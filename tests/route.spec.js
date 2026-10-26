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
      if (url.includes("nominatim")) { const q = decodeURIComponent(url.split("&q=")[1]); const k = Object.keys(SHOPS).find((x) => q.includes(x)); return k ? [{ lat: String(SHOPS[k][0]), lon: String(SHOPS[k][1]), place_rank: 30, display_name: k }] : [] }
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
  await expect(page.locator("#view")).toContainText("Start located at"); // the start is located as soon as it is entered
  await page.uncheck("#rt-back"); // one-way: the short western leg first, then east (B, A, C) beats A, C, then back west to B
  await page.click("#rt-plan");
  await expect(page.locator("#view")).toContainText("1 route(s)");
  const stops = await page.locator("ol li").allInnerTexts();
  expect(stops.map((s) => s.match(/SHOP \w/)[0])).toEqual(["SHOP B", "SHOP A", "SHOP C"]);
  await expect(page.locator("#view")).toContainText("Road distances and times: OSRM");
  expect(await page.locator("a:has-text('Open in Google Maps')").first().getAttribute("href")).toContain("origin=3%2C101.5");
  expect(decodeURIComponent(await page.locator("a:has-text('Open in Google Maps')").first().getAttribute("href"))).toContain("SHOP B, 10 Jalan B, 41000 Klang, Malaysia|SHOP A");

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

