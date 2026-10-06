"""SEE → THINK → ACT orchestration on top of the ledger."""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.engines.action import compare_suppliers, compare_scenarios, simulate
from app.engines.decision import RiskConfig, detect_risks, item_demand
from app.engines.state import BusinessState, STATE_EVENT_TYPES, project, validate_event
from app.models import (Approval, BusinessEvent, InputArtifact, Merchant, ProposedEvent, PurchaseOrder, Recommendation,
                        Scenario)
from app.services import files
from app.services.ai import Catalog, GeminiService, ParsedEvent, Understanding
from app.services.ledger import LedgerError, Masters, all_events, append_event, get_state, next_id

INTEL_TYPES = {"STOCKOUT", "LOW_STOCK", "PRICE_CHANGE", "MARGIN_ANOMALY", "QUOTE_INVOICE_MISMATCH", "INVENTORY_MISMATCH",
               "WORKING_CAPITAL"}
KIND_LABEL = {"invoice": "Supplier invoice received", "receipt": "Receipt received", "quotation": "Supplier quotation received",
              "message": "Customer message received", "voice": "Voice note received", "image": "Image received",
              "text": "Quick entry received"}


def merchant(db: Session) -> Merchant:
    return db.scalar(select(Merchant))


def risk_config(db: Session) -> RiskConfig:
    m = merchant(db)
    s = (m.settings or {}) if m else {}
    cfg = RiskConfig()
    for k in ("horizon_days", "cover_days", "min_margin_pct", "margin_drop_pp", "price_change_pct", "mismatch_pct",
              "min_cash_buffer", "receivable_alert"):
        if k in s:
            setattr(cfg, k, float(s[k]))
    return cfg


def owner_name(db: Session) -> str:
    m = merchant(db)
    return m.owner if m else "Merchant"


def ai_service(db: Session, masters: Masters | None = None) -> GeminiService:
    m = masters or Masters(db)
    return GeminiService(Catalog(
        items=[{"sku": i.sku, "name": i.name, "aliases": i.aliases or [], "selling_price": i.selling_price} for i in m.items],
        suppliers=[{"id": s.id, "short_name": s.short_name, "name": s.name, "aliases": s.aliases or []} for s in m.suppliers.values()],
        customers=[{"id": c.id, "name": c.name, "aliases": c.aliases or []} for c in m.customers.values()],
    ))


# ---------------------------------------------------------------------------
# SEE
# ---------------------------------------------------------------------------

DEMO_TRANSCRIPTION = "DEMO TRANSCRIPTION"


def analyze_input(db: Session, kind: str, data: bytes | None, filename: str | None, text: str | None,
                  sender: str | None) -> dict:
    kind = kind if kind in KIND_LABEL else "text"
    text = files.sanitize_text(text)
    sender = files.sanitize_text(sender, 120)
    if not data and not text:
        raise LedgerError("Provide a file or some text to analyze.")
    m = Masters(db)
    svc = ai_service(db, m)
    art_id = next_id(db, "artifact", "ART-", 2000)
    art = InputArtifact(id=art_id, kind=kind, sender=sender, text_content=text, analysis_mode="gemini" if svc.live else "demo")
    fixture = None
    if data:
        mime = files.validate_upload(data, filename)
        art.mime, art.size, art.filename = mime, len(data), files.safe_filename(filename)
        art.sha256 = files.sha256(data)
        art.path = str(files.store(data, art_id, mime))
        fixture = files.fixture_for(art.sha256)
        art.is_demo = bool(fixture)
    else:
        art.sha256 = hashlib.sha256(f"{kind}|{sender or ''}|{text}".encode()).hexdigest()
    db.add(art)
    db.flush()

    notice = None
    if data and art.mime == "application/pdf":
        pdf_text, notice, art.page_count = files.pdf_text(data)
        art.text_content = pdf_text or text
        u = svc.extract_invoice(data, art.mime, art.text_content, kind if kind in ("invoice", "receipt", "quotation") else "invoice")
    elif data and art.mime.startswith("image/"):
        ocr = (fixture or {}).get("ocr_text") or text
        if fixture and not svc.live:
            art.note = "Demo asset: text read from the bundled OCR fixture."
        u = svc.extract_image(data, art.mime, None if svc.live else ocr, kind)
        if svc.live and not u.events and ocr:
            u = svc.extract_image(data, art.mime, ocr, kind)
        art.text_content = u.text or ocr
    elif data and art.mime.startswith("audio/"):
        transcript = text
        if text:
            art.transcription = "BROWSER"
        elif not svc.live and (fixture or {}).get("transcript"):
            transcript = fixture["transcript"]
            art.transcription = DEMO_TRANSCRIPTION
        u = svc.summarize_voice(data, art.mime, transcript, sender)
        if not transcript and u.mode == "gemini" and u.text:
            art.transcription = "GEMINI"
        elif not transcript and (fixture or {}).get("transcript"):  # Gemini failed → fall back to the demo transcript
            transcript = fixture["transcript"]
            art.transcription = DEMO_TRANSCRIPTION
            u = svc.summarize_voice(None, None, transcript, sender)
            u.notice = "AI SERVICE UNAVAILABLE — used the bundled demo transcript (DEMO TRANSCRIPTION)."
        if art.transcription == DEMO_TRANSCRIPTION:
            art.note = f"{DEMO_TRANSCRIPTION}: transcript taken from the bundled demo fixture, not live speech recognition."
        art.text_content = u.text or transcript
    else:
        u = svc.extract_message(text or "", sender, kind)
    art.analysis_mode = u.mode
    notice = u.notice or notice

    source_ev = append_event(db, "INPUT_RECEIVED", {"artifact_id": art.id, "kind": kind, "filename": art.filename,
                                                    "page_count": art.page_count, "transcription": art.transcription},
                             category="SOURCE", source_type=kind, source_ref=u.document_no or art.filename or (sender or kind),
                             actor=sender or "merchant", title=KIND_LABEL[kind],
                             change=" • ".join(filter(None, [u.supplier_text or sender, u.document_no or art.filename]))
                             if (art.filename or u.document_no) else (f"“{text[:70]}”" if text else ""),
                             artifact_id=art.id, masters=m)
    state = get_state(db)
    proposals = []
    for idx, pe in enumerate(u.events):
        for prop in build_proposals(pe, u, m, state, db):
            prp = ProposedEvent(id=next_id(db, "proposal", "PRP-", 3000), artifact_id=art.id, **prop)
            db.add(prp)
            proposals.append(prp)
    db.commit()
    return {"artifact": art, "proposals": proposals, "source_event": source_ev,
            "understanding": {"mode": u.mode, "text": art.text_content, "document_type": u.document_type,
                              "document_no": u.document_no, "supplier": u.supplier_text, "notice": notice,
                              "page_count": art.page_count, "transcription": art.transcription,
                              "ai_confidence": round(min((p.confidence for p in proposals), default=0), 2) if proposals else None}}


