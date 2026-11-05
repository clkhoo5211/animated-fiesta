"""Central orchestrator: runs heterogeneous-model agents in parallel, weighted vote, learned weights.

Principles (from the Polymarket skill + lessons from atlas-gic):
- The LLM layer is ADVISORY and may only TIGHTEN: final_position = rule_position AND council_ok. It can never open a position.
- Agents that fail/timeout/return junk ABSTAIN (excluded from the vote, not counted as 0).
- Weights are learned ONLY from forward (live/paper) outcomes -- never from historical backtests, because LLMs
  may have seen the outcomes (look-ahead contamination). Bounded [0.3, 2.5]; no change before MIN_SAMPLES.
- Risk-kind agents hold veto power. High disagreement => no trade.
"""
import json, os, re, time
from concurrent.futures import ThreadPoolExecutor
from . import llm

W_MIN, W_MAX, MIN_SAMPLES = 0.3, 2.5, 20

SYSTEM = ("You are one member of a trading research council. Reply with ONLY a JSON object: "
          '{"score": number in [-1,1] (bearish..bullish over the stated horizon), "confidence": number in [0,1], '
          '"rationale": "<=40 words"}. Judge only from the provided context; do not invent data.')

def parse(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m: return None
    try:
        d = json.loads(m.group(0)); s, c = float(d["score"]), float(d["confidence"])
    except Exception:
        return None
    if not (-1 <= s <= 1 and 0 <= c <= 1): return None
    return {"score": s, "confidence": c, "rationale": str(d.get("rationale", ""))[:300]}

class Council:
    def __init__(self, cfg, weights_path="trader/weights.json", log_path="trader/votes.jsonl", caller=llm.call):
        self.cfg, self.caller, self.log_path, self.weights_path = cfg, caller, log_path, weights_path
        self.state = json.load(open(weights_path)) if os.path.exists(weights_path) else {}
        for a in cfg["agents"]:
            self.state.setdefault(a["name"], {"weight": a.get("weight", 1.0), "hist": []})

    def _ask(self, a, context):
        t0 = time.time()
        try:
            out = parse(self.caller(a["spec"], SYSTEM + "\nRole: " + a["role"], context, timeout=a.get("timeout", 60)))
            err = None if out else "unparseable"
        except Exception as e:
            out, err = None, str(e)
        return {"agent": a["name"], "model": a["spec"]["model"], "kind": a.get("kind", "signal"),
                "out": out, "err": err, "ms": int((time.time() - t0) * 1000)}

    def vote(self, context, ts=None):
        c = self.cfg
        with ThreadPoolExecutor(max_workers=len(c["agents"])) as ex:
            res = list(ex.map(lambda a: self._ask(a, context), c["agents"]))
        live = [r for r in res if r["out"]]
        for r in live: r["weight"] = self.state[r["agent"]]["weight"]
        den = sum(r["weight"] * r["out"]["confidence"] for r in live)
        score = sum(r["weight"] * r["out"]["confidence"] * r["out"]["score"] for r in live) / den if den else 0.0
        disp = (sum(r["weight"] * (r["out"]["score"] - score) ** 2 for r in live) / sum(r["weight"] for r in live)) ** 0.5 if live else 1.0
        veto = [r["agent"] for r in live if r["kind"] == "risk" and r["out"]["score"] <= -c.get("veto_score", 0.5)]
        why = []
        if len(live) < c.get("quorum", 2): why.append("no_quorum")
        if veto: why.append("risk_veto:" + ",".join(veto))
        if disp > c.get("max_dispersion", 0.6): why.append("high_disagreement")
        if score < c.get("long_threshold", 0.2): why.append("score_below_threshold")
        rec = {"ts": ts or time.time(), "score": round(score, 4), "dispersion": round(disp, 4),
               "council_ok": not why, "blocked_by": why, "abstained": [r["agent"] for r in res if not r["out"]],
               "votes": [{"agent": r["agent"], "model": r["model"], "kind": r["kind"], **(r["out"] or {"error": r["err"]}),
                          "weight": r.get("weight")} for r in res]}
        os.makedirs(os.path.dirname(self.log_path) or ".", exist_ok=True)
        with open(self.log_path, "a") as f: f.write(json.dumps(rec) + "\n")
        return rec

    @staticmethod
    def gate_position(rule_position, rec):
        """Asymmetry rule: council can only reduce exposure."""
        return 1 if (rule_position == 1 and rec["council_ok"]) else 0

    def settle(self, rec, forward_return):
        """Record realized forward return for a past vote; update weights once enough samples exist."""
        sign = 1 if forward_return > 0 else -1 if forward_return < 0 else 0
        for v in rec["votes"]:
            if "score" in v and sign:
                self.state[v["agent"]]["hist"].append(1 if v["score"] * sign > 0 else 0)
        self._reweight(); self.save()

    def _reweight(self):
        stats = {n: sum(s["hist"][-50:]) / len(s["hist"][-50:]) for n, s in self.state.items() if len(s["hist"]) >= MIN_SAMPLES}
        if len(stats) < 4: return                       # need a population to rank against
        ranked = sorted(stats, key=stats.get); q = max(1, len(ranked) // 4)
        for n in ranked[:q]: self.state[n]["weight"] = max(W_MIN, self.state[n]["weight"] * 0.95)
        for n in ranked[-q:]: self.state[n]["weight"] = min(W_MAX, self.state[n]["weight"] * 1.05)

    def save(self):
        with open(self.weights_path, "w") as f: json.dump(self.state, f, indent=1)

def load_config(path): return json.load(open(path))
