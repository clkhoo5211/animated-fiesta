import asyncio, csv, json, re, sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
import invoicelens as il  # noqa: E402

FIX = ROOT / "tests" / "fixtures"


def invoice(**over):
    r = {"document_type": "invoice", "document_number": "INV-TEST-0001", "document_date": "01/10/2026", "currency": "RM", "grand_total": "224.76",
         "parties": [{"role": "supplier", "name": "DEMO TRADING SDN BHD"}],
         "tables": [{"name": "Items", "columns": [{"name": "Item", "role": "text"}, {"name": "Qty", "role": "qty"}, {"name": "Unit Price", "role": "unit_price"}, {"name": "Amount", "role": "amount"}],
                     "rows": [["Widget A", "6", "20.86", "125.16"], ["Widget B", "10", "4.96", "49.60"], ["Service", "1", "50.00", "50.00"]], "total_row": [None, None, None, "224.76"], "printed_row_count": "3"}],
         "low_confidence_fields": []}
    r.update(over)
    return r


class FakeLLM:
    """httpx transport that answers like an OpenAI-compatible / Anthropic endpoint."""
    def __init__(self, handler):
        self.handler, self.calls = handler, []

    def __call__(self, request: httpx.Request):
        body = json.loads(request.content)
        content = body["messages"][0]["content"]
        text = next(c["text"] for c in content if c["type"] == "text")
        doc = (re.search(r"<<<DOCUMENT\n([\s\S]*?)\nDOCUMENT>>>", text) or [None, None])[1]
        call = {"url": str(request.url), "model": body["model"], "images": sum(c["type"] in ("image_url", "image") for c in content),
                "doc": doc, "json_mode": "response_format" in body, "auth": request.headers.get("authorization") or request.headers.get("x-api-key")}
        self.calls.append(call)
        out = self.handler(call)
        if "error" in out:
            return httpx.Response(500, json={"error": {"message": out["error"]}})
        if "anthropic" in call["url"]:
            return httpx.Response(200, json={"content": [{"type": "text", "text": json.dumps(out)}], "usage": {"input_tokens": 2000, "output_tokens": 500}})
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(out)}}], "usage": {"prompt_tokens": 10000, "completion_tokens": 1000}})

    @property
    def transport(self):
        return httpx.MockTransport(self)


def test_prompt_matches_web_app():
    s = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    i = s.index("const PROMPT=`") + len("const PROMPT=`")
    assert il.PROMPT == s[i:s.index("`;", i)], "Python PROMPT drifted from site/index.html — copy it over"


@pytest.mark.parametrize("name,n,kind", [("invoice.jpg", 1, "image"), ("invoice.pdf", 1, "image"), ("photo.heic", 1, "image"),
                                          ("sheet.xlsx", 2, "text"), ("data.csv", 1, "text"), ("quote.docx", 1, "text")])
def test_ingest_formats(name, n, kind):
    segs = il.ingest(FIX / name)
    assert len(segs) == n and all(s.kind == kind for s in segs)
    if kind == "image":
        assert il.b64_image(segs[0].b64).size[0] > 100
    if name == "quote.docx":
        assert "[TABLE]" in segs[0].text and "Hosting | 12 | 600.00" in segs[0].text
    if name == "sheet.xlsx":
        assert "Widget A | 2 | 10.5 | 21" in segs[0].text


def test_unsupported_and_rotation():
    assert il.kind_of(FIX / "note.txt") is None
    w, h = il.b64_image(il.ingest(FIX / "invoice.jpg")[0].b64).size
    assert il.b64_image(il.ingest(FIX / "invoice.jpg", rotate=90)[0].b64).size == (h, w)


def test_local_qr_decoding():
    codes = il.local_codes(il.ingest(FIX / "invoice.jpg")[0])["qr_and_barcodes"]
    assert any(c["data"] == "INV-TEST-0001|TOTAL=224.76" for c in codes)


def test_verify_rules():
    assert il.verify(invoice())["passed"]
    bad = invoice(); bad["tables"][0]["rows"][1][3] = "49.06"
    codes = {c["code"]: c for c in il.verify(bad)["checks"] if not c["ok"]}
    assert {"amount", "colsum", "grand"} <= set(codes) and codes["amount"]["row"] == 1
    reg = {"tables": [{"columns": [{"name": "CTN-1", "role": "number"}, {"name": "Total", "role": "row_total"}], "rows": [["1", "2"], ["22", "22"]], "total_row": ["23", "25"], "printed_row_count": "3"}]}
    fails = [c["code"] for c in il.verify(reg)["checks"] if not c["ok"]]
    assert "rowsum" in fails and "rowcount" in fails and "colsum" in fails


def test_compare_flags_mismatch():
    b = invoice(); b["parties"][0]["name"] = "DEMO TRADING SDN BHO"
    cv = il.compare(invoice(), b)
    assert [d["field"] for d in cv["discrepancies"]] == ["parties.0.name"] and cv["agreement_rate"] > 0.9


def test_reconcile_rules():
    reg = {"source_document": "reg.csv", "segments": [{"final_result": {"document_type": "invoice_register", "document_number": "SHIP-77", "tables": [{
        "columns": [{"name": "Name"}, {"name": "Invoice Date"}, {"name": "Invoice No."}],
        "rows": [["A", "01/10/2026", "INV-1001"], ["B", "01/10/2026", "INV-1002"], ["C", "02/10/2026", "INV-1003"], ["D", "02/10/2026", "INV-1004"]]}]}}]}
    inv = lambda f, no, d: {"source_document": f, "segments": [{"final_result": invoice(document_number=no, document_date=d)}]}
    rc = il.reconcile([reg, inv("a.jpg", "INV-1001", "1/10/2026"), inv("b.jpg", "INV-1002", "05/10/2026"), inv("c.jpg", "INV-10O3", "02/10/2026"),
                       inv("d.jpg", "INV-9999", "03/10/2026"), inv("e.jpg", "INV-9999", "03/10/2026")])
    assert [r["status"] for r in rc["registers"][0]["rows"]] == ["ok", "date_mismatch", "possible_match", "missing"]
    assert {x["file"] for x in rc["extra"]} == {"d.jpg", "e.jpg"}
    assert rc["duplicates"] == [{"no": "INV-9999", "files": ["d.jpg", "e.jpg"]}]


