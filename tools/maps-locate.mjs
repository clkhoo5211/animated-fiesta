// Local helper: look every delivery address up on Google Maps in a background browser and keep only coordinates that pass a check.
// Runs on YOUR computer (the web page cannot read google.com). Typical loop:
//   1. in the app, Delivery route tab, "Export stops to check" -> stops-to-check.json
//   2. npm install && npx playwright install chromium            (once)
//   3. node tools/maps-locate.mjs stops-to-check.json            (add --show to watch the browser)
//   4. in the app, Delivery route tab, "Import coordinates" -> locations.json
// A coordinate is kept only when it comes from a single place page (the pin, not the map view) AND the address Google shows for that
// place has the same postcode as the printed one AND (the place is a Speed Mart OR the street / area words agree). Anything else is
// reported with a reason and left for you. Google may change its page at any time and its terms restrict automated use: keep the volume
// small, the delay long, and use it for your own deliveries only.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const MY_BOX = { lat: [0.8, 7.5], lng: [99, 119.7] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const postcodeOf = a => (String(a ?? "").match(/\b\d{5}\b/g) || []).pop() || "";

/** the pin of a Google Maps place URL ("...!3d2.5!4d101.8..."); the "@lat,lng" of the URL is only the map view and is never used */
export function pinFromUrl(u) {
  const m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(String(u));
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return lat >= MY_BOX.lat[0] && lat <= MY_BOX.lat[1] && lng >= MY_BOX.lng[0] && lng <= MY_BOX.lng[1] ? { lat, lng } : null;
}

const STOP = new Set(["jalan", "taman", "pusat", "bandar", "persiaran", "lorong", "kampung", "medan", "laman", "komersial", "perniagaan", "negeri", "sembilan", "darul", "khusus", "ground", "floor", "malaysia", "selangor", "johor", "kuala", "lumpur", "single", "storey", "delivery", "address"]);
/** distinctive words of an address (street / area names), for comparing it with the address Google shows */
export function words(a) {
  return [...new Set(String(a ?? "").toLowerCase().replace(/\(.*?\)/g, " ").split(/[^a-z]+/).filter(w => w.length >= 5 && !STOP.has(w)))];
}

/** decide whether a place Google found is the delivery address. found: {name, address, lat, lng} */
export function judge(wanted, found) {
  if (!found || found.lat == null) return { ok: false, reason: "no place page" };
  if (!found.address) return { ok: false, reason: "place has no address to compare" };
  const wantPc = postcodeOf(wanted), foundPc = postcodeOf(found.address);
  if (wantPc && foundPc && wantPc !== foundPc) return { ok: false, reason: `postcode ${foundPc} is not ${wantPc}` };
  if (wantPc && !foundPc) return { ok: false, reason: "place address has no postcode" };
  const brand = /speed\s*mart/i.test(found.name || "") || /speed\s*mart/i.test(found.address);
  const fw = new Set(words(found.address + " " + (found.name || ""))), common = words(wanted).filter(w => fw.has(w));
  if (brand && common.length >= 1) return { ok: true, confidence: "high", reason: `Speed Mart, postcode ${foundPc}, words: ${common.join(" ")}` };
  if (common.length >= 2) return { ok: true, confidence: "medium", reason: `postcode ${foundPc}, words: ${common.join(" ")}` };
  if (brand && foundPc === wantPc) return { ok: true, confidence: "medium", reason: `Speed Mart in postcode ${foundPc}` };
  return { ok: false, reason: `different place: ${found.name || "?"} (${common.length} shared words)` };
}

