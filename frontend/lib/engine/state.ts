/**
 * Business-state projection and deterministic business maths (port of backend/app/engines/state.py).
 * State is never stored: project() replays the confirmed event ledger.
 */
import { dayKey, g, isNum, pyRound } from "./util";

export interface Ev {
  seq: number; id: string; ts: string; category: string; type: string; source_type: string; source_ref: string | null;
  actor: string; entity: string | null; title: string; change: string; payload: Record<string, any>; confidence: number | null;
  status: string; reason: string | null; prev_state: Record<string, any>; new_state: Record<string, any>;
  artifact_id: string | null; approval_id: string | null; caused_by: string | null; dedupe_key: string | null; is_demo: boolean;
}

export const availableStock = (onHand: number, reserved: number) => onHand - reserved;
export const projectedStock = (available: number, incoming: number, forecast: number) => available + incoming - forecast;
export const margin = (sell: number, cost: number) => pyRound(sell - cost, 2);
export const marginPercentage = (sell: number, cost: number) => (sell <= 0 ? 0 : pyRound(((sell - cost) / sell) * 100, 1));

export function workingCapitalImpact(purchaseCost: number, creditDays: number, expected = 0) {
  const cashNow = creditDays > 0 ? 0 : purchaseCost;
  const deferred = creditDays > 0 ? purchaseCost : 0;
  return {
    purchase_cost: pyRound(purchaseCost, 2), cash_outflow_now: pyRound(cashNow + expected, 2),
    deferred_payable: pyRound(deferred, 2), credit_days: creditDays, total_impact: pyRound(purchaseCost + expected, 2),
  };
}

export function weightedMovingAverage(values: number[]): number {
  if (!values.length) return 0;
  let num = 0, den = 0;
  values.forEach((v, i) => { num += v * (i + 1); den += i + 1; });
  return num / den;
}

export function forecastDailyDemand(dailySales: number[], fallback: number): number {
  const recent = dailySales.slice(-7);
  if (recent.length < 3) return pyRound(fallback, 2);
  return pyRound(weightedMovingAverage(recent), 2);
}

export function stockoutAssessment(onHand: number, reserved: number, incoming: number, daily: number, horizon: number, reorderPoint: number) {
  const available = availableStock(onHand, reserved);
  const forecast = pyRound(daily * horizon, 2);
  const projected = projectedStock(available, incoming, forecast);
  const shortfall = Math.max(0, -projected);
  const daysToStockout = daily <= 0 ? null : pyRound(Math.max(available, 0) / daily, 1);
  let level: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  if (available + incoming < 0) level = "CRITICAL";
  else if (shortfall > 0) level = "HIGH";
  else if (projected < reorderPoint) level = "MEDIUM";
  else level = "LOW";
  return { on_hand: onHand, reserved, available, incoming, forecast_demand: forecast, projected, shortfall, days_to_stockout: daysToStockout, level };
}

export const STATE_EVENT_TYPES = new Set([
  "OPENING_STOCK", "OPENING_CASH", "OPENING_RECEIVABLE", "OPENING_PAYABLE", "SUPPLIER_QUOTE", "PURCHASE_RECEIVED",
  "SUPPLIER_PRICE_UPDATE", "CUSTOMER_ORDER", "ORDER_FULFILLED", "SALE", "PAYMENT_RECEIVED", "PAYMENT_MADE", "DAMAGED_STOCK",
  "PURCHASE_ORDER_CREATED", "EVENT_REVERSED",
]);

export interface StockLine { on_hand: number; reserved: number; incoming: number; last_cost: number | null; prev_cost: number | null }

export class BusinessState {
  inventory: Record<string, StockLine> = {};
  cash = 0;
  receivables: Record<string, number> = {};
  payables: Record<string, number> = {};
  offers: Record<string, any> = {};
  quotes: any[] = [];
  price_changes: any[] = [];
  invoice_prices: any[] = [];
  orders: Record<string, any> = {};
  purchase_orders: Record<string, any> = {};
  daily_sales: Record<string, Record<string, number>> = {};
  cash_flow: any[] = [];
  stock_flow: any[] = [];
  event_count = 0;

