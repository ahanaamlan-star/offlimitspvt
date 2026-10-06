"""Read models: serialisers and computed views for the API."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines.decision import detect_risks, item_demand
from app.engines.state import as_utc, margin, margin_percentage, project
from app.models import (Approval, BusinessEvent, InputArtifact, Order, ProposedEvent, PurchaseOrder, Recommendation, Scenario)
from app.services.ledger import Masters, all_events, get_state
from app.services.workflow import current_risks, risk_config


def iso(ts: datetime | None) -> str | None:
    return as_utc(ts).isoformat() if ts else None


def event_dict(e: BusinessEvent, m: Masters | None = None) -> dict:
    return {
        "id": e.id, "seq": e.seq, "ts": iso(e.ts), "category": e.category, "type": e.type, "source_type": e.source_type,
        "source_ref": e.source_ref, "actor": e.actor, "entity": e.entity,
        "entity_name": (m.item_name(e.entity) if m and e.entity in m.items_by_sku else
                        (m.customer_name(e.entity) if m and e.entity in m.customers else
                         (m.supplier_name(e.entity) if m and e.entity in m.suppliers else e.entity))),
        "title": e.title, "change": e.change, "payload": e.payload, "confidence": e.confidence, "status": e.status,
        "reason": e.reason, "prev_state": e.prev_state, "new_state": e.new_state, "artifact_id": e.artifact_id,
        "approval_id": e.approval_id, "caused_by": e.caused_by, "is_demo": e.is_demo,
    }


def artifact_dict(a: InputArtifact) -> dict:
    return {"id": a.id, "kind": a.kind, "filename": a.filename, "mime": a.mime, "size": a.size, "sha256": a.sha256,
            "text_content": a.text_content, "sender": a.sender, "analysis_mode": a.analysis_mode, "note": a.note,
            "is_demo": a.is_demo, "created_at": iso(a.created_at), "has_file": bool(a.path),
            "page_count": a.page_count, "transcription": a.transcription,
            "file_url": f"/api/inputs/{a.id}/file" if a.path else None}


def proposal_dict(p: ProposedEvent, m: Masters) -> dict:
    pl = p.payload or {}
    names = {}
    if pl.get("sku"):
        names["sku"] = m.item_name(pl["sku"])
    if pl.get("supplier_id"):
        names["supplier"] = m.suppliers[pl["supplier_id"]].name if pl["supplier_id"] in m.suppliers else pl["supplier_id"]
    if pl.get("customer_id"):
        names["customer"] = m.customer_name(pl["customer_id"])
    if pl.get("items"):
        names["items"] = [m.item_name(i.get("sku")) for i in pl["items"]]
    return {"id": p.id, "artifact_id": p.artifact_id, "type": p.type, "payload": pl, "names": names, "summary": p.summary,
            "confidence": p.confidence, "status": p.status, "review_reason": p.review_reason, "candidates": p.candidates,
            "event_id": p.event_id, "created_at": iso(p.created_at)}


def rec_dict(r: Recommendation, m: Masters) -> dict:
    sup = m.suppliers.get(r.supplier_id)
    return {"id": r.id, "kind": r.kind, "risk_key": r.risk_key, "sku": r.sku, "item": m.item_name(r.sku),
            "supplier_id": r.supplier_id, "supplier": sup.short_name if sup else r.supplier_id,
            "supplier_name": sup.name if sup else r.supplier_id, "qty": r.qty, "unit_price": r.unit_price, "total": r.total,
            "reason": r.reason, "explanation": r.explanation, "comparison": r.comparison, "status": r.status,
            "trigger_event_id": r.trigger_event_id, "decision_event_id": r.decision_event_id, "po_id": r.po_id,
            "created_at": iso(r.created_at), "decided_at": iso(r.decided_at), "decided_by": r.decided_by}


def po_dict(po: PurchaseOrder, m: Masters) -> dict:
    sup = m.suppliers.get(po.supplier_id)
    return {"id": po.id, "supplier_id": po.supplier_id, "supplier": sup.short_name if sup else po.supplier_id,
            "supplier_name": sup.name if sup else po.supplier_id, "sku": po.sku, "item": m.item_name(po.sku),
            "qty": po.qty, "unit_price": po.unit_price, "total": po.total, "credit_days": po.credit_days,
            "delivery_days": po.delivery_days, "status": po.status, "recommendation_id": po.recommendation_id,
            "approval_id": po.approval_id, "approved_by": po.approved_by, "event_id": po.event_id,
            "received_event_id": po.received_event_id, "created_at": iso(po.created_at)}


def approval_dict(a: Approval) -> dict:
    return {"id": a.id, "recommendation_id": a.recommendation_id, "actor": a.actor, "decision": a.decision, "note": a.note,
            "snapshot": a.snapshot, "ts": iso(a.ts)}


def scenario_dict(s: Scenario) -> dict:
    return {"id": s.id, "name": s.name, "question": s.question, "inputs": s.inputs, "results": s.results,
            "created_at": iso(s.created_at)}


# ---------------------------------------------------------------------------
# Business state
# ---------------------------------------------------------------------------

def inventory_rows(db: Session, state=None, m: Masters | None = None, risks=None) -> list[dict]:
    m = m or Masters(db)
    state = state or get_state(db)
    cfg = risk_config(db)
    risks = risks if risks is not None else current_risks(db, state, m)
    risk_by_sku: dict[str, str] = {}
    for r in risks:
        if r.get("sku") and r["type"] in ("STOCKOUT", "LOW_STOCK"):
            risk_by_sku[r["sku"]] = r["severity"]
    rows = []
    for it in m.items:
        ln = state.inventory.get(it.sku)
        on_hand = ln.on_hand if ln else 0
        reserved = ln.reserved if ln else 0
        incoming = ln.incoming if ln else 0
        cost = ln.last_cost if ln else None
        daily = item_demand(state, it)
        rows.append({
            "sku": it.sku, "name": it.name, "category": it.category, "unit": it.unit, "on_hand": on_hand, "reserved": reserved,
            "available": on_hand - reserved, "incoming": incoming, "reorder_point": it.reorder_point,
            "forecast_daily": daily, "projected": round(on_hand - reserved + incoming - daily * cfg.horizon_days, 1),
            "risk": risk_by_sku.get(it.sku, "LOW"), "unit_cost": cost, "selling_price": it.selling_price,
            "margin": margin(it.selling_price, cost) if cost else None,
            "margin_pct": margin_percentage(it.selling_price, cost) if cost else None,
            "value": round(on_hand * (cost or 0), 2),
        })
    return rows


def business_state(db: Session) -> dict:
    m = Masters(db)
    events = all_events(db)
    state = project(events)
    risks = current_risks(db, state, m)
    inv = inventory_rows(db, state, m, risks)
    orders = list(db.scalars(select(Order).order_by(Order.created_at.desc())))
    risky_skus = {r["sku"] for r in risks if r["type"] == "STOCKOUT"}
    order_rows = [{"id": o.id, "customer_id": o.customer_id, "customer": m.customer_name(o.customer_id),
                   "items": [{**i, "name": m.item_name(i["sku"])} for i in o.items], "value": o.value, "due": o.due,
                   "status": o.status, "risk": "AT RISK" if o.status == "OPEN" and any(i["sku"] in risky_skus for i in o.items) else "OK",
                   "created_at": iso(o.created_at), "created_event_id": o.created_event_id} for o in orders]
    opening = sum(e.payload["amount"] for e in events if e.type == "OPENING_CASH" and e.status != "REVERSED")
    inflow = sum(c["delta"] for c in state.cash_flow if c["delta"] > 0 and c["reason"] != "Opening balance")
    outflow = -sum(c["delta"] for c in state.cash_flow if c["delta"] < 0)
    margins = []
    for it in m.items:
        ln = state.inventory.get(it.sku)
        if not ln or ln.last_cost is None:
            continue
        prev_pct = margin_percentage(it.selling_price, ln.prev_cost) if ln.prev_cost else None
        pct = margin_percentage(it.selling_price, ln.last_cost)
        anomaly = any(r["type"] == "MARGIN_ANOMALY" and r["sku"] == it.sku for r in risks)
        margins.append({"sku": it.sku, "name": it.name, "selling_price": it.selling_price, "cost": ln.last_cost,
                        "previous_cost": ln.prev_cost, "margin": margin(it.selling_price, ln.last_cost), "margin_pct": pct,
                        "previous_margin_pct": prev_pct, "anomaly": anomaly})
    prices = []
    for key, o in sorted(state.offers.items()):
        sup = m.suppliers.get(o["supplier_id"])
        prices.append({"supplier_id": o["supplier_id"], "supplier": sup.short_name if sup else o["supplier_id"],
                       "supplier_name": sup.name if sup else o["supplier_id"], "sku": o["sku"], "item": m.item_name(o["sku"]),
                       "unit_price": o["unit_price"], "moq": o.get("moq"), "delivery_days": o.get("delivery_days"),
                       "credit_days": o.get("credit_days"), "quoted_at": iso(o.get("quoted_at")), "source_event": o.get("source_event")})
    suppliers = [{"id": s.id, "short_name": s.short_name, "name": s.name, "reliability": round(s.reliability * 100),
                  "city": s.city, "offers": sum(1 for p in prices if p["supplier_id"] == s.id),
                  "payable": round(state.payables.get(s.id, 0), 2)} for s in m.suppliers.values()]
    inv_value = round(sum(r["value"] for r in inv if r["on_hand"] > 0), 2)
    total_rev = sum(r["selling_price"] * r["on_hand"] for r in inv if r["unit_cost"] and r["on_hand"] > 0)
    w_margin = round((total_rev - inv_value) / total_rev * 100, 1) if total_rev else 0
    summary = {
        "inventory_value": inv_value, "inventory_units": round(sum(r["on_hand"] for r in inv)), "skus": len(inv),
        "cash": round(state.cash, 2), "open_orders": sum(1 for o in order_rows if o["status"] == "OPEN"),
        "open_order_value": round(sum(o["value"] for o in order_rows if o["status"] == "OPEN"), 2),
        "stockout_risks": sum(1 for r in risks if r["type"] == "STOCKOUT"),
        "low_stock": sum(1 for r in risks if r["type"] == "LOW_STOCK"),
        "margin_alerts": sum(1 for r in risks if r["type"] in ("MARGIN_ANOMALY", "PRICE_CHANGE", "QUOTE_INVOICE_MISMATCH")),
        "pending_approvals": db.query(Recommendation).filter(Recommendation.status == "PENDING").count(),
        "needs_review": db.query(ProposedEvent).filter(ProposedEvent.status == "NEEDS_REVIEW").count(),
        "receivables": round(sum(v for v in state.receivables.values() if v > 0), 2),
        "payables": round(sum(v for v in state.payables.values() if v > 0), 2),
        "weighted_margin_pct": w_margin, "events": len(events),
        "last_event_at": iso(max((e.ts for e in events), default=None)),
    }
    return {
        "summary": summary, "inventory": inv, "orders": order_rows,
        "cash": {"opening": round(opening, 2), "inflow": round(inflow, 2), "outflow": round(outflow, 2), "current": round(state.cash, 2),
                 "receivables": [{"customer_id": k, "customer": m.customer_name(k), "amount": round(v, 2)}
                                 for k, v in state.receivables.items() if abs(v) > 0.001],
                 "payables": [{"supplier_id": k, "supplier": m.supplier_name(k), "amount": round(v, 2)}
                              for k, v in state.payables.items() if abs(v) > 0.001]},
        "prices": prices, "margins": margins, "suppliers": suppliers,
        "purchase_orders": [{"id": k, "status": v["status"], "sku": v["sku"], "qty": v["qty"]} for k, v in state.purchase_orders.items()],
    }


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------

def analytics(db: Session) -> dict:
    m = Masters(db)
    events = all_events(db)
    cfg = risk_config(db)
    now = datetime.now(timezone.utc)
    days = [(now - timedelta(days=d)).date() for d in range(7, -1, -1)]
    series = []
    focus = ["SKU-1042", "SKU-1020", "SKU-1010", "SKU-1021"]
    for d in days:
        end = datetime.combine(d, datetime.max.time(), tzinfo=timezone.utc)
        evs = [e for e in events if as_utc(e.ts) <= end]
        st = project(evs)
        risks = detect_risks(st, m.items, {k: v.short_name for k, v in m.suppliers.items()},
                             {k: v.name for k, v in m.customers.items()}, cfg)
        day_evs = [e for e in evs if as_utc(e.ts).date() == d and e.status != "REVERSED"]
        purchases = sum(e.payload["qty"] * e.payload["unit_cost"] for e in day_evs if e.type == "PURCHASE_RECEIVED")
        inflow = sum(e.payload["qty"] * e.payload["unit_price"] for e in day_evs if e.type == "SALE") + \
            sum(e.payload["amount"] for e in day_evs if e.type == "PAYMENT_RECEIVED")
        outflow = sum(e.payload["amount"] for e in day_evs if e.type == "PAYMENT_MADE") + \
            sum(e.payload["qty"] * e.payload["unit_cost"] for e in day_evs if e.type == "PURCHASE_RECEIVED" and not e.payload.get("credit_days"))
        row = {"date": d.isoformat(), "label": d.strftime("%a %d"),
               "inventory_units": round(sum(ln.on_hand for ln in st.inventory.values())),
               "inventory_value": round(sum(ln.on_hand * (ln.last_cost or 0) for ln in st.inventory.values())),
               "cash": round(st.cash), "inflow": round(inflow), "outflow": round(outflow), "purchase_cost": round(purchases),
               "stockout_risks": sum(1 for r in risks if r["type"] == "STOCKOUT"),
               "low_stock": sum(1 for r in risks if r["type"] == "LOW_STOCK")}
        for sku in focus:
            ln = st.inventory.get(sku)
            it = m.items_by_sku.get(sku)
            row[f"margin_{sku}"] = margin_percentage(it.selling_price, ln.last_cost) if ln and ln.last_cost and it else None
            row[f"stock_{sku}"] = ln.on_hand if ln else 0
        series.append(row)
    # Supplier price comparison for Coca-Cola (the demo SKU) and history
    st = project(events)
    price_points = defaultdict(list)
    for q in st.quotes:
        price_points[q["supplier_id"]].append({"ts": iso(q["ts"]), "price": q["unit_price"], "kind": "quote"})
    for c in st.price_changes:
        price_points[c["supplier_id"]].append({"ts": iso(c["ts"]), "price": c["new_price"], "kind": "update", "sku": c["sku"]})
    coke_offers = sorted([{"supplier": m.supplier_name(o["supplier_id"]), "price": o["unit_price"], "moq": o.get("moq"),
                           "delivery_days": o.get("delivery_days"), "credit_days": o.get("credit_days")}
                          for o in st.offers.values() if o["sku"] == "SKU-1042"], key=lambda x: x["price"])
    last, first = series[-1], series[0]
    insights = {
        "inventory": f'Stock on hand moved from {first["inventory_units"]:,} to {last["inventory_units"]:,} units over 8 days; '
                     f'{last["stockout_risks"]} SKU(s) are predicted to run short.',
        "stockout": "Stockout risk is computed from stock on hand, reserved orders, incoming POs and forecast demand — "
                    "act on spikes before committed orders fail.",
        "purchases": f'₹{sum(r["purchase_cost"] for r in series):,.0f} of stock was received in this period.',
        "margin": "Margins fall when supplier costs rise and selling prices do not — compare suppliers or re-price affected SKUs.",
        "supplier_prices": ("For Coca-Cola, the cheapest quote is " + f'{coke_offers[0]["supplier"]} at ₹{coke_offers[0]["price"]:g}, '
                            "but MOQ, delivery and credit decide the best buy.") if coke_offers else "",
        "cash": f'Cash moved from ₹{first["cash"]:,.0f} to ₹{last["cash"]:,.0f}; credit purchases defer outflows to payables.',
    }
    return {"series": series, "focus": [{"sku": s, "name": m.item_name(s)} for s in focus], "coke_offers": coke_offers,
            "insights": insights, "is_demo": True}


def trace(db: Session, ev: BusinessEvent) -> dict:
    """Walk caused_by links both ways to show WHY something changed and WHAT it caused."""
    m = Masters(db)
    events = {e.id: e for e in all_events(db)}
    up = []
    cur = ev
    seen = set()
    while cur and cur.caused_by and cur.caused_by not in seen:
        seen.add(cur.caused_by)
        cur = events.get(cur.caused_by)
        if cur:
            up.append(event_dict(cur, m))
    down = [event_dict(e, m) for e in events.values() if e.caused_by == ev.id]
    return {"upstream": list(reversed(up)), "downstream": down}
