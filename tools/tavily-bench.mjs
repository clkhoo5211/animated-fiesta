// Experiment: can Tavily web search find the branch (address, coordinates) of each delivery address? Run on your own computer:
//   TAVILY_KEY=tvly-... node tools/tavily-bench.mjs addresses.json > tavily.md      (free key: 1,000 credits a month, basic search = 1 credit)
//   node tools/tavily-bench.mjs addresses.json --dry                                  (only print the queries)
// For every address it searches the web twice (brand + area + postcode, then the street form), lists the top results and extracts
// anything that looks like a coordinate (Google Maps "@lat,lng" / "!3d!4d" / "lat": / "latitude"), flags results that mention the same
// postcode, and ends with a summary. It decides nothing: the output shows whether the web has the data at all.
import fs from "node:fs";
import { postcodeOf, tidyAddr, storeQuery } from "../site/route.js";

const [file, ...flags] = process.argv.slice(2);
if (!file) { console.error("usage: TAVILY_KEY=... node tools/tavily-bench.mjs addresses.json [--dry]"); process.exit(1) }
const DRY = flags.includes("--dry"), RAW = flags.includes("--raw"), KEY = process.env.TAVILY_KEY;   // --raw: also read the full page text (may cost more credits)
if (!DRY && !KEY) { console.error("set TAVILY_KEY (https://tavily.com, free plan)"); process.exit(1) }
const addrs = JSON.parse(fs.readFileSync(file, "utf8")).map(a => (typeof a === "string" ? a : a.address));
const CACHE = ".tavily-bench-cache.json", cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MY = (la, lo) => la >= 0.8 && la <= 7.5 && lo >= 99 && lo <= 119.7;

function coords(text) {
  const found = [], add = (la, lo, kind) => { la = +la; lo = +lo; if (MY(la, lo)) found.push({ la, lo, kind }) };
  for (const m of String(text).matchAll(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/g)) add(m[1], m[2], "pin");
  for (const m of String(text).matchAll(/@(-?\d+\.\d{3,}),(-?\d+\.\d{3,})/g)) add(m[1], m[2], "view");
  for (const m of String(text).matchAll(/"?lat(?:itude)?"?\s*[:=]\s*"?(-?\d+\.\d{3,})"?[\s,;&]*"?(?:lng|lon|long|longitude)"?\s*[:=]\s*"?(-?\d+\.\d{3,})/gi)) add(m[1], m[2], "latlng");
  return found;
}
// Google place ids appear in Waze / Google links ("place.ChIJ..." or "place_id:ChIJ..."); https://www.google.com/maps/place/?q=place_id:<id> opens exactly that shop
const placeIds = text => [...new Set([...String(text).matchAll(/(?:place\.|place_id:|!1s)(ChIJ[\w-]{20,})/g)].map(m => m[1]))];
function queries(a) {
  const t = tidyAddr(a), pc = postcodeOf(a), parts = t.split(",").map(s => s.trim()).filter(Boolean);
  const area = parts.find(p => /\b(Taman|Pusat|Bandar|Medan|Laman|Kampung)\b/i.test(p)) || parts[Math.max(0, parts.length - 2)] || "";
  const store = storeQuery(a);   // "99 Speedmart 1954 (NS) Nusari Biz": the name Google, Waze and the directories list the shop under
  return [...(store ? [`${store} ${pc}`] : []), `99 Speedmart ${area} ${pc} store address location`, `${t} 99 Speedmart Google Maps`];
}
async function search(q) {
  if (cache[q + (RAW ? "|raw" : "")]) return cache[q + (RAW ? "|raw" : "")];
  await sleep(500);
  const r = await fetch("https://api.tavily.com/search", { method: "POST", signal: AbortSignal.timeout(40000), headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ query: q, search_depth: "basic", max_results: 5, include_answer: false, include_raw_content: RAW }) });
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const j = await r.json(); const key = q + (RAW ? "|raw" : ""); cache[key] = j.results || []; fs.writeFileSync(CACHE, JSON.stringify(cache)); return cache[key];
}

const out = [`# Tavily bench, ${addrs.length} addresses\n`];
let withCoord = 0, withPc = 0, withBoth = 0, withId = 0;
for (const [i, a] of addrs.entries()) {
  console.error(`address ${i + 1} / ${addrs.length}`);
  const pc = postcodeOf(a); out.push(`## ${i + 1}. ${a}\n`);
  let anyC = false, anyP = false, both = false, anyId = false;
  for (const q of queries(a)) {
    out.push(`- query: \`${q}\``);
    if (DRY) continue;
    const rs = await search(q).catch(e => { out.push(`  - error: ${e.message}`); return [] });
    for (const r of rs) {
      const blob = `${r.url} ${r.title} ${r.content} ${r.raw_content || ""}`, ids = placeIds(blob), cs = coords(blob), hasPc = !!pc && blob.includes(pc), brand = /speed\s*mart/i.test(blob);
      anyC ||= cs.some(c => c.kind !== "view"); anyP ||= hasPc && brand; both ||= hasPc && brand && cs.some(c => c.kind !== "view");
      anyId ||= ids.length > 0 && brand;
      out.push(`  - ${ids.length ? `[placeid ${ids[0]}] ` : ""}${hasPc ? "[postcode] " : ""}${brand ? "[brand] " : ""}${cs.length ? `[coords ${cs.map(c => `${c.kind}:${c.la},${c.lo}`).join(" ")}] ` : ""}${(r.title || "").slice(0, 80)} (${r.url})`);
    }
  }
  withCoord += anyC; withPc += anyP; withBoth += both; withId += anyId; out.push("");
}
if (!DRY) out.push(`## Summary\n\n- addresses with a result that gives a pin or coordinate: ${withCoord} / ${addrs.length}\n- addresses with a Speed Mart result mentioning the same postcode: ${withPc} / ${addrs.length}\n- both in one result: ${withBoth} / ${addrs.length}\n- addresses with a Google place id for a Speed Mart result: ${withId} / ${addrs.length}`);
console.log(out.join("\n"));
