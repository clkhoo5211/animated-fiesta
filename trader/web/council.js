// Browser port of trader/council.py. Keys live ONLY in this browser's localStorage and are sent only to the provider you configure.
(function (root) {
  const W_MIN = 0.3, W_MAX = 2.5, MIN_SAMPLES = 20;
  const SYSTEM = 'You are one member of a trading research council. Reply with ONLY a JSON object: {"score": number in [-1,1] (bearish..bullish over the stated horizon), "confidence": number in [0,1], "rationale": "<=40 words"}. Judge only from the provided context; do not invent data.';
  const DEFAULT_CFG = {
    quorum: 2, long_threshold: 0.2, max_dispersion: 0.6, veto_score: 0.5,
    agents: [
      { name: "macro", kind: "signal", weight: 1, role: "Macro analyst: rates, dollar, liquidity, risk appetite.", provider: "anthropic", model: "claude-sonnet-5-5", base_url: "", key: "" },
      { name: "technical", kind: "signal", weight: 1, role: "Technical analyst: trend, momentum, volatility regime.", provider: "openai", model: "gpt-4o-mini", base_url: "https://api.openai.com/v1", key: "" },
      { name: "risk_officer", kind: "risk", weight: 1.5, role: "Adversarial risk officer: argue the bear case; score strongly negative if exposure is unwise.", provider: "anthropic", model: "claude-haiku-5-5", base_url: "", key: "" },
    ],
  };
  function parse(t) {
    const m = /\{[\s\S]*\}/.exec(t || ""); if (!m) return null;
    try { const d = JSON.parse(m[0]); const s = +d.score, c = +d.confidence;
      if (!(s >= -1 && s <= 1 && c >= 0 && c <= 1)) return null; return { score: s, confidence: c, rationale: String(d.rationale || "").slice(0, 300) }; }
    catch (e) { return null; }
  }
  async function call(a, user, signal) {
    if (!a.key) throw new Error("no key");
    if (a.provider === "anthropic") {
      const r = await fetch((a.base_url || "https://api.anthropic.com") + "/v1/messages", { method: "POST", signal,
        headers: { "content-type": "application/json", "x-api-key": a.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: a.model, max_tokens: 600, system: SYSTEM + "\nRole: " + a.role, messages: [{ role: "user", content: user }] }) });
      if (!r.ok) throw new Error("HTTP " + r.status); const j = await r.json(); return (j.content || []).map(b => b.text || "").join("");
    }
    const r = await fetch((a.base_url || "https://api.openai.com/v1") + "/chat/completions", { method: "POST", signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + a.key },
      body: JSON.stringify({ model: a.model, max_tokens: 600, messages: [{ role: "system", content: SYSTEM + "\nRole: " + a.role }, { role: "user", content: user }] }) });
    if (!r.ok) throw new Error("HTTP " + r.status); const j = await r.json(); return j.choices[0].message.content;
  }
  // weights: {name: {weight, hist: []}} (persisted by caller). caller: async (agent, ctx) => text  (injectable for tests)
  async function vote(cfg, weights, context, caller = (a, c) => call(a, c, AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined)) {
    const res = await Promise.all(cfg.agents.map(async a => {
      try { const out = parse(await caller(a, context)); return { agent: a.name, model: a.model, kind: a.kind, out, err: out ? null : "unparseable" }; }
      catch (e) { return { agent: a.name, model: a.model, kind: a.kind, out: null, err: String(e.message || e) }; }
    }));
    const live = res.filter(r => r.out);
    live.forEach(r => { r.weight = (weights[r.agent] || { weight: 1 }).weight; });
    const den = live.reduce((s, r) => s + r.weight * r.out.confidence, 0);
    const score = den ? live.reduce((s, r) => s + r.weight * r.out.confidence * r.out.score, 0) / den : 0;
    const wsum = live.reduce((s, r) => s + r.weight, 0);
    const disp = live.length ? Math.sqrt(live.reduce((s, r) => s + r.weight * (r.out.score - score) ** 2, 0) / wsum) : 1;
    const veto = live.filter(r => r.kind === "risk" && r.out.score <= -(cfg.veto_score ?? 0.5)).map(r => r.agent);
    const why = [];
    if (live.length < (cfg.quorum ?? 2)) why.push("no_quorum");
    if (veto.length) why.push("risk_veto:" + veto.join(","));
    if (disp > (cfg.max_dispersion ?? 0.6)) why.push("high_disagreement");
    if (score < (cfg.long_threshold ?? 0.2)) why.push("score_below_threshold");
    return { score, dispersion: disp, council_ok: why.length === 0, blocked_by: why,
      votes: res.map(r => ({ agent: r.agent, model: r.model, kind: r.kind, weight: r.weight, error: r.err, ...(r.out || {}) })) };
  }
  function settle(weights, rec, fwdRet) {
    const sign = fwdRet > 0 ? 1 : fwdRet < 0 ? -1 : 0; if (!sign) return;
    rec.votes.forEach(v => { if (v.score !== undefined && weights[v.agent]) weights[v.agent].hist.push(v.score * sign > 0 ? 1 : 0); });
    const stats = {}; Object.entries(weights).forEach(([n, s]) => { if (s.hist.length >= MIN_SAMPLES) { const h = s.hist.slice(-50); stats[n] = h.reduce((a, b) => a + b, 0) / h.length; } });
    const names = Object.keys(stats).sort((a, b) => stats[a] - stats[b]); if (names.length < 4) return;
    const q = Math.max(1, Math.floor(names.length / 4));
    names.slice(0, q).forEach(n => weights[n].weight = Math.max(W_MIN, weights[n].weight * 0.95));
    names.slice(-q).forEach(n => weights[n].weight = Math.min(W_MAX, weights[n].weight * 1.05));
  }
  const api = { DEFAULT_CFG, parse, vote, settle };
  if (typeof module !== "undefined") module.exports = api; else root.TraderCouncil = api;
})(this);
