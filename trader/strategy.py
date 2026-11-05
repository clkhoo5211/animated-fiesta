"""Parametric long/flat trend+RSI strategy. Params are the thing the research loop mutates."""
DEFAULT = {"fast": 10, "slow": 50, "rsi_n": 14, "rsi_max": 75, "stop": 0.08}
BOUNDS = {"fast": (2, 60), "slow": (10, 250), "rsi_n": (5, 30), "rsi_max": (55, 95), "stop": (0.02, 0.30)}

def sma(xs, n, i):
    return sum(xs[i - n + 1:i + 1]) / n

def rsi(xs, n, i):
    gains = losses = 0.0
    for j in range(i - n + 1, i + 1):
        d = xs[j] - xs[j - 1]
        gains += max(d, 0); losses += max(-d, 0)
    return 100.0 if losses == 0 else 100 - 100 / (1 + gains / losses)

def warmup(p):
    return max(p["slow"], p["rsi_n"]) + 1

def target_position(closes, i, p, entry_px=None):
    """Decision using data up to and including bar i. Returns 1 (long) or 0 (flat)."""
    if i < warmup(p) or p["fast"] >= p["slow"]:
        return 0
    if entry_px and closes[i] < entry_px * (1 - p["stop"]):
        return 0
    trend = sma(closes, p["fast"], i) > sma(closes, p["slow"], i)
    return 1 if trend and rsi(closes, p["rsi_n"], i) < p["rsi_max"] else 0
