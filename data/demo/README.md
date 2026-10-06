# Demo assets — DEMO DATA

Everything in this folder is **fictional** and watermarked "DEMO DATA". None of it is a real invoice,
receipt, supplier or merchant record.

| Folder | What goes here | Bundled files |
|---|---|---|
| `images/` | Invoice photos, receipts, supplier quotations, product photos (PNG/JPG/WEBP) | `demo_invoice_metro_INV-2841.png`, `demo_quotation_supplierB_QT-552.png`, `demo_receipt_householdhub_HH-7802.png` |
| `documents/` | Supplier invoices / quotations as PDF | `demo_invoice_householdhub_HH-7790.pdf` (text PDF, parsed for real with pypdf) |
| `audio/` | Voice notes (webm/ogg/wav/mp3/m4a) | `demo_voice_payment_ramesh.wav` (placeholder tone + bundled transcript) |

## How the demo reads these files

* **Demo Mode (no `GEMINI_API_KEY`)** — images have no OCR engine, so `data/fixtures/demo_assets.json`
  stores the text an OCR pass would return, keyed by the file's SHA-256. That text then goes through the
  same deterministic parser used for typed messages. PDFs with a text layer are parsed directly.
  The placeholder audio file uses its bundled transcript.
* **Live Mode (`GEMINI_API_KEY` set)** — Gemini reads images, PDFs and audio directly; fixtures are ignored.

## Adding your own files

Drop your own images/PDFs anywhere and upload them on the **SEE** page. In Demo Mode, a new image
without a fixture is marked **NEEDS REVIEW** (OFFLIMITS never guesses), and you can type the details
instead. Regenerate the bundled assets with `python scripts/make_demo_assets.py`.
