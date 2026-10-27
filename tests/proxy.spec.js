const { test, expect } = require("@playwright/test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

test("CORS proxy forwards the query string (SerpApi style GET) and the path, and refuses unknown origins and private targets", () => {
  const r = JSON.parse(spawnSync("node", ["--input-type=module", "-e", `
    import worker from "./proxy/worker.js";
    const seen = [];
    globalThis.fetch = async (url, init) => { seen.push({ url: String(url), method: init.method }); return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }) };
    const env = { ALLOWED_ORIGINS: "https://site.test", ALLOWED_TARGET_HOSTS: "serpapi.com,api.deepseek.com" };
    const call = (url, headers, method = "GET") => worker.fetch(new Request(url, { method, headers }), env);
    const ok = await call("https://proxy.test/search.json?engine=google_maps&q=a%20b&api_key=K", { Origin: "https://site.test", "X-Target-Base": "https://serpapi.com" });
    const badOrigin = await call("https://proxy.test/search.json", { Origin: "https://evil.test", "X-Target-Base": "https://serpapi.com" });
    const badHost = await call("https://proxy.test/x", { Origin: "https://site.test", "X-Target-Base": "https://example.com" });
    const priv = await call("https://proxy.test/x", { Origin: "https://site.test", "X-Target-Base": "https://localhost" });
    console.log(JSON.stringify({ ok: ok.status, cors: ok.headers.get("Access-Control-Allow-Origin"), seen, badOrigin: badOrigin.status, badHost: badHost.status, priv: priv.status }));
  `], { cwd: ROOT, encoding: "utf8", timeout: 60000 }).stdout);
  expect(r.ok).toBe(200);
  expect(r.cors).toBe("https://site.test");
  expect(r.seen[0].url).toBe("https://serpapi.com/search.json?engine=google_maps&q=a%20b&api_key=K");
  expect(r.badOrigin).toBe(403);
  expect(r.badHost).toBe(403);
  expect(r.priv).toBe(400);
});

test("tools/serpapi-locate.mjs: store name first, ll bias, place id link, a wrong place and a no-results answer are misses", () => {
  const r = JSON.parse(spawnSync("node", ["--input-type=module", "-e", `
    import * as m from "./tools/serpapi-locate.mjs";
    const urls = [];
    const answer = (u) => {
      const q = u.searchParams.get("q");
      if (q.startsWith("99 Speedmart 1954")) return { local_results: [
        { title: "Kedai Lain", address: "Jalan Lain, 71950 Bandar Sri Sendayan", gps_coordinates: { latitude: 2.1, longitude: 101.1 }, place_id: "X1" },
        { title: "99 Speedmart 1954 (NS) Nusari Biz", address: "1780, Jalan Nusari Bayu 7/1, Nusari Biz, 71950 Bandar Sri Sendayan", gps_coordinates: { latitude: 2.66123, longitude: 101.87456 }, place_id: "ChIJabc" } ] };
      return { error: "Google Maps hasn't returned any results for this query." };
    };
    const fetchImpl = async (url) => { const u = new URL(url); urls.push({ q: u.searchParams.get("q"), ll: u.searchParams.get("ll"), engine: u.searchParams.get("engine"), key: u.searchParams.get("api_key") }); return new Response(JSON.stringify(answer(u)), { status: 200 }) };
    const rows = await m.locateWithSerp([
      { key: "k1", name: "1954 NS NUSARI BIZ (DD)", address: "1780 (GF), JLN NUSARI BAYU 7/1 NUSARI BIZ, 71950 BDR SRI SENDAYAN", near: { lat: 2.66, lng: 101.87 } },
      { key: "k2", name: "", address: "NO 5, JLN ZZZ 1, 71900 LABU" },
    ], { key: "KEY", delay: 0, fetchImpl, cacheFile: null });
    console.log(JSON.stringify({ rows, urls, cands: m.serpCandidates({ place_results: { title: "A", address: "B", gps_coordinates: { latitude: 1, longitude: 2 } } }) }));`], { cwd: ROOT, encoding: "utf8", timeout: 60000 }).stdout);
  expect(r.rows[0]).toMatchObject({ key: "k1", ok: true, confidence: "high", lat: 2.66123, lng: 101.87456, url: "https://www.google.com/maps/place/?q=place_id:ChIJabc" });
  expect(r.rows[1].ok).toBe(false);
  expect(r.urls[0]).toMatchObject({ q: "99 Speedmart 1954 (NS) Nusari Biz", ll: "@2.66000,101.87000,16z", engine: "google_maps", key: "KEY" });
  expect(r.cands[0]).toMatchObject({ name: "A", lat: 1, lng: 2 });
});

test("tools/overture-bench.mjs: keeps Speed Mart places, matches them to an address by postcode + Speed Mart + street words, reads both GeoJSON layouts", ({}, testInfo) => {
  const fs = require("node:fs");
  const dir = testInfo.outputPath("overture"); fs.mkdirSync(dir, { recursive: true });
  const feat = (name, freeform, postcode, lng, lat, extra = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { id: name, names: { primary: name }, addresses: [{ freeform, locality: "Bandar Sri Sendayan", postcode }], ...extra } });
  const feats = [
    feat("99 Speedmart 1954 (NS) Nusari Biz", "1780, Jalan Nusari Bayu 7/1, Nusari Biz", "71950", 101.87456, 2.66123),
    feat("Restoran Nusari", "Jalan Nusari Bayu 7/2", "71950", 101.8, 2.6),
    feat("99 Speedmart 2445 (NS) Pusat Dagangan Sendayan", "Jalan Pusat Dagangan Sendayan 3/3", "71950", 101.86, 2.68),
    feat("Kedai Runcit", "Jalan Lain", "71950", 101.9, 2.7, { brand: { names: { primary: "99 Speedmart" } } }),
  ];
  fs.writeFileSync(`${dir}/places.geojson`, JSON.stringify({ type: "FeatureCollection", features: feats }));
  fs.writeFileSync(`${dir}/places.geojsonseq`, feats.map((f) => "\u001e" + JSON.stringify(f)).join("\n"));
  fs.writeFileSync(`${dir}/addr.json`, JSON.stringify(["1954 NS NUSARI BIZ (DD) 1780 (GF), JLN NUSARI BAYU 7/1 NUSARI BIZ, 71950 BDR SRI SENDAYAN NEGERI SEMBILAN", "NO 9, JLN ZZZ 1, 71900 LABU"]));
  for (const file of ["places.geojson", "places.geojsonseq"]) {
    const res = spawnSync("node", [path.join(ROOT, "tools/overture-bench.mjs"), `${dir}/${file}`, `${dir}/addr.json`], { cwd: dir, encoding: "utf8", timeout: 60000 }).stdout;
    expect(res).toContain("3 Speed Mart places");               // the restaurant is dropped, the brand-only record is kept
    expect(res).toContain("ACCEPTED high: 99 Speedmart 1954 (NS) Nusari Biz");
    expect(res).toContain("- addresses with a place that passes the app's check: 1 / 2");
  }
  expect(JSON.parse(fs.readFileSync(`${dir}/speedmart-places.json`, "utf8"))).toHaveLength(3);
});

