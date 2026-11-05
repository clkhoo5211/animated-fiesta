"""python -m trader.cli [--csv FILE | --binance SYMBOL] [--trials N] [--out site_dir]"""
import argparse, json, os
from . import data
from .research import research, walk_forward
from .dashboard import render

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv"); ap.add_argument("--binance")
    ap.add_argument("--trials", type=int, default=60); ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="trader/dist"); ap.add_argument("--walkforward", action="store_true")
    a = ap.parse_args()
    if a.csv: closes, src = data.load_csv(a.csv), a.csv
    elif a.binance: closes, src = data.fetch_binance(a.binance), f"Binance {a.binance} 1d"
    else: closes, src = data.synthetic(), "synthetic regime-switching data (demo)"
    os.makedirs(a.out, exist_ok=True)
    r = research(closes, trials=a.trials, seed=a.seed, log_path=os.path.join(a.out, "research.jsonl"))
    with open(os.path.join(a.out, "index.html"), "w") as f: f.write(render(r, source=src))
    print(json.dumps({k: r[k] for k in ("trials", "kept", "best_params", "holdout", "holdout_default_params", "holdout_buy_hold")}, indent=2))
    if a.walkforward:
        w = walk_forward(closes, trials=min(a.trials, 40))
        print("walk-forward OOS:", {k: round(w[k], 3) for k in ("sharpe", "ret", "maxdd")}, "windows:", len(w["windows"]))

if __name__ == "__main__": main()