def test_cli_end_to_end(tmp_path):
    reg_json = {"document_type": "invoice_register", "document_number": "SHIP-77", "tables": [{"name": "Orders",
        "columns": [{"name": "Name", "role": "text"}, {"name": "Invoice Date", "role": "date"}, {"name": "Invoice No.", "role": "id"}],
        "rows": [["SHOP ALPHA", "01/10/2026", "INV-TEST-0001"], ["SHOP BETA", "01/10/2026", "INV-1002"]]}]}
    llm = FakeLLM(lambda c: reg_json if c["doc"] and "Invoice No." in c["doc"] else invoice())
    files = [FIX / "register.csv", FIX / "invoice.jpg", FIX / "invoice.jpg", FIX / "note.txt"]
    code = il.main([*map(str, files), "--a-base", "https://relay.test/relay/v1/models", "--a-key", "k-a", "--a-model", "vision-x", "--b-key", "",
                    "--tiles", "--out", str(tmp_path)], transport=llm.transport)
    assert code == 0
    assert all(c["url"] == "https://relay.test/relay/v1/chat/completions" and c["auth"] == "Bearer k-a" for c in llm.calls)
    assert sorted(c["images"] for c in llm.calls) == [0, 3]  # CSV as text; image with full page + 2 tiles; duplicate jpg not sent
    summary = list(csv.DictReader(open(tmp_path / "summary.csv", encoding="utf-8-sig")))
    notes = {r["file"]: (r["status"], r["note"]) for r in summary}
    assert notes["note.txt"][1] == "unsupported file type" and "identical to invoice.jpg" in [r["note"] for r in summary if r["file"] == "invoice.jpg"][1]
    recon = list(csv.DictReader(open(tmp_path / "reconcile.csv", encoding="utf-8-sig")))
    assert [r["status"] for r in recon] == ["ok", "missing"]
    data = json.loads((tmp_path / "results.json").read_text())
    assert data["documents"][1]["segments"][0]["final_result"]["document_number"] == "INV-TEST-0001"


def test_anthropic_and_ab_cross_check(tmp_path):
    def handler(c):
        r = invoice()
        if "anthropic" in c["url"]:
            r["parties"][0]["name"] = "DEMO TRADING SDN BHO"
        return r
    llm = FakeLLM(handler)
    il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--a-no-json", "--b-key", "kb", "--b-type", "anthropic", "--out", str(tmp_path)], transport=llm.transport)
    assert {("anthropic" in c["url"], c["json_mode"]) for c in llm.calls} == {(False, False), (True, False)}
    seg = json.loads((tmp_path / "results.json").read_text())["documents"][0]["segments"][0]
    assert seg["cross_verification"]["discrepancies"][0]["field"] == "parties.0.name"
    assert json.loads((tmp_path / "results.json").read_text())["documents"][0]["status"] == "warn"


def test_model_error_and_no_key_local_parse(tmp_path):
    llm = FakeLLM(lambda c: {"error": "invalid request"})
    assert il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--b-key", "", "--out", str(tmp_path / "e")], transport=llm.transport) == 1
    il.main([str(FIX / "data.csv"), "--a-key", "", "--b-key", "", "--out", str(tmp_path / "l")])
    seg = json.loads((tmp_path / "l" / "results.json").read_text())["documents"][0]["segments"][0]
    assert seg["final_result"]["model"] == "local" and seg["checks"]["model_a"]["passed"]


