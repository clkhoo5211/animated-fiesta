"""Event-loop backtest. Signal at close of bar i is executed at close of bar i (+fee+slippage), earns bar i+1 return."""
import math
from .strategy import target_position, warmup

def run(closes, p, fee=0.001, slip=0.0005, start=None, end=None):
    start = max(start or 0, 0); end = end or len(closes)
    pos, entry, equity, curve, trades = 0, None, 1.0, [], 0
    rets = []
    for i in range(start, end - 1):
        want = target_position(closes, i, p, entry) if i >= warmup(p) else 0
        if want != pos:
            equity *= 1 - (fee + slip); trades += 1
            entry = closes[i] if want else None
            pos = want
        r = pos * (closes[i + 1] / closes[i] - 1)
        equity *= 1 + r; rets.append(r); curve.append(equity)
    return {"equity": curve, "returns": rets, "trades": trades, **metrics(rets, curve)}

def metrics(rets, curve, periods=365):
    if len(rets) < 2:
        return {"sharpe": 0.0, "ret": 0.0, "maxdd": 0.0}
    m = sum(rets) / len(rets)
    sd = math.sqrt(sum((x - m) ** 2 for x in rets) / (len(rets) - 1))
    peak, dd = 1.0, 0.0
    for e in curve:
        peak = max(peak, e); dd = min(dd, e / peak - 1)
    return {"sharpe": (m / sd * math.sqrt(periods)) if sd > 0 else 0.0,
            "ret": curve[-1] - 1, "maxdd": dd}

def buy_hold(closes, start, end):
    r = [closes[i + 1] / closes[i] - 1 for i in range(start, end - 1)]
    c, e = [], 1.0
    for x in r:
        e *= 1 + x; c.append(e)
    return {"equity": c, "returns": r, **metrics(r, c)}
