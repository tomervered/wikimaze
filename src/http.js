// Outgoing HTTP: one User-Agent, a small in-memory cache, a per-host
// concurrency limit, retry on 429/5xx and a time limit per call. Wikimedia asks every client for a
// descriptive User-Agent and blocks generic ones.

const pkg = require('../package.json');

const USER_AGENT =
  process.env.USER_AGENT ||
  `wikimaze-stremio-addon/${pkg.version} (+${pkg.homepage})`;

// Parallel calls per host. The Wikidata query service allows 5 per client
// IP; TVmaze allows 20 calls per 10 seconds and answers in under a second.
const MAX_PER_HOST = { 'query.wikidata.org': 5, 'api.tvmaze.com': 6 };
const DEFAULT_PER_HOST = 4;
const DEFAULT_TIMEOUT = 12000;
// The snapshot build (scripts/build-snapshot.js) is not answering anyone and
// can wait longer: it multiplies every time limit by this.
const TIMEOUT_SCALE = Number(process.env.HTTP_TIMEOUT_SCALE) || 1;
const MAX_CACHE_ENTRIES = 5000;

const cache = new Map(); // url -> { expires, promise }
const hosts = new Map(); // host -> { active, queue }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withHostSlot(host, fn) {
  let h = hosts.get(host);
  if (!h) {
    h = { active: 0, queue: [] };
    hosts.set(host, h);
  }
  if (h.active >= (MAX_PER_HOST[host] || DEFAULT_PER_HOST)) {
    await new Promise((resolve) => h.queue.push(resolve));
  }
  h.active++;
  try {
    return await fn();
  } finally {
    h.active--;
    const next = h.queue.shift();
    if (next) next();
  }
}

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

class TimeoutError extends Error {
  constructor(url, ms) {
    super(`No answer in ${ms} ms from ${url}`);
  }
}

// `timeout` covers the whole call: waiting for a slot, every attempt and the
// pauses between them. A late upstream must not hold a Stremio request open.
async function fetchOnce(url, accept, body, timeout) {
  const host = new URL(url).host;
  const deadline = Date.now() + timeout;
  const left = () => deadline - Date.now();
  return withHostSlot(host, async () => {
    for (let attempt = 0; ; attempt++) {
      if (left() <= 0) throw new TimeoutError(url, timeout);
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        body,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept,
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(left()),
      });
      if (res.ok) return res.json();
      if (res.status === 404) return null;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 3) throw new HttpError(res.status, url);
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 10) * 1000
        : 500 * 2 ** attempt;
      if (wait >= left()) throw new HttpError(res.status, url);
      await sleep(wait);
    }
  });
}

// Fetch JSON with caching. Failed requests are not cached. Returns null on 404.
// `body` (a form-encoded string) makes it a POST, for queries too long for a
// URL; the body is part of the cache key.
function getJson(url, { ttl = 6 * 3600, accept = 'application/json', body, timeout = DEFAULT_TIMEOUT } = {}) {
  const now = Date.now();
  const key = body ? `${url}\n${body}` : url;
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.promise;

  const promise = fetchOnce(url, accept, body, timeout * TIMEOUT_SCALE);
  cache.set(key, { expires: now + ttl * 1000, promise });
  promise.catch(() => cache.delete(key));

  if (cache.size > MAX_CACHE_ENTRIES) {
    // Drop the oldest tenth; Map keeps insertion order.
    let n = Math.floor(MAX_CACHE_ENTRIES / 10);
    for (const key of cache.keys()) {
      cache.delete(key);
      if (--n <= 0) break;
    }
  }
  return promise;
}

module.exports = { getJson, HttpError, USER_AGENT };