test("sharedPin: two different addresses on one pin are both doubtful; the same address twice, typed pins and different pins are not", () => {
  const r = JSON.parse(spawnSync("node", ["--input-type=module", "-e", `
    import { sharedPin } from "./site/route.js";
    const a = { key: "a", address: "1 JLN A, 71900 LABU", lat: 2.75343, lng: 101.82281 };
    const b = { key: "b", address: "2 JLN B, 71900 LABU", lat: 2.753431, lng: 101.822809 };
    const c = { key: "c", address: "3 JLN C, 71010 PD", lat: 2.5, lng: 101.8 };
    const d = { key: "d", address: "1 jln a, 71900 labu", lat: 2.75343, lng: 101.82281 };
    const m = { key: "m", address: "2 JLN B, 71900 LABU", lat: 2.75343, lng: 101.82281, manual: true };
    console.log(JSON.stringify({ ab: [sharedPin([a, b, c], a), sharedPin([a, b, c], b)], c: sharedPin([a, b, c], c), dup: sharedPin([a, d], a), typed: [sharedPin([a, m], a), sharedPin([a, m], m)] }));
  `], { cwd: ROOT, encoding: "utf8" }).stdout);
  expect(r).toEqual({ ab: [true, true], c: false, dup: false, typed: [false, false] });
});

