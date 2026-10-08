const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { serve, preset, waitIdle, invoice, FIX } = require("./helpers");

test("text-based PDF is sent as text (image kept for preview); scanned PDF stays an image", async ({ page, context }) => {
  const calls = await serve(context, { model: () => ({ json: invoice({ document_number: "INV-TEXT-0002" }) }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", [FIX("text-invoice.pdf"), FIX("invoice.pdf")]);
  await page.click("#go");
  await waitIdle(page);
  const textCall = calls.find((c) => c.doc && c.doc.includes("INV-TEXT-0002"));
  expect(textCall, "text layer sent").toBeTruthy();
  expect(textCall.images).toBe(0);
  expect(calls.filter((c) => c.images === 1)).toHaveLength(1); // the scanned PDF
  await page.locator('.job[data-name="text-invoice.pdf"]').click();
  await page.click(".tab[data-tab=overview]");
  await expect(page.locator("#view")).toContainText("Read from the PDF text layer");
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator(".pv img")).toBeVisible();                 // page image still shown for checking
  await expect(page.locator("#view")).not.toContainText("Low image resolution");
});

test("'always image' setting sends PDF pages as images", async ({ page, context }) => {
  const calls = await serve(context, { model: () => ({ json: invoice() }) });
  await preset(page, { extra: { pdf_text: "image" } });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("text-invoice.pdf"));
  await page.click("#go");
  await waitIdle(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].images).toBe(1);
  expect(calls[0].doc).toBeNull();
});

test("token usage and estimated cost are shown and exported", async ({ page, context }) => {
  await serve(context, { model: ({ model }) => ({ json: invoice(), usage: model === "model-b" ? [2000, 500] : [10000, 1000] }) });
  await preset(page, { b: {}, extra: { a_price_in: "2.5", a_price_out: "10", b_price_in: "1", b_price_out: "4" } });
  await page.goto("/");
  await page.setInputFiles("#f", [FIX("invoice.jpg"), FIX("rotated.jpg")]);
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=summary]");
  // per file: A 10k in/1k out ($0.035) + B 2k/0.5k ($0.004) = $0.039; two files = 0.078
  await expect(page.locator(".kpi", { hasText: "Tokens" })).toContainText("27.0k");
  await expect(page.locator(".kpi", { hasText: "Est. cost" })).toContainText("0.08");
  await page.locator(".job").first().click();
  await page.click(".tab[data-tab=overview]");
  await expect(page.locator("#view")).toContainText("Tokens (in / out): A 10.0k / 1.0k · B 2.0k / 500");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#csvsum")]);
  const row = fs.readFileSync(await dl.path(), "utf8").split("\n")[1];
  expect(row).toContain('"12000","1500","0.039000"');
});
