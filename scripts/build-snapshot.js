#!/usr/bin/env node
// Builds every browsable list for each language and writes
// <outDir>/<lang>.json (see src/snapshot.js). Run by
// .github/workflows/snapshot.yml; also works locally:
//   node scripts/build-snapshot.js out en he
// A list that fails keeps the previous snapshot's copy (pass the old files'
// folder as PREVIOUS_DIR), so one Wikidata hiccup never empties a row.

const fs = require('node:fs');
const path = require('node:path');
const lists = require('../src/lists');

async function main() {
  const [outDir = 'snapshot', ...langs] = process.argv.slice(2);
  const previousDir = process.env.PREVIOUS_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  let failures = 0;

  for (const lang of langs.length ? langs : ['en', 'he']) {
    let previous = {};
    try {
      previous = JSON.parse(fs.readFileSync(path.join(previousDir || '', `${lang}.json`), 'utf8')).lists || {};
    } catch {
      // first build, or no previous snapshot
    }
    const out = {};
    for (const key of lists.LISTS) {
      const [type, id] = key.split('/');
      const started = Date.now();
      try {
        const items = await lists.build(type, id, lang);
        if (!items || !items.length) throw new Error('empty list');
        out[key] = items;
        console.log(`${lang} ${key}: ${items.length} items in ${Date.now() - started} ms`);
      } catch (err) {
        failures++;
        if (previous[key]) out[key] = previous[key];
        console.error(`${lang} ${key}: FAILED (${err.message}); ${previous[key] ? 'kept previous' : 'left out'}`);
      }
    }
    const file = path.join(outDir, `${lang}.json`);
    fs.writeFileSync(file, JSON.stringify({ built: new Date().toISOString(), lists: out }));
    console.log(`${file}: ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  }
  // Fail the run only when nothing could be built at all.
  if (failures === lists.LISTS.length * (langs.length || 2)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
