"""Keep/revert research loop with overfitting guards.

Each trial mutates ONE parameter of the current best. Kept only if TRAIN Sharpe improves by > min_gain.
Holdout is touched exactly once at the end. Trial count is reported so results can be discounted.
Proposer is pluggable: pass propose(best, rng, history) to let an LLM agent suggest the change.
"""
import json, random, time
from .backtest import run, buy_hold
from .strategy import DEFAULT, BOUNDS

def random_mutation(best, rng, history=None):
    k = rng.choice(list(BOUNDS)); lo, hi = BOUNDS[k]
    cand = dict(best)
    if isinstance(DEFAULT[k], int):
        cand[k] = max(lo, min(hi, best[k] + rng.choice([-1, 1]) * rng.randint(1, max(1, (hi - lo) // 8))))
    else:
        cand[k] = round(max(lo, min(hi, best[k] * rng.uniform(0.7, 1.3))), 4)
    return cand, f"mutate {k}: {best[k]} -> {cand[k]}"

def research(closes, trials=60, holdout_frac=0.3, min_gain=0.05, seed=1, propose=random_mutation,
             log_path=None, **bt):
    rng = random.Random(seed)
    split = int(len(closes) * (1 - holdout_frac))
    best = dict(DEFAULT)
    best_s = run(closes, best, start=0, end=split, **bt)["sharpe"]
    base_s = best_s
    log, history = [], []
    for t in range(1, trials + 1):
        cand, why = propose(best, rng, history)
        s = run(closes, cand, start=0, end=split, **bt)["sharpe"]
        kept = s > best_s + min_gain
        entry = {"trial": t, "change": why, "train_sharpe": round(s, 3), "best_before": round(best_s, 3),
                 "decision": "keep" if kept else "revert", "params": cand}
        log.append(entry); history.append(entry)
        if kept:
            best, best_s = cand, s
    hold = run(closes, best, start=split, end=len(closes), **bt)
    hold_base = run(closes, DEFAULT, start=split, end=len(closes), **bt)
    bh = buy_hold(closes, split, len(closes))
    result = {
        "trials": trials, "kept": sum(e["decision"] == "keep" for e in log),
        "best_params": best, "train_sharpe_default": round(base_s, 3), "train_sharpe_best": round(best_s, 3),
        "holdout": {k: round(hold[k], 4) for k in ("sharpe", "ret", "maxdd")} | {"trades": hold["trades"]},
        "holdout_default_params": {k: round(hold_base[k], 4) for k in ("sharpe", "ret", "maxdd")},
        "holdout_buy_hold": {k: round(bh[k], 4) for k in ("sharpe", "ret", "maxdd")},
        "holdout_equity": hold["equity"], "bh_equity": bh["equity"], "log": log,
        "warning": "Holdout evaluated once. With N trials, expect best train Sharpe to be inflated; trust holdout only.",
    }
    if log_path:
        with open(log_path, "w") as f:
            for e in log:
                f.write(json.dumps(e) + "\n")
    return result

def walk_forward(closes, train=500, test=125, trials=40, **kw):
    """Rolling: optimise on a window, trade next window with frozen params. Returns concatenated OOS stats."""
    from .backtest import metrics
    rets, curve, e, windows = [], [], 1.0, []
    i = 0
    while i + train + test <= len(closes):
        seg = closes[i:i + train + test]
        r = research(seg, trials=trials, holdout_frac=test / (train + test), **kw)
        o = run(seg, r["best_params"], start=train, end=len(seg), **{k: v for k, v in kw.items() if k in ("fee", "slip")})
        for x in o["returns"]:
            e *= 1 + x; rets.append(x); curve.append(e)
        windows.append({"start": i, "sharpe": round(o["sharpe"], 3), "ret": round(o["ret"], 4)})
        i += test
    return {"windows": windows, **metrics(rets, curve), "equity": curve}
