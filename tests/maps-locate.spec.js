const { test, expect } = require("@playwright/test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { serve, preset, waitIdle, FIX } = require("./helpers");

const ROOT = path.resolve(__dirname, "..");
const node = (code) => JSON.parse(spawnSync("node", ["--input-type=module", "-e", code], { cwd: ROOT, encoding: "utf8", timeout: 120000 }).stdout);

test("maps-locate helpers: pin from URL (never the map view), postcode and word check", () => {
  const r = node(`
    import * as m from "./tools/maps-locate.mjs";
    const wanted = "NS SENDAYAN METROPARK (DD) NO: 27 (G), PERSIARAN METRO SENDAYAN 1, 71950 BDR SRI SENDAYAN, N. SEMBILAN";
    console.log(JSON.stringify({
      pin: m.pinFromUrl("https://www.google.com/maps/place/X/@2.7,101.9,17z/data=!4m6!3m5!1s0x0!8m2!3d2.686781!4d101.846841"),
      view: m.pinFromUrl("https://www.google.com/maps/search/foo/@2.7,101.9,17z"),
      abroad: m.pinFromUrl("data=!3d51.5!4d-0.1"),
      high: m.judge(wanted, { name: "99 Speed Mart", address: "27, Persiaran Metro Sendayan 1, 71950 Bandar Sri Sendayan, Negeri Sembilan", lat: 2.68, lng: 101.84 }),
      pc: m.judge(wanted, { name: "99 Speed Mart", address: "1 Jalan X, 71900 Labu", lat: 2.6, lng: 101.8 }),
      other: m.judge(wanted, { name: "Restoran Abc", address: "Jalan Lain, 71950 Bandar Sri Sendayan", lat: 2.6, lng: 101.8 }),
      brand: m.brandQuery(wanted),
    }));`);
  expect(r.pin).toEqual({ lat: 2.686781, lng: 101.846841 });
  expect(r.view).toBeNull();
  expect(r.abroad).toBeNull();
  expect(r.high).toMatchObject({ ok: true, confidence: "high" });
  expect(r.pc.ok).toBe(false);
  expect(r.pc.reason).toContain("postcode");
  expect(r.other.ok).toBe(false);
  expect(r.brand).toContain("99 Speed Mart");
});

test("maps-locate drives a (mocked) Google Maps: a place page is read, a different place is refused", async () => {
  const r = node(`
    import * as m from "./tools/maps-locate.mjs";
    // the page "turns into" a place page (as Google's single-result search does) by rewriting its own URL
    const placeHtml = (name, addr) => '<html><body><h1>' + name + '</h1><button data-item-id="address" aria-label="Address: ' + addr + '">x</button><script>history.replaceState({}, "", "/maps/place/Shop/@2.6,101.8,17z/data=!3d2.61!4d101.81")</script></body></html>';
    const rows = await m.locateAddresses([
      "NS A (DD) NO 1, JALAN SENDAYAN INDAH 1, TAMAN SENDAYAN INDAH, 71900 LABU",
      "NS B (DD) NO 2, JALAN LAIN 1, 71900 LABU",
    ], { delay: 0, hook: async (page) => {
      await page.route("https://www.google.com/**", async (route) => {
        const q = new URL(route.request().url()).searchParams.get("query") || "";
        return route.fulfill({ status: 200, contentType: "text/html", body: q.includes("LAIN") ? placeHtml("Restoran Abc", "Jalan Seberang, 71900 Labu") : placeHtml("99 Speed Mart", "1, Jalan Sendayan Indah 1, Taman Sendayan Indah, 71900 Labu, Negeri Sembilan") });
      });
    } });
    console.log(JSON.stringify(rows));`);
  expect(r[0]).toMatchObject({ ok: true, confidence: "high", lat: 2.61, lng: 101.81 });
  expect(r[1].ok).toBe(false);
});

test("route tab: export the stops to check, import coordinates found by the local helper", async ({ page, context }) => {
  await serve(context, {
    model: () => ({ json: { document_type: "delivery_order", document_number: "A1", parties: [{ role: "ship_to", address: "NO. 1, JLN GADONG INDAH 3, TMN GADONG INDAH 1, 71900 LABU NEGERI SEMBILAN" }], tables: [] } }),
    geo: () => [],
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#rt-export")]);
  const todo = JSON.parse(require("node:fs").readFileSync(await dl.path(), "utf8"));
  expect(todo).toHaveLength(1);
  expect(todo[0].address).toContain("GADONG INDAH 3");
  const rows = [{ key: todo[0].key, address: todo[0].address, ok: true, lat: 2.7, lng: 101.9, place: "99 Speed Mart", found_address: "Jalan Gadong Indah 3, 71900 Labu", url: "https://www.google.com/maps/place/x/data=!3d2.7!4d101.9", confidence: "high" }];
  await page.setInputFiles("#rt-import", { name: "locations.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(rows)) });
  await expect(page.locator("#view")).toContainText("1 coordinates imported");
  await expect(page.locator(".badge.ok")).toContainText("Located by web search");
});
