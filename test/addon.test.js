// Offline tests: the data sources are replaced with stubs, so these check
// the merging rules, not Wikidata or TVmaze.
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
  let seen;
  const undo = [
    stub(wikidata, 'classics', async (type, lang, skip, size, genre) => {
      seen = [type, genre];
      return [{ imdb: 'tt1', name: 'x', year: '2020' }];
    }),
    stub(tvmaze, 'airingNow', async () => [
      { id: 1, name: 'A', genres: ['Drama'], externals: { imdb: 'tt10' } },
      { id: 2, name: 'B', genres: ['Comedy'], externals: { imdb: 'tt20' } },
    ]),
  ];
  try {
    await addon.catalog('movie', 'wikimaze-popular', { genre: 'קומדיה' }, 'he');
    assert.strictEqual(seen[0], 'movie');
    assert.ok(seen[1].includes('Q157443'));
    await addon.catalog('series', 'wikimaze-classics', { genre: 'Comedy' }, 'he');
    assert.strictEqual(seen[0], 'series');
    assert.ok(seen[1].includes('Q9335576'));
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
        'WikiMovies - Very Trending',
        'WikiSeries - Very Trending',
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
    assert.match(await head('/catalog/movie/wikimaze-popular/search=x.json'), /stale-while-revalidate=86400/);
    assert.strictEqual(await head('/catalog/movie/wikimaze-popular/search=none.json'), 'public, max-age=60, s-maxage=60');
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

test('spike: newest day against the average of the days before', () => {
  const { spike } = require('../src/trending');
  const days = [
    new Map([['New', 0.3], ['Steady', 0.2], ['Fading', 0.1]]),
    new Map([['Steady', 0.2], ['Fading', 0.4]]),
    new Map([['Steady', 0.2], ['Fading', 0.4]]),
  ];
  const s = spike(days);
  assert.deepStrictEqual([...s.keys()], ['New']);
  assert.ok(Math.abs(s.get('New') - 0.3) < 1e-9);
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