def _n(v) -> str:
    if v is None:
        return "?"
    return f"{v:g}" if isinstance(v, (int, float)) else str(v)


def _offer(state: BusinessState, sup: str | None, sku: str | None) -> dict | None:
    return state.offers.get(f"{sup}|{sku}") if sup and sku else None


def build_proposals(pe: ParsedEvent, u: Understanding, m: Masters, state: BusinessState, db: Session) -> list[dict]:
    svc = ai_service(db, m)
    reasons: list[str] = [pe.note] if pe.note else []
    candidates: list[dict] = []
    conf = pe.confidence
    out: list[dict] = []

    def resolve_supplier():
        sid, cands = svc.matcher.supplier(pe.supplier_text or u.supplier_text)
        if cands:
            reasons.append(f"{len(cands)} possible suppliers — which one?")
            candidates.extend({"field": "supplier_id", **c} for c in cands)
        elif not sid:
            reasons.append("Supplier not identified")
        return sid

    def resolve_customer():
        cid, cands = svc.matcher.customer(pe.customer_text)
        if cands:
            reasons.append(f"{len(cands)} possible matches — " + " / ".join(c["name"] for c in cands) + ". Which customer?")
            candidates.extend({"field": "customer_id", **c} for c in cands)
        elif not cid:
            reasons.append("Customer not identified")
        return cid

    for it in pe.items:
        for k in ("qty", "unit_price"):
            if isinstance(it.get(k), float) and it[k].is_integer():
                it[k] = int(it[k])
    if isinstance(pe.amount, float) and pe.amount.is_integer():
        pe.amount = int(pe.amount)
    first = pe.items[0] if pe.items else {}
    if pe.type == "PURCHASE_RECEIVED":
        sid = resolve_supplier()
        sku = first.get("sku")
        offer = _offer(state, sid, sku)
        payload = {"supplier_id": sid, "sku": sku, "qty": first.get("qty"), "unit_cost": first.get("unit_price"),
                   "invoice_no": u.document_no, "credit_days": pe.credit_days if pe.credit_days is not None else (offer or {}).get("credit_days", 0)}
        summary = f'{first.get("product")}: {_n(first.get("qty"))} units @ ₹{_n(first.get("unit_price"))}'
        # Deterministic match against an open purchase order from the same supplier (PO ↔ invoice).
        open_po = next((po for pid, po in state.purchase_orders.items()
                        if po["status"] == "APPROVED" and po["supplier_id"] == sid and po["sku"] == sku), None)
        if open_po:
            payload["po_id"] = open_po["po_id"]
            payload["credit_days"] = open_po.get("credit_days", payload["credit_days"])
            summary += f' · matches {open_po["po_id"]}'
            if first.get("qty") and first["qty"] != open_po["qty"]:
                reasons.append(f'Quantity {first["qty"]:g} differs from {open_po["po_id"]} ({open_po["qty"]})')
        out.append(("PURCHASE_RECEIVED", payload, summary))
        if offer and first.get("unit_price") and abs(offer["unit_price"] - first["unit_price"]) > 0.001:
            old, new = offer["unit_price"], first["unit_price"]
            pct = round((new - old) / old * 100, 1)
            out.insert(0, ("SUPPLIER_PRICE_UPDATE", {"supplier_id": sid, "sku": sku, "old_price": old, "new_price": new,
                                                  "change_pct": pct, "invoice_no": u.document_no},
                        f'{m.item_name(sku)}: ₹{old:g} → ₹{new:g} ({pct:+.1f}%)'))
    elif pe.type == "SUPPLIER_QUOTE":
        sid = resolve_supplier()
        sku = first.get("sku")
        offer = _offer(state, sid, sku) or {}
        payload = {"supplier_id": sid, "sku": sku, "unit_price": first.get("unit_price"),
                   "moq": pe.moq or offer.get("moq") or (int(first["qty"]) if first.get("qty") else 1),
                   "delivery_days": pe.delivery_days if pe.delivery_days is not None else offer.get("delivery_days", 2),
                   "credit_days": pe.credit_days if pe.credit_days is not None else offer.get("credit_days", 0),
                   "quoted_qty": first.get("qty")}
        out.append(("SUPPLIER_QUOTE", payload, f'{first.get("product")}: ₹{_n(first.get("unit_price"))} each'
                    + (f', {payload["delivery_days"]}-day delivery' if payload["delivery_days"] is not None else "")))
    elif pe.type == "CUSTOMER_ORDER":
        cid = resolve_customer()
        items = [{"sku": i.get("sku"), "qty": i.get("qty")} for i in pe.items]
        payload = {"customer_id": cid, "items": items, "due": pe.due}
        summary = " + ".join(f'{i.get("qty") or "?"} {m.item_name(i.get("sku"))}' for i in pe.items)
        out.append(("CUSTOMER_ORDER", payload, summary + (f" · due {pe.due}" if pe.due else "")))
    elif pe.type == "PAYMENT_RECEIVED":
        cid = resolve_customer()
        out.append(("PAYMENT_RECEIVED", {"customer_id": cid, "amount": pe.amount, "mode": "cash/UPI"},
                    f'₹{pe.amount:,.0f} received' if pe.amount else "Payment received"))
    elif pe.type == "PAYMENT_MADE":
        sid = resolve_supplier()
        out.append(("PAYMENT_MADE", {"supplier_id": sid, "amount": pe.amount}, f'₹{pe.amount:,.0f} paid' if pe.amount else "Payment made"))
    elif pe.type == "SALE":
        sku = first.get("sku")
        price = first.get("unit_price") or (m.items_by_sku[sku].selling_price if sku in m.items_by_sku else None)
        out.append(("SALE", {"sku": sku, "qty": first.get("qty"), "unit_price": price}, f'{first.get("qty") or "?"} {m.item_name(sku)} sold'))
    elif pe.type == "DAMAGED_STOCK":
        sku = first.get("sku")
        out.append(("DAMAGED_STOCK", {"sku": sku, "qty": first.get("qty")}, f'{first.get("qty") or "?"} {m.item_name(sku)} damaged'))

    result = []
    for etype, payload, summary in out:
        r = list(reasons)
        if not candidates:
            errs = validate_event(state, etype, payload, set(m.items_by_sku), set(m.suppliers), set(m.customers))
            r += [e for e in errs if e not in r and not e.startswith("Missing customer") and not e.startswith("Missing supplier")]
        status = "NEEDS_REVIEW" if (candidates or r or conf < settings.confidence_threshold) else "PROPOSED"
        if conf < settings.confidence_threshold:
            r.append(f"Low confidence ({conf:.0%}) — below the {settings.confidence_threshold:.0%} threshold")
        result.append({"type": etype, "payload": payload, "summary": summary, "confidence": round(conf, 2), "status": status,
                       "review_reason": "; ".join(dict.fromkeys(x for x in r if x)) or None, "candidates": candidates})
    return result


