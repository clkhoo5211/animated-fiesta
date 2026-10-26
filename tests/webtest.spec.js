const { test, expect } = require("@playwright/test");
const { serve, preset } = require("./helpers");

for (const [name, osm, want] of [["a model that really opened the page", 4242, /Web search works/], ["a model that only guesses", 7, /Not confirmed/]]) {
  test(`settings: web-search test, ${name}`, async ({ page, context }) => {
    await serve(context, {
      model: () => ({ json: { opened: true, osm_id: osm, display_name: "x" } }),
      geo: () => ({ osm_id: 4242, display_name: "Kuala Lumpur" }),
    });
    await preset(page);
    await page.goto("/");
    await page.click("#open-settings");
    await page.click("#test-web");
    await expect(page.locator("#test-web-out")).toContainText(want);
  });
}
