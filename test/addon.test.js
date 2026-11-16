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

test('genre option text maps back to its id in either language; unknown genre is empty', async () => {
  let seen;
  const undo = [
    stub(wikidata, 'popularMovies', async (lang, skip, size, genre) => {
      seen = genre;
      return [{ imdb: 'tt1', name: 'x', year: '2020' }];
    }),
    stub(tvmaze, 'airingNow', async () => [
      { id: 1, name: 'A', genres: ['Drama'], externals: { imdb: 'tt10' } },
      { id: 2, name: 'B', genres: ['Comedy'], externals: { imdb: 'tt20' } },
    ]),
  ];
  try {
    await addon.catalog('movie', 'wikimaze-popular', { genre: 'קומדיה' }, 'he');
    assert.deepStrictEqual(seen, ['Q157443', 'Q860626']);
    await addon.catalog('movie', 'wikimaze-popular', { genre: 'Comedy' }, 'he');
    assert.deepStrictEqual(seen, ['Q157443', 'Q860626']);
    assert.deepStrictEqual(await addon.catalog('movie', 'wikimaze-popular', { genre: 'Nope' }, 'en'), []);

    const drama = await addon.catalog('series', 'wikimaze-airing', { genre: 'Drama' }, 'en');
    assert.deepStrictEqual(drama.map((m) => m.id), ['tt10']);

    const man = addon.manifest('he');
    const browse = man.catalogs.filter((c) => c.id !== 'wikimaze-trending');
    assert.ok(browse.every((c) => c.extra.some((e) => e.name === 'genre')));
    assert.ok(man.catalogs.every((c) => !c.extra.some((e) => e.isRequired)));
  } finally {
    undo.forEach((u) => u());
  }
});

test('trending merges English and local Wikipedia and keeps the asked type', async () => {
  const undo = [
    stub(wikidata, 'itemsForWikiTitles', async (titles, wiki) =>
      wiki === 'en'
        ? {
            'Big Film': { imdb: 'tt1', name: 'Big', type: 'movie' },
            'Show (TV series)': { imdb: 'tt2', name: 'Show', type: 'series' },
          }
        : { 'הבריחה': { imdb: 'tt3', name: 'הבריחה', type: 'series' }, 'סדרה': { imdb: 'tt2', name: 'Show', type: 'series' } }
    ),
  ];
  // Fixed top-viewed lists; trending.js is reloaded so it picks up the stub.
  const http = require('../src/http');
  const realGet = http.getJson;
  http.getJson = async (url) => ({
    items: [
      {
        articles: url.includes('/en.wikipedia/')
          ? [{ article: 'Main_Page', views: 9e9 }, { article: 'Big_Film', views: 600 }, { article: 'Show_(TV_series)', views: 400 }]
          : [{ article: 'הבריחה', views: 50 }, { article: 'סדרה', views: 50 }],
      },
    ],
  });
  try {
    delete require.cache[require.resolve('../src/trending')];
    const fresh = require('../src/trending');
    const series = await fresh.trending('series', 'he');
    // tt2 has 0.4 (en) + 0.5 (he); tt3 has 0.5 (he).
    assert.deepStrictEqual(series.map((x) => x.imdb), ['tt2', 'tt3']);
    const movies = await fresh.trending('movie', 'en');
    assert.deepStrictEqual(movies.map((x) => x.imdb), ['tt1']);
  } finally {
    http.getJson = realGet;
    delete require.cache[require.resolve('../src/trending')];
    undo.forEach((u) => u());
  }
});

test('details rows: billing order, then best known; runtime; Wikipedia in the viewer language', () => {
  const wd = require('../src/wikidata');
  const E = 'http://www.wikidata.org/entity/';
  const lit = (value) => ({ value });
  const row = (kind, v, extra = {}) => ({ item: lit(E + 'Q1'), kind: lit(kind), v: lit(v), ...extra });
  const rows = [
    row('label', 'en', { vl: lit('The Film (2001 film)') }),
    row('label', 'he', { vl: lit('הסרט') }),
    row('desc', 'en', { vl: lit('2001 film') }),
    row('wiki', 'https://en.wikipedia.org/', { vl: lit('https://en.wikipedia.org/wiki/The_Film') }),
    row('P577', '2001-05-01T00:00:00Z', { prec: lit('11') }),
    row('P577', '2000-01-01T00:00:00Z', { prec: lit('9') }),
    row('P577', '1900-01-01T00:00:00Z', { prec: lit('7') }), // century precision: ignored
    row('P2047', '7200', { unit: lit(E + 'Q11574'), n: lit('0') }),
    row('P161', E + 'Q10', { vl: lit('Minor'), n: lit('3') }),
    row('P161', E + 'Q11', { vl: lit('Star'), n: lit('90') }),
    row('P161', E + 'Q12', { vl: lit('Billed first'), n: lit('5'), ord: lit('1') }),
    row('P161', E + 'Q13', { vl: lit('Q13'), n: lit('99') }), // no label in any language
    row('P136', E + 'Q20', { vl: lit('דרמה'), n: lit('50') }),
  ];
  const d = wd.detailsFromRows(rows, 'Q1', 'movie', 'he');
  assert.strictEqual(d.name, 'הסרט');
  assert.strictEqual(d.englishName, 'The Film');
  assert.strictEqual(d.description, '2001 film');
  assert.strictEqual(d.year, '2000');
  assert.strictEqual(d.runtime, '120 min');
  assert.deepStrictEqual(d.cast, ['Billed first', 'Star', 'Minor']);
  assert.deepStrictEqual(d.genres, ['דרמה']);
  assert.strictEqual(d.wikipedia.url, 'https://en.wikipedia.org/wiki/The_Film');
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
