// Free-geocoding experiment: how many printed delivery addresses does OpenStreetMap place exactly,
// and which query shape works best? Run on your own computer (needs internet, Node 18+):
//   node tools/geo-bench.mjs addresses.json > bench.md          (addresses.json: ["address 1", "address 2", ...])
//   node tools/geo-bench.mjs addresses.json --dry               (only print the queries, no network)
//   HERE_KEY=... GEOAPIFY_KEY=... node tools/geo-bench.mjs addresses.json > bench.md   (also compare HERE and Geoapify, free keys; either may be left out)
// Nominatim policy: one request per second, identifying User-Agent. Results are cached in .geo-bench-cache.json.
import fs from "node:fs";
import { geoQueries, postcodeOf } from "../site/route.js";

const [file, ...flags] = process.argv.slice(2);
if (!file) { console.error("usage: node tools/geo-bench.mjs addresses.json [--dry]"); process.exit(1) }
const DRY = flags.includes("--dry");
const addrs = JSON.parse(fs.readFileSync(file, "utf8")).map(a => (typeof a === "string" ? { address: a } : a));
const UA = "invoicelens-geo-bench/1.0 (+https://github.com/clkhoo5211/animated-fiesta)";
const CACHE = ".geo-bench-cache.json";
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;

// V1: the printed address as a structured, spelled-out street query (abbreviations expanded, store codes and unit numbers dropped)
const ABBR = [[/\bJLN\b/gi, "Jalan"], [/\bTMN\b/gi, "Taman"], [/\bPST\b/gi, "Pusat"], [/\bBDR\b/gi, "Bandar"], [/\bLRG\b/gi, "Lorong"], [/\bKG\b/gi, "Kampung"], [/\bPSRN\b/gi, "Persiaran"], [/\bN\.?\s*SEMBILAN\b/gi, "Negeri Sembilan"]];
export function tidy(a) {
  const parts = String(a).replace(/^\s*Delivery Address\s*/i, "").replace(/\s*\n\s*/g, ", ").split(",").map(x => x.trim()).filter(Boolean)
    // the branch name ("1988 NS TMN X (DD)") and unit numbers ("NO: 20-G & 21-G (GROUND FLOOR)", "1780 (GF)", "3827") are not part of the street address
    .filter(x => !/\((?:DD|TD|ND|FN|01|[A-Z]{2})\)/.test(x) && !/^(?:NO\s*[:.]?\s*)?[\dA-Z-]+(?:\s*&\s*[\dA-Z-]+)?\s*(?:\([^)]*\))?\.?$/i.test(x) && !/^(?:\d{3,4}\s+)?(?:NS|RS)\s/i.test(x));
  let t = parts.join(", ").replace(/\bDARUL\s*K\w*\.?/gi, "").replace(/\bDARU\b\.?/gi, "").replace(/\s+/g, " ").replace(/[\s,.]+$/g, "");
  for (const [re, to] of ABBR) t = t.replace(re, to);
  return t.replace(/\b([A-Z]{2,})\b/g, w => w[0] + w.slice(1).toLowerCase());
}
// V2: brand + area (the shop is a 99 Speed Mart, which OpenStreetMap usually names after the brand)
function brandQueries(a) {
  const pc = postcodeOf(a), t = tidy(a), parts = t.split(",").map(s => s.trim()).filter(Boolean);
  const area = parts.filter(p => /^(Taman|Pusat|Bandar|Medan|Laman|Kampung)\b/i.test(p) || /\b(Taman|Pusat|Bandar|Medan|Laman|Kampung)\b/i.test(p)).slice(-1)[0] || parts[Math.max(0, parts.length - 2)] || "";
  const town = (t.match(/\b\d{5}\s+([A-Za-z .]+)/) || [])[1] || "";
  return [...new Set([`99 Speed Mart ${area} ${pc} ${town}`.replace(/\s+/g, " ").trim(), `99 Speed Mart ${area}`.trim(), `99 Speed Mart ${pc} ${town}`.trim()])];
}
const VARIANTS = { "V0 as printed (current)": a => geoQueries(a), "V1 spelled out": a => [tidy(a), ...tidy(a).split(",").slice(-3).length > 2 ? [tidy(a).split(",").slice(-3).join(",").trim()] : []], "V2 brand + area": a => brandQueries(a) };

async function nominatim(q) {
  const k = "N|" + q; if (cache[k]) return cache[k];
  const wait = 1100 - (Date.now() - last); if (wait > 0) await sleep(wait); last = Date.now();
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=3&countrycodes=my&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(30000), headers: { "User-Agent": UA, "Accept-Language": "en" } });
  if (!r.ok) throw new Error("nominatim HTTP " + r.status);
  const j = await r.json(); cache[k] = j; fs.writeFileSync(CACHE, JSON.stringify(cache)); return j;
}
async function overpassBrand() {
  const k = "O|brand-ns2"; if (cache[k]) return cache[k];
  // a bounding box (Negeri Sembilan) with a name / brand filter is far lighter than an area query; several public mirrors are tried
  const q = `[out:json][timeout:60][bbox:2.35,101.6,3.25,102.8];(nwr["brand"~"99 Speed",i];nwr["name"~"Speed ?Mart",i];);out center tags;`;
  const mirrors = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
  let lastErr = "";
  for (let round = 0; round < 2; round++) for (const m of mirrors) {
    try {
      console.error(`overpass: asking ${new URL(m).host} ...`);
      const r = await fetch(m, { method: "POST", signal: AbortSignal.timeout(75000), headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) });
      if (!r.ok) { lastErr = `${new URL(m).host} HTTP ${r.status}`; await sleep(3000); continue }
      const j = (await r.json()).elements || []; cache[k] = j; fs.writeFileSync(CACHE, JSON.stringify(cache)); return j;
    } catch (e) { lastErr = `${new URL(m).host} ${e.message}`; await sleep(3000) }
  }
  throw new Error(lastErr);
}

