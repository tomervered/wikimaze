// Prebuilt lists, one JSON file per language:
//   { built: ISO time, lists: { "movie/wikimaze-trending": [items...], ... } }
// scripts/build-snapshot.js writes them and a GitHub Action publishes them
// to the repository's `data` branch every few hours. The add-on reads the
// file from GitHub's CDN and keeps it in memory for a few minutes, so a
// catalog request costs one small download at most, never a Wikidata query.

const { getJson } = require('./http');

const BASE =
  process.env.SNAPSHOT_URL || 'https://raw.githubusercontent.com/tomervered/wikimaze/data/snapshot';
const TTL = 10 * 60; // seconds

// The snapshot for `lang`, or null when there is none (or it can't be read
// within the time limit). Never throws.
async function load(lang) {
  if (process.env.SNAPSHOT_URL === 'off') return null;
  try {
    const data = await getJson(`${BASE}/${lang}.json`, { ttl: TTL, timeout: 4000 });
    return data && data.lists ? data : null;
  } catch {
    return null;
  }
}

// One list from the snapshot, or null.
async function list(type, id, lang) {
  const snap = await load(lang);
  const items = snap && snap.lists[`${type}/${id}`];
  return Array.isArray(items) ? items : null;
}

module.exports = { load, list, BASE };
