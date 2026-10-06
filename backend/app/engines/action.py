"""Action Engine — supplier comparison, recommendations and the what-if simulator.

All arithmetic is deterministic. The cheapest unit price is *not* automatically
the best choice: delivery against the need-by date, MOQ fit, credit terms and
cash impact are scored together.
"""
from __future__ import annotations

import math

from app.engines.state import BusinessState, margin_percentage, working_capital_impact

WEIGHTS = {"price": 0.25, "moq_fit": 0.20, "delivery": 0.25, "credit": 0.10, "cash_impact": 0.20}


def _clamp(v: float, lo: float = 0, hi: float = 100) -> float:
    return max(lo, min(hi, v))


def compare_suppliers(state: BusinessState, sku: str, need_qty: int, target_max: int, needed_by_days: float,
                      suppliers: dict, cash_reference: float | None = None) -> dict:
    """Score every supplier offer for ``sku`` and recommend one.

    need_qty   – minimum units required to avoid the shortfall
    target_max – upper bound before stock becomes excess (shortfall + cover days of demand)
    """
    offers = [o for o in state.offers.values() if o["sku"] == sku]
    if not offers:
        return {"sku": sku, "options": [], "recommended": None, "need_qty": need_qty, "target_max": target_max}
    min_price = min(o["unit_price"] for o in offers)
    options = []
    for o in offers:
        sup = suppliers.get(o["supplier_id"])
        moq = int(o.get("moq", 1) or 1)
        qty = max(moq, need_qty)
        total = round(qty * o["unit_price"], 2)
        credit = int(o.get("credit_days", 0) or 0)
        delivery = int(o.get("delivery_days", 0) or 0)
        wc = working_capital_impact(total, credit)
        excess = max(0, qty - target_max)
        on_time = delivery <= needed_by_days
        scores = {
            "price": round(min_price / o["unit_price"] * 100),
            "moq_fit": round(_clamp(100 - (excess / max(target_max, 1)) * 100)),
            "delivery": round(_clamp(100 - 25 * delivery)) if on_time else 20,
            "credit": round(_clamp(credit / 15 * 100)),
            "cash_impact": round(_clamp(100 - wc["cash_outflow_now"] / 50)),
        }
        total_score = round(sum(scores[k] * w for k, w in WEIGHTS.items()), 1)
        risk = "Low" if on_time and excess == 0 else ("High" if not on_time else "Medium")
        notes = []
        if not on_time:
            notes.append(f"Arrives in {delivery} days — after the need-by date, stockout likely")
        if excess:
            notes.append(f"MOQ {moq} leaves ~{excess} excess units")
        if credit:
            notes.append(f"{credit}-day credit: no immediate cash outflow")
        options.append({
            "supplier_id": o["supplier_id"],
            "supplier": sup.short_name if sup else o["supplier_id"],
            "supplier_name": sup.name if sup else o["supplier_id"],
            "reliability": round((sup.reliability if sup else 0.8) * 100),
            "unit_price": o["unit_price"], "moq": moq, "qty": qty, "total": total,
            "credit_days": credit, "delivery_days": delivery,
            "delivery_label": "Today" if delivery == 0 else ("Tomorrow" if delivery == 1 else f"{delivery} days"),
            "cash_required": wc["cash_outflow_now"], "deferred_payable": wc["deferred_payable"],
            "excess_units": excess, "on_time": on_time, "risk": risk, "scores": scores, "score": total_score,
            "notes": notes,
        })
    options.sort(key=lambda x: (-x["score"], x["total"]))
    feasible = [o for o in options if o["on_time"]] or options
    best = feasible[0]
    best["recommended"] = True
    cheapest = min(options, key=lambda x: x["unit_price"])
    why = [f"{best['supplier']} scores {best['score']} on price, MOQ fit, delivery, credit and cash impact."]
    if cheapest["supplier_id"] != best["supplier_id"]:
        why.append(f"{cheapest['supplier']} is cheaper per unit (₹{cheapest['unit_price']:g}) but "
                   + ("; ".join(cheapest["notes"]) or "scores lower overall") + ".")
    return {"sku": sku, "need_qty": need_qty, "target_max": target_max, "options": options,
            "recommended": best["supplier_id"], "why": why, "weights": WEIGHTS}


# --------------------------------------------------------------------------
# What-if simulator
# --------------------------------------------------------------------------