def confirm_proposal(db: Session, prp_id: str, overrides: dict | None, actor: str | None) -> dict:
    prp = db.get(ProposedEvent, prp_id)
    if not prp:
        raise LedgerError(f"Unknown proposal {prp_id}")
    if prp.status in ("CONFIRMED", "REJECTED"):
        raise LedgerError(f"Proposal {prp_id} is already {prp.status.lower()}")
    art = db.get(InputArtifact, prp.artifact_id)
    payload = {**prp.payload, **(overrides or {})}
    if prp.candidates:
        fields = {c["field"] for c in prp.candidates}
        for f in fields:
            if not payload.get(f) or payload[f] not in {c["id"] for c in prp.candidates if c["field"] == f} | {(overrides or {}).get(f)}:
                raise LedgerError("Ambiguous entity — choose the correct match before confirming.")
    if prp.type == "CUSTOMER_ORDER":
        payload["order_id"] = payload.get("order_id") or next_id(db, "order", "ORD-", 600)
    actor = actor or owner_name(db)
    src_ref = (art.text_content or "")[:0] or None
    if art.filename:
        src_ref = art.filename
    if prp.payload.get("invoice_no"):
        src_ref = prp.payload["invoice_no"]
    elif art.kind in ("message", "voice", "text"):
        src_ref = {"message": "WhatsApp", "voice": "Voice note", "text": "Quick entry"}[art.kind] + (f" · {art.sender}" if art.sender else "")
    dedupe = f"{art.sha256}:{prp.type}:{hashlib.sha1(repr(sorted(prp.payload.items())).encode()).hexdigest()[:12]}"
    if prp.type in ("PURCHASE_RECEIVED", "SUPPLIER_PRICE_UPDATE") and payload.get("invoice_no") and payload.get("supplier_id"):
        # the same supplier invoice line can only be booked once, whichever file it arrives in
        dedupe = f'INVOICE:{payload["supplier_id"]}:{payload["invoice_no"]}:{payload.get("sku")}:{prp.type}'
    ev = append_event(db, prp.type, payload, category="EVENT", source_type=art.kind, source_ref=src_ref, actor=actor,
                      confidence=prp.confidence, reason=f"Confirmed by {actor}" + (" after review" if prp.status == "NEEDS_REVIEW" else ""),
                      artifact_id=art.id, dedupe_key=dedupe)
    prp.status, prp.event_id, prp.payload = "CONFIRMED", ev.id, payload
    effects = after_state_change(db, ev.id)
    db.commit()
    return {"event": ev, "proposal": prp, **effects}


