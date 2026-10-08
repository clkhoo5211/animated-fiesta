const { test, expect } = require("@playwright/test");
const { serve } = require("./helpers");

test("provider presets fill fields, hide Base URL for Anthropic, and show a translated guide", async ({ page, context }) => {
  await serve(context);
  await page.goto("/");
  await expect(page.locator("#settings[open]")).toBeVisible();
  const base = (s) => page.locator(`[name=${s}_base]`);
  await expect(page.locator("[name=a_prov]")).toHaveValue("openai");
  await expect(base("a")).toHaveValue("https://api.openai.com/v1");
  await expect(base("b")).toBeHidden(); // model B defaults to Anthropic
  await expect(page.locator('[data-help="a"]')).toContainText("platform.openai.com");

  await page.selectOption("[name=a_prov]", "gemini");
  await expect(base("a")).toHaveValue("https://generativelanguage.googleapis.com/v1beta/openai");
  await expect(page.locator("[name=a_model]")).toHaveValue("gemini-2.5-flash");
  await page.selectOption("[name=a_prov]", "deepseek");
  await expect(page.locator('[data-help="a"] .warnline').first()).toContainText("text-only");
  await page.selectOption("[name=a_prov]", "anthropic");
  await expect(base("a")).toBeHidden();

  await page.selectOption("[name=a_prov]", "openrouter");
  await page.fill("[name=a_key]", "k");
  await page.click("#save-settings");
  await page.reload();
  await page.click("#open-settings");
  await expect(page.locator("[name=a_prov]")).toHaveValue("openrouter");
  await page.click("#settings button[value=cancel]");
  await page.selectOption("#lang", "zh");
  await page.click("#open-settings");
  await expect(page.locator('[data-help="a"]')).toContainText("如何获取");
});