test("judgePlace: a different unit number is a different shop even when street and postcode agree (Overture gave Taman Indah Jaya's shop for Bandar Dataran Segar)", () => {
  const r = JSON.parse(spawnSync("node", ["--input-type=module", "-e", `
    import { judgePlace, lotNumbers, brandRegex, brandOf } from "./site/route.js";
    const re = brandRegex(brandOf("99")), want = "NS BANDAR DATARAN SEGAR (DD) NO. 31 (GF), Jln DS 1/1, BANDAR DATARAN SEGAR, 71010 PORT DICKSON";
    const other = { name: "99 Speedmart", address: "No: 8 & 9 (GF, Jalan Seremban, Port Dickson, 71010", lat: 2.57, lng: 101.83 };
    const same = { name: "99 Speedmart", address: "No: 31 (GF), Jalan DS 1/1, Bandar Dataran Segar, Port Dickson, 71010", lat: 2.56, lng: 101.81 };
    const nolot = { name: "99 Speedmart", address: "Jalan DS 1/1, Bandar Dataran Segar, 71010 Port Dickson", lat: 2.56, lng: 101.81 };
    console.log(JSON.stringify({ lots: [...lotNumbers("NO: 20-G & 21-G (GROUND FLOOR)")], other: judgePlace(want, other, re, true).ok, same: judgePlace(want, same, re, true).ok, nolot: judgePlace(want, nolot, re, true).ok }));
  `], { cwd: ROOT, encoding: "utf8" }).stdout);
  expect(r).toEqual({ lots: ["20", "21"], other: false, same: true, nolot: true });
});

test("judgePlace: the store number in the listing name settles it (equal accepts, different rejects); PT lots count; placeRank puts the store-number match first", () => {
  const r = JSON.parse(spawnSync("node", ["--input-type=module", "-e", `
    import { judgePlace, placeRank, storeNoOf, lotNumbers, brandRegex, brandOf } from "./site/route.js";
    const re = brandRegex(brandOf("99")), want = "1577 NS TANAH MERAH (DD) PT 1075 & PT 1076, JLN MELUR 1, TMN JIMAH JAYA, TANAH MERAH, SITE C, 71960 PORT DICKSON";
    const right = { name: "99 Speedmart 1577 Tanah Merah", address: "PT 1075 & PT 1976 (Ground Floor), Jalan Melur 1 Taman Jimah Jaya, Jimah, 71960", lat: 2.6, lng: 101.8 };
    const other = { name: "99 Speedmart", address: "No: 23 & 24, Jalan Bayan Indah 1, Taman Bayan Indah, Jimah, 71960", lat: 2.64, lng: 101.74 };
    const wrongNo = { name: "99 Speedmart 1578 Jimah", address: "Jalan Melur 1, Jimah, 71960", lat: 2.6, lng: 101.8 };
    const a = judgePlace(want, right, re, true), b = judgePlace(want, other, re, true), c = judgePlace(want, wrongNo, re, true);
    console.log(JSON.stringify({ no: [storeNoOf(want), storeNoOf("NS X (DD) 3420 NS Y (DD)"), storeNoOf("NS X (DD) NO 5")], lots: [...lotNumbers("PT 1075 & PT 1076")], right: [a.ok, placeRank(a)], other: b.ok, wrongNo: c.ok }));
  `], { cwd: ROOT, encoding: "utf8" }).stdout);
  expect(r).toEqual({ no: ["1577", "3420", ""], lots: ["1075", "1076"], right: [true, 0], other: false, wrongNo: false });
});

test("judgePlace: UU Speedmart is not 99 Speedmart; a unit before '(GF)' counts (Nusari Biz 1780 vs 186, Springhill 2 43A vs 8 & 9)", () => {
  const r = JSON.parse(spawnSync("node", ["--input-type=module", "-e", `
    import { judgePlace, lotNumbers, brandRegex, brandOf } from "./site/route.js";
    const re = brandRegex(brandOf("99"));
    const uu = { name: "UU Speedmart", address: "Jalan Waterfront 5, Port Dickson, 71000", lat: 2.52, lng: 101.8 };
    const nine = { name: "99 Speedmart", address: "Jalan Waterfront 5, Port Dickson, 71000", lat: 2.52, lng: 101.8 };
    const w = "1687 NS TMN RIA (DD) NO: 5 & 6 (G), BT 2 1/2 JLN SEREMBAN, TMN RIA 71000 PORT DICKSON";
    const nus = "1954 NS NUSARI BIZ (DD) 1780 (GF), JLN NUSARI BAYU 7/1 NUSARI BIZ, 71950 BDR SRI SENDAYAN";
    const other = { name: "99 Speedmart", address: "Ground floor, No: 186, Jalan Pusat Dagangan Sendayan 3/3, Labu, 71950", lat: 2.68, lng: 101.86 };
    console.log(JSON.stringify({ lots: [[...lotNumbers("1954 NS NUSARI BIZ (DD) 1780 (GF), JLN X")], [...lotNumbers("NS SPRINGHILL 2 (DD) 43A (GF), JLN")]], uu: judgePlace(w, uu, re, true).ok, nine: judgePlace(w, nine, re, true).ok, nus: judgePlace(nus, other, re, true).ok }));
  `], { cwd: ROOT, encoding: "utf8" }).stdout);
  expect(r).toEqual({ lots: [["1780"], ["43"]], uu: false, nine: true, nus: false });
});

