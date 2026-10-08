const { test, expect } = require("@playwright/test");
const { serve, preset, waitIdle, invoice, FIX } = require("./helpers");

test("live progress, cancel, and timeout", async ({ page, context }) => {
  let mode = "slow";
  await serve(context, { model: () => ({ json: invoice(), delay: mode === "slow" ? 3000 : 60_000 }) });
  await preset(page, { timeout: 5000 });
  await page.goto("/");
  await page.setInputFiles("#f", FIX("invoice.jpg"));
  await page.click("#go");
  await expect(page.locator(".prog .spin")).toBeVisible();
  await expect(page.locator(".prog .steps li.run", { hasText: "Model A" })).toContainText("waiting for model reply");
  await expect(page.locator('.job[data-status="run"] .stage')).toContainText("Model A");
  await waitIdle(page);
  await expect(page.locator(".kpis")).toBeVisible();

  mode = "hang";
  await page.locator(".job [data-act=retry]").click();
  await expect(page.locator("#cancel-job")).toBeVisible();
  await page.click("#cancel-job");
  await expect(page.locator(".job")).toHaveAttribute("data-status", "err");
  await expect(page.locator("#view")).toContainText("Cancelled");

  await page.locator(".job [data-act=retry]").click();
  await waitIdle(page);
  await expect(page.locator("#view")).toContainText("did not reply within 5 s");
});
