"""python -m trader.livecli --symbol BTCUSDT --interval 1h [--council trader/council.json] [--publish]
Publishes trader/live_out/index.html via the here.now skill script every --publish-every bars."""
import argparse, json, os, subprocess
from .feeds import BinanceFeed
from .live import run
from .dashboard import render_live
from .council import Council, load_config

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="BTCUSDT"); ap.add_argument("--interval", default="1h")
    ap.add_argument("--params", help="JSON file with strategy params (e.g. from research best_params)")
    ap.add_argument("--base", default="https://api.binance.com", help="use https://api.binance.us from US IPs")
    ap.add_argument("--council"); ap.add_argument("--out", default="trader/live_out")
    ap.add_argument("--publish", action="store_true"); ap.add_argument("--publish-every", type=int, default=1)
    ap.add_argument("--publish-script", default=os.path.expanduser("~/.agents/skills/here-now/scripts/publish.sh"))
    a = ap.parse_args()
    params = json.load(open(a.params)) if a.params else None
    council = Council(load_config(a.council)) if a.council else None
    def on_update(state):
        open(os.path.join(a.out, "index.html"), "w").write(render_live(state))
        if a.publish and state["bars"] % a.publish_every == 0:
            subprocess.run([a.publish_script, a.out, "--client", "claude-code"], cwd=os.getcwd())
    run(BinanceFeed(a.symbol, a.interval, base=a.base), params, council, a.out, a.symbol, on_update=on_update)

if __name__ == "__main__": main()
