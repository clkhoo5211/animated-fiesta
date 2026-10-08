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
    llm = FakeLLM(lambda c: {"error": "upstream overloaded"})
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
