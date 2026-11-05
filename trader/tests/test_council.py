import unittest, tempfile, os, json
from trader.council import Council, parse

def cfg(n=5):
    ag = [{"name": f"a{i}", "kind": "signal", "role": "r", "spec": {"kind": "x", "model": f"m{i}", "key_env": "K"}} for i in range(n)]
    ag[-1]["kind"] = "risk"
    return {"quorum": 3, "agents": ag}

def mk(scores, tmp, **kw):
    def caller(spec, system, user, timeout=0):
        v = scores[spec["model"]]
        if isinstance(v, Exception): raise v
        return v if isinstance(v, str) else json.dumps({"score": v, "confidence": 0.8, "rationale": "x"})
    return Council(cfg(len(scores)), os.path.join(tmp, "w.json"), os.path.join(tmp, "v.jsonl"), caller=caller)

class T(unittest.TestCase):
    def test_parse_rejects_junk(self):
        self.assertIsNone(parse("nope")); self.assertIsNone(parse('{"score": 5, "confidence": 1}'))
        self.assertEqual(parse('ok {"score":0.5,"confidence":0.9}')["score"], 0.5)
    def test_consensus_ok_and_gate(self):
        with tempfile.TemporaryDirectory() as d:
            r = mk({"m0": .6, "m1": .5, "m2": .7, "m3": .6, "m4": .4}, d).vote("ctx")
            self.assertTrue(r["council_ok"]); self.assertEqual(Council.gate_position(1, r), 1)
            self.assertEqual(Council.gate_position(0, r), 0)      # council can never open a position
    def test_risk_veto(self):
        with tempfile.TemporaryDirectory() as d:
            r = mk({"m0": .6, "m1": .6, "m2": .6, "m3": .6, "m4": -.9}, d).vote("ctx")
            self.assertFalse(r["council_ok"]); self.assertTrue(any("risk_veto" in b for b in r["blocked_by"]))
    def test_abstain_not_zero_and_quorum(self):
        with tempfile.TemporaryDirectory() as d:
            r = mk({"m0": .6, "m1": RuntimeError("down"), "m2": "garbage", "m3": .6, "m4": .5}, d).vote("ctx")
            self.assertEqual(sorted(r["abstained"]), ["a1", "a2"]); self.assertTrue(r["council_ok"])
            r2 = mk({"m0": .6, "m1": RuntimeError("x"), "m2": "g", "m3": RuntimeError("y"), "m4": .5}, d).vote("ctx")
            self.assertIn("no_quorum", r2["blocked_by"])
    def test_disagreement_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            r = mk({"m0": 1, "m1": -1, "m2": 1, "m3": -1, "m4": 0.3}, d).vote("ctx")
            self.assertIn("high_disagreement", r["blocked_by"])
    def test_weights_bounded_and_need_samples(self):
        with tempfile.TemporaryDirectory() as d:
            c = mk({"m0": .6, "m1": .6, "m2": -.6, "m3": -.6, "m4": .1, "m5": .1}, d)
            rec = {"votes": [{"agent": f"a{i}", "score": s} for i, s in enumerate([.6, .6, -.6, -.6, .1])]}
            for _ in range(MIN := 19): c.settle(rec, 0.01)
            self.assertTrue(all(s["weight"] == 1.0 for s in c.state.values()))   # <20 samples: untouched
            for _ in range(200): c.settle(rec, 0.01)
            w = {n: s["weight"] for n, s in c.state.items()}
            self.assertLessEqual(max(w.values()), 2.5); self.assertGreaterEqual(min(w.values()), 0.3)
            self.assertGreater(w["a0"], w["a2"])
if __name__ == "__main__": unittest.main()