def test_text_pdf_sent_as_text_and_usage_reported(tmp_path):
    segs = il.ingest(FIX / "text-invoice.pdf")
    assert segs[0].text_only and segs[0].b64 and "INV-TEXT-0002" in segs[0].text
    assert not il.ingest(FIX / "text-invoice.pdf", pdf_text="image")[0].text_only
    assert not il.ingest(FIX / "invoice.pdf")[0].text_only          # scanned PDF has no text layer
    llm = FakeLLM(lambda c: invoice(document_number="INV-TEXT-0002"))
    il.main([str(FIX / "text-invoice.pdf"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--b-key", "", "--out", str(tmp_path)], transport=llm.transport)
    assert llm.calls[0]["images"] == 0 and "INV-TEXT-0002" in llm.calls[0]["doc"]
    row = next(csv.DictReader(open(tmp_path / "summary.csv", encoding="utf-8-sig")))
    assert (row["tokens_in"], row["tokens_out"]) == ("10000", "1000")
    seg = json.loads((tmp_path / "results.json").read_text())["documents"][0]["segments"][0]
    assert seg["usage"]["model_a"] == {"in": 10000, "out": 1000} and "__usage" not in seg["final_result"]


def test_retries_temporary_errors(monkeypatch):
    monkeypatch.setattr(il, "RETRY_DELAYS", [0, 0])
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(504, json={"error": {"message": "queue wait exceeded"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}]})

    async def run(h):
        async with httpx.AsyncClient(transport=httpx.MockTransport(h)) as client:
            return await il.call_model(client, il.ModelConfig(type="openai", base="https://relay.test/v1", key="k", model="m"), "hi", None)

    assert asyncio.run(run(handler)) == {"ok": True} and len(calls) == 3
    calls.clear()
    with pytest.raises(il.HTTPStatusError):
        asyncio.run(run(lambda req: (calls.append(1), httpx.Response(401, json={}))[1]))
    assert len(calls) == 1  # non-temporary errors fail immediately


def test_max_tokens_default_and_length_error():
    seen = []

    def handler(req):
        seen.append(json.loads(req.content)["max_tokens"])
        return httpx.Response(200, json={"choices": [{"finish_reason": "length", "message": {"content": ""}}]})

    async def run(cfg):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await il.call_model(client, cfg, "hi", None)

    with pytest.raises(RuntimeError, match="used all 32000"):
        asyncio.run(run(il.ModelConfig(base="https://relay.test/v1", key="k", model="m")))
    with pytest.raises(RuntimeError, match="used all 65536"):
        asyncio.run(run(il.ModelConfig(base="https://relay.test/v1", key="k", model="m", max_tokens=65536)))
    assert seen == [32000, 65536]


def test_cross_checks_and_unrelated_register():
    r = {"document_date": "23/9/2026", "parties": [{"role": "ship_to", "address": "2346 JH TMN SKUDAI INDAH"}],
         "stamps_and_chops": [{"text": "SPEED MART (2348) JH"}], "handwritten_notes": [{"text": "BC 26/4/26 1:50pm"}], "tables": []}
    v = il.verify(r)
    assert v["passed"] and {c["code"] for c in v["checks"] if not c["ok"]} == {"notedate", "stampno"}
    reg = {"source_document": "reg.jpg", "segments": [{"final_result": {"document_type": "invoice_register", "tables": [{
        "columns": [{"name": "Ship-To"}, {"name": "Name"}, {"name": "Invoice No."}],
        "rows": [["1009135", "WATSONS", "1561454467"], ["1009215", "WATSONS 2", "1561454438"]]}]}}]}
    inv = {"source_document": "inv.jpg", "segments": [{"final_result": {"document_number": "A260907007"}}]}
    rc = il.reconcile([reg, inv])
    assert rc["registers"][0]["related"] is False and rc["extra"] == []
    assert rc["registers"][0]["rows"][0]["name"] == "WATSONS" and rc["registers"][0]["rows"][0]["status"] == "not_uploaded"


def test_format_checks():
    r = {"document_date": "23/9/2026", "handwritten_notes": [{"text": "2uc 6m) 2c 26/4/26 1:50pm"}], "tables": [],
         "parties": [{"name": "FRIZZ", "tax_id": "TIN:C685068310", "contact": "email: frizz@po.jarving.my"}, {"name": "OK", "tax_id": "TIN:C68506831100"}, {"name": "OK10", "tax_id": "TIN:C6850683100"}],
         "fields": [{"label": "Ref 1", "value": "2uc 6m) 2c 26/4/26 1:50pm"}, {"label": "Customer Account", "value": "NO10"}]}
    bad = {c["code"]: c for c in il.verify(r)["checks"] if not c["ok"]}
    assert {"hwfield", "tin", "email", "o0", "notedate"} <= set(bad)
    assert bad["email"]["k"] == "jaring.my" and bad["o0"]["s"] == "N010" and bad["tin"]["n"] == 9


def test_items_extracted_as_totals():
    r = {"grand_total": "384.00", "tables": [], "totals": [{"label": "Total Price", "value": v} for v in ("125.16", "49.60", "124.92", "84.32")]}
    bad = [c for c in il.verify(r)["checks"] if c["code"] == "itemstot"]
    assert bad and bad[0]["n"] == 4 and bad[0]["sum"] == 384.0
    ok = {"grand_total": "110", "tables": [], "totals": [{"label": "Subtotal", "value": "100"}, {"label": "SST", "value": "10"}, {"label": "Total", "value": "110"}]}
    assert not [c for c in il.verify(ok)["checks"] if c["code"] == "itemstot"]


def test_straighten_lastrow_capacity_retry(monkeypatch):
    # last row holding the totals line
    reg = {"tables": [{"columns": [{"name": "Name"}, {"name": "CTN-1", "role": "number"}, {"name": "CTN-2", "role": "number"}, {"name": "Total", "role": "row_total"}],
                       "rows": [["A", "1", "", "1"], ["B", "22", "6", "28"], ["C", "4", "1", "5"], ["T", "39", "17", "56"]], "total_row": [None, "0", "0", "0"]}]}
    assert [c for c in il.verify(reg)["checks"] if c["code"] == "lastrow"]
    # an old date in a signature is not a misread receiving date
    r = {"document_date": "23/09/2026", "tables": [], "handwritten_notes": [{"text": "3.9.16"}]}
    assert not [c for c in il.verify(r)["checks"] if c["code"] == "notedate"]
    # relay capacity message is retried
    monkeypatch.setattr(il, "RETRY_DELAYS", [0, 0])
    n = []

    def handler(req):
        n.append(1)
        if len(n) == 1:
            return httpx.Response(500, json={"error": {"message": "Chat admission capacity is temporarily unavailable. Retry shortly."}})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await il.call_model(client, il.ModelConfig(base="https://relay.test/v1", key="k", model="m"), "hi", None)
    assert asyncio.run(run()) == {"ok": True} and len(n) == 2


def test_auto_straighten(tmp_path):
    seen = []

    def handler(req):
        seen.append(1)
        doc = {"document_type": "invoice", "document_number": "INV-1", "rotation_degrees": "90" if len(seen) == 1 else "0", "tables": []}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(doc)}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
    il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--b-key", "", "--out", str(tmp_path)], transport=httpx.MockTransport(handler))
    res = json.loads((tmp_path / "results.json").read_text())["documents"][0]["segments"][0]
    assert len(seen) == 2 and res["straightened"] == 90 and res["usage"]["model_a"] == {"in": 20, "out": 10}


def test_broken_sums_retry_rotated(tmp_path):
    seen = []

    def handler(req):
        seen.append(1)
        rows = [["A", "2"], ["B", "3"]] if len(seen) == 1 else [["A", "4"], ["B", "5"]]
        doc = {"document_type": "invoice_register", "rotation_degrees": "0", "tables": [{"name": "R", "columns": [{"name": "Name", "role": "text"}, {"name": "CTN", "role": "number"}], "rows": rows, "total_row": [None, "9"]}]}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(doc)}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
    il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--b-key", "", "--out", str(tmp_path)], transport=httpx.MockTransport(handler))
    res = json.loads((tmp_path / "results.json").read_text())["documents"][0]["segments"][0]
    assert len(seen) == 2 and res["straightened"] == 90 and res["final_result"]["tables"][0]["rows"][0] == ["A", "4"]
    assert res["usage"]["model_a"] == {"in": 20, "out": 10}


