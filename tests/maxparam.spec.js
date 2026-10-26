const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, invoice, FIX } = require("./helpers");

test("a model that refuses max_tokens is asked again with max_completion_tokens, and the choice is remembered", async ({ page, context }) => {
  const calls = await serve(context, {
    model: (c) => c.maxTokens != null
      ? { status: 400, error: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." }
      : { json: invoice() },
  });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  await expect(page.locator("#view")).toContainText("INV-TEST-0001");
  expect(calls.some((c) => c.completionTokens === 32000)).toBe(true);
  const refused = calls.filter((c) => c.maxTokens != null).length;
  await page.locator(".job [data-act=retry]").click();
  await waitIdle(page);
  expect(calls.filter((c) => c.maxTokens != null).length).toBe(refused); // remembered: no second refusal
});
