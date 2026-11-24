// Install page: pick a language, get the manifest link and an
// "Install in Stremio" button.

const LANGS = [
  ['en', 'English'],
  ['he', 'עברית (Hebrew)'],
  ['ar', 'العربية (Arabic)'],
  ['ru', 'Русский (Russian)'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['it', 'Italiano'],
  ['pt', 'Português'],
  ['pl', 'Polski'],
  ['ja', '日本語'],
];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const REGIONS = [
  ['', 'Worldwide'],
  ['us', 'United States'],
  ['gb', 'United Kingdom'],
  ['de', 'Germany'],
  ['fr', 'France'],
  ['es', 'Spain'],
  ['it', 'Italy'],
  ['pl', 'Poland'],
  ['il', 'Israel'],
  ['eg', 'Egypt'],
  ['jp', 'Japan'],
  ['br', 'Brazil'],
];

function configurePage(origin, lang, region = '') {
  const options = LANGS.map(
    ([code, label]) => `<option value="${code}"${code === lang ? ' selected' : ''}>${esc(label)}</option>`
  ).join('');
  const regionOptions = REGIONS.map(
    ([code, label]) => `<option value="${code}"${code === (region || '') ? ' selected' : ''}>${esc(label)}</option>`
  ).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WikiMaze add-on</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --accent:#3b5bdb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141413; --fg:#ececea; --muted:#9a9a94; --card:#1f1f1d; --accent:#7d97f5; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; }
  main { max-width:560px; margin:48px auto; padding:0 16px; }
  .card { background:var(--card); border-radius:12px; padding:24px; }
  h1 { font-size:22px; margin:0 0 4px; } p { color:var(--muted); margin:0 0 20px; }
  label { display:block; font-weight:600; margin-bottom:6px; }
  select, input { width:100%; box-sizing:border-box; font:inherit; padding:8px 10px; border-radius:8px; border:1px solid #8884; background:var(--card); color:var(--fg); }
  option { background:var(--card); color:var(--fg); }
  .row { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; }
  a.btn, button { flex:1; text-align:center; text-decoration:none; font:inherit; font-weight:600; padding:10px; border-radius:8px; border:0; cursor:pointer; background:var(--accent); color:#fff; }
  button.secondary { background:#8882; color:inherit; }
  small { display:block; color:var(--muted); margin-top:20px; }
  small a { color:inherit; }
</style></head>
<body><main><div class="card">
  <h1>WikiMaze</h1>
  <p>Movie and series details from Wikidata and TVmaze, with titles in your language.</p>
  <label for="lang">Language</label>
  <select id="lang">${options}</select>
  <label for="region" style="margin-top:16px">Trending region</label>
  <select id="region">${regionOptions}</select>
  <p style="font-size:13px;margin:6px 0 0">A region leans Trending toward what that country is reading (60% country, 40% worldwide).</p>
  <fieldset id="lists" style="margin-top:16px;border:0;padding:0;display:grid;gap:6px">
    <legend style="font-weight:600;margin-bottom:6px">Lists to show</legend>
    <label style="font-weight:400"><input type="checkbox" id="l-t" value="t" checked style="width:auto"> Trending</label>
    <label style="font-weight:400"><input type="checkbox" id="l-v" value="v" checked style="width:auto"> Surging</label>
    <label style="font-weight:400"><input type="checkbox" id="l-n" value="n" checked style="width:auto"> Brand New (out in the last 30 days)</label>
    <label style="font-weight:400"><input type="checkbox" id="l-c" value="c" checked style="width:auto"> Classics</label>
    <label style="font-weight:400"><input type="checkbox" id="l-a" value="a" checked style="width:auto"> Airing now (series)</label>
    <label style="font-weight:400"><input type="checkbox" id="l-l" value="l" style="width:auto"> Live search row (asks Wikidata and TVmaze on every search; slower)</label>
  </fieldset>
  <label for="url" style="margin-top:16px">Manifest link</label>
  <input id="url" readonly>
  <div class="row">
    <a class="btn" id="install" href="#">Install in Stremio</a>
    <button class="secondary" id="copy" type="button">Copy link</button>
  </div>
  <small>Search tip: end a search with "!" (for example "dune!") to skip WikiMaze's saved titles and ask Wikidata and TVmaze directly.</small>
  <small>Data: <a href="https://www.wikidata.org/">Wikidata</a> (CC0) and
  <a href="https://www.tvmaze.com/">TVmaze</a> (CC BY-SA 4.0). Artwork is linked from TVmaze and metahub, not stored here.</small>
  <small><strong>Privacy.</strong> WikiMaze has no accounts, cookies, analytics or tracking, and it stores nothing about you. Lists are built from public, anonymous totals (Wikipedia page views, Wikidata, TVmaze). The host, Vercel, keeps short-lived request logs (including IP addresses) to run and secure the service; see <a href="https://vercel.com/legal/privacy-policy">Vercel's privacy policy</a>. Your choices on this page stay in the link you install.</small>
</div></main>
<script>
  const origin = ${JSON.stringify(origin)};
  const sel = document.getElementById('lang'), reg = document.getElementById('region'), url = document.getElementById('url'), install = document.getElementById('install');
  function update() {
    const l = sel.value;
    const picked = [...document.querySelectorAll('#lists input:checked')].map((c) => c.value).join('');
    // The default set needs no suffix; none picked falls back to it.
    let prefix = picked && picked !== 'tvnca' ? l + '.' + picked : (l === 'en' ? '' : l);
    if (reg.value) prefix = (prefix || l) + '-' + reg.value;
    const link = origin + (prefix ? '/' + prefix : '') + '/manifest.json';
    url.value = link;
    install.href = link.replace(/^https?:/, 'stremio:');
  }
  sel.addEventListener('change', update);
  reg.addEventListener('change', update);
  document.getElementById('lists').addEventListener('change', update);
  document.getElementById('copy').addEventListener('click', () => { url.select(); navigator.clipboard && navigator.clipboard.writeText(url.value); });
  update();
</script></body></html>`;
}

module.exports = { configurePage };
