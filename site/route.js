/* InvoiceLens — delivery route planner.
   Stops come from the scanned documents (delivery / ship-to / bill-to addresses), plus any added by hand.
   Addresses are geocoded (OpenStreetMap Nominatim, cached), road times come from OSRM when the stop count
   allows it (straight-line estimate otherwise), and the routes are computed here, deterministically:
   split between lorries by direction from the start, then nearest-neighbour + 2-opt + moves between lorries.
   The language model never computes the route; it only reviews the finished plan on request. */

const KEY = "invoicelens.route", GEO = "invoicelens.geo";
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} };
export const normAddr = s => String(s ?? "").toUpperCase().replace(/[\s,.]+/g, " ").trim();

/* ---------- stops from scanned documents ---------- */
const DELIVER = ["ship_to"], BILL = ["bill_to", "customer"];
const ADDR_COL = /address|alamat|地址|deliver(y)? to|ship.?to addr/i;
export function collectStops(docs) {
  const out = new Map();
  const add = (address, name, ref, src) => {
    const k = normAddr(address); if (k.length < 6) return;
    const s = out.get(k) || { key: k, address: String(address).replace(/\s*\n\s*/g, ", ").trim(), name: name || "", refs: [], src };
    if (ref && !s.refs.includes(ref)) s.refs.push(ref);
    if (!s.name && name) s.name = name;
    out.set(k, s);
  };
  for (const { file, result: r } of docs) {
    if (!r) continue;
    const ref = r.document_number || file;
    const parties = (r.parties || []).filter(p => p && p.address);
    // a document is delivered to its ship-to / delivery address; the billing address is used only when there is none
    const pick = parties.filter(p => DELIVER.includes(p.role));
    for (const p of (pick.length ? pick : parties.filter(p => BILL.includes(p.role)))) add(p.address, p.name, ref, pick.length ? "ship_to" : "bill_to");
    // registers / delivery lists with an address column: one stop per row
    for (const t of r.tables || []) {
      const cols = (t.columns || []).map(c => (typeof c === "string" ? c : c?.name) || "");
      const ai = cols.findIndex(c => ADDR_COL.test(c)); if (ai < 0) continue;
      const ni = cols.findIndex((c, i) => i !== ai && /name|customer|outlet|nama|客户|名称/i.test(c));
      for (const row of t.rows || []) if (Array.isArray(row) && row[ai]) add(row[ai], ni >= 0 ? row[ni] : "", ref, "table");
    }
  }
  return [...out.values()];
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
export function mapsLinks(start, stops, back) {
  // Google Maps takes up to 9 waypoints per link: long routes are split into consecutive legs
  const ll = p => `${p.lat},${p.lng}`, seq = [start, ...stops, ...(back ? [start] : [])], out = [];
  for (let i = 0; i < seq.length - 1; i += 10) {
    const part = seq.slice(i, i + 11); if (part.length < 2) break;
    const w = part.slice(1, -1).map(ll).join("|");
    out.push(`https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${ll(part[0])}&destination=${ll(part.at(-1))}${w ? "&waypoints=" + encodeURIComponent(w) : ""}`);
  }
  return out;
}

/* ---------- network: geocoding and road matrix ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastGeo = 0;
async function nominatim(q, cc) {
  const wait = 1100 - (Date.now() - lastGeo); if (wait > 0) await sleep(wait); lastGeo = Date.now();   // usage policy: max 1 request per second
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=0${cc ? "&countrycodes=" + encodeURIComponent(cc) : ""}&q=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: { "Accept-Language": "en" } }); if (!r.ok) throw new Error("geocoder HTTP " + r.status);
  const j = await r.json(); return j[0] ? { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name } : null;
}
// full address first; then from the postcode onwards (unit / lot numbers often confuse the geocoder)
export function geoQueries(addr) {
  const a = String(addr).replace(/\s*\n\s*/g, ", ").replace(/\s+/g, " ").trim(), qs = [a];
  const pc = a.match(/\b\d{5}\b.*$/); if (pc && pc[0] !== a) qs.push(pc[0]);
  const parts = a.split(",").map(s => s.trim()).filter(Boolean); if (parts.length > 2) qs.push(parts.slice(-2).join(", "));
  return [...new Set(qs)];
}
// rewrite (optional): the language model turns a messy printed address into clean search queries
// (abbreviations expanded, unit / floor / branch codes dropped). The coordinates always come from the map service, never from the model.
export async function geocode(addr, cc, rewrite) {
  const cache = load(GEO, {}), k = normAddr(addr) + "|" + (cc || "");
  if (cache[k] && !(rewrite && cache[k].approx)) return cache[k];
  let hit = null, approx = false, query = null;
  for (const [i, q] of geoQueries(addr).entries()) { hit = await nominatim(q, cc); if (hit) { approx = i > 0; break } }
  if ((!hit || approx) && rewrite) {
    const qs = await rewrite(addr).catch(() => []);
    for (const q of (Array.isArray(qs) ? qs : []).filter(x => typeof x === "string" && x.trim()).slice(0, 3)) {
      const h = await nominatim(q, cc); if (h) { hit = h; approx = false; query = q; break }
    }
  }
  const res = hit ? { lat: hit.lat, lng: hit.lng, approx, ...(query ? { ai: query } : {}) } : { fail: true };
  if (hit) { cache[k] = res; save(GEO, cache) }
  return res;
}
export const ADDRESS_PROMPT = `Rewrite this delivery address into search queries for a map geocoder (OpenStreetMap).
Expand abbreviations (e.g. JLN -> Jalan, TMN -> Taman, LRG -> Lorong, KG -> Kampung, BDR -> Bandar, PJU -> keep), drop unit, floor, lot-in-building, branch / store codes and notes in brackets such as (GF) or (DA), keep street number, street, area, postcode, city and state.
Give up to 3 queries, most specific first (the last one may be just "area, postcode city"). Do not invent anything that is not in the address.
Answer as ONE JSON object: {"queries":["...","..."]}. Raw JSON only.
ADDRESS:
`;
export async function roadMatrix(pts) {
  if (pts.length > 100) return estimateMatrix(pts);   // the public OSRM server answers up to ~100 points per table
  try {
    const u = `https://router.project-osrm.org/table/v1/driving/${pts.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";")}?annotations=duration,distance`;
    const r = await fetch(u); const j = await r.json();
    if (j.code !== "Ok" || !j.durations) throw new Error(j.code || "OSRM");
    const fix = (m, e) => m.map((row, i) => row.map((v, k) => v ?? e[i][k]));
    const est = estimateMatrix(pts);
    return { dist: fix(j.distances, est.dist), dur: fix(j.durations, est.dur), source: "osrm" };
  } catch { return estimateMatrix(pts) }
}

