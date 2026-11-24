// Stremio add-on logic: manifest, catalogs and meta, merging Wikidata and
// TVmaze. Every title is keyed by its IMDb id (tt...), so stream add-ons
// match it and the same title never shows up twice.

const pkg = require('../package.json');
const wikidata = require('./wikidata');
const tvmaze = require('./tvmaze');
const genres = require('./genres');
const { REGIONS } = require('./trending');
const lists = require('./lists');
const snapshot = require('./snapshot');
const store = require('./store');

const PAGE = 100;

// Images are linked, never copied. Movies get Stremio's public metahub
// artwork (keyed by IMDb id); series use TVmaze's own images.
const metahub = (kind, imdb, size = 'medium') =>
  `https://images.metahub.space/${kind}/${size}/${imdb}/img`;

function genreExtra(type, lang, source) {
  return { name: 'genre', options: genres.options(type, lang, source) };
}

// Lists a viewer can switch on or off on the install page; the letters go in
// the install link ("he.tc" = Trending and Classics, Hebrew). No letters =
// DEFAULT_FLAGS.
const LIST_FLAGS = {
  t: 'wikimaze-trending',
  v: 'wikimaze-hot',
  n: 'wikimaze-new',
  c: ['wikimaze-popular', 'wikimaze-classics'],
  a: 'wikimaze-airing',
};
const DEFAULT_FLAGS = 'tvnca';

function manifest(lang, lists = null, region = null) {
  let m = fullManifest(lang);
  if (region && REGIONS.includes(region)) {
    m = { ...m, id: `${m.id}-${region}`, name: `${m.name} ${region.toUpperCase()}` };
  }
  const flags = lists || DEFAULT_FLAGS;
  const keep = new Set([...flags].flatMap((f) => [].concat(LIST_FLAGS[f] || [])));
  const catalogs = m.catalogs.filter((c) => keep.has(c.id));
  return lists ? { ...m, id: `${m.id}.${[...lists].sort().join('')}`, catalogs } : { ...m, catalogs };
}

function fullManifest(lang) {
  const suffix = lang === 'en' ? '' : ` (${lang})`;
  // Every list can be searched (Stremio's search bar shows one row per
  // list) and filtered by genre and year in Discover.
  const extras = (type, source) => [
    genreExtra(type, lang, source),
    { name: 'year', options: store.yearOptions() },
    { name: 'search' },
    { name: 'skip' },
  ];
  const list = (type, id, name, source) => ({ type, id, name, extra: extras(type, source) });
  return {
    id: 'community.wikimaze' + (lang === 'en' ? '' : '.' + lang),
    version: pkg.version,
    name: 'WikiMaze' + suffix,
    description:
      'Movie and series details from Wikidata (CC0) and TVmaze (CC BY-SA), titles in your language. ' +
      'Search ends with "!" to ask Wikidata and TVmaze directly. ' +
      'TV data from TVmaze.com, licensed CC BY-SA 4.0.',
    logo: undefined,
    resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [
      list('movie', 'wikimaze-trending', 'WikiMovies - Trending'),
      list('series', 'wikimaze-trending', 'WikiSeries - Trending'),
      // Surging movies: Wikipedia readership climb, a PLACEHOLDER source
      // (see trending.js). Surging series: TVmaze, shows with a new
      // episode in the last two days by TVmaze's popularity weight.
      list('movie', 'wikimaze-hot', 'WikiMovies - Surging'),
      list('series', 'wikimaze-hot', 'WikiSeries - Surging', 'tvmaze'),
      list('movie', 'wikimaze-new', 'WikiMovies - Brand New'),
      list('series', 'wikimaze-new', 'WikiSeries - Brand New', 'tvmaze'),
      list('movie', 'wikimaze-popular', 'WikiMovies - Classics'),
      list('series', 'wikimaze-classics', 'WikiSeries - Classics'),
      list('series', 'wikimaze-airing', 'WikiSeries - Airing now', 'tvmaze'),
      // The whole title store ("wikimaze-library") is not a Stremio row;
      // apps reach it through /api/search (see server.js).
    ],
    behaviorHints: { configurable: true },
  };
}

