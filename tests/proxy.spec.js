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