def test_same_relay_sequential(tmp_path):
    order, live = [], [0, 0]

    async def handler(req):
        live[0] += 1; live[1] = max(live[1], live[0])
        await asyncio.sleep(0.05)
        live[0] -= 1
        order.append(json.loads(req.content)["model"])
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"document_type": "invoice", "tables": []}'}}]})
    il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--a-model", "ma",
             "--b-type", "openai", "--b-base", "https://relay.test/v1", "--b-key", "k", "--b-model", "mb", "--out", str(tmp_path)],
            transport=httpx.MockTransport(handler))
    assert order == ["ma", "mb"] and live[1] == 1


def test_totals_taxrate_and_statement_balance():
    inv = {"grand_total": "RM22,113.00", "tables": [],
           "totals": [{"label": "Subtotal", "value": "RM20,475.00"}, {"label": "SST 8%", "value": "RM1,638.00"}, {"label": "Discount", "value": "-"}]}
    ok = {c["code"]: c["ok"] for c in il.verify(inv)["checks"]}
    assert ok["totalsum"] and ok["taxrate"]
    inv["totals"][1]["value"] = "RM1,368.00"
    ok = {c["code"]: c["ok"] for c in il.verify(inv)["checks"]}
    assert not ok["totalsum"] and not ok["taxrate"]
    st = {"tables": [{"columns": [{"name": "Date", "role": "date"}, {"name": "Debit", "role": "debit"}, {"name": "Credit", "role": "credit"}, {"name": "Balance", "role": "balance"}],
                      "rows": [["1/9", "", "", "1,000.00"], ["2/9", "200.00", "", "800.00"], ["3/9", "", "50.00", "850.00"], ["4/9", "20.00", "", "830.00"]]}]}
    assert [c for c in il.verify(st)["checks"] if c["code"] == "balance_all"]
    st["tables"][0]["rows"][3][3] = "803.00"
    bad = [c for c in il.verify(st)["checks"] if c["code"] == "balance"]
    assert len(bad) == 1 and bad[0]["row"] == 3


def test_tables_csv_one_header_per_table(tmp_path):
    llm = FakeLLM(lambda c: invoice())
    il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--b-key", "", "--out", str(tmp_path)], transport=llm.transport)
    rows = list(csv.reader(open(tmp_path / "tables.csv", encoding="utf-8-sig")))
    assert rows[0][:5] == ["file", "page", "document_number", "table", "row"]
    assert rows[1][0] == "invoice.jpg" and rows[1][4] == "1"


def test_fields_csv_has_everything(tmp_path):
    llm = FakeLLM(lambda c: invoice(parties=[{"role": "bill_to", "name": "SAMPLE STORE", "address": "LOT 1, JALAN ANGSA, 41150 KLANG"}],
                                    stamps_and_chops=[{"text": "RECEIVED", "position": "bottom"}], handwritten_notes=["143"]))
    il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--b-key", "", "--out", str(tmp_path)], transport=llm.transport)
    rows = list(csv.reader(open(tmp_path / "fields.csv", encoding="utf-8-sig")))
    assert rows[0] == ["file", "page", "section", "item", "label", "value"]
    assert ["party", "bill_to 1", "address", "LOT 1, JALAN ANGSA, 41150 KLANG"] in [r[2:] for r in rows]
    assert any(r[2] == "handwriting" and r[5] == "143" for r in rows) and any(r[2].startswith("table:") for r in rows)


def test_accounting_numbers_text_cleanup_and_date_order():
    assert il.num("(1,234.56)") == -1234.56 and il.num("1,234.56-") == -1234.56 and il.num("1,234.56 CR") == -1234.56
    assert il.num("-RM5.00") == -5 and il.num("RM1,638.00") == 1638 and il.num("1,000.00 DR") == 1000 and il.num("-") is None
    assert il.norm_text("INV\u00ad-00\u200b12\u2013A\u00a0B\x00") == "INV-0012-A B "
    amb = {"document_date": "03/04/2026", "currency": "USD", "tables": []}
    assert [c for c in il.verify(amb)["checks"] if c["code"] == "dateamb"]
    assert not [c for c in il.verify({"document_date": "03/04/2026", "currency": "RM", "tables": []})["checks"] if c["code"] == "dateamb"]
    settled = {"document_date": "03/04/2026", "currency": "USD", "fields": [{"label": "Due", "value": "18/04/2026"}], "tables": []}
    assert not [c for c in il.verify(settled)["checks"] if c["code"] in ("dateamb", "datemdy")]
    us = {"document_date": "04/18/2026", "tables": []}
    assert [c for c in il.verify(us)["checks"] if c["code"] == "datemdy"]


