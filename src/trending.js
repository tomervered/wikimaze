// Trending = what people are reading about on Wikipedia right now.
// Wikimedia publishes the 1000 most-viewed articles of each day per language
// edition (CC0). For six large editions plus the viewer's own, the last three
// days are summed and mapped to Wikidata items; only films and series with
// an IMDb id are kept. Each edition's views count as a share of its own
// top-1000 total, so big editions don't drown small ones; the viewer's own
// edition counts three times, so Israeli hits rank high in the Hebrew install.
//
// The same lists also give Surging movies (see surge() below). That
// use is a PLACEHOLDER: Tomer wants a non-Wikipedia source for it once a
// legal, commercially usable one exists (IMDb data is paid-only, TMDB and
// Trakt are non-commercial).

const { getJson } = require('./http');
const wikidata = require('./wikidata');

const TOP = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top';
const DAYS = 3;
// Namespaces and pages that are never titles. Localised namespaces contain a
// colon too, but so do real titles ("Avatar: Fire and Ash"), so only the
// English ones are dropped here; Wikidata matching discards the rest.
const SKIP = /^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Template:|Category:|User:|Talk:)/;

function day(offset) {
  const d = new Date(Date.now() - offset * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '/');
}

// The edition's daily top lists, newest first: one Map(title -> share of
// that day's top-list views) per day. Today's list never exists yet and
// yesterday's appears during the day, so ask for one day more than needed.
const LOOKBACK = 8;

async function dailyShares(wiki) {
  const lists = await Promise.all(
    Array.from({ length: LOOKBACK + 1 }, (_, i) =>
      getJson(`${TOP}/${wiki}.wikipedia/all-access/${day(i + 1)}`, { ttl: 3 * 3600 })
        .then((r) => (r && r.items ? r.items[0].articles : null))
        .catch(() => null)
    )
  );
  return lists
    .filter(Boolean)
    .slice(0, LOOKBACK)
    .map((list) => {
      const kept = list.filter((a) => !SKIP.test(a.article));
      const total = kept.reduce((n, a) => n + a.views, 0) || 1;
      const m = new Map(kept.map((a) => [a.article.replace(/_/g, ' '), a.views / total]));
      m.floor = kept.length ? kept[kept.length - 1].views / total : 0;
      return m;
    });
}

// Trending: average share over the newest DAYS days.
function readership(days) {
  const out = new Map();
  for (const d of days.slice(0, DAYS)) {
    for (const [t, v] of d) out.set(t, (out.get(t) || 0) + v / DAYS);
  }
  return out;
}

// Surging (PLACEHOLDER source until a non-Wikipedia one is chosen): titles
// whose readership is climbing, not just big. The old one-day jump
// (share today minus the week's average) let any huge title with a small
// wobble beat a small title that tripled, and one news story (a death, a TV
// airing) could top it for a day. Now:
//   r = mean share over the newest SURGE_DAYS days
//   b = mean share over the days before; a day the title missed the top
//       list counts as half that day's cut-off share (it was below it)
//   score = log2(r / b) * sqrt(r), kept only when r >= SURGE_MIN * b
//       and every one of the newest days beats b (a climb, not one blip)
// log2(r/b) is the growth (1 = doubled); sqrt(r) keeps a tiny article that
// went from 10 to 40 views from outranking a real hit that doubled.
const SURGE_DAYS = 2;
const SURGE_MIN = 1.5;

function surge(days) {
  const recent = days.slice(0, SURGE_DAYS);
  const before = days.slice(SURGE_DAYS);
  const out = new Map();
  if (recent.length < SURGE_DAYS || !before.length) return out;
  const floorOf = (d) => (d.floor || Math.min(...d.values())) / 2;
  for (const t of recent[0].keys()) {
    const shares = recent.map((d) => d.get(t) || floorOf(d));
    const r = shares.reduce((n, v) => n + v, 0) / shares.length;
    const b = before.reduce((n, d) => n + (d.get(t) || floorOf(d)), 0) / before.length;
    if (r < SURGE_MIN * b || shares.some((v) => v <= b)) continue;
    out.set(t, Math.log2(r / b) * Math.sqrt(r));
  }
  return out;
}

// Series lists favour new titles: a score is multiplied by a weight that
// halves for every `halfLife` days since release and never drops below
// `floor` (a classic in the news still shows, just lower). Unknown date: floor.
function recency(date, halfLife = 365, floor = 0.1) {
  if (!date) return floor;
  const iso = /^\d{4}$/.test(date) ? `${date}-07-01` : date;
  const age = (Date.now() - Date.parse(iso)) / 86400000;
  if (!(age > 0)) return 1;
  return floor + (1 - floor) * 0.5 ** (age / halfLife);
}

// Surging movies use Tomer's U-shaped age weight: it halves every two
// years at first, then climbs back slowly (toward ~0.35 for very old films)
// so a resurgence of interest in an old film still counts.
//   W(a) = 0.10 + 0.90 * 2^(-a / 2y) + 0.25 * (1 - 2^(-a / 12y))
function movieAgeWeight(date) {
  if (!date) return 0.1;
  const iso = /^\d{4}$/.test(date) ? `${date}-07-01` : date;
  const years = (Date.now() - Date.parse(iso)) / (365 * 86400000);
  if (!(years > 0)) return 1;
  return 0.1 + 0.9 * 0.5 ** (years / 2) + 0.25 * (1 - 0.5 ** (years / 12));
}

