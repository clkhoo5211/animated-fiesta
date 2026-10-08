const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, statuses, invoice, FIX } = require("./helpers");

test("autosave restores results and edits; interrupted job returns to waiting; clear empties storage", async ({ page, context }) => {
  page.on("dialog", (d) => d.accept());
  let slow = false;
  await serve(context, { model: () => ({ json: invoice(), delay: slow ? 20_000 : 0 }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", [FIX("invoice.jpg"), FIX("invoice.pdf")]);
  await page.click("#go");
  await waitIdle(page);
  await page.locator('.job[data-name="invoice.jpg"]').click();
  await page.click(".tab[data-tab=overview]");
  await page.click("#tg-edit");
  await page.locator('[data-path="document_number"]').click();
  await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type("INV-EDITED"); await page.keyboard.press("Enter");
  await page.click("#tg-edit"); await page.click("#tg-rev");
  await page.waitForTimeout(800);

  await page.reload();
  await expect(page.locator(".job")).toHaveCount(2);
  expect(await statuses(page)).toContain("invoice.jpg=rev");
  await page.locator('.job[data-name="invoice.jpg"]').click();
  await page.click(".tab[data-tab=overview]");
  await expect(page.locator(".kpis")).toContainText("INV-EDITED");

  slow = true;
  await page.setInputFiles("#f", FIX("rotated.jpg"));
  await page.click("#go");
  await expect(page.locator('.job[data-name="rotated.jpg"]')).toHaveAttribute("data-status", "run");
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.locator('.job[data-name="rotated.jpg"]')).toHaveAttribute("data-status", "wait");

  await page.click("#clearq");
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForTimeout(800);
  await expect(page.locator(".job")).toHaveCount(0);
});

test("continuous activity does not postpone autosave (regression)", async ({ page, context }) => {
  await serve(context, { model: () => ({ json: invoice() }) });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  // keep interacting faster than the save delay, then reload immediately
  for (let i = 0; i < 12; i++) await page.click(`.tab[data-tab=${["overview", "items", "checks"][i % 3]}]`, { delay: 0 });
  await page.reload();
  await expect(page.locator(".job")).toHaveAttribute("data-status", /^(ok|warn|bad)$/);
});