def reject_proposal(db: Session, prp_id: str, reason: str | None) -> ProposedEvent:
    prp = db.get(ProposedEvent, prp_id)
    if not prp:
        raise LedgerError(f"Unknown proposal {prp_id}")
    if prp.status == "CONFIRMED":
        raise LedgerError("Already confirmed — reverse the ledger event instead.")
    prp.status = "REJECTED"
    prp.review_reason = reason or prp.review_reason
    db.commit()
    return prp


def mark_review_later(db: Session, prp_id: str) -> ProposedEvent:
    prp = db.get(ProposedEvent, prp_id)
    if not prp:
        raise LedgerError(f"Unknown proposal {prp_id}")
    prp.status = "NEEDS_REVIEW"
    prp.review_reason = prp.review_reason or "Deferred for later review"
    db.commit()
    return prp


# ---------------------------------------------------------------------------
# THINK
# ---------------------------------------------------------------------------

def current_risks(db: Session, state: BusinessState | None = None, m: Masters | None = None) -> list[dict]:
    m = m or Masters(db)
    state = state or get_state(db)
    return detect_risks(state, m.items, {k: v.short_name for k, v in m.suppliers.items()},
                        {k: v.name for k, v in m.customers.items()}, risk_config(db))


def _intel_text(r: dict, m: Masters) -> tuple[str, str]:
    mt = r["metrics"]
    if r["type"] == "STOCKOUT":
        return "Stock shortage predicted", f'{m.item_name(r["sku"])} shortage: {mt["expected_shortage"]} units • Required by tomorrow'
    if r["type"] == "LOW_STOCK":
        return "Below reorder point", f'{m.item_name(r["sku"])}: projected {mt["projected"]:g} vs reorder point {mt["reorder_point"]}'
    if r["type"] == "PRICE_CHANGE":
        return "Price anomaly detected", f'{m.item_name(r["sku"])} ₹{mt["old_price"]:g} → ₹{mt["new_price"]:g} ({mt["change_pct"]:+.1f}%)'
    if r["type"] == "MARGIN_ANOMALY":
        return "Margin anomaly detected", f'{m.item_name(r["sku"])} margin {mt["previous_margin_pct"]}% → {mt["margin_pct"]}%' \
            if mt.get("previous_margin_pct") is not None else f'{m.item_name(r["sku"])} margin {mt["margin_pct"]}%'
    if r["type"] == "QUOTE_INVOICE_MISMATCH":
        return "Quote–invoice mismatch", f'{m.item_name(r["sku"])} quoted ₹{mt["quoted_price"]:g}, invoiced ₹{mt["invoiced_price"]:g} ({mt["difference_pct"]:+.1f}%)'
    if r["type"] == "INVENTORY_MISMATCH":
        return "Inventory mismatch", r["reason"]
    return r["title"], r["reason"]


