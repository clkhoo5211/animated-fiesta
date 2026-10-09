const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { serve, preset, waitIdle, FIX } = require("./helpers");

const iota = {
  document_type: "invoice", document_number: "#IN2100113",
  parties: [{ role: "issuer", name: "Iota Technologies Sdn Bhd", registration_no: "(1340607-U)" }, { role: "bill_to", name: "Jabatan Perkhidmatan Veterinar", address: "Wisma Tani Blok Podium 1 A, 62630 Putrajaya" }], document_date: "2 July 2026", currency: "RM", grand_total: "RM22,113.00",
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
  await expect(page.locator("#view")).toContainText("SST 8% charged, but no tax registration number on the document");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#csv")]);
  const csv = fs.readFileSync(await dl.path(), "utf8").replace(/^﻿/, "").split("\n");
  expect(csv[0]).toBe('"file","page","document_number","table","row","Description","Quantity","Price"');
  expect(csv[1]).toContain('"#IN2100113","Items","1"');

  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#csvall")]);
  const all = fs.readFileSync(await dl2.path(), "utf8");
  expect(all).toContain('"party","issuer 1","registration_no","1340607-U"');
  expect(all).toContain('"party","bill_to 2","address","Wisma Tani Blok Podium 1 A, 62630 Putrajaya"');
  expect(all).toContain('"total","2","SST 8%","RM1,638.00"');
  expect(all).toContain('"table: Items","1","Price","RM20,475.00"');

  await page.setInputFiles("#f", FIX("rotated.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.locator(".job", { hasText: "rotated.jpg" }).click();
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Transactions: balance on row 4 does not follow");
});

test("accounting negatives in a credit note, and month-first dates are flagged", async ({ page, context }) => {
  const cn = {
    document_type: "credit_note", document_number: "CN-7", document_date: "04/18/2026", currency: "USD", grand_total: "(108.00)",
    tables: [{ name: "Items", columns: [{ name: "Item", role: "text" }, { name: "Qty", role: "qty" }, { name: "Price", role: "unit_price" }, { name: "Amount", role: "amount" }],
      rows: [["Return A", "2", "50.00", "(100.00)"]] }],
    totals: [{ label: "Subtotal", value: "100.00-" }, { label: "Tax 8%", value: "8.00 CR" }],
  };
  await serve(context, { model: () => ({ json: cn }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Totals add up");
  await expect(page.locator("#view")).toContainText("Dates look month-first");
  await expect(page.locator("#view")).not.toContainText("row 1 amount");
  await expect(page.locator("#view")).toContainText("qty × unit price = amount");
});

test("grouped report: subtotals checked from the model's row kinds (any wording); PDF values grounded in the text layer", async ({ page, context }) => {
  const report = {
    document_type: "aging_report", document_number: "AR-1", document_date: "30/09/2026",
    tables: [{ name: "Aging", columns: [{ name: "Customer", role: "text" }, { name: "Current", role: "number" }, { name: "1-30", role: "number" }, { name: "Balance", role: "row_total" }],
      rows: [["ALPHA", "", "", ""], ["INV-1", "100", "", "100"], ["INV-2", "", "50", "50"], ["Jumlah ALPHA", "100", "50", "150"], ["BETA", "", "", ""], ["INV-3", "20", "", "20"], ["Jumlah BETA", "20", "", "25"]],
      row_kinds: ["group_header", "line", "line", "subtotal", "group_header", "line", "subtotal"], total_row: [null, "120", "50", "170"] }],
  };
  const queue = [report, { document_type: "invoice", document_number: "ZZ-99999", document_date: "01/10/2026", tables: [] }];
  await serve(context, { model: () => ({ json: queue.shift() }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Aging: subtotal on row 7 (Balance) does not match");
  await expect(page.locator("#view")).toContainText("Rows add up to 170"); // subtotal rows are not double-counted (would be 345)
  await expect(page.locator("#view")).not.toContainText("PDF text layer"); // photos skip grounding

  await page.setInputFiles("#f", FIX("text-invoice.pdf"));
  await page.click("#go");
  await waitIdle(page);
  await page.locator(".job", { hasText: "text-invoice.pdf" }).click();
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Not in the PDF text layer: document_number");
});

test("string table headers get roles, so a column shift is caught and the better-checked model is chosen", async ({ page, context }) => {
  const names = ["WATSONS-GATEWAY", "WATSONS-MITSUI", "ALL DAY", "DC UNIT", "KLINIK", "REZEKI", "SSD"];
  const rows = (ctn) => ctn.map((c, i) => [String(i + 1), `15315${String(i).padStart(5, "0")}`, `10${String(i).padStart(5, "0")}`, names[i], "21/09/2026", `15614${String(i).padStart(5, "0")}`, ...c]);
  const good = [[null, "1", null, null, "1"], [null, "1", null, null, "1"], ["22", "6", null, null, "28"], ["4", "1", null, null, "5"], ["3", null, null, null, "3"], ["5", "8", null, null, "13"], ["5", null, null, null, "5"]];
  const shifted = [[null, "1", null, null, "1"], [null, "1", null, null, "1"], ["22", "6", null, null, "28"], [null, "4", "1", null, "5"], [null, "3", null, null, "3"], [null, "5", "8", null, "13"], [null, "5", null, null, "5"]];
  const cols = ["No.", "Delivery No.", "Ship-To", "Name", "Invoice Date", "Invoice No.", "CTN-1", "CTN-2", "CTN-3", "CTN-4", "Total"];
  const total = [null, null, null, null, null, null, "39", "17", "0", "0", "56"];
  const roles = ["id", "id", "id", "text", "date", "id", "number", "number", "number", "number", "row_total"];
  await serve(context, { model: ({ model }) => ({ json: model === "model-a"
    ? { document_type: "invoice_register", document_number: "1000849237", tables: [{ name: "Register", columns: cols, rows: rows(shifted), total_row: total }] }
    : { document_type: "invoice_register", document_number: "1000849237", tables: [{ name: "Register", columns: cols.map((n, i) => ({ name: n, role: roles[i] })), rows: rows(good), total_row: total }] } }) });
  await preset(page, { b: {} });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await expect(page.locator("#view")).toContainText("Source: model B");
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Model A · Register · column “CTN-1” total");
});
