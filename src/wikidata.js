// Wikidata (CC0). Everything goes through the query service (SPARQL) and the
// CDN-cached Special:EntityData pages. The action API (w/api.php) is avoided:
// it rate-limits shared IPs hard. Full-text search runs inside the query
// service through its MWAPI bridge.

const { getJson } = require('./http');

const SPARQL = 'https://query.wikidata.org/sparql';
const ENTITY = 'https://www.wikidata.org/wiki/Special:EntityData/';

const FILM_CLASSES = ['Q11424', 'Q24869', 'Q202866', 'Q29168811', 'Q506240', 'Q93204'];
const SERIES_CLASSES = ['Q5398426', 'Q1259759', 'Q581714', 'Q63952888', 'Q526877'];

const CLASSES = { movie: FILM_CLASSES, series: SERIES_CLASSES };

// Label languages to try in order: the viewer's language, then English, then
// the language-neutral "mul" label Wikidata added in 2024. The query
// service's label service ignores "mul", so the fallback is spelled out.
function langChain(lang) {
  return [...new Set([lang, 'en', 'mul'])];
}

function labelClause(lang, v = '?item', out = '?label') {
  const chain = langChain(lang);
  const parts = chain.map(
    (l, i) => `OPTIONAL { ${v} rdfs:label ?lab${i} FILTER(LANG(?lab${i}) = "${l}") }`
  );
  return `${parts.join('\n      ')}\n      BIND(COALESCE(${chain.map((_, i) => `?lab${i}`).join(', ')}) AS ${out})`;
}

function sparql(query, ttl, timeout) {
  const accept = 'application/sparql-results+json';
  const done = (r) => (r ? r.results.bindings : []);
  // Long queries (hundreds of titles) go as a POST body.
  if (query.length > 6000) {
    return getJson(SPARQL, { ttl, accept, timeout, body: `format=json&query=${encodeURIComponent(query)}` }).then(done);
  }
  return getJson(`${SPARQL}?format=json&query=${encodeURIComponent(query)}`, { ttl, accept, timeout }).then(done);
}

function qid(uri) {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

function str(lit) {
  // Escape for a SPARQL string literal.
  return '"' + String(lit).replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, ' ') + '"';
}

// Hebrew (and other) labels often carry Wikipedia's disambiguation:
// "המכון (מיני-סדרה)". Titles never need it in a catalog.
function cleanTitle(label) {
  return label && label.replace(/\s*\([^()]*\)\s*$/, '').trim();
}

function isQidLabel(item, label) {
  return !label || label === item;
}

