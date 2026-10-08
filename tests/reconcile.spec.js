const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { serve, preset, waitIdle, invoice, FIX } = require("./helpers");

const register = {
  document_type: "invoice_register", document_number: "SHIP-77", document_date: "02/10/2026",
  tables: [{ name: "Orders", columns: [{ name: "Delivery No", role: "id" }, { name: "Name", role: "text" }, { name: "Invoice Date", role: "date" }, { name: "Invoice No.", role: "id" }, { name: "CTN-1", role: "number" }, { name: "Total", role: "row_total" }],
    rows: [["1000000001", "SHOP ALPHA", "01/10/2026", "INV-1001", "1", "1"], ["1000000002", "SHOP BETA", "01/10/2026", "INV-1002", "2", "2"], ["1000000003", "SHOP GAMMA", "02/10/2026", "INV-1003", "3", "3"], ["1000000004", "SHOP DELTA", "02/10/2026", "INV-1004", "4", "4"]],
    total_row: [null, null, null, null, "10", "10"], printed_row_count: "4" }],
};

test("register is reconciled against uploaded invoices", async ({ page, context }) => {
  // each image call returns the next invoice: exact, wrong date, 1-char misread, not on register
  const queue = [["INV-1001", "1/10/2026"], ["INV-1002", "05/10/2026"], ["INV-10O3", "02/10/2026"], ["INV-9999", "03/10/2026"]];
  await serve(context, { model: ({ doc }) => {
    if (doc && doc.includes("Invoice No.")) return { json: register };
    const [no, date] = queue.shift(); return { json: invoice({ document_number: no, document_date: date }) };
  } });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", ["register.csv", "invoice.jpg", "rotated.jpg", "invoice.pdf", "photo.heic"].map(FIX));
  await expect(page.locator(".job")).toHaveCount(5);
  await page.click("#go");
  await waitIdle(page);
  await expect(page.locator(".tab[data-tab=recon]")).toHaveClass(/on/); // opens automatically when a register exists
  const rows = page.locator("#view table tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Matched");           // 1/10/2026 == 01/10/2026
  await expect(rows.nth(1)).toContainText("Date differs: 05/10/2026");
  await expect(rows.nth(2)).toContainText("Possible match");
  await expect(rows.nth(2)).toContainText("INV-10O3");
  await expect(rows.nth(3)).toContainText("Missing");
  await expect(rows.nth(3)).toHaveClass(/flag/);
  await page.screenshot({ path: "test-results/recon.png", fullPage: true });
  await expect(page.locator("#view")).toContainText("1 of 4 invoice numbers matched");
  await expect(page.locator("#view")).toContainText("Invoice No INV-9999 does not appear on any register");

  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#csvrecon")]);
  const csv = fs.readFileSync(await dl.path(), "utf8");
  for (const st of ["ok", "date_mismatch", "possible_match", "missing", "not_in_register"]) expect(csv).toContain(`"${st}"`);

  // a manual fix on the misread invoice turns the possible match into a match
  await page.locator("#view a", { hasText: /\.(jpg|pdf|heic)$/ }).nth(2).click();
  await page.click("#tg-edit");
  await page.locator('[data-path="document_number"]').click();
  await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type("INV-1003"); await page.keyboard.press("Enter");
  await page.click(".tab[data-tab=recon]");
  await expect(rows.nth(2)).toContainText("Matched");

  // clicking a matched file opens it
  await rows.nth(0).locator("a").click();
  await expect(page.locator(".tab[data-tab=overview]")).toHaveClass(/on/);
  await expect(page.locator(".kpis")).toContainText("INV-1001");
});

test("duplicates: identical files are skipped, repeated invoice numbers are flagged", async ({ page, context }) => {
  await serve(context, { model: () => ({ json: invoice({ document_number: "INV-5555" }) }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", [FIX("invoice.jpg"), FIX("rotated.jpg")]);
  await expect(page.locator(".job")).toHaveCount(2);
  await page.setInputFiles("#f", FIX("invoice.jpg")); // same bytes again
  await expect(page.locator("#toast")).toContainText("Skipped 1 identical file");
  await expect(page.locator(".job")).toHaveCount(2);
  await page.click("#go");
  await waitIdle(page);
  await expect(page.locator(".job .badge", { hasText: "Duplicate" })).toHaveCount(2);
  await page.click(".tab[data-tab=recon]");
  await expect(page.locator("#view")).toContainText("Duplicate invoice numbers");
  await expect(page.locator("#view")).toContainText("INV-5555");
});