const searchUrl = q => `https://www.google.com/maps/search/?api=1&hl=en&query=${encodeURIComponent(q)}`;
const full = a => String(a).replace(/\s*\n\s*/g, ", ").replace(/\s+/g, " ").trim();
/** second attempt: the brand plus the area part of the address (the shop is usually listed under its brand) */
export function brandQuery(a) {
  const parts = full(a).split(",").map(s => s.trim()).filter(Boolean), pc = postcodeOf(a);
  const area = parts.find(p => /\b(TAMAN|TMN|PUSAT|PST|BANDAR|BDR|MEDAN|LAMAN|KAMPUNG)\b/i.test(p) && !/\(/.test(p)) || parts[parts.length - 2] || "";
  return `99 Speed Mart ${area} ${pc}`.replace(/\s+/g, " ").trim();
}

async function consent(page) {
  for (const label of [/reject all/i, /accept all/i, /tolak semua/i, /terima semua/i]) {
    const b = page.getByRole("button", { name: label }).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 3000 }).catch(() => {}); await sleep(800); return }
  }
}
async function readPlace(page) {
  await page.waitForFunction(() => /\/maps\/place\//.test(location.href) && /!3d-?\d/.test(location.href), null, { timeout: 15000 }).catch(() => {});
  const url = page.url(), pin = pinFromUrl(url);
  const info = await page.evaluate(() => {
    const t = el => (el?.getAttribute("aria-label") || el?.textContent || "").replace(/^\s*Address:\s*/i, "").trim();
    return { name: document.querySelector("h1")?.textContent?.trim() || "", address: t(document.querySelector('[data-item-id="address"]')) };
  }).catch(() => ({ name: "", address: "" }));
  return { ...info, url, ...(pin || {}) };
}

/** locate one address; returns {ok, lat, lng, place, found_address, url, confidence, reason} */
export async function locateOne(page, address, { debug = false, tag = "" } = {}) {
  const queries = [...new Set([full(address), brandQuery(address)])];
  let best = { ok: false, reason: "nothing found" };
  for (const q of queries) {
    await page.goto(searchUrl(q), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await consent(page);
    await page.waitForFunction(() => /\/maps\/place\//.test(location.href) || document.querySelector('div[role="feed"]'), null, { timeout: 20000 }).catch(() => {});
    const cands = [];
    if (/\/maps\/place\//.test(page.url())) cands.push(await readPlace(page));
    else {
      const links = await page.$$eval('div[role="feed"] a[href*="/maps/place/"]', as => as.slice(0, 5).map(a => a.href)).catch(() => []);
      for (const href of links) { await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); cands.push(await readPlace(page)); await sleep(1200) }
    }
    for (const c of cands) {
      const v = judge(address, c);
      if (v.ok) return { ok: true, lat: c.lat, lng: c.lng, place: c.name, found_address: c.address, url: c.url, confidence: v.confidence, reason: v.reason, query: q };
      if (!best.ok && (best.reason === "nothing found" || best.reason === "no place page")) best = { ok: false, reason: v.reason, place: c.name, found_address: c.address, url: c.url };
    }
    if (debug) { await page.screenshot({ path: `maps-debug-${tag}.png` }).catch(() => {}) }
  }
  return best;
}

export async function locateAddresses(items, { show = false, debug = false, delay = 4, hook, onResult } = {}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: !show });
  const ctx = await browser.newContext({ locale: "en-GB", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  if (hook) await hook(page);
  const out = [];
  try {
    for (const [i, it] of items.entries()) {
      const address = typeof it === "string" ? it : it.address;
      const res = await locateOne(page, address, { debug, tag: String(i + 1) });
      const row = { ...(typeof it === "object" ? { key: it.key } : {}), address, ...res };
      out.push(row); onResult?.(row, i, items.length);
      if (i < items.length - 1) await sleep((delay + Math.random() * delay * 0.8) * 1000);
    }
  } finally { await browser.close() }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), file = args.find(a => !a.startsWith("--"));
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null };
  if (!file) { console.error("usage: node tools/maps-locate.mjs stops-to-check.json [--out locations.json] [--show] [--debug] [--limit N] [--delay 4]"); process.exit(1) }
  const outFile = opt("--out") || "locations.json";
  let items = JSON.parse(fs.readFileSync(file, "utf8")).map(a => (typeof a === "string" ? { address: a } : a));
  if (opt("--limit")) items = items.slice(0, +opt("--limit"));
  const done = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : [];
  const byAddr = new Map(done.filter(r => r.ok).map(r => [r.address, r]));
  const todo = items.filter(i => !byAddr.has(i.address));
  console.error(`${items.length} addresses, ${items.length - todo.length} already located in ${outFile}, ${todo.length} to look up`);
  const rows = await locateAddresses(todo, {
    show: args.includes("--show"), debug: args.includes("--debug"), delay: +(opt("--delay") || 4),
    onResult: (r, i, n) => console.error(`${i + 1}/${n} ${r.ok ? `OK ${r.confidence} ${r.lat},${r.lng} ${r.place}` : `no: ${r.reason}`}`),
  });
  const all = items.map(i => rows.find(r => r.address === i.address) || byAddr.get(i.address)).filter(Boolean);
  fs.writeFileSync(outFile, JSON.stringify(all, null, 1));
  console.error(`\n${all.filter(r => r.ok).length} / ${items.length} located. Written to ${outFile}`);
}
