const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { serve, preset, waitIdle, statuses, invoice, FIX } = require("./helpers");

test("manual review: A/B pick, inline edit keeps focus, rows add/delete/undo, reviewed, export", async ({ page, context }) => {
  page.on("dialog", (d) => d.accept());
  await serve(context, { model: ({ model }) => {
    const r = invoice({ low_confidence_fields: ["fields.0.value"] });
    if (model === "model-b") r.parties[1].tax_id = "C10000000007"; // B misreads the TIN
    return { json: r };
  } });
  await preset(page, { b: {} });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await page.click(".tab[data-tab=checks]");
  await expect(page.locator("#view")).toContainText("A/B mismatch · parties.1.tax_id");
  await page.locator('.item:has-text("parties.1.tax_id")').getByRole("button", { name: "Use A value" }).click();
  await page.locator('.item:has-text("fields.0.value")').first().getByRole("button", { name: "Confirm correct" }).click();
  await page.locator('.item:has-text("Low image resolution")').getByRole("button", { name: "Confirm correct" }).click();
  await expect(page.locator('#view .item[data-k="warn"]')).toHaveCount(0);
  expect(await statuses(page)).toEqual(["invoice.jpg=ok"]);

  await page.click(".tab[data-tab=items]");
  await page.click("#tg-edit");
  const cell = page.locator("#view tbody tr").nth(1).locator(".ev").nth(3);
  await cell.click(); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type("49.06");
  await page.locator("#view tbody tr").nth(2).locator(".ev").nth(0).click();
  expect(await page.evaluate(() => document.activeElement.classList.contains("ev"))).toBe(true);
  await expect(page.locator("#view tbody tr").nth(1)).toHaveClass(/flag/);
  await page.keyboard.press("Escape");

  await page.click('[data-addrow="0"]');
  await expect(page.locator("#view tbody tr")).toHaveCount(4);
  await page.click('[data-delrow="0.3"]');
  await expect(page.locator("#view tbody tr")).toHaveCount(3);
  for (let i = 0; i < 3; i++) await page.click("#undo");
  await expect(page.locator("#view tbody tr").nth(1).locator(".ev").nth(3)).toHaveText("49.60");

  await page.click("#tg-edit");
  await page.click("#tg-rev");
  expect(await statuses(page)).toEqual(["invoice.jpg=rev"]);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dl")]);
  const out = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  expect(out.segments[0].final_result.parties[1].tax_id).toBe("C10000000001");
  // "Use A value" matched the shown value, so it is recorded as accepted; the 3 cell/row edits were undone
  expect(out.segments[0].accepted).toContain("parties.1.tax_id");
  expect(out.segments[0].manual_edits).toHaveLength(0);
});
