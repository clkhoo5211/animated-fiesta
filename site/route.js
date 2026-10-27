/* InvoiceLens — delivery route planner.
   Stops come from the scanned documents (delivery / ship-to / bill-to addresses), plus any added by hand.
   Addresses are geocoded (OpenStreetMap Nominatim, cached), road times come from OSRM when the stop count
   allows it (straight-line estimate otherwise), and the routes are computed here, deterministically:
   split between lorries by direction from the start, then nearest-neighbour + 2-opt + moves between lorries.
   The language model never computes the route; it only reviews the finished plan on request. */

const KEY = "invoicelens.route", GEO = "invoicelens.geo";
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} };
/** is this party name the 99 Speedmart company ("99 SPEED MART SDN. BHD.")? On a 99 delivery order the billing party is. */
export const isSpeedmartName = n => /99\s*-?\s*speed\s*-?\s*mart/i.test(String(n ?? ""));
export const normAddr = s => String(s ?? "").toUpperCase().replace(/[\s,.]+/g, " ").trim();

/* ---------- stops from scanned documents ---------- */
const DELIVER = ["ship_to"], BILL = ["bill_to", "customer"];
const ADDR_COL = /address|alamat|地址|deliver(y)? to|ship.?to addr/i;
/** the address only: a delivery block also carries "Attn: ...", "Tel: ...", "Fax:" lines, which end the address (they made the map lookup fail and went into the Google link) */
export function cleanStopAddress(a) {
  const parts = String(a ?? "").split(/\s*\n\s*|\s*,\s*/).map(x => x.trim()).filter(Boolean);
  const cut = parts.findIndex(x => /^(?:attn|attention|tel|fax|phone|hp|h\/p|mobile|contact|e-?mail)\b/i.test(x) || /^\+?\d[\d\s-]{7,}$/.test(x));
  return (cut >= 0 ? parts.slice(0, cut) : parts).join(", ");
}
export function collectStops(docs) {
  const out = new Map();
  const add = (address, name, ref, src, sus, bill, billAddr) => {
    address = cleanStopAddress(address);
    const k = normAddr(address); if (k.length < 6) return;
    const s = out.get(k) || { key: k, address: String(address).replace(/\s*\n\s*/g, ", ").trim(), name: name || "", refs: [], src, suspect: !!sus, bill: bill || "", billAddr: billAddr || "" };
    s.suspect = s.suspect && !!sus;
    if (!s.bill && bill) { s.bill = bill; s.billAddr = billAddr || "" }
    if (ref && !s.refs.includes(ref)) s.refs.push(ref);
    if (!s.name && name) s.name = name;
    out.set(k, s);
  };
  for (const { file, result: r, suspect } of docs) {
    if (!r) continue;
    const ref = r.document_number || file;
    // who the document is billed to: "99 SPEED MART SDN. BHD." on a 99 Speedmart delivery order
    const billP = (r.parties || []).filter(p => p && BILL.includes(p.role) && p.name)[0], bill = billP?.name || "", billAddr = billP?.address || "";
    const parties = (r.parties || []).filter(p => p && p.address);
    // a document is delivered to its ship-to / delivery address; the billing address is used only when there is none
    const pick = parties.filter(p => DELIVER.includes(p.role));
    for (const p of (pick.length ? pick : parties.filter(p => BILL.includes(p.role)))) add(p.address, p.name, ref, pick.length ? "ship_to" : "bill_to", suspect, bill, billAddr);
    // registers / delivery lists with an address column: one stop per row
    for (const t of r.tables || []) {
      const cols = (t.columns || []).map(c => (typeof c === "string" ? c : c?.name) || "");
      const ai = cols.findIndex(c => ADDR_COL.test(c)); if (ai < 0) continue;
      const ni = cols.findIndex((c, i) => i !== ai && /name|customer|outlet|nama|客户|名称/i.test(c));
      for (const row of t.rows || []) if (Array.isArray(row) && row[ai]) add(row[ai], ni >= 0 ? row[ni] : "", ref, "table", false, bill, billAddr);
    }
  }
  return mergeNearDuplicates([...out.values()]);
}
// the same address read twice (two copies of one invoice, a slightly different scan) is one stop:
// same postcode and nearly the same text (character-pair similarity), e.g. "TANAH MERAM … OLN MELUR" vs "TANAH MERAH … JLN MELUR"
export const postcodeOf = a => (String(a ?? "").match(/\b\d{5}\b/g) || []).pop() || "";
const STOPWORDS = new Set(["jalan", "taman", "pusat", "bandar", "persiaran", "lorong", "kampung", "medan", "laman", "komersial", "perniagaan", "negeri", "sembilan", "darul", "khusus", "ground", "floor", "malaysia", "selangor", "johor", "kuala", "lumpur", "single", "storey", "delivery", "address"]);
/** distinctive words (street / area names) of an address, to compare it with the address a place service returns */
export const addrWords = a => [...new Set(String(a ?? "").toLowerCase().replace(/\(.*?\)/g, " ").split(/[^a-z]+/).filter(w => w.length >= 5 && !STOPWORDS.has(w)))];
/** is the place a service found the delivery address? found: {name, address, lat, lng}. Same postcode, and the place is a Speed Mart or the street / area words agree. */
/** the store number printed before the branch name: "1577 NS TANAH MERAH (DD)" or "NS X (DD) 3420 NS X" -> "1577" / "3420" */
export function storeNoOf(a) { return /(?:^|[\s,(])(\d{3,4})\)?\s+(?:NS|RS)\b/.exec(String(a || ""))?.[1] || "" }
/** order for several accepted places: the store number match first, then high before medium */
export const placeRank = v => (/^store number/.test(v.reason || "") ? 0 : v.confidence === "high" ? 1 : 2);
/** the lot / unit numbers an address states after "No": "NO: 8 & 9 (GF)" -> {8, 9}; "No. 20-G & 21-G" -> {20, 21} */
export function lotNumbers(a) {
  const out = new Set(), re = /\b(?:NO|PT|LOT)\s*[.:]?\s*(\d+(?:-?[A-Z](?![A-Z]))?(?:\s*(?:&|,|-|AND)\s*\d+(?:-?[A-Z](?![A-Z]))?)*)/gi;
  for (const m of String(a || "").matchAll(re)) for (const n of m[1].match(/\d+/g) || []) out.add(String(+n));
  // a number straight before the floor note names the unit too: "1780 (GF)", "43A (GF)"
  for (const m of String(a || "").matchAll(/\b(\d+)[A-Z]?\s*\(\s*(?:GF|G|GROUND FLOOR)\s*\)/gi)) out.add(String(+m[1]));
  return out;
}
// "UU Speedmart" is another chain: only 99 Speedmart / Speed Mart count
const SPEEDMART_RE = /(?<!\bUU\s*)speed\s*-?\s*mart/i;
export function judgePlace(wanted, found, brandRe = SPEEDMART_RE, requireBrand = false) {
  if (!found || found.lat == null || found.lng == null) return { ok: false, reason: "no place" };
  if (!found.address) return { ok: false, reason: "place has no address to compare" };
  const wantPc = postcodeOf(wanted), foundPc = postcodeOf(found.address);
  if (wantPc && foundPc && wantPc !== foundPc) return { ok: false, reason: `postcode ${foundPc} is not ${wantPc}` };
  if (wantPc && !foundPc) return { ok: false, reason: "place address has no postcode" };
  const brand = !!brandRe && (brandRe.test(found.name || "") || brandRe.test(found.address || ""));
  // when the documents are known to be for one brand (99 Speedmart by the billing party or the user's choice) the place MUST be that brand: another shop on the same street is not the destination
  if (requireBrand && brandRe && !brand) return { ok: false, reason: `not a ${brandRe === undefined ? "Speed Mart" : "match for the brand"}: ${found.name || "?"}` };
  // the printed store number ("1577 NS TANAH MERAH") against the number in the listing's name ("99 Speedmart 1577 Tanah Merah"): equal settles it, different rejects
  const wn = storeNoOf(wanted), fn = /\b(\d{3,4})\b/.exec(found.name || "")?.[1];
  if (wn && fn) return wn === fn ? { ok: true, confidence: "high", reason: `store number ${fn}, postcode ${foundPc}` } : { ok: false, reason: `different store number: ${fn} is not ${wn}` };
  // both addresses name a lot / unit ("NO: 8 & 9", "No. 31") and the numbers differ: a neighbouring branch or shop, however well the street words agree
  const lw = lotNumbers(wanted), lf = lotNumbers(found.address);
  if (lw.size && lf.size && ![...lw].some(n => lf.has(n))) return { ok: false, reason: `different unit: ${[...lf].join(" & ")} is not ${[...lw].join(" & ")}` };
  const fw = new Set(addrWords(found.address + " " + (found.name || ""))), common = addrWords(wanted).filter(w => fw.has(w));
  if (brand && common.length >= 1) return { ok: true, confidence: "high", reason: `brand, postcode ${foundPc}, words: ${common.join(" ")}` };
  if (common.length >= 2) return { ok: true, confidence: "medium", reason: `postcode ${foundPc}, words: ${common.join(" ")}` };
  if (!requireBrand && brand && foundPc === wantPc) return { ok: true, confidence: "medium", reason: `brand in postcode ${foundPc}` };
  return { ok: false, reason: `different place: ${found.name || "?"} (${common.length} shared words)` };
}
export function similarity(a, b) {
  const g = x => { const s = normAddr(x).replace(/[^A-Z0-9]/g, ""), m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1) } return [m, Math.max(0, s.length - 1)] };
  const [ga, na] = g(a), [gb, nb] = g(b); if (!na || !nb) return 0;
  let both = 0; for (const [k, v] of ga) both += Math.min(v, gb.get(k) || 0);
  return 2 * both / (na + nb);
}
// near-identical text alone is not enough (two shops can differ by one letter): it must also be the same document
// (equal or OCR-close number), carry the same longer numbers (outlet code, lot / house number), or be practically identical
const longNums = (a, pc) => [...new Set((normAddr(a).match(/\b\d{3,}\b/g) || []).filter(n => n !== pc))].sort().join(",");
function sameStop(o, s, pc) {
  const sim = similarity(o.address, s.address); if (sim < 0.8) return false;
  if (sim >= 0.93) return true;
  if (o.refs.some(a => s.refs.some(b => a === b || (a.length > 5 && similarity(a, b) >= 0.8)))) return true;
  const n = longNums(o.address, pc); return !!n && n === longNums(s.address, pc);
}
export function mergeNearDuplicates(list) {
  const out = [];
  for (const s of list) {
    const pc = postcodeOf(s.address), twin = pc && out.find(o => postcodeOf(o.address) === pc && sameStop(o, s, pc));
    if (!twin) { out.push({ ...s, refs: [...s.refs] }); continue }
    for (const r of s.refs) if (!twin.refs.includes(r)) twin.refs.push(r);
    if (!twin.name && s.name) twin.name = s.name;
    if (!twin.bill && s.bill) twin.bill = s.bill;
    twin.suspect = twin.suspect && s.suspect;
    (twin.variants ||= []).push(s.address);
  }
  return out;
}

