const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, invoice, FIX } = require("./helpers");

test("a model that cannot read the image is flagged", async ({ page, context }) => {
  // A reads the image; B is a text-only model: one rejects image_url, the other returns nothing
  await serve(context, { model: ({ model }) => (model === "model-a" ? { json: invoice() } : { status: 400, error: "unknown variant `image_url`, expected `text`" }) });
  await preset(page, { b: {} });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Model B may not read images");
  await expect(page.locator("#view")).not.toContainText("Model A may not read images");
});
