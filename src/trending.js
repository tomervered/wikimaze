// Trending = what people are reading about on Wikipedia right now.
// Wikimedia publishes the 1000 most-viewed articles of each day per language
// edition (CC0). For six large editions plus the viewer's own, the last three
// days are summed and mapped to Wikidata items; only films and series with
// an IMDb id are kept. Each edition's views count as a share of its own
// top-1000 total, so big editions don't drown small ones; the viewer's own
// edition counts three times, so Israeli hits rank high in the Hebrew install.
//
// The same lists also give Very Trending movies (see spike() below). That
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
      return new Map(kept.map((a) => [a.article.replace(/_/g, ' '), a.views / total]));
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

// Very Trending (PLACEHOLDER until a non-Wikipedia source is chosen): how
// much a title's share on the newest day beats its average over the days
// before. A title new to the top list jumps by its whole share.
function spike(days) {
  const [today, ...before] = days;
  const out = new Map();
  if (!today || !before.length) return out;
  for (const [t, v] of today) {
    const base = before.reduce((n, d) => n + (d.get(t) || 0), 0) / before.length;
    if (v > base) out.set(t, v - base);
  }
  return out;
}

// Very Trending favours new titles: a score is multiplied by a weight that
// halves for every `halfLife` days since release and never drops below
// `floor` (a classic in the news still shows, just lower). Unknown date: floor.
function recency(date, halfLife = 365, floor = 0.1) {
  if (!date) return floor;
  const iso = /^\d{4}$/.test(date) ? `${date}-07-01` : date;
  const age = (Date.now() - Date.parse(iso)) / 86400000;
  if (!(age > 0)) return 1;
  return floor + (1 - floor) * 0.5 ** (age / halfLife);
}

// Very Trending movies use Tomer's U-shaped age weight: it halves every two
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
  const scores = mode === 'spike' ? spike(days) : titles;
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

module.exports = { trending, spike, recency, movieAgeWeight };
