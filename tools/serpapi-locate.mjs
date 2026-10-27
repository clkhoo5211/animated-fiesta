// Local helper: look the stops up with SerpApi (Google Maps engine) from your own computer (Node has no browser CORS limit, so no proxy is needed here).
//   1. in the app, Delivery route tab, "Export stops to check" -> stops-to-check.json
//   2. SERPAPI_KEY=... node tools/serpapi-locate.mjs stops-to-check.json            (--limit 2 --debug first)
//   3. in the app, Delivery route tab, "Import coordinates" -> locations.json
// --brand: what the documents are for ("99" = Speedmart, the default; or the shop / brand name). The app writes it into stops-to-check.json too.
// Per stop it asks for the store number + name first ("99 Speedmart 1954 (NS) Nusari Biz"), then the full printed address, biased towards the
// street position the app already knows (ll). A result is kept only when the postcode matches and the place is a Speed Mart or the street / area
// words agree (the same check as the app). Free plan: 250 searches a month, 50 an hour: every query is one search, cached in .serpapi-cache.json.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { judgePlace, placeRank, placeQueries, brandOf, brandRegex } from "../site/route.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** the places in a SerpApi Google Maps response: a single place (place_results) or a list (local_results) */
export function serpCandidates(j) {
  const rows = [...(j?.place_results ? [j.place_results] : []), ...(Array.isArray(j?.local_results) ? j.local_results : [])];
  return rows.slice(0, 5).map(p => ({ name: p.title || "", address: p.address || "", lat: p.gps_coordinates?.latitude, lng: p.gps_coordinates?.longitude, place_id: p.place_id || "", link: p.link || "" }));
}
export function serpQueries(address, name = "", brand = brandOf("99")) { return placeQueries(brand, name, address) }

export async function locateWithSerp(items, { brand: args99 = "99", key, delay = 2, debug = false, fetchImpl = fetch, cacheFile = ".serpapi-cache.json", onResult } = {}) {
  const cache = cacheFile && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  const call = async (params) => {
    const qs = new URLSearchParams({ engine: "google_maps", type: "search", hl: "en", gl: "my", ...params }), ck = qs.toString();
    if (cache[ck]) return cache[ck];
    qs.set("api_key", key);
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetchImpl(`https://serpapi.com/search.json?${qs}`, { signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await sleep(20000); continue }
      const j = await r.json().catch(() => ({}));
      if (j.error && /hasn.t returned any results|no results/i.test(j.error)) { cache[ck] = {}; break }
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      cache[ck] = j; if (debug && !fs.existsSync("serpapi-debug.json")) fs.writeFileSync("serpapi-debug.json", JSON.stringify(j, null, 1));
      break;
    }
    if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(cache));
    return cache[ck] || {};
  };
  const out = [];
  for (const [i, it] of items.entries()) {
    const brand = brandOf((typeof it === "object" && it.brand) || args99), address = typeof it === "string" ? it : it.address, name = typeof it === "object" ? it.name || "" : "", near = typeof it === "object" ? it.near : null;
    let row = { ...(typeof it === "object" && it.key ? { key: it.key } : {}), address, ok: false, reason: "no result" };
    for (const q of serpQueries(address, name, brand)) {
      const j = await call({ q, ...(near ? { ll: `@${(+near.lat).toFixed(5)},${(+near.lng).toFixed(5)},16z` } : {}) });
      const hits = [];
      for (const c of serpCandidates(j)) {
        const v = judgePlace(address, c, brandRegex(brand), brand.mode === "99");
        if (v.ok) hits.push({ rank: placeRank(v), row: { ...row, ok: true, lat: c.lat, lng: c.lng, place: c.name, found_address: c.address, url: c.place_id ? `https://www.google.com/maps/place/?q=place_id:${c.place_id}` : c.link, confidence: v.confidence, reason: v.reason, query: q } });
        else row.reason = v.reason;
      }
      if (hits.length) row = hits.sort((a, b) => a.rank - b.rank)[0].row;
      if (row.ok) break;
    }
    out.push(row); onResult?.(row, i, items.length);
    if (i < items.length - 1) await sleep(delay * 1000);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), file = args.find(a => !a.startsWith("--")), opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null };
  const key = process.env.SERPAPI_KEY;
  if (!file || !key) { console.error("usage: SERPAPI_KEY=... node tools/serpapi-locate.mjs stops-to-check.json [--out locations.json] [--limit N] [--delay 2] [--debug] [--brand 99 or the shop name]"); process.exit(1) }
  const outFile = opt("--out") || "locations.json";
  let items = JSON.parse(fs.readFileSync(file, "utf8")).map(a => (typeof a === "string" ? { address: a } : a));
  if (opt("--limit")) items = items.slice(0, +opt("--limit"));
  const done = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : [], have = new Map(done.filter(r => r.ok).map(r => [r.address, r]));
  const todo = items.filter(i => !have.has(i.address));
  console.error(`${items.length} addresses, ${items.length - todo.length} already located in ${outFile}, ${todo.length} to look up`);
  const rows = await locateWithSerp(todo, { brand: opt("--brand") || "99", key, delay: +(opt("--delay") || 2), debug: args.includes("--debug"), onResult: (r, i, n) => console.error(`${i + 1}/${n} ${r.ok ? `OK ${r.confidence} ${r.lat},${r.lng} ${r.place}` : `no: ${r.reason}`}`) });
  const all = items.map(i => rows.find(r => r.address === i.address) || have.get(i.address)).filter(Boolean);
  fs.writeFileSync(outFile, JSON.stringify(all, null, 1));
  console.error(`\n${all.filter(r => r.ok).length} / ${items.length} located. Written to ${outFile}`);
}
