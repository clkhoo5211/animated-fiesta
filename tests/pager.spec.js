const { test, expect } = require("@playwright/test");
const { serve, preset, invoice, FIX } = require("./helpers");

test("a PDF with many pages gets a compact page navigator, not a wall of buttons; flagged pages are one click away", async ({ page, context }) => {
  test.setTimeout(170_000);
  await serve(context, {
    model: ({ text, doc }) => {
      const n = +/PAGE (\d+)/.exec(doc || text)[1];
      const inv = invoice({ document_number: "INV-" + n });
      if (n === 5) inv.tables[0].rows[0][3] = "999.99"; // amount does not match qty x price
      return { json: inv };
    },
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("eight_pages.pdf"));
  await page.click("#go");
  await page.waitForFunction(() => { const j = [...document.querySelectorAll(".job")]; return j.length > 0 && j.every((x) => !["run", "wait"].includes(x.dataset.status)); }, null, { timeout: 160_000 });
  await page.click(".tab[data-tab=overview]");
  await expect(page.locator(".pager")).toBeVisible();
  await expect(page.locator(".seg [data-seg]")).toHaveCount(0);
  await expect(page.locator("#seg-sel option")).toHaveCount(8);
  await expect(page.locator("#view")).toContainText("INV-1");
  await page.click('[data-step="1"]');
  await expect(page.locator("#view")).toContainText("INV-2");
  await page.click("#seg-flag");
  await expect(page.locator("#view")).toContainText("INV-5");
  await page.selectOption("#seg-sel", "7");
  await expect(page.locator("#view")).toContainText("INV-8");
});
