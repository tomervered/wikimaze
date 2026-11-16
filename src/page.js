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
  ['ja', '日本語'],
];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function configurePage(origin, lang) {
  const options = LANGS.map(
    ([code, label]) => `<option value="${code}"${code === lang ? ' selected' : ''}>${esc(label)}</option>`
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
  select, input { width:100%; box-sizing:border-box; font:inherit; padding:8px 10px; border-radius:8px; border:1px solid #8884; background:transparent; color:inherit; }
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
  <label for="url" style="margin-top:16px">Manifest link</label>
  <input id="url" readonly>
  <div class="row">
    <a class="btn" id="install" href="#">Install in Stremio</a>
    <button class="secondary" id="copy" type="button">Copy link</button>
  </div>
  <small>Data: <a href="https://www.wikidata.org/">Wikidata</a> (CC0) and
  <a href="https://www.tvmaze.com/">TVmaze</a> (CC BY-SA 4.0). Artwork is linked from TVmaze and metahub, not stored here.</small>
</div></main>
<script>
  const origin = ${JSON.stringify(origin)};
  const sel = document.getElementById('lang'), url = document.getElementById('url'), install = document.getElementById('install');
  function update() {
    const l = sel.value;
    const link = origin + (l === 'en' ? '' : '/' + l) + '/manifest.json';
    url.value = link;
    install.href = link.replace(/^https?:/, 'stremio:');
  }
  sel.addEventListener('change', update);
  document.getElementById('copy').addEventListener('click', () => { url.select(); navigator.clipboard && navigator.clipboard.writeText(url.value); });
  update();
</script></body></html>`;
}

module.exports = { configurePage };
