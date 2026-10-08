// @ts-check
const { defineConfig } = require("@playwright/test");
const fs = require("fs");
// Use a pre-installed Chromium when present (cloud sandbox); CI installs its own.
const local = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(p => fs.existsSync(p));
module.exports = defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://app.test/", ...(local && !process.env.CI ? { launchOptions: { executablePath: local } } : {}) },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