def after_state_change(db: Session, caused_by: str | None, ts: datetime | None = None) -> dict:
    """THINK after every state change: log new intelligence and refresh recommendations."""
    db.flush()
    m = Masters(db)
    state = get_state(db)
    risks = current_risks(db, state, m)
    new_intel = []
    for r in risks:
        if r["type"] not in INTEL_TYPES:
            continue
        sig = r["key"] + (f':{r["metrics"]["expected_shortage"]}' if r["type"] == "STOCKOUT" else "")
        key = f"INTEL:{sig}"
        if db.scalar(select(BusinessEvent.id).where(BusinessEvent.dedupe_key == key)):
            continue
        title, change = _intel_text(r, m)
        ev = append_event(db, "RISK_DETECTED", {"risk": {k: v for k, v in r.items() if k != "orders"}, "orders": r.get("orders", [])},
                          category="INTELLIGENCE", source_type="engine", source_ref="Decision engine", actor="OFFLIMITS",
                          title=title, change=change, entity=r.get("sku") or r.get("entity"), reason=r["reason"],
                          caused_by=caused_by, dedupe_key=key, ts=ts, masters=m, state=state)
        new_intel.append(ev)
    recs = sync_recommendations(db, state, risks, m, caused_by, ts)
    return {"intelligence": new_intel, "recommendations": recs}


def _explanation(best: dict, cmp: dict, risk: dict, m: Masters) -> str:
    cheapest = min(cmp["options"], key=lambda o: o["unit_price"])
    name = m.item_name(risk["sku"])
    parts = [f'{best["supplier"]} is recommended']
    if cheapest["supplier_id"] != best["supplier_id"]:
        parts[0] += f' despite a higher unit price than {cheapest["supplier"]} (₹{best["unit_price"]:g} vs ₹{cheapest["unit_price"]:g})'
    reasons = []
    if best["moq"] <= cmp["target_max"]:
        reasons.append(f'its MOQ of {best["moq"]} fits the need')
    reasons.append(f'delivery {best["delivery_label"].lower()} arrives before the need-by date' if best["on_time"] else "")
    if best["credit_days"]:
        reasons.append(f'{best["credit_days"]}-day credit means no immediate cash outflow')
    text = parts[0] + ": " + ", ".join(r for r in reasons if r) + f". This prevents the predicted {name} shortage of {risk['need_qty']} units"
    if cheapest["supplier_id"] != best["supplier_id"] and cheapest.get("notes"):
        text += f'. {cheapest["supplier"]}: ' + "; ".join(cheapest["notes"]).lower()
    return text + "."


def sync_recommendations(db: Session, state: BusinessState, risks: list[dict], m: Masters, caused_by: str | None,
                         ts: datetime | None = None) -> list[Recommendation]:
    cfg = risk_config(db)
    svc = ai_service(db, m)
    active = set()
    created = []
    for r in risks:
        if r.get("action") != "evaluate_suppliers":
            continue
        cmp = compare_suppliers(state, r["sku"], int(r["need_qty"]), int(r["target_max"]), cfg.horizon_days, m.suppliers)
        if not cmp["options"]:
            continue
        best = next(o for o in cmp["options"] if o.get("recommended"))
        active.add(r["key"])
        reason = (f'{r["reason"]} Projected shortfall {r["need_qty"]} units.' if r["type"] == "STOCKOUT"
                  else r["reason"])
        existing = db.scalar(select(Recommendation).where(Recommendation.risk_key == r["key"], Recommendation.status == "PENDING"))
        fallback = _explanation(best, cmp, r, m)
        cmp_store = {**cmp, "risk": {k: v for k, v in r.items() if k != "orders"}}
        if existing:
            if existing.qty != best["qty"] or existing.supplier_id != best["supplier_id"] or existing.unit_price != best["unit_price"]:
                existing.supplier_id, existing.qty, existing.unit_price, existing.total = (best["supplier_id"], best["qty"],
                                                                                         best["unit_price"], best["total"])
                existing.explanation = fallback
            existing.comparison, existing.reason = cmp_store, reason
            continue
        rejected = db.scalar(select(Recommendation).where(Recommendation.risk_key == r["key"], Recommendation.status == "REJECTED",
                                                          Recommendation.qty == best["qty"], Recommendation.supplier_id == best["supplier_id"]))
        if rejected:
            continue
        rec_id = next_id(db, "rec", "REC-", 1040)
        why = cmp.get("why", [""])[0]
        dec = append_event(db, "SUPPLIERS_EVALUATED", {"recommendation_id": rec_id, "sku": r["sku"], "options": len(cmp["options"]),
                                                       "recommended": best["supplier_id"]},
                           category="DECISION", source_type="engine", source_ref="Action engine", actor="OFFLIMITS",
                           title="Suppliers evaluated",
                           change=f'{best["supplier"]} recommended — ' + ", ".join(
                               x for x in ["best MOQ" if best["scores"]["moq_fit"] >= 90 else "", "delivery" if best["on_time"] else "",
                                           "credit" if best["credit_days"] else ""] if x) if best else "",
                           entity=r["sku"], reason=why, caused_by=caused_by, ts=ts, masters=m, state=state)
        rec = Recommendation(id=rec_id, risk_key=r["key"], sku=r["sku"], supplier_id=best["supplier_id"], qty=best["qty"],
                             unit_price=best["unit_price"], total=best["total"], reason=reason,
                             explanation=svc.explain_decision({"risk": r["metrics"], "recommended": best}, fallback),
                             comparison=cmp_store, status="PENDING", trigger_event_id=caused_by, decision_event_id=dec.id,
                             created_at=ts or datetime.now(timezone.utc))
        db.add(rec)
        created.append(rec)
    for rec in db.scalars(select(Recommendation).where(Recommendation.status == "PENDING")):
        if rec.risk_key not in active:
            rec.status = "SUPERSEDED"
            rec.reason = (rec.reason or "") + " — superseded: the risk is no longer present."
    db.flush()
    return created


