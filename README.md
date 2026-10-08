# Unified Vision Pipeline

- `site/` — 纯浏览器版（GitHub Pages 部署）：图片/PDF/视频 → zxing 条码 + pdf.js 文本层 → OpenAI & Anthropic → 交叉核验。用户自带 API Key，只在内存中。
- `python/` — 修复后的服务端脚本：`pip install -r python/requirements.txt && python python/unified_vision_pipeline.py invoice.pdf`

部署：push 后 `.github/workflows/pages.yml` 自动发布到 GitHub Pages（需在 Settings → Pages 选 Source = GitHub Actions）。

## CORS 代理（可选）
部分 OpenAI 兼容服务（如 DeepSeek 官方）不允许浏览器直连。`proxy/` 是一个 Cloudflare Worker：只接受本站两个域名的请求，按 `X-Target-Base` 转发，不存储密钥。
部署：在仓库 Secrets 添加 `CLOUDFLARE_API_TOKEN`（模板 "Edit Cloudflare Workers"）和 `CLOUDFLARE_ACCOUNT_ID`，push 或手动运行 "Deploy CORS proxy"，再把得到的 `https://vision-cors-proxy.<子域>.workers.dev` 填进页面的“CORS 代理 URL”。