test("roadMatrix: 123 points are asked from the public OSRM server in blocks of at most 100 points and assembled; over 300 points no request is made", () => {
  const r = JSON.parse(spawnSync("node", ["--input-type=module", "-e", `
    import { roadMatrix } from "./site/route.js";
    const calls = [];
    globalThis.fetch = async url => {
      const u = new URL(String(url)), n = u.pathname.split("/").pop().split(";").length;
      const sc = (u.searchParams.get("sources") || "").split(";").filter(Boolean).length || n, dc = (u.searchParams.get("destinations") || "").split(";").filter(Boolean).length || n;
      calls.push(n);
      const m = v => Array.from({ length: sc }, () => Array.from({ length: dc }, () => v));
      return new Response(JSON.stringify({ code: "Ok", durations: m(60), distances: m(1000) }));
    };
    const pts = n => Array.from({ length: n }, (_, i) => ({ lat: 1.4 + i * 0.001, lng: 103.6 + i * 0.001 }));
    const M = await roadMatrix(pts(123)), n1 = calls.length, big = await roadMatrix(pts(301));
    console.log(JSON.stringify({ source: M.source, calls: n1, maxPoints: Math.max(...calls), size: [M.dur.length, M.dur[0].length], cell: M.dur[0][122], far: big.source, after: calls.length }));
  `], { cwd: ROOT, encoding: "utf8" }).stdout);
  expect(r).toEqual({ source: "osrm", calls: 9, maxPoints: 100, size: [123, 123], cell: 60, far: "estimate", after: 9 });
});

test("fullAddr (view on map, route waypoints): abbreviations are spelled out and a lone leading number becomes 'No.' (Google read '6, JLN KEBUDAYAAN 21' as house 21 of street 6)", () => {
  const r = JSON.parse(spawnSync("node", ["--input-type=module", "-e", `
    import { fullAddr } from "./site/route.js";
    console.log(JSON.stringify([fullAddr("6, JLN KEBUDAYAAN 21, TMN UNIVERSITI, 81300 SKUDAI, JOHOR"), fullAddr("1988\\nNS TMN GADONG INDAH (DD)\\nNO 1, JLN GADONG INDAH 3\\n71900 LABU"), fullAddr("12-A, LRG ABC 3, KG BARU, 81300 SKUDAI, Malaysia")]));
  `], { cwd: ROOT, encoding: "utf8" }).stdout);
  expect(r).toEqual(["No. 6, Jalan KEBUDAYAAN 21, Taman UNIVERSITI, 81300 SKUDAI, JOHOR, Malaysia", "1988, NS Taman GADONG INDAH (DD), NO 1, Jalan GADONG INDAH 3, 71900 LABU, Malaysia", "No. 12-A, Lorong ABC 3, Kampung BARU, 81300 SKUDAI, Malaysia"]);
});

test("selfQuery: an invoice billed to the place it is delivered to is sent to Google with the customer's name (waypoints, view on map); a head-office billing address is not", () => {
  const r = JSON.parse(spawnSync("node", ["--input-type=module", "-e", `
    import { collectStops, mapsLinks, selfQuery } from "./site/route.js";
    const A = "6, JLN KEBUDAYAAN 21, TMN UNIVERSITI, 81300 SKUDAI, JOHOR";
    const mk = (billAddr, name) => ({ file: "f", result: { document_number: "D1", parties: [{ role: "bill_to", name, address: billAddr }, { role: "ship_to", name: null, address: A }] } });
    const same = collectStops([mk(A, "ATC JAYA SDN BHD")])[0], hq = collectStops([mk("LOT 2811, JALAN ANGSA, 41150 KLANG, SELANGOR", "ABC HQ SDN BHD")])[0];
    const link = decodeURIComponent(mapsLinks({ lat: 1.5, lng: 103.7 }, [{ ...same, lat: 1.55, lng: 103.6 }], false, () => null)[0]);
    console.log(JSON.stringify({ same: selfQuery(same), hq: selfQuery(hq), link: link.split("destination=")[1] }));
  `], { cwd: ROOT, encoding: "utf8" }).stdout);
  expect(r.same).toBe("ATC JAYA SDN BHD, No. 6, Jalan KEBUDAYAAN 21, Taman UNIVERSITI, 81300 SKUDAI, JOHOR, Malaysia");
  expect(r.hq).toBe("");
  expect(r.link).toBe(r.same);
});
