"""Decision Intelligence Engine — detects consequences in the live business state.

Everything here is deterministic rules over the projected state. The language
model is never asked to decide whether a risk exists.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.engines.state import BusinessState, forecast_daily_demand, margin_percentage, stockout_assessment

SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}


@dataclass
class RiskConfig:
    horizon_days: float = 1.0          # "required by tomorrow"
    cover_days: float = 7.0            # how many days of demand a purchase should cover
    min_margin_pct: float = 10.0
    margin_drop_pp: float = 3.0
    price_change_pct: float = 5.0
    mismatch_pct: float = 2.0
    min_cash_buffer: float = 10000.0
    receivable_alert: float = 5000.0


def item_demand(state: BusinessState, item) -> float:
    days = sorted(state.daily_sales.get(item.sku, {}).items())
    return forecast_daily_demand([v for _, v in days], item.daily_demand)


def stock_view(state: BusinessState, item, cfg: RiskConfig) -> dict:
    ln = state.inventory.get(item.sku)
    on_hand = ln.on_hand if ln else 0
    reserved = ln.reserved if ln else 0
    incoming = ln.incoming if ln else 0
    daily = item_demand(state, item)
    a = stockout_assessment(on_hand, reserved, incoming, daily, cfg.horizon_days, item.reorder_point)
    a["daily_demand"] = daily
    a["unit_cost"] = ln.last_cost if ln else None
    return a


def detect_risks(state: BusinessState, items: list, suppliers: dict, customers: dict,
                 cfg: RiskConfig | None = None) -> list[dict]:
    cfg = cfg or RiskConfig()
    risks: list[dict] = []
    by_sku = {i.sku: i for i in items}

    # --- Stockout / low stock / order risk ------------------------------------------------
    for item in items:
        v = stock_view(state, item, cfg)
        affected_orders = [oid for oid, o in state.orders.items()
                           if o["status"] == "OPEN" and any(it["sku"] == item.sku for it in o["items"])]
        if v["level"] in ("CRITICAL", "HIGH"):
            shortfall = int(round(v["shortfall"]))
            low = shortfall
            high = int(5 * round((shortfall + v["daily_demand"] * cfg.cover_days) / 5))
            reason = (f"Committed orders ({v['reserved']:g}) exceed stock on hand ({v['on_hand']:g})."
                      if v["available"] < 0 else
                      f"Forecast demand ({v['forecast_demand']:g}) exceeds available stock ({v['available']:g}).")
            risks.append({
                "key": f"STOCKOUT:{item.sku}", "type": "STOCKOUT", "category": "Inventory",
                "severity": v["level"], "sku": item.sku, "entity": item.name,
                "title": "Stock Shortage Predicted",
                "metrics": {"current_stock": v["on_hand"], "reserved": v["reserved"], "available": v["available"],
                            "incoming": v["incoming"], "forecast_demand": v["forecast_demand"],
                            "expected_shortage": shortfall, "required_by": "Tomorrow",
                            "recommended_purchase": f"{low}–{max(high, low)} units"},
                "reason": reason, "orders": affected_orders,
                "recommendation": "Replenish inventory before tomorrow morning.",
                "action": "evaluate_suppliers", "need_qty": max(shortfall, 1), "target_max": max(high, shortfall),
            })
        elif v["level"] == "MEDIUM":
            need = int(round(item.reorder_point + v["daily_demand"] * 3 - v["projected"]))
            risks.append({
                "key": f"LOW_STOCK:{item.sku}", "type": "LOW_STOCK", "category": "Inventory",
                "severity": "MEDIUM", "sku": item.sku, "entity": item.name,
                "title": "Below Reorder Point",
                "metrics": {"current_stock": v["on_hand"], "reserved": v["reserved"], "available": v["available"],
                            "projected": v["projected"], "reorder_point": item.reorder_point,
                            "days_to_stockout": v["days_to_stockout"]},
                "reason": f"Projected stock ({v['projected']:g}) is below the reorder point ({item.reorder_point}).",
                "orders": affected_orders,
                "recommendation": "Plan a replenishment order in the next few days.",
                "action": "evaluate_suppliers", "need_qty": max(need, 1),
                "target_max": max(need, int(item.reorder_point + v["daily_demand"] * cfg.cover_days - v["projected"])),
            })

    # --- Supplier price changes and margin anomalies ----------------------------------------
    latest_change: dict[tuple, dict] = {}
    for ch in state.price_changes:
        latest_change[(ch["supplier_id"], ch["sku"])] = ch
    for (sup, sku), ch in latest_change.items():
        pct = ch.get("change_pct")
        if pct is None and ch.get("old_price"):
            pct = round((ch["new_price"] - ch["old_price"]) / ch["old_price"] * 100, 1)
        if pct is not None and abs(pct) >= cfg.price_change_pct and sku in by_sku:
            risks.append({
                "key": f"PRICE_CHANGE:{sup}:{sku}:{ch['new_price']}", "type": "PRICE_CHANGE", "category": "Suppliers",
                "severity": "MEDIUM", "sku": sku, "entity": by_sku[sku].name,
                "title": "Supplier Price Change",
                "metrics": {"supplier": suppliers.get(sup, sup), "old_price": ch.get("old_price"),
                            "new_price": ch["new_price"], "change_pct": pct},
                "reason": f"{suppliers.get(sup, sup)} changed {by_sku[sku].name} from ₹{ch.get('old_price')} to ₹{ch['new_price']} ({pct:+.1f}%).",
                "recommendation": "Check margin impact and compare other suppliers before the next purchase.",
                "action": "compare_suppliers",
            })

    for item in items:
        ln = state.inventory.get(item.sku)
        if not ln or ln.last_cost is None:
            continue
        now_pct = margin_percentage(item.selling_price, ln.last_cost)
        before_pct = margin_percentage(item.selling_price, ln.prev_cost) if ln.prev_cost else None
        dropped = before_pct is not None and before_pct - now_pct >= cfg.margin_drop_pp and now_pct < 20
        if dropped or now_pct < cfg.min_margin_pct:
            sev = "HIGH" if now_pct < cfg.min_margin_pct else "MEDIUM"
            risks.append({
                "key": f"MARGIN:{item.sku}:{ln.last_cost}", "type": "MARGIN_ANOMALY", "category": "Margins",
                "severity": sev, "sku": item.sku, "entity": item.name, "title": "Margin Anomaly",
                "metrics": {"selling_price": item.selling_price, "unit_cost": ln.last_cost, "previous_cost": ln.prev_cost,
                            "margin_pct": now_pct, "previous_margin_pct": before_pct},
                "reason": (f"Cost rose from ₹{ln.prev_cost:g} to ₹{ln.last_cost:g}; margin fell from {before_pct}% to {now_pct}%."
                           if dropped else f"Margin is only {now_pct}% (threshold {cfg.min_margin_pct:g}%)."),
                "recommendation": f"Review the selling price of {item.name} or source from a cheaper supplier.",
                "action": "compare_suppliers",
            })

    # --- Quote vs invoice mismatch (contradiction detection) --------------------------------
    for inv in state.invoice_prices:
        refs = state.quotes + [{"supplier_id": c["supplier_id"], "sku": c["sku"], "unit_price": c["new_price"], "ts": c["ts"],
                                "event": c["event"]} for c in state.price_changes]
        quotes = sorted([q for q in refs if q["supplier_id"] == inv["supplier_id"] and q["sku"] == inv["sku"]
                         and q["ts"] <= inv["ts"]], key=lambda q: q["ts"])
        if not quotes:
            continue
        q = quotes[-1]
        diff = round((inv["unit_price"] - q["unit_price"]) / q["unit_price"] * 100, 1)
        if diff >= cfg.mismatch_pct and inv["sku"] in by_sku:
            risks.append({
                "key": f"MISMATCH:{inv['event']}", "type": "QUOTE_INVOICE_MISMATCH", "category": "Suppliers",
                "severity": "HIGH" if diff >= 5 else "MEDIUM", "sku": inv["sku"], "entity": by_sku[inv["sku"]].name,
                "title": "Quote–Invoice Mismatch",
                "metrics": {"supplier": suppliers.get(inv["supplier_id"], inv["supplier_id"]), "quoted_price": q["unit_price"],
                            "invoiced_price": inv["unit_price"], "difference_pct": diff},
                "reason": f"Quoted ₹{q['unit_price']:g}/unit but invoiced ₹{inv['unit_price']:g}/unit ({diff:+.1f}%).",
                "evidence": [q["event"], inv["event"]],
                "recommendation": "Raise the difference with the supplier before paying the invoice.",
                "action": "review_sources",
            })

    # --- Inventory mismatch: received quantity differs from PO quantity ----------------------
    for po_id, po in state.purchase_orders.items():
        if po.get("received_qty") is not None and po["received_qty"] != po["qty"]:
            risks.append({
                "key": f"INV_MISMATCH:{po_id}", "type": "INVENTORY_MISMATCH", "category": "Inventory",
                "severity": "MEDIUM", "sku": po["sku"], "entity": by_sku[po["sku"]].name if po["sku"] in by_sku else po["sku"],
                "title": "Inventory Mismatch",
                "metrics": {"po": po_id, "ordered": po["qty"], "received": po["received_qty"]},
                "reason": f"{po_id}: ordered {po['qty']} but received {po['received_qty']}.",
                "recommendation": "Confirm the delivery note with the supplier.", "action": "review_sources",
            })

    # --- Cash & payments ------------------------------------------------------------------------
    payables = sum(v for v in state.payables.values() if v > 0)
    if state.cash < cfg.min_cash_buffer:
        risks.append({
            "key": "CASH:LOW", "type": "WORKING_CAPITAL", "category": "Cash", "severity": "HIGH", "sku": None,
            "entity": "Cash position", "title": "Low Cash Buffer",
            "metrics": {"cash": round(state.cash, 2), "buffer": cfg.min_cash_buffer, "payables": round(payables, 2)},
            "reason": f"Cash ₹{state.cash:,.0f} is below the ₹{cfg.min_cash_buffer:,.0f} buffer.",
            "recommendation": "Prefer credit terms and delay non-urgent purchases.", "action": "none",
        })
    for cid, amt in state.receivables.items():
        if amt >= cfg.receivable_alert:
            risks.append({
                "key": f"RECEIVABLE:{cid}", "type": "OUTSTANDING_PAYMENT", "category": "Payments", "severity": "MEDIUM",
                "sku": None, "entity": customers.get(cid, cid), "title": "Outstanding Receivable",
                "metrics": {"customer": customers.get(cid, cid), "amount": round(amt, 2)},
                "reason": f"{customers.get(cid, cid)} owes ₹{amt:,.0f}.",
                "recommendation": "Send a payment reminder.", "action": "none",
            })

    risks.sort(key=lambda r: (SEVERITY_ORDER[r["severity"]], r["type"]))
    return risks
