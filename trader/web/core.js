// Port of trader/strategy.py + trader/paper.py. Paper only.
(function (root) {
  const DEFAULT = { fast: 10, slow: 50, rsi_n: 14, rsi_max: 75, stop: 0.08 };
  const sma = (xs, n, i) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += xs[j]; return s / n; };
  const rsi = (xs, n, i) => {
    let g = 0, l = 0;
    for (let j = i - n + 1; j <= i; j++) { const d = xs[j] - xs[j - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  };
  const warmup = (p) => Math.max(p.slow, p.rsi_n) + 1;
  function target(xs, i, p, entry) {
    if (i < warmup(p) || p.fast >= p.slow) return 0;
    if (entry && xs[i] < entry * (1 - p.stop)) return 0;
    return sma(xs, p.fast, i) > sma(xs, p.slow, i) && rsi(xs, p.rsi_n, i) < p.rsi_max ? 1 : 0;
  }
  // blocked: optional (i) => true when the council vetoed a long at bar i. Overlay can only tighten.
  function replay(closes, p = DEFAULT, blocked = null, cash0 = 10000, fee = 0.001, slip = 0.0005) {
    let cash = cash0, units = 0, entry = null; const equity = [], events = [];
    for (let i = 0; i < closes.length; i++) {
      const px = closes[i]; let want = target(closes, i, p, entry);
      if (want && blocked && blocked(i)) want = 0;
      let action = "HOLD";
      if (want && !units) { units = cash * (1 - fee - slip) / px; cash = 0; entry = px; action = "LONG"; }
      else if (!want && units) { cash = units * px * (1 - fee - slip); units = 0; entry = null; action = "CLOSE"; }
      const eq = cash + units * px; equity.push(eq);
      if (action !== "HOLD") events.push({ i, px, action, equity: eq });
    }
    return { equity, events, position: units ? "LONG" : "FLAT", entry, units, cash };
  }
  const api = { DEFAULT, sma, rsi, target, replay, warmup };
  if (typeof module !== "undefined") module.exports = api; else root.TraderCore = api;
})(this);
