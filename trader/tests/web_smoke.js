// Headless smoke test: mocks Binance + Anthropic, checks render, live status, and council gating. Run: node trader/tests/web_smoke.js
const { chromium } = require("playwright");
const path = require("path");
const bars = []; let p = 100;
for (let i = 0; i < 1001; i++) { p *= 1 + Math.sin(i / 25) * 0.004 + 0.0008; bars.push([Date.now() - (1001 - i) * 3600e3, 0, 0, 0, String(p)]); }
(async () => {
  const b = await chromium.launch(); const pg = await b.newPage(); const errs = []; let llm = 0;
  pg.on("pageerror", e => errs.push(e.message));
  await pg.route(/binance/, r => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(bars) }));
  await pg.route(/anthropic/, r => { llm++; r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ content: [{ type: "text", text: '{"score":-0.9,"confidence":0.9,"rationale":"bearish"}' }] }) }); });
  await pg.goto("file://" + path.resolve(__dirname, "../web/index.html"));
  await pg.waitForFunction(() => /LIVE/.test(document.getElementById("status").textContent), null, { timeout: 15000 });
  const eq0 = await pg.textContent("#eq"); if (!/\$/.test(eq0)) throw new Error("no equity: " + eq0);
  // configure council: one anthropic agent with a fake key, enable, save
  await pg.evaluate(() => { document.getElementById("cfgbox").open = true; });
  const rows = await pg.$$("#agents tr");
  for (let i = 1; i < rows.length; i++) await (await rows[i].$("[data-del]")).click().catch(() => {});
  await pg.fill('#agents tr:first-child [data-f="key"]', "sk-test"); await pg.check("#cen"); await pg.fill("#q", "1");
  await pg.click("#testv"); await pg.waitForFunction(() => /voted|failed/.test(document.getElementById("cmsg").textContent), null, { timeout: 15000 });
  const lv = await pg.textContent("#lastvote");
  if (errs.length) throw new Error("page errors: " + errs.join("; "));
  if (!llm || !/BLOCKED|OK/.test(lv)) throw new Error("council did not vote: " + lv + " llm=" + llm);
  console.log("OK equity", eq0, "| llm calls", llm, "|", lv.slice(0, 80)); await b.close();
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