def run_simulation(db: Session, sku: str, scenarios: list[dict], name: str | None, question: str | None, save: bool = True):
    m = Masters(db)
    if sku not in m.items_by_sku:
        raise LedgerError(f"Unknown SKU {sku}")
    state = get_state(db)
    item = m.items_by_sku[sku]
    daily = item_demand(state, item)
    results = []
    for sc in scenarios:
        if not isinstance(sc.get("qty"), (int, float)) or sc["qty"] <= 0:
            raise LedgerError("Each scenario needs a positive quantity")
        if sc.get("supplier_id") and not sc.get("unit_price"):
            offer = _offer(state, sc["supplier_id"], sku)
            if not offer:
                raise LedgerError(f"{sc['supplier_id']} has no price for {sku}")
            sc = {**{k: offer[k] for k in ("unit_price", "delivery_days", "credit_days")}, **sc}
        if not sc.get("unit_price") or sc["unit_price"] <= 0:
            raise LedgerError("Each scenario needs a unit price above 0")
        if sc.get("supplier_id") and sc["supplier_id"] in m.suppliers and not sc.get("label"):
            sc["label"] = f'{m.suppliers[sc["supplier_id"]].short_name} · {int(sc["qty"])} units'
        results.append(simulate(state, item, daily, sc))
    seen: dict[str, int] = {}
    for r in results:  # keep labels unique so badges and charts stay unambiguous
        seen[r["label"]] = seen.get(r["label"], 0) + 1
        if seen[r["label"]] > 1:
            r["label"] = f'{r["label"]} ({seen[r["label"]]})'
    verdict = compare_scenarios(results)
    if not save:  # live recalculation while editing
        return {"scenarios": results, "verdict": verdict, "sku": sku, "item": item.name, "daily_demand": daily}
    sim = Scenario(id=next_id(db, "sim", "SIM-", 100), name=name or f"What-if · {item.name}", question=question,
                   inputs={"sku": sku, "scenarios": scenarios}, results={"scenarios": results, "verdict": verdict, "sku": sku,
                                                                         "item": item.name, "daily_demand": daily})
    db.add(sim)
    db.commit()
    return sim


# ---------------------------------------------------------------------------
# ACT
# ---------------------------------------------------------------------------

def _metrics(state: BusinessState, sku: str, db: Session) -> dict:
    m = Masters(db)
    item = m.items_by_sku[sku]
    cfg = risk_config(db)
    ln = state.inventory.get(sku)
    daily = item_demand(state, item)
    on_hand = ln.on_hand if ln else 0
    reserved = ln.reserved if ln else 0
    incoming = ln.incoming if ln else 0
    projected = on_hand - reserved + incoming - daily * cfg.horizon_days
    return {"sku": sku, "on_hand": on_hand, "reserved": reserved, "incoming": incoming,
            "predicted_shortage": max(0, round(-projected)), "cash": round(state.cash, 2),
            "payables": round(sum(state.payables.values()), 2)}


