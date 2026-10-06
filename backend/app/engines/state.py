"""Business-state projection and deterministic business maths.

State is never stored directly. ``project()`` replays the confirmed event ledger
(oldest first) and returns the live business state. Every number shown in the UI
comes from here or from the decision engine, never from the language model.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable

# --------------------------------------------------------------------------
# Pure business functions (unit-tested in tests/test_business_logic.py)
# --------------------------------------------------------------------------


def available_stock(on_hand: float, reserved: float) -> float:
    return on_hand - reserved


def projected_stock(available: float, incoming: float, forecast_demand: float) -> float:
    return available + incoming - forecast_demand


def margin(selling_price: float, unit_cost: float) -> float:
    return round(selling_price - unit_cost, 2)


def margin_percentage(selling_price: float, unit_cost: float) -> float:
    if selling_price <= 0:
        return 0.0
    return round((selling_price - unit_cost) / selling_price * 100, 1)


def working_capital_impact(purchase_cost: float, credit_days: int, expected_cash_effect: float = 0.0) -> dict:
    """Cash needed now vs. amount deferred to payables, plus any extra expected effect."""
    cash_now = 0.0 if credit_days > 0 else purchase_cost
    deferred = purchase_cost if credit_days > 0 else 0.0
    return {
        "purchase_cost": round(purchase_cost, 2),
        "cash_outflow_now": round(cash_now + expected_cash_effect, 2),
        "deferred_payable": round(deferred, 2),
        "credit_days": credit_days,
        "total_impact": round(purchase_cost + expected_cash_effect, 2),
    }


def weighted_moving_average(values: list[float]) -> float:
    """Recent days weigh more: weights 1..n (oldest → newest)."""
    if not values:
        return 0.0
    weights = list(range(1, len(values) + 1))
    return sum(v * w for v, w in zip(values, weights)) / sum(weights)


def forecast_daily_demand(daily_sales: list[float], fallback: float) -> float:
    """Simple, explainable forecast: weighted moving average of the last 7 days."""
    recent = daily_sales[-7:]
    if len(recent) < 3:
        return round(fallback, 2)
    return round(weighted_moving_average(recent), 2)


def stockout_assessment(on_hand: float, reserved: float, incoming: float, daily_demand: float,
                        horizon_days: float, reorder_point: float) -> dict:
    """Deterministic stockout risk for one SKU over the planning horizon."""
    available = available_stock(on_hand, reserved)
    forecast = round(daily_demand * horizon_days, 2)
    projected = projected_stock(available, incoming, forecast)
    shortfall = max(0.0, -projected)
    days_to_stockout = None if daily_demand <= 0 else round(max(available, 0) / daily_demand, 1)
    if available + incoming < 0:
        level = "CRITICAL"  # committed orders exceed stock on hand plus everything already ordered
    elif shortfall > 0:
        level = "HIGH"
    elif projected < reorder_point:
        level = "MEDIUM"
    else:
        level = "LOW"
    return {
        "on_hand": on_hand, "reserved": reserved, "available": available, "incoming": incoming,
        "forecast_demand": forecast, "projected": projected, "shortfall": shortfall,
        "days_to_stockout": days_to_stockout, "level": level,
    }


# --------------------------------------------------------------------------
# Projection
# --------------------------------------------------------------------------

STATE_EVENT_TYPES = {
    "OPENING_STOCK", "OPENING_CASH", "OPENING_RECEIVABLE", "OPENING_PAYABLE", "SUPPLIER_QUOTE",
    "PURCHASE_RECEIVED", "SUPPLIER_PRICE_UPDATE", "CUSTOMER_ORDER", "ORDER_FULFILLED", "SALE",
    "PAYMENT_RECEIVED", "PAYMENT_MADE", "DAMAGED_STOCK", "PURCHASE_ORDER_CREATED", "EVENT_REVERSED",
}


@dataclass
class StockLine:
    on_hand: float = 0
    reserved: float = 0
    incoming: float = 0
    last_cost: float | None = None
    prev_cost: float | None = None


@dataclass
class BusinessState:
    inventory: dict[str, StockLine] = field(default_factory=lambda: defaultdict(StockLine))
    cash: float = 0.0
    receivables: dict[str, float] = field(default_factory=lambda: defaultdict(float))
    payables: dict[str, float] = field(default_factory=lambda: defaultdict(float))
    offers: dict[str, dict] = field(default_factory=dict)          # "SUP|SKU" -> quote terms
    quotes: list[dict] = field(default_factory=list)                # quote history
    price_changes: list[dict] = field(default_factory=list)         # supplier price updates
    invoice_prices: list[dict] = field(default_factory=list)        # invoice price history
    orders: dict[str, dict] = field(default_factory=dict)
    purchase_orders: dict[str, dict] = field(default_factory=dict)
    daily_sales: dict[str, dict[str, float]] = field(default_factory=lambda: defaultdict(lambda: defaultdict(float)))
    cash_flow: list[dict] = field(default_factory=list)
    stock_flow: list[dict] = field(default_factory=list)
    event_count: int = 0

    def line(self, sku: str) -> StockLine:
        return self.inventory[sku]


def as_utc(ts: datetime) -> datetime:
    """SQLite drops tzinfo; treat naive timestamps as UTC."""
    return ts.replace(tzinfo=timezone.utc) if ts.tzinfo is None else ts


def _ts(e: Any) -> datetime:
    return as_utc(e["ts"] if isinstance(e, dict) else e.ts)


def _get(e: Any, key: str):
    return e[key] if isinstance(e, dict) else getattr(e, key)


def apply(state: BusinessState, etype: str, p: dict, ts: datetime, event_id: str = "") -> None:
    """Apply one event to the state in place."""
    day = ts.date().isoformat()
    if etype == "OPENING_STOCK":
        ln = state.line(p["sku"])
        ln.on_hand += p["qty"]
        ln.last_cost = p.get("unit_cost", ln.last_cost)
    elif etype == "OPENING_CASH":
        state.cash += p["amount"]
        state.cash_flow.append({"ts": ts, "delta": p["amount"], "reason": "Opening balance", "event": event_id})
    elif etype == "OPENING_RECEIVABLE":
        state.receivables[p["customer_id"]] += p["amount"]
    elif etype == "OPENING_PAYABLE":
        state.payables[p["supplier_id"]] += p["amount"]
    elif etype == "SUPPLIER_QUOTE":
        key = f'{p["supplier_id"]}|{p["sku"]}'
        prev = state.offers.get(key, {})
        state.offers[key] = {**prev, **{k: p[k] for k in ("supplier_id", "sku", "unit_price", "moq", "delivery_days", "credit_days") if k in p},
                             "quoted_at": ts, "source_event": event_id}
        state.quotes.append({"supplier_id": p["supplier_id"], "sku": p["sku"], "unit_price": p["unit_price"], "ts": ts, "event": event_id})
    elif etype == "SUPPLIER_PRICE_UPDATE":
        key = f'{p["supplier_id"]}|{p["sku"]}'
        state.price_changes.append({"supplier_id": p["supplier_id"], "sku": p["sku"], "old_price": p.get("old_price"),
                                    "new_price": p["new_price"], "change_pct": p.get("change_pct"), "ts": ts, "event": event_id})
        if key in state.offers:
            state.offers[key] = {**state.offers[key], "unit_price": p["new_price"], "quoted_at": ts, "source_event": event_id}
        else:
            state.offers[key] = {"supplier_id": p["supplier_id"], "sku": p["sku"], "unit_price": p["new_price"],
                                 "moq": p.get("moq", 1), "delivery_days": p.get("delivery_days", 2),
                                 "credit_days": p.get("credit_days", 0), "quoted_at": ts, "source_event": event_id}
    elif etype == "PURCHASE_RECEIVED":
        ln = state.line(p["sku"])
        ln.on_hand += p["qty"]
        if ln.last_cost is not None and ln.last_cost != p["unit_cost"]:
            ln.prev_cost = ln.last_cost
        ln.last_cost = p["unit_cost"]
        amount = p["qty"] * p["unit_cost"]
        if p.get("po_id"):
            ln.incoming = max(0, ln.incoming - p["qty"])
            if p["po_id"] in state.purchase_orders:
                po = state.purchase_orders[p["po_id"]]
                po["status"] = "RECEIVED"
                po["received_qty"] = (po.get("received_qty") or 0) + p["qty"]
                ln.incoming = max(0, ln.incoming - (po["qty"] - p["qty"]))  # close the PO fully
        if p.get("credit_days", 0) > 0:
            state.payables[p["supplier_id"]] += amount
        else:
            state.cash -= amount
            state.cash_flow.append({"ts": ts, "delta": -amount, "reason": f'Purchase {p["sku"]}', "event": event_id})
        state.invoice_prices.append({"supplier_id": p["supplier_id"], "sku": p["sku"], "unit_price": p["unit_cost"], "ts": ts, "event": event_id})
        state.stock_flow.append({"ts": ts, "sku": p["sku"], "delta": p["qty"]})
    elif etype == "CUSTOMER_ORDER":
        for it in p["items"]:
            state.line(it["sku"]).reserved += it["qty"]
        state.orders[p["order_id"]] = {"customer_id": p["customer_id"], "items": p["items"], "status": "OPEN",
                                       "due": p.get("due", ""), "ts": ts}
    elif etype == "ORDER_FULFILLED":
        order = state.orders.get(p["order_id"])
        if order and order["status"] == "OPEN":
            value = 0.0
            for it in order["items"]:
                ln = state.line(it["sku"])
                ln.on_hand -= it["qty"]
                ln.reserved -= it["qty"]
                value += it["qty"] * it.get("unit_price", 0)
                state.daily_sales[it["sku"]][day] += it["qty"]
                state.stock_flow.append({"ts": ts, "sku": it["sku"], "delta": -it["qty"]})
            order["status"] = "FULFILLED"
            state.receivables[order["customer_id"]] += value
    elif etype == "SALE":
        ln = state.line(p["sku"])
        ln.on_hand -= p["qty"]
        state.cash += p["qty"] * p["unit_price"]
        state.daily_sales[p["sku"]][day] += p["qty"]
        state.cash_flow.append({"ts": ts, "delta": p["qty"] * p["unit_price"], "reason": f'Sale {p["sku"]}', "event": event_id})
        state.stock_flow.append({"ts": ts, "sku": p["sku"], "delta": -p["qty"]})
    elif etype == "PAYMENT_RECEIVED":
        state.receivables[p["customer_id"]] -= p["amount"]
        state.cash += p["amount"]
        state.cash_flow.append({"ts": ts, "delta": p["amount"], "reason": f'Payment from {p["customer_id"]}', "event": event_id})
    elif etype == "PAYMENT_MADE":
        state.payables[p["supplier_id"]] -= p["amount"]
        state.cash -= p["amount"]
        state.cash_flow.append({"ts": ts, "delta": -p["amount"], "reason": f'Payment to {p["supplier_id"]}', "event": event_id})
    elif etype == "DAMAGED_STOCK":
        state.line(p["sku"]).on_hand -= p["qty"]
        state.stock_flow.append({"ts": ts, "sku": p["sku"], "delta": -p["qty"]})
    elif etype == "PURCHASE_ORDER_CREATED":
        state.line(p["sku"]).incoming += p["qty"]
        state.purchase_orders[p["po_id"]] = {**p, "status": "APPROVED", "ts": ts}
    state.event_count += 1


def project(events: Iterable[Any]) -> BusinessState:
    events = sorted(list(events), key=lambda e: (_ts(e), _get(e, "seq") if not isinstance(e, dict) else e.get("seq", 0)))
    reversed_ids = {(_get(e, "payload") or {}).get("reverses") for e in events if _get(e, "type") == "EVENT_REVERSED"}
    state = BusinessState()
    for e in events:
        if _get(e, "id") in reversed_ids or _get(e, "type") not in STATE_EVENT_TYPES:
            continue
        apply(state, _get(e, "type"), _get(e, "payload") or {}, _ts(e), _get(e, "id"))
    return state


def validate_event(state: BusinessState, etype: str, p: dict, known_skus: set[str], known_suppliers: set[str],
                   known_customers: set[str]) -> list[str]:
    """Rules that must hold before an event may enter the ledger."""
    errors: list[str] = []

    def need_sku(key="sku"):
        sku = p.get(key)
        if not sku:
            errors.append("Missing SKU")
        elif sku not in known_skus:
            errors.append(f"Unknown SKU {sku}")

    def need_qty(key="qty"):
        q = p.get(key)
        if not isinstance(q, (int, float)) or q <= 0 or int(q) != q:
            errors.append(f"Invalid quantity: {q!r} (must be a positive whole number)")

    def need_price(key):
        v = p.get(key)
        if not isinstance(v, (int, float)) or v <= 0:
            errors.append(f"Invalid price/amount: {v!r} (must be greater than 0)")

    def need_supplier():
        s = p.get("supplier_id")
        if not s:
            errors.append("Missing supplier")
        elif s not in known_suppliers:
            errors.append(f"Unknown supplier {s}")

    def need_customer():
        c = p.get("customer_id")
        if not c:
            errors.append("Missing customer")
        elif c not in known_customers:
            errors.append(f"Unknown customer {c}")

    if etype == "PURCHASE_RECEIVED":
        need_sku(); need_qty(); need_price("unit_cost"); need_supplier()
    elif etype in ("SUPPLIER_QUOTE",):
        need_sku(); need_price("unit_price"); need_supplier()
        if p.get("moq") is not None and (not isinstance(p["moq"], (int, float)) or p["moq"] < 1):
            errors.append("MOQ must be at least 1")
    elif etype == "SUPPLIER_PRICE_UPDATE":
        need_sku(); need_price("new_price"); need_supplier()
    elif etype == "CUSTOMER_ORDER":
        need_customer()
        if not p.get("items"):
            errors.append("Order has no items")
        for it in p.get("items", []):
            if it.get("sku") not in known_skus:
                errors.append(f"Unknown SKU {it.get('sku')}")
            q = it.get("qty")
            if not isinstance(q, (int, float)) or q <= 0 or int(q) != q:
                errors.append(f"Invalid quantity for {it.get('sku')}: {q!r}")
    elif etype == "ORDER_FULFILLED":
        order = state.orders.get(p.get("order_id", ""))
        if not order:
            errors.append(f"Unknown order {p.get('order_id')}")
        elif order["status"] != "OPEN":
            errors.append(f"Order {p.get('order_id')} is already {order['status']}")
        else:
            for it in order["items"]:
                if state.line(it["sku"]).on_hand - it["qty"] < 0:
                    errors.append(f"Not enough {it['sku']} on hand to fulfil (would make inventory negative)")
    elif etype in ("SALE", "DAMAGED_STOCK"):
        need_sku(); need_qty()
        if etype == "SALE":
            need_price("unit_price")
        if not errors and state.line(p["sku"]).on_hand - p["qty"] < 0:
            errors.append(f"Negative inventory: only {state.line(p['sku']).on_hand:g} {p['sku']} on hand")
    elif etype == "PAYMENT_RECEIVED":
        need_customer(); need_price("amount")
    elif etype == "PAYMENT_MADE":
        need_supplier(); need_price("amount")
    elif etype == "PURCHASE_ORDER_CREATED":
        need_sku(); need_qty(); need_price("unit_price"); need_supplier()
    return errors


def snapshot(state: BusinessState, etype: str, p: dict) -> dict:
    """The slice of state an event touches (stored as prev/new on the ledger row)."""
    snap: dict[str, Any] = {}
    skus = set()
    if p.get("sku"):
        skus.add(p["sku"])
    for it in p.get("items", []) or []:
        skus.add(it["sku"])
    if etype == "ORDER_FULFILLED" and p.get("order_id") in state.orders:
        skus |= {it["sku"] for it in state.orders[p["order_id"]]["items"]}
    for sku in sorted(skus):
        ln = state.inventory.get(sku, StockLine())
        snap[f"{sku}.on_hand"] = ln.on_hand
        snap[f"{sku}.reserved"] = ln.reserved
        snap[f"{sku}.incoming"] = ln.incoming
        if ln.last_cost is not None:
            snap[f"{sku}.unit_cost"] = ln.last_cost
    if etype in ("SALE", "PAYMENT_RECEIVED", "PAYMENT_MADE", "PURCHASE_RECEIVED", "OPENING_CASH"):
        snap["cash"] = round(state.cash, 2)
    if p.get("customer_id"):
        snap[f'receivable.{p["customer_id"]}'] = round(state.receivables.get(p["customer_id"], 0), 2)
    if p.get("supplier_id") and etype in ("PURCHASE_RECEIVED", "PAYMENT_MADE", "PURCHASE_ORDER_CREATED"):
        snap[f'payable.{p["supplier_id"]}'] = round(state.payables.get(p["supplier_id"], 0), 2)
    if p.get("supplier_id") and p.get("sku") and etype in ("SUPPLIER_QUOTE", "SUPPLIER_PRICE_UPDATE"):
        offer = state.offers.get(f'{p["supplier_id"]}|{p["sku"]}')
        snap["supplier_price"] = offer["unit_price"] if offer else None
    return snap
