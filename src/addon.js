// Stremio add-on logic: manifest, catalogs and meta, merging Wikidata and
// TVmaze. Every title is keyed by its IMDb id (tt...), so stream add-ons
// match it and the same title never shows up twice.

const pkg = require('../package.json');
const wikidata = require('./wikidata');
const tvmaze = require('./tvmaze');
const genres = require('./genres');
const lists = require('./lists');
const snapshot = require('./snapshot');

const PAGE = 100;

// Images are linked, never copied. Movies get Stremio's public metahub
// artwork (keyed by IMDb id); series use TVmaze's own images.
const metahub = (kind, imdb, size = 'medium') =>
  `https://images.metahub.space/${kind}/${size}/${imdb}/img`;

function genreExtra(type, lang, source) {
  return { name: 'genre', options: genres.options(type, lang, source) };
}

// Lists a viewer can switch on or off on the install page; the letters go in
// the install link ("he.tc" = Trending and Classics, Hebrew).
const LIST_FLAGS = { t: 'wikimaze-trending', v: 'wikimaze-hot', c: ['wikimaze-popular', 'wikimaze-classics'], a: 'wikimaze-airing' };

function manifest(lang, lists = null) {
  const m = fullManifest(lang);
  if (!lists) return m;
  const keep = new Set([...lists].flatMap((f) => [].concat(LIST_FLAGS[f] || [])));
  const catalogs = m.catalogs.filter((c) => keep.has(c.id));
  return { ...m, id: `${m.id}.${[...lists].sort().join('')}`, catalogs };
}

function fullManifest(lang) {
  const suffix = lang === 'en' ? '' : ` (${lang})`;
  return {
    id: 'community.wikimaze' + (lang === 'en' ? '' : '.' + lang),
    version: pkg.version,
    name: 'WikiMaze' + suffix,
    description:
      'Movie and series details from Wikidata (CC0) and TVmaze (CC BY-SA), titles in your language. ' +
      'TV data from TVmaze.com, licensed CC BY-SA 4.0.',
    logo: undefined,
    resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    // One browsable catalog per type. Search and genre are optional extras
    // on it (like Cinemeta), so Discover always has a list to show and
    // Stremio's search bar still reaches it.
    catalogs: [
      { type: 'movie', id: 'wikimaze-trending', name: 'WikiMovies - Trending', extra: [genreExtra('movie', lang), { name: 'skip' }] },
      { type: 'series', id: 'wikimaze-trending', name: 'WikiSeries - Trending', extra: [genreExtra('series', lang), { name: 'skip' }] },
      // Very Trending movies: Wikipedia one-day spike, a PLACEHOLDER source
      // (see trending.js). Very Trending series: TVmaze, shows with a new
      // episode in the last two days by TVmaze's popularity weight.
      { type: 'movie', id: 'wikimaze-hot', name: 'WikiMovies - Very Trending', extra: [genreExtra('movie', lang), { name: 'skip' }] },
      { type: 'series', id: 'wikimaze-hot', name: 'WikiSeries - Very Trending', extra: [genreExtra('series', lang, 'tvmaze'), { name: 'skip' }] },
      {
        type: 'movie',
        id: 'wikimaze-popular',
        name: 'WikiMovies - Classics',
        extra: [{ name: 'search' }, genreExtra('movie', lang), { name: 'skip' }],
      },
      {
        type: 'series',
        id: 'wikimaze-classics',
        name: 'WikiSeries - Classics',
        extra: [{ name: 'search' }, genreExtra('series', lang), { name: 'skip' }],
      },
      {
        type: 'series',
        id: 'wikimaze-airing',
        name: 'WikiSeries - Airing now',
        extra: [genreExtra('series', lang, 'tvmaze'), { name: 'skip' }],
      },
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

function liveList(type, id, lang) {
  const key = `${lang}/${type}/${id}`;
  const hit = built.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = lists.build(type, id, lang);
  built.set(key, { expires: Date.now() + LIVE_TTL, promise });
  promise.catch(() => built.delete(key));
  return promise;
}

async function catalog(type, id, extra, lang) {
  const skip = Number(extra.skip) || 0;
  const q = (extra.search || '').trim();

  // Any catalog id with a search term searches; 'wikimaze-search' is the id
  // older installs of the manifest still use.
  if (q) return type === 'movie' ? searchMovies(q, lang) : searchSeries(q, lang);
  if (!lists.LISTS.includes(`${type}/${id}`)) return [];

  const source = id === 'wikimaze-airing' || (type === 'series' && id === 'wikimaze-hot') ? 'tvmaze' : 'wikidata';
  const genre = genres.lookup(type, extra.genre, lang, source);
  if (extra.genre && !genre) return [];

  const all = (await snapshot.list(type, id, lang)) || (await liveList(type, id, lang)) || [];
  const picked = genre ? all.filter((x) => (x.g || []).includes(genre.key)) : all;
  return picked.slice(skip, skip + PAGE).map(({ g, ...preview }) => preview);
}

async function searchMovies(q, lang) {
  const rows = await wikidata.search('movie', q, lang);
  return rows.map(moviePreview);
}

async function searchSeries(q, lang) {
  // Both sources in parallel; one failing must not empty the results.
  const [maze, wd] = await Promise.all([
    tvmaze.search(q).catch(() => []),
    wikidata.search('series', q, lang).catch(() => []),
  ]);
  const out = new Map();
  const mazeWithImdb = maze.filter((s) => s.externals && s.externals.imdb);
  const wdByImdb = new Map(wd.map((r) => [r.imdb, r]));
  const missing = mazeWithImdb.map((s) => s.externals.imdb).filter((x) => !wdByImdb.has(x));
  const names = await localNames(missing, lang);

  for (const s of mazeWithImdb) {
    const imdb = s.externals.imdb;
    if (out.has(imdb)) continue;
    const local = wdByImdb.get(imdb) || names[imdb];
    out.set(imdb, seriesPreview(s, lang === 'en' ? undefined : local && local.name));
  }
  for (const r of wd) {
    if (!out.has(r.imdb)) out.set(r.imdb, wikidataSeriesPreview(r));
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
  manifest,
  catalog,
  meta,
  clearLists: () => built.clear(),
};
