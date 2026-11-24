#!/usr/bin/env node
// Builds every browsable list for each language, merges them into the title
// store and writes <outDir>/<lang>.json (see src/store.js, src/snapshot.js).
// Run by .github/workflows/snapshot.yml; also works locally:
//   node scripts/build-snapshot.js out en he
// PREVIOUS_DIR holds the previous files: the store grows from them, and a
// list that fails keeps its previous copy, so one Wikidata hiccup never
// empties a row.

const fs = require('node:fs');
const path = require('node:path');
const lists = require('../src/lists');
const store = require('../src/store');
const tvmaze = require('../src/tvmaze');
const genres = require('../src/genres');
const wikidata = require('../src/wikidata');
const { REGIONS } = require('../src/trending');

// TVmaze lookups per run for series that have none yet (TVmaze allows 20
// calls per 10 s; the store keeps the answer, so later runs skip them).
const MAZE_LOOKUPS = 600;

function readPrevious(dir, lang) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir || '', `${lang}.json`), 'utf8'));
    if (p.titles) return p;
    // A snapshot from before the store: whole items per list.
    return { titles: store.merge(null, p.lists || {}).titles, lists: {}, old: p.lists || {} };
  } catch {
    return { titles: {}, lists: {} };
  }
}

// Series genres from TVmaze, which tags Breaking Bad "Drama, Crime,
// Thriller" where Wikidata adds "black comedy television series".
async function addMazeGenres(titles, ids) {
  let n = 0;
  for (const id of ids) {
    const e = titles[id];
    if (!e || e.type !== 'series' || 'mz' in e) continue;
    if (n++ >= MAZE_LOOKUPS) break;
    const show = await tvmaze.showByImdb(id).catch(() => undefined);
    if (show === undefined) continue; // failed: try again next run
    e.mz = show ? show.genres || [] : null;
    if (show && tvmaze.isIndian(show)) e.mzIn = true;
    if (e.mz && e.mz.length) e.g = genres.keysFor({ maze: e.mz });
  }
  return n;
}

async function main() {
  const [outDir = 'snapshot', ...langs] = process.argv.slice(2);
  const previousDir = process.env.PREVIOUS_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  let failures = 0;
  let total = 0;

  for (const lang of langs.length ? langs : ['en', 'he']) {
    const previous = readPrevious(previousDir, lang);
    const built = {};
    const failed = [];
    // Every list, then Trending once per region ("type/id@region").
    const keys = [
      ...lists.LISTS,
      ...lists.LISTS.filter((k) => k.endsWith('/wikimaze-trending')).flatMap((k) => REGIONS.map((r) => `${k}@${r}`)),
    ];
    total += keys.length;
    for (const key of keys) {
      const [type, rest] = key.split('/');
      const [id, region] = rest.split('@');
      const started = Date.now();
      try {
        // One retry: Wikidata's query service has slow moments.
        let items = await lists.build(type, id, lang, region).catch(() => null);
        if (!items || !items.length) items = await lists.build(type, id, lang, region);
        if (!items || !items.length) throw new Error('empty list');
        built[key] = items;
        console.log(`${lang} ${key}: ${items.length} items in ${Date.now() - started} ms`);
      } catch (err) {
        failures++;
        failed.push(key);
        console.error(`${lang} ${key}: FAILED (${err.message})`);
      }
    }
    const merged = store.merge(previous, built);
    for (const key of failed) {
      const old = previous.lists[key] || (previous.old && previous.old[key] && previous.old[key].map((x) => x.id));
      if (old) merged.lists[key] = old;
      console.error(`${lang} ${key}: ${old ? 'kept previous' : 'left out'}`);
    }
    // Series in Wikidata-ranked lists get TVmaze genres (Trending first).
    const seriesIds = Object.entries(merged.lists)
      .filter(([k]) => k.startsWith('series/'))
      .sort(([a], [b]) => (a.includes('trending') ? -1 : 0) - (b.includes('trending') ? -1 : 0))
      .flatMap(([, ids]) => ids);
    const looked = await addMazeGenres(merged.titles, [...new Set(seriesIds)]);
    // Mark Indian titles (hidden unless the install's region is India).
    const unknown = Object.values(merged.titles).filter((e) => !('in' in e)).map((e) => e.id);
    try {
      const indian = await wikidata.indianImdbs(unknown);
      for (const id of unknown) merged.titles[id].in = indian.has(id);
      console.log(`${lang}: ${indian.size} of ${unknown.length} new titles marked Indian`);
    } catch (err) {
      console.error(`${lang}: Indian check failed (${err.message}); retried next run`);
    }
    for (const e of Object.values(merged.titles)) {
      if (e.type === 'series' && e.mzIn) e.in = true;
    }
    const file = path.join(outDir, `${lang}.json`);
    fs.writeFileSync(file, JSON.stringify({ built: new Date().toISOString(), ...merged }));
    console.log(
      `${file}: ${Object.keys(merged.titles).length} titles, ${looked} TVmaze lookups, ` +
        `${(fs.statSync(file).size / 1024).toFixed(0)} KB`
    );
  }
  // Fail the run only when nothing could be built at all.
  if (failures === total) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