/* ---------- UI ---------- */
export function renderRoute(view, api) {
  const { t, esc, docs, askModel, rewriteAddr, dl } = api;
  const st = Object.assign({ start: "", startLL: null, lorries: 1, back: true, service: 10, time: "08:00", maxStops: 0, cc: "my", manual: [], over: {} }, load(KEY, {}));
  const persist = () => save(KEY, st);
  const stops = () => [...collectStops(docs()), ...st.manual.map(m => ({ key: normAddr(m.address), address: m.address, name: m.name || "", refs: [], src: "manual" }))]
    .map(s => ({ ...s, ...(st.over[s.key] || {}) }));
  let plan = null, msg = "", review = null;
  const fmtT = m => { const h = Math.floor(m / 60) % 24, mm = Math.round(m % 60); return `${String(h).padStart(2, "0")}:${String(mm === 60 ? 59 : mm).padStart(2, "0")}` };
  let editing = null;
  const mapLink = p => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  const status = s => s.lat != null && !s.fail ? (s.approx ? `<span class="badge warn">${t("rt_geo_approx")}</span>` : `<span class="badge ok" ${s.ai ? `title="${esc(s.ai)}"` : ""}>✓ ${t(s.ai ? "rt_st_ai" : "rt_st_ok")}</span>`) + ` <a class="sub" target="_blank" rel="noopener" href="${esc(mapLink(s))}">${t("rt_view")}</a>`
    : s.fail ? `<span class="badge bad">${t("rt_geo_fail")}</span>` : `<span class="badge" style="background:var(--soft);color:var(--mut)">${t("rt_st_pending")}</span>`;
  const draw = () => {
    const S = stops(), on = S.filter(s => !s.skip), need = !st.start ? t("rt_need_start") : !on.length ? t("rt_need_stops") : "";
    const fld = (id, label, attrs) => `<div class="f"><label for="${id}">${label}</label><input id="${id}" ${attrs}></div>`;
    let h = `<p class="sub" style="margin:0 0 4px">${t("rt_intro")}</p>
      <div class="sec"><h3>${t("rt_step1")}</h3><div class="box">
        <div class="f"><label for="rt-start">${t("rt_start")}</label><div style="display:flex;gap:8px"><input id="rt-start" style="flex:1" value="${esc(st.start)}" placeholder="${esc(t("rt_start_ph"))}"><button class="btn sm" id="rt-here" type="button">${t("rt_here")}</button></div></div>
        ${st.startLL ? `<p class="sub" style="margin:6px 0 0">${t("rt_start_ok")} <a target="_blank" rel="noopener" href="${esc(mapLink(st.startLL))}">${st.startLL.lat.toFixed(5)}, ${st.startLL.lng.toFixed(5)}</a></p>` : ""}
        <div class="row">${fld("rt-time", t("rt_time"), `type="time" value="${esc(st.time)}"`)}<div class="f"><label>&nbsp;</label><label class="chk" style="margin:0"><input type="checkbox" id="rt-back" ${st.back ? "checked" : ""}> ${t("rt_back")}</label></div></div>
      </div></div>
      <div class="sec"><h3>${t("rt_step2")}</h3><div class="box">
        <div class="row">${fld("rt-lorries", t("rt_lorries"), `type="number" min="1" max="50" value="${st.lorries}"`)}${fld("rt-service", t("rt_service"), `type="number" min="0" max="240" value="${st.service}"`)}</div>
        <div class="row">${fld("rt-max", t("rt_maxstops"), `type="number" min="0" value="${st.maxStops}"`)}${fld("rt-cc", t("rt_cc"), `value="${esc(st.cc)}" maxlength="20"`)}</div>
      </div></div>
      <div class="sec"><h3>${t("rt_step3", { n: on.length, m: S.length })}</h3>
        <p class="sub" style="margin:0 0 8px">${t("rt_how")}</p>`;
    if (!S.length) h += `<div class="box"><p class="sub" style="margin:0">${t("rt_none")}</p></div>`;
    else h += `<div style="overflow:auto"><table><thead><tr><th style="width:28px"></th><th>${t("rt_addr")}</th><th>${t("rt_refs")}</th><th>${t("rt_coord")}</th></tr></thead><tbody>${S.map((s, i) => `<tr${s.skip ? ' style="opacity:.5"' : ""}>
      <td><input type="checkbox" data-skip="${i}" ${s.skip ? "" : "checked"} aria-label="${esc(t("rt_use"))}"></td>
      <td>${s.name ? `<b>${esc(s.name)}</b><br>` : ""}<span class="sub">${esc(s.address)}</span></td><td class="sub">${esc(s.refs.join(", ")) || "—"}</td>
      <td style="min-width:200px">${status(s)} <button class="btn sm" data-edit="${i}" type="button">${t("rt_edit")}</button>
        ${editing === s.key ? `<div class="f" style="margin-top:6px"><input data-ll="${i}" value="${s.lat != null ? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}` : ""}" placeholder="${esc(t("rt_ll_ph"))}"><span class="sub">${t("rt_ll_help")}</span></div>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
    h += `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" class="f"><input id="rt-new" style="flex:1;min-width:14em;width:auto" placeholder="${esc(t("rt_add_ph"))}"><button class="btn sm" id="rt-add" type="button">${t("rt_add")}</button>${S.length ? `<button class="btn sm" id="rt-locate" type="button">${t("rt_locate")}</button>` : ""}</div></div>`;
    h += `<div class="sec"><h3>${t("rt_step4")}</h3><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn pri" id="rt-plan" ${need ? "disabled" : ""}>${t("rt_plan")}</button>${plan ? `<button class="btn sm" id="rt-csv">${t("rt_csv")}</button>${askModel ? `<button class="btn sm" id="rt-ai">${t("rt_ai")}</button>` : ""}` : ""}<span class="sub" id="rt-msg">${esc(msg || need)}</span></div></div>`;
    if (plan) {
      h += `<div class="sec"><h3>${t("rt_result", { k: plan.routes.length, km: plan.km.toFixed(1), h: (plan.min / 60).toFixed(1) })}</h3><p class="sub" style="margin:0 0 8px">${t(plan.source === "osrm" ? "rt_src_osrm" : "rt_src_est")}${plan.unplaced.length ? " · " + t("rt_unplaced", { n: plan.unplaced.length }) : ""}</p>`;
      plan.routes.forEach((r, i) => {
        h += `<div class="box" style="margin:8px 0"><h4>${t("rt_lorry", { i: i + 1, n: r.stops.length, km: r.km.toFixed(1), h: (r.min / 60).toFixed(1), end: fmtT(plan.t0 + r.min) })}</h4><ol style="margin:4px 0 8px 18px;padding:0">${r.stops.map((s, k) => `<li><b>${fmtT(r.eta[k])}</b> · ${esc(s.name ? s.name + " — " : "")}${esc(s.address)}${s.refs.length ? ` <span class="sub">(${esc(s.refs.join(", "))})</span>` : ""}</li>`).join("")}</ol>${r.links.map((u, k) => `<a class="btn sm" target="_blank" rel="noopener" href="${esc(u)}">${t("rt_nav", { k: k + 1, n: r.links.length })}</a> `).join("")}</div>`;
      });
      if (plan.unplaced.length) h += `<p class="sub">${t("rt_unplaced_d")}: ${plan.unplaced.map(s => esc(s.address)).join(" · ")}</p>`;
      h += `</div>`;
    }
    if (review) h += `<div class="sec"><h3>${t("rt_ai_h")}</h3><div class="box">${review.summary ? `<p>${esc(review.summary)}</p>` : ""}${(review.warnings || []).map(w => `<p>⚠ ${esc(w)}</p>`).join("")}${(review.suggestions || []).map(w => `<p>→ ${esc(w)}</p>`).join("")}<p class="sub">${t("rt_ai_note")}</p></div></div>`;
    h += `<p class="sub" style="margin-top:16px">${t("rt_privacy")}</p>`;
    view.innerHTML = h;
    const num = (id, d) => { const v = parseInt(view.querySelector(id).value); return Number.isFinite(v) ? v : d };
    const sync = () => { st.start = view.querySelector("#rt-start").value.trim(); st.lorries = Math.max(1, num("#rt-lorries", 1)); st.time = view.querySelector("#rt-time").value || "08:00"; st.service = Math.max(0, num("#rt-service", 10)); st.maxStops = Math.max(0, num("#rt-max", 0)); st.cc = view.querySelector("#rt-cc").value.trim(); st.back = view.querySelector("#rt-back").checked; persist() };
    view.querySelectorAll("input[id^=rt-]:not(#rt-new)").forEach(el => el.onchange = () => { const had = st.start; sync(); if (had !== st.start) st.startLL = null, persist(); draw() });
    view.querySelector("#rt-here").onclick = () => {
      if (!navigator.geolocation) { msg = t("rt_here_fail"); return draw() }
      navigator.geolocation.getCurrentPosition(p => { st.startLL = { lat: p.coords.latitude, lng: p.coords.longitude }; st.start = `${st.startLL.lat.toFixed(5)}, ${st.startLL.lng.toFixed(5)}`; persist(); msg = ""; draw() }, () => { msg = t("rt_here_fail"); draw() }, { timeout: 15000 });
    };
    view.querySelectorAll("[data-skip]").forEach(el => el.onchange = () => { const s = S[+el.dataset.skip]; st.over[s.key] = { ...(st.over[s.key] || {}), skip: !el.checked }; persist(); draw() });
    view.querySelectorAll("[data-edit]").forEach(el => el.onclick = () => { const k = S[+el.dataset.edit].key; editing = editing === k ? null : k; draw(); view.querySelector("[data-ll]")?.focus() });
    view.querySelectorAll("[data-ll]").forEach(el => el.onchange = () => { const s = S[+el.dataset.ll], ll = parseLatLng(el.value); const o = { ...(st.over[s.key] || {}) }; delete o.fail; delete o.approx; if (ll) Object.assign(o, ll); else { delete o.lat; delete o.lng } st.over[s.key] = o; editing = null; persist(); draw() });
    view.querySelector("#rt-add").onclick = () => { const v = view.querySelector("#rt-new").value.trim(); if (!v) return; st.manual.push({ address: v }); persist(); draw() };
    const lb = view.querySelector("#rt-locate"); if (lb) lb.onclick = () => locateAll(stops().filter(s => !s.skip)).then(() => { msg = ""; draw() }).catch(e => { msg = String(e.message || e); draw() });
    const pb = view.querySelector("#rt-plan"); if (pb) pb.onclick = () => run().catch(e => { msg = String(e.message || e); draw() });
    const cb = view.querySelector("#rt-csv"); if (cb) cb.onclick = () => {
      const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`, L = [["lorry", "seq", "eta", "name", "address", "documents", "lat", "lng"].join(",")];
      plan.routes.forEach((r, i) => r.stops.forEach((s, k) => L.push([i + 1, k + 1, fmtT(r.eta[k]), s.name, s.address, s.refs.join(" "), s.lat, s.lng].map(q).join(","))));
      dl(`invoicelens_routes_${new Date().toISOString().slice(0, 10)}.csv`, "﻿" + L.join("\n"), "text/csv");
    };
    const ab = view.querySelector("#rt-ai"); if (ab) ab.onclick = async () => {
      msg = t("rt_ai_wait"); draw();
      try { review = await askModel(planSummary()); msg = "" } catch (e) { msg = String(e.message || e) }
      draw();
    };
  };
  // look up every stop that has no location yet (results are cached, so this is quick the second time)
  const locateAll = async S => {
    let i = 0;
    for (const s of S) {
      i++; if ((s.lat != null && !(rewriteAddr && s.approx && !s.aiTried)) || (s.fail && !(rewriteAddr && !s.aiTried))) continue;
      msg = t("rt_geo_prog", { i, n: S.length }); const m = view.querySelector("#rt-msg"); if (m) m.textContent = msg;
      const g = parseLatLng(s.address) || await geocode(s.address, st.cc, rewriteAddr).catch(() => ({ fail: true }));
      const o = { ...(st.over[s.key] || {}) }; delete o.fail; delete o.approx; delete o.ai;
      st.over[s.key] = { ...o, ...g, ...(rewriteAddr ? { aiTried: true } : {}) }; Object.assign(s, { fail: undefined, approx: undefined, ai: undefined }, g); persist();
    }
  };
  const planSummary = () => ({
    start: st.start, lorries: st.lorries, depart: st.time, service_minutes: st.service, return_to_start: st.back, road_data: plan.source,
    routes: plan.routes.map((r, i) => ({ lorry: i + 1, km: +r.km.toFixed(1), hours: +(r.min / 60).toFixed(2), stops: r.stops.map((s, k) => ({ seq: k + 1, eta: fmtT(r.eta[k]), name: s.name, address: s.address, approx_location: !!s.approx })) })),
    not_placed: plan.unplaced.map(s => s.address),
  });
  const run = async () => {
    const S = stops().filter(s => !s.skip);
    if (!st.startLL) { msg = t("rt_geo_start"); draw(); const g = parseLatLng(st.start) || await geocode(st.start, st.cc, rewriteAddr); if (g.fail) throw new Error(t("rt_start_fail")); st.startLL = { lat: g.lat, lng: g.lng }; persist() }
    await locateAll(S);
    const ok = S.filter(s => s.lat != null && !s.fail), unplaced = S.filter(s => s.lat == null || s.fail);
    if (!ok.length) throw new Error(t("rt_no_coords"));
    msg = t("rt_matrix"); view.querySelector("#rt-msg").textContent = msg;
    const pts = [st.startLL, ...ok], M = await roadMatrix(pts);
    const [hh, mm] = st.time.split(":").map(Number), t0 = hh * 60 + (mm || 0);
    const routes = planRoutes(pts, M.dur, { lorries: st.lorries, back: st.back, maxStops: st.maxStops }).map(r => {
      const s = routeStats(r, M, st.back, st.service, t0), stopsR = r.map(x => pts[x]);
      return { stops: stopsR, ...s, links: mapsLinks(st.startLL, stopsR, st.back) };
    });
    plan = { routes, unplaced, source: M.source, t0, km: routes.reduce((a, r) => a + r.km, 0), min: routes.reduce((a, r) => a + r.min, 0) };
    review = null; msg = ""; draw();
  };
  draw();
}

export const ROUTE_REVIEW_PROMPT = `You review a delivery route plan that an optimiser already computed. Do NOT reorder stops or invent new routes or addresses.
Look for practical problems: stops that look far from the rest of their lorry, addresses whose location was only approximate, very unbalanced lorries, late finishing times, stops that were not placed, and anything a dispatcher should confirm.
Answer in the user's language ({lang}) as ONE JSON object: {"summary":"2-3 sentences","warnings":["..."],"suggestions":["..."]}. Raw JSON only.`;
