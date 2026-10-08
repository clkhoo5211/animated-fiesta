# Unified Vision Pipeline

- `site/` — 纯浏览器版（GitHub Pages 部署）：图片/PDF/视频 → zxing 条码 + pdf.js 文本层 → OpenAI & Anthropic → 交叉核验。用户自带 API Key，只在内存中。
- `python/` — 修复后的服务端脚本：`pip install -r python/requirements.txt && python python/unified_vision_pipeline.py invoice.pdf`

部署：push 后 `.github/workflows/pages.yml` 自动发布到 GitHub Pages（需在 Settings → Pages 选 Source = GitHub Actions）。