function moviePreview(row) {
  return {
    id: row.imdb,
    type: 'movie',
    name: row.name,
    poster: metahub('poster', row.imdb),
    releaseInfo: row.year,
  };
}

function seriesPreview(show, name) {
  const imdb = show.externals && show.externals.imdb;
  return {
    id: imdb,
    type: 'series',
    name: name || show.name,
    poster: tvmaze.image(show.image, 'medium') || metahub('poster', imdb),
    releaseInfo: show.premiered ? show.premiered.slice(0, 4) : undefined,
    genres: show.genres,
  };
}

function wikidataSeriesPreview(r) {
  return { id: r.imdb, type: 'series', name: r.name, poster: metahub('poster', r.imdb), releaseInfo: r.year };
}

async function localNames(imdbs, lang) {
  if (lang === 'en') return {};
  try {
    return await wikidata.labelsByImdb(imdbs, lang);
  } catch {
    return {}; // fall back to TVmaze's own names
  }
}

// Whole lists built at request time, when no snapshot is available. Kept
// per instance so paging through a list doesn't rebuild it.
const built = new Map(); // "lang/type/id" -> { expires, promise }
const LIVE_TTL = 3 * 3600 * 1000;

function liveList(type, id, lang, region) {
  const key = `${lang}/${type}/${id}${region ? '@' + region : ''}`;
  const hit = built.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = lists.build(type, id, lang, region);
  built.set(key, { expires: Date.now() + LIVE_TTL, promise });
  promise.catch(() => built.delete(key));
  return promise;
}

// Fewer stored matches than this and All titles adds live results.
const LIVE_BELOW = 20;
// All titles asks live unless the store alone has a full page of matches.
const ALL_TITLES_LIVE_BELOW = 100;

// Few stored matches: add Wikidata and TVmaze results after them, so a
// search never finds less than it did before the store existed. Live
// results carry no genre or year, so a filtered search stays in the store.
async function withLive(rows, type, q, lang, filters, below = LIVE_BELOW) {
  if (rows.length >= below || filters.genre || filters.from || filters.to) return { rows, source: 'store' };
  const extra = await live(type, q, lang, filters.india).catch(() => []);
  const have = new Set(rows.map((x) => x.id));
  const more = extra.filter((x) => x.id && !have.has(x.id));
  return { rows: [...rows, ...more], source: rows.length ? 'store+live' : 'live' };
}

// "breaking bad!" forces a live search; the "!" is dropped.
function parseQuery(raw) {
  const q = String(raw || '').trim();
  const forced = /^!|!$/.test(q);
  return { q: q.replace(/^!+|!+$/g, '').trim(), forced };
}

function genreSource(type, id) {
  return id === 'wikimaze-airing' || (type === 'series' && (id === 'wikimaze-hot' || id === 'wikimaze-new'))
    ? 'tvmaze'
    : 'wikidata';
}

// Live search on Wikidata and TVmaze.
function live(type, q, lang, india = false) {
  return type === 'movie' ? searchMovies(q, lang, india) : searchSeries(q, lang, india);
}

