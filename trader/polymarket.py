"""Polymarket PAPER module: gate pipeline + Decision Records for market-making/spread-capture proposals.

No live orders, no keys. Market params (tick, fees, rewards) must come from the API at runtime -- this
module only consumes a `market` dict; it never hardcodes fee or reward values. No directional bets.
"""
import json, os, datetime as dt

RISK = {"max_order_frac_of_depth": 0.25, "min_depth_mult": 4.0, "min_hours_to_resolution": 6.0,
        "thin_hours_utc": (3, 7), "max_inventory_usd": 500.0, "daily_loss_limit_usd": 50.0,
        "adverse_kill_ratio": 0.6}

def edge_math(m, size):
    """net = 0.5*spread + rebate + reward - adverse - exit_fee_reserve (all per-share, inputs from market dict)."""
    e = {"half_spread": 0.5 * m["book_spread"], "rebate_exp": m.get("rebate_exp", 0.0),
         "reward_exp": m.get("reward_exp", 0.0), "adverse_est": m["adverse_est"],
         "exit_fee_reserve": m.get("exit_fee_reserve", 0.0)}
    e["net"] = round(e["half_spread"] + e["rebate_exp"] + e["reward_exp"] - e["adverse_est"] - e["exit_fee_reserve"], 5)
    return e

def run_gates(order, m, state, now):
    g, veto = {}, []
    def gate(k, ok, note=""):
        g[k] = ("pass" if ok else "FAIL") + (f":{note}" if note else "")
        if not ok: veto.append(k)
    gate("G1", all(k in m for k in ("tick", "neg_risk", "fees_enabled", "book_spread")) and
         abs(round(order["price"] / m["tick"]) * m["tick"] - order["price"]) < 1e-9, "tick/params")
    d = m["depth_3c_opp"]
    gate("G2", d >= RISK["min_depth_mult"] * order["size"] and order["size"] <= RISK["max_order_frac_of_depth"] * d,
         f"{d}/{order['size']}")
    e = edge_math(m, order["size"]); gate("G3", e["net"] > 0, f"{e['net']:+.4f}")
    hrs = (m["resolves_at"] - now).total_seconds() / 3600
    lo, hi = RISK["thin_hours_utc"]
    gate("G4", hrs >= RISK["min_hours_to_resolution"] and not (lo <= now.hour < hi) and m["vol_state"] != "SHOCK",
         f"{hrs:.1f}h,{m['vol_state']}")
    notional = order["price"] * order["size"]
    gate("G5", state["inventory_usd"] + notional <= RISK["max_inventory_usd"] and
         state["daily_pnl_usd"] > -RISK["daily_loss_limit_usd"] and
         state["adverse_ratio"] < RISK["adverse_kill_ratio"] and not state.get("kill"), "risk state")
    gate("G6", order["order_type"] == "GTD" and order.get("post_only") and order["expiry_s"] >= 60, "GTD/post-only")
    return g, veto, e

def decide(order, m, state, now=None, outdir=".learnings/polymarket/decisions", params_version="lp-0"):
    now = now or dt.datetime.now(dt.timezone.utc)
    g, veto, e = run_gates(order, m, state, now)
    rec = {"ts": now.isoformat(), "condition_id": m["condition_id"], "token": order["token"], "side": order["side"],
           "price": order["price"], "size": order["size"], "order_type": order["order_type"],
           "strategy": order.get("strategy", "MM"), "market_state": {k: m[k] for k in ("book_spread", "depth_3c_opp", "vol_state")},
           "edge_math": e, "gates": g, "vetoed_by": veto, "params_version": params_version, "mode": "paper",
           "outcome": None}
    os.makedirs(outdir, exist_ok=True)           # G7: no record, no order
    with open(os.path.join(outdir, now.strftime("%Y-%m-%d") + ".jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")
    rec["approved"] = not veto
    return rec

def adverse_fill_ratio(fills, thr=0.0):
    """fills: [{'drift_60s': signed price move against us}]; ratio of fills followed by adverse drift."""
    if not fills: return 0.0
    return sum(f["drift_60s"] < -thr for f in fills) / len(fills)