  line(sku: string): StockLine {
    if (!this.inventory[sku]) this.inventory[sku] = { on_hand: 0, reserved: 0, incoming: 0, last_cost: null, prev_cost: null };
    return this.inventory[sku];
  }
  get(sku: string): StockLine | undefined { return this.inventory[sku]; }
  addSale(sku: string, day: string, q: number) {
    this.daily_sales[sku] = this.daily_sales[sku] || {};
    this.daily_sales[sku][day] = (this.daily_sales[sku][day] || 0) + q;
  }
}

const inc = (o: Record<string, number>, k: string, v: number) => { o[k] = (o[k] || 0) + v; };

export function apply(state: BusinessState, etype: string, p: any, ts: string, eventId = ""): void {
  const day = dayKey(ts);
  switch (etype) {
    case "OPENING_STOCK": { const ln = state.line(p.sku); ln.on_hand += p.qty; ln.last_cost = p.unit_cost ?? ln.last_cost; break; }
    case "OPENING_CASH": state.cash += p.amount; state.cash_flow.push({ ts, delta: p.amount, reason: "Opening balance", event: eventId }); break;
    case "OPENING_RECEIVABLE": inc(state.receivables, p.customer_id, p.amount); break;
    case "OPENING_PAYABLE": inc(state.payables, p.supplier_id, p.amount); break;
    case "SUPPLIER_QUOTE": {
      const key = `${p.supplier_id}|${p.sku}`;
      const prev = state.offers[key] || {};
      const pick: any = {};
      for (const k of ["supplier_id", "sku", "unit_price", "moq", "delivery_days", "credit_days"]) if (k in p && p[k] !== undefined) pick[k] = p[k];
      state.offers[key] = { ...prev, ...pick, quoted_at: ts, source_event: eventId };
      state.quotes.push({ supplier_id: p.supplier_id, sku: p.sku, unit_price: p.unit_price, ts, event: eventId });
      break;
    }
    case "SUPPLIER_PRICE_UPDATE": {
      const key = `${p.supplier_id}|${p.sku}`;
      state.price_changes.push({ supplier_id: p.supplier_id, sku: p.sku, old_price: p.old_price ?? null, new_price: p.new_price, change_pct: p.change_pct ?? null, ts, event: eventId });
      if (state.offers[key]) state.offers[key] = { ...state.offers[key], unit_price: p.new_price, quoted_at: ts, source_event: eventId };
      else state.offers[key] = { supplier_id: p.supplier_id, sku: p.sku, unit_price: p.new_price, moq: p.moq ?? 1, delivery_days: p.delivery_days ?? 2, credit_days: p.credit_days ?? 0, quoted_at: ts, source_event: eventId };
      break;
    }
    case "PURCHASE_RECEIVED": {
      const ln = state.line(p.sku);
      ln.on_hand += p.qty;
      if (ln.last_cost !== null && ln.last_cost !== p.unit_cost) ln.prev_cost = ln.last_cost;
      ln.last_cost = p.unit_cost;
      const amount = p.qty * p.unit_cost;
      if (p.po_id) {
        ln.incoming = Math.max(0, ln.incoming - p.qty);
        const po = state.purchase_orders[p.po_id];
        if (po) {
          po.status = "RECEIVED";
          po.received_qty = (po.received_qty || 0) + p.qty;
          ln.incoming = Math.max(0, ln.incoming - (po.qty - p.qty));
        }
      }
      if ((p.credit_days || 0) > 0) inc(state.payables, p.supplier_id, amount);
      else { state.cash -= amount; state.cash_flow.push({ ts, delta: -amount, reason: `Purchase ${p.sku}`, event: eventId }); }
      state.invoice_prices.push({ supplier_id: p.supplier_id, sku: p.sku, unit_price: p.unit_cost, ts, event: eventId });
      state.stock_flow.push({ ts, sku: p.sku, delta: p.qty });
      break;
    }
    case "CUSTOMER_ORDER":
      for (const it of p.items) state.line(it.sku).reserved += it.qty;
      state.orders[p.order_id] = { customer_id: p.customer_id, items: p.items, status: "OPEN", due: p.due ?? "", ts };
      break;
    case "ORDER_FULFILLED": {
      const order = state.orders[p.order_id];
      if (order && order.status === "OPEN") {
        let value = 0;
        for (const it of order.items) {
          const ln = state.line(it.sku);
          ln.on_hand -= it.qty; ln.reserved -= it.qty;
          value += it.qty * (it.unit_price || 0);
          state.addSale(it.sku, day, it.qty);
          state.stock_flow.push({ ts, sku: it.sku, delta: -it.qty });
        }
        order.status = "FULFILLED";
        inc(state.receivables, order.customer_id, value);
      }
      break;
    }
    case "SALE": {
      state.line(p.sku).on_hand -= p.qty;
      state.cash += p.qty * p.unit_price;
      state.addSale(p.sku, day, p.qty);
      state.cash_flow.push({ ts, delta: p.qty * p.unit_price, reason: `Sale ${p.sku}`, event: eventId });
      state.stock_flow.push({ ts, sku: p.sku, delta: -p.qty });
      break;
    }
    case "PAYMENT_RECEIVED":
      inc(state.receivables, p.customer_id, -p.amount); state.cash += p.amount;
      state.cash_flow.push({ ts, delta: p.amount, reason: `Payment from ${p.customer_id}`, event: eventId });
      break;
    case "PAYMENT_MADE":
      inc(state.payables, p.supplier_id, -p.amount); state.cash -= p.amount;
      state.cash_flow.push({ ts, delta: -p.amount, reason: `Payment to ${p.supplier_id}`, event: eventId });
      break;
    case "DAMAGED_STOCK":
      state.line(p.sku).on_hand -= p.qty; state.stock_flow.push({ ts, sku: p.sku, delta: -p.qty }); break;
    case "PURCHASE_ORDER_CREATED":
      state.line(p.sku).incoming += p.qty;
      state.purchase_orders[p.po_id] = { ...p, status: "APPROVED", ts };
      break;
  }
  state.event_count += 1;
}

