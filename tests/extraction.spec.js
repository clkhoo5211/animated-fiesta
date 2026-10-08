const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, statuses, invoice, FIX } = require("./helpers");

test("empty states, extraction and all four result tabs", async ({ page, context }) => {
  const calls = await serve(context, { model: () => ({ json: invoice() }) });
  await preset(page);
  await page.goto("/");
  for (const [tab, text] of [["overview", "Upload files"], ["items", "every table"], ["checks", "arithmetic checks"], ["json", "raw JSON"]]) {
    await page.click(`.tab[data-tab=${tab}]`);
    await expect(page.locator("#view")).toContainText(text);
  }
  await page.click(".tab[data-tab=overview]");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(await statuses(page)).toEqual(["invoice.jpg=warn"]); // low-res warning only
  expect(calls).toHaveLength(1);
  expect(calls[0].images).toBe(1);

  await expect(page.locator("#view")).toContainText("INV-TEST-0001");
  await expect(page.locator(".kpi.big")).toContainText("224.76");
  await page.click(".tab[data-tab=items]");
  await expect(page.locator("#view tbody tr")).toHaveCount(3);
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator('.item[data-k="bad"]')).toHaveCount(0);
  await expect(page.locator("#view")).toContainText("QR"); // local QR decoded from the fixture
  await expect(page.locator("#view")).toContainText("INV-TEST-0001|TOTAL=224.76");
  await page.click(".tab[data-tab=json]");
  const json = JSON.parse(await page.locator("#view pre").textContent());
  expect(json.segments[0].final_result.document_number).toBe("INV-TEST-0001");
});

test("arithmetic check flags a wrong line amount and highlights the row", async ({ page, context }) => {
  const bad = invoice(); bad.tables[0].rows[1][3] = "49.06";
  await serve(context, { model: () => ({ json: bad }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(await statuses(page)).toEqual(["invoice.jpg=bad"]);
  await page.click(".tab[data-tab=items]");
  await expect(page.locator("#view tbody tr").nth(1)).toHaveClass(/flag/);
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator('.item[data-k="bad"]', { hasText: "row 2 amount" })).toContainText("10 × 4.96 = 49.60 ≠ 49.06");
});
