// Shared test harness: serves site/index.html, maps CDN libraries to node_modules,
// and mocks OpenAI-compatible / Anthropic model endpoints. No real network is used.
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const FIX = (n) => path.join(__dirname, "fixtures", n);
const TYPES = { js: "text/javascript", mjs: "text/javascript", wasm: "application/wasm", map: "application/json" };

/** @param {import('@playwright/test').BrowserContext} ctx */
async function serve(ctx, { model } = {}) {
  const calls = [];
  await ctx.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("http://app.test/")) return route.fulfill({ path: path.join(ROOT, "site/index.html"), contentType: "text/html" });
    const cdn = url.match(/(?:cdn|fastly)\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
    if (cdn) {
      const file = path.join(ROOT, "node_modules", cdn[1], cdn[2]);
      if (fs.existsSync(file)) return route.fulfill({ path: file, contentType: TYPES[file.split(".").pop()] || "text/javascript" });
      return route.fulfill({ status: 404, body: "missing " + file });
    }
    if (url.startsWith("https://relay.test/") || url.startsWith("https://api.anthropic.com/")) {
      const body = JSON.parse(route.request().postData() || "{}");
      const content = body.messages?.[0]?.content || [];
      const text = (Array.isArray(content) ? content.find((c) => c.type === "text")?.text : content) || "";
      const images = Array.isArray(content) ? content.filter((c) => c.type === "image_url" || c.type === "image").length : 0;
      const doc = (text.match(/<<<DOCUMENT\n([\s\S]*?)\nDOCUMENT>>>/) || [])[1] || null;
      const call = { model: body.model, images, doc, maxTokens: body.max_tokens, anthropic: url.includes("anthropic") };
      calls.push(call);
      const out = model ? await model(call) : { json: {} };
      if (out.delay) await new Promise((r) => setTimeout(r, out.delay));
      if (out.abort) return route.abort().catch(() => {});
      const payload = out.error
        ? { error: { message: out.error } }
        : call.anthropic
          ? { content: [{ type: "text", text: JSON.stringify(out.json) }], ...(out.usage ? { usage: { input_tokens: out.usage[0], output_tokens: out.usage[1] } } : {}) }
          : { choices: [{ message: { content: JSON.stringify(out.json) } }], ...(out.usage ? { usage: { prompt_tokens: out.usage[0], completion_tokens: out.usage[1] } } : {}) };
      return route.fulfill({ status: out.status || (out.error ? 500 : 200), contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(payload) }).catch(() => {});
    }
    return route.abort();
  });
  return calls;
}

/** Preload settings/language into localStorage (only on first load, so reload tests keep state). */
async function preset(page, { lang = "en", a = {}, b = null, enhance = false, tiles = false, timeout, extra = {} } = {}) {
  const settings = {
    a_prov: "custom", a_type: "openai", a_base: "https://relay.test/v1", a_model: "model-a", a_key: "test-key-a", a_json: true,
    b_prov: "custom", b_type: "openai", b_base: b ? "https://relay.test/v1" : "", b_model: b ? "model-b" : "", b_key: b ? "test-key-b" : "", b_json: true,
    proxy: "", remember_keys: true, enhance, tiles,
    ...Object.fromEntries(Object.entries(a).map(([k, v]) => ["a_" + k, v])),
    ...(b ? Object.fromEntries(Object.entries(b).map(([k, v]) => ["b_" + k, v])) : {}),
    ...extra,
  };
  await page.addInitScript(([s, l, t]) => {
    try {
      if (!localStorage.getItem("invoicelens.settings.v1")) localStorage.setItem("invoicelens.settings.v1", JSON.stringify(s));
      if (l && !localStorage.getItem("invoicelens.lang")) localStorage.setItem("invoicelens.lang", l);
    } catch {}
    if (t) window.__IL_TIMEOUT = t;
  }, [settings, lang, timeout]);
}

const statuses = (page) => page.$$eval(".job", (els) => els.map((e) => `${e.dataset.name}=${e.dataset.status}`));
async function waitIdle(page) {
  await page.waitForFunction(() => {
    const jobs = [...document.querySelectorAll(".job")];
    return jobs.length > 0 && jobs.every((j) => !["run", "wait"].includes(j.dataset.status));
  }, null, { timeout: 60_000 });
}
/** Visible text of the page without <script> and the language picker. */
const visibleText = (page, sel = "body") => page.evaluate((sel) => {
  const src = document.querySelector(sel); const c = src.cloneNode(true);
  c.querySelectorAll("script,#lang").forEach((e) => e.remove());
  c.style.position = "absolute"; document.body.append(c); const t = c.innerText; c.remove(); return t;
}, sel);

/** A realistic extraction result. Pass overrides to tweak fields. */
function invoice(over = {}) {
  return {
    document_type: "invoice", title: "Invoice", document_number: "INV-TEST-0001", document_date: "01/10/2026", currency: "RM", grand_total: "224.76",
    parties: [{ role: "supplier", name: "DEMO TRADING SDN BHD" }, { role: "bill_to", name: "SAMPLE STORE SDN BHD", tax_id: "C10000000001" }],
    fields: [{ label: "Payment Terms", value: "14 DAYS" }], totals: [{ label: "Total Payable (RM)", value: "224.76" }],
    stamps_and_chops: [], handwritten_notes: [],
    tables: [{ name: "Items", columns: [{ name: "Item", role: "text" }, { name: "Qty", role: "qty" }, { name: "Unit Price", role: "unit_price" }, { name: "Amount", role: "amount" }],
      rows: [["Widget A", "6", "20.86", "125.16"], ["Widget B", "10", "4.96", "49.60"], ["Service", "1", "50.00", "50.00"]], total_row: [null, null, null, "224.76"], printed_row_count: "3" }],
    low_confidence_fields: [], ...over,
  };
}

module.exports = { serve, preset, statuses, waitIdle, visibleText, invoice, FIX };