export function sortEvents<T extends { ts: string; seq: number }>(events: T[]): T[] {
  return [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));
}

export function project(events: Ev[]): BusinessState {
  const evs = sortEvents(events);
  const reversed = new Set(evs.filter((e) => e.type === "EVENT_REVERSED").map((e) => e.payload?.reverses));
  const state = new BusinessState();
  for (const e of evs) {
    if (reversed.has(e.id) || !STATE_EVENT_TYPES.has(e.type)) continue;
    apply(state, e.type, e.payload || {}, e.ts, e.id);
  }
  return state;
}

const isWhole = (q: any) => isNum(q) && q > 0 && Math.floor(q) === q;
const repr = (v: any) => (v === null || v === undefined ? "None" : typeof v === "string" ? `'${v}'` : String(v));

export function validateEvent(state: BusinessState, etype: string, p: any, skus: Set<string>, sups: Set<string>, custs: Set<string>): string[] {
  const errors: string[] = [];
  const needSku = () => { if (!p.sku) errors.push("Missing SKU"); else if (!skus.has(p.sku)) errors.push(`Unknown SKU ${p.sku}`); };
  const needQty = () => { if (!isWhole(p.qty)) errors.push(`Invalid quantity: ${repr(p.qty)} (must be a positive whole number)`); };
  const needPrice = (k: string) => { if (!isNum(p[k]) || p[k] <= 0) errors.push(`Invalid price/amount: ${repr(p[k])} (must be greater than 0)`); };
  const needSupplier = () => { if (!p.supplier_id) errors.push("Missing supplier"); else if (!sups.has(p.supplier_id)) errors.push(`Unknown supplier ${p.supplier_id}`); };
  const needCustomer = () => { if (!p.customer_id) errors.push("Missing customer"); else if (!custs.has(p.customer_id)) errors.push(`Unknown customer ${p.customer_id}`); };

  if (etype === "PURCHASE_RECEIVED") { needSku(); needQty(); needPrice("unit_cost"); needSupplier(); }
  else if (etype === "SUPPLIER_QUOTE") {
    needSku(); needPrice("unit_price"); needSupplier();
    if (p.moq !== null && p.moq !== undefined && (!isNum(p.moq) || p.moq < 1)) errors.push("MOQ must be at least 1");
  } else if (etype === "SUPPLIER_PRICE_UPDATE") { needSku(); needPrice("new_price"); needSupplier(); }
  else if (etype === "CUSTOMER_ORDER") {
    needCustomer();
    if (!p.items || !p.items.length) errors.push("Order has no items");
    for (const it of p.items || []) {
      if (!skus.has(it.sku)) errors.push(`Unknown SKU ${it.sku ?? "None"}`);
      if (!isWhole(it.qty)) errors.push(`Invalid quantity for ${it.sku ?? "None"}: ${repr(it.qty)}`);
    }
  } else if (etype === "ORDER_FULFILLED") {
    const order = state.orders[p.order_id || ""];
    if (!order) errors.push(`Unknown order ${p.order_id ?? "None"}`);
    else if (order.status !== "OPEN") errors.push(`Order ${p.order_id} is already ${order.status}`);
    else for (const it of order.items) if (state.line(it.sku).on_hand - it.qty < 0) errors.push(`Not enough ${it.sku} on hand to fulfil (would make inventory negative)`);
  } else if (etype === "SALE" || etype === "DAMAGED_STOCK") {
    needSku(); needQty();
    if (etype === "SALE") needPrice("unit_price");
    if (!errors.length && state.line(p.sku).on_hand - p.qty < 0) errors.push(`Negative inventory: only ${g(state.line(p.sku).on_hand)} ${p.sku} on hand`);
  } else if (etype === "PAYMENT_RECEIVED") { needCustomer(); needPrice("amount"); }
  else if (etype === "PAYMENT_MADE") { needSupplier(); needPrice("amount"); }
  else if (etype === "PURCHASE_ORDER_CREATED") { needSku(); needQty(); needPrice("unit_price"); needSupplier(); }
  return errors;
}

