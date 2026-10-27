const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, FIX } = require("./helpers");

const doc = () => ({ document_type: "invoice", document_number: "A1", parties: [{ role: "bill_to", name: "99 SPEED MART SDN. BHD.", address: "LOT 2811, 41150 KLANG" }, { role: "ship_to", name: null, address: "1988\nNS TMN GADONG INDAH (DD)\nNO 1, JLN GADONG INDAH 3\n71900 LABU, NEGERI SEMBILAN" }], stamps_and_chops: [], rotation_degrees: "0" });

test("addresses-only mode: one model call per page with the short prompt (no tables / totals asked), only the Delivery route page is shown, the branch number stays in the address", async ({ page, context }) => {
  const prompts = [];
  await serve(context, { model: (call) => { prompts.push(call.text || ""); return { json: doc() } }, geo: () => [] });
  await preset(page, { b: { prov: "custom" } });
  await page.addInitScript(() => localStorage.setItem("invoicelens.mode", "route"));
  await page.goto("/");
  await expect(page.locator("[data-mode=route]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#mode-hint")).toContainText("Tables, totals and checks are skipped");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(prompts.length).toBe(1);                                   // model B is not called
  expect(prompts[0]).toContain("ONLY to plan delivery routes");
  expect(prompts[0]).not.toContain("line_items");
  expect(prompts[0].length).toBeLessThan(6000);                      // the full prompt is far longer
  await expect(page.locator("#tab-route")).toBeVisible();
  await expect(page.locator(".tab[data-tab=overview]")).toBeHidden();
  await expect(page.locator(".tab[data-tab=items]")).toBeHidden();
  await expect(page.locator(".tab[data-tab=json]")).toBeHidden();
  await expect(page.locator("#view")).toContainText("1988, NS TMN GADONG INDAH (DD)"); // the branch number is part of the stop
  // back to everything: the other pages are there again (nothing was deleted)
  await page.click("[data-mode=full]");
  await expect(page.locator(".tab[data-tab=overview]")).toBeVisible();
});