def simulate(state: BusinessState, item, daily_demand: float, scenario: dict) -> dict:
    """Deterministically evaluate one purchase scenario."""
    sku = item.sku
    ln = state.inventory.get(sku)
    on_hand = ln.on_hand if ln else 0
    reserved = ln.reserved if ln else 0
    incoming = ln.incoming if ln else 0
    unit_cost_now = ln.last_cost if ln and ln.last_cost else scenario.get("unit_price", 0)

    qty = int(scenario["qty"])
    base_price = float(scenario["unit_price"])
    discount = float(scenario.get("discount_pct", 0) or 0)
    eff_price = round(base_price * (1 - discount / 100), 2)
    delivery = int(scenario.get("delivery_days", 0) or 0)
    credit = int(scenario.get("credit_days", 0) or 0)
    demand = float(scenario.get("daily_demand") or daily_demand)
    cover = float(scenario.get("cover_days", 7))
    need_by = float(scenario.get("needed_by_days", 1))

    available = on_hand - reserved
    purchase_cost = round(qty * eff_price, 2)
    savings = round(qty * (base_price - eff_price), 2)
    stock_at_need_by_without = available + incoming - demand * need_by
    arrives_in_time = delivery <= need_by
    stock_at_need_by = stock_at_need_by_without + (qty if arrives_in_time else 0)
    projected_after_cover = available + incoming + qty - demand * cover
    excess = max(0, round(projected_after_cover))
    days_to_clear = round(max(available + incoming + qty, 0) / demand, 1) if demand > 0 else None
    if stock_at_need_by < 0:
        risk = "HIGH"
    elif projected_after_cover < 0:
        risk = "MEDIUM"
    else:
        risk = "LOW"
    wc = working_capital_impact(purchase_cost, credit)
    locked = round(excess * eff_price, 2)
    m_now = margin_percentage(item.selling_price, unit_cost_now)
    m_new = margin_percentage(item.selling_price, eff_price)
    suggested = max(0, -(available + incoming)) + demand * cover
    suggested = int(5 * math.ceil(suggested / 5)) if suggested > 0 else 0
    return {
        "label": scenario.get("label") or f"{qty} units",
        "supplier_id": scenario.get("supplier_id"),
        "qty": qty, "unit_price": base_price, "discount_pct": discount, "effective_price": eff_price,
        "delivery_days": delivery, "credit_days": credit, "daily_demand": round(demand, 2),
        "purchase_cost": purchase_cost, "purchase_savings": savings,
        "cash_outflow_now": wc["cash_outflow_now"], "deferred_payable": wc["deferred_payable"],
        "projected_stock": round(available + incoming + qty, 1),
        "stock_at_need_by": round(stock_at_need_by, 1),
        "excess_units": excess, "days_to_clear": days_to_clear,
        "capital_locked_in_excess": locked, "stockout_risk": risk,
        "margin_pct_before": m_now, "margin_pct_after": m_new,
        "margin_impact_pp": round(m_new - m_now, 1),
        "working_capital_impact": "NEGATIVE" if locked > savings else ("NEUTRAL" if locked == 0 else "POSITIVE"),
        "suggested_qty": suggested,
    }


def compare_scenarios(results: list[dict]) -> dict:
    """Pick the scenario that avoids stockouts with the least cash tied up."""
    def cost_key(r):
        return (r["stockout_risk"] != "LOW", r["cash_outflow_now"] + r["capital_locked_in_excess"] - r["purchase_savings"])
    best = min(results, key=cost_key)
    lines = []
    for r in results:
        if r["purchase_savings"] > 0 and r["capital_locked_in_excess"] > r["purchase_savings"]:
            lines.append(f"{r['label']}: saves ₹{r['purchase_savings']:,.0f} but locks ₹{r['capital_locked_in_excess']:,.0f} "
                         f"in {r['excess_units']} excess units (~{r['days_to_clear']} days to clear).")
        elif r["stockout_risk"] != "LOW":
            lines.append(f"{r['label']}: stockout risk {r['stockout_risk'].lower()} — stock at need-by date {r['stock_at_need_by']:g}.")
        else:
            lines.append(f"{r['label']}: ₹{r['purchase_cost']:,.0f} purchase, {r['excess_units']} excess units, risk low.")
    return {"best_label": best["label"], "lines": lines, "suggested_qty": best["suggested_qty"],
            "badges": scenario_badges(results, best["label"])}


def scenario_badges(results: list[dict], balanced: str) -> dict:
    """BEST COST / BEST SPEED / BEST STOCK COVERAGE / BEST BALANCED (ties → first scenario)."""
    return {
        "best_cost": min(results, key=lambda r: r["effective_price"] * 1e6 + r["purchase_cost"])["label"],
        "best_speed": min(results, key=lambda r: r["delivery_days"] * 1e6 + r["effective_price"])["label"],
        "best_coverage": max(results, key=lambda r: r["stock_at_need_by"] * 1e3 - r["excess_units"])["label"],
        "best_balanced": balanced,
    }
