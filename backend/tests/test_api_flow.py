"""End-to-end SEE → THINK → ACT through the HTTP API (Demo Mode)."""
from conftest import DEMO, analyze_text, confirm_all, upload


def coke(client):
    return next(r for r in client.get("/api/inventory").json() if r["sku"] == "SKU-1042")


def test_health_and_seed(client):
    h = client.get("/api/health").json()
    assert h["mode"] == "DEMO" and h["database"]["ok"]
    s = client.get("/api/business-state").json()
    assert s["summary"]["cash"] == 42850
    assert len(s["inventory"]) >= 20 and len(s["suppliers"]) >= 5 and len(s["orders"]) >= 5
    assert len(client.get("/api/risks").json()) >= 3
    assert len(client.get("/api/recommendations?status=PENDING").json()) >= 3
    assert len(client.get("/api/events").json()) >= 10


def test_invoice_image_creates_events_and_updates_inventory(client):
    r = upload(client, DEMO / "images" / "demo_invoice_metro_INV-2841.png", "invoice")
    assert r.status_code == 200, r.text
    body = r.json()
    types = [p["type"] for p in body["proposals"]]
    assert types.count("PURCHASE_RECEIVED") == 2 and "SUPPLIER_PRICE_UPDATE" in types
    assert body["understanding"]["document_no"] == "INV-2841"
    assert all(p["status"] == "PROPOSED" for p in body["proposals"])
    before = coke(client)
    res = confirm_all(client, body["proposals"])
    after = coke(client)
    assert after["on_hand"] == before["on_hand"] + 40 and after["incoming"] == 0   # closes PO OFF-2026-087
    titles = [e["title"] for x in res for e in x["intelligence"]]
    assert "Price anomaly detected" in titles


def test_duplicate_invoice_is_rejected(client):
    body = upload(client, DEMO / "images" / "demo_invoice_metro_INV-2841.png", "invoice").json()
    confirm_all(client, body["proposals"])
    again = upload(client, DEMO / "images" / "demo_invoice_metro_INV-2841.png", "invoice").json()
    r = client.post(f"/api/proposals/{again['proposals'][0]['id']}/confirm", json={})
    assert r.status_code == 409 and "Duplicate" in r.text


def test_pdf_invoice_is_parsed(client):
    body = upload(client, DEMO / "documents" / "demo_invoice_householdhub_HH-7790.pdf", "invoice").json()
    skus = {p["payload"].get("sku") for p in body["proposals"] if p["type"] == "PURCHASE_RECEIVED"}
    assert {"SKU-1050", "SKU-1054", "SKU-1053"} <= skus


def test_message_order_creates_stockout_and_recommendation(client):
    confirm_all(client, upload(client, DEMO / "images" / "demo_invoice_metro_INV-2841.png", "invoice").json()["proposals"])
    body = analyze_text(client, "Kal 25 Coke aur 10 Sprite bhej dena", sender="Ramesh Stores").json()
    [p] = body["proposals"]
    assert p["type"] == "CUSTOMER_ORDER" and p["payload"]["customer_id"] == "CUST-01"
    res = client.post(f"/api/proposals/{p['id']}/confirm", json={}).json()
    assert any(e["title"] == "Stock shortage predicted" for e in res["intelligence"])
    risk = next(r for r in client.get("/api/risks").json() if r["type"] == "STOCKOUT" and r["sku"] == "SKU-1042")
    assert risk["metrics"]["expected_shortage"] == 11
    rec = next(r for r in client.get("/api/recommendations?status=PENDING").json() if r["sku"] == "SKU-1042")
    assert rec["supplier_id"] == "SUP-B" and rec["qty"] == 20 and rec["total"] == 780


def test_ambiguous_entity_needs_review(client):
    [p] = analyze_text(client, "Ramesh paid ₹3,000").json()["proposals"]
    assert p["status"] == "NEEDS_REVIEW" and len(p["candidates"]) == 2
    assert client.post(f"/api/proposals/{p['id']}/confirm", json={}).status_code == 400
    ok = client.post(f"/api/proposals/{p['id']}/confirm", json={"overrides": {"customer_id": "CUST-02"}})
    assert ok.status_code == 200


