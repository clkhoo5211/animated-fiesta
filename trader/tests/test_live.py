import unittest, tempfile, json, os
from trader import data
from trader.feeds import ReplayFeed
from trader.live import run
from trader.council import Council
from trader.dashboard import render_live

def council(tmp, score):
    ag = [{"name": f"a{i}", "kind": "signal", "role": "r", "spec": {"kind": "x", "model": f"m{i}", "key_env": "K"}} for i in range(3)]
    caller = lambda spec, sys, user, timeout=0: json.dumps({"score": score, "confidence": 0.9, "rationale": "t"})
    return Council({"quorum": 2, "agents": ag}, os.path.join(tmp, "w.json"), os.path.join(tmp, "v.jsonl"), caller=caller)

class T(unittest.TestCase):
    def setUp(self): self.c = data.synthetic(700)
    def test_runs_without_council(self):
        with tempfile.TemporaryDirectory() as d:
            acct, ev = run(ReplayFeed(self.c, warm=300), outdir=d)
            self.assertEqual(len(ev), 400); self.assertTrue(os.path.exists(os.path.join(d, "state.json")))
    def test_council_can_only_block(self):
        with tempfile.TemporaryDirectory() as d:
            _, base = run(ReplayFeed(self.c, warm=300), outdir=d + "/a")
            _, bear = run(ReplayFeed(self.c, warm=300), council=council(d, -0.8), outdir=d + "/b")
            _, bull = run(ReplayFeed(self.c, warm=300), council=council(d, 0.8), outdir=d + "/c")
            self.assertTrue(all(e["action"] != "LONG" for e in bear))          # bearish council: never opens
            longs = lambda ev: sum(e["action"] == "LONG" for e in ev)
            self.assertLessEqual(longs(bull), longs(base))                     # never more than the rule alone
            self.assertGreater(longs(base), 0)
    def test_settle_feeds_weights(self):
        with tempfile.TemporaryDirectory() as d:
            c = council(d, 0.8); run(ReplayFeed(self.c, warm=300), council=c, outdir=d + "/x")
            self.assertTrue(any(len(s["hist"]) > 0 for s in c.state.values()))
    def test_render(self):
        with tempfile.TemporaryDirectory() as d:
            run(ReplayFeed(self.c, warm=300), outdir=d, max_bars=50)
            self.assertIn("PAPER ONLY", render_live(json.load(open(os.path.join(d, "state.json")))))
if __name__ == "__main__": unittest.main()
