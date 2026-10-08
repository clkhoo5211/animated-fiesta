"""Unified vision pipeline (fixed version of the original draft).

Fixes vs. draft: os.path.splitext()[1], choices[0]/content[0] indexing,
PDF pages rendered to images (were text-only, so AI never saw them),
anthropic JSON fence stripping, current model ids, __name__ guard.
"""
import asyncio
import base64
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI
from pyzbar.pyzbar import decode

PROMPT = ("Extract document information into a JSON object with keys: 'invoice_metadata', "
          "'line_items_table', 'stamps_and_chops_found', 'handwritten_notes'. Return raw JSON only.")


def parse_json(text):
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        return json.loads(m.group(0)) if m else {"raw": text}


class EnterpriseVisionPipeline:
    def __init__(self, openai_key=None, anthropic_key=None, max_workers=4,
                 openai_model="gpt-4o", anthropic_model="claude-sonnet-5-5"):
        openai_key = openai_key or os.getenv("OPENAI_API_KEY")
        anthropic_key = anthropic_key or os.getenv("ANTHROPIC_API_KEY")
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.openai = AsyncOpenAI(api_key=openai_key) if openai_key else None
        self.anthropic = AsyncAnthropic(api_key=anthropic_key) if anthropic_key else None
        self.openai_model, self.anthropic_model = openai_model, anthropic_model
        self.sem = asyncio.Semaphore(3)  # cap concurrent pages to avoid rate limits

    def _local(self, img_bytes, text):
        report = {"qr_and_barcodes": [], "native_extracted_text": text}
        img = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR) if img_bytes else None
        if img is not None:
            report["qr_and_barcodes"] = [{"type": d.type, "data": d.data.decode("utf-8", "ignore")} for d in decode(img)]
        return report

    def _ingest(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in {".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp"}:
            img = cv2.imread(path)
            return [{"id": "Image_1", "bytes": cv2.imencode(".jpg", img)[1].tobytes(), "text": ""}] if img is not None else []
        if ext == ".pdf":
            import fitz  # PyMuPDF: renders pages so scanned PDFs work too
            out = []
            with fitz.open(path) as doc:
                for i, page in enumerate(doc, 1):
                    out.append({"id": f"Page_{i}", "bytes": page.get_pixmap(dpi=150).tobytes("jpeg"), "text": page.get_text()})
            return out
        if ext in {".mp4", ".avi", ".mov", ".mkv"}:
            cap, out = cv2.VideoCapture(path), []
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            for k, frac in enumerate((0.25, 0.5, 0.75), 1):
                cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * frac))
                ok, frame = cap.read()
                if ok:
                    out.append({"id": f"Video_Frame_{k}", "bytes": cv2.imencode(".jpg", frame)[1].tobytes(), "text": ""})
            cap.release()
            return out
        return []

    async def _openai(self, b64, prompt):
        r = await self.openai.chat.completions.create(
            model=self.openai_model, response_format={"type": "json_object"}, max_tokens=2000,
            messages=[{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}]}])
        return parse_json(r.choices[0].message.content)

    async def _anthropic(self, content):
        r = await self.anthropic.messages.create(model=self.anthropic_model, max_tokens=2000,
                                                 messages=[{"role": "user", "content": content}])
        return parse_json(next(b.text for b in r.content if b.type == "text"))

    @staticmethod
    async def _safe(coro):
        try:
            return await coro
        except Exception as e:  # keep other providers' results
            return {"error": str(e)}

    async def _segment(self, seg):
        async with self.sem:
            loop = asyncio.get_running_loop()
            b64 = base64.b64encode(seg["bytes"]).decode()
            prompt = PROMPT + (f"\n\nPDF text layer:\n{seg['text'][:6000]}" if seg["text"] else "")
            local, oa, an = await asyncio.gather(
                loop.run_in_executor(self.executor, self._local, seg["bytes"], seg["text"]),
                self._safe(self._openai(b64, prompt)) if self.openai else asyncio.sleep(0, {"status": "skipped"}),
                self._safe(self._anthropic([
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
                    {"type": "text", "text": prompt}])) if self.anthropic else asyncio.sleep(0, {"status": "skipped"}))
            audit = {}
            if self.openai and self.anthropic:
                if "error" in oa or "error" in an:
                    audit = {"status": "Verification Bypassed", "reason": "A provider failed."}
                else:
                    audit = await self._safe(self._anthropic([{"type": "text", "text": (
                        "You are a strict data auditor. Compare two extractions of the same document.\n"
                        f"A (OpenAI): {json.dumps(oa)}\nB (Anthropic): {json.dumps(an)}\n"
                        "Return JSON with 'consensus_data' and 'discrepancy_flags' (field, value_a, value_b). Raw JSON only.")}]))
            return {"segment_identifier": seg["id"], "local_extraction": local,
                    "provider_responses": {"openai": oa, "anthropic": an}, "cross_verification_audit": audit}

    async def run(self, path):
        segs = await asyncio.get_running_loop().run_in_executor(self.executor, self._ingest, path)
        if not segs:
            return {"error": "Unsupported or unreadable file."}
        done = await asyncio.gather(*(self._segment(s) for s in segs))
        return {"source_document": path, "total_extracted_segments": len(done), "segments": done}


def process_any_file(path, **kw):
    return asyncio.run(EnterpriseVisionPipeline(**kw).run(path))


if __name__ == "__main__":
    import sys
    print(json.dumps(process_any_file(sys.argv[1] if len(sys.argv) > 1 else "invoice.png"), indent=2, ensure_ascii=False))
