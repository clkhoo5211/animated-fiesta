"""Provider adapters over plain HTTPS (stdlib). Keys come from environment variables ONLY.

kinds: "anthropic" (Messages API), "openai" (any OpenAI-compatible /chat/completions: OpenAI, OpenRouter, DeepSeek, Together, local vLLM...).
"""
import json, os, urllib.request

class LLMError(Exception): pass

def _post(url, headers, body, timeout):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except Exception as e:
        raise LLMError(f"{type(e).__name__}: {e}") from None

def call(spec, system, user, timeout=60, max_tokens=600):
    """spec: {kind, model, key_env, base_url?}. Returns text."""
    key = os.environ.get(spec["key_env"])
    if not key:
        raise LLMError(f"missing env var {spec['key_env']}")
    if spec["kind"] == "anthropic":
        r = _post(spec.get("base_url", "https://api.anthropic.com") + "/v1/messages",
                  {"x-api-key": key, "anthropic-version": "2023-06-01"},
                  {"model": spec["model"], "max_tokens": max_tokens, "system": system,
                   "messages": [{"role": "user", "content": user}]}, timeout)
        return "".join(b.get("text", "") for b in r.get("content", []))
    if spec["kind"] == "openai":
        r = _post(spec.get("base_url", "https://api.openai.com/v1") + "/chat/completions",
                  {"authorization": f"Bearer {key}"},
                  {"model": spec["model"], "max_tokens": max_tokens,
                   "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}, timeout)
        return r["choices"][0]["message"]["content"]
    raise LLMError(f"unknown provider kind {spec['kind']}")