def test_grouped_report_and_grounding():
    rep = {"tables": [{"columns": [{"name": "Customer", "role": "text"}, {"name": "Current", "role": "number"}, {"name": "1-30", "role": "number"}, {"name": "Balance", "role": "row_total"}],
                       "rows": [["ALPHA", "", "", ""], ["INV-1", "100", "", "100"], ["INV-2", "", "50", "50"], ["Jumlah ALPHA", "100", "50", "150"],
                                ["BETA", "", "", ""], ["INV-3", "20", "", "20"], ["Jumlah BETA", "20", "", "25"]],
                       "row_kinds": ["group_header", "line", "line", "subtotal", "group_header", "line", "subtotal"],
                       "total_row": [None, "120", "50", "170"]}]}
    checks = il.verify(rep)["checks"]
    bad = [c for c in checks if c["code"] == "groupsum"]
    assert len(bad) == 1 and bad[0]["row"] == 6 and bad[0]["sum"] == 20
    assert all(c["ok"] for c in checks if c["code"] == "colsum")  # subtotal rows are not double-counted
    layer = "TAX INVOICE  No: INV-0042   Date: 02/07/2026   Grand Total RM 1,234.50"
    g = il.grounding(layer, {"document_number": "INV-0042", "document_date": "02/07/2026", "grand_total": "1234.50", "fields": [{"label": "Ref", "value": "PO-9981"}]})
    assert g["checked"] == 4 and [m["field"] for m in g["missing"]] == ["fields.0.value"]


def test_small_corner_qr_found_by_region_scan():
    seg = il.ingest(FIX / "small-qr.jpg")[0]
    codes = il.local_codes(seg)["qr_and_barcodes"]
    assert codes and codes[0]["data"].startswith("https://myinvois.hasil.gov.my/")


def test_tax_without_registration_and_name_with_reg_no():
    r = {"tables": [], "parties": [{"role": "issuer", "name": "Iota Technologies Sdn Bhd (1340607-U)", "registration_no": "1340607-U"}],
         "totals": [{"label": "Subtotal", "value": "RM20,475.00"}, {"label": "SST 8%", "value": "RM1,638.00"}], "grand_total": "RM22,113.00"}
    codes = {c["code"] for c in il.verify(r)["checks"] if not c["ok"]}
    assert {"taxnoreg", "namereg"} <= codes
    r["fields"] = [{"label": "SST Reg No", "value": "W10-1808-31000123"}]
    r["parties"][0]["name"] = "Iota Technologies Sdn Bhd"
    codes = {c["code"] for c in il.verify(r)["checks"] if not c["ok"]}
    assert not {"taxnoreg", "namereg"} & codes


DELFI_COLS = ["No.", "Delivery No.", "Ship-To", "Name", "Invoice Date", "Invoice No.", "CTN-1", "CTN-2", "CTN-3", "CTN-4", "Total"]
DELFI_TOTAL = [None] * 6 + ["39", "17", "0", "0", "56"]


def _delfi(ctn):
    names = ["WATSONS-GATEWAY", "WATSONS-MITSUI", "ALL DAY PHARMACY", "DC UNIT", "KLINIK I-CARE", "REZEKI", "SSD HEALTHCARE"]
    return [[str(i + 1), f"15315{i:05d}", f"10{i:05d}", n, "21/09/2026", f"15614{i:05d}", *c] for i, (n, c) in enumerate(zip(names, ctn))]


def test_string_headers_get_roles_and_the_better_checked_model_wins():
    good = [[None, "1", None, None, "1"], [None, "1", None, None, "1"], ["22", "6", None, None, "28"], ["4", "1", None, None, "5"],
            ["3", None, None, None, "3"], ["5", "8", None, None, "13"], ["5", None, None, None, "5"]]
    shifted = [[None, "1", None, None, "1"], [None, "1", None, None, "1"], ["22", "6", None, None, "28"], [None, "4", "1", None, "5"],
               [None, "3", None, None, "3"], [None, "5", "8", None, "13"], [None, "5", None, None, "5"]]
    a = il.normalize_result({"document_type": "invoice_register", "tables": [{"columns": list(DELFI_COLS), "rows": _delfi(shifted), "total_row": DELFI_TOTAL}]})
    roles = {c["name"]: c["role"] for c in a["tables"][0]["columns"]}
    assert roles["No."] == "id" and roles["Delivery No."] == "id" and roles["CTN-1"] == "number" and roles["Total"] == "row_total" and roles["Invoice Date"] == "date"
    ca = il.verify(a)
    assert [c for c in ca["checks"] if c["code"] == "colsum" and not c["ok"]]  # the column shift is now caught
    b = {"document_type": "invoice_register", "tables": [{"columns": [{"name": n, "role": r} for n, r in roles.items()], "rows": _delfi(good), "total_row": DELFI_TOTAL}]}
    seg = {"provider_responses": {"model_a": a, "model_b": b}, "checks": {"model_a": ca, "model_b": il.verify(b)}}
    assert il.pick_model(seg)[0] == "B"


def test_bracketed_ids_are_unwrapped():
    r = il.normalize_result({"parties": [{"name": "Iota", "registration_no": " (1340607-U) ", "tax_id": "C123"}], "tables": []})
    assert r["parties"][0]["registration_no"] == "1340607-U" and r["parties"][0]["tax_id"] == "C123"


def test_guessed_names_phone_lengths_and_label_alignment():
    r = {"tables": [], "handwritten_notes": [{"text": "143"}, {"text": "Johnson David Raju"}], "low_confidence_fields": ["handwritten_notes[1].text"],
         "parties": [{"role": "supplier", "contact": "Phone: 03-563339805 Fax: 03-56343748"}, {"role": "bill_to", "contact": "Tel: 03-33626863"}]}
    bad = {c["code"]: c for c in il.verify(r)["checks"] if not c["ok"]}
    assert bad["guessname"]["v"] == "Johnson David Raju" and not bad["guessname"].get("warn")
    assert bad["phonelen"]["v"] == "03-563339805" and bad["phonelen"]["n"] == 9  # two 8-digit numbers make the majority
    mix = [c for c in il.verify({"tables": [], "parties": [{"contact": "Phone: 03-563339805 Fax: 03-56343748"}]})["checks"] if c["code"] == "phonemix"]
    assert mix and "03-563339805 (9)" in mix[0]["v"] and "03-56343748 (8)" in mix[0]["v"]
    a = {"fields": [{"label": "Customer Account", "value": "N010"}, {"label": "Payment Terms :", "value": "14 DAYS"}]}
    b = {"fields": [{"label": "Payment Terms", "value": "14 DAYS"}, {"label": "Ref 1", "value": None}, {"label": "Customer Account", "value": "N01O"}]}
    il.align_by_label(a, b)
    assert [f["label"] for f in b["fields"]] == ["Customer Account", "Payment Terms", "Ref 1"]
    cv = il.compare(a, b)
    assert [d["field"] for d in cv["discrepancies"] if d["kind"] == "mismatch"] == ["fields.0.value"]


