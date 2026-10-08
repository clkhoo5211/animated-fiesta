const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, statuses, invoice, FIX } = require("./helpers");

test("HEIC is converted to an image; Excel/Word/CSV are sent as text", async ({ page, context }) => {
  const calls = await serve(context, { model: ({ doc }) => ({ json: doc?.includes("Quotation")
    ? { document_type: "quotation", document_number: "Q-2026-15", grand_total: "2100.00", tables: [{ name: "Items", columns: [{ name: "Item", role: "text" }, { name: "Qty", role: "qty" }, { name: "Amount", role: "amount" }], rows: [["Design", "1", "1500.00"], ["Hosting", "12", "600.00"]] }] }
    : invoice() }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", ["photo.heic", "sheet.xlsx", "quote.docx", "data.csv"].map(FIX));
  await page.click("#go");
  await waitIdle(page);
  expect((await statuses(page)).filter((s) => s.endsWith("=err"))).toEqual([]);
  const imageCalls = calls.filter((c) => c.images > 0), textCalls = calls.filter((c) => c.doc);
  expect(imageCalls).toHaveLength(1);                       // HEIC
  expect(textCalls.length).toBe(4);                          // 2 sheets + docx + csv
  expect(textCalls.some((c) => c.doc.includes("Widget A | 2 | 10.5 | 21"))).toBe(true);
  expect(textCalls.some((c) => c.doc.includes("[TABLE]") && c.doc.includes("Hosting | 12 | 600.00"))).toBe(true);
  await page.locator('.job[data-name="quote.docx"]').click();
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator(".pv pre")).toContainText("Quotation Q-2026-15");
});

test("CSV is parsed locally when no model is configured", async ({ page, context }) => {
  await serve(context);
  await preset(page, { a: { key: "" } });
  await page.goto("/");
  // with no key configured the settings dialog opens on start; close it
  await page.locator("#settings button[value=cancel]").click();
  await page.setInputFiles("#f", FIX("data.csv"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Local parse · CSV · column “CTN” total");
  await page.click(".tab[data-tab=items]");
  await expect(page.locator("#view tbody tr")).toHaveCount(2);
});
