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

## Council (multi-model weighted vote) — `council.py`, `llm.py`
- Config: `trader/council.example.json` (agents, model per agent, `key_env` names). Keys via env vars only
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`...). `kind: anthropic|openai` (openai = any compatible `base_url`).
- Vote = Σ weight·confidence·score / Σ weight·confidence. Failed/junk agents abstain. Quorum, dispersion cap, risk-agent veto.
- LLM layer only tightens: `Council.gate_position(rule_pos, vote)` — can block a long, never open one.
- Weights learned only from forward paper outcomes via `settle()` (bounded 0.3–2.5, ≥20 samples, top/bottom quartile ×1.05/×0.95). Never from backtests (LLM look-ahead).
