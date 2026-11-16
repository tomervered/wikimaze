// Trending = what people are reading about on Wikipedia right now.
// Wikimedia publishes the 1000 most-viewed articles of each day per language
// edition (CC0). The last three days are summed and mapped to Wikidata
// items; only films or series with an IMDb id are kept.
//
// English Wikipedia sets the global trend. For another language (the Hebrew
// install) that language's Wikipedia is mixed in with equal weight, so local
// hits show up even though the Hebrew edition has far fewer readers: each
// edition's views count as a share of that edition's own top-1000 total.

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

// Map of title -> share of the edition's top-list views over the last days.
async function topArticles(wiki) {
  // Today's list never exists yet and yesterday's appears during the day, so
  // ask for four days and use the newest three that answered.
  const lists = await Promise.all(
    [1, 2, 3, 4].map((i) =>
      getJson(`${TOP}/${wiki}.wikipedia/all-access/${day(i)}`, { ttl: 3 * 3600 })
        .then((r) => (r && r.items ? r.items[0].articles : null))
        .catch(() => null)
    )
  );
  const views = new Map();
  let total = 0;
  for (const list of lists.filter(Boolean).slice(0, DAYS)) {
    for (const a of list) {
      if (SKIP.test(a.article)) continue;
      const title = a.article.replace(/_/g, ' ');
      views.set(title, (views.get(title) || 0) + a.views);
      total += a.views;
    }
  }
  for (const [t, v] of views) views.set(t, v / (total || 1));
  return views;
}

// Films and series together, so one Wikidata query serves both catalogs.
async function fromWiki(wiki, lang) {
  const shares = await topArticles(wiki);
  if (!shares.size) return [];
  const found = await wikidata.itemsForWikiTitles([...shares.keys()], wiki, lang);
  return Object.entries(found).map(([title, item]) => ({ ...item, score: shares.get(title) || 0 }));
}

// [{ imdb, qid, name, year, score }] most-read first.
async function trending(type, lang) {
  const wikis = lang === 'en' ? ['en'] : ['en', lang];
  const lists = await Promise.all(wikis.map((w) => fromWiki(w, lang).catch(() => [])));
  const out = new Map();
  for (const item of lists.flat().filter((x) => x.type === type)) {
    const prev = out.get(item.imdb);
    if (prev) prev.score += item.score;
    else out.set(item.imdb, { ...item });
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

module.exports = { trending };
