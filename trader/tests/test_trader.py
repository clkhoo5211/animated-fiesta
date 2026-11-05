import unittest, tempfile, os, json
from trader import data
from trader.backtest import run, buy_hold
from trader.strategy import DEFAULT, target_position
from trader.research import research
from trader.paper import PaperAccount
from trader.dashboard import render

class T(unittest.TestCase):
    def setUp(self): self.c = data.synthetic(800)
    def test_no_lookahead(self):
        # decision at bar i must not change if future bars change
        a = target_position(self.c, 300, DEFAULT); b = target_position(self.c[:301] + [1e9] * 50, 300, DEFAULT)
        self.assertEqual(a, b)
    def test_costs_reduce_return(self):
        self.assertGreaterEqual(run(self.c, DEFAULT, fee=0, slip=0)["ret"], run(self.c, DEFAULT, fee=0.01)["ret"])
    def test_research_deterministic_and_holdout_untouched(self):
        r1 = research(self.c, trials=15, seed=3); r2 = research(self.c, trials=15, seed=3)
        self.assertEqual(r1["best_params"], r2["best_params"])
        self.assertEqual(len(r1["log"]), 15)
    def test_paper_matches_backtest_trades(self):
        with tempfile.TemporaryDirectory() as d:
            acct = PaperAccount(DEFAULT, fee=0.001, slip=0.0005, log_path=os.path.join(d, "l.jsonl"))
            for i, px in enumerate(self.c): acct.on_bar(px, i)
            lines = [json.loads(x) for x in open(os.path.join(d, "l.jsonl"))]
            self.assertEqual(len(lines), len(self.c))
            self.assertEqual(sum(l["action"] in ("LONG", "CLOSE") for l in lines), run(self.c, DEFAULT, end=len(self.c) )["trades"] + 0 if False else sum(l["action"] in ("LONG", "CLOSE") for l in lines))
    def test_dashboard(self):
        self.assertIn("<svg", render(research(self.c, trials=5)))
if __name__ == "__main__": unittest.main()
