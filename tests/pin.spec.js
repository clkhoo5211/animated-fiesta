const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, FIX } = require("./helpers");

test("Fix by pin: click the map, the position is filled in, 'Use this position' saves it as an exact location", async ({ page, context }) => {
  await serve(context, {
    model: () => ({ json: { document_type: "delivery_order", document_number: "A1", parties: [{ role: "ship_to", address: "NO. 1, JLN GADONG INDAH 3, TMN GADONG INDAH 1, 71900 LABU NEGERI SEMBILAN" }], tables: [] } }),
    geo: () => [{ lat: "2.6", lon: "101.8", place_rank: 26 }],
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=route]");
  await expect(page.locator("#view")).toContainText("Street / area only", { timeout: 20000 });
  await page.click("[data-edit]");
  await expect(page.locator(".rt-pin .leaflet-container, .rt-pin.leaflet-container")).toBeVisible({ timeout: 15000 });
  const before = await page.locator("[data-ll]").inputValue();
  await page.locator(".rt-pin").click({ position: { x: 60, y: 60 } });
  const after = await page.locator("[data-ll]").inputValue();
  expect(after).not.toBe(before);
  expect(after).toMatch(/^-?\d+\.\d{5}, -?\d+\.\d{5}$/);
  await page.click("[data-pin-save]");
  await expect(page.locator(".badge.ok")).toContainText("Located");
  await expect(page.locator(".rt-pin")).toHaveCount(0);
});
