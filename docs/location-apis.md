# Location lookup: every interface InvoiceLens uses

Status words: **tested** = covered by an automated test against a mocked server; **live-unverified** = never called against the real service from the development environment (its network is blocked), confirm on first real use.

| Step | Service | Needs | Where | Status |
|---|---|---|---|---|
| 1 | OpenStreetMap Nominatim (search) | nothing | app (browser) | live: measured on 22 real addresses (street level at best) |
| 2 | Your own model rewrites an address (optional) | model key | app | tested |
| 3 | Google Places (New) Text Search | Google key | app (browser) | tested, live-unverified |
| 3 | SerpApi, Google Maps engine | SerpApi key + CORS proxy | app via proxy, or local script | tested, live-unverified |
| 3 | Local Google Maps browser helper | Playwright | your computer | tested against a mocked page, live-unverified |
| 4 | Fix by pin: Leaflet + OpenStreetMap tiles | nothing | app | tested, tiles live-unverified |
| nav | Google Maps URLs (search / directions) | nothing | links | live: used by the owner |

## Free options when no Google / SerpApi key is set (research, 2026-10)

Figures below come from search results and third-party summaries; confirm them on the provider's page before relying on them.

| Source | Free terms | Data | Verdict |
|---|---|---|---|
| OpenStreetMap Nominatim | 1 request/s, no key | OSM | in use; measured: street level at best, 0/22 exact |
| Photon (photon.komoot.io) | no key, polite use | OSM, fuzzier search | benchmark: `node tools/geo-bench.mjs` (Photon is compared automatically) |
| Overture Maps places | open dataset (GeoParquet on S3, `overturemaps` CLI), no key, no request limits | merged POI sources (not OSM only) | **most promising**: benchmark `tools/overture-bench.mjs`; if it knows the branches, ship a branch directory file instead of calling any API |
| Foursquare Open Source Places | Apache 2.0, Parquet; Hugging Face copy needs accepting terms | Foursquare POIs | backup to Overture |
| Geoapify | 3,000 credits/day | OSM + open data | expected like OSM (`GEOAPIFY_KEY=... node tools/geo-bench.mjs`) |
| LocationIQ | ~5,000/day, attribution link (third-party figure) | OSM | expected like OSM, not benchmarked |
| OpenCage | ~2,500/day (third-party figure) | OSM + others | not benchmarked |
| Mapbox | ~100,000 temporary geocodes/month (third-party figure) | own data | card requirement unclear, not benchmarked |
| HERE | no usable free plan for the owner | own data | dropped |
| Tavily | 1,000 credits/month | web pages, no coordinates | measured 4 of 22 correct store pages, not built |
| GeoNames scripts / geopy | n/a | place names / client library only | no store-level data, not integrated |

Idea if Overture knows the branches: `tools/overture-bench.mjs` already writes `speedmart-places.json` (name, address, postcode, position); a directory of the 99 Speedmart branches built from it can be matched in the app by store number / name / postcode with the same `judgePlace()` check, with no key, no network call and no quota. Keep the Overture attribution with the file.

## Detected from the billing party (customer observation)

On 99 Speedmart delivery orders the billing party ("Billing Address") is 99 SPEED MART SDN. BHD. (`isSpeedmartName`). When the user has not chosen anything, each stop whose documents are billed to 99 Speedmart is treated as **99 Speedmart** automatically (the route tab says "The billing address says 99 Speedmart for n of m stops"); stops billed to anyone else still wait for the choice below. The user's own choice, when made, applies to all stops. For a stop known to be 99 Speedmart:

- the destination is the 99 Speedmart at that address: searches carry the keyword ("99 Speedmart <address>", and "99 Speedmart <store no> (NS) <name>" or "99 Speedmart (NS) <name>" from the printed branch name);
- a place is accepted **only if it is a Speed Mart** (plus the same postcode and street/area words); another shop on the same street, or any Speed Mart that only shares the postcode, is refused.

## What the deliveries are for (required before any paid / keyed lookup)

The route tab asks "What are these deliveries for?": **99 Speedmart** or **Other / manual input** (type the shop or brand name, e.g. Tesco). Until one is chosen, **nothing is sent to Google Places, SerpApi or the model web search** (the tab says so). The choice decides:

- **queries**: 99 Speedmart -> `99 Speedmart <store no> (NS) <name>`, then the full address; Other -> `<brand> <shop name> <postcode>`, then the full address;
- **the check** (`judgePlace`): 99 Speedmart -> the place must be a Speed Mart (or the street / area words must agree); Other -> the place must carry the typed brand (without a typed name only the street / area words count, which gives "medium" confidence at best);
- **links**: the "by store name" main link and the route waypoints use the store number form only for 99 Speedmart; for Other they use `<brand> <shop name>` when one is known, otherwise the address;
- **the web-search prompt** of the model step, and the `brand` field in `stops-to-check.json` (the local scripts read it; `--brand 99` or `--brand "Tesco"` sets the default).
Changing the choice asks the stops the lookup missed again.

## The provider chain (how to add a search source later)

