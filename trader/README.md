# trader/ — paper-trading research toolkit (crypto + Polymarket)

Stdlib-only Python. **Paper only: no live order placement, no keys.**

- `python -m trader.cli [--binance BTCUSDT | --csv FILE] --trials 60 --walkforward` — keep/revert research loop
  (train/holdout split, holdout touched once, trial count reported), writes `trader/dist/index.html` + `research.jsonl`.
- `paper.py` — paper account with JSONL decision log. `data.py` — CSV / Binance / synthetic data.
- `polymarket.py` — gate pipeline (G1–G7) + Decision Records for market-making/spread-capture proposals;
  fee/reward/tick params must come from the API at runtime. No directional bets.
- Tests: `python -m unittest trader.tests.test_trader trader.tests.test_polymarket`

Demo output uses synthetic data (Binance/Polymarket hosts were unreachable from the build sandbox).
Tuned-vs-buy&hold results on synthetic data are not evidence of edge.
