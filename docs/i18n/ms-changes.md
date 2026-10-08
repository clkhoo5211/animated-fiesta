# Bahasa Melayu wording changes (self-review, Oct 2026)

Not a native-speaker review — see issue #1. Sources: LHDN/HASiL Malay usage for “nombor pengenalan cukai (TIN)”; Malaysian business documents for “Pesanan Penghantaran”; DBP preference for “sunting” (edit).

| key | English | before | after | why |
|---|---|---|---|---|
| `drop_title` | Drop, click or paste files (multiple allowed) | Seret, klik atau tampal fail (boleh banyak) | Seret, klik atau tampal fail (boleh pilih beberapa fail) | "boleh banyak" is colloquial |
| `start` | Start extraction | Mula ekstrak | Mulakan pengekstrakan | "ekstrak" bare verb is colloquial; use the noun form |
| `start_n` | Start extraction ({n} files) | Mula ekstrak ({n} fail) | Mulakan pengekstrakan ({n} fail) | as start |
| `tab_overview` | Overview | Gambaran | Gambaran keseluruhan | standard UI term for Overview |
| `show` | Show | Tunjuk | Papar | standard UI term |
| `json_mode` | Use JSON mode (turn off if the provider errors) | Guna mod JSON (matikan jika penyedia beri ralat) | Guna mod JSON (matikan jika penyedia memaparkan ralat) | "beri ralat" colloquial |
| `key_b` | API Key (leave empty to disable) | API Key (biarkan kosong untuk tidak guna) | API Key (biarkan kosong jika tidak digunakan) | clearer |
| `remember_warn` | Keys are stored in plain text in this browser's localStorage — personal devices only, never on shared computers. Base URL / model and other settings are always saved. | Kunci disimpan sebagai teks biasa dalam localStorage pelayar ini — untuk peranti peribadi sahaja, jangan pada komputer awam. Base URL / model dan tetapan lain sentiasa disimpan. | Kunci disimpan sebagai teks biasa dalam localStorage pelayar ini — gunakan pada peranti peribadi sahaja, bukan pada komputer yang dikongsi. Base URL / model dan tetapan lain sentiasa disimpan. | "shared computer" = komputer yang dikongsi |
| `err_word_empty` | The Word document has no readable text (it may only contain images) | Dokumen Word tiada teks yang boleh dibaca (mungkin hanya ada imej) | Dokumen Word ini tidak mempunyai teks yang boleh dibaca (mungkin hanya mengandungi imej) | grammar |
| `ck_colsum_d` | Rows add up to {s}; printed total {p} | Baris dijumlahkan {s}; jumlah bercetak {p} | Jumlah semua baris {s}; jumlah bercetak {p} | clearer |
| `ck_grand` | Line total vs grand total | Jumlah butiran vs jumlah besar | Jumlah butiran berbanding jumlah keseluruhan | "vs" → berbanding; grand total = jumlah keseluruhan |
| `chip_enh` | Small-text boost | Teks kecil | Peningkatan teks kecil | match the setting name |
| `rotate_title` | Rotate before extraction | Putar sebelum ekstrak | Putar sebelum pengekstrakan | noun form |
| `confirm_retry` | Re-extracting will discard this file's manual corrections. Continue? | Ekstrak semula akan membuang pembetulan manual fail ini. Teruskan? | Pengekstrakan semula akan membuang pembetulan manual fail ini. Teruskan? | noun form |
| `not_yet` | This file has not been extracted yet — click “Start extraction”. | Fail ini belum diekstrak — klik “Mula ekstrak”. | Fail ini belum diekstrak — klik “Mulakan pengekstrakan”. | button label changed |
| `empty_overview` | Upload files and click “Start extraction”. Document type, number, date, total and parties will appear here. | Muat naik fail dan klik “Mula ekstrak”. Jenis dokumen, nombor, tarikh, jumlah dan pihak-pihak akan dipaparkan di sini. | Muat naik fail dan klik “Mulakan pengekstrakan”. Jenis dokumen, nombor, tarikh, jumlah dan pihak-pihak berkaitan akan dipaparkan di sini. | button label changed |
| `empty_items` | After extraction, every table in the document appears here for row-by-row checking and editing. | Selepas ekstrak, semua jadual dalam dokumen dipaparkan di sini untuk disemak dan diedit baris demi baris. | Selepas pengekstrakan, semua jadual dalam dokumen dipaparkan di sini untuk disemak dan disunting baris demi baris. | noun form; sunting (DBP) for edit |
| `empty_checks` | After extraction, arithmetic checks, A/B disagreements and low-confidence fields to confirm are listed here. | Selepas ekstrak, semakan aritmetik, ketidaksepadanan A/B dan medan berkeyakinan rendah disenaraikan di sini. | Selepas pengekstrakan, semakan aritmetik, ketidaksepadanan A/B dan medan berkeyakinan rendah disenaraikan di sini. | noun form |
| `empty_json` | After extraction, the complete raw JSON (model outputs and manual corrections) appears here. | Selepas ekstrak, JSON mentah lengkap (output model dan pembetulan manual) dipaparkan di sini. | Selepas pengekstrakan, JSON mentah lengkap (output model dan pembetulan manual) dipaparkan di sini. | noun form |
| `elapsed` | Elapsed {s} s | Masa berlalu {s} saat | Telah berlalu {s} saat |  |
| `only_local` | No model configured — local extraction only | Tiada model ditetapkan — ekstrak tempatan sahaja | Tiada model ditetapkan — pengekstrakan tempatan sahaja | noun form |
| `th_party` | Counterparty | Pihak lain | Rakan niaga | counterparty; "pihak lain" means simply "other party" |
| `no_numbers_d` | The document has no total row / qty × price structure | Dokumen tiada baris jumlah / struktur kuantiti × harga | Dokumen ini tidak mempunyai baris jumlah / struktur kuantiti × harga | "tiada" + noun is colloquial here |
| `lowres_d` | Small print (tax IDs, phones, labels) is easily misread: turn on “Multi-scale reading” or configure model B; use the original photo when you have it | Cetakan kecil (no. cukai, telefon, label) mudah salah baca: hidupkan “Bacaan pelbagai skala” atau tetapkan model B; guna foto asal jika ada | Cetakan kecil (TIN, telefon, label) mudah salah dibaca: hidupkan “Bacaan pelbagai skala” atau tetapkan model B; guna foto asal jika ada | TIN as used by LHDN; salah dibaca (passive) |
| `no_codes_d` | If the image has a code: use the original photo (avoid WhatsApp compression) or a close-up | Jika imej ada kod: guna foto asal (elak mampatan WhatsApp) atau ambil dari dekat | Jika imej ada kod: guna foto asal (elakkan mampatan WhatsApp) atau ambil gambar dari dekat | grammar |
| `r_issuer` | Issuer | Pengeluar | Pengeluar dokumen | "pengeluar" alone also means manufacturer |
| `zoom` | Click to zoom | Klik untuk zum | Klik untuk besarkan | avoid loanword "zum" |
| `done_edit` | ✓ Done editing | ✓ Selesai edit | ✓ Selesai menyunting | sunting (DBP) for edit |
| `edit` | ✎ Edit result | ✎ Edit keputusan | ✎ Sunting keputusan | sunting (DBP) |
| `edit_hint` | Click any value to edit; Enter or click elsewhere to save | Klik mana-mana nilai untuk edit; Enter atau klik di tempat lain untuk simpan | Klik mana-mana nilai untuk menyunting; tekan Enter atau klik di tempat lain untuk menyimpan | sunting (DBP); grammar |
| `b_mut` | Info | Info | Maklumat | avoid "Info" |
| `fix` | Edit | Edit | Sunting | sunting (DBP) |
| `v_warn` | Items to confirm | Ada item perlu disahkan | Ada item yang perlu disahkan | grammar |
| `agree` |  · A/B agreement {p}% |  · Persetujuan A/B {p}% |  · Kesepadanan A/B {p}% | "persetujuan" = consent/approval |
| `f_reg` | Reg. no. | No. daftar | No. pendaftaran | standard form |
| `f_tax` | Tax ID | No. cukai | No. pengenalan cukai (TIN) | term used by LHDN/HASiL for TIN |
| `f_contact` | Contact | Hubungan | Maklumat hubungan | "hubungan" alone = relationship |
| `stamps_h` | Stamps / chops | Cop / chop | Cop | "chop" is Malaysian English |
| `fix_prompt` | Edit {f} | Edit {f} | Sunting {f} | sunting (DBP) |
| `rc_near_d` | Invoice shows {v} (1 character different — check for misreading) | Invois menunjukkan {v} (beza 1 aksara — semak salah baca) | Invois menunjukkan {v} (berbeza 1 aksara — semak kemungkinan salah baca) | grammar |
| `pv_custom` | Other / relay (OpenAI-compatible) | Lain-lain / relay (serasi OpenAI) | Lain-lain / perantara (serasi OpenAI) | relay → perantara |
| `h_title` | Get your {p} API key | Cara mendapatkan kunci {p} | Cara mendapatkan API key {p} | consistent term "API key" |
| `h_custom1` | Ask your relay/provider for its Base URL (usually ends with /v1) and an API key. | Minta Base URL (biasanya berakhir dengan /v1) dan API key daripada relay/penyedia anda. | Minta Base URL (biasanya berakhir dengan /v1) dan API key daripada perantara/penyedia anda. | relay → perantara |
| `h_custom2` | Ask which model names support images (vision), e.g. gpt-4o, gemini-2.5-flash, qwen-vl-max. | Tanya nama model yang menyokong imej (vision), cth. gpt-4o, gemini-2.5-flash, qwen-vl-max. | Tanya nama model yang menyokong imej, cth. gpt-4o, gemini-2.5-flash, qwen-vl-max. | drop "vision" |
| `hn_gemini` | Has a free tier with rate limits. gemini-2.5-flash is fast and reads images. | Ada tahap percuma (dengan had kadar). gemini-2.5-flash pantas dan boleh membaca imej. | Ada pelan percuma (dengan had kadar). gemini-2.5-flash pantas dan boleh membaca imej. | tier → pelan |
| `hn_openrouter` | One key for many vendors; check each model page for “image” input. Some free models are slow or rate-limited. | Satu kunci untuk banyak vendor; semak halaman model untuk input “image”. Sesetengah model percuma perlahan atau terhad. | Satu kunci untuk banyak pembekal; semak halaman setiap model untuk input “image”. Sesetengah model percuma perlahan atau dihadkan. | vendor → pembekal |
| `hn_custom` | Many relays work directly from the browser; if you get a CORS error, set a CORS proxy under Advanced. | Banyak relay boleh dipanggil terus dari pelayar; jika berlaku ralat CORS, tetapkan proksi CORS di bahagian Lanjutan. | Banyak perantara boleh dipanggil terus dari pelayar; jika berlaku ralat CORS, tetapkan proksi CORS di bahagian Lanjutan. | relay → perantara |
| `h_novision` | Its models are text-only: fine for Excel / CSV / Word, but images and PDFs will fail. Use a vision model for those. | Modelnya teks sahaja: sesuai untuk Excel / CSV / Word, tetapi imej dan PDF akan gagal. Guna model vision untuk itu. | Model penyedia ini hanya untuk teks: sesuai untuk Excel / CSV / Word, tetapi imej dan PDF akan gagal. Gunakan model yang menyokong imej untuk itu. | drop "vision"; clearer |