// optional commercial-grade geocoders with a free tier (keys from the environment); same postcode filter, "exact" = a house / building / place hit
const KEYS = { here: process.env.HERE_KEY, geoapify: process.env.GEOAPIFY_KEY };
async function keyed(name, q) {
  const k = `${name}|${q}`; if (cache[k]) return cache[k];
  await sleep(300);
  const url = name === "here"
    ? `https://geocode.search.hereapi.com/v1/geocode?q=${encodeURIComponent(q)}&in=countryCode:MYS&limit=3&apiKey=${KEYS.here}`
    : `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(q)}&filter=countrycode:my&limit=3&format=json&apiKey=${KEYS.geoapify}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
  const j = await r.json();
  const rows = name === "here"
    ? (j.items || []).map(i => ({ text: i.title, lat: i.position?.lat, lng: i.position?.lng, type: i.resultType, pc: i.address?.postalCode, exact: ["houseNumber", "place"].includes(i.resultType) }))
    : (j.results || []).map(i => ({ text: i.formatted, lat: i.lat, lng: i.lon, type: i.result_type, pc: i.postcode, exact: ["building", "amenity"].includes(i.result_type) }));
  cache[k] = rows; fs.writeFileSync(CACHE, JSON.stringify(cache)); return rows;
}
const exact = h => h && (Number(h.place_rank) >= 28 || ["shop", "amenity", "building", "office"].includes(h.category || h.class));
const short = h => h ? `${(h.display_name || "").split(",").slice(0, 3).join(",")} [${h.category || h.class}/${h.type}, rank ${h.place_rank}]` : "no hit";

const full = a => String(a).replace(/\s*\n\s*/g, ", ").replace(/\s+/g, " ").trim();
const out = [];
const score = Object.fromEntries(Object.keys(VARIANTS).map(k => [k, 0]));
out.push(`# Geocoding bench, ${addrs.length} addresses\n`);
for (const [i, item] of addrs.entries()) {
  const a = item.address, pc = postcodeOf(a);
  console.error(`address ${i + 1} / ${addrs.length}`);
  out.push(`## ${i + 1}. ${a}\n`);
  for (const [name, fn] of Object.entries(VARIANTS)) {
    const qs = fn(a);
    if (DRY) { out.push(`- ${name}: ${qs.map(q => "`" + q + "`").join(" | ")}`); continue }
    let best = null, used = "";
    for (const q of qs) { const hs = await nominatim(q).catch(e => { out.push(`  - error: ${e.message}`); return [] }); const h = hs.find(x => !pc || !x.address?.postcode || String(x.address.postcode).replace(/\s/g, "") === pc) || null; if (h && (!best || (exact(h) && !exact(best)))) { best = h; used = q } if (exact(best)) break }
    if (exact(best)) score[name]++;
    out.push(`- ${name}: ${exact(best) ? "EXACT" : best ? "area only" : "none"}: ${short(best)}${best ? ` (${Number(best.lat).toFixed(5)}, ${Number(best.lon).toFixed(5)}) via \`${used}\`` : ""}`);
  }
  if (!DRY) for (const name of Object.keys(KEYS).filter(n => KEYS[n])) {
    let best = null, used = "";
    for (const q of [tidy(a), full(a)]) {
      const rows = await keyed(name, q).catch(e => { out.push(`  - ${name} error: ${e.message}`); return [] });
      const h = rows.find(x => x.lat != null && (!pc || !x.pc || String(x.pc).replace(/\s/g, "") === pc)) || null;
      if (h && (!best || (h.exact && !best.exact))) { best = h; used = q } if (best?.exact) break;
    }
    score[name] = (score[name] || 0) + (best?.exact ? 1 : 0);
    out.push(`- ${name.toUpperCase()}: ${best?.exact ? "EXACT" : best ? "area only" : "none"}: ${best ? `${best.text} [${best.type}] (${Number(best.lat).toFixed(5)}, ${Number(best.lng).toFixed(5)}) via \`${used}\`` : "no hit"}`);
  }
  out.push("");
}
if (!DRY) {
  out.push("## Summary: exact hits per variant\n");
  for (const [k, v] of Object.entries(score)) out.push(`- ${k}: ${v} / ${addrs.length}`);
  try {
    const els = await overpassBrand();
    out.push(`\n## OpenStreetMap 99 Speed Mart POIs in the Negeri Sembilan box: ${els.length}\n`);
    const withPc = addrs.map(x => postcodeOf(x.address));
    let matched = 0;
    for (const [i, x] of addrs.entries()) { const c = els.filter(e => (e.tags?.["addr:postcode"] || "") === withPc[i]); if (c.length) matched++; out.push(`- ${i + 1}. postcode ${withPc[i]}: ${c.length} POI(s) ${c.slice(0, 3).map(e => `${e.tags?.name || e.tags?.brand} (${(e.lat ?? e.center?.lat)?.toFixed?.(5)}, ${(e.lon ?? e.center?.lon)?.toFixed?.(5)})`).join("; ")}`) }
    out.push(`\nAddresses whose postcode has at least one brand POI: ${matched} / ${addrs.length}`);
  } catch (e) { out.push(`\n(overpass skipped: ${e.message})`) }
}
console.log(out.join("\n"));