def approve_recommendation(db: Session, rec_id: str, actor: str | None, supplier_id: str | None, qty: int | None,
                           note: str | None, acknowledged: bool) -> dict:
    rec = db.get(Recommendation, rec_id)
    if not rec:
        raise LedgerError(f"Unknown recommendation {rec_id}")
    if rec.status != "PENDING":
        raise LedgerError(f"Recommendation {rec_id} is {rec.status.lower()}")
    if not acknowledged:
        raise LedgerError("Human approval required: confirm you reviewed the recommendation and supporting evidence.")
    actor = actor or owner_name(db)
    options = {o["supplier_id"]: o for o in rec.comparison.get("options", [])}
    sup = supplier_id or rec.supplier_id
    if sup not in options:
        raise LedgerError(f"Supplier {sup} has no offer for {rec.sku}")
    opt = options[sup]
    q = int(qty if qty is not None else (rec.qty if sup == rec.supplier_id else opt["qty"]))
    if q <= 0:
        raise LedgerError("Quantity must be positive")
    if q < opt["moq"]:
        raise LedgerError(f'{opt["supplier"]} requires a minimum order of {opt["moq"]} units')
    state = get_state(db)
    before = _metrics(state, rec.sku, db)
    total = round(q * opt["unit_price"], 2)
    m = Masters(db)
    apr = Approval(id=next_id(db, "approval", "APR-", 90, 4), recommendation_id=rec.id, actor=actor, decision="APPROVED", note=note,
                   snapshot={"supplier_id": sup, "qty": q, "unit_price": opt["unit_price"], "total": total, "before": before})
    db.add(apr)
    db.flush()
    apr_ev = append_event(db, "PROCUREMENT_APPROVED", {"recommendation_id": rec.id, "approval_id": apr.id, "supplier_id": sup, "qty": q},
                          category="APPROVAL", source_type="user", source_ref=rec.id, actor=actor,
                          title="Merchant approved procurement", change=f"{actor} • {m.supplier_name(sup)}, {q} units",
                          entity=rec.sku, reason=note or "Reviewed recommendation and supporting evidence",
                          approval_id=apr.id, caused_by=rec.decision_event_id, masters=m)
    po_id = next_id(db, "po", "OFF-2026-", 90, 3)
    payload = {"po_id": po_id, "supplier_id": sup, "sku": rec.sku, "qty": q, "unit_price": opt["unit_price"], "total": total,
               "credit_days": opt["credit_days"], "delivery_days": opt["delivery_days"], "recommendation_id": rec.id,
               "approval_id": apr.id}
    po_ev = append_event(db, "PURCHASE_ORDER_CREATED", payload, category="ACTION", source_type="user", source_ref=rec.id,
                         actor=actor, change=f'{m.supplier_name(sup)} • {q} {m.item_name(rec.sku)} @ ₹{opt["unit_price"]:g} • ₹{total:,.0f}'
                         + (f' • {opt["credit_days"]}-day credit' if opt["credit_days"] else ""),
                         reason=f"Approved by {actor} ({apr.id})", approval_id=apr.id, caused_by=apr_ev.id, masters=m)
    po = PurchaseOrder(id=po_id, supplier_id=sup, sku=rec.sku, qty=q, unit_price=opt["unit_price"], total=total,
                       credit_days=opt["credit_days"], delivery_days=opt["delivery_days"], status="APPROVED",
                       recommendation_id=rec.id, approval_id=apr.id, approved_by=actor, event_id=po_ev.id)
    db.add(po)
    rec.status, rec.po_id, rec.decided_at, rec.decided_by = "APPROVED", po_id, datetime.now(timezone.utc), actor
    if sup != rec.supplier_id or q != rec.qty:
        rec.supplier_id, rec.qty, rec.unit_price, rec.total = sup, q, opt["unit_price"], total
    effects = after_state_change(db, po_ev.id)
    after = _metrics(get_state(db), rec.sku, db)
    db.commit()
    return {"purchase_order": po, "approval": apr, "events": [apr_ev, po_ev], "before": before, "after": after, **effects}


def reject_recommendation(db: Session, rec_id: str, actor: str | None, reason: str | None) -> Recommendation:
    rec = db.get(Recommendation, rec_id)
    if not rec:
        raise LedgerError(f"Unknown recommendation {rec_id}")
    if rec.status != "PENDING":
        raise LedgerError(f"Recommendation {rec_id} is {rec.status.lower()}")
    actor = actor or owner_name(db)
    apr = Approval(id=next_id(db, "approval", "APR-", 90, 4), recommendation_id=rec.id, actor=actor, decision="REJECTED", note=reason)
    db.add(apr)
    db.flush()
    append_event(db, "RECOMMENDATION_REJECTED", {"recommendation_id": rec.id, "approval_id": apr.id}, category="APPROVAL",
                 source_type="user", source_ref=rec.id, actor=actor, title="Recommendation rejected",
                 change=f"{actor} • {rec.id}", entity=rec.sku, reason=reason or "Rejected by merchant", approval_id=apr.id,
                 caused_by=rec.decision_event_id)
    rec.status, rec.decided_at, rec.decided_by = "REJECTED", datetime.now(timezone.utc), actor
    db.commit()
    return rec


