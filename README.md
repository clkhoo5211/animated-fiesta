# InvoiceLens

In-browser document extraction: invoices, receipts, delivery orders, shipment lists and more.
Images (incl. iPhone HEIC), PDF, Excel/CSV, Word and video → OpenAI-compatible or Anthropic models → arithmetic checks, A/B cross-verification, manual review, export. UI in English (default), 中文 and Bahasa Melayu.

- Live: https://clkhoo5211.github.io/animated-fiesta/ · https://lapis-bloom-hav8.here.now/
- Everything runs in the browser. Files go only to the model providers you configure. API keys are stored in this browser only if you tick “Remember”.

## Layout

| Path | What |
|---|---|
| `site/index.html` | The whole app (single file, libraries from jsDelivr with pinned versions) |
| `tests/` | Playwright end-to-end tests + synthetic fixtures (`tests/fixtures/make_fixtures.py`) |
| `proxy/` | Optional Cloudflare Worker CORS proxy |
| `python/invoicelens.py` | Command-line / server version with the same prompt, checks, cross-check and reconciliation as the web app |
| `.github/workflows/` | `tests.yml` → on success `pages.yml` + `herenow.yml` deploy; `proxy.yml` deploys the worker |

## Tests

```bash
npm ci
npx playwright install chromium   # once
npm test
```

The tests serve `site/index.html` locally, map the jsDelivr libraries to `node_modules` (same pinned versions) and mock every model call, so they need no network or API keys. They cover: extraction and all result tabs, arithmetic checks, batch queue (concurrency, failure, retry, CSV), manual review (A/B pick, inline edit, undo, reviewed, export), autosave/restore, HEIC/Excel/Word/CSV, progress/cancel/timeout, i18n (no untranslated text in en/ms/zh), mobile overflow at 375px, and provider presets.

When you change a library version in `site/index.html`, change it in `package.json` too.

## Python / command line

Same extraction rules as the web app, for batch or server use (any OpenAI-compatible endpoint or Anthropic):

```bash
pip install -r python/requirements.txt
export IL_A_KEY=sk-...                     # model A; optional model B via IL_B_KEY / --b-*
python python/invoicelens.py invoices/ register.pdf \
  --a-base https://openrouter.ai/api/v1 --a-model google/gemini-2.5-flash --out out/
```

Writes `results.json`, `summary.csv`, `tables.csv` and `reconcile.csv` to `--out`. Run `python python/invoicelens.py -h` for all options (`--tiles`, `--no-enhance`, `--pdf-image`, `--concurrency`, `--b-type anthropic`, …). Text-based PDF pages are sent as their text layer by default (exact digits, fewer tokens); `summary.csv` includes token usage. Tests: `pytest python/tests` (a test fails if the prompt drifts from `site/index.html`).

## Deployment

Every push runs **Tests**. Only when they pass do GitHub Pages and here.now deploy that exact commit (here.now needs the `HERENOW_API_KEY` repository secret). Both deploy workflows can also be run manually.

## CORS proxy (optional)

Some OpenAI-compatible providers block calls from web pages. `proxy/` is a Cloudflare Worker that only accepts requests from the two sites above and forwards them to the `X-Target-Base` URL without storing keys. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, run “Deploy CORS proxy”, and paste the worker URL into Model settings → Advanced.
