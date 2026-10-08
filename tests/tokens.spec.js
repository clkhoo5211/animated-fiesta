const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, invoice, FIX } = require("./helpers");

test("max output tokens: 32000 by default, configurable, clear error when thinking eats the budget", async ({ page, context }) => {
  let mode = "ok";
  const calls = await serve(context, {
    model: () => (mode === "ok" ? { json: invoice() } : { raw: { choices: [{ finish_reason: "length", message: { content: "" } }] } }),
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(calls.at(-1).maxTokens).toBe(32000);

  await page.click("#open-settings");
  await page.fill('[name="a_maxtok"]', "65536");
  await page.click("#save-settings");
  await page.keyboard.press("Escape");
  mode = "length";
  await page.locator(".job [data-act=retry]").click();
  await waitIdle(page);
  expect(calls.at(-1).maxTokens).toBe(65536);
  await expect(page.locator("#view")).toContainText("used all 65536 output tokens");
});
