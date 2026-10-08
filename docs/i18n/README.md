# Translation review

`ms-review.csv` lists every interface string: key, English, current Bahasa Melayu, and an empty **suggested** column.

**For the reviewer:** open the CSV in Excel / Google Sheets, write a better wording in **suggested** only where needed (leave blank to keep), and keep placeholders such as `{n}`, `{f}`, `{k}` exactly as they are. Notes are optional.

**To apply:** `python tools/i18n.py apply ms docs/i18n/ms-review.csv`, then `npm test` (the i18n test checks for leftover keys / placeholders) and open a PR.

Regenerate the sheet after adding strings: `python tools/i18n.py export ms docs/i18n/ms-review.csv` (same for `zh`).
