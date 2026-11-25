// Genre pools: more titles of one genre, so a genre filter keeps going after
// a list's own titles run out (a list of 400 trending films may hold only
// a handful of westerns).
//
// Each pool is its own file in WikiMaze's data (the `data` branch, next to
// the snapshot), read only when someone filters by that genre:
//   pools/<lang>/movie-<genre>.json
//     { built: "YYYY-MM-DD", deepest, years: { "2025": [entries] } }
//     Films newest year first, each year best known first (Wikidata).
//     Once a day the build refreshes the last RECENT_YEARS years and reaches
//     DEEPEN years further back, so the stored pool grows day by day down to
//     OLDEST_YEAR. Until then the add-on asks Wikidata live for the years
//     past `deepest` as the viewer scrolls.
//   pools/<lang>/series-<genre>.json
//     { built, items: [entries] }
//     Every TVmaze show of the genre with an IMDb id, most popular first
//     (TVmaze weight), up to SERIES_POOL. Refreshed once a day.
// Entries have the title store's shape (store.entryOf).

const fs = require('node:fs');
const path = require('node:path');
const wikidata = require('./wikidata');
const tvmaze = require('./tvmaze');
const genres = require('./genres');
const store = require('./store');

const RECENT_YEARS = 3;
const DEEPEN = 5;
const PER_YEAR = 100;
const OLDEST_YEAR = 1950;
const SERIES_POOL = 500;

const thisYear = () => new Date().getUTCFullYear();
const today = () => new Date().toISOString().slice(0, 10);
const file = (lang, type, genre) => `pools/${lang}/${type}-${genre}.json`;

// Genres that get a pool: every genre a list of that type can filter by.
function poolGenres(type) {
  return genres
    .all('en')
    .filter((g) => g[type])
    .map((g) => genres.byKey(g.key))
    .filter((g) => (type === 'movie' ? g.ids.length > 0 : g.maze || g.key === 'animation'));
}

// One year of a movie genre as store entries. `toItem` is lists.fromWikidata.
async function movieYear(genre, year, lang, toItem, limit = PER_YEAR) {
  const rows = (await wikidata.genreYear('movie', lang, genre.ids, year)).slice(0, limit);
  return rows.map((r) => store.entryOf({ ...toItem('movie', r), in: r.indian || undefined }));
}

// Pool entries in order, and the oldest stored year (movies).
function entries(pool) {
  if (!pool) return { items: [], deepest: null };
  if (pool.items) return { items: pool.items, deepest: null };
  const items = Object.keys(pool.years || {})
    .sort((a, b) => b - a)
    .flatMap((y) => pool.years[y]);
  return { items, deepest: pool.deepest };
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// One movie pool, refreshed (or copied when already built today).
async function movieFile(g, lang, prev, toItem, log) {
  const now = thisYear();
  if (prev && prev.built === today()) return prev;
  const start = prev && prev.deepest ? prev.deepest : now - RECENT_YEARS + 1;
  const deepest = Math.max(OLDEST_YEAR, Math.min(start, now - RECENT_YEARS + 1) - DEEPEN);
  const years = { ...((prev && prev.years) || {}) };
  let reached = now + 1;
  for (let y = now; y >= deepest; y--) {
    // Older years don't change; only recent ones and new depth are asked.
    if (y <= now - RECENT_YEARS && years[y]) {
      reached = y;
      continue;
    }
    try {
      years[y] = await movieYear(g, y, lang, toItem);
      reached = y;
    } catch (err) {
      log(`movie ${g.key} ${y}: ${err.message}`);
      if (!years[y]) break; // never stored: the next run starts here
      reached = y;
    }
  }
  return { built: today(), deepest: Math.min(reached, start), years };
}

// TVmaze's index, read once per run and shared by every language.
let indexOnce = null;
function seriesIndex() {
  indexOnce =
    indexOnce ||
    tvmaze.allShows().then((all) =>
      all.filter((s) => s.externals && s.externals.imdb).sort((a, b) => (b.weight || 0) - (a.weight || 0))
    );
  return indexOnce;
}

// Every pool for one language: reads prevDir/pools, writes outDir/pools.
// `lists` is src/lists (fromWikidata, fromTvmaze, localNames).
async function buildAll(lang, prevDir, outDir, lists, log = console.error) {
  fs.mkdirSync(path.join(outDir, 'pools', lang), { recursive: true });
  const read = (type, key) => readJson(path.join(prevDir || '', file(lang, type, key)));
  const write = (type, key, data) => fs.writeFileSync(path.join(outDir, file(lang, type, key)), JSON.stringify(data));
  const summary = { movie: 0, series: 0 };

  // Films: two genres at a time, each asking Wikidata a year at a time
  // (the query service allows five parallel queries per client).
  const queue = poolGenres('movie');
  const worker = async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      const pool = await movieFile(g, lang, read('movie', g.key), lists.fromWikidata, log);
      write('movie', g.key, pool);
      summary.movie += entries(pool).items.length;
    }
  };
  await Promise.all([worker(), worker()]);

  // Series: from TVmaze's index, unless built today already.
  const todo = poolGenres('series').filter((g) => {
    const prev = read('series', g.key);
    if (prev && prev.built === today()) {
      write('series', g.key, prev);
      summary.series += prev.items.length;
      return false;
    }
    return true;
  });
  if (todo.length) {
    try {
      const shows = await seriesIndex();
      const picked = {};
      for (const g of todo) {
        const match = g.key === 'animation' ? (s) => s.type === 'Animation' : (s) => (s.genres || []).includes(g.maze);
        picked[g.key] = shows.filter(match).slice(0, SERIES_POOL);
      }
      const ids = [...new Set(Object.values(picked).flat().map((s) => s.externals.imdb))];
      const names = {};
      for (let i = 0; i < ids.length; i += 300) Object.assign(names, await lists.localNames(ids.slice(i, i + 300), lang));
      for (const g of todo) {
        const items = picked[g.key].map((s) =>
          store.entryOf(lists.fromTvmaze(s, names[s.externals.imdb] && names[s.externals.imdb].name))
        );
        write('series', g.key, { built: today(), items });
        summary.series += items.length;
      }
    } catch (err) {
      log(`series pools: ${err.message}; keeping yesterday's`);
      for (const g of todo) {
        const prev = read('series', g.key);
        if (prev) write('series', g.key, prev);
      }
    }
  }
  return summary;
}

module.exports = { file, poolGenres, movieYear, entries, buildAll, OLDEST_YEAR };
