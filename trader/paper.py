"""Paper account: replays/streams bars through the strategy, logs every decision with its context to JSONL."""
import json
from .strategy import target_position, warmup, sma, rsi

class PaperAccount:
    def __init__(self, params, cash=10_000.0, fee=0.001, slip=0.0005, log_path=None):
        self.p, self.cash, self.units, self.fee, self.slip = params, cash, 0.0, fee, slip
        self.entry, self.log_path, self.closes = None, log_path, []

    def equity(self, px):
        return self.cash + self.units * px

    def on_bar(self, px, ts=None):
        self.closes.append(px); i = len(self.closes) - 1
        want = target_position(self.closes, i, self.p, self.entry)
        action = "HOLD"
        if want and not self.units:
            self.units = self.cash * (1 - self.fee - self.slip) / px; self.cash = 0.0; self.entry = px; action = "LONG"
        elif not want and self.units:
            self.cash = self.units * px * (1 - self.fee - self.slip); self.units = 0.0; self.entry = None; action = "CLOSE"
        rec = {"ts": ts, "i": i, "px": px, "action": action, "equity": round(self.equity(px), 2)}
        if i >= warmup(self.p):
            rec["ctx"] = {"sma_fast": round(sma(self.closes, self.p["fast"], i), 2),
                          "sma_slow": round(sma(self.closes, self.p["slow"], i), 2),
                          "rsi": round(rsi(self.closes, self.p["rsi_n"], i), 1)}
        if self.log_path:
            with open(self.log_path, "a") as f:
                f.write(json.dumps(rec) + "\n")
        return rec
