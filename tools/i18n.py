"""Export / apply translation review sheets for site/index.html.

  python tools/i18n.py export ms docs/i18n/ms-review.csv   # sheet for a reviewer
  python tools/i18n.py apply  ms docs/i18n/ms-review.csv   # write the "suggested" column back

The reviewer fills only the "suggested" column (leave blank to keep the current text).
Keep {placeholders} such as {n} or {f} unchanged.
"""
import csv, json, re, subprocess, sys
from pathlib import Path

SITE = Path(__file__).resolve().parents[1] / "site" / "index.html"
JS = r"""const s=require('fs').readFileSync(process.argv[1],'utf8');const a=s.indexOf('const I18N=');const b=s.indexOf('let LANG=',a);
eval(s.slice(a,b).replace('const I18N=','globalThis.I18N='));process.stdout.write(JSON.stringify(I18N))"""


def load():
    return json.loads(subprocess.check_output(["node", "-e", JS, str(SITE)]))


def export(lang, out):
    d = load()
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["key", "english", "current", "suggested", "notes"])
        for k, en in d["en"].items():
            w.writerow([k, en, d[lang].get(k, ""), "", ""])
    print(f"wrote {len(d['en'])} rows to {out}")


def apply(lang, sheet):
    s = SITE.read_text(encoding="utf-8")
    a = s.index(f"\n{lang}:{{", s.index("const I18N="))
    b = s.index("\n}", a)
    block = s[a:b]
    n = 0
    for row in csv.DictReader(open(sheet, encoding="utf-8-sig")):
        new = (row.get("suggested") or "").strip()
        if not new or new == row["current"]:
            continue
        ph_old, ph_new = sorted(re.findall(r"\{\w+\}", row["english"])), sorted(re.findall(r"\{\w+\}", new))
        if ph_old != ph_new:
            sys.exit(f"{row['key']}: placeholders {ph_new} must match {ph_old}")
        pat = re.compile(r'([,{\s])' + re.escape(row["key"]) + r':"((?:[^"\\]|\\.)*)"')
        block, k = pat.subn(lambda m: f'{m.group(1)}{row["key"]}:{json.dumps(new, ensure_ascii=False)}', block, count=1)
        n += k
    SITE.write_text(s[:a] + block + s[b:], encoding="utf-8")
    print(f"applied {n} change(s) to {lang}")


if __name__ == "__main__":
    cmd, lang, path = sys.argv[1:4]
    {"export": export, "apply": apply}[cmd](lang, path)