def test_voice_payment_updates_receivable(client):
    with open(DEMO / "audio" / "demo_voice_payment_ramesh.wav", "rb") as fh:
        body = client.post("/api/inputs/analyze", data={"kind": "voice"}, files={"file": ("v.wav", fh)}).json()
    [p] = body["proposals"]
    assert p["type"] == "PAYMENT_RECEIVED" and p["payload"]["customer_id"] == "CUST-01"
    client.post(f"/api/proposals/{p['id']}/confirm", json={})
    cust = next(c for c in client.get("/api/customers").json() if c["id"] == "CUST-01")
    assert cust["receivable"] == 4500


def test_low_confidence_extraction_goes_to_review(client):
    [p] = analyze_text(client, "Coke bhej dena", sender="Sharma Kirana").json()["proposals"]
    assert p["status"] == "NEEDS_REVIEW"


def test_approval_creates_po_and_updates_state(client):
    confirm_all(client, upload(client, DEMO / "images" / "demo_invoice_metro_INV-2841.png", "invoice").json()["proposals"])
    p = analyze_text(client, "Kal 25 Coke aur 10 Sprite bhej dena", sender="Ramesh Stores").json()["proposals"][0]
    client.post(f"/api/proposals/{p['id']}/confirm", json={})
    rec = next(r for r in client.get("/api/recommendations?status=PENDING").json() if r["sku"] == "SKU-1042")
    assert client.post(f"/api/recommendations/{rec['id']}/approve", json={}).status_code == 400   # needs explicit approval
    res = client.post(f"/api/recommendations/{rec['id']}/approve", json={"acknowledged": True}).json()
    assert res["purchase_order"]["id"] == "OFF-2026-091" and res["approval"]["id"] == "APR-0091"
    assert res["before"]["predicted_shortage"] == 11 and res["after"]["predicted_shortage"] == 0
    detail = client.get(f"/api/events/{res['events'][1]['id']}").json()
    assert detail["approval"]["actor"] == "Rajesh Sharma" and detail["trace"]["upstream"]
    rcv = client.post(f"/api/purchase-orders/{res['purchase_order']['id']}/receive", json={}).json()
    assert rcv["purchase_order"]["status"] == "RECEIVED"
    assert coke(client)["on_hand"] == 60


def test_reject_recommendation(client):
    rec = client.get("/api/recommendations?status=PENDING").json()[0]
    r = client.post(f"/api/recommendations/{rec['id']}/reject", json={"reason": "Buying from local market"})
    assert r.json()["status"] == "REJECTED"


def test_invalid_inputs_are_refused(client):
    assert client.post("/api/events", json={"type": "SALE", "payload": {"sku": "SKU-1042", "qty": 999, "unit_price": 45}}).status_code == 400
    assert client.post("/api/events", json={"type": "SALE", "payload": {"sku": "SKU-1042", "qty": -2, "unit_price": 45}}).status_code == 400
    assert client.post("/api/inputs/analyze", data={"kind": "image"}, files={"file": ("x.png", b"not an image")}).status_code == 415
    assert client.post("/api/simulations", json={"sku": "SKU-1042", "scenarios": [{"qty": 0, "unit_price": 10}]}).status_code == 400


def test_simulation_endpoint(client):
    r = client.post("/api/simulations", json={"sku": "SKU-1042", "question": "15% discount if I buy 100?",
                                              "scenarios": [{"supplier_id": "SUP-A", "qty": 100, "discount_pct": 15},
                                                            {"supplier_id": "SUP-B", "qty": 55}]})
    assert r.status_code == 201
    sim = r.json()
    assert client.get(f"/api/simulations/{sim['id']}").status_code == 200
    assert sim["results"]["verdict"]["best_label"].startswith("Supplier B")


def test_reverse_event(client):
    ev = client.post("/api/events", json={"type": "SALE", "payload": {"sku": "SKU-1001", "qty": 2, "unit_price": 28}}).json()["event"]
    before = next(r for r in client.get("/api/inventory").json() if r["sku"] == "SKU-1001")["on_hand"]
    assert client.post(f"/api/events/{ev['id']}/reverse", json={"reason": "typo"}).status_code == 200
    after = next(r for r in client.get("/api/inventory").json() if r["sku"] == "SKU-1001")["on_hand"]
    assert after == before + 2


def test_analytics(client):
    a = client.get("/api/analytics").json()
    assert len(a["series"]) == 8 and a["insights"]["cash"]
