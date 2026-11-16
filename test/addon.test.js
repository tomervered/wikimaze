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