/* ---------- geometry ---------- */
export function haversineKm(a, b) {
  const R = 6371, r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// estimate when no road matrix is available: roads are ~1.3x the straight line, ~40 km/h in mixed traffic
export function estimateMatrix(pts) {
  const n = pts.length, dist = [], dur = [];
  for (let i = 0; i < n; i++) { dist.push([]); dur.push([]); for (let j = 0; j < n; j++) { const km = i === j ? 0 : haversineKm(pts[i], pts[j]) * 1.3; dist[i].push(km * 1000); dur[i].push(km / 40 * 3600) } }
  return { dist, dur, source: "estimate" };
}
// "3.07, 101.5" typed alone, a pair with long decimals inside text, or a Google Maps link (@lat,lng)
export function parseLatLng(s) {
  const x = String(s || "");
  const m = x.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/) || x.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || x.match(/(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/);
  return m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180 ? { lat: +m[1], lng: +m[2] } : null;
}

/* ---------- optimisation (index 0 = start) ----------
   Every improvement step is evaluated from the edges it changes (O(1)), so 500+ stops stay fast; a time budget caps the work.
   The matrix may be asymmetric (one-way streets): reversals use forward/backward prefix sums, so their cost is exact. */
const routeCost = (r, D, back) => { let c = 0, p = 0; for (const i of r) { c += D[p][i]; p = i } return c + (back && r.length ? D[p][0] : 0) };
function nearest(ids, D) {
  const left = new Set(ids), r = []; let p = 0;
  while (left.size) { let b = null; for (const i of left) if (b === null || D[p][i] < D[p][b]) b = i; r.push(b); left.delete(b); p = b }
  return r;
}
function localSearch(r, D, back, until) {
  const e = (a, b) => b == null ? 0 : D[a][b];
  const nxt = (x, i) => i < x.length - 1 ? x[i + 1] : back ? 0 : null, prv = (x, i) => i > 0 ? x[i - 1] : 0;
  let imp = true;
  while (imp && Date.now() < until) {
    imp = false;
    // 2-opt: reverse r[i..k]
    const F = [0], B = [0];
    for (let t = 0; t < r.length - 1; t++) { F.push(F[t] + D[r[t]][r[t + 1]]); B.push(B[t] + D[r[t + 1]][r[t]]) }
    outer: for (let i = 0; i < r.length - 1; i++) for (let k = i + 1; k < r.length; k++) {
      const p = prv(r, i), n = nxt(r, k);
      const d = e(p, r[k]) + e(r[i], n) - e(p, r[i]) - e(r[k], n) + (B[k] - B[i]) - (F[k] - F[i]);
      if (d < -1e-6) { r = [...r.slice(0, i), ...r.slice(i, k + 1).reverse(), ...r.slice(k + 1)]; imp = true; break outer }
    }
    if (imp) continue;
    // or-opt: move one stop elsewhere in the route (2-opt alone cannot, e.g., bring the last stop to the front)
    outer2: for (let i = 0; i < r.length; i++) {
      const s = r[i], rem = e(prv(r, i), nxt(r, i)) - e(prv(r, i), s) - e(s, nxt(r, i)), rest = r.filter((_, k) => k !== i);
      for (let j = 0; j <= rest.length; j++) {
        if (j === i) continue;
        const p = j > 0 ? rest[j - 1] : 0, n = j < rest.length ? rest[j] : back ? 0 : null;
        if (rem + e(p, s) + e(s, n) - e(p, n) < -1e-6) { r = [...rest.slice(0, j), s, ...rest.slice(j)]; imp = true; break outer2 }
      }
    }
  }
  return r;
}
export function planRoutes(pts, D, { lorries = 1, back = false, maxStops = 0, budgetMs = 4000 } = {}) {
  const n = pts.length - 1; if (n < 1) return [];
  const until = Date.now() + budgetMs, k = Math.max(1, Math.min(lorries, n)), cap = maxStops > 0 ? maxStops : Infinity;
  // split by direction from the start (sweep), so each lorry gets one area
  const ang = i => Math.atan2(pts[i].lat - pts[0].lat, pts[i].lng - pts[0].lng);
  const ids = Array.from({ length: n }, (_, i) => i + 1).sort((a, b) => ang(a) - ang(b));
  // start the sweep at the widest angular gap, so no area is cut in two
  let gap = 0, at = 0; ids.forEach((id, i) => { const nx = ids[(i + 1) % n], g = ((ang(nx) - ang(id)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI; if (g > gap) { gap = g; at = (i + 1) % n } });
  const sweep = [...ids.slice(at), ...ids.slice(0, at)], size = Math.min(cap, Math.ceil(n / k));
  const groups = []; for (let i = 0; i < sweep.length; i += size) groups.push(sweep.slice(i, i + size));   // more groups than lorries only when the stop limit forces it
  let routes = groups.map(g => localSearch(nearest(g, D), D, back, until));
  // move single stops between lorries while the plan improves. Objective: the longest route (when the last lorry is back)
  // plus a fifth of the total, so extra lorries are used to finish sooner but not for detours
  const e = (a, b) => b == null ? 0 : D[a][b];
  let cost = routes.map(r => routeCost(r, D, back));
  const obj = c => Math.max(...c) + 0.2 * c.reduce((x, y) => x + y, 0);
  for (let moved = true; moved && Date.now() < until;) {
    moved = false;
    for (let a = 0; a < routes.length && Date.now() < until; a++) for (let i = 0; i < routes[a].length; i++) {
      const ra = routes[a], s = ra[i], p0 = i > 0 ? ra[i - 1] : 0, n0 = i < ra.length - 1 ? ra[i + 1] : back ? 0 : null;
      const ca = ra.length === 1 ? 0 : cost[a] + e(p0, n0) - e(p0, s) - e(s, n0), base = obj(cost);
      let best = null;
      for (let b = 0; b < routes.length; b++) {
        if (b === a || routes[b].length >= cap) continue;
        const rb = routes[b];
        for (let j = 0; j <= rb.length; j++) {
          const p = j > 0 ? rb[j - 1] : 0, n = j < rb.length ? rb[j] : back ? 0 : null, cb = cost[b] + e(p, s) + e(s, n) - e(p, n);
          const c = cost.slice(); c[a] = ca; c[b] = cb; const v = obj(c);
          if (v < base - 1e-6 && (!best || v < best.v)) best = { v, b, j, c };
        }
      }
      if (best) {
        routes[a] = ra.filter((_, k) => k !== i); routes[best.b] = [...routes[best.b].slice(0, best.j), s, ...routes[best.b].slice(best.j)];
        cost = best.c; moved = true; i--;
      }
    }
    const keep = routes.map((r, i) => r.length ? i : -1).filter(i => i >= 0); routes = keep.map(i => routes[i]); cost = keep.map(i => cost[i]);
  }
  return routes.map(r => localSearch(r, D, back, Date.now() + 1000));
}
export function routeStats(r, M, back, serviceMin, startMin) {
  let p = 0, km = 0, sec = 0; const eta = [];
  for (const i of r) { km += M.dist[p][i] / 1000; sec += M.dur[p][i]; eta.push(startMin + sec / 60); sec += serviceMin * 60; p = i }
  if (back) { km += M.dist[p][0] / 1000; sec += M.dur[p][0] }
  return { km, min: sec / 60, eta };
}
// store codes ("3912", "(DD)"), floor notes and "NS" branch prefixes are internal; Google needs street, area, postcode, state
export function cleanAddr(a) {
  let t = String(a).replace(/\s*\n\s*/g, ", ").replace(/\(\s*(?:GF|G|GROUND FLOOR)\s*\)/gi, "").replace(/\(\s*[A-Z]{1,4}\s*\)/g, "")
    .replace(/^\s*\d{3,4}\b[\s,—-]*/, "").replace(/\b(?:NS|RS)\s+(?=(?:TMN|TAMAN|PUSAT|PST|BDR|BANDAR|PP|MEDAN)\b)/i, "").replace(/\bDARUL KHU?S?\.?$/i, "").replace(/\s+/g, " ").trim();
  return /malaysia/i.test(t) ? t : t + ", Malaysia";
}
// the full address exactly as printed (nothing removed; only line breaks and runs of spaces collapsed, and the country added so Google does not look abroad): what Google gets for a stop, so it matches the Address column
// the printed address as a place search / route waypoint: abbreviations spelled out (Google reads "JLN KEBUDAYAAN 21" as house 21 of a street "Kebudayaan"),
// a lone leading number before a street is marked as the house number ("6, JLN X" -> "No. 6, Jalan X"), country added
export const fullAddr = a => {
  let t = String(a).replace(/\s*\n\s*/g, ", ").replace(/\s+/g, " ").trim();
  for (const [re, to] of ABBR) t = t.replace(re, to);
  t = t.replace(/^(\d+(?:-?[A-Za-z])?(?:\s*(?:&|-)\s*\d+(?:-?[A-Za-z])?)*)\s*,\s*(?=(?:Jalan|Lorong|Persiaran|Lebuh|Lebuhraya|Jln|Lrg)\b)/i, "No. $1, ");
  return /malaysia/i.test(t) ? t : t + ", Malaysia";
};
// The branch identity printed on the document ("1954 NS NUSARI BIZ (DD)") is how Google lists the shop: "99 Speedmart 1954 (NS) Nusari Biz".
// Much more unique than a street address; returns "" when the text carries no store number.
export function storeQuery(...texts) {
  for (const x of texts) {
    const m = /(?:^|[\s,])(?:(\d{3,4})\s+)?(NS|RS)\s+([A-Za-z][A-Za-z0-9 .'&/-]*?)\s*\(\s*[A-Za-z0-9]{1,2}\s*\)/.exec(String(x ?? ""));
    if (!m) continue;
    let name = m[3]; for (const [re, to] of ABBR) name = name.replace(re, to);
    name = name.replace(/\b(\w)(\w*)/g, (_, a, b) => a.toUpperCase() + b.toLowerCase()).replace(/\s+/g, " ").trim();
    if (name) return `99 Speedmart ${m[1] ? m[1] + " " : ""}(${m[2].toUpperCase()}) ${name}`;
  }
  return "";
}
// What the uploaded documents are for, chosen by the user before any Google / SerpApi lookup: "99" (Speedmart: store number + name queries, Speed Mart check)
// or "other" (the shop / brand name typed by hand: brand + shop name queries, that name as the check). brand = { mode: "99" | "other" | "", name }.
export const brandOf = v => { const s = String(v ?? "").trim(); return !s || s === "99" ? { mode: "99", name: "" } : s === "other" ? { mode: "other", name: "" } : { mode: "other", name: s } };
export function brandRegex(brand) {
  if (!brand || brand.mode !== "other") return SPEEDMART_RE;
  const w = String(brand.name || "").trim().split(/\s+/).filter(x => x.length >= 2).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return w.length ? new RegExp(w.join("\\s*"), "i") : null;
}
/** the name a place is listed under: the store number form for Speedmart, "<brand> <shop name>" for anything else; "" when there is nothing to add to the address */
export function nameQuery(brand, name, address) {
  if (brand && brand.mode === "other") return [brand.name, name].map(x => String(x ?? "").trim()).filter(Boolean).join(" ");
  return storeQuery(name, address);
}
/** the customer's own name + address when the invoice is billed to the very place it is delivered to (billing address = delivery address): Google lists such a place under its business name,
 *  and a bare "6, JLN X 21" can come back as a house number point ("21, 6, Jalan X"). Never used when the billing address is elsewhere (head office). */
export function selfQuery(s) {
  if (!s || !s.bill || !s.billAddr || !s.address) return "";
  const pc = postcodeOf(s.address);
  if (!pc || pc !== postcodeOf(s.billAddr) || similarity(s.address, s.billAddr) < 0.85) return "";
  return `${s.bill}, ${fullAddr(s.address)}`;
}
/** the printed address as a search text: for 99 Speedmart the brand keyword is added ("99 Speedmart <address>") so the search lands on the shop, not on the lot */
export const addrFor = (brand, address) => (brand?.mode === "99" ? "99 Speedmart " : "") + fullAddr(address);
export const placeQueries = (brand, name, address) => [...new Set([[nameQuery(brand, name, address), brand?.mode === "other" ? postcodeOf(address) : ""].filter(Boolean).join(" "), ...(brand?.mode === "99" ? [addrFor(brand, address)] : []), fullAddr(address)].filter(Boolean))];
/** true when another stop with a different printed address sits on the same pin (to ~10 m); typed pins are never questioned */
export function sharedPin(list, s) {
  if (s.lat == null || s.fail || s.manual) return false;
  const k = x => `${(+x.lat).toFixed(4)},${(+x.lng).toFixed(4)}`, norm = a => String(a || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  return list.some(o => o.key !== s.key && !o.skip && !o.manual && o.lat != null && !o.fail && k(o) === k(s) && norm(o.address) !== norm(s.address));
}

export function mapsLinks(start, stops, back, brandArg) {
  // Google Maps takes up to 9 waypoints per link: long routes are split into consecutive legs
  // stops at the same spot (two invoices for one shop) are one waypoint
  // a stop is sent to Google as its full printed address (as in the Address column): Google's own search knows Malaysian shops and lots far better
  // than a coordinate from the open map, which can land on a neighbouring business. Coordinates only when there is no address.
  const ll = p => `${p.lat},${p.lng}`, brandOfP = p => (typeof brandArg === "function" ? brandArg(p) : brandArg), wp = p => p.address ? (nameQuery(brandOfP(p), p.name, p.address) || selfQuery(p) || addrFor(brandOfP(p), p.address)) : ll(p), seq = [start, ...stops, ...(back ? [start] : [])].filter((p, i, a) => i === 0 || ll(p) !== ll(a[i - 1])), out = [];
  for (let i = 0; i < seq.length - 1; i += 10) {
    const part = seq.slice(i, i + 11); if (part.length < 2) break;
    const w = part.slice(1, -1).map(wp).join("|");
    out.push(`https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${encodeURIComponent(wp(part[0]))}&destination=${encodeURIComponent(wp(part.at(-1)))}${w ? "&waypoints=" + encodeURIComponent(w) : ""}`);
  }
  return out;
}

/* ---------- network: geocoding and road matrix ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastGeo = 0;
async function nominatim(q, cc) {
  const wait = 1100 - (Date.now() - lastGeo); if (wait > 0) await sleep(wait); lastGeo = Date.now();   // usage policy: max 1 request per second
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1${cc ? "&countrycodes=" + encodeURIComponent(cc) : ""}&q=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: { "Accept-Language": "en" } }); if (!r.ok) throw new Error("geocoder HTTP " + r.status);
  const j = await r.json(); return j[0] ? { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name, rank: +j[0].place_rank || 0, pc: j[0].address?.postcode || postcodeOf(j[0].display_name) } : null;
}
// full address first; then from the postcode onwards (unit / lot numbers often confuse the geocoder)
// the printed address as a street query the map service can match: the branch name ("1988 NS TMN X (DD)"), unit numbers ("NO: 20-G & 21-G",
// "1780 (GF)") and state suffixes are dropped, abbreviations spelled out. Measured on 22 real store addresses: the whole printed line never matched,
// this form reached the street for about half of them.
const ABBR = [[/\bJLN\b/gi, "Jalan"], [/\bTMN\b/gi, "Taman"], [/\bPST\b/gi, "Pusat"], [/\bBDR\b/gi, "Bandar"], [/\bLRG\b/gi, "Lorong"], [/\bKG\b/gi, "Kampung"], [/\bPSRN\b/gi, "Persiaran"], [/\bN\.?\s*SEMBILAN\b/gi, "Negeri Sembilan"]];
export function tidyAddr(addr) {
  const parts = String(addr).replace(/^\s*Delivery Address\s*/i, "").replace(/\s*\n\s*/g, ", ").split(",").map(x => x.trim()).filter(Boolean)
    .filter(x => !/\((?:DD|TD|ND|FN|01|[A-Z]{2})\)/.test(x) && !/^(?:NO\s*[:.]?\s*)?[\dA-Z-]+(?:\s*&\s*[\dA-Z-]+)?\s*(?:\([^)]*\))?\.?$/i.test(x) && !/^(?:\d{3,4}\s+)?(?:NS|RS)\s/i.test(x));
  let s = parts.join(", ").replace(/\bDARUL\s*K\w*\.?/gi, "").replace(/\bDARU\b\.?/gi, "").replace(/\s+/g, " ").replace(/[\s,.]+$/g, "");
  for (const [re, to] of ABBR) s = s.replace(re, to);
  return s;
}
export function geoQueries(addr) {
  const a = String(addr).replace(/\s*\n\s*/g, ", ").replace(/\s+/g, " ").trim(), tidy = tidyAddr(a), qs = [];
  if (tidy) { qs.push(tidy); const tp = tidy.split(",").map(s => s.trim()).filter(Boolean); if (tp.length > 3) qs.push(tp.slice(-3).join(", ")) }
  qs.push(a);
  const pc = a.match(/\b\d{5}\b.*$/); if (pc && pc[0] !== a) qs.push(pc[0]);
  const parts = a.split(",").map(s => s.trim()).filter(Boolean); if (parts.length > 2) qs.push(parts.slice(-2).join(", "));
  return [...new Set(qs)];
}
// rewrite (optional): the language model turns a messy printed address into clean search queries
// (abbreviations expanded, unit / floor / branch codes dropped). The coordinates always come from the map service, never from the model.
// pre: search queries the language model already wrote for this address (abbreviations expanded, unit / floor / branch codes
// dropped); tried first, then the address as printed. rewrite (optional): asked only when nothing was found.
// The coordinates always come from the map service, never from the model.
export async function geocode(addr, cc, rewrite, pre = []) {
  const cache = load(GEO, {}), k = normAddr(addr) + "|" + (cc || "");
  if (cache[k] && !((rewrite || pre.length) && (cache[k].approx || (pre.length && (cache[k].rank || 0) < 28)))) return cache[k];
  // a hit in another postcode is a wrong match (a same-named street elsewhere): keep looking, use it only as a last resort
  const want = postcodeOf(addr), ok = h => h && !(want && h.pc && String(h.pc).replace(/\s/g, "") !== want);
  let hit = null, approx = false, query = null, other = null;
  const tryQ = async q => { const h = await nominatim(q, cc); if (ok(h)) return h; if (h && !other) other = h; return null };
  for (const q of pre.filter(x => typeof x === "string" && x.trim()).slice(0, 3)) { hit = await tryQ(q); if (hit) { query = q; break } }
  if (!hit) for (const [i, q] of geoQueries(addr).entries()) { hit = await tryQ(q); if (hit) { approx = i > 0; break } }
  if ((!hit || approx) && rewrite && !pre.length) {
    const qs = await rewrite(addr).catch(() => []);
    for (const q of (Array.isArray(qs) ? qs : []).filter(x => typeof x === "string" && x.trim()).slice(0, 3)) {
      const h = await tryQ(q); if (h) { hit = h; approx = false; query = q; break }
    }
  }
  // the map service often knows only the street or the housing estate: that centroid is not the shop. Only a building / house / POI hit counts as located.
  let res = hit ? { lat: hit.lat, lng: hit.lng, label: hit.label, approx, rank: hit.rank || 0, ...(query ? { ai: query } : {}) } : { fail: true };
  if (!hit && other) res = { lat: other.lat, lng: other.lng, label: other.label, rank: other.rank || 0, approx: true, pcMismatch: other.pc };
  if (hit) { cache[k] = res; save(GEO, cache) }
  return res;
}

// With a model that can search the web: it looks up the exact premises (Google Maps place) of every stop the map service only found at street /
// estate level. Its coordinates are never taken on trust: verifyWebPos() below must confirm them.
// the web-search prompt follows what the user chose the deliveries are for (see brandOf)
export const locatePrompt = brand => {
  const other = brand && brand.mode === "other", shop = other ? (brand.name ? `a ${brand.name} shop` : "a shop") : "usually a 99 Speed Mart store, with a store code and branch name";
  return `You can search the web. Each numbered line is a delivery address in Malaysia, printed on a delivery order (${shop}).
For each, find the EXACT premises on Google Maps (search the ${other ? "shop name" : "store name"} + street + postcode) and report the coordinates that the page you found shows (a Google Maps place page or link: "@lat,lng" / "!3dLAT!4dLNG"), with 6 decimals.
Never estimate, interpolate or guess coordinates, and never give the centre of a street or estate. If you cannot find the exact premises, set found to false.
Return JSON only: {"results":[{"n":1,"found":true,"place_name":"...","address_found":"full address as shown","lat":1.234567,"lng":103.123456,"maps_url":"the Google Maps URL you used","evidence":"one short sentence"}]}
Addresses:
`;
};
export const LOCATE_PROMPT = locatePrompt({ mode: "99" });
async function nominatimReverse(lat, lng) {
  const wait = 1100 - (Date.now() - lastGeo); if (wait > 0) await sleep(wait); lastGeo = Date.now();
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lng}`, { headers: { "Accept-Language": "en" } });
  if (!r.ok) throw new Error("geocoder HTTP " + r.status); const j = await r.json();
  return { pc: j?.address?.postcode || postcodeOf(j?.display_name || ""), label: j?.display_name || "" };
}
// coordinates a Google Maps URL carries
export function coordsInUrl(u) {
  const s = decodeURIComponent(String(u || "")), m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || s.match(/[?&](?:query|q|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
}
/* a model-reported position is accepted only when: it lies in Malaysia; the Google URL it cites (if any) carries the same coordinate;
   and the map service agrees that point is in the printed postcode (or, without a postcode, within 3 km of the street-level hit). */
export async function verifyWebPos(addr, m, near) {
  const lat = +m?.lat, lng = +m?.lng;
  if (!m?.found || !Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, reason: "not found" };
  if (lat < 0.8 || lat > 7.5 || lng < 99.5 || lng > 119.5) return { ok: false, reason: "outside Malaysia" };
  const u = coordsInUrl(m.maps_url), urlAgrees = !!u && haversineKm({ lat, lng }, u) <= 0.15;
  if (u && !urlAgrees) return { ok: false, reason: "coordinate differs from its own Google link" };
  const want = postcodeOf(addr); let rev = null; try { rev = await nominatimReverse(lat, lng) } catch { }
  if (want && rev?.pc) { if (String(rev.pc).replace(/\s/g, "") !== want) return { ok: false, reason: `point is in postcode ${rev.pc}, not ${want}` } }
  else if (near && haversineKm({ lat, lng }, near) > 3) return { ok: false, reason: "far from the street the map service found" };
  else if (!urlAgrees) return { ok: false, reason: "nothing confirms the coordinate" };
  return { ok: true, confidence: urlAgrees ? "high" : "medium", label: [m.place_name, m.address_found].filter(Boolean).join(", ") || rev?.label || "" };
}
// a stop far from every other stop is usually a wrong location or a document that belongs to another trip
export function farStops(pts) {
  if (pts.length < 4) return [];
  const nn = pts.map((p, i) => Math.min(...pts.map((q, j) => i === j ? Infinity : haversineKm(p, q))));
  const med = [...nn].sort((a, b) => a - b)[Math.floor(nn.length / 2)];
  return pts.map((p, i) => ({ p, km: nn[i] })).filter(x => x.km > Math.max(30, 6 * med));
}
export const ADDRESS_BATCH_PROMPT = `Rewrite each numbered delivery address into search queries for a map geocoder (OpenStreetMap).
Expand abbreviations (e.g. JLN -> Jalan, TMN -> Taman, LRG -> Lorong, KG -> Kampung, BDR -> Bandar), drop unit, floor, lot-in-building, branch / store codes and notes in brackets such as (GF) or (DA), keep street number, street, area, postcode, city and state. A leading company or shop name is not part of the address.
For each address give up to 3 queries, most specific first (the last may be just "area, postcode city"). Do not invent anything that is not in the address.
Answer as ONE JSON object: {"results":[{"n":1,"queries":["..."]}]}. Raw JSON only.
ADDRESSES:
`;
export const ADDRESS_PROMPT = `Rewrite this delivery address into search queries for a map geocoder (OpenStreetMap).
Expand abbreviations (e.g. JLN -> Jalan, TMN -> Taman, LRG -> Lorong, KG -> Kampung, BDR -> Bandar, PJU -> keep), drop unit, floor, lot-in-building, branch / store codes and notes in brackets such as (GF) or (DA), keep street number, street, area, postcode, city and state.
Give up to 3 queries, most specific first (the last one may be just "area, postcode city"). Do not invent anything that is not in the address.
Answer as ONE JSON object: {"queries":["...","..."]}. Raw JSON only.
ADDRESS:
`;
export async function roadMatrix(pts) {
  const est = estimateMatrix(pts), N = pts.length, B = 50;
  if (N > 300) return est;   // too many requests for the public server: straight-line estimate
  const fix = (m, e) => m.map((row, i) => row.map((v, k) => v ?? e[i][k]));
  const ll = p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
  try {
    // the public OSRM server answers up to ~100 points per request: bigger sets are asked block by block (sources x destinations, 50 + 50 points)
    if (N <= 100) {
      const r = await fetch(`https://router.project-osrm.org/table/v1/driving/${pts.map(ll).join(";")}?annotations=duration,distance`), j = await r.json();
      if (j.code !== "Ok" || !j.durations) throw new Error(j.code || "OSRM");
      return { dist: fix(j.distances, est.dist), dur: fix(j.durations, est.dur), source: "osrm" };
    }
    const dist = est.dist.map(r => r.slice()), dur = est.dur.map(r => r.slice());
    for (let i = 0; i < N; i += B) for (let k = 0; k < N; k += B) {
      const S = pts.slice(i, i + B), D = i === k ? S : pts.slice(k, k + B), coords = i === k ? S : [...S, ...D];
      const src = S.map((_, x) => x).join(";"), dst = i === k ? src : D.map((_, x) => S.length + x).join(";");
      const r = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords.map(ll).join(";")}?sources=${src}&destinations=${dst}&annotations=duration,distance`), j = await r.json();
      if (j.code !== "Ok" || !j.durations) throw new Error(j.code || "OSRM");
      for (let x = 0; x < S.length; x++) for (let y = 0; y < D.length; y++) {
        if (j.durations[x][y] != null) dur[i + x][k + y] = j.durations[x][y];
        if (j.distances?.[x]?.[y] != null) dist[i + x][k + y] = j.distances[x][y];
      }
    }
    return { dist, dur, source: "osrm" };
  } catch { return est }
}

/* ---------- UI ---------- */
export function renderRoute(view, api) {
  const { t, esc, docs, askModel, rewriteAddr, rewriteMany, locateMany, placeLocate, dl } = api;
  const st = Object.assign({ start: "", startLL: null, lorries: 1, back: true, service: 10, time: "08:00", maxStops: 0, cc: "my", brand: "", brandName: "", manual: [], over: {} }, load(KEY, {}));
  const persist = () => save(KEY, st);
  const allStops = () => [...collectStops(docs()), ...st.manual.map(m => ({ key: normAddr(m.address), address: m.address, name: m.name || "", refs: [], src: "manual" }))]
    .map(s => ({ ...s, ...(st.over[s.key] || {}) }));
  // a removed stop is gone from the list and the plan; one from a document can be brought back ("restore"), a hand-added one is deleted
  const stops = () => allStops().filter(x => !x.removed);
  let plan = null, msg = "", review = null;
  const fmtT = m => { const h = Math.floor(m / 60) % 24, mm = Math.round(m % 60); return `${String(h).padStart(2, "0")}:${String(mm === 60 ? 59 : mm).padStart(2, "0")}` };
  let editing = null;
  const mapLink = p => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  // a stop's own link searches Google for the printed address (its own business / lot data); the open-map coordinate is often only the street
  // what a stop's documents are for: the user's choice for all stops, else the billing party of its own documents ("99 SPEED MART SDN. BHD." = 99 Speedmart)
  const brandFor = s => st.brand ? { mode: st.brand, name: st.brandName } : isSpeedmartName(s?.bill) ? { mode: "99", name: "", auto: true } : null;
  const addrLink = s => s.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addrFor(brandFor(s), s.address))}` : mapLink(s);
  // the store number + name ("99 Speedmart 1954 (NS) Nusari Biz") is how Google lists a shop: when the document carries it, that is the main link
  // (confirmed more accurate than the address on real stops), the full printed address the second
  const viewLinks = s => {
    const sq = nameQuery(brandFor(s) || {}, s.name, s.address) || selfQuery(s), a = `<a class="sub" target="_blank" rel="noopener" href="${esc(addrLink(s))}">${t(sq ? "rt_view_addr" : "rt_view")}</a>`;
    return sq ? ` <a class="sub" target="_blank" rel="noopener" href="${esc("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(sq))}" title="${esc(sq)}">${t("rt_view")}</a> ${a}` : " " + a;
  };
  // a position the user typed (or an address that is itself a coordinate) is exact; a model-reported one counts once verified
  // two different delivery addresses on the very same pin means the service returned one shop (or building) for both: at most one is right, so none counts as exact
  const precise = s => !!s.manual || !!parseLatLng(s.address) || ((!!s.web || (!s.approx && (s.rank || 0) >= 28)) && !sharedPin(stops(), s));
  const status = s => s.lat != null && !s.fail ? (s.web ? `<span class="badge ok" title="${esc(s.webSrc || "")}">${t("rt_st_web")}${s.webConf === "high" ? "" : " (?)"}</span>` : !precise(s) ? `<span class="badge warn" title="${esc((s.webWhy ? s.webWhy + " — " : "") + t("rt_geo_street_d"))}">${t(s.approx ? "rt_geo_approx" : "rt_geo_street")}</span>` : `<span class="badge ok" ${s.ai ? `title="${esc(s.ai)}"` : ""}>✓ ${t(s.ai ? "rt_st_ai" : "rt_st_ok")}</span>`) + ` ${viewLinks(s)}` + (s.label ? `<div class="sub" title="${esc(String(s.label))}">${esc(String(s.label).split(",").slice(0, 4).join(","))}</div>` : "")
    : (s.fail ? `<span class="badge bad">${t("rt_geo_fail")}</span>` : `<span class="badge" style="background:var(--soft);color:var(--mut)">${t("rt_st_pending")}</span>`) + (s.address ? viewLinks(s) : "");
  // Fix by pin: a Leaflet map (loaded on first use, OpenStreetMap tiles) where a click or a drag sets the exact position of a stop
  let draft = null;
  const LEAFLET = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/";
  let leafletP = null;
  const leaflet = () => leafletP ||= new Promise((res, rej) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = LEAFLET + "leaflet.css"; document.head.append(css);
    const sc = document.createElement("script"); sc.src = LEAFLET + "leaflet.js"; sc.onload = () => res(window.L); sc.onerror = () => { leafletP = null; rej(new Error("leaflet")) }; document.head.append(sc);
  });
  const initPin = async (host, s) => {
    let L; try { L = await leaflet() } catch { host.textContent = t("rt_map_off"); return }
    if (!host.isConnected) return;
    const d = draft && draft.key === s.key ? draft : null, c = d || (s.lat != null ? s : null), centre = c || st.startLL || { lat: 4.2, lng: 102 };
    const map = L.map(host, { scrollWheelZoom: false }).setView([centre.lat, centre.lng], c ? 17 : st.startLL ? 12 : 6);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    const input = () => view.querySelector("[data-ll]"), icon = L.divIcon({ className: "pin", iconSize: [18, 18], iconAnchor: [9, 9] });
    const set = (lat, lng) => { draft = { key: s.key, lat, lng }; const el = input(); if (el) el.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
    let mk = null;
    const place = (lat, lng) => { if (mk) mk.setLatLng([lat, lng]); else { mk = L.marker([lat, lng], { draggable: true, icon }).addTo(map); mk.on("dragend", () => { const p = mk.getLatLng(); set(p.lat, p.lng) }) } set(lat, lng) };
    if (c) { mk = L.marker([c.lat, c.lng], { draggable: true, icon }).addTo(map); mk.on("dragend", () => { const p = mk.getLatLng(); set(p.lat, p.lng) }) }
    map.on("click", e => place(e.latlng.lat, e.latlng.lng));
    setTimeout(() => map.invalidateSize(), 0);
  };
  const draw = () => {
    const S = stops(), hidden = allStops().length - S.length, on = S.filter(s => !s.skip), need = !st.start ? t("rt_need_start") : !on.length ? t("rt_need_stops") : "";
    const fld = (id, label, attrs) => `<div class="f"><label for="${id}">${label}</label><input id="${id}" ${attrs}></div>`;
    const placed = s => s.lat != null && !s.fail && precise(s);
    // ---- stops: one flat list, one block per stop (name, documents, address | location state | actions)
    const rowHtml = (s, i) => `<li class="rt-row${s.skip ? " off" : ""}" data-key="${esc(s.key)}">
        <input type="checkbox" data-skip="${i}" ${s.skip ? "" : "checked"} aria-label="${esc(t("rt_use"))}">
        <div class="rt-info"><div class="rt-name">${s.name && !normAddr(s.address).startsWith(normAddr(s.name)) ? `<b>${esc(s.name)}</b>` : ""}${s.refs.length ? `<span class="rt-docs">${esc(s.refs.join(", "))}</span>` : ""}</div>
          <div class="rt-addr">${esc(s.address)}</div>${s.variants ? `<span class="rt-note" title="${esc(s.variants.join("\n"))}">${t("rt_merged", { n: s.variants.length + 1 })}</span>` : ""}</div>
        <div class="rt-loc">${status(s)}${s.suspect ? `<span class="badge warn" title="${esc(t("rt_check_d"))}">${t("rt_check")}</span>` : ""}</div>
        <div class="rt-acts"><button class="lnk" data-edit="${i}" type="button">${t("rt_edit")}</button><button class="lnk" data-del="${i}" type="button" title="${esc(t("rt_del"))}" aria-label="${esc(t("rt_del"))}">&times;</button></div>
        ${editing === s.key ? `<div class="rt-fix"><div class="rt-pin" data-pin="${i}"></div><span class="sub">${t("rt_pin_help")}</span><input data-ll="${i}" value="${(draft && draft.key === s.key) ? `${draft.lat.toFixed(5)}, ${draft.lng.toFixed(5)}` : s.lat != null ? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}` : ""}" placeholder="${esc(t("rt_ll_ph"))}"><span class="sub">${t("rt_ll_help")}</span><div class="rt-pinbar"><button class="btn sm pri" data-pin-save type="button">${t("rt_pin_use")}</button><button class="lnk" data-pin-cancel type="button">${t("rt_pin_cancel")}</button></div></div>` : ""}</li>`;
    let stopsHtml = `<div class="rt-head"><h3>${t("rt_step3", { n: on.length, m: S.length })}</h3>${S.length ? `<span class="rt-sum">${t("rt_sum", { n: S.length, p: S.filter(placed).length, q: S.filter(s => !placed(s)).length })}</span>` : ""}</div>`;
    stopsHtml += `<div class="rt-tools"><input id="rt-new" placeholder="${esc(t("rt_add_ph"))}"><button class="btn sm" id="rt-add" type="button">${t("rt_add")}</button>${S.length ? `<button class="btn sm" id="rt-locate" type="button">${t("rt_locate")}</button>` : ""}${hidden ? `<button class="btn sm" id="rt-restore" type="button">${t("rt_restore", { n: hidden })}</button>` : ""}</div>`;
    if (S.length) stopsHtml += `<div class="rt-sub"><label class="chk"><input type="checkbox" id="rt-onlyfix" ${st.onlyFix ? "checked" : ""}> ${t("rt_only")}</label><span class="rt-io"><button class="lnk" id="rt-export" type="button">${t("rt_export")}</button><label class="lnk">${t("rt_import")}<input type="file" id="rt-import" accept=".json,application/json" hidden></label></span></div>`;
    stopsHtml += S.length ? `<ul class="rt-list">${S.map((s, i) => (st.onlyFix && placed(s) && !s.suspect) ? "" : rowHtml(s, i)).join("")}</ul>` : `<p class="sub">${t("rt_none")}</p>`;

    // ---- a schematic map (no tiles, no network): where the stops are, how the lorries run
    const svgMap = () => {
      const pts = S.filter(s => s.lat != null && !s.fail), start = st.startLL;
      if (!pts.length) return "";
      const all = [...pts.map(p => [p.lat, p.lng]), ...(start ? [[start.lat, start.lng]] : [])];
      const la = all.map(p => p[0]), lo = all.map(p => p[1]), minLa = Math.min(...la), maxLa = Math.max(...la), minLo = Math.min(...lo), maxLo = Math.max(...lo);
      const kx = Math.cos(((minLa + maxLa) / 2) * Math.PI / 180), W = 360, H = 250, pad = 20;
      const sx = Math.max((maxLo - minLo) * kx, 1e-6), sy = Math.max(maxLa - minLa, 1e-6), sc = Math.min((W - 2 * pad) / sx, (H - 2 * pad) / sy);
      const ox = pad + ((W - 2 * pad) - sx * sc) / 2, oy = pad + ((H - 2 * pad) - sy * sc) / 2;
      const X = lng => (ox + (lng - minLo) * kx * sc).toFixed(1), Y = lat => (oy + (maxLa - lat) * sc).toFixed(1);
      let g = "";
      if (plan) plan.routes.forEach((rt, i) => {
        const line = [...(start ? [start] : []), ...rt.stops, ...(st.back && start ? [start] : [])].map(p => `${X(p.lng)},${Y(p.lat)}`).join(" ");
        g += `<polyline class="rt-line l${i % 6}" points="${line}"/>`;
      });
      pts.forEach(s => { g += `<circle class="rt-dot ${precise(s) ? "ex" : "st"}" data-key="${esc(s.key)}" cx="${X(s.lng)}" cy="${Y(s.lat)}" r="4"/>` });
      if (plan) plan.routes.forEach((rt, i) => rt.stops.forEach((s, k) => { g += `<text class="rt-seq l${i % 6}" x="${(+X(s.lng) + 6).toFixed(1)}" y="${(+Y(s.lat) - 5).toFixed(1)}">${k + 1}</text>` }));
      if (start) g += `<rect class="rt-start" x="${(+X(start.lng) - 5).toFixed(1)}" y="${(+Y(start.lat) - 5).toFixed(1)}" width="10" height="10"/>`;
      return `<figure class="rt-fig"><svg class="rt-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("rt_map_alt", { n: pts.length }))}">${g}</svg><figcaption><span class="lg ex"></span>${t("rt_leg_exact")}<span class="lg st"></span>${t("rt_leg_street")}<span class="lg sq"></span>${t("rt_leg_start")}</figcaption></figure>`;
    };

    // the live map of every located stop (OpenStreetMap tiles through Leaflet); the drawn schematic below is the fallback when Leaflet cannot load
    const mapHtml = () => { const f = svgMap(); return f ? f.replace(/<svg[\s\S]*<\/svg>/, `<div class="rt-lmap" role="img" aria-label="${esc(t("rt_map_alt", { n: S.filter(s => s.lat != null && !s.fail).length }))}"></div>`) : "" };
    const initRouteMap = async host => {
      let L; try { L = await leaflet() } catch { host.innerHTML = (svgMap().match(/<svg[\s\S]*<\/svg>/) || [""])[0]; return }
      if (!host.isConnected) return;
      const pts = S.filter(s => s.lat != null && !s.fail), start = st.startLL, map = L.map(host, { scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      const all = [...pts.map(p => [p.lat, p.lng]), ...(start ? [[start.lat, start.lng]] : [])], mks = {};
      if (plan) plan.routes.forEach((rt, i) => L.polyline([...(start ? [start] : []), ...rt.stops, ...(st.back && start ? [start] : [])].map(p => [p.lat, p.lng]), { className: "rt-ll l" + (i % 6) }).addTo(map));
      const seq = new Map(); if (plan) plan.routes.forEach(rt => rt.stops.forEach((s, k) => seq.set(s.key, k + 1)));
      pts.forEach(s => {
        const mk = L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "mk " + (precise(s) ? "ex" : "st"), html: seq.get(s.key) || "", iconSize: [24, 24], iconAnchor: [12, 12] }), keyboard: false }).addTo(map);
        mk.bindTooltip(String(s.name || s.address).slice(0, 80));
        mk.on("click", () => { const row = view.querySelector(`.rt-row[data-key="${CSS.escape(s.key)}"]`); if (row) { row.scrollIntoView({ block: "center" }); row.classList.add("hl"); setTimeout(() => row.classList.remove("hl"), 1600) } });
        mks[s.key] = mk;
      });
      if (start) L.marker([start.lat, start.lng], { icon: L.divIcon({ className: "mk start", html: "", iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false }).addTo(map);
      map.fitBounds(L.latLngBounds(all), { padding: [28, 28], maxZoom: 16 });
      view.querySelectorAll(".rt-row").forEach(row => {
        row.onmouseenter = () => mks[row.dataset.key]?.getElement()?.classList.add("hl");
        row.onmouseleave = () => mks[row.dataset.key]?.getElement()?.classList.remove("hl");
      });
      setTimeout(() => map.invalidateSize(), 0);
    };

    // ---- side panel: setup, plan, result
    let h = `<div class="rt-main">${mapHtml()}${stopsHtml}</div><aside class="rt-side">
      <details class="how"><summary>${t("rt_how_h")}</summary><p class="sub">${t("rt_intro")}</p><p class="sub">${t("rt_how")}</p></details>
      <div class="rt-brand"><div class="rt-lab">${t("rt_brand_q")}</div><div class="rt-radios"><label class="chk"><input type="radio" name="rt-brand" value="99" ${st.brand === "99" ? "checked" : ""}> ${t("rt_brand_99")}</label><label class="chk"><input type="radio" name="rt-brand" value="other" ${st.brand === "other" ? "checked" : ""}> ${t("rt_brand_other")}</label></div>${st.brand === "other" ? `<input id="rt-brandname" value="${esc(st.brandName)}" placeholder="${esc(t("rt_brand_ph"))}">` : ""}${(placeLocate || locateMany) && !st.brand ? `${S.some(s => isSpeedmartName(s.bill)) ? `<p class="rt-hint">${t("rt_brand_auto", { n: S.filter(s => isSpeedmartName(s.bill)).length, m: S.length })}</p>` : ""}${S.some(s => !isSpeedmartName(s.bill)) ? `<p class="rt-hint rt-need">${t("rt_brand_wait")}</p>` : ""}` : ""}</div>
      <h3 class="rt-title">${t("rt_setup")}</h3>
      <div class="rt-form">
        <div class="rt-f rt-wide"><label for="rt-start">${t("rt_start")}</label><div class="rt-inline"><input id="rt-start" value="${esc(st.start)}" placeholder="${esc(t("rt_start_ph"))}"><button class="lnk" id="rt-here" type="button">${t("rt_here")}</button></div>${st.startLL ? `<span class="rt-hint">${t("rt_start_ok")} <a target="_blank" rel="noopener" href="${esc(mapLink(st.startLL))}">${st.startLL.lat.toFixed(5)}, ${st.startLL.lng.toFixed(5)}</a></span>` : ""}</div>
        ${fld("rt-time", t("rt_time"), `type="time" value="${esc(st.time)}"`).replace('class="f"', 'class="rt-f"')}
        <div class="rt-f"><label class="chk rt-back"><input type="checkbox" id="rt-back" ${st.back ? "checked" : ""}> ${t("rt_back")}</label></div>
        ${[["rt-lorries", "rt_lorries", `type="number" min="1" max="50" value="${st.lorries}"`], ["rt-service", "rt_service", `type="number" min="0" max="240" value="${st.service}"`], ["rt-max", "rt_maxstops", `type="number" min="0" value="${st.maxStops}"`], ["rt-cc", "rt_cc", `value="${esc(st.cc)}" maxlength="20"`]].map(([id, k, at]) => fld(id, t(k), at).replace('class="f"', 'class="rt-f"')).join("")}
      </div>
      <div class="rt-plan"><button class="btn pri" id="rt-plan" ${need ? "disabled" : ""}>${t("rt_plan")}</button>${plan ? `<button class="lnk" id="rt-csv">${t("rt_csv")}</button>${askModel ? `<button class="lnk" id="rt-ai">${t("rt_ai")}</button>` : ""}` : ""}<span class="rt-msg" id="rt-msg">${esc(msg || need)}</span></div>
      `;
    if (plan) {
      h += `<h3 class="rt-title">${t("rt_result", { k: plan.routes.length, km: plan.km.toFixed(1), h: (plan.min / 60).toFixed(1) })}</h3><p class="sub">${t(plan.source === "osrm" ? "rt_src_osrm" : "rt_src_est")}${plan.unplaced.length ? ", " + t("rt_unplaced", { n: plan.unplaced.length }) : ""}</p>`;
      if (plan.far.size) h += `<div class="rt-warn"><b>${t("rt_far_h", { n: plan.far.size })}</b><p class="sub">${t("rt_far_d")}</p><ul>${[...plan.far].map(([k, km]) => { const s = ok_(k); return `<li>${esc(s ? (s.name ? s.name + " — " : "") + s.address : k)} <span class="sub">(${t("rt_far_km", { km: km.toFixed(0) })}${s?.refs?.length ? ", " + esc(s.refs.join(", ")) : ""})</span></li>` }).join("")}</ul></div>`;
      plan.routes.forEach((r, i) => {
        h += `<section class="rt-lorry l${i % 6}"><h4>${t("rt_lorry", { i: i + 1, n: r.stops.length, km: r.km.toFixed(1), h: (r.min / 60).toFixed(1), end: fmtT(plan.t0 + r.min) })}</h4>${r.min > 10 * 60 ? `<p class="rt-warnline">${t("rt_long", { h: (r.min / 60).toFixed(1), k: Math.ceil(plan.min / (9 * 60)) })}</p>` : ""}<ol>${r.stops.map((s, k) => `<li${plan.far.has(s.key) ? ' class="far"' : ""}><b>${fmtT(r.eta[k])}</b>, ${esc(s.name ? s.name + " — " : "")}${esc(s.address)}${s.refs.length ? ` <span class="sub">(${esc(s.refs.join(", "))})</span>` : ""}</li>`).join("")}</ol><div class="rt-nav">${r.links.map((u, k) => `<a class="btn sm" target="_blank" rel="noopener" href="${esc(u)}">${t("rt_nav", { k: k + 1, n: r.links.length })}</a>`).join("")}</div></section>`;
      });
      if (plan.unplaced.length) h += `<p class="sub">${t("rt_unplaced_d")}: ${plan.unplaced.map(s => esc(s.address)).join(", ")}</p>`;
    }
    if (review) h += `<h3 class="rt-title">${t("rt_ai_h")}</h3><div class="rt-review">${review.summary ? `<p>${esc(review.summary)}</p>` : ""}${(review.warnings || []).map(w => `<p>${esc(w)}</p>`).join("")}${(review.suggestions || []).map(w => `<p>${esc(w)}</p>`).join("")}<p class="sub">${t("rt_ai_note")}</p></div>`;
    h += `<p class="rt-priv">${t("rt_privacy")}</p></aside>`;
    h = `<div class="rt">${h}</div>`;
    // background lookups redraw the page: keep what the user is typing (and where) so it is not wiped
    const act = document.activeElement, keep = [...view.querySelectorAll("input[id]:not([type=checkbox])")].filter(el => el.id === "rt-new" || el === act).map(el => [el.id, el.value, el === act, el.selectionStart]);
    view.innerHTML = h;
    for (const [id, v, focused, pos] of keep) { const el = view.querySelector("#" + id); if (!el) continue; el.value = v; if (focused) { el.focus(); try { el.setSelectionRange(pos, pos) } catch {} } }
    // the local helper (tools/maps-locate.mjs) looks the stops that are not exact up on Google Maps and writes locations.json: export the list, import the result
    view.querySelector("#rt-export")?.addEventListener("click", () => {
      const todo = stops().filter(s => !s.skip && !placed(s)).map(s => ({ key: s.key, name: s.name || "", address: s.address, ...(brandFor(s) ? { brand: brandFor(s).mode === "other" ? (brandFor(s).name || "other") : "99" } : {}), ...(s.lat != null ? { near: { lat: s.lat, lng: s.lng } } : {}) }));
      dl("stops-to-check.json", JSON.stringify(todo, null, 1), "application/json");
    });
    view.querySelector("#rt-import")?.addEventListener("change", async e => {
      const f = e.target.files?.[0]; if (!f) return;
      try {
        const rows = JSON.parse(await f.text()); let n = 0; const byKey = new Map(allStops().map(s => [s.key, s]));
        for (const r of Array.isArray(rows) ? rows : []) {
          if (!r || !r.ok || !Number.isFinite(+r.lat) || !Number.isFinite(+r.lng)) continue;
          const key = r.key && byKey.has(r.key) ? r.key : normAddr(r.address || ""); if (!byKey.has(key)) continue;
          st.over[key] = { ...(st.over[key] || {}), lat: +r.lat, lng: +r.lng, label: [r.place, r.found_address].filter(Boolean).join(", "), approx: false, fail: undefined, web: true, rank: 30, webSrc: r.url || "", webConf: r.confidence === "high" ? "high" : "medium", webTried: true, aiTried: true };
          n++;
        }
        persist(); msg = t("rt_imported", { n }); draw();
      } catch { msg = t("rt_import_bad"); draw() }
    });
    view.querySelectorAll(".rt-row").forEach(li => { const on = v => view.querySelector(`.rt-dot[data-key="${CSS.escape(li.dataset.key)}"]`)?.classList.toggle("hl", v); li.addEventListener("mouseenter", () => on(true)); li.addEventListener("mouseleave", () => on(false)) });
    const mapHost = view.querySelector(".rt-lmap"); if (mapHost) initRouteMap(mapHost);
    const pinHost = view.querySelector(".rt-pin"); if (pinHost) initPin(pinHost, S[+pinHost.dataset.pin]);
    view.querySelector("[data-pin-save]")?.addEventListener("click", () => view.querySelector("[data-ll]")?.dispatchEvent(new Event("change")));
    view.querySelector("[data-pin-cancel]")?.addEventListener("click", () => { editing = null; draft = null; draw() });
    view.querySelector("#rt-onlyfix")?.addEventListener("change", e => { st.onlyFix = e.target.checked; persist(); draw() });
    // a different brand means different queries and a different check: stops the place lookup missed are asked again
    const resetLookups = () => { for (const k of Object.keys(st.over)) if (!st.over[k].web && !st.over[k].manual) delete st.over[k].gTried };
    view.querySelectorAll("input[name=rt-brand]").forEach(el => el.addEventListener("change", () => { st.brand = el.value; resetLookups(); persist(); draw() }));
    const num = (id, d) => { const v = parseInt(view.querySelector(id).value); return Number.isFinite(v) ? v : d };
    const sync = () => { st.start = view.querySelector("#rt-start").value.trim(); st.lorries = Math.max(1, num("#rt-lorries", 1)); st.time = view.querySelector("#rt-time").value || "08:00"; st.service = Math.max(0, num("#rt-service", 10)); st.maxStops = Math.max(0, num("#rt-max", 0)); st.cc = view.querySelector("#rt-cc").value.trim(); st.back = view.querySelector("#rt-back").checked; const bn = view.querySelector("#rt-brandname"); if (bn && bn.value.trim() !== st.brandName) { st.brandName = bn.value.trim(); resetLookups() } persist() };
    view.querySelectorAll("input[id^=rt-]:not(#rt-new)").forEach(el => el.onchange = () => { const had = st.start; sync(); if (had !== st.start) { st.startLL = null; persist(); locateStart() } draw() });
    view.querySelector("#rt-here").onclick = () => {
      if (!navigator.geolocation) { msg = t("rt_here_fail"); return draw() }
      navigator.geolocation.getCurrentPosition(p => { st.startLL = { lat: p.coords.latitude, lng: p.coords.longitude }; st.start = `${st.startLL.lat.toFixed(5)}, ${st.startLL.lng.toFixed(5)}`; persist(); msg = ""; draw() }, () => { msg = t("rt_here_fail"); draw() }, { timeout: 15000 });
    };
    view.querySelectorAll("[data-skip]").forEach(el => el.onchange = () => { const s = S[+el.dataset.skip]; st.over[s.key] = { ...(st.over[s.key] || {}), skip: !el.checked }; persist(); draw() });
    view.querySelectorAll("[data-del]").forEach(el => el.onclick = () => {
      const s = S[+el.dataset.del];
      if (s.src === "manual") { st.manual = st.manual.filter(m => normAddr(m.address) !== s.key); delete st.over[s.key] }
      else st.over[s.key] = { ...(st.over[s.key] || {}), removed: true };
      if (editing === s.key) editing = null;
      plan = null; review = null; persist(); draw();
    });
    const rs = view.querySelector("#rt-restore"); if (rs) rs.onclick = () => { for (const k in st.over) delete st.over[k].removed; plan = null; persist(); draw() };
    view.querySelectorAll("[data-edit]").forEach(el => el.onclick = () => { const k = S[+el.dataset.edit].key; editing = editing === k ? null : k; if (!editing) draft = null; draw() });
    view.querySelectorAll("[data-ll]").forEach(el => el.onchange = () => { const s = S[+el.dataset.ll], ll = parseLatLng(el.value); const o = { ...(st.over[s.key] || {}) }; delete o.fail; delete o.approx; if (ll) Object.assign(o, ll, { manual: true }); else { delete o.lat; delete o.lng; delete o.manual } st.over[s.key] = o; editing = null; draft = null; persist(); draw() });
    view.querySelector("#rt-add").onclick = () => { const v = view.querySelector("#rt-new").value.trim(); if (!v) return; st.manual.push({ address: v }); persist(); draw() };
    const lb = view.querySelector("#rt-locate"); if (lb) lb.onclick = () => locate();
    if (!locating && S.some(needs)) setTimeout(locate, 0);
    const pb = view.querySelector("#rt-plan"); if (pb) pb.onclick = () => run().catch(e => { msg = String(e.message || e); draw() });
    const cb = view.querySelector("#rt-csv"); if (cb) cb.onclick = () => {
      const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`, L = [["lorry", "seq", "eta", "name", "address", "zip", "documents", "lat", "lng"].join(",")];
      plan.routes.forEach((r, i) => r.stops.forEach((s, k) => L.push([i + 1, k + 1, fmtT(r.eta[k]), s.name, s.address, postcodeOf(s.address), s.refs.join(" "), s.lat, s.lng].map(q).join(","))));
      dl(`invoicelens_routes_${new Date().toISOString().slice(0, 10)}.csv`, "﻿" + L.join("\n"), "text/csv");
    };
    const ab = view.querySelector("#rt-ai"); if (ab) ab.onclick = async () => {
      msg = t("rt_ai_wait"); draw();
      try { review = await askModel(planSummary()); msg = "" } catch (e) { msg = String(e.message || e) }
      draw();
    };
  };
  // look up every stop that has no location yet (results are cached, so this is quick the second time)
  // every stop without a location is looked up as soon as it appears. With a model configured, model A first rewrites all
  // pending addresses in one call into clean search text; the map service then finds the coordinates.
  const needs = s => !s.skip && ((s.lat == null && !s.fail) || (!!rewriteMany && !s.aiTried && (s.fail || s.approx)) || (!!placeLocate && !!brandFor(s) && !s.gTried && !precise(s)) || (!!locateMany && !!brandFor(s) && !s.webTried && !precise(s)));
  let locating = null;
  const locate = () => locating || (locating = locateAll(stops().filter(needs)).catch(e => { msg = String(e.message || e) }).finally(() => { locating = null; draw() }));
  const locateAll = async S => {
    let fatalMsg = ""; // an error that stopped the place lookup stays visible after the run
    if (!S.length) return;
    const show = m => { msg = m; const el = view.querySelector("#rt-msg"); if (el) el.textContent = m };
    // 1) the printed address goes to the map service first (cleaned by rules only, no model)
    let i = 0;
    for (const s of S) {
      show(t("rt_geo_prog", { i: ++i, n: S.length }));
      if (s.lat != null && !s.fail) continue; // already placed (later steps may still improve it)
      const g = parseLatLng(s.address) || await geocode(s.address, st.cc, null, []).catch(() => ({ fail: true }));
      const o = { ...(st.over[s.key] || {}) }; delete o.fail; delete o.approx; delete o.ai;
      st.over[s.key] = { ...o, ...g }; Object.assign(s, { fail: undefined, approx: undefined, ai: undefined }, g); persist();
    }
    // 2) only the stops the map could not place exactly: the model rewrites the address into cleaner search text, then the map is asked again
    if (rewriteMany) {
      const R = S.filter(s => !s.aiTried && !precise(s) && !parseLatLng(s.address));
      if (R.length) show(t("rt_ai_addr"));
      for (let k = 0; k < R.length; k += 25) {
        const chunk = R.slice(k, k + 25), r = await rewriteMany(chunk.map(s => s.address)).catch(() => []);
        for (const [j, s] of chunk.entries()) {
          const pre = Array.isArray(r[j]) ? r[j] : [];
          const g = await geocode(s.address, st.cc, null, pre).catch(() => ({ fail: true }));
          const o = { ...(st.over[s.key] || {}) }; delete o.fail; delete o.approx; delete o.ai;
          st.over[s.key] = { ...o, ...g, aiTried: true }; Object.assign(s, { fail: undefined, approx: undefined, ai: undefined }, g, { aiTried: true }); persist();
        }
      }
    }
    // optional: Google Places / SerpApi (the user's own API key) looks up every stop that is still not exact; accepted only after judgePlace() confirms it
    if (placeLocate) {
      const G = S.filter(s => brandFor(s) && !s.gTried && !precise(s) && !parseLatLng(s.address));
      for (const [k, s] of G.entries()) {
        show(t("rt_g_prog", { i: k + 1, n: G.length }));
        const res = await placeLocate(s.address, s.name, s.lat != null ? { lat: s.lat, lng: s.lng } : null, brandFor(s)).catch(e => ({ ok: false, reason: String(e?.message || e), fatal: true }));
        if (res.fatal) { fatalMsg = t("rt_g_err", { e: res.reason }); show(fatalMsg); for (const x of G.slice(k)) { st.over[x.key] = { ...(st.over[x.key] || {}), gTried: true }; Object.assign(x, { gTried: true }) } persist(); break }
        const patch = res.ok ? { lat: +res.lat, lng: +res.lng, label: [res.place, res.found_address].filter(Boolean).join(", "), approx: false, fail: undefined, web: true, rank: 30, webSrc: res.url || "", webConf: res.confidence === "high" ? "high" : "medium" } : { webWhy: "Google: " + res.reason };
        st.over[s.key] = { ...(st.over[s.key] || {}), ...patch, gTried: true }; Object.assign(s, patch, { gTried: true }); persist();
      }
    }
    // a model that can search the web finds the exact premises of every stop that is still only street / estate level (or not found);
    // its coordinates count only after verifyWebPos() confirms them
    if (locateMany) {
      const groups = new Map();
      for (const s of S.filter(s => brandFor(s) && !s.webTried && !precise(s) && !parseLatLng(s.address))) { const b = brandFor(s), k = b.mode + "|" + b.name; (groups.get(k) || groups.set(k, { b, list: [] }).get(k)).list.push(s) }
      for (const { b, list: W } of groups.values()) for (let k = 0; k < W.length; k += 5) {
        const chunk = W.slice(k, k + 5); show(t("rt_web_prog", { i: Math.min(k + 5, W.length), n: W.length }));
        const r = await locateMany(chunk.map(s => s.address), { mode: b.mode, name: b.name }).catch(() => null);
        for (const [j, s] of chunk.entries()) {
          const m = Array.isArray(r) ? (r.find(x => +x?.n === j + 1) || r[j]) : null, near = s.lat != null ? { lat: s.lat, lng: s.lng } : null;
          const v = r ? await verifyWebPos(s.address, m, near).catch(() => ({ ok: false, reason: "check failed" })) : { ok: false, reason: "no answer" };
          const patch = v.ok ? { lat: +m.lat, lng: +m.lng, label: v.label, approx: false, fail: undefined, web: true, rank: 30, webSrc: m.maps_url || "", webConf: v.confidence } : { webWhy: v.reason };
          st.over[s.key] = { ...(st.over[s.key] || {}), ...patch, webTried: true }; Object.assign(s, patch, { webTried: true }); persist();
        }
      }
    }
    msg = fatalMsg;
  };
  const locateStart = async () => {
    if (!st.start || st.startLL) return;
    const g = parseLatLng(st.start) || await geocode(st.start, st.cc, rewriteAddr).catch(() => ({ fail: true }));
    if (g.fail) msg = t("rt_start_fail"); else { st.startLL = { lat: g.lat, lng: g.lng }; persist() }
    draw();
  };
  const ok_ = k => plan.routes.flatMap(r => r.stops).find(x => x.key === k);
  const planSummary = () => ({
    start: st.start, lorries: st.lorries, depart: st.time, service_minutes: st.service, return_to_start: st.back, road_data: plan.source,
    routes: plan.routes.map((r, i) => ({ lorry: i + 1, km: +r.km.toFixed(1), hours: +(r.min / 60).toFixed(2), stops: r.stops.map((s, k) => ({ seq: k + 1, eta: fmtT(r.eta[k]), name: s.name, address: s.address, approx_location: !!s.approx, far_from_other_stops_km: plan.far.has(s.key) ? Math.round(plan.far.get(s.key)) : undefined })) })),
    not_placed: plan.unplaced.map(s => s.address),
  });
  const run = async () => {
    const S = stops().filter(s => !s.skip);
    if (!st.startLL) { msg = t("rt_geo_start"); draw(); const g = parseLatLng(st.start) || await geocode(st.start, st.cc, rewriteAddr); if (g.fail) throw new Error(t("rt_start_fail")); st.startLL = { lat: g.lat, lng: g.lng }; persist() }
    await locate();
    const ok = S.filter(s => s.lat != null && !s.fail), unplaced = S.filter(s => s.lat == null || s.fail);
    if (!ok.length) throw new Error(t("rt_no_coords"));
    msg = t("rt_matrix"); view.querySelector("#rt-msg").textContent = msg;
    const pts = [st.startLL, ...ok], M = await roadMatrix(pts);
    const [hh, mm] = st.time.split(":").map(Number), t0 = hh * 60 + (mm || 0);
    const routes = planRoutes(pts, M.dur, { lorries: st.lorries, back: st.back, maxStops: st.maxStops }).map(r => {
      const s = routeStats(r, M, st.back, st.service, t0), stopsR = r.map(x => pts[x]);
      return { stops: stopsR, ...s, links: mapsLinks(st.startLL, stopsR, st.back, brandFor) };
    });
    plan = { routes, unplaced, source: M.source, t0, km: routes.reduce((a, r) => a + r.km, 0), min: routes.reduce((a, r) => a + r.min, 0), far: new Map(farStops(ok).map(x => [x.p.key, x.km])) };
    review = null; msg = ""; draw();
  };
  draw();
}

export const ROUTE_REVIEW_PROMPT = `You review a delivery route plan that an optimiser already computed. Do NOT reorder stops or invent new routes or addresses.
Look for practical problems: stops that look far from the rest of their lorry, addresses whose location was only approximate, very unbalanced lorries, late finishing times, stops that were not placed, and anything a dispatcher should confirm.
Answer in the user's language ({lang}) as ONE JSON object: {"summary":"2-3 sentences","warnings":["..."],"suggestions":["..."]}. Raw JSON only.`;