def test_tie_goes_to_the_fuller_table():
    mk = lambda desc: {"document_type": "invoice", "tables": [{"columns": [{"name": "Description", "role": "text"}, {"name": "Qty", "role": "qty"}], "rows": [[desc, "3"]]}]}
    a, b = mk("Tuntukan Bayaran Bagi:"), mk("Tuntukan Bayaran Bagi: PERKHIDMATAN PENYELENGGARAAN SISTEM MYWALET BLOCKCHAIN • 3 Bulan")
    seg = {"provider_responses": {"model_a": a, "model_b": b}, "checks": {"model_a": il.verify(a), "model_b": il.verify(b)}}
    assert il.pick_model(seg)[0] == "B"


def test_field_level_merge_and_columnless_tables():
    r = il.normalize_result({"tables": [{"columns": [{"name": "D", "role": "text"}], "rows": [["x"]]}, {"columns": [], "rows": [["7 Orders"]]}]})
    assert len(r["tables"]) == 1
    final = {"fields": [{"label": "Ref", "value": None}, {"label": "Fax", "value": "03-56343748"}],
             "tables": [{"columns": [{"name": "Description", "role": "text"}], "rows": [["Tuntukan Bayaran Bagi:"]]}]}
    diffs = [{"field": "fields.0.value", "a": None, "b": "PO-77", "kind": "missing"},
             {"field": "fields.1.value", "a": "03-56343748", "b": "03-56343740", "kind": "mismatch"},
             {"field": "tables.0.rows.0.0", "a": "Tuntukan Bayaran Bagi:", "b": "Tuntukan Bayaran Bagi: PERKHIDMATAN ... • 3 Bulan", "kind": "mismatch"},
             {"field": "tables.0.columns.0.role", "a": "text", "b": "id", "kind": "mismatch"}]
    merged = il.merge_from(final, "A", diffs)
    assert [m["path"] for m in merged] == ["fields.0.value", "tables.0.rows.0.0"]
    assert final["fields"][1]["value"] == "03-56343748" and final["tables"][0]["rows"][0][0].endswith("3 Bulan")


def test_merge_never_fills_empty_table_cells_and_is_undone_if_checks_break():
    cols = [{"name": "Name", "role": "text"}, {"name": "CTN-1", "role": "number"}, {"name": "CTN-2", "role": "number"}, {"name": "Total", "role": "row_total"}]
    good = {"tables": [{"columns": cols, "rows": [["A", "4", "1", "5"], ["B", "3", "", "3"]], "total_row": [None, "7", "1", "8"]}]}
    final = json.loads(json.dumps(good))
    diffs = [{"field": "tables.0.rows.1.2", "a": "", "b": "3", "kind": "missing"}]
    assert il.merge_from(final, "A", diffs) == [] and final == good
    assert not il.normalize_result({"tables": [{"columns": [{"name": "Header", "role": "text"}], "rows": [["7 Orders"]], "row_kinds": ["other"]}]})["tables"]


def test_repair_shift_and_label_guarded_merge():
    cols = [{"name": "Name", "role": "text"}] + [{"name": f"CTN-{i}", "role": "number"} for i in (1, 2, 3)] + [{"name": "Total", "role": "row_total"}]
    rows = [["A", None, "1", None, "1"], ["B", "22", "6", None, "28"], ["C", None, "3", None, "3"], ["D", "5", "8", None, "13"]]
    r = {"tables": [{"columns": cols, "rows": rows, "total_row": [None, "30", "15", "0", "45"]}]}
    assert il.repair_shift(r) == [{"ti": 0, "row": 3, "from": "CTN-2", "to": "CTN-1", "v": "3"}]
    assert rows[2] == ["C", "3", None, None, "3"] and il.verify(r)["passed"]
    amb = {"tables": [{"columns": cols, "rows": [["A", None, "1", None, "1"], ["B", None, "1", None, "1"]], "total_row": [None, "1", "1", "0", "2"]}]}
    assert il.repair_shift(amb) == []  # two candidate rows: nothing is guessed
    final = {"fields": [{"label": "Collected By", "value": None}]}
    diffs = [{"field": "fields.0.label", "a": "Time", "b": "Collected By"}, {"field": "fields.0.value", "a": "07:08:04", "b": None}]
    assert il.merge_from(final, "B", diffs) == [] and final["fields"][0]["value"] is None


def test_merge_adds_missing_field_and_role_synonyms():
    final = {"fields": [{"label": "Page", "value": "1 of 1"}]}
    diffs = [{"field": "fields.1.label", "a": None, "b": "Time"}, {"field": "fields.1.value", "a": None, "b": "07:08:04"}]
    assert il.merge_from(final, "A", diffs)[0]["v"] == "Time: 07:08:04" and final["fields"][1] == {"label": "Time", "value": "07:08:04"}
    c = il.compare({"parties": [{"role": "supplier"}]}, {"parties": [{"role": "issuer"}]})
    assert c["discrepancies"] == []


def test_temperature_zero_with_fallback(tmp_path):
    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append(body.get("temperature"))
        if "temperature" in body:
            return httpx.Response(400, json={"error": {"message": "temperature is not supported with this model"}})
        doc = {"document_type": "invoice", "document_number": "INV-1", "rotation_degrees": "0", "tables": []}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(doc)}}]})
    il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--b-key", "", "--out", str(tmp_path)], transport=httpx.MockTransport(handler))
    assert seen == [0, None]


