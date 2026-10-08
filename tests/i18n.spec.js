const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, visibleText, invoice, FIX } = require("./helpers");

const leaks = (txt, lang) => {
  const out = [];
  if (lang !== "zh") out.push(...(txt.match(/\S*[一-鿿]\S*/g) || []));
  out.push(...(txt.match(/\b(ck|st|dt|r|stg|pv|hn|h)_\w+|\{[a-z]\w*\}/g) || []));
  return [...new Set(out)];
};

test("English by default; no untranslated text in en / ms / zh; choice persists", async ({ page, context }) => {
  await serve(context, { model: ({ model }) => { const r = invoice({ low_confidence_fields: ["parties.1.tax_id"] }); if (model === "model-b") r.parties[1].tax_id = "X"; return { json: r }; } });
  await preset(page, { lang: null, b: {} }); // no stored language -> default
  await page.goto("/");
  await expect(page.locator("#lang")).toHaveValue("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.setInputFiles("#f", [FIX("invoice.jpg"), FIX("data.csv")]);
  await page.click("#go");
  await waitIdle(page);
  for (const lang of ["en", "ms", "zh"]) {
    await page.selectOption("#lang", lang);
    await page.locator('.job[data-name="invoice.jpg"]').click();
    for (const tab of ["overview", "items", "checks", "summary", "recon"]) {
      await page.click(`.tab[data-tab=${tab}]`);
      expect(leaks(await visibleText(page), lang), `${lang}/${tab}`).toEqual([]);
    }
    await page.click(".tab[data-tab=overview]"); await page.click("#tg-edit");
    expect(leaks(await visibleText(page), lang), `${lang}/edit`).toEqual([]);
    await page.click("#tg-edit");
    await page.click("#open-settings");
    expect(leaks(await visibleText(page, "#settings"), lang), `${lang}/settings`).toEqual([]);
    await page.click("#settings button[value=cancel]");
  }
  await page.selectOption("#lang", "ms");
  await page.reload();
  await expect(page.locator("#lang")).toHaveValue("ms");
  await expect(page.locator("#go")).toHaveText("Mulakan pengekstrakan");
});
