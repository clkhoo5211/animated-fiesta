const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, FIX } = require("./helpers");

const ADDR = "1780 (GF), JLN NUSARI BAYU 7/1 NUSARI BIZ, 71950 BDR SRI SENDAYAN NEGERI SEMBILAN";
const doc = () => ({ json: { document_type: "delivery_order", document_number: "A1", parties: [{ role: "ship_to", name: "1954 NS NUSARI BIZ (DD)", address: ADDR }], tables: [] } });
const SERP_OK = { local_results: [
  { title: "Kedai Lain", address: "Jalan Lain, 71950 Bandar Sri Sendayan", gps_coordinates: { latitude: 2.1, longitude: 101.1 }, place_id: "X1" },
  { title: "99 Speedmart 1954 (NS) Nusari Biz", address: "1780, Jalan Nusari Bayu 7/1, Nusari Biz, 71950 Bandar Sri Sendayan, Negeri Sembilan", gps_coordinates: { latitude: 2.66123, longitude: 101.87456 }, place_id: "ChIJZ4sV47npzTERz5ygmZw1CL0" },
] };

async function open(page) {
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
}

test("SerpApi: asked through the proxy (X-Target-Base) with the store name first, near the street position; accepted only after the postcode / words check", async ({ page, context }) => {
  const calls = [];
  await serve(context, { model: doc, geo: () => [{ lat: "2.6", lon: "101.8", place_rank: 26 }] });
  await context.route("https://proxy.test/**", async (route) => {
    const req = route.request(), u = new URL(req.url());
    calls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), target: req.headers()["x-target-base"] });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, body: JSON.stringify(SERP_OK) });
  });
  await preset(page, { extra: { serpapi_key: "s-key", serp_proxy: "https://proxy.test", locate_service: "serpapi" }, route: { brand: "99" } });
  await open(page);
  await expect(page.locator(".badge.ok")).toContainText("Located by web search", { timeout: 20000 });
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("/search.json");
  expect(calls[0].target).toBe("https://serpapi.com");
  expect(calls[0].q).toMatchObject({ engine: "google_maps", type: "search", q: "99 Speedmart 1954 (NS) Nusari Biz", api_key: "s-key", gl: "my", hl: "en" });
  expect(calls[0].q.ll).toMatch(/^@2\.6\d+,101\.8\d+,16z$/);
  await expect(page.locator("#view")).toContainText("99 Speedmart 1954 (NS) Nusari Biz, 1780, Jalan Nusari Bayu 7/1");
});

test("SerpApi without a proxy says so instead of calling serpapi.com from the page", async ({ page, context }) => {
  let direct = 0;
  await serve(context, { model: doc, geo: () => [{ lat: "2.6", lon: "101.8", place_rank: 26 }] });
  await context.route("https://serpapi.com/**", (route) => { direct++; return route.abort(); });
  await preset(page, { extra: { serpapi_key: "s-key", locate_service: "serpapi" }, route: { brand: "99" } });
  await open(page);
  await expect(page.locator("#rt-msg")).toContainText("proxy", { timeout: 20000 });
  expect(direct).toBe(0);
});

test("automatic order: Google Places first; when it finds nothing SerpApi answers", async ({ page, context }) => {
  const order = [];
  await serve(context, { model: doc, geo: () => [{ lat: "2.6", lon: "101.8", place_rank: 26 }] });
  await context.route("https://places.googleapis.com/**", (route) => { order.push("google"); return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ places: [] }) }); });
  await context.route("https://proxy.test/**", (route) => { order.push("serpapi"); return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(SERP_OK) }); });
  await preset(page, { extra: { google_key: "g", serpapi_key: "s", serp_proxy: "https://proxy.test", locate_service: "auto" }, route: { brand: "99" } });
  await open(page);
  await expect(page.locator(".badge.ok")).toContainText("Located by web search", { timeout: 20000 });
  expect(order[0]).toBe("google");
  expect(order).toContain("serpapi");
});

test("a SerpApi 'no results' answer is a miss, not an error that stops the batch", async ({ page, context }) => {
  await serve(context, { model: doc, geo: () => [{ lat: "2.6", lon: "101.8", place_rank: 26 }] });
  await context.route("https://proxy.test/**", (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "Google Maps hasn't returned any results for this query." }) }));
  await preset(page, { extra: { serpapi_key: "s", serp_proxy: "https://proxy.test", locate_service: "serpapi" }, route: { brand: "99" } });
  await open(page);
  await expect(page.locator("#view")).toContainText("Street / area only", { timeout: 20000 });
  await expect(page.locator("#rt-msg")).not.toContainText("stopped");
});

test("settings: 'Check SerpApi key' reads the free account endpoint through the proxy", async ({ page, context }) => {
  const seen = [];
  await serve(context);
  await context.route("https://proxy.test/**", (route) => { seen.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, body: JSON.stringify({ total_searches_left: 247 }) }); });
  await preset(page, { extra: { serpapi_key: "s", serp_proxy: "https://proxy.test" }, route: { brand: "99" } });
  await page.goto("/");
  await page.click("#open-settings");
  await page.click("#test-serp");
  await expect(page.locator("#test-serp-out")).toContainText("247 searches left");
  expect(seen).toEqual(["/account.json"]);
});