def test_max_completion_tokens_fallback(tmp_path):
    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append("max_tokens" in body)
        if "max_tokens" in body:
            return httpx.Response(400, json={"error": {"message": "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}})
        doc = {"document_type": "invoice", "document_number": "INV-1", "rotation_degrees": "0", "tables": []}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(doc)}}]})
    il._TOK_PARAM.clear()
    il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--b-key", "", "--out", str(tmp_path)], transport=httpx.MockTransport(handler))
    assert seen[0] is True and seen[1] is False  # refused once, then the other parameter name; later calls use it directly


def test_normalize_id_prefix_and_label_colon():
    r = il.normalize_result({"parties": [{"tax_id": "TIN:C6850683100", "registration_no": "(279018-W)"}], "fields": [{"label": "Payment Terms :", "value": "14 DAYS"}]})
    assert r["parties"][0]["tax_id"] == "C6850683100" and r["parties"][0]["registration_no"] == "279018-W"
    assert r["fields"][0]["label"] == "Payment Terms"


def test_twin_model_b_gets_closeups(tmp_path):
    seen = []

    def handler(req):
        body = json.loads(req.content)
        seen.append(sum(1 for c in body["messages"][0]["content"] if c["type"] == "image_url"))
        doc = {"document_type": "invoice", "document_number": "INV-1", "rotation_degrees": "0", "tables": [], "notes": ["* Private & Confidential"]}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(doc)}}]})
    il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--a-model", "m", "--b-type", "openai", "--b-model", "m", "--b-base", "https://relay.test/v1", "--b-key", "k", "--out", str(tmp_path)], transport=httpx.MockTransport(handler))
    assert sorted(seen) == [1, 3]
    assert "note" in (tmp_path / "all_fields.csv").read_text() if (tmp_path / "all_fields.csv").exists() else True


def test_wrong_quarter_turn_tries_other_way(tmp_path):
    seen = []

    def handler(req):
        seen.append(1)
        # first read: "turn 90"; after 90 the page reads upside down (180); after 270 it is upright
        rot = {1: "90", 2: "180"}.get(len(seen), "0")
        doc = {"document_type": "invoice", "document_number": "INV-1", "rotation_degrees": rot, "tables": []}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(doc)}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
    il.main([str(FIX / "invoice.jpg"), "--a-base", "https://relay.test/v1", "--a-key", "k", "--b-key", "", "--out", str(tmp_path)], transport=httpx.MockTransport(handler))
    res = json.loads((tmp_path / "results.json").read_text())["documents"][0]["segments"][0]
    assert len(seen) == 3 and res["straightened"] == 270 and res["usage"]["model_a"] == {"in": 30, "out": 15}


def test_fade_fix_darkens_a_faded_block_only():
    faded = il.jpeg_b64(il.Image.open(FIX / "faded.jpg"))
    out = il.fade_fix(faded)
    assert out is not None
    blk = il.b64_image(out).convert("L").crop((480, 200, 880, 320))
    assert min(blk.getdata()) < 150   # was ~196
    assert il.fade_fix(il.jpeg_b64(il.Image.open(FIX / "invoice.jpg"))) is None  # clean page untouched


def test_apply_copies_corrects_the_odd_copy():
    def read(no, name):
        return {"document_number": no, "grand_total": "423.08", "parties": [{"role": "ship_to", "name": name, "address": "NO. 4 & 5, LORONG LUKUT MAKMUR 1, 71010 PORT DICKSON"}]}
    good = read("A261001216", "NS TMN LUKUT MAKMUR (DD)")
    segs = [
        {"segment_identifier": "Page_1", "final_result": json.loads(json.dumps(good)), "provider_responses": {"model_a": good, "model_b": good}},
        {"segment_identifier": "Page_2", "final_result": read("A2610632158", "RS MIN LUKUT MAKMUR (JD)"),
         "provider_responses": {"model_a": read("A2610632158", "RS MIN LUKUT MAKMUR (JD)"), "model_b": read("A261001216", "NS TMN LUKUT MAKMUR (OD)")}},
    ]
    il.apply_copies(segs)
    f = segs[1]["final_result"]
    assert f["document_number"] == "A261001216" and f["parties"][0]["name"] == "NS TMN LUKUT MAKMUR (DD)"
    assert {c["path"] for c in segs[1]["consensus"]} == {"document_number", "parties.ship_to.name"} and "consensus" not in segs[0]


ROWS = [["1", "BL P", "8076 BUTTERLITE", "20.00 UNIT", "4.91", "98.20"], ["2", "AH", "8092 AYAMAS HOT", "6.00 UNIT", "20.86", "125.16"], ["3", "FP7.5", "8104 FRIZZ POPIA", "10.00 UNIT", "4.96", "49.60"],
        ["4", "RBB", "8436 RAMLY BEEF BURGER", "12.00 UNIT", "7.75", "93.00"], ["5", "ACF", "9150 AYAMAS FRANKFURTERS", "16.00 UNIT", "5.27", "84.32"], ["6", "ACFC", "9153 AYAMAS CRISPY", "6.00 UNIT", "20.10", "120.60"], ["7", "MYFF", "9251 MYDIBEL FRIES", "1.00 CTN", "80.00", "80.00"]]
COLS = [{"name": "No", "role": "id"}, {"name": "Item Code", "role": "text"}, {"name": "Description", "role": "text"}, {"name": "Qty", "role": "qty"}, {"name": "Price", "role": "unit_price"}, {"name": "Total", "role": "amount"}]
STREETS = ["LORONG LUKUT MAKMUR 1", "JALAN BUKIT EKA BIZ", "JLN PUSAT DAGANGAN SENDAYAN 3/3", "JALAN NUSARI BAYU 7/1", "PERSIARAN METRO SENDAYAN 1", "JLN SPRINGHILL 9/1"]


