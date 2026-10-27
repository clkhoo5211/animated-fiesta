const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, FIX } = require("./helpers");

const doc = () => ({ document_type: "invoice", document_number: "A1", parties: [{ role: "bill_to", name: "99 SPEED MART SDN. BHD.", address: "LOT 2811, 41150 KLANG" }, { role: "ship_to", name: null, address: "1988\nNS TMN GADONG INDAH (DD)\nNO 1, JLN GADONG INDAH 3\n71900 LABU, NEGERI SEMBILAN" }], stamps_and_chops: [], rotation_degrees: "0" });

test("addresses-only mode: one call per page when the address is read with a postcode (model B is set but not called), a second call only when it is not; short prompt, the route page opens first and the other tabs stay, the branch number stays in the address", async ({ page, context }) => {
  const prompts = [];
  await serve(context, { model: (call) => { prompts.push(call.text || ""); return { json: doc() } }, geo: () => [] });
  await preset(page, { b: { prov: "custom" } });
  await page.addInitScript(() => localStorage.setItem("invoicelens.mode", "route"));
  await page.goto("/");
  await expect(page.locator("[data-mode=route]")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#mode-hint")).toContainText("The second model is called only for a page");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(prompts.length).toBe(1);                                   // model B is set but not called: the address was read with its postcode
  expect(prompts[0]).toContain("ONLY to plan delivery routes");
  expect(prompts[0]).not.toContain("line_items");
  expect(prompts[0].length).toBeLessThan(6000);                      // the full prompt is far longer
  await expect(page.locator("#tab-route")).toBeVisible();
  await expect(page.locator(".tab[data-tab=route]")).toHaveClass(/on/);        // opens on the route page; the other pages are still in the tab bar
  await expect(page.locator(".tab[data-tab=overview]")).toBeVisible();
  await expect(page.locator(".tab[data-tab=json]")).toBeVisible();
  await expect(page.locator("#view")).toContainText("1988, NS TMN GADONG INDAH (DD)"); // the branch number is part of the stop
});

test("addresses-only mode: the second model is called for a page whose delivery address has no postcode, and for nothing else", async ({ page, context }) => {
  const calls = [];
  await serve(context, { model: (call) => { calls.push(call.model); const d = doc(); d.parties[1].address = "1988\nNS TMN GADONG INDAH (DD)\nNO 1, JLN GADONG INDAH 3\nLABU"; return { json: d } }, geo: () => [] });
  await preset(page, { b: { prov: "custom" } });
  await page.addInitScript(() => localStorage.setItem("invoicelens.mode", "route"));
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(calls).toEqual(["model-a", "model-b"]);
});

test("addresses-only mode: while the first file is being read the progress is shown, not an empty route page", async ({ page, context }) => {
  await serve(context, { model: async () => { await new Promise(r => setTimeout(r, 1500)); return { json: doc() } }, geo: () => [] });
  await preset(page);
  await page.addInitScript(() => localStorage.setItem("invoicelens.mode", "route"));
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await expect(page.locator(".prog")).toBeVisible();
  await waitIdle(page);
  await expect(page.locator(".tab[data-tab=route]")).toHaveClass(/on/);
});
