const { test, expect } = require("@playwright/test");
const { serve, preset } = require("./helpers");

const testA = async page => page.click("fieldset[data-model=a] .test-btn");
const out = page => page.locator("fieldset[data-model=a] .test");

test("Other provider: an empty Base URL is asked for, never silently sent to OpenAI", async ({ page, context }) => {
  const calls = await serve(context, { model: () => ({ json: { ok: true } }) });
  await preset(page);
  await page.goto("/");
  await page.click("#open-settings");
  await page.selectOption("select[name=a_prov]", "custom");
  await page.fill("input[name=a_base]", "");
  await expect(page.locator("input[name=a_base]")).toHaveAttribute("placeholder", /your-provider/);
  await testA(page);
  await expect(out(page)).toContainText("Base URL");
  expect(calls).toHaveLength(0);
});

test("Other provider: switching to Other does not leave the previous provider's default model behind", async ({ page, context }) => {
  await serve(context, { model: () => ({ json: {} }) });
  await preset(page);
  await page.goto("/");
  await page.click("#open-settings");
  await page.fill("input[name=a_model]", "");
  await page.selectOption("select[name=a_prov]", "openai");
  await expect(page.locator("input[name=a_model]")).toHaveValue("gpt-4o");
  await page.selectOption("select[name=a_prov]", "custom");
  await expect(page.locator("input[name=a_model]")).toHaveValue("");
});

test("Output-token limit: a model that allows fewer tokens than asked (DeepSeek-style 8192) is asked again with its own limit, remembered", async ({ page, context }) => {
  const calls = await serve(context, { model: c => c.maxTokens > 8192 ? { status: 400, error: "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]" } : { json: { ok: true } } });
  await preset(page);
  await page.goto("/");
  await page.click("#open-settings");
  await testA(page);
  await expect(out(page)).toContainText("Connection OK");
  expect(calls.map(c => c.maxTokens)).toEqual([32000, 8192]);
  await testA(page);
  await expect(out(page)).toContainText("Connection OK");
  expect(calls.map(c => c.maxTokens)).toEqual([32000, 8192, 8192]);
});

test("A 404 points at the Base URL and the model name", async ({ page, context }) => {
  await serve(context, { model: () => ({ status: 404, error: "Not found" }) });
  await preset(page);
  await page.goto("/");
  await page.click("#open-settings");
  await testA(page);
  await expect(out(page)).toContainText("Base URL");
});
