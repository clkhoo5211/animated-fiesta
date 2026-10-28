const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, FIX } = require("./helpers");

// iOS Safari before 17.4 has no AbortSignal.any (and old ones no AbortSignal.timeout): a model call must still time out and still be cancellable
test("without AbortSignal.any / .timeout a silent model still ends in a timeout message, and the test button gives up", async ({ page, context }) => {
  await serve(context, { model: () => ({ delay: 4000, json: { document_type: "invoice" } }) });
  await preset(page, { timeout: 800 });
  await page.addInitScript(() => { delete AbortSignal.any; delete AbortSignal.timeout; });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await expect(page.locator("#view")).toContainText("did not reply within");
});

test("test connection shows the seconds while it waits and a live result", async ({ page, context }) => {
  await serve(context, { model: () => ({ delay: 2500, json: { ok: true } }) });
  await preset(page);
  await page.goto("/");
  await page.click("#open-settings");
  await page.click("fieldset[data-model=a] .test-btn");
  await expect(page.locator("fieldset[data-model=a] .test")).toContainText(/Testing.* [12] s/);
  await expect(page.locator("fieldset[data-model=a] .test")).toContainText("Connection OK", { timeout: 10000 });
});
