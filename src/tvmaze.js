// TVmaze (data CC BY-SA 4.0, credit required: see the manifest description
// and README). TV only. Limit is 20 calls per 10 seconds per IP; responses are
// cached in http.js.

const { getJson } = require('./http');

const API = 'https://api.tvmaze.com';

function stripHtml(html) {
  if (!html) return undefined;
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim() || undefined;
}

function image(img, size = 'original') {
  if (!img) return undefined;
  return img[size] || img.original || img.medium;
}

async function showByImdb(imdb) {
  // The lookup endpoint answers with a redirect to /shows/:id.
  return getJson(`${API}/lookup/shows?imdb=${encodeURIComponent(imdb)}`, { ttl: 24 * 3600, timeout: 6000 });
}

async function showFull(id) {
  return getJson(`${API}/shows/${id}?embed[]=episodes&embed[]=cast&embed[]=images`, { ttl: 6 * 3600, timeout: 8000 });
}

async function search(query) {
  const rows = await getJson(`${API}/search/shows?q=${encodeURIComponent(query)}`, { ttl: 3600, timeout: 5000 });
  return (rows || []).map((r) => r.show);
}

// Shows with an episode out in the last `days` days, on TV in the given
// countries or on streaming services, ordered by TVmaze's popularity weight.
async function airingNow(countries = ['US', 'GB'], days = 7) {
  const dates = [];
  for (let i = 0; i < days; i++) {
    dates.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  const urls = [];
  for (const d of dates) {
    urls.push(`${API}/schedule/web?date=${d}`);
    for (const c of countries) urls.push(`${API}/schedule?country=${c}&date=${d}`);
  }
  const lists = await Promise.all(urls.map((u) => getJson(u, { ttl: 6 * 3600 }).catch(() => [])));
  const shows = new Map();
  for (const list of lists) {
    for (const ep of list || []) {
      const show = ep.show || (ep._embedded && ep._embedded.show);
      if (show && !shows.has(show.id)) shows.set(show.id, show);
    }
  }
  return [...shows.values()].sort((a, b) => (b.weight || 0) - (a.weight || 0));
}

// Brand New series: shows whose first episode (season 1, episode 1, or the
// show's premiere date) falls in the last `days` days, on TV in the given
// countries or on streaming, by TVmaze's popularity weight.
async function premieres(countries = ['US', 'GB', 'IL'], days = 30) {
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const urls = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    urls.push(`${API}/schedule/web?date=${d}`);
    for (const c of countries) urls.push(`${API}/schedule?country=${c}&date=${d}`);
  }
  const lists = await Promise.all(urls.map((u) => getJson(u, { ttl: 12 * 3600 }).catch(() => [])));
  const shows = new Map();
  for (const list of lists) {
    for (const ep of list || []) {
      const show = ep.show || (ep._embedded && ep._embedded.show);
      if (!show || shows.has(show.id)) continue;
      const first = ep.season === 1 && ep.number === 1;
      if (first || (show.premiered && show.premiered >= from)) shows.set(show.id, show);
    }
  }
  return [...shows.values()]
    .filter((s) => s.premiered && s.premiered >= from)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));
}

function bestBackground(show) {
  const imgs = (show._embedded && show._embedded.images) || [];
  const bg = imgs.find((i) => i.type === 'background' && i.main) || imgs.find((i) => i.type === 'background');
  return bg && bg.resolutions && bg.resolutions.original && bg.resolutions.original.url;
}

function bestLogo(show) {
  const imgs = (show._embedded && show._embedded.images) || [];
  const logo = imgs.find((i) => i.type === 'typography');
  return logo && logo.resolutions && logo.resolutions.original && logo.resolutions.original.url;
}

module.exports = { showByImdb, showFull, search, airingNow, premieres, stripHtml, image, bestBackground, bestLogo };
