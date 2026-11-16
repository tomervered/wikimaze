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

// Films, most popular first. Wikidata has no view counts, so the number of
// Wikipedia editions with an article (sitelinks) stands in for popularity.
// Matching a date range in SPARQL times out, so candidates come from
// full-text search: bot-written English descriptions start with the year
// ("2025 film directed by ..."). The 1000 most-linked candidates are then
// re-ranked by sitelinks.
//
// Without a genre: films first released this year or last (re-releases
// dropped). With a genre (a list of Wikidata ids from genres.js): all years,
// so a genre always has enough titles to browse.
const POPULAR_POOL = 1000;

async function popularMovies(lang, skip = 0, pageSize = 100, genreIds = null) {
  const year = new Date().getUTCFullYear();
  const classes = FILM_CLASSES.map((c) => `P31=${c}`).join('|');
  const filter = genreIds
    ? `haswbstatement:${genreIds.map((g) => `P136=${g}|P31=${g}`).join('|')}`
    : `"${year} film" OR "${year - 1} film"`;
  const srsearch = `${filter} haswbstatement:P345 haswbstatement:${classes}`;
  const rows = await sparql(
    `SELECT ?item ?imdb ?label ?date ?links WHERE {
      SERVICE wikibase:mwapi {
        bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "Search";
                        mwapi:srsearch ${str(srsearch)}; mwapi:srsort "incoming_links_desc";
                        mwapi:srlimit "max"; wikibase:limit ${POPULAR_POOL} .
        ?item wikibase:apiOutputItem mwapi:title.
      }
      ?item wdt:P345 ?imdb; wikibase:sitelinks ?links. FILTER(STRSTARTS(?imdb, "tt"))
      OPTIONAL { ?item wdt:P577 ?date. }
      ${labelClause(lang)}
    }`,
    12 * 3600,
    20000
  );
  const links = new Map(rows.map((r) => [r.imdb.value, Number(r.links.value)]));
  return dedupeRows(rows)
    .filter((x) => genreIds || (x.year && Number(x.year) >= year - 1 && Number(x.year) <= year))
    .sort((a, b) => links.get(b.imdb) - links.get(a.imdb))
    .slice(skip, skip + pageSize);
}