Every place lookup is a function `(address, shopName, nearPosition, brand) -> { ok, lat, lng, place, found_address, url, confidence, reason }` and is checked by the same `judgePlace()` before a coordinate counts. In `site/index.html` the providers are collected in `provs` (Google Places, SerpApi) and tried in the order of the setting "Place lookup service"; the model web search (`locateMany`, the user's own model, verified by `verifyWebPos()` with a Google-link coordinate and a postcode check) runs after them for the stops still not exact. To add a source (for example a model API that can search the web and returns place data, or another geocoder with a free tier): write one function with the signature above (use `placeQueries(brand, name, address)` for the queries and `judgePlace(addr, candidate, brandRegex(brand))` for the check), add it to `order`, add a setting for its key, add one test with a mocked endpoint. Nothing else in the route tab needs to change.

Candidates considered: a model with built-in web search (the settings button "Test web search" proves it can open a live page; most chat APIs cannot), Tavily (no coordinates in results, about 4 of 22 correct store pages: not built), HERE (no usable free plan for the owner), Geoapify (open data, expected to be like OpenStreetMap; benchmark with `GEOAPIFY_KEY=... node tools/geo-bench.mjs`).

Order inside the app: OpenStreetMap -> (model rewrite) -> place lookup service(s) -> model web search -> manual Fix. A place lookup answer is accepted only when `judgePlace()` agrees (same postcode, and the place is a Speed Mart or street/area words match). Anything else stays "Street / area only".

## 1. OpenStreetMap Nominatim

- `GET https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=3&countrycodes=my&q=<text>` (browser sends no custom User-Agent; the policy allows 1 request per second, so the app waits 1.1 s between requests and caches results).
- Queries tried in order (`geoQueries` in `site/route.js`): the spelled-out street form (`tidyAddr`: branch name, unit numbers, state suffix dropped; JLN/TMN/PST/BDR expanded), its last three parts, the printed line, postcode + town, last two parts.
- Result `place_rank >= 28` counts as exact; street / area hits (rank 19 to 26) are shown as "Street / area only". Measured: 0 of 22 exact, about half reach a street.
- Benchmarks: `node tools/geo-bench.mjs addresses.json` (see the script header).

## 2. Google Places (New), Text Search (optional, customer's own key)

- Settings: "Google Maps API key". Empty = never called.
- `POST https://places.googleapis.com/v1/places:searchText`, headers `X-Goog-Api-Key`, `X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.location`, body `{textQuery, regionCode:"MY", languageCode:"en", maxResultCount:3}`.
- Query order: store number + name (`storeQuery`, e.g. `99 Speedmart 1954 (NS) Nusari Biz`), then the full printed address.
- The key needs "Places API (New)" enabled and should be restricted to the website's address. Google bills the key.
- live-unverified: browser calls with a referrer-restricted key; error text is shown in the route tab ("Place lookup stopped: ...").

## 3. SerpApi (optional, customer's own key)

Facts read from public sources (SerpApi's own documentation site could not be opened from the development environment, confirm the field names on first use):

- Endpoint `GET https://serpapi.com/search.json?engine=google_maps&type=search&q=<text>&hl=en&gl=my&api_key=<key>`; optional `ll=@<lat>,<lng>,<zoom>z` biases the search to a position (the app sends the OpenStreetMap street position with zoom 16).
- Response: `local_results[]` (list) or `place_results` (a single place). Fields used: `title`, `address`, `gps_coordinates.latitude` / `.longitude`, `place_id`. A "no results" answer comes back as `{"error": "Google Maps hasn't returned any results for this query."}` and is treated as a miss, not a failure.
- Account check (does not use a search): `GET https://serpapi.com/account.json?api_key=<key>` -> `total_searches_left` (the settings button "Check SerpApi key" shows it).
- Free plan: 250 searches a month, 50 an hour, no card (per third-party sources, confirm at serpapi.com/pricing). Every query is one search; the app asks the store name first, then the address, so one stop costs 1 to 2 searches.
- **SerpApi does not allow calls from a web page** (the key would be visible and browsers are blocked by CORS), so there are two ways to use it:
  1. **Through the CORS proxy** (in the app): deploy `proxy/worker.js` (README "CORS proxy"), then Settings -> "SerpApi proxy URL" (or the proxy in Advanced). The page sends `X-Target-Base: https://serpapi.com`; the worker forwards path + query string and adds CORS headers; keys are not stored or logged. If you set `ALLOWED_TARGET_HOSTS` in `proxy/wrangler.toml`, include `serpapi.com`. The worker only accepts the two site origins listed in `ALLOWED_ORIGINS`.
  2. **Local script** (no proxy): `SERPAPI_KEY=... node tools/serpapi-locate.mjs stops-to-check.json` then import `locations.json` in the route tab. Use `--limit 2 --debug` first: `--debug` saves the first raw response as `serpapi-debug.json` so the field names can be confirmed.
- Settings "Place lookup service": Automatic (Google first, then SerpApi), Google only, SerpApi only. With one service failing by error the other still answers; if all fail the batch stops and the message stays visible.

## 4. Fix by pin (Leaflet + OpenStreetMap tiles)

- Leaflet 1.9.4 from jsDelivr, loaded on first use; tiles `https://tile.openstreetmap.org/{z}/{x}/{y}.png` with the required attribution; light use only (tile policy). Click or drag sets the position, "Use this position" saves it as a manual (exact) location.

## 5. Google Maps links

- Per stop: main link `https://www.google.com/maps/search/?api=1&query=<store name>` when the document carries a store number, second link with the full printed address; stops without a store number get the address link only.
- Per lorry: `https://www.google.com/maps/dir/?api=1&origin=...&destination=...&waypoints=a|b|...` split into legs of at most 9 waypoints; waypoints use the store name when available, the full address otherwise.

## First real use checklist (SerpApi)

1. Sign up at serpapi.com (free plan), copy the API key. Do not paste it into chats or commit it.
2. Local script first: `git pull`, then `SERPAPI_KEY=<key> node tools/serpapi-locate.mjs stops-to-check.json --limit 2 --debug`. Send `serpapi-debug.json` (it contains no key) if a field name differs.
3. In-app: deploy the proxy, put the worker URL in Settings, paste the key, press "Check SerpApi key" (shows searches left), then open the route tab.
4. Compare with the "by store name" link on a few stops before trusting the result.
