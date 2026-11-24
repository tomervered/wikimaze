// Offline tests: the data sources are replaced with stubs, so these check
// the merging rules, not Wikidata or TVmaze.
// Lists come from the live builders here, never from the published snapshot.
process.env.SNAPSHOT_URL = 'off';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const wikidata = require('../src/wikidata');
const tvmaze = require('../src/tvmaze');
const addon = require('../src/addon');
const { createServer } = require('../src/server');

function stub(obj, name, fn) {
  const orig = obj[name];
  obj[name] = fn;
  return () => (obj[name] = orig);
}

test('series search merges TVmaze and Wikidata by IMDb id, no duplicates', async () => {
  const undo = [
    stub(tvmaze, 'search', async () => [
      { id: 169, name: 'Breaking Bad', premiered: '2008-01-20', image: { medium: 'p.jpg' }, externals: { imdb: 'tt0903747' } },
      { id: 1, name: 'No IMDb', externals: { imdb: null } },
    ]),
    stub(wikidata, 'search', async () => [
      { imdb: 'tt0903747', qid: 'Q1079', name: 'שובר שורות', year: '2008' },
      { imdb: 'tt3032476', qid: 'Q1', name: 'סמוך על סול', year: '2015' },
    ]),
    stub(wikidata, 'labelsByImdb', async () => ({})),
  ];
  try {
    const metas = await addon.catalog('series', 'wikimaze-search', { search: 'x' }, 'he');
    assert.deepStrictEqual(metas.map((m) => m.id), ['tt0903747', 'tt3032476']);
    assert.strictEqual(metas[0].name, 'שובר שורות');
    assert.strictEqual(metas[0].poster, 'p.jpg');
  } finally {
    undo.forEach((u) => u());
  }
});

test('English keeps TVmaze names; one failing source still returns the other', async () => {
  const undo = [
    stub(tvmaze, 'search', async () => [{ id: 169, name: 'Breaking Bad', externals: { imdb: 'tt0903747' } }]),
    stub(wikidata, 'search', async () => {
      throw new Error('down');
    }),
  ];
  try {
    const metas = await addon.catalog('series', 'wikimaze-search', { search: 'x' }, 'en');
    assert.deepStrictEqual(metas.map((m) => [m.id, m.name]), [['tt0903747', 'Breaking Bad']]);
  } finally {
    undo.forEach((u) => u());
  }
});

test('series meta: TVmaze episodes keyed imdb:season:episode, specials skipped', async () => {
  const undo = [
    stub(wikidata, 'details', async () => ({
      qid: 'Q1079', name: 'שובר שורות', description: 'סדרה', genres: ['פשע'], cast: [], director: [], country: [],
    })),
    stub(tvmaze, 'showByImdb', async () => ({ id: 169 })),
    stub(tvmaze, 'showFull', async () => ({
      id: 169, name: 'Breaking Bad', url: 'https://www.tvmaze.com/shows/169', premiered: '2008-01-20', ended: '2013-09-29',
      status: 'Ended', summary: '<p>Walter <b>White</b></p>', genres: ['Drama'], runtime: 60,
      _embedded: {
        episodes: [
          { season: 1, number: 1, name: 'Pilot', airstamp: '2008-01-21T03:00:00+00:00' },
          { season: 1, number: null, name: 'Special' },
        ],
        cast: [{ person: { name: 'Bryan Cranston' } }],
        images: [],
      },
    })),
  ];
  try {
    const m = await addon.meta('series', 'tt0903747', 'he');
    assert.strictEqual(m.name, 'שובר שורות');
    assert.deepStrictEqual(m.genres, ['פשע']);
    assert.strictEqual(m.releaseInfo, '2008-2013');
    assert.strictEqual(m.description, 'סדרה\n\nWalter White');
    assert.deepStrictEqual(m.videos.map((v) => v.id), ['tt0903747:1:1']);
    assert.deepStrictEqual(m.cast, ['Bryan Cranston']);
  } finally {
    undo.forEach((u) => u());
  }
});

test('meta rejects non-IMDb ids without calling anything', async () => {
  assert.strictEqual(await addon.meta('movie', 'kitsu:1', 'en'), null);
});

