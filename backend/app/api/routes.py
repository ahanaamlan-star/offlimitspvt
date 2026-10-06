"""HTTP API. Thin layer: validation errors become 4xx, everything else lives in services/engines."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.engines.action import compare_suppliers
from app.models import (Approval, BusinessEvent, Customer, InputArtifact, Merchant, ProposedEvent, PurchaseOrder,
                        Recommendation, Scenario)
from app.services import files, views
from app.services import workflow as wf
from app.services.ledger import LedgerError, Masters, append_event, get_state
from app.services.seed import reset_database, seed

router = APIRouter(prefix="/api")
VERSION = "1.0.0"


def bad(exc: Exception, code: int = 400):
    detail = exc.errors if isinstance(exc, LedgerError) else [str(exc)]
    raise HTTPException(status_code=code, detail=detail)


# ---------------------------------------------------------------- health & settings

@router.get("/health")
def health(db: Session = Depends(get_db)):
    try:
        db.execute(select(1))
        db_ok = True
    except Exception:  # pragma: no cover
        db_ok = False
    return {
        "status": "online" if db_ok else "degraded", "version": VERSION,
        "mode": "LIVE" if settings.ai_live else "DEMO",
        "ai": {"provider": "Google Gemini", "configured": bool(settings.gemini_api_key), "live": settings.ai_live,
               "model": settings.gemini_model},
        "voice": {"provider": "Browser speech recognition / Gemini audio", "sarvam_configured": bool(settings.sarvam_api_key)},
        "database": {"ok": db_ok, "engine": settings.database_url.split(":")[0]},
        "confidence_threshold": settings.confidence_threshold, "max_upload_mb": settings.max_upload_mb,
    }


class SettingsIn(BaseModel):
    name: str | None = None
    owner: str | None = None
    settings: dict[str, Any] | None = None


@router.get("/settings")
def get_settings(db: Session = Depends(get_db)):
    m = db.scalar(select(Merchant))
    return {"merchant": {"id": m.id, "name": m.name, "owner": m.owner, "city": m.city, "currency": m.currency, "is_demo": m.is_demo},
            "settings": m.settings, "health": health(db)}


@router.put("/settings")
def put_settings(body: SettingsIn, db: Session = Depends(get_db)):
    m = db.scalar(select(Merchant))
    if body.name:
        m.name = files.sanitize_text(body.name, 120)
    if body.owner:
        m.owner = files.sanitize_text(body.owner, 120)
    if body.settings:
        merged = dict(m.settings or {})
        for k, v in body.settings.items():
            if isinstance(v, (int, float)) and v < 0:
                bad(ValueError(f"{k} cannot be negative"))
            merged[k] = v
        m.settings = merged
    db.commit()
    return get_settings(db)


# ---------------------------------------------------------------- demo

@router.post("/demo/reset")
def demo_reset(db: Session = Depends(get_db)):
    reset_database(db)
    from app.db.session import SessionLocal
    fresh = SessionLocal()
    try:
        seed(fresh)
    finally:
        fresh.close()
    return {"ok": True, "message": "Demo business reset to its starting state."}


@router.get("/demo/assets")
def demo_assets():
    out = []
    fx = files.demo_fixtures()
    by_name = {v["filename"]: v for v in fx.values()}
    for folder in ("images", "documents", "audio"):
        d = settings.demo_dir / folder
        if not d.exists():
            continue
        for p in sorted(d.iterdir()):
            if p.name.startswith(".") or p.suffix.lower() in (".md", ".txt"):
                continue
            meta = by_name.get(p.name, {})
            out.append({"name": p.name, "folder": folder, "size": p.stat().st_size, "url": f"/api/demo/assets/{folder}/{p.name}",
                        "kind": meta.get("kind"), "label": meta.get("label", p.stem), "transcript": meta.get("transcript")})
    return {"assets": out, "messages": [
        {"label": "Customer order (Hinglish)", "kind": "message", "sender": "Ramesh Stores", "text": "Kal 25 Coke aur 10 Sprite bhej dena"},
        {"label": "Ambiguous payment", "kind": "message", "sender": "", "text": "Ramesh paid ₹3,000"},
        {"label": "Supplier quote", "kind": "quotation", "sender": "Supplier B",
         "text": "Supplier B says the price for 20 units of Coke is ₹39 each, can deliver today, 15 days credit."},
        {"label": "Voice: payment (Hindi)", "kind": "voice", "sender": "", "text": "Ramesh Stores ne 3000 rupaye de diye"},
        {"label": "Counter sale", "kind": "text", "sender": "", "text": "Aaj 5 Maggi becha"},
        {"label": "Damaged stock", "kind": "text", "sender": "", "text": "2 Sprite bottles damaged in delivery"},
    ]}


@router.get("/demo/assets/{folder}/{name}")
def demo_asset_file(folder: str, name: str):
    if folder not in ("images", "documents", "audio"):
        raise HTTPException(404)
    p = (settings.demo_dir / folder / Path(name).name)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


# ---------------------------------------------------------------- SEE: inputs & proposals

@router.post("/inputs/analyze")
async def analyze(kind: str = Form("text"), text: str | None = Form(None), sender: str | None = Form(None),
                  file: UploadFile | None = File(None), db: Session = Depends(get_db)):
    data = await file.read() if file else None
    try:
        res = wf.analyze_input(db, kind, data, file.filename if file else None, text, sender)
    except files.UploadError as exc:
        db.rollback()
        bad(exc, 415)
    except LedgerError as exc:
        db.rollback()
        bad(exc)
    m = Masters(db)
    return {"artifact": views.artifact_dict(res["artifact"]), "proposals": [views.proposal_dict(p, m) for p in res["proposals"]],
            "understanding": res["understanding"], "source_event": views.event_dict(res["source_event"], m)}


@router.get("/inputs")
def list_inputs(limit: int = 30, db: Session = Depends(get_db)):
    arts = db.scalars(select(InputArtifact).order_by(InputArtifact.created_at.desc()).limit(limit))
    return [views.artifact_dict(a) for a in arts]


@router.get("/inputs/{art_id}")
def get_input(art_id: str, db: Session = Depends(get_db)):
    a = db.get(InputArtifact, art_id)
    if not a:
        raise HTTPException(404, "Unknown input")
    m = Masters(db)
    props = db.scalars(select(ProposedEvent).where(ProposedEvent.artifact_id == art_id))
    return {"artifact": views.artifact_dict(a), "proposals": [views.proposal_dict(p, m) for p in props]}


@router.get("/inputs/{art_id}/file")
def input_file(art_id: str, db: Session = Depends(get_db)):
    a = db.get(InputArtifact, art_id)
    if not a or not a.path or not Path(a.path).exists():
        raise HTTPException(404)
    return FileResponse(a.path, media_type=a.mime, filename=a.filename)


@router.get("/proposals")
def list_proposals(status: str | None = None, db: Session = Depends(get_db)):
    q = select(ProposedEvent).order_by(ProposedEvent.created_at.desc())
    if status:
        q = q.where(ProposedEvent.status == status)
    m = Masters(db)
    return [views.proposal_dict(p, m) for p in db.scalars(q.limit(100))]


class ConfirmIn(BaseModel):
    overrides: dict[str, Any] | None = None
    actor: str | None = None


@router.post("/proposals/{prp_id}/confirm")
def confirm(prp_id: str, body: ConfirmIn, db: Session = Depends(get_db)):
    try:
        res = wf.confirm_proposal(db, prp_id, body.overrides, body.actor)
    except LedgerError as exc:
        db.rollback()
        bad(exc, 409 if "Duplicate" in str(exc) else 400)
    m = Masters(db)
    return {"event": views.event_dict(res["event"], m), "proposal": views.proposal_dict(res["proposal"], m),
            "intelligence": [views.event_dict(e, m) for e in res["intelligence"]],
            "recommendations": [views.rec_dict(r, m) for r in res["recommendations"]]}


class ReasonIn(BaseModel):
    reason: str | None = None
    actor: str | None = None


@router.post("/proposals/{prp_id}/reject")
def reject_prp(prp_id: str, body: ReasonIn, db: Session = Depends(get_db)):
    try:
        p = wf.reject_proposal(db, prp_id, body.reason)
    except LedgerError as exc:
        bad(exc)
    return views.proposal_dict(p, Masters(db))


@router.post("/proposals/{prp_id}/review-later")
def review_later(prp_id: str, db: Session = Depends(get_db)):
    try:
        p = wf.mark_review_later(db, prp_id)
    except LedgerError as exc:
        bad(exc)
    return views.proposal_dict(p, Masters(db))


# ---------------------------------------------------------------- Ledger

@router.get("/events")
def list_events(category: str | None = None, type: str | None = None, q: str | None = None, entity: str | None = None,
                source: str | None = None, from_: str | None = Query(None, alias="from"), to: str | None = None,
                include_opening: bool = False, include_pos: bool = True, limit: int = Query(200, le=1000),
                db: Session = Depends(get_db)):
    stmt = select(BusinessEvent).order_by(BusinessEvent.ts.desc(), BusinessEvent.seq.desc())
    if category:
        stmt = stmt.where(BusinessEvent.category.in_(category.split(",")))
    elif not include_opening:
        stmt = stmt.where(BusinessEvent.category != "OPENING")
    if not include_pos:
        stmt = stmt.where(BusinessEvent.source_type != "pos")
    if type:
        stmt = stmt.where(BusinessEvent.type.in_(type.split(",")))
    if entity:
        stmt = stmt.where(BusinessEvent.entity == entity)
    if source:
        stmt = stmt.where(BusinessEvent.source_type.in_(source.split(",")))
    try:
        if from_:
            stmt = stmt.where(BusinessEvent.ts >= datetime.fromisoformat(from_).replace(tzinfo=timezone.utc))
        if to:
            stmt = stmt.where(BusinessEvent.ts < datetime.fromisoformat(to).replace(tzinfo=timezone.utc) + timedelta(days=1))
    except ValueError:
        bad(ValueError("Dates must be YYYY-MM-DD"), 422)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(BusinessEvent.title.ilike(like), BusinessEvent.id.ilike(like), BusinessEvent.change.ilike(like),
                              BusinessEvent.source_ref.ilike(like), BusinessEvent.entity.ilike(like)))
    m = Masters(db)
    return [views.event_dict(e, m) for e in db.scalars(stmt.limit(limit))]


@router.get("/events/{event_id}")
def get_event(event_id: str, db: Session = Depends(get_db)):
    e = db.scalar(select(BusinessEvent).where(BusinessEvent.id == event_id))
    if not e:
        raise HTTPException(404, "Unknown event")
    m = Masters(db)
    out = views.event_dict(e, m)
    out["artifact"] = views.artifact_dict(db.get(InputArtifact, e.artifact_id)) if e.artifact_id and db.get(InputArtifact, e.artifact_id) else None
    out["approval"] = views.approval_dict(db.get(Approval, e.approval_id)) if e.approval_id and db.get(Approval, e.approval_id) else None
    po_id = (e.payload or {}).get("po_id")
    out["purchase_order"] = views.po_dict(db.get(PurchaseOrder, po_id), m) if po_id and db.get(PurchaseOrder, po_id) else None
    rec_id = (e.payload or {}).get("recommendation_id")
    out["recommendation"] = views.rec_dict(db.get(Recommendation, rec_id), m) if rec_id and db.get(Recommendation, rec_id) else None
    out["trace"] = views.trace(db, e)
    return out


class EventIn(BaseModel):
    type: str
    payload: dict[str, Any]
    actor: str | None = None
    reason: str | None = None


MANUAL_TYPES = {"PURCHASE_RECEIVED", "SUPPLIER_QUOTE", "SUPPLIER_PRICE_UPDATE", "CUSTOMER_ORDER", "ORDER_FULFILLED", "SALE",
                "PAYMENT_RECEIVED", "PAYMENT_MADE", "DAMAGED_STOCK"}


@router.post("/events", status_code=201)
def create_event(body: EventIn, db: Session = Depends(get_db)):
    if body.type not in MANUAL_TYPES:
        bad(ValueError(f"Event type must be one of {sorted(MANUAL_TYPES)}"))
    payload = dict(body.payload)
    if body.type == "CUSTOMER_ORDER" and not payload.get("order_id"):
        from app.services.ledger import next_id
        payload["order_id"] = next_id(db, "order", "ORD-", 600)
    try:
        ev = append_event(db, body.type, payload, category="EVENT", source_type="user", source_ref="Manual entry",
                          actor=body.actor or wf.owner_name(db), reason=body.reason or "Manual entry", confidence=1.0)
        effects = wf.after_state_change(db, ev.id)
        db.commit()
    except LedgerError as exc:
        db.rollback()
        bad(exc)
    m = Masters(db)
    return {"event": views.event_dict(ev, m), "intelligence": [views.event_dict(e, m) for e in effects["intelligence"]]}


@router.post("/events/{event_id}/reverse")
def reverse(event_id: str, body: ReasonIn, db: Session = Depends(get_db)):
    try:
        res = wf.reverse_event(db, event_id, body.actor, body.reason)
    except LedgerError as exc:
        db.rollback()
        bad(exc)
    return {"event": views.event_dict(res["event"], Masters(db))}


# ---------------------------------------------------------------- Business state

@router.get("/business-state")
def business_state(db: Session = Depends(get_db)):
    return views.business_state(db)


@router.get("/inventory")
def inventory(db: Session = Depends(get_db)):
    return views.inventory_rows(db)


@router.get("/orders")
def orders(db: Session = Depends(get_db)):
    return views.business_state(db)["orders"]


@router.post("/orders/{order_id}/fulfill")
def fulfill(order_id: str, body: ReasonIn, db: Session = Depends(get_db)):
    try:
        res = wf.fulfil_order(db, order_id, body.actor)
    except LedgerError as exc:
        db.rollback()
        bad(exc)
    return {"event": views.event_dict(res["event"], Masters(db))}


@router.get("/suppliers")
def suppliers(db: Session = Depends(get_db)):
    bs = views.business_state(db)
    return [{**s, "prices": [p for p in bs["prices"] if p["supplier_id"] == s["id"]]} for s in bs["suppliers"]]


@router.get("/customers")
def customers(db: Session = Depends(get_db)):
    state = get_state(db)
    return [{"id": c.id, "name": c.name, "kind": c.kind, "aliases": c.aliases, "receivable": round(state.receivables.get(c.id, 0), 2)}
            for c in db.scalars(select(Customer).order_by(Customer.id))]


# ---------------------------------------------------------------- THINK

@router.get("/risks")
def risks(db: Session = Depends(get_db)):
    return wf.current_risks(db)


@router.get("/suppliers/compare/{sku}")
def compare(sku: str, qty: int | None = None, db: Session = Depends(get_db)):
    m = Masters(db)
    if sku not in m.items_by_sku:
        raise HTTPException(404, "Unknown SKU")
    state = get_state(db)
    cfg = wf.risk_config(db)
    risk = next((r for r in wf.current_risks(db, state, m) if r.get("sku") == sku and r.get("need_qty")), None)
    need = qty or (risk["need_qty"] if risk else 1)
    target = max(need, risk["target_max"] if risk else need)
    return {**compare_suppliers(state, sku, need, target, cfg.horizon_days, m.suppliers), "risk": risk, "item": m.item_name(sku)}


class SimIn(BaseModel):
    sku: str
    scenarios: list[dict[str, Any]] = Field(min_length=1, max_length=6)
    name: str | None = None
    question: str | None = None


@router.post("/simulations/preview")
def preview_simulation(body: SimIn, db: Session = Depends(get_db)):
    """Same deterministic maths as /simulations, without saving — powers live recalculation in the UI."""
    try:
        return wf.run_simulation(db, body.sku, body.scenarios, None, None, save=False)
    except LedgerError as exc:
        bad(exc)


@router.post("/simulations", status_code=201)
def create_simulation(body: SimIn, db: Session = Depends(get_db)):
    try:
        sim = wf.run_simulation(db, body.sku, body.scenarios, files.sanitize_text(body.name, 160),
                                files.sanitize_text(body.question, 500))
    except LedgerError as exc:
        db.rollback()
        bad(exc)
    return views.scenario_dict(sim)


@router.get("/simulations")
def list_simulations(db: Session = Depends(get_db)):
    return [views.scenario_dict(s) for s in db.scalars(select(Scenario).order_by(Scenario.created_at.desc()).limit(20))]


@router.get("/simulations/{sim_id}")
def get_simulation(sim_id: str, db: Session = Depends(get_db)):
    s = db.get(Scenario, sim_id)
    if not s:
        raise HTTPException(404, "Unknown simulation")
    return views.scenario_dict(s)


# ---------------------------------------------------------------- ACT

@router.get("/recommendations")
def recommendations(status: str | None = None, db: Session = Depends(get_db)):
    q = select(Recommendation).order_by(Recommendation.created_at.desc())
    if status:
        q = q.where(Recommendation.status.in_(status.split(",")))
    m = Masters(db)
    return [views.rec_dict(r, m) for r in db.scalars(q)]


@router.get("/recommendations/{rec_id}")
def recommendation(rec_id: str, db: Session = Depends(get_db)):
    r = db.get(Recommendation, rec_id)
    if not r:
        raise HTTPException(404, "Unknown recommendation")
    return views.rec_dict(r, Masters(db))


class ApproveIn(BaseModel):
    actor: str | None = None
    supplier_id: str | None = None
    qty: int | None = None
    note: str | None = None
    acknowledged: bool = False


@router.post("/recommendations/{rec_id}/approve")
def approve(rec_id: str, body: ApproveIn, db: Session = Depends(get_db)):
    try:
        res = wf.approve_recommendation(db, rec_id, body.actor, body.supplier_id, body.qty, files.sanitize_text(body.note), body.acknowledged)
    except LedgerError as exc:
        db.rollback()
        bad(exc)
    m = Masters(db)
    return {"purchase_order": views.po_dict(res["purchase_order"], m), "approval": views.approval_dict(res["approval"]),
            "events": [views.event_dict(e, m) for e in res["events"]], "before": res["before"], "after": res["after"]}


@router.post("/recommendations/{rec_id}/reject")
def reject_rec(rec_id: str, body: ReasonIn, db: Session = Depends(get_db)):
    try:
        r = wf.reject_recommendation(db, rec_id, body.actor, files.sanitize_text(body.reason))
    except LedgerError as exc:
        db.rollback()
        bad(exc)
    return views.rec_dict(r, Masters(db))


@router.get("/purchase-orders")
def purchase_orders(db: Session = Depends(get_db)):
    m = Masters(db)
    return [views.po_dict(p, m) for p in db.scalars(select(PurchaseOrder).order_by(PurchaseOrder.created_at.desc()))]


@router.get("/purchase-orders/{po_id}")
def purchase_order(po_id: str, db: Session = Depends(get_db)):
    po = db.get(PurchaseOrder, po_id)
    if not po:
        raise HTTPException(404, "Unknown purchase order")
    m = Masters(db)
    out = views.po_dict(po, m)
    merchant = db.scalar(select(Merchant))
    out["merchant"] = {"name": merchant.name, "owner": merchant.owner, "city": merchant.city}
    out["supplier_detail"] = {"name": m.suppliers[po.supplier_id].name, "city": m.suppliers[po.supplier_id].city}
    out["approval"] = views.approval_dict(db.get(Approval, po.approval_id)) if po.approval_id and db.get(Approval, po.approval_id) else None
    ev = db.scalar(select(BusinessEvent).where(BusinessEvent.id == po.event_id)) if po.event_id else None
    out["trace"] = views.trace(db, ev) if ev else {"upstream": [], "downstream": []}
    out["event"] = views.event_dict(ev, m) if ev else None
    return out


class POIn(BaseModel):
    sku: str
    supplier_id: str
    qty: int
    actor: str | None = None
    note: str | None = None
    acknowledged: bool = False


@router.post("/purchase-orders", status_code=201)
def create_po(body: POIn, db: Session = Depends(get_db)):
    try:
        res = wf.create_purchase_order(db, body.sku, body.supplier_id, body.qty, body.actor, body.acknowledged, body.note)
    except LedgerError as exc:
        db.rollback()
        bad(exc)
    return {"purchase_order": views.po_dict(res["purchase_order"], Masters(db))}


class ReceiveIn(BaseModel):
    qty: int | None = None
    actor: str | None = None


@router.post("/purchase-orders/{po_id}/receive")
def receive(po_id: str, body: ReceiveIn, db: Session = Depends(get_db)):
    try:
        res = wf.receive_purchase_order(db, po_id, body.qty, body.actor)
    except LedgerError as exc:
        db.rollback()
        bad(exc)
    m = Masters(db)
    return {"event": views.event_dict(res["event"], m), "purchase_order": views.po_dict(res["purchase_order"], m)}


# ---------------------------------------------------------------- Analytics

@router.get("/analytics")
def analytics(db: Session = Depends(get_db)):
    return views.analytics(db)


@router.get("/overview")
def overview(db: Session = Depends(get_db)):
    """One call for the command center."""
    bs = views.business_state(db)
    m = Masters(db)
    feed = db.scalars(select(BusinessEvent).where(BusinessEvent.category != "OPENING", BusinessEvent.source_type != "pos")
                      .order_by(BusinessEvent.ts.desc(), BusinessEvent.seq.desc()).limit(12))
    pending = db.scalars(select(Recommendation).where(Recommendation.status == "PENDING").order_by(Recommendation.created_at.desc()))
    return {"summary": bs["summary"], "inventory": bs["inventory"], "cash": bs["cash"], "orders": bs["orders"][:6],
            "risks": wf.current_risks(db), "feed": [views.event_dict(e, m) for e in feed],
            "pending": [views.rec_dict(r, m) for r in pending], "health": health(db)}
