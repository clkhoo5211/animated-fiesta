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

test("a faded block on a scan (light-grey address) is darkened before the model reads it", async ({ page, context }) => {
  const calls = await serve(context, { model: () => ({ json: { document_type: "invoice", document_number: "INV-FADE-01", tables: [] } }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", [FIX("faded.jpg"), FIX("invoice.jpg")]);
  await page.click("#go");
  await waitIdle(page);
  // darkest pixel inside the faded delivery-address block, as the model received it
  const darkest = (url) => page.evaluate(async (u) => {
    const img = await createImageBitmap(await (await fetch(u)).blob()), c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d");
    x.drawImage(img, 0, 0); const sx = img.width / 900, d = x.getImageData(480 * sx, 200 * sx, 400 * sx, 120 * sx).data;
    let mn = 255; for (let i = 0; i < d.length; i += 4) mn = Math.min(mn, d[i]); return { mn, w: img.width };
  }, url);
  const sent = await Promise.all(calls.map((c) => darkest(c.imageUrls[0])));
  const faded = sent.find((s) => s.w === 900) || sent[0];
  expect(faded.mn).toBeLessThan(150); // was ~196 (light grey) on the page
  expect(calls.length).toBe(2);
});

test("a scanned PDF page (no text layer) is rendered near scan resolution, not at 2x", async ({ page, context }) => {
  const calls = await serve(context, { model: () => ({ json: { document_type: "invoice", document_number: "INV-1", tables: [] } }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.pdf"));
  await page.click("#go");
  await waitIdle(page);
  const size = await page.evaluate(async (u) => { const b = await createImageBitmap(await (await fetch(u)).blob()); return [b.width, b.height] }, calls[0].imageUrls[0]);
  expect(Math.max(...size)).toBeGreaterThan(2400); // 2x would be 2200 px on this page; capped at 2600
  expect(Math.max(...size)).toBeLessThanOrEqual(2600);
});
