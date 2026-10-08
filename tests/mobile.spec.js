const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, invoice, FIX } = require("./helpers");

for (const lang of ["en", "ms", "zh"]) {
  test(`mobile 375px layout has no horizontal overflow (${lang})`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await serve(context, { model: () => ({ json: invoice(), delay: 1500 }) });
    await preset(page, { lang });
    const noOverflow = async (where) => {
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w, where).toBeLessThanOrEqual(375);
    };
    await page.goto("/");
    await noOverflow("start");
    await page.click("#open-settings");
    await noOverflow("settings");
    await page.click("#save-settings"); // must be reachable on a phone
    await page.setInputFiles("#f", [FIX("invoice.jpg"), FIX("rotated.jpg")]);
    await page.click("#go");
    await expect(page.locator(".prog")).toBeVisible();
    await noOverflow("progress");
    await waitIdle(page);
    for (const tab of ["summary", "overview", "items", "checks"]) {
      if (tab !== "summary") await page.locator(".job").first().click();
      await page.click(`.tab[data-tab=${tab}]`);
      await noOverflow(tab);
    }
    await page.click(".tab[data-tab=items]"); await page.click("#tg-edit");
    await noOverflow("edit");
    await context.close();
  });
}
