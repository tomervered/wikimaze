// Plain Node HTTP server speaking the Stremio add-on protocol.
// Routes (the language prefix is optional, English when absent):
//   /[he/]manifest.json
//   /[he/]catalog/:type/:id[/:extra].json
//   /[he/]meta/:type/:id.json
//   /  and  /configure  -> install page

const http = require('node:http');
const addon = require('./addon');
const { configurePage } = require('./page');

const LANG = /^[a-z]{2,3}$/;

function send(res, status, body, { type = 'application/json', maxAge = 0 } = {}) {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': maxAge ? `public, max-age=${maxAge}, s-maxage=${maxAge}` : 'no-store',
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
  let parts = url.pathname.split('/').filter(Boolean);
  let lang = 'en';
  if (parts.length && LANG.test(parts[0])) {
    lang = parts[0];
    parts = parts.slice(1);
  }

  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'configure')) {
    return send(res, 200, configurePage(origin, lang), { type: 'text/html', maxAge: 3600 });
  }
  if (parts.length === 1 && parts[0] === 'manifest.json') {
    return send(res, 200, addon.manifest(lang), { maxAge: 3600 });
  }
  if (parts.length === 1 && parts[0] === 'health') {
    return send(res, 200, { ok: true });
  }

  const last = parts.length ? parts[parts.length - 1] : '';
  if (!last.endsWith('.json')) return send(res, 404, { err: 'not found' });
  parts[parts.length - 1] = last.slice(0, -5);

  if (parts[0] === 'catalog' && (parts.length === 3 || parts.length === 4)) {
    const [, type, id, extra] = parts;
    const metas = await addon.catalog(type, decodeURIComponent(id), parseExtra(extra), lang);
    return send(res, 200, { metas }, { maxAge: extra && extra.includes('search=') ? 3600 : 6 * 3600 });
  }
  if (parts[0] === 'meta' && parts.length === 3) {
    const [, type, id] = parts;
    const meta = await addon.meta(type, decodeURIComponent(id), lang);
    if (!meta) return send(res, 404, { meta: null });
    return send(res, 200, { meta }, { maxAge: 12 * 3600 });
  }
  return send(res, 404, { err: 'not found' });
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
