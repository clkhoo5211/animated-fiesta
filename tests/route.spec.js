const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, FIX } = require("./helpers");

// start at 101.5; shop B is west of it, A and C east (C furthest); scanned out of order; the start is entered as coordinates
const SHOPS = { "SHOP A": [3.0, 101.6], "SHOP B": [3.0, 101.4], "SHOP C": [3.0, 101.7] };
const doc = (name, addr) => ({ document_type: "delivery_order", document_number: "DO-" + name.slice(-1), parties: [{ role: "supplier", name: "SUPPLIER", address: "1 Supplier Road 47500 Subang" }, { role: "ship_to", name, address: addr }], tables: [] });

test("delivery route: stops from scanned ship-to addresses, geocoded, ordered by the optimiser, split between lorries", async ({ page, context }) => {
  const order = ["SHOP C", "SHOP A", "SHOP B"];
  let n = 0;
  const geoCalls = [];
  await serve(context, {
    model: () => { if (n >= 3) return { json: { summary: "Plan looks balanced.", warnings: ["Confirm SHOP B opening hours"], suggestions: [] } }; const s = order[n++]; return { json: doc(s, `${s}, 10 Jalan ${s.slice(-1)}, 41000 Klang`) } },
    geo: (url) => {
      geoCalls.push(url);
      if (url.includes("nominatim")) { const q = decodeURIComponent(url.split("&q=")[1]); const k = Object.keys(SHOPS).find((x) => q.includes(x)); return k ? [{ lat: String(SHOPS[k][0]), lon: String(SHOPS[k][1]), display_name: k }] : [] }
      // OSRM table: durations proportional to the longitude gap
      const pts = url.split("/driving/")[1].split("?")[0].split(";").map((p) => p.split(",").map(Number));
      const m = pts.map((a) => pts.map((b) => Math.abs(a[0] - b[0]) * 1000));
      return { code: "Ok", durations: m, distances: m.map((r) => r.map((v) => v * 10)) };
    },
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", [FIX("invoice.jpg"), FIX("rotated.jpg"), FIX("small-qr.jpg")]);
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  await expect(page.locator("#view")).toContainText("Delivery stops — 3 of 3 selected");
  await expect(page.locator("#rt-plan")).toBeDisabled(); // nothing to plan from until the start is entered
  await expect(page.locator("#view")).toContainText("Enter the driver start first");
  await page.click("#rt-locate"); // look the stops up before planning: each gets a status
  await expect(page.locator(".badge.ok")).toHaveCount(3);
  await expect(page.locator("#view")).not.toContainText("Supplier Road"); // the supplier's own address is not a stop
  await page.fill("#rt-start", "3.0, 101.5");
  await page.locator("#rt-start").dispatchEvent("change");
  await page.uncheck("#rt-back"); // one-way: the short western leg first, then east (B, A, C) beats A, C, then back west to B
  await page.click("#rt-plan");
  await expect(page.locator("#view")).toContainText("1 route(s)");
  const stops = await page.locator("ol li").allInnerTexts();
  expect(stops.map((s) => s.match(/SHOP \w/)[0])).toEqual(["SHOP B", "SHOP A", "SHOP C"]);
  await expect(page.locator("#view")).toContainText("Road distances and times: OSRM");
  expect(await page.locator("a:has-text('Open in Google Maps')").first().getAttribute("href")).toContain("origin=3,101.5");

  // two lorries returning to the start: one goes west, one east, so both are back sooner; every stop still served once
  await page.check("#rt-back");
  await page.fill("#rt-lorries", "2");
  await page.locator("#rt-lorries").dispatchEvent("change");
  await page.click("#rt-plan");
  await expect(page.locator("#view")).toContainText("2 route(s)");
  expect(await page.locator("ol li").count()).toBe(3);
  expect(geoCalls.filter((u) => u.includes("nominatim")).length).toBe(3); // addresses are geocoded once, then cached
  await page.click("#rt-ai"); // the model only comments on the computed plan
  await expect(page.locator("#view")).toContainText("Confirm SHOP B opening hours");
  expect(await page.locator("ol li").count()).toBe(3);
});

test("route optimiser: 2-opt untangles a crossing tour; maps links split long routes", async ({ page, context }) => {
  await serve(context, {});
  await page.goto("/");
  const r = await page.evaluate(async () => {
    const m = await import("./route.js");
    const pts = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }, { lat: 0.5, lng: 2 }];
    const M = m.estimateMatrix(pts);
    const routes = m.planRoutes(pts, M.dur, { lorries: 1, back: true });
    const links = m.mapsLinks(pts[0], Array.from({ length: 23 }, (_, i) => ({ lat: i, lng: i })), false);
    return { routes, cost: m.routeStats(routes[0], M, true, 0, 0).km, links: links.length, q: m.geoQueries("Lot 5, Jalan Angsa, 41150 Klang, Selangor"), ll: m.parseLatLng("https://www.google.com/maps/place/@3.1390,101.6869,15z") };
  });
  expect(r.routes[0].length).toBe(4);
  expect(r.cost).toBeLessThan(5.25 * 111.2 * 1.3); // the shortest tour is 1+1.118+1.118+1+1 degrees
  expect(r.links).toBe(3); // 23 stops -> legs of at most 10
  expect(r.q).toContain("41150 Klang, Selangor");
  expect(r.ll).toEqual({ lat: 3.139, lng: 101.6869 });
});

test("an address the map cannot find is tidied by the model and searched again; coordinates still come from the map", async ({ page, context }) => {
  const prompts = [];
  await serve(context, {
    model: (c) => {
      if (c.text.includes("Rewrite this delivery address")) { prompts.push(c.text); return { json: { queries: ["14 Jalan Keindahan 1, Taman Skudai Indah, 81300 Skudai, Johor"] } } }
      return { json: { document_type: "delivery_order", document_number: "A260907007", parties: [{ role: "ship_to", address: "JH TMN SKUDAI INDAH ( DA ) NO 14 & 16 (GF), JLN KEINDAHAN 1 TMN SKUDAI INDAH 81300 SKUDAI, JOHOR." }], tables: [] } };
    },
    geo: (url) => { const q = decodeURIComponent(url.split("&q=")[1] || ""); return q.includes("Jalan Keindahan") ? [{ lat: "1.535", lon: "103.657" }] : [] },
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  await page.click("#rt-locate");
  await expect(page.locator("#view")).toContainText("Located (address tidied by AI)", { timeout: 20000 });
  expect(prompts.length).toBe(1);
  expect(prompts[0]).toContain("JLN KEINDAHAN 1");
  expect(await page.locator("a:has-text('view on map')").getAttribute("href")).toContain("1.535,103.657");
});