test('server routes manifest, language prefix and extras', async () => {
  const undo = stub(wikidata, 'search', async (type, q, lang) => [{ imdb: 'tt1375666', name: `${q}/${lang}`, year: '2010' }]);
  const server = createServer().listen(0);
  const port = server.address().port;
  const get = (p) =>
    new Promise((resolve, reject) =>
      http.get({ port, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }).on('error', reject)
    );
  try {
    const man = await get('/he/manifest.json');
    assert.strictEqual(man.status, 200);
    assert.strictEqual(JSON.parse(man.body).id, 'community.wikimaze.he');
    assert.strictEqual(man.headers['access-control-allow-origin'], '*');

    const cat = await get('/he/catalog/movie/wikimaze-search/search=%D7%94%D7%AA%D7%97%D7%9C%D7%94.json');
    assert.strictEqual(JSON.parse(cat.body).metas[0].name, 'התחלה/he');

    // Vercel's routing (vercel.json) adds ?path=; either form must resolve.
    for (const p of ['/he/manifest.json?path=%2Fhe%2Fmanifest.json', '/api/index.js?path=%2Fhe%2Fmanifest.json']) {
      assert.strictEqual(JSON.parse((await get(p)).body).id, 'community.wikimaze.he', p);
    }

    assert.strictEqual((await get('/nope.json')).status, 404);
    assert.match((await get('/')).body, /Install in Stremio/);
  } finally {
    undo();
    server.close();
  }
});

test('genre filters: option text in either language, on every list', async () => {
  addon.clearLists();
  const undo = [
    stub(wikidata, 'classics', async (type) => [
      { imdb: 'tt1', name: 'Funny', year: '2020', genres: [type === 'movie' ? 'Q157443' : 'Q9335576'] },
      { imdb: 'tt2', name: 'Sad', year: '2021', genres: ['Q130232'] },
    ]),
    stub(tvmaze, 'airingNow', async () => [
      { id: 1, name: 'A', genres: ['Drama'], externals: { imdb: 'tt10' } },
      { id: 2, name: 'B', genres: ['Comedy'], externals: { imdb: 'tt20' } },
    ]),
    stub(wikidata, 'labelsByImdb', async () => ({})),
  ];
  try {
    const movies = await addon.catalog('movie', 'wikimaze-popular', { genre: 'קומדיה' }, 'he');
    assert.deepStrictEqual(movies.map((m) => m.id), ['tt1']);
    assert.strictEqual(movies[0].g, undefined); // genre keys stay internal
    const series = await addon.catalog('series', 'wikimaze-classics', { genre: 'Comedy' }, 'he');
    assert.deepStrictEqual(series.map((m) => m.id), ['tt1']);
    assert.deepStrictEqual((await addon.catalog('series', 'wikimaze-classics', {}, 'he')).length, 2);
    assert.deepStrictEqual(await addon.catalog('movie', 'wikimaze-popular', { genre: 'Nope' }, 'en'), []);

    const drama = await addon.catalog('series', 'wikimaze-airing', { genre: 'Drama' }, 'en');
    assert.deepStrictEqual(drama.map((m) => m.id), ['tt10']);

    const man = addon.manifest('he');
    assert.ok(man.catalogs.every((c) => c.extra.some((e) => e.name === 'genre' && e.options.length > 5)));
    assert.ok(man.catalogs.every((c) => !c.extra.some((e) => e.isRequired)));
    assert.deepStrictEqual(
      man.catalogs.map((c) => c.name),
      [
        'WikiMovies - Trending',
        'WikiSeries - Trending',
        'WikiMovies - Surging',
        'WikiSeries - Surging',
        'WikiMovies - Brand New',
        'WikiSeries - Brand New',
        'WikiMovies - Classics',
        'WikiSeries - Classics',
        'WikiSeries - Airing now',
      ]
    );
  } finally {
    undo.forEach((u) => u());
  }
});

test('trending: two editions or the viewer\'s own come first; local edition weighs more', async () => {
  const lists = {
    en: [{ article: 'Main_Page', views: 9e9 }, { article: 'Big_Film', views: 600 }, { article: 'Show_(TV_series)', views: 300 }, { article: 'Solo_Film', views: 100 }],
    de: [{ article: 'Big_Film', views: 100 }],
    he: [{ article: 'הבריחה', views: 50 }, { article: 'סדרה', views: 50 }],
  };
  const items = {
    en: {
      'Big Film': { imdb: 'tt1', name: 'Big', type: 'movie', firstDate: '2020-01-02' },
      'Show (TV series)': { imdb: 'tt2', name: 'Show', type: 'series' },
      'Solo Film': { imdb: 'tt9', name: 'Solo', type: 'movie', firstDate: '2020-01-02' },
    },
    de: { 'Big Film': { imdb: 'tt1', name: 'Big', type: 'movie', firstDate: '2020-01-02' } },
    he: { 'הבריחה': { imdb: 'tt3', name: 'הבריחה', type: 'series' }, 'סדרה': { imdb: 'tt2', name: 'Show', type: 'series' } },
  };
  const undo = stub(wikidata, 'itemsForWikiTitles', async (titles, wiki) => items[wiki] || {});
  const http = require('../src/http');
  const realGet = http.getJson;
  http.getJson = async (url) => {
    const wiki = url.match(/top\/(\w+)\.wikipedia/)[1];
    return { items: [{ articles: lists[wiki] || [] }] };
  };
  try {
    // trending.js is reloaded so it picks up the stubbed getJson.
    delete require.cache[require.resolve('../src/trending')];
    const fresh = require('../src/trending');
    // tt2: en share + 3 x he share, two editions; tt3: Hebrew only, but local.
    assert.deepStrictEqual((await fresh.trending('series', 'he')).map((x) => x.imdb), ['tt2', 'tt3']);
    // tt9 trends only on English Wikipedia: after tt1 (en and de) although it
    // has more views there, and still listed so scrolling keeps loading.
    assert.deepStrictEqual((await fresh.trending('movie', 'en')).map((x) => x.imdb), ['tt1', 'tt9']);
  } finally {
    http.getJson = realGet;
    delete require.cache[require.resolve('../src/trending')];
    undo();
  }
});

