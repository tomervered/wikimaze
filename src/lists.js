// The browsable lists (every catalog without a search term), built whole:
// ranked, every item already in Stremio's preview shape, plus `g`, the
// genre keys it belongs to (see genres.keysFor). Paging and genre filters
// are cut from the whole list (addon.catalog), so one build serves them all.
//
// Building a list is slow (Trending reads 63 Wikipedia top lists and runs
// seven big Wikidata queries), so it does not happen while Stremio waits: a
// scheduled GitHub Action runs scripts/build-snapshot.js and publishes the
// lists as one JSON file per language (see snapshot.js). These builders run
// at request time only when no snapshot can be read.
//
// Items carry only what a list shows: IMDb id, name, poster link, year and
// genres. Everything else is fetched when a title is opened (addon.meta).

const wikidata = require('./wikidata');
const tvmaze = require('./tvmaze');
const genres = require('./genres');
const { trending, regional, recency } = require('./trending');

// Longest list kept per catalog; Stremio pages through it 100 at a time.
const MAX_ITEMS = 2000;
// Classics are cut from the best-known titles of all time; a genre filter
// then keeps the ones of that genre among them.
const CLASSICS_POOL = 3000;
// Brand New: out (film release, series premiere) within this many days.
const NEW_DAYS = 30;

// The catalogs built here, by "type/id". Order matters only for the build
// script: series Trending and movie Surging reuse the movie Trending
// data, so they come after it.
const LISTS = [
  'movie/wikimaze-trending',
  'movie/wikimaze-popular',
  'series/wikimaze-classics',
  'series/wikimaze-airing',
  'series/wikimaze-hot',
  'series/wikimaze-trending',
  'movie/wikimaze-hot',
  'movie/wikimaze-new',
  'series/wikimaze-new',
];

const metahub = (kind, imdb, size = 'medium') => `https://images.metahub.space/${kind}/${size}/${imdb}/img`;

// "2008-2013" for an ended series, "2019-" for one still running, the year
// alone for a film or a one-year series.
function years(start, end, running) {
  if (!start) return undefined;
  if (running) return `${start}-`;
  return end && end !== start ? `${start}-${end}` : start;
}

function fromWikidata(type, r) {
  return {
    id: r.imdb,
    type,
    name: r.name,
    poster: metahub('poster', r.imdb),
    releaseInfo: type === 'series' ? years(r.year, r.endYear, !r.endYear) : r.year,
    date: r.firstDate,
    g: genres.keysFor({ ids: r.genres || [] }),
  };
}

function fromTvmaze(show, localName) {
  const imdb = show.externals.imdb;
  return {
    id: imdb,
    type: 'series',
    name: localName || show.name,
    poster: tvmaze.image(show.image, 'medium') || metahub('poster', imdb),
    releaseInfo: years(
      show.premiered && show.premiered.slice(0, 4),
      show.ended && show.ended.slice(0, 4),
      show.status === 'Running' || show.status === 'In Development'
    ),
    date: show.premiered,
    en: show.name,
    mz: show.genres || [],
    g: genres.keysFor({ maze: show.genres || [] }),
  };
}

async function localNames(imdbs, lang) {
  if (lang === 'en' || !imdbs.length) return {};
  try {
    return await wikidata.labelsByImdb(imdbs, lang);
  } catch {
    return {}; // keep TVmaze's own names
  }
}

// Surging series: a zipper of two orders, one title from each in
// turn: TVmaze's plain popularity weight (as in Airing now) and the same
// weight times a premiere-date weight (two-year half-life, floor 0.5) that
// favours new shows. Each show is listed once.
function zipper(shows) {
  const plain = [...shows].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const score = (x) => (x.weight || 0) * recency(x.premiered, 730, 0.5);
  const fresh = [...shows].sort((a, b) => score(b) - score(a));
  const seen = new Set();
  const out = [];
  for (let i = 0; i < plain.length; i++) {
    for (const s of [plain[i], fresh[i]]) if (!seen.has(s.id)) seen.add(s.id) && out.push(s);
  }
  return out;
}

async function tvmazeList(id, lang) {
  const recent =
    id === 'wikimaze-new'
      ? tvmaze.premieres(['US', 'GB', 'IL'], NEW_DAYS)
      : id === 'wikimaze-hot'
        ? tvmaze.airingNow(['US', 'GB', 'IL'], 2)
        : tvmaze.airingNow();
  let shows = (await recent).filter((s) => s.externals && s.externals.imdb);
  if (id === 'wikimaze-hot') shows = zipper(shows);
  shows = shows.slice(0, MAX_ITEMS);
  // Labels in batches: one query for a few hundred ids stays well under
  // the query service's limits.
  const names = {};
  for (let i = 0; i < shows.length; i += 300) {
    Object.assign(names, await localNames(shows.slice(i, i + 300).map((s) => s.externals.imdb), lang));
  }
  return shows.map((s) => fromTvmaze(s, names[s.externals.imdb] && names[s.externals.imdb].name));
}

// The whole ranked list for one catalog, or null when there is no such list.
async function build(type, id, lang, region = null) {
  if (!LISTS.includes(`${type}/${id}`)) return null;
  if (region && id === 'wikimaze-trending') {
    const rows = await regional(type, lang, region);
    return rows.slice(0, MAX_ITEMS).map((r) => fromWikidata(type, r));
  }
  if (id === 'wikimaze-trending' || (type === 'movie' && id === 'wikimaze-hot')) {
    const rows = await trending(type, lang, id === 'wikimaze-hot' ? 'spike' : 'trending');
    return rows.slice(0, MAX_ITEMS).map((r) => fromWikidata(type, r));
  }
  if (type === 'movie' && id === 'wikimaze-new') {
    const rows = await wikidata.newFilms(lang, NEW_DAYS);
    return rows.slice(0, MAX_ITEMS).map((r) => fromWikidata(type, r));
  }
  if (id === 'wikimaze-popular' || id === 'wikimaze-classics') {
    const rows = await wikidata.classics(type, lang, 0, CLASSICS_POOL);
    return rows.map((r) => fromWikidata(type, r));
  }
  return tvmazeList(id, lang);
}

module.exports = { LISTS, build, zipper };
