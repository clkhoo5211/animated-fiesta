// Experiment: does the open Overture Maps places dataset know the 99 Speedmart branches? (free, no key, no per-request limits)
//   1. pip install overturemaps
//   2. overturemaps download --bbox=101.6,2.35,102.8,3.25 -f geojson --type=place -o negeri-sembilan-places.geojson
//      (bbox = west,south,east,north; this one covers Negeri Sembilan. Use the area of your deliveries.)
//   3. node tools/overture-bench.mjs negeri-sembilan-places.geojson addresses.json > overture.md
// It keeps the places whose record mentions "Speed Mart" / "Speedmart" (name, brand, anything), compares them with every address (same postcode,
// Speed Mart, street / area words: the same check as the app), prints the candidates and writes speedmart-places.json (all of them) that a branch
// directory for the app could be built from. Attribution: Overture Maps Foundation data, see overturemaps.org for the license of the release you use.
import fs from "node:fs";
import { judgePlace, brandRegex, brandOf, placeRank, postcodeOf, storeQuery } from "../site/route.js";

const [geoFile, addrFile] = process.argv.slice(2);
if (!geoFile || !addrFile) { console.error("usage: node tools/overture-bench.mjs places.geojson addresses.json"); process.exit(1) }

/** the features of a GeoJSON FeatureCollection or of a line-delimited GeoJSON (one feature per line) */
export function readFeatures(text) {
  const t = text.trim();
  if (t.startsWith("{") && /"features"\s*:/.test(t.slice(0, 400))) { try { return JSON.parse(t).features || [] } catch {} }
  return t.split(/[\n\u001e]+/).map(l => l.trim()).filter(Boolean).flatMap(l => { try { const j = JSON.parse(l); return j.type === "FeatureCollection" ? j.features : [j] } catch { return [] } });
}
/** name, address and position of one Overture place feature (field names differ a little between releases: read defensively) */
export function placeOf(f) {
  const p = f.properties || {}, a = Array.isArray(p.addresses) ? p.addresses[0] || {} : (p.address || {});
  const name = p.names?.primary || p.name || p.brand?.names?.primary || "";
  const address = [a.freeform || a.street, a.locality || a.city, a.postcode, a.region].filter(Boolean).join(", ");
  const [lng, lat] = f.geometry?.type === "Point" ? f.geometry.coordinates : [undefined, undefined];
  return { id: p.id || f.id || "", name, address, postcode: a.postcode || "", lat, lng, category: p.categories?.primary || p.category || "", confidence: p.confidence };
}
export const isSpeedmart = f => /speed\s*-?\s*mart/i.test(JSON.stringify(f.properties || {}));

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const feats = readFeatures(fs.readFileSync(geoFile, "utf8")), places = feats.filter(isSpeedmart).map(placeOf).filter(p => p.lat != null);
  const addrs = JSON.parse(fs.readFileSync(addrFile, "utf8")).map(a => (typeof a === "string" ? { address: a } : a));
  fs.writeFileSync("speedmart-places.json", JSON.stringify(places, null, 1));
  const out = [`# Overture bench: ${feats.length} places in the file, ${places.length} Speed Mart places (${places.filter(p => p.postcode).length} with a postcode, ${places.filter(p => /\d{3,4}\s*\(?(NS|RS)\b/i.test(p.name)).length} with a store number in the name)\n`];
  let withPc = 0, accepted = 0;
  for (const [i, it] of addrs.entries()) {
    const a = it.address, pc = postcodeOf(a);
    const cands = places.map(p => ({ p, v: judgePlace(a, { name: p.name, address: p.address, lat: p.lat, lng: p.lng }, brandRegex(brandOf("99")), true) }));
    const same = cands.filter(c => pc && c.p.postcode && String(c.p.postcode).replace(/\s/g, "") === pc), ok = cands.filter(c => c.v.ok).sort((x, y) => placeRank(x.v) - placeRank(y.v));
    withPc += same.length > 0; accepted += ok.length > 0;
    out.push(`## ${i + 1}. ${a}\n\n- store name asked for: \`${storeQuery(it.name, a) || "(none)"}\``);
    for (const c of (ok.length ? ok : same).slice(0, 3)) out.push(`  - ${c.v.ok ? `ACCEPTED ${c.v.confidence}` : "same postcode"}: ${c.p.name} | ${c.p.address} (${c.p.lat.toFixed(5)}, ${c.p.lng.toFixed(5)}) ${c.v.ok ? "" : "[" + c.v.reason + "]"}`);
    if (!ok.length && !same.length) out.push("  - nothing in the same postcode");
    out.push("");
  }
  out.push(`## Summary\n\n- addresses with a Speed Mart place in the same postcode: ${withPc} / ${addrs.length}\n- addresses with a place that passes the app's check: ${accepted} / ${addrs.length}`);
  console.log(out.join("\n"));
}