test('getJson gives up at its time limit instead of hanging', async () => {
  const { getJson } = require('../src/http');
  const server = http.createServer(() => {}).listen(0); // never answers
  try {
    const started = Date.now();
    await assert.rejects(getJson(`http://127.0.0.1:${server.address().port}/slow`, { timeout: 300 }));
    assert.ok(Date.now() - started < 2000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('responses allow serving stale while refreshing; empty lists are kept briefly', async () => {
  const undo = [
    stub(wikidata, 'search', async (type, q) => (q === 'none' ? [] : [{ imdb: 'tt1375666', name: q, year: '2010' }])),
  ];
  const server = createServer().listen(0);
  const port = server.address().port;
  const head = (p) => new Promise((resolve) => http.get({ port, path: p }, (res) => { res.resume(); resolve(res.headers['cache-control']); }));
  try {
    assert.match(await head('/catalog/movie/wikimaze-live/search=x.json'), /stale-while-revalidate=86400/);
    assert.strictEqual(await head('/catalog/movie/wikimaze-live/search=none.json'), 'public, max-age=60, s-maxage=60');
  } finally {
    undo.forEach((u) => u());
    server.close();
  }
});

test('releasedBy: out, out within two weeks, or a past year', () => {
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  assert.ok(wikidata.releasedBy({ firstDate: day(-30) }));
  assert.ok(wikidata.releasedBy({ firstDate: day(10) }));
  assert.ok(!wikidata.releasedBy({ firstDate: day(30) }));
  const year = new Date().getUTCFullYear();
  assert.ok(wikidata.releasedBy({ year: String(year - 1) }));
  assert.ok(!wikidata.releasedBy({ year: String(year) }));
});

test('surge: steady climbers rank, big steady titles and one-day blips do not', () => {
  const { surge } = require('../src/trending');
  const day = (o) => new Map(Object.entries(o));
  const days = [
    day({ Small: 0.04, Big: 0.42, Blip: 0.3, Gone: 0.01 }),
    day({ Small: 0.03, Big: 0.40, Blip: 0.01 }),
    day({ Small: 0.01, Big: 0.40, Blip: 0.01, Gone: 0.2 }),
    day({ Small: 0.01, Big: 0.38, Blip: 0.01, Gone: 0.2 }),
  ];
  const s = surge(days);
  assert.deepStrictEqual([...s.keys()], ['Small']);
  assert.ok(s.get('Small') > 0);
});

test('recency: new titles weigh 1, a year-old one about 0.55, old ones the floor', () => {
  const { recency } = require('../src/trending');
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  assert.ok(recency(ago(-5)) === 1);
  assert.ok(Math.abs(recency(ago(365)) - 0.55) < 0.01);
  assert.ok(recency(ago(3650)) < 0.11);
  assert.strictEqual(recency(undefined), 0.1);
  assert.ok(Math.abs(recency(ago(730), 730, 0.5) - 0.75) < 0.01);
});

test('movie age weight: falls for recent years, rises again for old films', () => {
  const { movieAgeWeight } = require('../src/trending');
  const ago = (y) => new Date(Date.now() - y * 365 * 86400000).toISOString().slice(0, 10);
  assert.strictEqual(movieAgeWeight(ago(-0.01)), 1);
  assert.ok(Math.abs(movieAgeWeight(ago(2)) - 0.58) < 0.01);
  assert.ok(movieAgeWeight(ago(10)) < movieAgeWeight(ago(40)));
});

test('install link picks lists: "he.tc" keeps Trending and Classics only', () => {
  const m = addon.manifest('he', 'tc');
  assert.deepStrictEqual(
    [...new Set(m.catalogs.map((c) => c.id))].sort(),
    ['wikimaze-classics', 'wikimaze-popular', 'wikimaze-trending']
  );
  assert.notStrictEqual(m.id, addon.manifest('he').id);
  assert.strictEqual(addon.manifest('he').catalogs.length, 9);
  assert.ok(!addon.manifest('he', 'tl').catalogs.some((c) => c.id === 'wikimaze-live'));
});

test('regions: link prefix parses, manifest is named, unknown regions are ignored', async () => {
  const addon = require('../src/addon');
  const m = addon.manifest('he', null, 'il');
  assert.strictEqual(m.id, 'community.wikimaze.he-il');
  assert.ok(m.name.endsWith(' IL'));
  assert.strictEqual(addon.manifest('en', null, 'zz').id, 'community.wikimaze');
  const { REGIONS, REGION_WEIGHT } = require('../src/trending');
  assert.deepStrictEqual(REGIONS, ['us', 'gb', 'de', 'fr', 'es', 'it', 'pl', 'il', 'eg', 'jp', 'br']);
  assert.ok(REGION_WEIGHT > 0.5 && REGION_WEIGHT < 1);
});

test('store: one entry per title, history keeps lists long, search and filters', () => {
  const store = require('../src/store');
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const item = (id, name, year, g = [], type = 'movie') => ({ id, type, name, poster: 'p', releaseInfo: String(year), g });
  const first = store.merge(null, {
    'movie/wikimaze-trending': [item('tt1', 'The Odyssey', 2026, ['adventure']), item('tt2', 'Old News', 2010)],
    'movie/wikimaze-new': [item('tt1', 'The Odyssey', 2026, ['adventure'])],
  }, day(10));
  assert.strictEqual(Object.keys(first.titles).length, 2); // The Odyssey once
  assert.deepStrictEqual(Object.keys(first.titles.tt1.seen).sort(), ['movie/wikimaze-new', 'movie/wikimaze-trending']);

  const second = store.merge(first, { 'movie/wikimaze-trending': [item('tt3', 'Amélie', 2001, ['romance'])] }, day(0));
  // Today's ranking first, then recent history; nothing is dropped.
  assert.deepStrictEqual(second.lists['movie/wikimaze-trending'], ['tt3', 'tt1', 'tt2']);
  assert.strictEqual(Object.keys(second.titles).length, 3);

  const q = (o) => store.query(second.titles, o).map((e) => e.id);
  assert.deepStrictEqual(q({ q: 'amelie' }), ['tt3']); // accents ignored
  assert.deepStrictEqual(q({ q: 'odyss' }), ['tt1']);
  assert.deepStrictEqual(q({ genre: 'adventure' }), ['tt1']);
  assert.deepStrictEqual(q({ from: 2000, to: 2009 }), ['tt3']);
  assert.deepStrictEqual(store.yearRange('2010s'), [2010, 2019]);
  assert.deepStrictEqual(store.yearRange('Older'), [0, 1969]);
});

test('series genres: TVmaze wins over Wikidata tone tags (Breaking Bad is not a comedy)', () => {
  const store = require('../src/store');
  const genres = require('../src/genres');
  const wd = genres.keysFor({ ids: ['Q1366112', 'Q9335577', 'Q20652466', 'Q21010853'] });
  assert.ok(!wd.includes('comedy'));
  const e = store.entryOf({ id: 'tt0903747', type: 'series', name: 'Breaking Bad', g: ['comedy', 'drama'] }, { mz: ['Drama', 'Crime', 'Thriller'] });
  assert.deepStrictEqual(e.g.sort(), ['crime', 'drama', 'thriller']);
});

test('search: "!" forces a live query; category search stays inside the list', async () => {
  assert.deepStrictEqual(addon.parseQuery('breaking bad!'), { q: 'breaking bad', forced: true });
  assert.deepStrictEqual(addon.parseQuery('odyssey'), { q: 'odyssey', forced: false });
});

test('api: /api/genres and /he/api/genres answer JSON', async () => {
  const server = createServer().listen(0);
  const port = server.address().port;
  const get = (p) => new Promise((resolve) => http.get({ port, path: p }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve([res.statusCode, d])); }));
  try {
    const [s1, b1] = await get('/api/genres');
    assert.strictEqual(s1, 200);
    assert.ok(JSON.parse(b1).genres.some((g) => g.key === 'comedy' && g.label === 'Comedy'));
    const [, b2] = await get('/he/api/genres');
    assert.ok(JSON.parse(b2).genres.some((g) => g.label === 'קומדיה'));
  } finally {
    server.close();
  }
});