export function snapshot(state: BusinessState, etype: string, p: any): Record<string, any> {
  const snap: Record<string, any> = {};
  const skus = new Set<string>();
  if (p.sku) skus.add(p.sku);
  for (const it of p.items || []) skus.add(it.sku);
  if (etype === "ORDER_FULFILLED" && state.orders[p.order_id]) for (const it of state.orders[p.order_id].items) skus.add(it.sku);
  for (const sku of Array.from(skus).sort()) {
    const ln = state.get(sku) || { on_hand: 0, reserved: 0, incoming: 0, last_cost: null };
    snap[`${sku}.on_hand`] = ln.on_hand;
    snap[`${sku}.reserved`] = ln.reserved;
    snap[`${sku}.incoming`] = ln.incoming;
    if (ln.last_cost !== null) snap[`${sku}.unit_cost`] = ln.last_cost;
  }
  if (["SALE", "PAYMENT_RECEIVED", "PAYMENT_MADE", "PURCHASE_RECEIVED", "OPENING_CASH"].includes(etype)) snap.cash = pyRound(state.cash, 2);
  if (p.customer_id) snap[`receivable.${p.customer_id}`] = pyRound(state.receivables[p.customer_id] || 0, 2);
  if (p.supplier_id && ["PURCHASE_RECEIVED", "PAYMENT_MADE", "PURCHASE_ORDER_CREATED"].includes(etype)) snap[`payable.${p.supplier_id}`] = pyRound(state.payables[p.supplier_id] || 0, 2);
  if (p.supplier_id && p.sku && ["SUPPLIER_QUOTE", "SUPPLIER_PRICE_UPDATE"].includes(etype)) {
    const offer = state.offers[`${p.supplier_id}|${p.sku}`];
    snap.supplier_price = offer ? offer.unit_price : null;
  }
  return snap;
}
