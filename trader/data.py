"""Price data: CSV loader, optional Binance fetch, deterministic synthetic generator."""
import csv, json, math, random, urllib.request

def load_csv(path):
    """CSV with header containing 'close' (and optional 'date'/'timestamp'). Returns list of closes."""
    with open(path, newline="") as f:
        return [float(r["close"]) for r in csv.DictReader(f)]

def fetch_binance(symbol="BTCUSDT", interval="1d", limit=1000):
    url = f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}"
    with urllib.request.urlopen(url, timeout=15) as r:
        return [float(k[4]) for k in json.load(r)]

def synthetic(n=1500, seed=7, start=100.0):
    """Regime-switching GBM (trend up / chop / crash) so strategies can't win by luck of one regime."""
    rng = random.Random(seed)
    regimes = [(0.0006, 0.012), (0.0, 0.010), (-0.0010, 0.025), (0.0004, 0.015)]
    px, out, i = start, [], 0
    while len(out) < n:
        mu, sd = regimes[rng.randrange(len(regimes))]
        for _ in range(rng.randint(40, 160)):
            px *= math.exp(rng.gauss(mu, sd))
            out.append(px)
    return out[:n]
