"""Live paper-trading loop: closed bar -> rule signal -> (optional) council gate -> paper account -> log/state.

Council is called only when the rule wants a long, can only block it, and its votes are settled against the next bar's
return so weights learn from forward outcomes. NO live orders: paper account only.
"""
import json, os, time
from .strategy import DEFAULT, target_position, sma, rsi, warmup
from .paper import PaperAccount
from .council import Council

def default_context(closes, p, symbol="asset", horizon="next bar"):
    i = len(closes) - 1
    last = ", ".join(f"{x:.2f}" for x in closes[-12:])
    return (f"Asset: {symbol}. Horizon: {horizon}. Last closes: {last}. "
            f"SMA{p['fast']}={sma(closes, p['fast'], i):.2f}, SMA{p['slow']}={sma(closes, p['slow'], i):.2f}, "
            f"RSI{p['rsi_n']}={rsi(closes, p['rsi_n'], i):.1f}. A rule-based trend strategy currently wants to be LONG; "
            "score whether going long is advisable.")

def run(feed, params=None, council=None, outdir="trader/live_out", symbol="asset", max_bars=None,
        on_update=None, cash=10_000.0, ctx_fn=default_context):
    params = params or dict(DEFAULT); os.makedirs(outdir, exist_ok=True)
    acct = PaperAccount(params, cash=cash, log_path=os.path.join(outdir, "decisions.jsonl"))
    acct.closes = list(feed.history(max(300, warmup(params) + 5)))
    pending, curve, events, n = None, [], [], 0
    for ts, px in feed.bars():
        if pending is not None and council:               # settle previous vote on realised forward return
            council.settle(pending["rec"], px / pending["px"] - 1)
        pending = None
        tentative = acct.closes + [px]
        rule_long = target_position(tentative, len(tentative) - 1, params, acct.entry) == 1
        allow, vote = True, None
        if council and rule_long:
            vote = council.vote(ctx_fn(tentative, params, symbol), ts=ts)
            allow = council.gate_position(1, vote) == 1
            pending = {"rec": vote, "px": px}
        rec = acct.on_bar(px, ts, allow_long=allow)
        if vote: rec["council"] = {k: vote[k] for k in ("score", "dispersion", "council_ok", "blocked_by")}
        curve.append(rec["equity"]); events.append(rec); n += 1
        state = {"symbol": symbol, "updated": time.time(), "bars": n, "equity": curve[-300:], "last": rec,
                 "position": "LONG" if acct.units else "FLAT", "recent": events[-30:],
                 "weights": {k: round(v["weight"], 3) for k, v in council.state.items()} if council else {}}
        with open(os.path.join(outdir, "state.json"), "w") as f:
            json.dump(state, f)
        if on_update: on_update(state)
        if max_bars and n >= max_bars: break
    return acct, events