// Rows for one catalog: a list (or the whole store) filtered by genre, year
// and search text. Shared by Stremio catalogs and the JSON search API.
//   returns { rows: store entries or previews, source: 'store' | 'live' }
async function findAll(type, id, extra, lang, region = null) {
  const india = region === 'in';
  const { q, forced } = parseQuery(extra.search);
  // 'wikimaze-live' / 'wikimaze-search': ids older installs may still ask for.
  if (id === 'wikimaze-live' || id === 'wikimaze-search') {
    return { rows: q ? await live(type, q, lang, india) : [], source: 'live' };
  }
  if (q && forced) return { rows: await live(type, q, lang, india), source: 'live' };

  const genre = genres.lookup(type, extra.genre, lang, genreSource(type, id)) ||
    (extra.genre && genres.byKey(extra.genre));
  if (extra.genre && !genre) return { rows: [], source: 'store' };
  const years = store.yearRange(extra.year);
  const filters = {
    type,
    q,
    genre: genre && genre.key,
    from: extra.from ? Number(extra.from) : years && years[0],
    to: extra.to ? Number(extra.to) : years && years[1],
  };

  if (id === 'wikimaze-library') {
    const titles = await snapshot.titles(lang);
    if (!titles) return { rows: q ? await live(type, q, lang, india) : [], source: 'live' };
    const rows = store.query(titles, filters);
    // All titles is the search engine: saved matches first, then every
    // Wikidata/TVmaze match not saved yet (unless genre/year filters are
    // on, which live results can't honour).
    return q ? withLive(rows, type, q, lang, { ...filters, india }, ALL_TITLES_LIVE_BELOW) : { rows, source: 'store' };
  }

  if (!lists.LISTS.includes(`${type}/${id}`)) return { rows: [], source: 'store' };
  // A region changes only Trending; the other lists are the same everywhere.
  const r = id === 'wikimaze-trending' && REGIONS.includes(region) ? region : null;
  const all = (await snapshot.list(type, id, lang, r)) || (await liveList(type, id, lang, r)) || [];
  const byId = Object.fromEntries(all.map((x) => [x.id, { ...x, year: x.year || parseInt(x.releaseInfo, 10) || undefined }]));
  const rows = store.query(byId, { ...filters, ids: all.map((x) => x.id) });
  // A search in any list shows the list's own matches first, then Wikidata
  // and TVmaze matches when the list has fewer than LIVE_BELOW.
  if (q) return withLive(rows, type, q, lang, { ...filters, india });
  return { rows, source: 'store' };
}

// Indian titles (store flag `in`, set by the snapshot build) are left out
// everywhere unless the install's region is India.
async function find(type, id, extra, lang, region = null) {
  const res = await findAll(type, id, extra, lang, region);
  if (region === 'in') return res;
  return { ...res, rows: res.rows.filter((x) => !x.in) };
}

async function catalog(type, id, extra, lang, region = null) {
  const skip = Number(extra.skip) || 0;
  const { rows } = await find(type, id, extra, lang, region);
  return rows.slice(skip, skip + PAGE).map((x) => (x.poster !== undefined && x.g !== undefined ? store.preview(x) : x));
}

async function searchMovies(q, lang, india = false) {
  const rows = await wikidata.search('movie', q, lang);
  return rows.filter((r) => india || !r.indian).map(moviePreview);
}

async function searchSeries(q, lang, india = false) {
  // Both sources in parallel; one failing must not empty the results.
  const [maze, wd] = await Promise.all([
    tvmaze.search(q).catch(() => []),
    wikidata.search('series', q, lang).catch(() => []),
  ]);
  const out = new Map();
  const mazeWithImdb = maze.filter((s) => s.externals && s.externals.imdb && (india || !tvmaze.isIndian(s)));
  const indianWd = new Set(wd.filter((r) => r.indian).map((r) => r.imdb));
  const wdByImdb = new Map(wd.map((r) => [r.imdb, r]));
  const missing = mazeWithImdb.map((s) => s.externals.imdb).filter((x) => !wdByImdb.has(x));
  const names = await localNames(missing, lang);

  for (const s of mazeWithImdb) {
    const imdb = s.externals.imdb;
    if (out.has(imdb) || (!india && indianWd.has(imdb))) continue;
    const local = wdByImdb.get(imdb) || names[imdb];
    out.set(imdb, seriesPreview(s, lang === 'en' ? undefined : local && local.name));
  }
  for (const r of wd) {
    if (!out.has(r.imdb) && (india || !r.indian)) out.set(r.imdb, wikidataSeriesPreview(r));
  }
  return [...out.values()];
}

function joinDescription(...parts) {
  const seen = new Set();
  const kept = parts.filter((p) => p && !seen.has(p) && seen.add(p));
  return kept.length ? kept.join('\n\n') : undefined;
}

async function movieMeta(imdb, lang) {
  const wd = await wikidata.details(imdb, 'movie', lang);
  if (!wd || !wd.name) return null;
  return {
    id: imdb,
    type: 'movie',
    name: wd.name,
    poster: metahub('poster', imdb),
    background: metahub('background', imdb, 'large'),
    logo: metahub('logo', imdb),
    description: wd.description,
    releaseInfo: wd.year,
    released: wd.released,
    runtime: wd.runtime,
    genres: wd.genres,
    director: wd.director,
    writer: wd.writer,
    cast: wd.cast,
    country: wd.country.join(', ') || undefined,
    links: wikiLinks(wd),
    behaviorHints: { defaultVideoId: imdb },
  };
}

