#!/usr/bin/env bash
# Long-running paper loop. Keys via env vars only (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...). Restarts on crash.
cd "$(dirname "$0")/.." || exit 1
[ -f trader/council.json ] || cp trader/council.example.json trader/council.json
while true; do
  python3 -m trader.livecli --symbol "${SYMBOL:-BTCUSDT}" --interval "${INTERVAL:-1h}" \
    --council trader/council.json --base "${BINANCE_BASE:-https://api.binance.com}" --publish "$@"
  echo "loop exited, restarting in 30s" >&2; sleep 30
done