// Full-text search over items that have an IMDb id and the right class.
// Returns [{ imdb, qid, name }] in search-relevance order, one per IMDb id.
async function search(type, query, lang, limit = 40) {
  const classes = CLASSES[type].map((c) => `P31=${c}`).join('|');
  const term = query.replace(/[\\"]/g, ' ').trim();
  if (!term) return [];
  const srsearch = `${term} haswbstatement:P345 haswbstatement:${classes}`;
  const rows = await sparql(
    `SELECT ?item ?imdb ?label ?date ?ordinal WHERE {
      SERVICE wikibase:mwapi {
        bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "Search";
                        mwapi:srsearch ${str(srsearch)}; mwapi:srlimit "${limit}".
        ?item wikibase:apiOutputItem mwapi:title.
        ?ordinal wikibase:apiOrdinal true.
      }
      ?item wdt:P345 ?imdb. FILTER(STRSTARTS(?imdb, "tt"))
      OPTIONAL { ?item wdt:${type === 'movie' ? 'P577' : 'P580'} ?date. }
      ${labelClause(lang)}
    } ORDER BY ?ordinal`,
    3600,
    6000
  );
  return dedupeRows(rows);
}

// Classics: the best-known films or series of all time, optionally in one
// genre. Wikidata has no view counts, so the number of Wikipedia editions
// with an article (sitelinks) stands in for fame. Candidates come from
// full-text search (the 1000 most-linked-to items of the type and genre),
// then get re-ranked by sitelinks. Films not out yet are dropped.
const POPULAR_POOL = 1000;

async function classics(type, lang, skip = 0, pageSize = 100, genreIds = null) {
  const classes = CLASSES[type].map((c) => `P31=${c}`).join('|');
  const genre = genreIds ? ` haswbstatement:${genreIds.map((g) => `P136=${g}|P31=${g}`).join('|')}` : '';
  const srsearch = `haswbstatement:P345 haswbstatement:${classes}${genre}`;
  const rows = await sparql(
    `SELECT ?item ?imdb ?label ?date ?links WHERE {
      SERVICE wikibase:mwapi {
        bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "Search";
                        mwapi:srsearch ${str(srsearch)}; mwapi:srsort "incoming_links_desc";
                        mwapi:srlimit "max"; wikibase:limit ${POPULAR_POOL} .
        ?item wikibase:apiOutputItem mwapi:title.
      }
      ?item wdt:P345 ?imdb; wikibase:sitelinks ?links. FILTER(STRSTARTS(?imdb, "tt"))
      OPTIONAL { ?item wdt:${type === 'movie' ? 'P577' : 'P580'} ?date. }
      ${labelClause(lang)}
    }`,
    12 * 3600,
    20000
  );
  const links = new Map(rows.map((r) => [r.imdb.value, Number(r.links.value)]));
  return dedupeRows(rows)
    .filter((x) => type !== 'movie' || releasedBy(x))
    .sort((a, b) => links.get(b.imdb) - links.get(a.imdb))
    .slice(skip, skip + pageSize);
}

// The query service flattens a year-only date to January 1st, so a Jan 1
// date is read as "some time that year".
function isYearOnly(iso) {
  return /-01-01T00:00:00Z$/.test(iso);
}

function dedupeRows(rows) {
  const out = new Map();
  for (const r of rows) {
    const imdb = r.imdb.value;
    const item = qid(r.item.value);
    const iso = r.date ? r.date.value : undefined;
    const year = iso ? iso.slice(0, 4) : undefined;
    const exact = iso && !isYearOnly(iso) ? iso.slice(0, 10) : undefined;
    const prev = out.get(imdb);
    if (prev) {
      // Several dates: keep the earliest (the first release, not a re-release).
      if (year && (!prev.year || year < prev.year)) prev.year = year;
      if (exact && (!prev.firstDate || exact < prev.firstDate)) prev.firstDate = exact;
      continue;
    }
    const name = r.label && !isQidLabel(item, r.label.value) ? cleanTitle(r.label.value) : undefined;
    out.set(imdb, { imdb, qid: item, name, year, firstDate: exact });
  }
  return [...out.values()].filter((x) => x.name);
}

// Out already, or out within `days` days. With only a year known, it counts
// as out once that year is over.
function releasedBy(x, days = 14) {
  if (x.firstDate) {
    const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    return x.firstDate <= cutoff;
  }
  return Boolean(x.year) && Number(x.year) < new Date().getUTCFullYear();
}

// Labels for a batch of IMDb ids in one query: { tt..: { qid, name } }.
async function labelsByImdb(imdbs, lang) {
  const ids = [...new Set(imdbs)].filter((x) => /^tt\d+$/.test(x));
  if (!ids.length) return {};
  const rows = await sparql(
    `SELECT ?item ?imdb ?label WHERE {
      VALUES ?imdb { ${ids.map(str).join(' ')} }
      ?item wdt:P345 ?imdb.
      ${labelClause(lang)}
    }`,
    24 * 3600,
    4000
  );
  const out = {};
  for (const r of rows) {
    const item = qid(r.item.value);
    if (out[r.imdb.value] || !r.label || isQidLabel(item, r.label.value)) continue;
    out[r.imdb.value] = { qid: item, name: cleanTitle(r.label.value) };
  }
  return out;
}

// The Wikidata item for an IMDb id, preferring one of the given type.
async function itemForImdb(imdb, type) {
  if (!/^tt\d+$/.test(imdb)) return null;
  const rows = await sparql(
    `SELECT ?item ?cls WHERE { ?item wdt:P345 ${str(imdb)}. OPTIONAL { ?item wdt:P31 ?cls. } }`,
    7 * 24 * 3600,
    4000
  );
  if (!rows.length) return null;
  const wanted = new Set(CLASSES[type] || []);
  const match = rows.find((r) => r.cls && wanted.has(qid(r.cls.value)));
  return qid((match || rows[0]).item.value);
}

async function entity(id) {
  const data = await getJson(`${ENTITY}${id}.json`, { ttl: 24 * 3600, timeout: 6000 });
  return data && data.entities ? Object.values(data.entities)[0] : null;
}

async function labelsFor(ids, lang) {
  const unique = [...new Set(ids)].filter((x) => /^Q\d+$/.test(x));
  if (!unique.length) return {};
  const rows = await sparql(
    `SELECT ?item ?label WHERE {
      VALUES ?item { ${unique.map((x) => 'wd:' + x).join(' ')} }
      ${labelClause(lang)}
    }`,
    7 * 24 * 3600,
    4000
  );
  const out = {};
  for (const r of rows) {
    const id = qid(r.item.value);
    if (r.label && !isQidLabel(id, r.label.value)) out[id] = r.label.value;
  }
  return out;
}

// Statements of one property, preferred rank first, deprecated dropped.
function claims(ent, prop) {
  const list = (ent.claims && ent.claims[prop]) || [];
  const live = list.filter((c) => c.rank !== 'deprecated' && c.mainsnak.datavalue);
  const preferred = live.filter((c) => c.rank === 'preferred');
  return (preferred.length ? preferred : live).map((c) => c.mainsnak.datavalue.value);
}

function allClaims(ent, prop) {
  const list = (ent.claims && ent.claims[prop]) || [];
  return list
    .filter((c) => c.rank !== 'deprecated' && c.mainsnak.datavalue)
    .map((c) => c.mainsnak.datavalue.value);
}

function pickText(map, lang) {
  if (!map) return undefined;
  for (const l of [lang, 'en', 'mul']) if (map[l]) return map[l].value;
  return undefined;
}

function earliestDate(values) {
  const dates = values
    .filter((v) => v && v.time && v.precision >= 9)
    .map((v) => ({ iso: v.time.replace(/^\+/, ''), precision: v.precision }))
    .sort((a, b) => a.iso.localeCompare(b.iso));
  return dates[0];
}

// Everything Wikidata knows about a title, already labelled in `lang`.
async function details(imdb, type, lang) {
  const id = await itemForImdb(imdb, type);
  if (!id) return null;
  const ent = await entity(id);
  if (!ent) return null;

  const genreIds = allClaims(ent, 'P136').map((v) => v.id);
  const directorIds = allClaims(ent, 'P57').map((v) => v.id);
  const castIds = allClaims(ent, 'P161').map((v) => v.id).slice(0, 15);
  const writerIds = allClaims(ent, 'P58').map((v) => v.id).slice(0, 5);
  const countryIds = allClaims(ent, 'P495').map((v) => v.id);
  const labels = await labelsFor([...genreIds, ...directorIds, ...castIds, ...writerIds, ...countryIds], lang).catch(() => ({}));
  const names = (ids) => [...new Set(ids.map((x) => labels[x]).filter(Boolean))];

  const released = earliestDate(allClaims(ent, type === 'movie' ? 'P577' : 'P580'));
  const ended = type === 'series' ? earliestDate(allClaims(ent, 'P582')) : undefined;
  const duration = claims(ent, 'P2047')[0];
  let runtime;
  if (duration && duration.unit.endsWith('/Q7727')) runtime = `${Math.round(Number(duration.amount))} min`;
  else if (duration && duration.unit.endsWith('/Q11574')) runtime = `${Math.round(Number(duration.amount) / 60)} min`;

  return {
    qid: id,
    name: cleanTitle(pickText(ent.labels, lang)),
    englishName: cleanTitle(pickText(ent.labels, 'en')),
    description: pickText(ent.descriptions, lang),
    released: released && released.iso,
    year: released && released.iso.slice(0, 4),
    endYear: ended && ended.iso.slice(0, 4),
    runtime,
    genres: names(genreIds),
    director: names(directorIds),
    writer: names(writerIds),
    cast: names(castIds),
    country: names(countryIds),
    tvmazeId: claims(ent, 'P8600')[0],
    wikipedia: ent.sitelinks && (ent.sitelinks[`${lang}wiki`] || ent.sitelinks.enwiki),
  };
}

// Map Wikipedia article titles (of the `wiki` language edition) to films and
// series in one query: { 'Title': { imdb, qid, name, year, type } }.
async function itemsForWikiTitles(titles, wiki, lang) {
  if (!titles.length) return {};
  const film = new Set(FILM_CLASSES);
  const classes = [...FILM_CLASSES, ...SERIES_CLASSES].map((c) => 'wd:' + c).join(' ');
  const rows = await sparql(
    `SELECT ?title ?item ?cls ?imdb ?label ?date ?genre WHERE {
      VALUES ?title { ${titles.map((t) => str(t) + '@' + wiki).join(' ')} }
      ?article schema:name ?title; schema:isPartOf <https://${wiki}.wikipedia.org/>; schema:about ?item.
      VALUES ?cls { ${classes} }
      ?item wdt:P31 ?cls; wdt:P345 ?imdb. FILTER(STRSTARTS(?imdb, "tt"))
      OPTIONAL { ?item wdt:P577|wdt:P580 ?date. }
      OPTIONAL { ?item wdt:P136 ?genre. }
      ${labelClause(lang)}
    }`,
    6 * 3600,
    45000 // hundreds of titles: slower than the default deadline
  );
  const byImdb = new Map(dedupeRows(rows).map((x) => [x.imdb, x]));
  // Genres: P136 values plus classes (P31), so "anime television series"
  // and "animated film" match their genre filters.
  const genresOf = new Map();
  for (const r of rows) {
    const set = genresOf.get(r.imdb.value) || new Set();
    set.add(qid(r.cls.value));
    if (r.genre) set.add(qid(r.genre.value));
    genresOf.set(r.imdb.value, set);
  }
  const out = {};
  for (const r of rows) {
    const x = byImdb.get(r.imdb.value);
    if (!x || out[r.title.value]) continue;
    out[r.title.value] = {
      ...x,
      type: film.has(qid(r.cls.value)) ? 'movie' : 'series',
      genres: [...genresOf.get(r.imdb.value)],
    };
  }
  return out;
}

module.exports = {
  releasedBy,
  search,
  classics,
  labelsByImdb,
  details,
  itemForImdb,
  itemsForWikiTitles,
};
