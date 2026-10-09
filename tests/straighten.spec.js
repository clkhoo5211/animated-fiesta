const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, invoice, FIX } = require("./helpers");

test("sideways page is straightened and re-read; relay capacity errors are retried; totals-as-row flagged", async ({ page, context }) => {
  let n = 0;
  const reg = {
    document_type: "invoice_register", document_number: "1000849237", document_date: "23/09/2026",
    handwritten_notes: [{ text: "3.9.16" }],
    tables: [{ name: "Invoice Register", columns: [{ name: "Name", role: "text" }, { name: "CTN-1", role: "number" }, { name: "CTN-2", role: "number" }, { name: "Total", role: "row_total" }],
      rows: [["A", "", "1", "1"], ["B", "22", "6", "28"], ["C", "4", "1", "5"], ["T", "39", "17", "56"]], total_row: [null, "0", "0", "0"] }],
  };
  const calls = await serve(context, { model: () => {
    n++;
    if (n === 1) return { status: 500, error: "Chat admission capacity is temporarily unavailable. Retry shortly." };
    return { json: { ...reg, rotation_degrees: n === 2 ? "90" : "0" }, usage: [100, 50] };
  } });
  await page.addInitScript(() => { window.__IL_RETRY_MS = [10, 10]; });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("rotated.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(calls.length).toBe(3); // capacity error, sideways read, straightened read
  await expect(page.locator("#view")).toContainText("Page straightened 90° and re-read");
  await expect(page.locator("#view")).toContainText("A 200 / 100");
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("row 4 looks like the printed totals line");
  await expect(page.locator("#view")).not.toContainText("3.9.16 is earlier");
});

test("page reported upright but every table fails its sums: re-read turned 90° and keep the better read", async ({ page, context }) => {
  let n = 0;
  const tbl = rows => ({ name: "Register", columns: [{ name: "Name", role: "text" }, { name: "CTN", role: "number" }], rows, total_row: [null, "9"] });
  const calls = await serve(context, { model: () => {
    n++;
    const rows = n === 1 ? [["A", "2"], ["B", "3"]] : [["A", "4"], ["B", "5"]];
    return { json: { document_type: "invoice_register", tables: [tbl(rows)], rotation_degrees: "0" }, usage: [10, 5] };
  } });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("rotated.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(calls.length).toBe(2); // upright read with broken sums, then the 90° read that adds up
  await expect(page.locator("#view")).toContainText("Page straightened 90° and re-read");
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Rows add up to 9; printed total 9");
});
