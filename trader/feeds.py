"""Bar feeds. A feed yields (ts, close) for each newly CLOSED bar; history(n) returns the last n closes for warmup."""
import json, time, urllib.request

class ReplayFeed:
    def __init__(self, closes, warm=0): self.c, self.warm = closes, warm
    def history(self, n=0): return self.c[:self.warm]
    def bars(self):
        for i in range(self.warm, len(self.c)): yield i, self.c[i]

class BinanceFeed:
    """REST polling of closed klines (no key needed). Last kline in the response is the forming bar and is skipped."""
    def __init__(self, symbol="BTCUSDT", interval="1h", poll_s=30, base="https://api.binance.com"):
        self.symbol, self.interval, self.poll_s, self.base, self.last = symbol, interval, poll_s, base, None
    def _klines(self, limit):
        u = f"{self.base}/api/v3/klines?symbol={self.symbol}&interval={self.interval}&limit={limit}"
        with urllib.request.urlopen(u, timeout=15) as r: return json.load(r)[:-1]
    def history(self, n=300):
        k = self._klines(n + 1); self.last = k[-1][0]; return [float(x[4]) for x in k]
    def bars(self):
        while True:
            try:
                for k in self._klines(5):
                    if self.last is None or k[0] > self.last:
                        self.last = k[0]; yield k[0], float(k[4])
            except Exception as e:
                print("feed error:", e)
            time.sleep(self.poll_s)
