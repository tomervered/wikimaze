# WikiMaze

A Stremio metadata add-on that merges two open sources:

- **Wikidata** (CC0) for movies: title, short description, genres, director, writers, cast, runtime, release date. Labels come in the viewer's language, so the Hebrew install shows "התחלה" for Inception.
- **TVmaze** (CC BY-SA 4.0) for series: episodes, plot, posters, backgrounds, cast. Wikidata adds the local-language name and genres.

Every title is keyed by its IMDb id (`tt…`), so stream add-ons still match it, and a show found by both sources is listed once.

## Catalogs

| Catalog | Source |
| --- | --- |
| Trending (movies, series) | The most-read films and shows on Wikipedia over the last 3 days, across six large language editions plus the install's own (Wikimedia page-view statistics). A title must trend in at least two editions, or in the install's own language, so one edition's local hit doesn't top the global list |
| Popular movies | Films first released this year or last, ranked by how many Wikipedia editions have an article on them. With a genre picked: that genre's films from all years, same ranking |
| Airing now (series) | Shows with an episode in the last 7 days on US/UK TV or streaming, ranked by TVmaze's popularity weight, optionally filtered by TVmaze genre |
| Search (both) | Wikidata full-text search, which matches titles in every language (searching "שובר שורות" in the English install finds Breaking Bad), plus TVmaze search for series |

## Install

Open the add-on's root URL for the install page. The manifest is at `/manifest.json` (English) or `/<lang>/manifest.json`, for example `/he/manifest.json`.

## Run locally

```
npm start          # http://127.0.0.1:7000/manifest.json
npm test
```

Node 20 or newer, no dependencies. `PORT` and `USER_AGENT` can be set in the environment. Behind an HTTPS proxy, set `NODE_USE_ENV_PROXY=1`.

## Deploy

- **Vercel:** import the repo; `vercel.json` sends every path to `api/index.js`.
- **Render:** `render.yaml` describes a free web service.

## How the data is fetched

Wikimedia's action API (`w/api.php`) rate-limits shared IPs hard, so this add-on reads Wikidata only through the query service (SPARQL, with search through its MWAPI bridge) and `Special:EntityData`, which the Wikimedia CDN caches. TVmaze allows 20 calls per 10 seconds; all responses are cached in memory for 1 to 24 hours.

Images are linked, never stored. Series use TVmaze's images; movies use Stremio's public metahub artwork, keyed by IMDb id.

## Credits

TV data from [TVmaze](https://www.tvmaze.com), licensed CC BY-SA 4.0. Movie data from [Wikidata](https://www.wikidata.org), CC0.
