"""Upload (image / PDF / audio), demo mode and AI-fallback behaviour."""
from datetime import datetime, timezone

from conftest import DEMO, analyze_text, upload

from app.config import settings
from app.services import ai as ai_mod


def test_image_upload_uses_demo_ocr_fixture(client):
    r = upload(client, DEMO / "images" / "demo_quotation_supplierB_QT-552.png", "quotation")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["artifact"]["mime"] == "image/png" and body["artifact"]["is_demo"] is True
    assert body["understanding"]["mode"] == "demo"
    [p] = body["proposals"]
    assert p["type"] == "SUPPLIER_QUOTE" and p["payload"]["supplier_id"] == "SUP-B" and p["payload"]["unit_price"] == 36


def test_pdf_reports_page_count(client):
    body = upload(client, DEMO / "documents" / "demo_invoice_householdhub_HH-7790.pdf", "invoice").json()
    assert body["artifact"]["page_count"] == 1
    assert body["understanding"]["page_count"] == 1
    assert body["proposals"], "PDF text should yield at least one event"


def test_audio_upload_is_labelled_demo_transcription(client):
    with open(DEMO / "audio" / "demo_voice_payment_ramesh.wav", "rb") as fh:
        body = client.post("/api/inputs/analyze", data={"kind": "voice"}, files={"file": ("v.wav", fh)}).json()
    assert body["artifact"]["transcription"] == "DEMO TRANSCRIPTION"
    assert "DEMO TRANSCRIPTION" in body["artifact"]["note"]
    assert body["proposals"][0]["type"] == "PAYMENT_RECEIVED"


def test_audio_with_browser_transcript(client):
    with open(DEMO / "audio" / "demo_voice_payment_ramesh.wav", "rb") as fh:
        body = client.post("/api/inputs/analyze", data={"kind": "voice", "text": "Aaj 5 Maggi becha"},
                           files={"file": ("v.wav", fh)}).json()
    assert body["artifact"]["transcription"] == "BROWSER"
    assert body["proposals"][0]["type"] == "SALE"


def test_unknown_audio_without_transcript_explains_demo_mode(client):
    import io
    import struct
    wav = b"RIFF" + struct.pack("<I", 36) + b"WAVEfmt " + b"\x00" * 24  # minimal header, unknown hash
    body = client.post("/api/inputs/analyze", data={"kind": "voice"}, files={"file": ("x.wav", io.BytesIO(wav))}).json()
    assert body["proposals"] == []
    assert "Demo Mode" in body["understanding"]["notice"]


def test_ai_failure_falls_back_to_rules(client, monkeypatch):
    monkeypatch.setattr(type(settings), "ai_live", property(lambda self: True))

    def boom(*a, **k):
        raise RuntimeError("network down")
    monkeypatch.setattr(ai_mod.GeminiService, "_call_gemini", boom)
    body = analyze_text(client, "Aaj 5 Maggi becha", kind="text").json()
    assert body["understanding"]["mode"] == "fallback"
    assert "AI SERVICE UNAVAILABLE" in body["understanding"]["notice"]
    assert body["proposals"][0]["type"] == "SALE"
    # a file with no text cannot be read → clear notice, no invented events
    r = upload(client, DEMO / "images" / "demo_receipt_householdhub_HH-7802.png", "receipt").json()
    assert r["understanding"]["mode"] in ("fallback", "demo")


def test_demo_reset_restores_start_state(client):
    analyze_text(client, "Aaj 5 Maggi becha", kind="text")
    assert client.post("/api/demo/reset").json()["ok"] is True
    s = client.get("/api/business-state").json()["summary"]
    assert s["cash"] == 42850 and s["needs_review"] == 0
    assert client.get("/api/inputs").json() == []


def test_simulation_preview_badges_and_no_save(client):
    before = len(client.get("/api/simulations").json())
    r = client.post("/api/simulations/preview", json={"sku": "SKU-1042", "scenarios": [
        {"supplier_id": "SUP-A", "qty": 100, "discount_pct": 15}, {"supplier_id": "SUP-B", "qty": 20}, {"supplier_id": "SUP-C", "qty": 50}]})
    assert r.status_code == 200, r.text
    b = r.json()["verdict"]["badges"]
    assert set(b) == {"best_cost", "best_speed", "best_coverage", "best_balanced"}
    assert b["best_speed"].startswith("Supplier B") and b["best_cost"].startswith("Supplier A")
    assert len(client.get("/api/simulations").json()) == before


def test_ledger_filters(client):
    upload(client, DEMO / "images" / "demo_invoice_metro_INV-2841.png", "invoice")
    evs = client.get("/api/events", params={"source": "invoice"}).json()
    assert evs and all(e["source_type"] == "invoice" for e in evs)
    t = client.get("/api/events", params={"type": "RISK_DETECTED"}).json()
    assert t and all(e["type"] == "RISK_DETECTED" for e in t)
    today = datetime.now(timezone.utc).date().isoformat()
    d = client.get("/api/events", params={"from": today, "to": today}).json()
    assert d and all(e["ts"][:10] == today for e in d)
    assert client.get("/api/events", params={"from": "nope"}).status_code == 422