test("as soon as the stops appear, model A reads the addresses and the map locates them (no click); coordinates come from the map", async ({ page, context }) => {
  const prompts = [];
  await serve(context, {
    model: (c) => {
      if (c.text.includes("Rewrite each numbered delivery address")) { prompts.push(c.text); return { json: { results: [{ n: 1, queries: ["14 Jalan Keindahan 1, Taman Skudai Indah, 81300 Skudai, Johor"] }] } } }
      return { json: { document_type: "delivery_order", document_number: "A260907007", parties: [{ role: "ship_to", address: "JH TMN SKUDAI INDAH ( DA ) NO 14 & 16 (GF), JLN KEINDAHAN 1 TMN SKUDAI INDAH 81300 SKUDAI, JOHOR." }], tables: [] } };
    },
    geo: (url) => { const q = decodeURIComponent(url.split("&q=")[1] || ""); return q.includes("Jalan Keindahan") ? [{ lat: "1.535", lon: "103.657", place_rank: 30 }] : [] },
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]"); // no button: locating starts by itself
  await expect(page.locator("#view")).toContainText("Located (address tidied by AI)", { timeout: 20000 });
  expect(prompts.length).toBe(1);
  expect(prompts[0]).toContain("JLN KEINDAHAN 1");
  // the stop's link searches the printed address (cleaned), not the open-map coordinate
  const href = decodeURIComponent(await page.locator("a:has-text('view on map')").getAttribute("href"));
  expect(href).toContain("query=JH TMN SKUDAI INDAH");
  expect(href).not.toContain("1.535");
});

test("stops can be removed: a hand-added stop is deleted, a document stop is hidden and can be restored", async ({ page, context }) => {
  await serve(context, {
    model: () => ({ json: { document_type: "delivery_order", document_number: "DO-1", parties: [{ role: "ship_to", name: "SHOP A", address: "SHOP A, 10 Jalan A, 41000 Klang" }], tables: [] } }),
    // a slow map reply: the page redraws while the user is typing a new stop
    geo: async () => { await new Promise((r) => setTimeout(r, 700)); return [{ lat: "3.0", lon: "101.6" }] },
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  await page.locator("#rt-new").pressSequentially("3.1, 101.7", { delay: 80 });
  await page.click("#rt-add");
  await expect(page.locator("#view")).toContainText("Delivery stops — 2 of 2 selected");
  await page.locator("[data-del]").nth(1).click(); // the hand-added one: deleted for good
  await expect(page.locator("#view")).toContainText("Delivery stops — 1 of 1 selected");
  await expect(page.locator("#rt-restore")).toHaveCount(0);
  await page.locator("[data-del]").first().click(); // the document's stop: hidden
  await expect(page.locator("#view")).toContainText("Delivery stops — 0 of 0 selected");
  await page.click("#rt-restore");
  await expect(page.locator("#view")).toContainText("SHOP A, 10 Jalan A");
  await page.reload(); // removals are remembered
  await page.click(".tab[data-tab=route]");
  await expect(page.locator("#view")).toContainText("Delivery stops — 1 of 1 selected");
});

test("two copies of one invoice read slightly differently are one stop; geocoder hits in another postcode are rejected; far-away stops are flagged", async ({ page, context }) => {
  await serve(context, {});
  await page.goto("/");
  const r = await page.evaluate(async () => {
    const m = await import("./route.js");
    const stops = m.collectStops([
      { file: "p1", result: { document_number: "A261001104", parties: [{ role: "ship_to", address: "1577 NS TANAH MERAM (DD) PT 1075 & PT 1076, OLN MELUR 1 THN JIMAH JAYA, 71960 PORT DICKSON" }] } },
      { file: "p2", result: { document_number: "A261001104", parties: [{ role: "ship_to", address: "1577 NS TANAH MERAH (DD) PT 1075 & PT 1076, JLN MELUR 1 TMN JIMAH JAYA, 71960 PORT DICKSON" }] } },
      { file: "p3", result: { document_number: "AZ01001205", parties: [{ role: "ship_to", address: "3036 NS Tmn Mikamas (B), NO. 15 (GF), Tmn Mikamas B1. 2, Jln Seremban, 71000 Port Dickson" }] } },
      { file: "p4", result: { document_number: "A2510032261", parties: [{ role: "ship_to", address: "3036 NS TMM MIKAMAS (LD), NO. 15 (GF), TMM MIKAMAS BT. 2, JLN SEREMBAN, 71000 PORT DICKSON" }] } },
      // a different shop one letter apart, other document: stays separate
      { file: "p5", result: { document_number: "DO-A", parties: [{ role: "ship_to", address: "SHOP A, 10 Jalan A, 41000 Klang" }] } },
      { file: "p6", result: { document_number: "DO-B", parties: [{ role: "ship_to", address: "SHOP B, 10 Jalan B, 41000 Klang" }] } },
    ]);
    const near = [0, 1, 2, 3, 4].map((i) => ({ lat: 2.5 + i * 0.02, lng: 101.8 }));
    const far = m.farStops([...near, { lat: 1.55, lng: 103.79, key: "jb" }]).map((x) => x.p.key);
    return { n: stops.length, merged: stops.map((s) => (s.variants || []).length), far, links: m.mapsLinks({ lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }, { lat: 1, lng: 1 }, { lat: 2, lng: 2 }], false)[0] };
  });
  expect(r.n).toBe(4);
  expect(r.merged).toEqual([1, 1, 0, 0]);
  expect(r.far).toEqual(["jb"]);
  expect(r.links).toContain("destination=2%2C2&waypoints=1%2C1"); // the repeated spot is one waypoint

  // the geocoder's first answer is a same-named street in another postcode: rejected, the next query is used
  await page.evaluate(() => localStorage.clear());
  await context.unroute("**/*");
  await serve(context, { geo: (url) => (url.includes("q=Jalan%20Melur%201") ? [{ lat: "3.1", lon: "101.5", address: { postcode: "40000" } }] : [{ lat: "2.48", lon: "101.86", address: { postcode: "71960" } }]) });
  const g = await page.evaluate(async () => (await import("./route.js")).geocode("Jalan Melur 1, 71960 Port Dickson", "my", null, ["Jalan Melur 1", "Taman Jimah Jaya, 71960 Port Dickson"]));
  expect(g).toMatchObject({ lat: 2.48, lng: 101.86 });
});

test("a map hit that is only a street / estate is not shown as located, and the stop link searches the printed address", async ({ page, context }) => {
  await serve(context, {
    model: () => ({ json: { document_type: "delivery_order", document_number: "A260907008", parties: [{ role: "ship_to", address: "7124 JH TMN SCIENTEX KULAI ( DC ) NO 340 & 341 (GF), JLN SCIENTEX 10 TMN SCIENTEX, KELAPA SAWIT 81030,KULAI, JOHOR" }], tables: [] } }),
    geo: () => [{ lat: "1.687", lon: "103.523", place_rank: 26, display_name: "Jalan Scientex Utama, Kulai" }],
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  await expect(page.locator("#view")).toContainText("Street / area only", { timeout: 20000 });
  await expect(page.locator("#view")).not.toContainText("✓ Located");
  const href = decodeURIComponent(await page.locator("a:has-text('view on map')").getAttribute("href"));
  expect(href).toContain("SCIENTEX 10 TMN SCIENTEX");
  expect(href).not.toContain("1.687");
});

const SCI = "7124 JH TMN SCIENTEX KULAI ( DC ) NO 340 & 341 (GF), JLN SCIENTEX 10 TMN SCIENTEX, KELAPA SAWIT 81030,KULAI, JOHOR";
async function webCase(page, context, found, revPc) {
  const prompts = [];
  await serve(context, {
    model: (c) => {
      if (c.text.includes("find the EXACT premises")) { prompts.push(c.text); return { json: { results: [found] } }; }
      return { json: { document_type: "delivery_order", document_number: "A260907009", parties: [{ role: "ship_to", address: SCI }], tables: [] } };
    },
    geo: (url) => url.includes("/reverse") ? { display_name: "somewhere", address: { postcode: revPc } } : [{ lat: "1.687", lon: "103.523", place_rank: 26, display_name: "Jalan Scientex Utama, Kulai" }],
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  return prompts;
}

test("model web search finds the exact premises: accepted only when its Google link and the map's postcode confirm the coordinate", async ({ page, context }) => {
  const prompts = await webCase(page, context, { n: 1, found: true, place_name: "99 Speed Mart Scientex Kulai", address_found: "No 340, Jalan Scientex 10, 81030 Kulai", lat: 1.6905, lng: 103.5251, maps_url: "https://www.google.com/maps/place/99+Speed+Mart/@1.6905,103.5251,17z" }, "81030");
  await expect(page.locator("#view")).toContainText("Located by web search", { timeout: 20000 });
  await expect(page.locator("#view")).toContainText("99 Speed Mart Scientex Kulai");
  expect(prompts.length).toBe(1);
  expect(prompts[0]).toContain("JLN SCIENTEX 10");
});

test("a model-reported coordinate that its own link or the postcode contradicts is rejected (stays street / area only)", async ({ page, context }) => {
  await webCase(page, context, { n: 1, found: true, lat: 1.6905, lng: 103.5251, maps_url: "https://www.google.com/maps/place/x/@1.9,103.9,17z" }, "81030");
  await expect(page.locator("#view")).toContainText("Street / area only", { timeout: 20000 });
  await expect(page.locator("#view")).not.toContainText("Located by web search");
});

test("a model-reported coordinate in another postcode is rejected", async ({ page, context }) => {
  await webCase(page, context, { n: 1, found: true, lat: 1.6905, lng: 103.5251, maps_url: "https://www.google.com/maps/place/x/@1.6905,103.5251,17z" }, "80000");
  await expect(page.locator("#view")).toContainText("Street / area only", { timeout: 20000 });
});

test("the printed address goes to the map first; the model is only asked to rewrite addresses the map cannot place exactly", async ({ page, context }) => {
  let rewrites = 0;
  await serve(context, {
    model: (c) => {
      if (c.text.includes("Rewrite each numbered delivery address")) { rewrites++; return { json: { results: [{ n: 1, queries: [] }] } } }
      return { json: { document_type: "delivery_order", document_number: "A1", parties: [{ role: "ship_to", address: "NO 14 JALAN KEINDAHAN 1, TAMAN SKUDAI INDAH, 81300 SKUDAI, JOHOR." }], tables: [] } };
    },
    geo: (url) => url.includes("nominatim") ? [{ lat: "1.535", lon: "103.657", place_rank: 30 }] : [],
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  await expect(page.locator(".badge.ok")).toHaveCount(1, { timeout: 20000 });
  expect(rewrites).toBe(0);
});

test("view on map and the Google route use the complete printed address (store number, brackets, state), not a trimmed tail", async ({ page, context }) => {
  const ADDR = "1988 NS TMN GADONG INDAH (DD) NO 1 (SINGLE STOREY), JLN GADONG INDAH 3 TMN GADONG INDAH 1, 71900 LABU NEGERI SEMBILAN";
  await serve(context, {
    model: () => ({ json: { document_type: "delivery_order", document_number: "A1", parties: [{ role: "ship_to", address: ADDR }], tables: [] } }),
    geo: () => [],
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  const href = decodeURIComponent(await page.locator("a:has-text('view on map')").first().getAttribute("href"));
  expect(href).toContain("query=" + ADDR);
});

test("tidyAddr drops the branch name, unit numbers and state suffix and spells out abbreviations", async ({ page, context }) => {
  await serve(context);
  await page.goto("/");
  const r = await page.evaluate(async () => {
    const { tidyAddr, geoQueries } = await import("/route.js");
    return {
      a: tidyAddr("1988 NS TMN GADONG INDAH (DD) NO 1 (SINGLE STOREY), JLN GADONG INDAH 3 TMN GADONG INDAH 1, 71900 LABU NEGERI SEMBILAN"),
      b: tidyAddr("NS TIARA SENDAYAN (DD) NO. 13 (GF), JLN TIARA SENDAYAN BIZ 1, PST KOMERSIAL TIARA SENDAYAN, 71900 LABU, N.SEMBILAN."),
      q: geoQueries("NO. 7, JLN A 1, TMN B, 71900 LABU, NEGERI SEMBILAN DARUL KHUSUS"),
    };
  });
  expect(r.a).toBe("Jalan GADONG INDAH 3 Taman GADONG INDAH 1, 71900 LABU NEGERI SEMBILAN");
  expect(r.b).toBe("Jalan TIARA SENDAYAN BIZ 1, Pusat KOMERSIAL TIARA SENDAYAN, 71900 LABU, Negeri Sembilan");
  expect(r.q[0]).toBe("Jalan A 1, Taman B, 71900 LABU, NEGERI SEMBILAN"); // the street form first, the printed line later
  expect(r.q).toContain("NO. 7, JLN A 1, TMN B, 71900 LABU, NEGERI SEMBILAN DARUL KHUSUS");
});

test("Google Maps API key (optional): without it nothing is sent to Google; with it a stop the map cannot place exactly is looked up and accepted only after the postcode / words check", async ({ page, context }) => {
  const ADDR = "NS SENDAYAN INDAH (DD) NO 7, JLN SENDAYAN INDAH 1, TMN SENDAYAN INDAH, 71900 LABU, NEGERI SEMBILAN";
  const run = async (key) => {
    const places = [];
    await serve(context, {
      model: () => ({ json: { document_type: "delivery_order", document_number: "A1", parties: [{ role: "ship_to", address: ADDR }], tables: [] } }),
      geo: (url) => url.includes("nominatim") ? [{ lat: "2.6", lon: "101.8", place_rank: 26 }] : [],
    });
    await context.route("https://places.googleapis.com/**", async (route) => {
      const req = route.request(); places.push({ key: req.headers()["x-goog-api-key"], body: JSON.parse(req.postData() || "{}") });
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ places: [
        { id: "P1", displayName: { text: "Restoran Lain" }, formattedAddress: "Jalan Seberang, 71900 Labu", location: { latitude: 2.1, longitude: 101.1 } },
        { id: "P2", displayName: { text: "99 Speed Mart" }, formattedAddress: "7, Jalan Sendayan Indah 1, Taman Sendayan Indah, 71900 Labu, Negeri Sembilan", location: { latitude: 2.61234, longitude: 101.81234 } },
      ] }) });
    });
    await preset(page, { extra: key ? { google_key: key } : {} });
    await page.goto("/");
    await page.setInputFiles("#f", FIX("invoice.jpg"));
    await page.click("#go");
    await waitIdle(page);
    await page.click(".tab[data-tab=route]");
    return places;
  };
  const places = await run("g-test-key");
  await expect(page.locator(".badge.ok")).toContainText("Located by web search", { timeout: 20000 });
  expect(places).toHaveLength(1);
  expect(places[0].key).toBe("g-test-key");
  expect(places[0].body.textQuery).toBe(ADDR + ", Malaysia");
  await expect(page.locator("#view")).toContainText("99 Speed Mart, 7, Jalan Sendayan Indah 1");
});

test("without a Google key the route tab never calls Google Places", async ({ page, context }) => {
  let called = 0;
  await serve(context, {
    model: () => ({ json: { document_type: "delivery_order", document_number: "A1", parties: [{ role: "ship_to", address: "NO 7, JLN A 1, TMN B, 71900 LABU" }], tables: [] } }),
    geo: () => [{ lat: "2.6", lon: "101.8", place_rank: 26 }],
  });
  await context.route("https://places.googleapis.com/**", (route) => { called++; return route.abort(); });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  await expect(page.locator("#view")).toContainText("Street / area only", { timeout: 20000 });
  expect(called).toBe(0);
});

test("storeQuery turns the printed branch name into the name Google lists the shop under", async ({ page, context }) => {
  await serve(context);
  await page.goto("/");
  const r = await page.evaluate(async () => {
    const { storeQuery } = await import("/route.js");
    return [storeQuery("1954 NS NUSARI BIZ (DD)"), storeQuery("", "1988 NS TMN GADONG INDAH (DD) NO 1 (SINGLE STOREY), JLN GADONG INDAH 3"), storeQuery("3036 NS Tmn Mikamas (01)"), storeQuery("NS TIARA SENDAYAN (DD)", "NO. 13 (GF), JLN TIARA"), storeQuery("GO SPEED MART SDN. BHD.", "LOT PT 2811, JALAN ANGGSA")];
  });
  expect(r[0]).toBe("99 Speedmart 1954 (NS) Nusari Biz");
  expect(r[1]).toBe("99 Speedmart 1988 (NS) Taman Gadong Indah");
  expect(r[2]).toBe("99 Speedmart 3036 (NS) Taman Mikamas");
  expect(r[3]).toBe("");
  expect(r[4]).toBe("");
});

test("Google Places is asked for the store number + name first, then the printed address", async ({ page, context }) => {
  const queries = [];
  await serve(context, {
    model: () => ({ json: { document_type: "delivery_order", document_number: "A1", parties: [{ role: "ship_to", name: "1954 NS NUSARI BIZ (DD)", address: "1780 (GF), JLN NUSARI BAYU 7/1 NUSARI BIZ, 71950 BDR SRI SENDAYAN NEGERI SEMBILAN" }], tables: [] } }),
    geo: () => [{ lat: "2.6", lon: "101.8", place_rank: 26 }],
  });
  await context.route("https://places.googleapis.com/**", async (route) => {
    queries.push(JSON.parse(route.request().postData()).textQuery);
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ places: [{ id: "P9", displayName: { text: "99 Speedmart 1954 (NS) Nusari Biz" }, formattedAddress: "1780, Jalan Nusari Bayu 7/1, Nusari Biz, 71950 Bandar Sri Sendayan, Negeri Sembilan", location: { latitude: 2.66, longitude: 101.87 } }] }) });
  });
  await preset(page, { extra: { google_key: "g" } });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  await expect(page.locator(".badge.ok")).toContainText("Located by web search", { timeout: 20000 });
  expect(queries[0]).toBe("99 Speedmart 1954 (NS) Nusari Biz");
});