function wikiLinks(wd) {
  const links = [];
  if (wd.wikipedia && wd.wikipedia.url) {
    links.push({ name: 'Wikipedia', category: 'Wikipedia', url: wd.wikipedia.url });
  }
  links.push({ name: 'Wikidata', category: 'Wikidata', url: `https://www.wikidata.org/wiki/${wd.qid}` });
  return links;
}

async function seriesMeta(imdb, lang) {
  const [wd, found] = await Promise.all([
    wikidata.details(imdb, 'series', lang).catch(() => null),
    tvmaze.showByImdb(imdb).catch(() => null),
  ]);
  let show = found;
  if (!show && wd && wd.tvmazeId) show = { id: wd.tvmazeId };
  const full = show ? await tvmaze.showFull(show.id).catch(() => null) : null;

  if (!full && !(wd && wd.name)) return null;

  const emb = (full && full._embedded) || {};
  const useLocal = lang !== 'en' && wd;
  const name = (useLocal && wd.name) || (full && full.name) || (wd && wd.name);

  const videos = (emb.episodes || [])
    .filter((e) => e.season != null && e.number != null)
    .map((e) => ({
      id: `${imdb}:${e.season}:${e.number}`,
      title: e.name || `Episode ${e.number}`,
      season: e.season,
      episode: e.number,
      released: e.airstamp || (e.airdate ? `${e.airdate}T00:00:00Z` : undefined),
      overview: tvmaze.stripHtml(e.summary),
      thumbnail: tvmaze.image(e.image, 'original'),
    }));

  const start = (full && full.premiered && full.premiered.slice(0, 4)) || (wd && wd.year);
  const end = full ? full.ended && full.ended.slice(0, 4) : wd && wd.endYear;
  const running = full ? full.status === 'Running' : !end;
  const releaseInfo = start ? (running ? `${start}-` : end && end !== start ? `${start}-${end}` : start) : undefined;

  const genres = useLocal && wd.genres.length ? wd.genres : (full && full.genres) || (wd && wd.genres) || [];
  const cast = (emb.cast || []).slice(0, 15).map((c) => c.person && c.person.name).filter(Boolean);

  const links = wd ? wikiLinks(wd) : [];
  if (full) links.push({ name: 'TVmaze', category: 'TVmaze', url: full.url });

  return {
    id: imdb,
    type: 'series',
    name,
    poster: (full && tvmaze.image(full.image, 'original')) || metahub('poster', imdb),
    background: (full && tvmaze.bestBackground(full)) || metahub('background', imdb, 'large'),
    logo: (full && tvmaze.bestLogo(full)) || metahub('logo', imdb),
    description: joinDescription(useLocal ? wd.description : undefined, full && tvmaze.stripHtml(full.summary), !full && wd && wd.description),
    releaseInfo,
    released: full && full.premiered ? `${full.premiered}T00:00:00Z` : wd && wd.released,
    runtime: full && (full.averageRuntime || full.runtime) ? `${full.averageRuntime || full.runtime} min` : wd && wd.runtime,
    genres,
    cast: cast.length ? cast : wd ? wd.cast : [],
    director: wd ? wd.director : [],
    country: full && full.network && full.network.country ? full.network.country.name : wd && wd.country.join(', ') || undefined,
    links,
    videos,
  };
}

async function meta(type, id, lang) {
  const imdb = id.split(':')[0];
  if (!/^tt\d+$/.test(imdb)) return null;
  if (type === 'movie') return movieMeta(imdb, lang);
  if (type === 'series') return seriesMeta(imdb, lang);
  return null;
}

module.exports = {
  LIST_FLAGS,
  DEFAULT_FLAGS,
  find,
  parseQuery,
  manifest,
  catalog,
  meta,
  clearLists: () => built.clear(),
};