function dedupeRows(rows) {
  const out = new Map();
  for (const r of rows) {
    const imdb = r.imdb.value;
    const item = qid(r.item.value);
    const year = r.date ? r.date.value.slice(0, 4) : undefined;
    const prev = out.get(imdb);
    if (prev) {
      // Several dates: keep the earliest (the first release, not a re-release).
      if (year && (!prev.year || year < prev.year)) prev.year = year;
      continue;
    }
    const name = r.label && !isQidLabel(item, r.label.value) ? cleanTitle(r.label.value) : undefined;
    out.set(imdb, { imdb, qid: item, name, year });
  }
  return [...out.values()].filter((x) => x.name);
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

// Everything Wikidata knows about a title, already labelled in `lang`,
// asking only for the fields the add-on shows. (The full Special:EntityData
// record is 250-350 KB for a popular film, and its linked items then needed
// a second query for their labels.) Each UNION branch returns rows of one
// kind: the title's labels, descriptions, Wikipedia articles, plain values,
// dates and runtime, or linked items (genre, director, cast, writer,
// country) with their label and sitelink count. The branches go out as two
// queries in parallel: one query with all of them runs about twice as long
// on the query service.
const LINKED = { P136: 'genres', P57: 'director', P161: 'cast', P58: 'writer', P495: 'country' };
const LINK_LIMIT = { P161: 15, P58: 5 };

function detailsQueries(imdb, lang) {
  const chain = langChain(lang);
  const langs = chain.map((l) => str(l)).join(', ');
  const wikis = [...new Set([lang, 'en'])].map((l) => `<https://${l}.wikipedia.org/>`).join(', ');
  const valueLabels = chain
    .map((l, i) => `OPTIONAL { ?v rdfs:label ?l${i} FILTER(LANG(?l${i}) = ${str(l)}) }`)
    .join(' ');
  // Every branch names its predicate outright, so the query service can use
  // its indexes (a computed predicate makes it scan).
  const branches = [
    `?item rdfs:label ?vl. FILTER(LANG(?vl) IN (${langs})) BIND("label" AS ?kind) BIND(LANG(?vl) AS ?v)`,
    `?item schema:description ?vl. FILTER(LANG(?vl) IN (${langs})) BIND("desc" AS ?kind) BIND(LANG(?vl) AS ?v)`,
    `?vl schema:about ?item; schema:isPartOf ?wiki. FILTER(?wiki IN (${wikis})) BIND("wiki" AS ?kind) BIND(STR(?wiki) AS ?v)`,
    ...['P31', 'P8600'].map((p) => `?item wdt:${p} ?v. BIND("${p}" AS ?kind)`),
    ...['P577', 'P580', 'P582'].map(
      (p) => `?item p:${p} ?st. ?st psv:${p} ?tv; wikibase:rank ?r. FILTER(?r != wikibase:DeprecatedRank)
      ?tv wikibase:timeValue ?v; wikibase:timePrecision ?prec. BIND("${p}" AS ?kind)`
    ),
    `?item p:P2047 ?st. ?st psv:P2047 ?q; wikibase:rank ?r. FILTER(?r != wikibase:DeprecatedRank)
      ?q wikibase:quantityAmount ?v; wikibase:quantityUnit ?unit.
      BIND(IF(?r = wikibase:PreferredRank, 1, 0) AS ?n) BIND("P2047" AS ?kind)`,
    ...Object.keys(LINKED).map(
      (p) => `?item p:${p} ?st. ?st ps:${p} ?v; wikibase:rank ?r. FILTER(?r != wikibase:DeprecatedRank)
      OPTIONAL { ?st pq:P1545 ?ord. } OPTIONAL { ?v wikibase:sitelinks ?n. }
      ${valueLabels}
      BIND(COALESCE(${chain.map((_, i) => `?l${i}`).join(', ')}) AS ?vl) BIND("${p}" AS ?kind)`
    ),
  ];
  const query = (list) => `SELECT ?item ?kind ?v ?vl ?n ?ord ?unit ?prec WHERE {
    ?item wdt:P345 ${str(imdb)}.
    { ${list.join('\n    } UNION {\n      ')} }
  }`;
  const own = branches.length - Object.keys(LINKED).length;
  return [query(branches.slice(0, own)), query(branches.slice(own))];
}

function pickLang(map, lang) {
  for (const l of langChain(lang)) if (map[l]) return map[l];
  return undefined;
}

// Turns the query rows of one item into the details object.
function detailsFromRows(rows, id, type, lang) {
  const labels = {};
  const descs = {};
  const wikis = {};
  const plain = {};
  const dates = { P577: [], P580: [], P582: [] };
  const durations = [];
  const linked = Object.fromEntries(Object.keys(LINKED).map((k) => [k, new Map()]));

  for (const r of rows) {
    const kind = r.kind && r.kind.value;
    const v = r.v && r.v.value;
    if (!kind || v == null) continue;
    if (kind === 'label') labels[v] = r.vl.value;
    else if (kind === 'desc') descs[v] = r.vl.value;
    else if (kind === 'wiki') wikis[v] = r.vl.value;
    else if (kind === 'P31' || kind === 'P8600') (plain[kind] = plain[kind] || []).push(v);
    else if (dates[kind]) {
      if (Number(r.prec && r.prec.value) >= 9) dates[kind].push(v);
    } else if (kind === 'P2047') {
      durations.push({ amount: Number(v), unit: r.unit.value, preferred: r.n && r.n.value === '1' });
    } else if (linked[kind]) {
      const vid = qid(v);
      const name = r.vl && r.vl.value;
      if (!/^Q\d+$/.test(vid) || isQidLabel(vid, name) || linked[kind].has(vid)) continue;
      const ord = r.ord ? Number(r.ord.value) : Infinity;
      linked[kind].set(vid, { name, ord: Number.isFinite(ord) ? ord : Infinity, links: r.n ? Number(r.n.value) : 0 });
    }
  }

  // Billing order when Wikidata has it (P1545), else best known first.
  const names = (prop) => {
    const list = [...linked[prop].values()].sort((a, b) => a.ord - b.ord || b.links - a.links);
    const out = [...new Set(list.map((x) => x.name))];
    return LINK_LIMIT[prop] ? out.slice(0, LINK_LIMIT[prop]) : out;
  };
  const earliest = (list) => list.sort()[0];

  const released = earliest(dates[type === 'movie' ? 'P577' : 'P580']);
  const ended = type === 'series' ? earliest(dates.P582) : undefined;
  const duration = durations.find((d) => d.preferred) || durations[0];
  let runtime;
  if (duration && duration.unit.endsWith('/Q7727')) runtime = `${Math.round(duration.amount)} min`;
  else if (duration && duration.unit.endsWith('/Q11574')) runtime = `${Math.round(duration.amount / 60)} min`;

  const wikiUrl = wikis[`https://${lang}.wikipedia.org/`] || wikis['https://en.wikipedia.org/'];
  return {
    qid: id,
    name: cleanTitle(pickLang(labels, lang)),
    englishName: cleanTitle(pickLang(labels, 'en')),
    description: pickLang(descs, lang),
    released,
    year: released && released.slice(0, 4),
    endYear: ended && ended.slice(0, 4),
    runtime,
    genres: names('P136'),
    director: names('P57'),
    writer: names('P58'),
    cast: names('P161'),
    country: names('P495'),
    tvmazeId: plain.P8600 && plain.P8600[0],
    wikipedia: wikiUrl ? { url: wikiUrl } : undefined,
  };
}

async function details(imdb, type, lang) {
  if (!/^tt\d+$/.test(imdb)) return null;
  const parts = await Promise.all(detailsQueries(imdb, lang).map((q) => sparql(q, 24 * 3600, 8000)));
  const rows = parts.flat();
  if (!rows.length) return null;

  // Several items can share an IMDb id; prefer one of the requested type.
  const byItem = new Map();
  for (const r of rows) {
    const id = qid(r.item.value);
    if (!byItem.has(id)) byItem.set(id, []);
    byItem.get(id).push(r);
  }
  const wanted = new Set(CLASSES[type] || []);
  let id = [...byItem.keys()][0];
  for (const [item, list] of byItem) {
    if (list.some((r) => r.kind && r.kind.value === 'P31' && wanted.has(qid(r.v.value)))) {
      id = item;
      break;
    }
  }
  return detailsFromRows(byItem.get(id), id, type, lang);
}

// Map Wikipedia article titles (of the `wiki` language edition) to films and
// series in one query: { 'Title': { imdb, qid, name, year, type } }.
async function itemsForWikiTitles(titles, wiki, lang) {
  if (!titles.length) return {};
  const film = new Set(FILM_CLASSES);
  const classes = [...FILM_CLASSES, ...SERIES_CLASSES].map((c) => 'wd:' + c).join(' ');
  const rows = await sparql(
    `SELECT ?title ?item ?cls ?imdb ?label ?date WHERE {
      VALUES ?title { ${titles.map((t) => str(t) + '@' + wiki).join(' ')} }
      ?article schema:name ?title; schema:isPartOf <https://${wiki}.wikipedia.org/>; schema:about ?item.
      VALUES ?cls { ${classes} }
      ?item wdt:P31 ?cls; wdt:P345 ?imdb. FILTER(STRSTARTS(?imdb, "tt"))
      OPTIONAL { ?item wdt:P577|wdt:P580 ?date. }
      ${labelClause(lang)}
    }`,
    6 * 3600,
    45000 // hundreds of titles: slower than the default deadline
  );
  const byImdb = new Map(dedupeRows(rows).map((x) => [x.imdb, x]));
  const out = {};
  for (const r of rows) {
    const x = byImdb.get(r.imdb.value);
    if (!x || out[r.title.value]) continue;
    out[r.title.value] = { ...x, type: film.has(qid(r.cls.value)) ? 'movie' : 'series' };
  }
  return out;
}

module.exports = {
  search,
  popularMovies,
  labelsByImdb,
  details,
  detailsQueries,
  detailsFromRows,
  itemsForWikiTitles,
};
