import unittest, tempfile, datetime as dt
from trader.polymarket import decide

NOW = dt.datetime(2026, 11, 5, 12, 0, tzinfo=dt.timezone.utc)
M = {"condition_id": "0xabc", "tick": 0.01, "neg_risk": False, "fees_enabled": True, "book_spread": 0.04,
     "depth_3c_opp": 1400, "vol_state": "LULL", "adverse_est": 0.008, "reward_exp": 0.004,
     "exit_fee_reserve": 0.004, "resolves_at": NOW + dt.timedelta(days=10)}
O = {"token": "YES", "side": "BUY", "price": 0.48, "size": 200, "order_type": "GTD", "post_only": True, "expiry_s": 90}
S = {"inventory_usd": 0, "daily_pnl_usd": 0, "adverse_ratio": 0.2}

class T(unittest.TestCase):
    def go(self, o=O, m=M, s=S):
        with tempfile.TemporaryDirectory() as d: return decide(o, m, s, NOW, outdir=d)
    def test_approved(self): self.assertTrue(self.go()["approved"])
    def test_oversized_rejected_by_depth(self): self.assertIn("G2", self.go(o={**O, "size": 1000})["vetoed_by"])
    def test_shock_vetoes(self): self.assertIn("G4", self.go(m={**M, "vol_state": "SHOCK"})["vetoed_by"])
    def test_no_gtd_rejected(self): self.assertIn("G6", self.go(o={**O, "order_type": "GTC"})["vetoed_by"])
    def test_negative_edge_rejected(self): self.assertIn("G3", self.go(m={**M, "adverse_est": 0.05})["vetoed_by"])
    def test_bad_tick(self): self.assertIn("G1", self.go(o={**O, "price": 0.485})["vetoed_by"])
    def test_kill_switch(self): self.assertIn("G5", self.go(s={**S, "adverse_ratio": 0.7})["vetoed_by"])
if __name__ == "__main__": unittest.main()