// Films and series together, so one Wikidata query serves both catalogs and
// both modes (the title list, and so the query, is the same).
async function fromWiki(wiki, lang, mode) {
  const days = await dailyShares(wiki);
  const titles = readership(days);
  if (!titles.size) return [];
  const scores = mode === 'spike' ? surge(days) : titles;
  const found = await wikidata.itemsForWikiTitles([...titles.keys()], wiki, lang);
  return Object.entries(found)
    .filter(([title]) => scores.has(title))
    .map(([title, item]) => ({
      ...item,
      score: scores.get(title) * (mode === 'spike' ? movieAgeWeight(item.firstDate || item.year) : 1),
    }));
}

// [{ imdb, qid, name, year, score }] most-read first.
const GLOBAL = (process.env.TREND_WIKIS || 'en,de,fr,es,it,ja').split(',');
const LOCAL_WEIGHT = Number(process.env.TREND_LOCAL_WEIGHT || 3);

async function trending(type, lang, mode = 'trending') {
  const wikis = [...new Set([...GLOBAL, lang])];
  const lists = await Promise.all(
    wikis.map((w) =>
      fromWiki(w, lang, mode)
        .then((items) => items.map((x) => ({ ...x, wiki: w })))
        .catch(() => [])
    )
  );
  const out = new Map();
  for (const item of lists.flat().filter((x) => x.type === type && (type !== 'movie' || wikidata.releasedBy(x)))) {
    const local = item.wiki === lang && lang !== 'en';
    const weight = local ? LOCAL_WEIGHT : 1;
    const prev = out.get(item.imdb);
    if (prev) {
      prev.score += item.score * weight;
      prev.editions++;
      prev.local = prev.local || local;
    } else out.set(item.imdb, { ...item, score: item.score * weight, editions: 1, local });
  }
  // A title that trends in only one foreign edition is a local story there
  // (a Bollywood release read mostly on English Wikipedia, a Dutch TV show).
  // Titles that trend in two editions or in the viewer's own come first;
  // single-edition ones follow, so the list keeps loading when scrolled.
  const strong = (x) => x.editions >= 2 || x.local;
  const all = [...out.values()].sort((a, b) => b.score - a.score);
  return [...all.filter(strong), ...all.filter((x) => !strong(x))];
}

// Regional Trending. Wikimedia publishes, per country and day, the most-read
// articles across all Wikipedias (anonymous totals, CC0; small counts are
// withheld for privacy). A region's list leans on that country's readers
// without being only theirs:
//   final = REGION_WEIGHT * country share + (1 - REGION_WEIGHT) * global share
// where each part is first scaled to sum to 1 over its own list, so a small
// country's short list still counts in full.
const REGIONS = ['us', 'gb', 'de', 'fr', 'es', 'it', 'pl', 'il', 'eg', 'jp', 'br'];
const REGION_WEIGHT = 0.6;
const COUNTRY = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top-per-country';

// Map(wiki -> Map(title -> mean share over the last DAYS days)) for a country.
async function countryShares(region) {
  const days = await Promise.all(
    Array.from({ length: DAYS + 1 }, (_, i) =>
      getJson(`${COUNTRY}/${region.toUpperCase()}/all-access/${day(i + 1)}`, { ttl: 3 * 3600 })
        .then((r) => (r && r.items ? r.items[0].articles : null))
        .catch(() => null)
    )
  );
  const out = new Map();
  for (const list of days.filter(Boolean).slice(0, DAYS)) {
    const kept = list.filter((a) => /\.wikipedia$/.test(a.project) && !SKIP.test(a.article));
    const total = kept.reduce((n, a) => n + a.views_ceil, 0) || 1;
    for (const a of kept) {
      const wiki = a.project.replace(/\.wikipedia$/, '');
      const m = out.get(wiki) || new Map();
      const t = a.article.replace(/_/g, ' ');
      m.set(t, (m.get(t) || 0) + a.views_ceil / total / DAYS);
      out.set(wiki, m);
    }
  }
  return out;
}

async function regional(type, lang, region) {
  const [global, shares] = await Promise.all([trending(type, lang), countryShares(region)]);
  const local = new Map();
  await Promise.all(
    [...shares].map(async ([wiki, titles]) => {
      const found = await wikidata.itemsForWikiTitles([...titles.keys()], wiki, lang).catch(() => ({}));
      for (const [title, item] of Object.entries(found)) {
        if (item.type !== type || (type === 'movie' && !wikidata.releasedBy(item))) continue;
        const prev = local.get(item.imdb);
        local.set(item.imdb, { ...item, score: (prev ? prev.score : 0) + titles.get(title) });
      }
    })
  );
  const sum = (xs) => xs.reduce((n, x) => n + x.score, 0) || 1;
  const gSum = sum(global);
  const lSum = sum([...local.values()]);
  const out = new Map();
  // Keep the global list's consensus rule: a title read in one edition only
  // (a Bollywood hit on English Wikipedia) counts a quarter, unless the
  // country itself reads it.
  for (const x of global) {
    const solo = !(x.editions >= 2 || x.local) ? 0.25 : 1;
    out.set(x.imdb, { ...x, score: (1 - REGION_WEIGHT) * solo * (x.score / gSum) });
  }
  // Without any country data the list is the global one.
  if (local.size) {
    for (const x of local.values()) {
      const prev = out.get(x.imdb);
      out.set(x.imdb, { ...(prev || x), score: (prev ? prev.score : 0) + REGION_WEIGHT * (x.score / lSum) });
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

module.exports = { trending, regional, REGIONS, REGION_WEIGHT, surge, recency, movieAgeWeight };
