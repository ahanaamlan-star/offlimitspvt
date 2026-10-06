"""Seeded DEMO DATA. Fictional business, fictional people. Nothing here is real merchant data."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.db.session import Base, engine
from app.models import Approval, Customer, InventoryItem, Merchant, PurchaseOrder, Supplier, User
from app.services.ledger import Masters, append_event, get_state
from app.services.workflow import after_state_change

DEFAULT_SETTINGS = {
    "horizon_days": 1, "cover_days": 7, "min_margin_pct": 10, "margin_drop_pp": 3, "price_change_pct": 5,
    "mismatch_pct": 2, "min_cash_buffer": 10000, "receivable_alert": 5000, "confidence_threshold": 0.75,
    "language": "Hindi + English", "currency": "INR",
}

# sku, name, category, unit, sell, cost, target on_hand at demo start, reorder, daily demand, aliases
ITEMS = [
    ("SKU-1001", "Tata Salt 1kg", "Grocery", "pack", 28, 22, 60, 20, 6, ["salt", "namak", "tata salt"]),
    ("SKU-1002", "Aashirvaad Atta 5kg", "Grocery", "bag", 265, 238, 18, 8, 3, ["atta", "aata", "aashirvaad"]),
    ("SKU-1003", "Fortune Sunflower Oil 1L", "Grocery", "pouch", 155, 138, 9, 10, 3, ["oil", "tel", "fortune", "sunflower oil"]),
    ("SKU-1004", "India Gate Basmati 1kg", "Grocery", "pack", 140, 118, 22, 8, 2, ["basmati", "rice", "chawal", "india gate"]),
    ("SKU-1005", "Toor Dal 1kg", "Grocery", "pack", 165, 142, 25, 10, 3, ["toor dal", "arhar dal", "dal"]),
    ("SKU-1006", "Sugar 1kg", "Grocery", "pack", 48, 41, 40, 15, 5, ["sugar", "cheeni", "shakkar"]),
    ("SKU-1010", "Parle-G 250g", "FMCG", "pack", 25, 21, 30, 25, 8, ["parle-g", "parle g", "parleg", "biscuit"]),
    ("SKU-1011", "Maggi Noodles 4-pack", "FMCG", "pack", 60, 51, 35, 12, 4, ["maggi", "noodles"]),
    ("SKU-1012", "Lay's Classic 52g", "FMCG", "pack", 20, 16, 48, 15, 6, ["lays", "lay's", "chips"]),
    ("SKU-1013", "Britannia Good Day 200g", "FMCG", "pack", 40, 33, 26, 10, 3, ["good day", "britannia"]),
    ("SKU-1020", "Amul Butter 100g", "FMCG", "pack", 58, 50, 24, 8, 3, ["butter", "amul butter", "makhan"]),
    ("SKU-1021", "Amul Taaza Milk 1L", "FMCG", "pouch", 70, 62, 30, 20, 12, ["milk", "doodh", "amul milk", "taaza"]),
    ("SKU-1042", "Coca-Cola 300ml", "Beverages", "bottle", 45, 35, 0, 8, 6, ["coke", "coca cola", "coca-cola", "cola"]),
    ("SKU-1043", "Sprite 300ml", "Beverages", "bottle", 40, 34, 12, 10, 4, ["sprite"]),
    ("SKU-1044", "Thums Up 300ml", "Beverages", "bottle", 45, 35, 28, 12, 4, ["thums up", "thumbs up", "thumsup"]),
    ("SKU-1050", "Surf Excel 1kg", "Household", "pack", 140, 118, 6, 10, 2, ["surf", "surf excel", "detergent"]),
    ("SKU-1051", "Vim Bar 200g", "Household", "bar", 20, 16, 40, 12, 3, ["vim", "vim bar"]),
    ("SKU-1052", "Colgate Strong Teeth 200g", "Household", "tube", 110, 92, 18, 6, 2, ["colgate", "toothpaste"]),
    ("SKU-1053", "Dettol Soap 75g", "Household", "bar", 45, 37, 30, 10, 3, ["dettol", "soap"]),
    ("SKU-1054", "Harpic 500ml", "Household", "bottle", 99, 42, 14, 6, 1, ["harpic", "toilet cleaner"]),
]

SUPPLIERS = [
    ("SUP-A", "Supplier A", "Shree Wholesale Mart", 0.90, ["shree wholesale", "shree"]),
    ("SUP-B", "Supplier B", "Beverages Distribution Co.", 0.95, ["beverages distribution", "bdc"]),
    ("SUP-C", "Supplier C", "City Cash & Carry", 0.85, ["city cash", "cash and carry", "cash & carry"]),
    ("SUP-D", "Supplier D", "Metro Beverages", 0.92, ["metro beverages", "metro"]),
    ("SUP-E", "Supplier E", "Household Hub Distributors", 0.88, ["household hub"]),
]

CUSTOMERS = [
    ("CUST-01", "Ramesh Stores", "retailer", ["ramesh", "ramesh bhai", "ramesh stores", "ramesh store"]),
    ("CUST-02", "Ramesh Kumar", "retailer", ["ramesh", "ramesh kumar", "rameshji"]),
    ("CUST-03", "Sharma Kirana", "retailer", ["sharma", "sharma ji", "sharma kirana"]),
    ("CUST-04", "Hotel Annapurna", "horeca", ["annapurna", "hotel annapurna"]),
    ("CUST-05", "Priya Caterers", "horeca", ["priya", "priya caterers"]),
]

# supplier quotes: (supplier, sku, price, moq, delivery_days, credit_days)
QUOTES = [
    ("SUP-A", "SKU-1042", 36, 100, 2, 0), ("SUP-B", "SKU-1042", 39, 20, 0, 15), ("SUP-C", "SKU-1042", 37, 50, 1, 0),
    ("SUP-D", "SKU-1042", 35, 40, 3, 7),
    ("SUP-B", "SKU-1043", 35, 20, 0, 15), ("SUP-D", "SKU-1043", 34, 30, 3, 7), ("SUP-C", "SKU-1043", 34.5, 48, 1, 0),
    ("SUP-B", "SKU-1044", 36, 24, 0, 15), ("SUP-D", "SKU-1044", 35, 40, 3, 7),
    ("SUP-A", "SKU-1003", 136, 24, 1, 0), ("SUP-C", "SKU-1003", 138, 12, 0, 0), ("SUP-E", "SKU-1003", 141, 10, 1, 10),
    ("SUP-A", "SKU-1010", 20.5, 96, 1, 0), ("SUP-C", "SKU-1010", 21, 48, 0, 0),
    ("SUP-A", "SKU-1050", 116, 24, 2, 0), ("SUP-E", "SKU-1050", 118, 12, 1, 15),
    ("SUP-E", "SKU-1054", 42, 12, 2, 15), ("SUP-E", "SKU-1051", 16, 36, 1, 15), ("SUP-E", "SKU-1053", 37, 24, 1, 15),
    ("SUP-E", "SKU-1052", 92, 12, 2, 15),
    ("SUP-A", "SKU-1001", 22, 50, 1, 0), ("SUP-A", "SKU-1002", 238, 10, 1, 0), ("SUP-A", "SKU-1004", 118, 20, 1, 0),
    ("SUP-A", "SKU-1005", 142, 20, 1, 0), ("SUP-A", "SKU-1006", 41, 50, 1, 0), ("SUP-C", "SKU-1011", 51, 24, 0, 0),
    ("SUP-C", "SKU-1012", 16, 48, 0, 0), ("SUP-C", "SKU-1013", 33, 24, 0, 0), ("SUP-C", "SKU-1020", 50, 20, 0, 0),
    ("SUP-C", "SKU-1021", 62, 24, 0, 0),
]

# 7 days of daily sales (oldest → yesterday) for items with real movement in the demo
SALES = {
    "SKU-1042": [5, 7, 6, 4, 8, 6, 6], "SKU-1043": [3, 4, 5, 3, 4, 4, 5], "SKU-1010": [7, 9, 8, 6, 9, 8, 9],
    "SKU-1021": [11, 13, 12, 10, 14, 12, 12], "SKU-1003": [2, 3, 3, 4, 3, 2, 4], "SKU-1011": [4, 3, 5, 4, 4, 3, 5],
    "SKU-1050": [2, 1, 3, 2, 2, 2, 2], "SKU-1012": [5, 7, 6, 6, 5, 7, 6],
}

# open orders at demo start: order_id, customer, items, due-in-days, hours ago
ORDERS = [
    ("ORD-501", "CUST-03", [("SKU-1042", 20)], 1, 20),
    ("ORD-502", "CUST-04", [("SKU-1020", 6), ("SKU-1021", 10)], 1, 6),
    ("ORD-503", "CUST-04", [("SKU-1003", 8)], 1, 5),
    ("ORD-504", "CUST-02", [("SKU-1010", 40)], 1, 4),
    ("ORD-505", "CUST-05", [("SKU-1002", 4), ("SKU-1005", 5)], 2, 3),
]


def reset_database(db: Session) -> None:
    db.close()
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def seed(db: Session) -> None:
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=8)).replace(hour=3, minute=30, second=0, microsecond=0)

    db.add(Merchant(id="MER-001", name="Rajesh General Stores", owner="Rajesh Sharma", city="Mumbai (demo)", currency="INR",
                    settings=dict(DEFAULT_SETTINGS), is_demo=True))
    db.add(User(id="USR-001", merchant_id="MER-001", name="Rajesh Sharma", role="owner"))
    for sku, name, cat, unit, sell, cost, target, rop, daily, aliases in ITEMS:
        db.add(InventoryItem(sku=sku, name=name, category=cat, unit=unit, selling_price=sell, reorder_point=rop,
                             daily_demand=daily, aliases=aliases))
    for sid, short, name, rel, aliases in SUPPLIERS:
        db.add(Supplier(id=sid, short_name=short, name=name, reliability=rel, city="Mumbai (demo)", aliases=aliases))
    for cid, name, kind, aliases in CUSTOMERS:
        db.add(Customer(id=cid, name=name, kind=kind, aliases=aliases))
    db.flush()
    m = Masters(db)

    def ev(etype, payload, ts, category="EVENT", **kw):
        kw.setdefault("source_type", "seed")
        kw.setdefault("actor", "Demo seed")
        return append_event(db, etype, payload, category=category, ts=ts, masters=m, **kw)

    # Opening stock = stock at demo start + everything sold / committed since opening.
    sold = {sku: sum(v) for sku, v in SALES.items()}
    adjustments = {"SKU-1020": 0, "SKU-1054": 0}
    received_later = {"SKU-1020": 20, "SKU-1054": 12}  # bought during the week (see below)
    for sku, name, cat, unit, sell, cost, target, rop, daily, aliases in ITEMS:
        opening = target + sold.get(sku, 0) - received_later.get(sku, 0) + adjustments.get(sku, 0)
        if opening > 0:
            ev("OPENING_STOCK", {"sku": sku, "qty": opening, "unit_cost": cost}, start, category="OPENING",
               source_ref="Opening stock count (demo)")
    for sid, sku, price, moq, dd, cd in QUOTES:
        ev("SUPPLIER_QUOTE", {"supplier_id": sid, "sku": sku, "unit_price": price, "moq": moq, "delivery_days": dd, "credit_days": cd},
           start + timedelta(minutes=5), category="OPENING", source_ref="Supplier price list (demo)")
    ev("OPENING_RECEIVABLE", {"customer_id": "CUST-01", "amount": 7500}, start, category="OPENING", source_ref="Khata book (demo)")
    ev("OPENING_RECEIVABLE", {"customer_id": "CUST-04", "amount": 2400}, start, category="OPENING", source_ref="Khata book (demo)")
    ev("OPENING_PAYABLE", {"supplier_id": "SUP-A", "amount": 3200}, start, category="OPENING", source_ref="Supplier ledger (demo)")

    # Historical week: daily POS summaries, a few purchases, payments and a quote-vs-invoice mismatch.
    for d in range(7):
        day = start + timedelta(days=d + 1, hours=15)
        for sku, series in SALES.items():
            price = m.items_by_sku[sku].selling_price
            ev("SALE", {"sku": sku, "qty": series[d], "unit_price": price}, day, source_type="pos",
               source_ref="Daily POS summary (demo)", title=f'{series[d]} {m.item_name(sku)} sold (daily summary)')
    ev("SUPPLIER_QUOTE", {"supplier_id": "SUP-E", "sku": "SKU-1054", "unit_price": 42, "moq": 12, "delivery_days": 2, "credit_days": 15},
       start + timedelta(days=2, hours=6), source_type="quotation", source_ref="QT-118 (demo)", actor="Rajesh Sharma", confidence=0.96)
    ev("PURCHASE_RECEIVED", {"supplier_id": "SUP-E", "sku": "SKU-1054", "qty": 12, "unit_cost": 46, "credit_days": 15,
                             "invoice_no": "HH-7731"}, start + timedelta(days=4, hours=5), source_type="invoice",
       source_ref="HH-7731 (demo)", actor="Rajesh Sharma", confidence=0.95)
    ev("SUPPLIER_PRICE_UPDATE", {"supplier_id": "SUP-C", "sku": "SKU-1020", "old_price": 50, "new_price": 54, "change_pct": 8.0},
       start + timedelta(days=5, hours=4), source_type="message", source_ref="WhatsApp · City Cash & Carry (demo)",
       actor="Rajesh Sharma", confidence=0.93)
    ev("PURCHASE_RECEIVED", {"supplier_id": "SUP-C", "sku": "SKU-1020", "qty": 20, "unit_cost": 54, "credit_days": 0,
                             "invoice_no": "CCC-5520"}, start + timedelta(days=5, hours=6), source_type="invoice",
       source_ref="CCC-5520 (demo)", actor="Rajesh Sharma", confidence=0.97)
    ev("PAYMENT_RECEIVED", {"customer_id": "CUST-04", "amount": 2400, "mode": "UPI"}, start + timedelta(days=6, hours=7),
       source_type="message", source_ref="UPI SMS (demo)", actor="Rajesh Sharma", confidence=0.98)
    ev("PAYMENT_MADE", {"supplier_id": "SUP-A", "amount": 3200}, start + timedelta(days=6, hours=9), source_type="user",
       source_ref="Bank transfer (demo)", actor="Rajesh Sharma")

    # An open purchase order (approved earlier this week) that the demo invoice INV-2841 will close.
    po_ts = now - timedelta(days=3)
    db.add(Approval(id="APR-0087", recommendation_id=None, actor="Rajesh Sharma", decision="APPROVED",
                    note="Weekly beverage reorder (demo)", ts=po_ts))
    po_ev = ev("PURCHASE_ORDER_CREATED", {"po_id": "OFF-2026-087", "supplier_id": "SUP-D", "sku": "SKU-1042", "qty": 40,
                                          "unit_price": 35, "total": 1400, "credit_days": 7, "delivery_days": 3,
                                          "approval_id": "APR-0087"}, po_ts, category="ACTION", source_type="user",
               actor="Rajesh Sharma", approval_id="APR-0087", reason="Weekly beverage reorder (demo)")
    db.add(PurchaseOrder(id="OFF-2026-087", supplier_id="SUP-D", sku="SKU-1042", qty=40, unit_price=35, total=1400,
                         credit_days=7, delivery_days=3, status="APPROVED", approval_id="APR-0087", approved_by="Rajesh Sharma",
                         event_id=po_ev.id, created_at=po_ts))

    for oid, cid, items, due_days, hours_ago in ORDERS:
        ev("CUSTOMER_ORDER", {"order_id": oid, "customer_id": cid, "items": [{"sku": s, "qty": q} for s, q in items],
                              "due": (now + timedelta(days=due_days)).date().isoformat()},
           now - timedelta(hours=hours_ago), source_type="message", source_ref="WhatsApp (demo)", actor="Rajesh Sharma",
           confidence=0.95)

    # Opening cash so that the demo starts with ₹42,850 in hand.
    db.flush()
    cash_now = get_state(db).cash
    ev("OPENING_CASH", {"amount": round(42850 - cash_now, 2)}, start - timedelta(minutes=1), category="OPENING",
       source_ref="Cash count (demo)")
    db.flush()
    # THINK once over the seeded history so the demo opens with live risks & recommendations.
    after_state_change(db, None, ts=now - timedelta(hours=2))
    db.commit()


def _schema_outdated() -> bool:
    """Demo databases from an older version lack newer columns → rebuild (all data is DEMO DATA)."""
    from sqlalchemy import inspect
    insp = inspect(engine)
    if "input_artifacts" not in insp.get_table_names():
        return False
    cols = {c["name"] for c in insp.get_columns("input_artifacts")}
    return not {"page_count", "transcription"} <= cols


def ensure_seeded(db: Session) -> None:
    if _schema_outdated():
        reset_database(db)
    Base.metadata.create_all(bind=engine)
    if db.query(Merchant).count() == 0:
        seed(db)