def _inv(no, date, total, ship, street, rows=ROWS):
    return {"document_number": no, "document_date": date, "grand_total": total, "tables": [{"columns": COLS, "rows": json.loads(json.dumps(rows)), "row_kinds": ["line"] * len(rows)}],
            "stamps_and_chops": [{"text": "99 SPEED MART (3420) NS TMN"}],
            "parties": [{"role": "ship_to", "name": ship, "address": f"NO. 4 & 5 (GF), {street}, 71010 PORT DICKSON"}]}


def _seg(n, a, b=None):
    return {"segment_identifier": f"Page_{n}", "final_result": json.loads(json.dumps(a)), "provider_responses": {"model_a": a, "model_b": b or a}, "cross_verification": {"agreement_rate": 0.9}}


def test_batch_fix_date_number_store_and_copy_lines():
    wrong = json.loads(json.dumps(ROWS))
    wrong[1] = ["2", "AH", "8092 AYAMAS HOT", "5.00 UNIT", "20.85", "104.25"]
    wrong[6] = ["7", "MYFF", "9251 MYDIBEL FRIES", "1.00 CTN", "90.00", "90.00"]
    segs = [
        _seg(1, _inv("A261001101", "7/10/2026", "652.88", "3420 NS TMN", STREETS[0])),
        _seg(2, _inv("A261001101", "7/10/2026", "650.88", "3420 NS TMN", STREETS[0], wrong)),
        _seg(3, _inv("A261001103", "7/10/2026", "650.88", "7420 NS TMN", STREETS[2]), _inv("A261001103", "7/10/2026", "650.88", "3420 NS TMN", STREETS[2])),
        _seg(4, _inv("A2636612270", "7/10/2026", "650.88", "3420 NS TMN", STREETS[3]), _inv("A261001104", "7/10/2026", "650.88", "3420 NS TMN", STREETS[3])),
        _seg(5, _inv("A2636612271", "7/10/2026", "650.88", "3420 NS TMN", STREETS[4])),
        _seg(6, _inv("A261001106", "7/15/2025", "650.88", "3420 NS TMN", STREETS[5])),
    ]
    il.apply_copies(segs)
    f = [s["final_result"] for s in segs]
    assert f[0]["grand_total"] == "650.88"
    assert f[1]["tables"][0]["rows"][1][3:] == ["6.00 UNIT", "20.86", "125.16"] and f[1]["tables"][0]["rows"][6][3:] == ["1.00 CTN", "80.00", "80.00"]
    assert f[2]["parties"][0]["name"] == "3420 NS TMN"
    assert f[3]["document_number"] == "A261001104"
    assert "docno" in segs[4]["suspects"]
    assert f[5]["document_date"] == "7/10/2026"


def test_parse_json_repairs_bare_quotes_and_missing_commas():
    r = il.parse_json('{"a":"FP7.5" (20PKT)","r":[["1","x"] ["2","y"],],"n":null}')
    assert r["a"] == 'FP7.5" (20PKT)' and r["r"] == [["1", "x"], ["2", "y"]] and r["n"] is None


def test_fix_row_shape_merges_columns_and_glues_units():
    cols = [{"name": n, "role": r} for n, r in [("No", "number"), ("Item Code", "id"), ("Description", "text"), ("Qty", "qty"), ("Price", "unit_price"), ("Discount", "text"), ("Total", "amount")]]
    short = il.normalize_result({"tables": [{"columns": json.loads(json.dumps(cols)), "rows": [["1", "ABD 8091 DRUMMET", "6.00 UNIT", "20.00", "", "120.00"], ["2", "RBB 8436 BURGER", "12.00 UNIT", "15.00", "", "180.00"]]}]})
    t = short["tables"][0]
    assert all(len(r) == len(t["columns"]) for r in t["rows"]) and not any(not c["ok"] and not c.get("warn") for c in il.verify(short)["checks"])
    long = il.normalize_result({"tables": [{"columns": json.loads(json.dumps(cols)), "rows": [["1", "ABD", "8091 DRUMMET", "6.00", "UNIT", "20.00", "", "120.00"]]}]})
    assert long["tables"][0]["rows"][0] == ["1", "ABD", "8091 DRUMMET", "6.00 UNIT", "20.00", "", "120.00"]


def test_fix_delivery_block_brings_the_branch_number_back_into_the_address():
    rest = "NO 1 (SINGLE STOREY), JLN GADONG INDAH 3, TMN GADONG INDAH 1, 71900 LABU"
    stamp = [{"text": "99 SPEED MART SDN. BHD. (519537-X) (1988) NS Tmn Gadong Indah"}]
    r = il.fix_delivery_block({"parties": [{"role": "ship_to", "name": "1988", "address": "NS TMN GADONG INDAH (DD) " + rest}], "stamps_and_chops": stamp})
    assert r["parties"][0]["address"] == "1988 NS TMN GADONG INDAH (DD) " + rest and r["parties"][0]["name"] == "1988"
    r = il.fix_delivery_block({"parties": [{"role": "ship_to", "name": "NS TMN GADONG INDAH (DD)", "address": rest}], "stamps_and_chops": stamp})
    assert r["parties"][0]["address"] == "1988 NS TMN GADONG INDAH (DD) " + rest
    whole = {"parties": [{"role": "ship_to", "name": None, "address": "1988 NS TMN GADONG INDAH (DD) " + rest}], "stamps_and_chops": stamp}
    assert il.fix_delivery_block(whole) is whole
    assert il.normalize_result({"parties": [{"role": "ship_to", "name": "3912", "address": "NS TMN BKT EKA (TD) NO 20"}]})["parties"][0]["address"] == "3912 NS TMN BKT EKA (TD) NO 20"
