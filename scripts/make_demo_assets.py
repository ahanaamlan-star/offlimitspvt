"""Generate the bundled DEMO assets (fictional documents, clearly watermarked).

Run:  python scripts/make_demo_assets.py
Creates data/demo/{images,documents,audio}/… and data/fixtures/demo_assets.json, which maps each
file's SHA-256 to the text a demo "OCR" pass would return. In LIVE mode (GEMINI_API_KEY set) the
fixtures are ignored and Gemini reads the images directly.
"""
from __future__ import annotations

import hashlib
import json
import math
import struct
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "data" / "demo"
FIX = ROOT / "data" / "fixtures"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_M = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def watermark(img: Image.Image):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    f = font(FONT_B, 64)
    d.text((img.width * 0.12, img.height * 0.45), "DEMO DATA · FICTIONAL", font=f, fill=(220, 38, 38, 40))
    layer = layer.rotate(18, expand=False)
    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def document_png(path: Path, title: str, header: list[str], meta: list[str], rows: list[tuple], footer: list[str],
                 accent=(79, 70, 229)):
    W, H = 1100, 1250
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 16], fill=accent)
    d.text((60, 60), header[0], font=font(FONT_B, 40), fill=(15, 23, 42))
    for i, line in enumerate(header[1:]):
        d.text((60, 115 + i * 30), line, font=font(FONT, 22), fill=(71, 85, 105))
    d.text((W - 60, 60), title, font=font(FONT_B, 34), fill=accent, anchor="ra")
    for i, line in enumerate(meta):
        d.text((W - 60, 115 + i * 30), line, font=font(FONT_M, 22), fill=(30, 41, 59), anchor="ra")
    y = 300
    d.rectangle([60, y, W - 60, y + 50], fill=(241, 245, 249))
    cols = [80, 620, 780, 940]
    for x, h in zip(cols, ["Item", "Qty", "Rate", "Amount"]):
        d.text((x if h == "Item" else x + 60, y + 12), h, font=font(FONT_B, 22), fill=(51, 65, 85), anchor="la" if h == "Item" else "ra")
    y += 70
    for r in rows:
        d.text((cols[0], y), str(r[0]), font=font(FONT, 26), fill=(15, 23, 42))
        for x, v in zip(cols[1:], r[1:]):
            d.text((x + 60, y), str(v), font=font(FONT_M, 26), fill=(15, 23, 42), anchor="ra")
        y += 58
        d.line([60, y - 12, W - 60, y - 12], fill=(226, 232, 240), width=2)
    y += 20
    for i, line in enumerate(footer):
        d.text((W - 60, y + i * 40), line, font=font(FONT_B if i == 0 else FONT, 28 if i == 0 else 22),
               fill=(15, 23, 42) if i == 0 else (71, 85, 105), anchor="ra")
    d.text((60, H - 80), "This is a fictional document generated for the OFFLIMITS demo. Not a real tax invoice.",
           font=font(FONT, 20), fill=(220, 38, 38))
    img = watermark(img)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)


def ocr_text(header, title, meta, rows, footer) -> str:
    lines = [header[0], *header[1:], title, *meta, "Item Qty Rate Amount"]
    lines += [" ".join(str(c) for c in r) for r in rows]
    lines += footer
    return "\n".join(lines)


def make_pdf(path: Path, header, title, meta, rows, footer):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=A4)
    w, h = A4
    c.setFont("Helvetica-Bold", 20)
    c.drawString(50, h - 60, header[0])
    c.setFont("Helvetica", 11)
    for i, line in enumerate(header[1:]):
        c.drawString(50, h - 82 - i * 15, line)
    c.setFont("Helvetica-Bold", 16)
    c.drawRightString(w - 50, h - 60, title)
    c.setFont("Helvetica", 11)
    for i, line in enumerate(meta):
        c.drawRightString(w - 50, h - 82 - i * 15, line)
    y = h - 180
    c.setFont("Helvetica-Bold", 11)
    c.drawString(50, y, "Item Qty Rate Amount")
    c.setFont("Helvetica", 11)
    for r in rows:
        y -= 22
        c.drawString(50, y, " ".join(str(x) for x in r))
    y -= 34
    for line in footer:
        c.drawString(50, y, line)
        y -= 16
    c.setFillColorRGB(0.86, 0.15, 0.15)
    c.drawString(50, 50, "DEMO DATA - fictional document generated for the OFFLIMITS demo. Not a real tax invoice.")
    c.save()


