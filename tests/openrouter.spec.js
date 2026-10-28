const { test, expect } = require("@playwright/test");
const { serve, preset } = require("./helpers");

const wrapped = (raw, name = "Google AI Studio", code = 400) => ({ status: code, raw: { error: { message: "Provider returned error", code, metadata: { raw, provider_name: name } } } });
const testA = async page => { await page.click("#open-settings"); await page.click("fieldset[data-model=a] .test-btn"); };

test("OpenRouter: a model that refuses JSON mode is asked again without it, and the choice is remembered", async ({ page, context }) => {
  const calls = await serve(context, { model: c => c.responseFormat ? wrapped('{"error":{"message":"JSON mode is not enabled for models/gemma-4-31b-it"}}') : { json: { ok: true } } });
  await preset(page);
  await page.goto("/");
  await testA(page);
  await expect(page.locator("fieldset[data-model=a] .test")).toContainText("Connection OK");
  expect(calls.map(c => !!c.responseFormat)).toEqual([true, false]);
  await page.click("fieldset[data-model=a] .test-btn");                       // the second test goes straight without JSON mode
  await expect(page.locator("fieldset[data-model=a] .test")).toContainText("Connection OK");
  expect(calls.map(c => !!c.responseFormat)).toEqual([true, false, false]);
});

test("OpenRouter: the real reason behind 'Provider returned error' and the provider's name are shown", async ({ page, context }) => {
  await serve(context, { model: () => wrapped("this model is not available in your region", "Acme AI", 403) });
  await preset(page);
  await page.goto("/");
  await testA(page);
  const t = page.locator("fieldset[data-model=a] .test");
  await expect(t).toContainText("Provider returned error");
  await expect(t).toContainText("Acme AI");
  await expect(t).toContainText("not available in your region");
});

test("OpenRouter: a rate-limited free model says so instead of a bare error", async ({ page, context }) => {
  await serve(context, { model: () => wrapped("google/gemma-4-31b-it:free is temporarily rate-limited upstream", "Google AI Studio", 429) });
  await preset(page, { a: { model: "google/gemma-4-31b-it:free" } });
  await page.addInitScript(() => { window.__IL_RETRY_MS = [1, 1, 1]; });
  await page.goto("/");
  await testA(page);
  await expect(page.locator("fieldset[data-model=a] .test")).toContainText("heavily rate limited", { timeout: 15000 });
});
