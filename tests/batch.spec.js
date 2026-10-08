const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { serve, preset, waitIdle, statuses, invoice, FIX } = require("./helpers");

test("batch queue: skips unsupported, max 2 concurrent, failure then retry, summary + CSV", async ({ page, context }) => {
  let inFlight = 0, maxInFlight = 0, failOnce = true;
  await serve(context, { model: async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 400)); inFlight--;
    if (failOnce) { failOnce = false; return { error: "invalid request" }; }
    return { json: invoice() };
  } });
  await preset(page);
  await page.goto("/");
  await page.setInputFiles("#f", ["invoice.jpg", "rotated.jpg", "invoice.pdf", "note.txt"].map(FIX));
  await expect(page.locator(".job")).toHaveCount(3);
  await expect(page.locator("#go")).toHaveText("Start extraction (3 files)");
  await page.click("#go");
  await waitIdle(page);
  expect(maxInFlight).toBeLessThanOrEqual(2);
  const st = await statuses(page);
  expect(st.filter((s) => s.endsWith("=err"))).toHaveLength(1);
  await expect(page.locator(".tab[data-tab=summary]")).toBeVisible();
  await expect(page.locator("#view table tbody tr")).toHaveCount(3);

  await page.locator('.job[data-status="err"] [data-act=retry]').click();
  await waitIdle(page);
  expect((await statuses(page)).some((s) => s.endsWith("=err"))).toBe(false);

  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#csvsum")]);
  const csv = fs.readFileSync(await dl.path(), "utf8");
  expect(csv.split("\n")).toHaveLength(4); // header + 3 files
  expect(csv).toContain("INV-TEST-0001");
});