def make_tone_wav(path: Path, seconds=2.0, rate=16000):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        frames = b"".join(struct.pack("<h", int(6000 * math.sin(2 * math.pi * 440 * t / rate) * (1 if (t // 4000) % 2 == 0 else 0.3)))
                          for t in range(int(seconds * rate)))
        wf.writeframes(frames)


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    fixtures = {}

    # 1) Metro Beverages invoice — the primary demo story (closes PO OFF-2026-087, Coke price ₹35 → ₹38)
    h = ["Metro Beverages", "Wholesale beverage distributor (DEMO)", "Mumbai · GSTIN: DEMO-NOT-REAL"]
    meta = ["Invoice No: INV-2841", "Bill to: Rajesh General Stores", "Credit: 7 days"]
    rows = [("Coke", 40, 38, 1520), ("Sprite", 30, 34, 1020)]
    foot = ["Total 2540", "Payment terms: 7 days credit"]
    p = DEMO / "images" / "demo_invoice_metro_INV-2841.png"
    document_png(p, "TAX INVOICE", h, meta, rows, foot)
    fixtures[sha(p)] = {"filename": p.name, "kind": "invoice", "label": "Supplier invoice · Metro Beverages INV-2841",
                        "ocr_text": ocr_text(h, "TAX INVOICE", meta, rows, foot)}

    # 2) Supplier B quotation
    h = ["Beverages Distribution Co.", "Supplier B (DEMO)", "Same-day delivery in Mumbai"]
    meta = ["Quotation QT-552", "MOQ 20", "Credit: 15 days", "Delivery: today"]
    rows = [("Thums Up 300ml", 24, 36, 864)]
    foot = ["Total 864", "Valid for 7 days"]
    p = DEMO / "images" / "demo_quotation_supplierB_QT-552.png"
    document_png(p, "QUOTATION", h, meta, rows, foot, accent=(8, 145, 178))
    fixtures[sha(p)] = {"filename": p.name, "kind": "quotation", "label": "Quotation · Supplier B QT-552",
                        "ocr_text": ocr_text(h, "QUOTATION", meta, rows, foot)}

    # 3) Cash receipt — Household Hub
    h = ["Household Hub Distributors", "Supplier E (DEMO)", "Cash & carry counter"]
    meta = ["Bill No: HH-7802", "Paid: cash", "Credit: 0 days"]
    rows = [("Vim Bar", 36, 16, 576)]
    foot = ["Total 576", "Paid in full"]
    p = DEMO / "images" / "demo_receipt_householdhub_HH-7802.png"
    document_png(p, "CASH RECEIPT", h, meta, rows, foot, accent=(21, 128, 61))
    fixtures[sha(p)] = {"filename": p.name, "kind": "receipt", "label": "Cash receipt · Household Hub HH-7802",
                        "ocr_text": ocr_text(h, "CASH RECEIPT", meta, rows, foot)}

    # 4) Text-based PDF invoice (parsed for real with pypdf in Demo Mode)
    h = ["Household Hub Distributors", "Supplier E (DEMO)", "Mumbai"]
    meta = ["Invoice No: HH-7790", "Bill to: Rajesh General Stores", "Credit: 15 days"]
    rows = [("Surf Excel 1kg", 12, 118, 1416), ("Harpic 500ml", 12, 46, 552), ("Dettol Soap", 24, 37, 888)]
    foot = ["Total 2856", "Payment terms: 15 days credit"]
    p = DEMO / "documents" / "demo_invoice_householdhub_HH-7790.pdf"
    make_pdf(p, h, "TAX INVOICE", meta, rows, foot)
    fixtures[sha(p)] = {"filename": p.name, "kind": "invoice", "label": "Supplier invoice · Household Hub HH-7790 (PDF)"}

    # 5) Placeholder audio (a tone, not speech) with a bundled demo transcript
    p = DEMO / "audio" / "demo_voice_payment_ramesh.wav"
    make_tone_wav(p)
    fixtures[sha(p)] = {"filename": p.name, "kind": "voice", "label": "Voice note (demo placeholder audio)",
                        "transcript": "Ramesh Stores ne 3000 rupaye de diye"}

    FIX.mkdir(parents=True, exist_ok=True)
    (FIX / "demo_assets.json").write_text(json.dumps(fixtures, indent=2, ensure_ascii=False))
    # the in-browser engine (static / Netlify build) bundles the same fixtures and serves the assets from public/
    web = ROOT / "frontend"
    (web / "lib" / "engine" / "fixtures.json").write_text(json.dumps(fixtures, indent=2, ensure_ascii=False))
    import shutil
    for folder in ("images", "documents", "audio"):
        dst = web / "public" / "demo" / folder
        dst.mkdir(parents=True, exist_ok=True)
        for f in (DEMO / folder).iterdir():
            shutil.copy2(f, dst / f.name)
    print(f"Wrote {len(fixtures)} fixtures and assets under {DEMO}")


if __name__ == "__main__":
    main()
