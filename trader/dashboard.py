"""Render result dict to a single self-contained static HTML file (inline SVG, no JS deps)."""
import html

def _svg(series, w=720, h=220):
    pts = [(n, s) for n, s in series if s]
    lo = min(min(s) for _, s in pts); hi = max(max(s) for _, s in pts)
    colors = ["#2563eb", "#9ca3af", "#16a34a"]
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="Equity curves" width="100%">']
    for k, (name, s) in enumerate(pts):
        d = " ".join(f"{x * w / max(1, len(s) - 1):.1f},{h - (v - lo) / (hi - lo or 1) * (h - 10) - 5:.1f}" for x, v in enumerate(s))
        out.append(f'<polyline fill="none" stroke="{colors[k % 3]}" stroke-width="1.6" points="{d}"/>')
    return "".join(out) + "</svg>"

def render(result, title="Paper Trader Research", source="synthetic data"):
    h, bh, d = result["holdout"], result["holdout_buy_hold"], result["holdout_default_params"]
    rows = "".join(
        f"<tr><td>{e['trial']}</td><td>{html.escape(e['change'])}</td><td>{e['train_sharpe']}</td><td class='{e['decision']}'>{e['decision']}</td></tr>"
        for e in result["log"])
    def m(x): return f"<td>{x['sharpe']:.2f}</td><td>{x['ret']*100:.1f}%</td><td>{x['maxdd']*100:.1f}%</td>"
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title><style>
:root{{--bg:#fff;--fg:#111827;--mut:#6b7280;--line:#e5e7eb;--ok:#16a34a;--bad:#dc2626}}
@media(prefers-color-scheme:dark){{:root{{--bg:#0b0f14;--fg:#e5e7eb;--mut:#9ca3af;--line:#1f2937}}}}
body{{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:16px}}
table{{width:100%;border-collapse:collapse}}td,th{{padding:4px 8px;border-bottom:1px solid var(--line);text-align:left}}
.keep{{color:var(--ok)}}.revert{{color:var(--mut)}}.warn{{border-left:3px solid var(--bad);padding:6px 12px;color:var(--mut)}}
</style></head><body><h1>{html.escape(title)}</h1><p style="color:var(--mut)">Source: {html.escape(source)}. Paper only &mdash; not financial advice.</p>
<p class="warn">{html.escape(result['warning'])} Trials: {result['trials']}, kept: {result['kept']}.</p>
<h2>Holdout (out-of-sample) equity</h2>{_svg([("tuned", result["holdout_equity"]), ("buy&hold", result["bh_equity"])])}
<p><span style="color:#2563eb">&#9632;</span> tuned &nbsp; <span style="color:#9ca3af">&#9632;</span> buy &amp; hold</p>
<table><tr><th></th><th>Sharpe</th><th>Return</th><th>Max DD</th></tr>
<tr><td>Tuned params</td>{m(h)}</tr><tr><td>Default params</td>{m(d)}</tr><tr><td>Buy &amp; hold</td>{m(bh)}</tr></table>
<h2>Best params</h2><pre>{html.escape(str(result['best_params']))}</pre>
<h2>Research log</h2><table><tr><th>#</th><th>Change</th><th>Train Sharpe</th><th>Decision</th></tr>{rows}</table></body></html>"""
