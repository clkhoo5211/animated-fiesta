"""Parity + behaviour checks for the browser port (needs node). Run: python3 trader/tests/web_parity.py"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from trader import data
from trader.paper import PaperAccount
from trader.strategy import DEFAULT

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
c = data.synthetic(900, seed=11)
a = PaperAccount(DEFAULT)
py = [a.on_bar(x, i)["equity"] for i, x in enumerate(c)]

js = f"""
const T=require('{WEB}/core.js'), C=require('{WEB}/council.js');
const closes={json.dumps(c)};
const r=T.replay(closes), rb=T.replay(closes,T.DEFAULT,()=>true);
const mk=s=>async(a,ctx)=>JSON.stringify({{score:s[a.name],confidence:0.9,rationale:'t'}});
(async()=>{{
 const cfg={{quorum:2,agents:[{{name:'a',kind:'signal'}},{{name:'b',kind:'signal'}},{{name:'r',kind:'risk'}}]}};
 const ok=await C.vote(cfg,{{}},'x',mk({{a:.6,b:.5,r:.2}}));
 const veto=await C.vote(cfg,{{}},'x',mk({{a:.6,b:.6,r:-.9}}));
 const junk=await C.vote(cfg,{{}},'x',async a=>a.name==='a'?'garbage':JSON.stringify({{score:.6,confidence:.9}}));
 console.log(JSON.stringify({{eq:r.equity,blockedLongs:rb.events.filter(e=>e.action==='LONG').length,ok:ok.council_ok,veto:veto.blocked_by,junk:junk.votes.filter(v=>v.error).length}}));
}})();
"""
out = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
diff = max(abs(x - y) for x, y in zip(py, out["eq"]))
assert len(out["eq"]) == len(py) and diff < 0.01, diff
assert out["blockedLongs"] == 0 and out["ok"] and out["veto"][0].startswith("risk_veto") and out["junk"] == 1
print("OK parity max diff", diff)
