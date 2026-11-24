# WikiMaze

A Stremio metadata add-on that merges two open sources:

- **Wikidata** (CC0) for movies: title, short description, genres, director, writers, cast, runtime, release date. Labels come in the viewer's language, so the Hebrew install shows "התחלה" for Inception.
- **TVmaze** (CC BY-SA 4.0) for series: episodes, plot, posters, backgrounds, cast. Wikidata adds the local-language name and genres.

Every title is keyed by its IMDb id (`tt…`), so stream add-ons still match it, and a show found by both sources is listed once.

## Catalogs

Every list has a genre filter. Search runs through the two Classics lists.

| List | Source |
| --- | --- |
| Movies / Series - Trending | The most-read films and shows on Wikipedia over the last 3 days, across six large language editions plus the install's own (Wikimedia page-view statistics, CC0). A title must trend in at least two editions, or in the install's own language |
| Movies - Surging | **Placeholder.** Films whose Wikipedia readership jumped most on the newest day compared with the week before. To be replaced by a non-Wikipedia source once a legal, commercially usable one exists (IMDb data is paid-only; TMDB and Trakt are non-commercial) |
| Series - Surging | TVmaze: shows with a new episode in the last two days (US, UK, Israel, streaming), by TVmaze's popularity weight |
| Movies / Series - Classics | The best-known titles of all time on Wikidata, ranked by how many Wikipedia editions have an article on them |
| Series - Airing now | TVmaze: shows with an episode in the last 7 days on US/UK TV or streaming, by TVmaze's popularity weight |

Films that are not out yet, or out within two weeks, are left out of every movie list.

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

Lists (every catalog without a search term) are not built while Stremio waits. A GitHub Action (`.github/workflows/snapshot.yml`) runs `scripts/build-snapshot.js` every three hours and on every change to `src/`. It publishes each list, already ranked, as one JSON file per language on the `data` branch. Each item holds only the IMDb id, name, poster link, year and genre keys. The add-on reads that file from GitHub's CDN, then filters by genre and pages through it in memory. Search and title details are still fetched live, because they depend on what the user asks for. Without a snapshot (a new language, or GitHub unreachable) the lists are built live as before. Set `SNAPSHOT_URL=off` to always build them live.

Images are linked, never stored. Series use TVmaze's images; movies use Stremio's public metahub artwork, keyed by IMDb id.

## Credits

TV data from [TVmaze](https://www.tvmaze.com), licensed CC BY-SA 4.0. Movie data from [Wikidata](https://www.wikidata.org), CC0.

## Privacy

WikiMaze has no accounts, cookies, analytics or tracking, and stores nothing about the people who use it. Lists are built from public, anonymous totals: Wikipedia page views, Wikidata and TVmaze. Vercel, the host, keeps short-lived request logs that include IP addresses so it can run and secure the service; see [Vercel's privacy policy](https://vercel.com/legal/privacy-policy). The language and list choices made on the install page live only in the install link.