def create_purchase_order(db: Session, sku: str, supplier_id: str, qty: int, actor: str | None, acknowledged: bool,
                          note: str | None) -> dict:
    """Manual PO (outside a recommendation). Still requires explicit human approval."""
    if not acknowledged:
        raise LedgerError("Human approval required: set acknowledged=true to confirm this purchase.")
    m = Masters(db)
    state = get_state(db)
    offer = _offer(state, supplier_id, sku)
    if supplier_id not in m.suppliers:
        raise LedgerError(f"Unknown supplier {supplier_id}")
    if not offer:
        raise LedgerError(f"{supplier_id} has no price for {sku}")
    if qty < offer.get("moq", 1):
        raise LedgerError(f'Minimum order for this supplier is {offer.get("moq")} units')
    actor = actor or owner_name(db)
    apr = Approval(id=next_id(db, "approval", "APR-", 90, 4), recommendation_id=None, actor=actor, decision="APPROVED", note=note)
    db.add(apr)
    db.flush()
    total = round(qty * offer["unit_price"], 2)
    po_id = next_id(db, "po", "OFF-2026-", 90, 3)
    payload = {"po_id": po_id, "supplier_id": supplier_id, "sku": sku, "qty": qty, "unit_price": offer["unit_price"], "total": total,
               "credit_days": offer.get("credit_days", 0), "delivery_days": offer.get("delivery_days", 0), "approval_id": apr.id}
    ev = append_event(db, "PURCHASE_ORDER_CREATED", payload, category="ACTION", source_type="user", actor=actor,
                      reason=f"Manual purchase approved by {actor}", approval_id=apr.id, masters=m)
    po = PurchaseOrder(id=po_id, supplier_id=supplier_id, sku=sku, qty=qty, unit_price=offer["unit_price"], total=total,
                       credit_days=offer.get("credit_days", 0), delivery_days=offer.get("delivery_days", 0),
                       approval_id=apr.id, approved_by=actor, event_id=ev.id)
    db.add(po)
    effects = after_state_change(db, ev.id)
    db.commit()
    return {"purchase_order": po, "approval": apr, **effects}


def receive_purchase_order(db: Session, po_id: str, qty: int | None, actor: str | None) -> dict:
    po = db.get(PurchaseOrder, po_id)
    if not po:
        raise LedgerError(f"Unknown purchase order {po_id}")
    if po.status == "RECEIVED":
        raise LedgerError(f"{po_id} was already received")
    q = int(qty or po.qty)
    ev = append_event(db, "PURCHASE_RECEIVED", {"po_id": po.id, "supplier_id": po.supplier_id, "sku": po.sku, "qty": q,
                                                "unit_cost": po.unit_price, "credit_days": po.credit_days},
                      category="EVENT", source_type="delivery", source_ref=po.id, actor=actor or owner_name(db),
                      reason=f"Goods received against {po.id}", caused_by=po.event_id)
    effects = after_state_change(db, ev.id)
    db.commit()
    return {"event": ev, "purchase_order": po, **effects}


def fulfil_order(db: Session, order_id: str, actor: str | None) -> dict:
    ev = append_event(db, "ORDER_FULFILLED", {"order_id": order_id}, category="EVENT", source_type="user", source_ref=order_id,
                      actor=actor or owner_name(db), reason="Order delivered to customer")
    effects = after_state_change(db, ev.id)
    db.commit()
    return {"event": ev, **effects}


def reverse_event(db: Session, event_id: str, actor: str | None, reason: str | None) -> dict:
    target = db.scalar(select(BusinessEvent).where(BusinessEvent.id == event_id))
    if not target:
        raise LedgerError(f"Unknown event {event_id}")
    if target.type not in STATE_EVENT_TYPES or target.type == "EVENT_REVERSED" or target.category == "OPENING":
        raise LedgerError("Only confirmed business events (not opening balances or system notes) can be reversed.")
    if target.status == "REVERSED":
        raise LedgerError(f"{event_id} is already reversed")
    if target.type == "PURCHASE_ORDER_CREATED":
        raise LedgerError("Purchase orders cannot be reversed from the ledger in this prototype.")
    events = [e for e in all_events(db) if e.id != event_id]
    trial = project(events)
    neg = [sku for sku, ln in trial.inventory.items() if ln.on_hand < 0]
    if neg:
        raise LedgerError(f"Reversal would make inventory negative for {', '.join(neg)}")
    ev = append_event(db, "EVENT_REVERSED", {"reverses": event_id}, category="CORRECTION", source_type="user", source_ref=event_id,
                      actor=actor or owner_name(db), reason=reason or "Correction", caused_by=event_id)
    effects = after_state_change(db, ev.id)
    db.commit()
    return {"event": ev, **effects}
