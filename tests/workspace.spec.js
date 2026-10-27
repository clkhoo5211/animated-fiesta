const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, FIX } = require("./helpers");

const doc = n => ({ document_type: "invoice", document_number: "INV-" + n, document_date: "7/10/2026", currency: "RM",
  parties: [{ role: "bill_to", name: "99 SPEED MART SDN. BHD.", address: "LOT 2811, 41150 KLANG" }, { role: "ship_to", name: null, address: n % 2 ? "1988\nNS TMN GADONG INDAH (DD)\nNO 1, JLN GADONG INDAH 3\n71900 LABU, NEGERI SEMBILAN" : "2445\nNS PST DAGANGAN SENDAYAN (DD)\nNO. 186 (GROUND FLOOR), JLN PUSAT DAGANGAN SENDAYAN 3/3\n71950 SEREMBAN, NEGERI SEMBILAN" }],
  tables: [{ name: "Items", columns: [{ name: "Item", role: "text" }, { name: "Amount", role: "amount" }], rows: [["A", "10.00"], ["B", "5.00"]], total_row: ["", "15.00"] }], grand_total: "15.00", rotation_degrees: "0" });

async function run(page, context, geo) {
  let n = 0;
  await serve(context, { model: () => ({ json: doc(++n) }), geo: geo || (() => []) });
  await preset(page, { route: { brand: "99" } });
  await page.goto("/");
  await page.setInputFiles("#f", [FIX("invoice.jpg"), FIX("rotated.jpg")]);
  await page.click("#go");
  await waitIdle(page);
}

test("workspace: grouped navigation, page header, and an inspector with the source page and the checks beside the data", async ({ page, context }) => {
  await run(page, context);
  await page.click(".tab[data-tab=overview]");
  await expect(page.locator(".navgrp")).toHaveCount(2);
  await expect(page.locator("#pagehead h2")).toHaveText("Overview");
  await expect(page.locator("#crumbs")).toContainText("invoice.jpg");
  await expect(page.locator(".ins .pv img")).toBeVisible();                 // the source page next to the data
  await expect(page.locator(".ins")).toContainText("Checks");
  await page.click(".tab[data-tab=items]");
  await expect(page.locator(".ins .pv img")).toBeVisible();
  await expect(page.locator("#pagehead h2")).toHaveText("Tables");
});

test("go to palette: Ctrl+K opens it, typing filters, Enter opens the page; the page is kept in the URL", async ({ page, context }) => {
  await run(page, context);
  await page.keyboard.press("Control+k");
  await expect(page.locator("#cmd")).toBeVisible();
  await page.keyboard.type("route");
  await expect(page.locator("#cmd-list li[role=option]")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator("#cmd")).toBeHidden();
  await expect(page.locator(".tab[data-tab=route]")).toHaveClass(/on/);
  expect(page.url()).toContain("#route");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("rotated");
  await page.keyboard.press("Enter");
  await expect(page.locator("#crumbs")).toContainText("rotated.jpg");
  await page.reload();
  await expect(page.locator(".tab[data-tab=route]")).toHaveClass(/on/);   // restored from the URL once the saved files are back
});

test("route page: every located stop is on a live map with its lorry line, numbered after planning; the drawn schematic is the fallback", async ({ page, context }) => {
  await run(page, context, url => {
    if (url.includes("nominatim")) return [{ lat: "2.75", lon: String(101.8 + Math.random() * 0.05), place_rank: 30, display_name: "Jalan Test", address: { postcode: "71900" } }];
    const pts = url.split("/driving/")[1].split("?")[0].split(";").map(p => p.split(",").map(Number)); const m = pts.map(a => pts.map(b => Math.abs(a[0] - b[0]) * 1000));
    return { code: "Ok", durations: m, distances: m.map(r => r.map(v => v * 10)) };
  });
  await page.click(".tab[data-tab=route]");
  await page.fill("#rt-start", "3.0, 101.5");
  await page.locator("#rt-start").dispatchEvent("change");
  await expect(page.locator(".rt-lmap")).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".rt-lmap .mk:not(.start)")).toHaveCount(2, { timeout: 20000 });
  await page.click("#rt-plan");
  await expect(page.locator("#view")).toContainText("1 route(s)");
  await expect(page.locator(".rt-lmap .mk:not(.start)").first()).toHaveText(/^[12]$/);
  await expect(page.locator(".rt-lmap path.rt-ll")).toHaveCount(1);
});
