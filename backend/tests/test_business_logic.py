"""Pure deterministic business functions."""
from datetime import datetime, timezone

from app.engines.action import compare_scenarios, compare_suppliers, simulate
from app.engines.state import (BusinessState, apply, available_stock, forecast_daily_demand, margin, margin_percentage,
                               project, projected_stock, stockout_assessment, validate_event, working_capital_impact)

T = datetime(2026, 10, 1, tzinfo=timezone.utc)


def test_formulas():
    assert available_stock(11, 6) == 5
    assert projected_stock(5, 0, 18) == -13
    assert margin(45, 38) == 7
    assert margin_percentage(45, 38) == 15.6
    wc = working_capital_impact(780, 15)
    assert wc["cash_outflow_now"] == 0 and wc["deferred_payable"] == 780
    assert working_capital_impact(1850, 0)["cash_outflow_now"] == 1850


def test_forecast_weights_recent_days():
    assert forecast_daily_demand([1, 1, 1, 1, 1, 1, 10], 5) > forecast_daily_demand([10, 1, 1, 1, 1, 1, 1], 5)
    assert forecast_daily_demand([4], 6) == 6  # not enough history → fallback


def test_stockout_levels():
    assert stockout_assessment(40, 45, 0, 6, 1, 12)["level"] == "CRITICAL"
    a = stockout_assessment(40, 45, 0, 6, 1, 12)
    assert a["shortfall"] == 11
    assert stockout_assessment(40, 45, 20, 6, 1, 12)["level"] in ("MEDIUM", "LOW")
    assert stockout_assessment(100, 0, 0, 6, 1, 12)["level"] == "LOW"


def _state_with_offers():
    st = BusinessState()
    apply(st, "OPENING_STOCK", {"sku": "X", "qty": 40, "unit_cost": 35}, T)
    apply(st, "CUSTOMER_ORDER", {"order_id": "O1", "customer_id": "C", "items": [{"sku": "X", "qty": 45, "unit_price": 45}]}, T)
    for sup, price, moq, dd, cd in [("A", 36, 100, 2, 0), ("B", 39, 20, 0, 15), ("C", 37, 50, 1, 0)]:
        apply(st, "SUPPLIER_QUOTE", {"supplier_id": sup, "sku": "X", "unit_price": price, "moq": moq, "delivery_days": dd,
                                     "credit_days": cd}, T)
    return st


def test_supplier_comparison_is_not_just_cheapest():
    st = _state_with_offers()
    res = compare_suppliers(st, "X", need_qty=11, target_max=53, needed_by_days=1, suppliers={})
    assert res["recommended"] == "B"           # cheapest (A) arrives too late and has MOQ 100
    a = next(o for o in res["options"] if o["supplier_id"] == "A")
    assert not a["on_time"] and a["excess_units"] == 47


def test_simulation_flags_excess_and_capital_lock():
    st = _state_with_offers()

    class Item:
        sku, selling_price = "X", 45
    r100 = simulate(st, Item, 6, {"qty": 100, "unit_price": 36, "discount_pct": 15, "delivery_days": 0})
    r55 = simulate(st, Item, 6, {"qty": 55, "unit_price": 39, "delivery_days": 0, "credit_days": 15})
    assert r100["purchase_savings"] == 540 and r100["excess_units"] > 0 and r100["capital_locked_in_excess"] > 0
    assert r55["stockout_risk"] == "LOW" and r55["cash_outflow_now"] == 0
    assert compare_scenarios([r100, r55])["best_label"] == r55["label"]


def test_validation_rules():
    st = _state_with_offers()
    skus, sups, custs = {"X"}, {"A", "B"}, {"C"}
    assert validate_event(st, "SALE", {"sku": "X", "qty": 100, "unit_price": 45}, skus, sups, custs)  # negative inventory
    assert validate_event(st, "SALE", {"sku": "X", "qty": -1, "unit_price": 45}, skus, sups, custs)
    assert validate_event(st, "PURCHASE_RECEIVED", {"sku": "X", "qty": 5, "unit_cost": 0, "supplier_id": "A"}, skus, sups, custs)
    assert validate_event(st, "PURCHASE_RECEIVED", {"sku": "X", "qty": 5, "unit_cost": 30, "supplier_id": None}, skus, sups, custs)
    assert validate_event(st, "PURCHASE_RECEIVED", {"sku": "Y", "qty": 5, "unit_cost": 30, "supplier_id": "A"}, skus, sups, custs)
    assert not validate_event(st, "PURCHASE_RECEIVED", {"sku": "X", "qty": 5, "unit_cost": 30, "supplier_id": "A"}, skus, sups, custs)


def test_state_is_derived_from_events_and_reversal():
    evs = [
        {"id": "E1", "seq": 1, "ts": T, "type": "OPENING_STOCK", "payload": {"sku": "X", "qty": 10, "unit_cost": 5}},
        {"id": "E2", "seq": 2, "ts": T, "type": "SALE", "payload": {"sku": "X", "qty": 3, "unit_price": 8}},
        {"id": "E3", "seq": 3, "ts": T, "type": "EVENT_REVERSED", "payload": {"reverses": "E2"}},
    ]
    assert project(evs[:2]).inventory["X"].on_hand == 7
    assert project(evs).inventory["X"].on_hand == 10
