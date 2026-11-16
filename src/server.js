// Plain Node HTTP server speaking the Stremio add-on protocol.
// Routes (the language prefix is optional, English when absent):
//   /[he/]manifest.json
//   /[he/]catalog/:type/:id[/:extra].json
//   /[he/]meta/:type/:id.json
//   /  and  /configure  -> install page

const http = require('node:http');
const addon = require('./addon');
const { configurePage } = require('./page');

// First path segment: the language, optionally with the chosen lists after a
// dot, e.g. "he" or "he.tc" (see addon.LIST_FLAGS).
// A region may follow after a dash: "en-us", "he.tc-il" (Trending only).
const LANG = /^([a-z]{2,3})(?:\.([a-z]+))?(?:-([a-z]{2}))?$/;
const DAY = 86400;

// maxAge: how long Stremio and Vercel's CDN treat a response as fresh.
// stale: how long after that the CDN still answers instantly with the old
// copy while it fetches a new one in the background (and keeps serving it
// if the refresh fails), so only the very first visitor waits.
function send(res, status, body, { type = 'application/json', maxAge = 0, stale = 0 } = {}) {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': maxAge
      ? `public, max-age=${maxAge}, s-maxage=${maxAge}` +
        (stale ? `, stale-while-revalidate=${stale}, stale-if-error=${stale}` : '')
      : 'no-store',
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// "search=foo&skip=100" -> { search: 'foo', skip: '100' }
function parseExtra(s) {
  const out = {};
  if (!s) return out;
  for (const part of s.split('&')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

async function route(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '', { type: 'text/plain' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { err: 'method' });

  const url = new URL(req.url, 'http://localhost');
  // Vercel routes every path to one function (vercel.json). It keeps the
  // original path in req.url and adds ?path=<encoded path>. Should a
  // deployment ever show the function's own path instead, fall back to the
  // query value, taken raw and decoded once: a catalog extra such as
  // "search=x&skip=100" holds '&', which searchParams would cut off.
  let path = url.pathname;
  const routed = req.url.indexOf('?path=');
  if (/^\/api\/index(\.js)?$/.test(path) && routed >= 0) {
    try {
      path = decodeURIComponent(req.url.slice(routed + 6));
    } catch {
      path = '/';
    }
  }
  let parts = path.split('/').filter(Boolean);
  let lang = 'en';
  let lists = null;
  let region = null;
  const prefix = parts.length && parts[0].match(LANG);
  if (prefix) {
    lang = prefix[1];
    lists = prefix[2] || null;
    region = prefix[3] || null;
    parts = parts.slice(1);
  }

  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'configure')) {
    return send(res, 200, configurePage(origin, lang, region), { type: 'text/html', maxAge: 3600 });
  }
  if (parts.length === 1 && parts[0] === 'manifest.json') {
    return send(res, 200, addon.manifest(lang, lists, region), { maxAge: 3600 });
  }
  if (parts.length === 1 && parts[0] === 'health') {
    return send(res, 200, { ok: true });
  }
  if (parts.length === 1 && parts[0] === 'warm') {
    return send(res, 200, await warm(origin));
  }

  const last = parts.length ? parts[parts.length - 1] : '';
  if (!last.endsWith('.json')) return send(res, 404, { err: 'not found', url: req.url });
  parts[parts.length - 1] = last.slice(0, -5);

  if (parts[0] === 'catalog' && (parts.length === 3 || parts.length === 4)) {
    const [, type, id, extra] = parts;
    const metas = await addon.catalog(type, decodeURIComponent(id), parseExtra(extra), lang, region);
    const search = extra && extra.includes('search=');
    // An empty list may only mean an upstream timed out: keep it briefly.
    if (!metas.length) return send(res, 200, { metas }, { maxAge: 60 });
    return send(res, 200, { metas }, search ? { maxAge: 3600, stale: DAY } : { maxAge: 6 * 3600, stale: 7 * DAY });
  }
  if (parts[0] === 'meta' && parts.length === 3) {
    const [, type, id] = parts;
    const meta = await addon.meta(type, decodeURIComponent(id), lang);
    if (!meta) return send(res, 404, { meta: null });
    return send(res, 200, { meta }, { maxAge: 12 * 3600, stale: 7 * DAY });
  }
  return send(res, 404, { err: 'not found', url: req.url });
}

// Requests the home rows through the public URL, so Vercel's CDN holds a
// copy and Stremio never waits for a cold build (Trending takes 20-30 s).
// Run daily by the cron in vercel.json; harmless to call by hand.
const WARM_LANGS = ['en', 'he'];
// Every catalog in the manifest that has no required extra.
const WARM_FIRST = [
  'movie/wikimaze-trending',
  'movie/wikimaze-popular',
  'series/wikimaze-classics',
  'series/wikimaze-airing',
  'series/wikimaze-hot',
];
// Built from the same Wikipedia data as movie trending, so they go second.
const WARM_AFTER = ['series/wikimaze-trending', 'movie/wikimaze-hot'];

async function warm(origin) {
  const out = {};
  const hit = async (lang, path) => {
    const url = `${origin}${lang === 'en' ? '' : '/' + lang}/catalog/${path}.json`;
    const started = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(55000) });
      out[url] = `${r.status} ${Date.now() - started} ms`;
    } catch (err) {
      out[url] = err.message;
    }
  };
  await Promise.all(
    WARM_LANGS.map(async (lang) => {
      await Promise.all(WARM_FIRST.map((p) => hit(lang, p)));
      await Promise.all(WARM_AFTER.map((p) => hit(lang, p)));
    })
  );
  return out;
}

function handler(req, res) {
  const started = Date.now();
  return route(req, res)
    .catch((err) => {
      console.error(`${req.url}: ${err.message}`);
      if (!res.headersSent) send(res, 502, { err: 'upstream error' });
    })
    .finally(() => {
      if (process.env.LOG_REQUESTS) console.log(`${res.statusCode} ${Date.now() - started}ms ${req.url}`);
    });
}

function createServer() {
  return http.createServer(handler);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 7000;
  createServer().listen(port, () => {
    console.log(`WikiMaze add-on on http://127.0.0.1:${port}/manifest.json`);
    // Warm the slowest catalog so the first visitor doesn't wait for it.
    addon.catalog('movie', 'wikimaze-popular', {}, 'en').catch(() => {});
  });
}

// The module itself is the request handler, so hosts that import this file
// as a function entry point (Vercel's zero-config Node detection picks up
// src/server.js) get something they can call.
module.exports = handler;
module.exports.handler = handler;
module.exports.createServer = createServer;
