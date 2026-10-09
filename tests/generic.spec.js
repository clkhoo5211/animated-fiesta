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
  // the broken subtotal also triggers the turned re-reads (90° and 270°), which read the same table: 3 calls for the photo
  let n = 0;
  await serve(context, { model: () => ({ json: ++n <= 3 ? report : { document_type: "invoice", document_number: "ZZ-99999", document_date: "01/10/2026", tables: [] } }) });
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

test("guessed handwritten names cost the model the pick; phone lengths; labels aligned; e-invoice QR shown", async ({ page, context }) => {
  const base = { document_type: "invoice", document_number: "A260907007", document_date: "23/9/2026", grand_total: "384.00", tables: [] };
  const a = { ...base, parties: [{ role: "supplier", name: "FRIZZ", contact: "Phone: 03-563339805 Fax: 03-56343748" }],
    fields: [{ label: "Customer Account", value: "N010" }, { label: "Payment Terms :", value: "14 DAYS" }], handwritten_notes: [{ text: "26/4/26" }] };
  const b = { ...base, parties: [{ role: "supplier", name: "FRIZZ", contact: "Phone: 03-563339805 Fax: 03-56343740" }],
    fields: [{ label: "Payment Terms", value: "14 DAYS" }, { label: "Customer Account", value: "N010" }],
    handwritten_notes: [{ text: "26/9/26" }, { text: "Johnson David Raju" }], low_confidence_fields: ["handwritten_notes[1].text"] };
  await serve(context, { model: ({ model }) => ({ json: model === "model-a" ? a : b }) });
  await preset(page, { b: {} });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("small-qr.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await expect(page.locator("#view")).toContainText("Source: model A");
  await page.click(".tab[data-tab=checks]");
  const v = page.locator("#view");
  await expect(v).toContainText("Handwritten name “Johnson David Raju” is probably guessed");
  await expect(v).toContainText("Numbers with area code 03 have different lengths");
  await expect(v).toContainText("03-563339805 (9)");
  await expect(v).toContainText("LHDN MyInvois e-invoice link found");
  await expect(v).not.toContainText("A/B mismatch · fields.0.label"); // same labels in a different order are not differences
});

test("field-level merge fills empty and truncated values from the other model; column-less tables dropped", async ({ page, context }) => {
  const mk = (desc, ref, extra) => ({ document_type: "invoice", document_number: "#IN2100113", grand_total: "RM22,113.00",
    fields: [{ label: "Ref", value: ref }], totals: [{ label: "Subtotal", value: "RM20,475.00" }, { label: "SST 8%", value: "RM1,638.00" }],
    tables: [{ name: "Items", columns: [{ name: "Description", role: "text" }, { name: "Quantity", role: "qty" }, { name: "Price", role: "amount" }], rows: [[desc, "3", "RM20,475.00"]] }, ...extra] });
  await serve(context, { model: ({ model }) => ({ json: model === "model-a"
    ? mk("Tuntukan Bayaran Bagi:", null, [{ columns: [], rows: [["7 Orders"]] }, { columns: [{ name: "Header", role: "text" }], rows: [["TOTAL: 7 Orders"]], row_kinds: ["other"] }])
    : mk("Tuntukan Bayaran Bagi: PERKHIDMATAN PENYELENGGARAAN SISTEM • 3 Bulan", "Q-2026-17", []) }) });
  await preset(page, { b: {} });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=items]");
  await expect(page.locator("#view")).toContainText("PERKHIDMATAN PENYELENGGARAAN SISTEM");
  await expect(page.locator("#view")).not.toContainText("7 Orders");
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("tables.0.rows.0.0");
  await expect(page.locator("#view")).toContainText("Q-2026-17");
});

test("merge never copies the other model's numbers into empty cells of a correct table", async ({ page, context }) => {
  const cols = [{ name: "Name", role: "text" }, { name: "CTN-1", role: "number" }, { name: "CTN-2", role: "number" }, { name: "Total", role: "row_total" }];
  const t = (rows) => ({ document_type: "invoice_register", tables: [{ name: "Reg", columns: cols, rows, total_row: [null, "7", "1", "8"] }] });
  await serve(context, { model: ({ model }) => ({ json: model === "model-a" ? t([["A", "4", "1", "5"], ["B", "3", "", "3"]]) : t([["A", "", "4", "5"], ["B", "", "3", "3"]]) }) });
  await preset(page, { b: {} });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=items]");
  await expect(page.locator("#view tbody tr").nth(1)).toHaveText(/^\s*B\s*3\s*3\s*$/);
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).not.toContainText("Filled from model B");
});

test("a cell read one column off is moved back when the printed totals single it out", async ({ page, context }) => {
  const cols = [{ name: "Name", role: "text" }, { name: "CTN-1", role: "number" }, { name: "CTN-2", role: "number" }, { name: "CTN-3", role: "number" }, { name: "Total", role: "row_total" }];
  const reg = { document_type: "invoice_register", tables: [{ name: "Register", columns: cols,
    rows: [["A", null, "1", null, "1"], ["B", "22", "6", null, "28"], ["C", null, "3", null, "3"], ["D", "5", "8", null, "13"]], total_row: [null, "30", "15", "0", "45"] }] };
  await serve(context, { model: () => ({ json: reg }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("Row 3: moved 3 from CTN-2 to CTN-1");
  await expect(page.locator("#view")).toContainText("Rows add up to 30; printed total 30");
});

test("model A reads with temperature 0; a relay that refuses it is asked again without", async ({ page, context }) => {
  const calls = await serve(context, { model: (c) => c.temperature === 0 ? { status: 400, error: "Unsupported parameter: temperature" } : { json: { document_type: "invoice", document_number: "INV-1", tables: [] } } });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(calls.map((c) => c.temperature)).toEqual([0, undefined]);
  await expect(page.locator("#view")).toContainText("INV-1");
});

test("same model as A and B: B reads close-ups, B keeps its own temperature; printed notes shown and exported", async ({ page, context }) => {
  const calls = await serve(context, { model: () => ({ json: { document_type: "invoice", document_number: "INV-1", tables: [], notes: ["* Private & Confidential"] } }) });
  await preset(page, { b: { model: "model-a" } });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(calls.map((c) => [c.images, c.temperature]).sort()).toEqual([[1, 0], [3, undefined]]);
  await expect(page.locator("#view")).toContainText("Printed notes");
  await expect(page.locator("#view")).toContainText("* Private & Confidential");
});
