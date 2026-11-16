// Stremio add-on logic: manifest, catalogs and meta, merging Wikidata and
// TVmaze. Every title is keyed by its IMDb id (tt...), so stream add-ons
// match it and the same title never shows up twice.

const pkg = require('../package.json');
const wikidata = require('./wikidata');
const tvmaze = require('./tvmaze');

const PAGE = 100;

// Images are linked, never copied. Movies get Stremio's public metahub
// artwork (keyed by IMDb id); series use TVmaze's own images.
const metahub = (kind, imdb, size = 'medium') =>
  `https://images.metahub.space/${kind}/${size}/${imdb}/img`;

function manifest(lang) {
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
    catalogs: [
      { type: 'movie', id: 'wikimaze-popular', name: 'WikiMaze Popular', extra: [{ name: 'skip' }] },
      { type: 'series', id: 'wikimaze-airing', name: 'WikiMaze Airing now', extra: [{ name: 'skip' }] },
      { type: 'movie', id: 'wikimaze-search', name: 'WikiMaze', extra: [{ name: 'search', isRequired: true }] },
      { type: 'series', id: 'wikimaze-search', name: 'WikiMaze', extra: [{ name: 'search', isRequired: true }] },
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

async function localNames(imdbs, lang) {
  if (lang === 'en') return {};
  try {
    return await wikidata.labelsByImdb(imdbs, lang);
  } catch {
    return {}; // fall back to TVmaze's own names
  }
}

async function catalog(type, id, extra, lang) {
  const skip = Number(extra.skip) || 0;

  if (id === 'wikimaze-search') {
    const q = (extra.search || '').trim();
    if (!q) return [];
    return type === 'movie' ? searchMovies(q, lang) : searchSeries(q, lang);
  }
  if (type === 'movie' && id === 'wikimaze-popular') {
    const rows = await wikidata.popularMovies(lang, skip, PAGE);
    return rows.map(moviePreview);
  }
  if (type === 'series' && id === 'wikimaze-airing') {
    const shows = (await tvmaze.airingNow()).filter((s) => s.externals && s.externals.imdb);
    const page = shows.slice(skip, skip + PAGE);
    const names = await localNames(page.map((s) => s.externals.imdb), lang);
    return page.map((s) => seriesPreview(s, names[s.externals.imdb] && names[s.externals.imdb].name));
  }
  return [];
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
    if (out.has(r.imdb)) continue;
    out.set(r.imdb, {
      id: r.imdb,
      type: 'series',
      name: r.name,
      poster: metahub('poster', r.imdb),
      releaseInfo: r.year,
    });
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

module.exports = { manifest, catalog, meta };
