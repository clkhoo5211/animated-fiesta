// CORS proxy for OpenAI-compatible APIs.
// The page sends the request here with header X-Target-Base (e.g. https://api.deepseek.com/v1);
// this worker forwards path + body + Authorization to that base and adds CORS headers.
// API keys pass through and are never stored or logged.

const DEFAULT_ORIGINS = "https://clkhoo5211.github.io,https://lapis-bloom-hav8.here.now";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Target-Base",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function badTarget(u) {
  if (u.protocol !== "https:") return "target must be https";
  const h = u.hostname;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return "private host";
  if (/^(\d+\.){3}\d+$/.test(h) || h.includes(":")) return "IP targets not allowed";
  return null;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim());
    if (!allowed.includes(origin)) return new Response("origin not allowed", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    const err = (msg, status = 400) =>
      new Response(JSON.stringify({ error: { message: msg } }), {
        status, headers: { ...cors(origin), "Content-Type": "application/json" },
      });

    let base;
    try { base = new URL(req.headers.get("X-Target-Base") || ""); } catch { return err("missing or invalid X-Target-Base"); }
    const bad = badTarget(base);
    if (bad) return err(bad);
    const hosts = (env.ALLOWED_TARGET_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (hosts.length && !hosts.includes(base.hostname)) return err(`target host ${base.hostname} not allowed`, 403);

    const path = new URL(req.url).pathname; // e.g. /chat/completions
    const target = base.href.replace(/\/+$/, "") + path;
    const headers = new Headers();
    for (const h of ["Authorization", "Content-Type"]) if (req.headers.get(h)) headers.set(h, req.headers.get(h));

    const upstream = await fetch(target, {
      method: req.method, headers,
      body: req.method === "GET" ? undefined : req.body,
    }).catch((e) => null);
    if (!upstream) return err(`upstream unreachable: ${base.hostname}`, 502);

    const out = new Headers(cors(origin));
    out.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
