"""Event ledger: the only write path for business state."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines.state import STATE_EVENT_TYPES, as_utc, BusinessState, apply, project, snapshot, validate_event
from app.models import BusinessEvent, Counter, Customer, InventoryItem, Order, PurchaseOrder, Supplier


class LedgerError(Exception):
    def __init__(self, errors: list[str] | str):
        self.errors = [errors] if isinstance(errors, str) else errors
        super().__init__("; ".join(self.errors))


def next_id(db: Session, name: str, prefix: str, start: int, width: int = 0) -> str:
    c = db.get(Counter, name)
    if c is None:
        c = Counter(name=name, value=start)
        db.add(c)
    c.value += 1
    db.flush()
    return f"{prefix}{str(c.value).zfill(width) if width else c.value}"


def all_events(db: Session) -> list[BusinessEvent]:
    return list(db.scalars(select(BusinessEvent).order_by(BusinessEvent.ts, BusinessEvent.seq)))


def get_state(db: Session) -> BusinessState:
    return project(all_events(db))


class Masters:
    def __init__(self, db: Session):
        self.items = list(db.scalars(select(InventoryItem).order_by(InventoryItem.sku)))
        self.items_by_sku = {i.sku: i for i in self.items}
        self.suppliers = {s.id: s for s in db.scalars(select(Supplier).order_by(Supplier.id))}
        self.customers = {c.id: c for c in db.scalars(select(Customer).order_by(Customer.id))}

    def item_name(self, sku: str | None) -> str:
        return self.items_by_sku[sku].name if sku in self.items_by_sku else (sku or "")

    def supplier_name(self, sid: str | None) -> str:
        return self.suppliers[sid].short_name if sid in self.suppliers else (sid or "")

    def customer_name(self, cid: str | None) -> str:
        return self.customers[cid].name if cid in self.customers else (cid or "")


def describe(etype: str, p: dict, m: Masters, state: BusinessState | None = None) -> tuple[str, str, str | None]:
    """Human title, compact change string and primary entity for an event."""
    if etype == "PURCHASE_RECEIVED":
        return (f'{p["qty"]:g} {m.item_name(p["sku"])} received @ ₹{p["unit_cost"]:g}',
                f'+{p["qty"]:g} {p["sku"]}', p["sku"])
    if etype == "SUPPLIER_QUOTE":
        return (f'{m.supplier_name(p["supplier_id"])} quote: {m.item_name(p["sku"])} @ ₹{p["unit_price"]:g}',
                f'quote ₹{p["unit_price"]:g}', p["sku"])
    if etype == "SUPPLIER_PRICE_UPDATE":
        pct = p.get("change_pct")
        return (f'{m.item_name(p["sku"])} price ₹{p.get("old_price")} → ₹{p["new_price"]:g}' + (f" ({pct:+.1f}%)" if pct is not None else ""),
                f'{pct:+.1f}%' if pct is not None else f'₹{p["new_price"]:g}', p["sku"])
    if etype == "CUSTOMER_ORDER":
        items = " + ".join(f'{i["qty"]:g} {m.item_name(i["sku"])}' for i in p["items"])
        return (f'{items} reserved', ", ".join(f'+{i["qty"]:g} reserved {i["sku"]}' for i in p["items"]), p["customer_id"])
    if etype == "ORDER_FULFILLED":
        return (f'Order {p["order_id"]} fulfilled', "stock out, receivable up", p["order_id"])
    if etype == "SALE":
        return (f'{p["qty"]:g} {m.item_name(p["sku"])} sold @ ₹{p["unit_price"]:g}', f'-{p["qty"]:g} {p["sku"]}', p["sku"])
    if etype == "PAYMENT_RECEIVED":
        return (f'₹{p["amount"]:,.0f} received from {m.customer_name(p["customer_id"])}', f'+₹{p["amount"]:,.0f} cash', p["customer_id"])
    if etype == "PAYMENT_MADE":
        return (f'₹{p["amount"]:,.0f} paid to {m.supplier_name(p["supplier_id"])}', f'-₹{p["amount"]:,.0f} cash', p["supplier_id"])
    if etype == "DAMAGED_STOCK":
        return (f'{p["qty"]:g} {m.item_name(p["sku"])} written off (damaged)', f'-{p["qty"]:g} {p["sku"]}', p["sku"])
    if etype == "PURCHASE_ORDER_CREATED":
        return (f'Purchase Order {p["po_id"]} generated',
                f'+{p["qty"]:g} incoming {p["sku"]}', p["sku"])
    if etype == "OPENING_STOCK":
        return (f'Opening stock: {p["qty"]:g} {m.item_name(p["sku"])}', f'+{p["qty"]:g} {p["sku"]}', p["sku"])
    if etype == "OPENING_CASH":
        return ("Opening cash balance", f'₹{p["amount"]:,.0f}', "cash")
    if etype == "OPENING_RECEIVABLE":
        return (f'Opening receivable: {m.customer_name(p["customer_id"])}', f'₹{p["amount"]:,.0f}', p["customer_id"])
    if etype == "OPENING_PAYABLE":
        return (f'Opening payable: {m.supplier_name(p["supplier_id"])}', f'₹{p["amount"]:,.0f}', p["supplier_id"])
    if etype == "EVENT_REVERSED":
        return (f'Event {p["reverses"]} reversed', "correction", p["reverses"])
    return (etype.replace("_", " ").title(), "", None)


def append_event(db: Session, etype: str, payload: dict, *, category: str = "EVENT", source_type: str = "system",
                 source_ref: str | None = None, actor: str = "system", title: str | None = None, change: str | None = None,
                 entity: str | None = None, confidence: float | None = None, reason: str | None = None,
                 artifact_id: str | None = None, approval_id: str | None = None, caused_by: str | None = None,
                 dedupe_key: str | None = None, ts: datetime | None = None, is_demo: bool = True,
                 state: BusinessState | None = None, masters: Masters | None = None) -> BusinessEvent:
    """Validate and append one event. State-changing events store before/after snapshots."""
    if dedupe_key and db.scalar(select(BusinessEvent.id).where(BusinessEvent.dedupe_key == dedupe_key)):
        raise LedgerError(f"Duplicate event: this input was already recorded ({dedupe_key}).")
    m = masters or Masters(db)
    st = state if state is not None else get_state(db)
    if etype == "CUSTOMER_ORDER":
        payload = {**payload, "items": [
            {**i, "unit_price": i.get("unit_price") or (m.items_by_sku[i["sku"]].selling_price if i.get("sku") in m.items_by_sku else None)}
            for i in payload.get("items", [])]}
    prev, new = {}, {}
    if etype in STATE_EVENT_TYPES:
        errors = validate_event(st, etype, payload, set(m.items_by_sku), set(m.suppliers), set(m.customers))
        if errors:
            raise LedgerError(errors)
        auto_title, auto_change, auto_entity = describe(etype, payload, m, st)
        prev = snapshot(st, etype, payload)
        apply(st, etype, payload, as_utc(ts) if ts else datetime.now(timezone.utc))
        new = snapshot(st, etype, payload)
    else:
        auto_title, auto_change, auto_entity = describe(etype, payload, m)
    ev = BusinessEvent(
        id=next_id(db, "event", "EVT-", 1000), ts=ts or datetime.now(timezone.utc), category=category, type=etype,
        source_type=source_type, source_ref=source_ref, actor=actor, entity=entity or auto_entity,
        title=title or auto_title, change=change if change is not None else auto_change, payload=payload,
        confidence=confidence, reason=reason, prev_state=prev, new_state=new, artifact_id=artifact_id,
        approval_id=approval_id, caused_by=caused_by, dedupe_key=dedupe_key, is_demo=is_demo,
    )
    db.add(ev)
    db.flush()
    _apply_records(db, ev)
    return ev


def _apply_records(db: Session, ev: BusinessEvent) -> None:
    """Keep workflow record tables in step with the ledger."""
    p = ev.payload
    if ev.type == "CUSTOMER_ORDER":
        items = p["items"]
        if not db.get(Order, p["order_id"]):
            db.add(Order(id=p["order_id"], customer_id=p["customer_id"], items=items,
                         value=round(sum(i["qty"] * i["unit_price"] for i in items), 2), due=p.get("due") or "",
                         status="OPEN", created_event_id=ev.id, created_at=ev.ts))
    elif ev.type == "ORDER_FULFILLED":
        o = db.get(Order, p["order_id"])
        if o:
            o.status = "FULFILLED"
            o.fulfilled_event_id = ev.id
    elif ev.type == "PURCHASE_RECEIVED" and p.get("po_id"):
        po = db.get(PurchaseOrder, p["po_id"])
        if po:
            po.status = "RECEIVED"
            po.received_event_id = ev.id
    elif ev.type == "EVENT_REVERSED":
        target = db.scalar(select(BusinessEvent).where(BusinessEvent.id == p["reverses"]))
        if target:
            target.status = "REVERSED"
