const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { serve, preset, waitIdle, FIX } = require("./helpers");

const iota = {
  document_type: "invoice", document_number: "#IN2100113",
  parties: [{ role: "bill_to", name: "Jabatan Perkhidmatan Veterinar", address: "Wisma Tani Blok Podium 1 A, 62630 Putrajaya" }], document_date: "2 July 2026", currency: "RM", grand_total: "RM22,113.00",
  tables: [{ name: "Items", columns: [{ name: "Description", role: "text" }, { name: "Quantity", role: "qty" }, { name: "Price", role: "amount" }], rows: [["Maintenance, 3 Bulan", "3", "RM20,475.00"]] }],
  totals: [{ label: "Subtotal", value: "RM20,475.00" }, { label: "SST 8%", value: "RM1,638.00" }, { label: "Discount", value: "-" }],
};
const statement = {
  document_type: "statement", document_number: "ST-9", document_date: "30/09/2026",
  tables: [{ name: "Transactions", columns: [{ name: "Date", role: "date" }, { name: "Debit", role: "debit" }, { name: "Credit", role: "credit" }, { name: "Balance", role: "balance" }],
    rows: [["1/9", "", "", "1,000.00"], ["2/9", "200.00", "", "800.00"], ["3/9", "", "50.00", "850.00"], ["4/9", "20.00", "", "803.00"]] }],
};

test("generic checks: totals block, tax rate, statement balance; tables CSV has one header per table", async ({ page, context }) => {
  const queue = [iota, statement];
  await serve(context, { model: () => ({ json: queue.shift() }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Totals add up");
  await expect(page.locator("#view")).toContainText("SST 8% matches the rate");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#csv")]);
  const csv = fs.readFileSync(await dl.path(), "utf8").replace(/^﻿/, "").split("\n");
  expect(csv[0]).toBe('"file","page","document_number","table","row","Description","Quantity","Price"');
  expect(csv[1]).toContain('"#IN2100113","Items","1"');

  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#csvall")]);
  const all = fs.readFileSync(await dl2.path(), "utf8");
  expect(all).toContain('"party","bill_to 1","address","Wisma Tani Blok Podium 1 A, 62630 Putrajaya"');
  expect(all).toContain('"total","2","SST 8%","RM1,638.00"');
  expect(all).toContain('"table: Items","1","Price","RM20,475.00"');

  await page.setInputFiles("#f", FIX("rotated.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.locator(".job", { hasText: "rotated.jpg" }).click();
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Transactions: balance on row 4 does not follow");
});
