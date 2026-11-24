// The title store: every title any list has shown, saved once.
//
// A snapshot file (see snapshot.js) holds
//   { built, titles: { tt..: entry }, lists: { "type/id[@region]": [tt..] } }
// so a film that sits in Trending, Surging and Brand New for weeks is stored
// one time, and lists are plain id arrays. Each build merges the new lists
// into the previous store: entries are refreshed, nothing is dropped, and
// `seen` remembers the last day each title was in each list.
//
// An entry: { id, type, name, en?, poster, releaseInfo, date?, year?, g, mz?, seen }
//   en    English name, kept when the install language names it differently,
//         so a Hebrew store still finds "Breaking Bad"
//   date  first release / premiere (YYYY-MM-DD) when known
//   g     genre keys (genres.keysFor)
//   mz    TVmaze genre names for series, null when TVmaze has no such show
//   seen  { listKey: "YYYY-MM-DD" }
//
// Everything here is pure (no network), so it is tested directly.

const genres = require('./genres');

// A title that left a ranked list stays at its end for this many days, so
// lists (and genre filters on them) keep a useful length.
const HISTORY_DAYS = 60;
const HISTORY_LISTS = ['wikimaze-trending', 'wikimaze-hot'];

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (d) => (Date.now() - Date.parse(d)) / 86400000;

// Store entry from a list item (lists.js preview shape plus date/en).
function entryOf(item, prev) {
  const year = parseInt(item.releaseInfo || item.year, 10) || (prev && prev.year) || undefined;
  const e = {
    ...(prev || {}),
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster,
    releaseInfo: item.releaseInfo,
    year,
    g: item.g || (prev && prev.g) || [],
    seen: { ...((prev && prev.seen) || {}) },
  };
  if (item.date) e.date = item.date;
  if (item.en && item.en !== item.name) e.en = item.en;
  if (item.mz) e.mz = item.mz;
  if (item.in) e.in = true;
  // TVmaze genres win for series: Wikidata tags tone ("black comedy") as
  // genre, so Breaking Bad would otherwise show under Comedy.
  if (e.type === 'series' && e.mz && e.mz.length) e.g = genres.keysFor({ maze: e.mz });
  return e;
}

// Merge freshly built lists into the previous store.
//   built: { key: [items] }   (items in preview shape)
// Returns { titles, lists } with lists as id arrays, history appended.
function merge(previous, built, day = today()) {
  const titles = { ...((previous && previous.titles) || {}) };
  const lists = {};
  for (const [key, items] of Object.entries(built)) {
    lists[key] = [];
    for (const item of items) {
      if (!item || !item.id) continue;
      const e = entryOf(item, titles[item.id]);
      e.seen[key] = day;
      titles[item.id] = e;
      lists[key].push(item.id);
    }
  }
  for (const key of Object.keys(lists)) {
    const id = key.split('/')[1].split('@')[0];
    if (HISTORY_LISTS.includes(id)) lists[key] = withHistory(titles, key, lists[key]);
  }
  return { titles, lists };
}

// Current ranking first, then titles that were in this list within
// HISTORY_DAYS, most recently seen first.
function withHistory(titles, key, current) {
  const have = new Set(current);
  const past = Object.values(titles)
    .filter((e) => !have.has(e.id) && e.seen && e.seen[key] && daysAgo(e.seen[key]) <= HISTORY_DAYS)
    .sort((a, b) => (a.seen[key] < b.seen[key] ? 1 : a.seen[key] > b.seen[key] ? -1 : 0));
  return [...current, ...past.map((e) => e.id)];
}

// Lower-case, accents and punctuation removed: "Amélie!" -> "amelie".
function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// 0 = no match; higher is better: exact name, name starts with the query,
// every word of the query in the name.
function matchScore(e, q) {
  const nq = norm(q);
  if (!nq) return 1;
  let best = 0;
  for (const n of [e.name, e.en].filter(Boolean).map(norm)) {
    if (n === nq) best = Math.max(best, 3);
    else if (n.startsWith(nq)) best = Math.max(best, 2);
    else if (nq.split(' ').every((w) => n.split(' ').some((x) => x.startsWith(w)))) best = Math.max(best, 1);
  }
  return best;
}

// Year filter values offered in Stremio and the search API.
function yearOptions(now = new Date().getUTCFullYear()) {
  const years = [0, 1, 2, 3, 4].map((i) => String(now - i));
  const decades = [];
  for (let d = Math.floor(now / 10) * 10; d >= 1970; d -= 10) decades.push(`${d}s`);
  return [...years, ...decades, 'Older'];
}

// "2024" -> [2024, 2024]; "2010s" -> [2010, 2019]; "Older" -> [0, 1969].
function yearRange(opt) {
  if (!opt) return null;
  if (/^\d{4}$/.test(opt)) return [Number(opt), Number(opt)];
  const dec = /^(\d{4})s$/.exec(opt);
  if (dec) return [Number(dec[1]), Number(dec[1]) + 9];
  if (opt === 'Older') return [0, 1969];
  return null;
}

// Filter and order store entries.
//   ids: restrict to (and keep the order of) this list; otherwise the whole
//        store, most recently seen in any list first
//   q, type, genre (key), from, to (years)
function query(titles, { ids = null, type, q, genre, from, to } = {}) {
  let rows = ids ? ids.map((id) => titles[id]).filter(Boolean) : Object.values(titles);
  if (type) rows = rows.filter((e) => e.type === type);
  if (genre) rows = rows.filter((e) => (e.g || []).includes(genre));
  if (from || to) {
    rows = rows.filter((e) => e.year && (!from || e.year >= from) && (!to || e.year <= to));
  }
  if (!ids) {
    const last = (e) => Object.values(e.seen || {}).sort().pop() || '';
    rows = rows.map((e, i) => [e, last(e), i]).sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : a[2] - b[2])).map((x) => x[0]);
  }
  if (q) {
    rows = rows
      .map((e, i) => [e, matchScore(e, q), i])
      .filter((x) => x[1] > 0)
      .sort((a, b) => b[1] - a[1] || a[2] - b[2])
      .map((x) => x[0]);
  }
  return rows;
}

// Counts for the search API's filter chips.
function facets(rows) {
  const g = {};
  const decades = {};
  for (const e of rows) {
    for (const k of e.g || []) g[k] = (g[k] || 0) + 1;
    if (e.year) {
      const d = e.year < 1970 ? 'Older' : `${Math.floor(e.year / 10) * 10}s`;
      decades[d] = (decades[d] || 0) + 1;
    }
  }
  return { genres: g, decades };
}

// Stremio preview shape.
function preview(e) {
  return { id: e.id, type: e.type, name: e.name, poster: e.poster, releaseInfo: e.releaseInfo };
}

// Lists the add-on lets you search: the given list's own titles.
function listsOf(e) {
  return Object.keys(e.seen || {});
}

module.exports = {
  HISTORY_DAYS,
  merge,
  withHistory,
  entryOf,
  norm,
  matchScore,
  yearOptions,
  yearRange,
  query,
  facets,
  preview,
  listsOf,
};
