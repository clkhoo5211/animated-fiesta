const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, statuses, invoice, FIX } = require("./helpers");

test("temporary 504/429 errors are retried, permanent errors are not", async ({ page, context }) => {
  let n = 0, mode = "flaky";
  const calls = await serve(context, {
    model: () => (mode === "flaky" ? (++n <= 2 ? { status: n === 1 ? 504 : 429, error: "queue wait exceeded" } : { json: invoice() }) : { status: 401, error: "bad key" }),
  });
  await page.addInitScript(() => { window.__IL_RETRY_MS = [1500, 10]; });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await expect(page.locator(".prog .steps li.run", { hasText: "Model A" })).toContainText("retrying (1/2)");
  await waitIdle(page);
  expect(calls.length).toBe(3);
  expect(await statuses(page)).not.toContain("err");
  await expect(page.locator(".kpis")).toBeVisible();

  mode = "auth";
  await page.locator(".job [data-act=retry]").click();
  await waitIdle(page);
  expect(calls.length).toBe(4);
  await expect(page.locator("#view")).toContainText("bad key");
});

test("A and B on the same relay are called one after the other", async ({ page, context }) => {
  let inFlight = 0, max = 0;
  const calls = await serve(context, { model: async () => {
    inFlight++; max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 1500)); inFlight--;
    return { json: invoice() };
  } });
  await preset(page, { b: {} });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await expect(page.locator(".prog .steps li", { hasText: "Model B" })).toContainText("starts after model A");
  await waitIdle(page);
  expect(calls.map((c) => c.model)).toEqual(["model-a", "model-b"]);
  expect(max).toBe(1);
});

test("retries stop once the 5-minute budget would be exceeded", async ({ page, context }) => {
  const calls = await serve(context, { model: () => ({ status: 504, error: "gateway timeout" }) });
  await page.addInitScript(() => { window.__IL_RETRY_MS = [200, 200, 200]; window.__IL_RETRY_BUDGET = 300; });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await waitIdle(page);
  expect(calls.length).toBe(2); // first call + one retry; the second retry would pass the budget
});
