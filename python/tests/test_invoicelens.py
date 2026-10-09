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
