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
