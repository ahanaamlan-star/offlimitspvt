/** Read models (port of backend/app/services/views.py). Same JSON shapes as the FastAPI backend. */
import { detectRisks, itemDemand } from "./decision";
import { getState, Masters } from "./ledger";
import { Ev, margin, marginPercentage, project } from "./state";
import type { ApprovalRec, Artifact, DB, PO, Proposal, Rec, ScenarioRec } from "./store";
import { D, pyRound } from "./util";
import { currentRisks, riskConfig } from "./workflow";

export function eventDict(e: Ev, m?: Masters) {
  let entityName: string | null = e.entity;
  if (m && e.entity) {
    if (m.itemsBySku[e.entity]) entityName = m.itemName(e.entity);
    else if (m.customers[e.entity]) entityName = m.customerName(e.entity);
    else if (m.suppliers[e.entity]) entityName = m.supplierName(e.entity);
  }
  const { dedupe_key, ...rest } = e;
  return { ...rest, entity_name: entityName };
}

export function artifactDict(a: Artifact) {
  return { ...a, file_url: a.has_file ? `/api/inputs/${a.id}/file` : null };
}

export function proposalDict(p: Proposal, m: Masters) {
  const pl: any = p.payload || {};
  const names: any = {};
  if (pl.sku) names.sku = m.itemName(pl.sku);
  if (pl.supplier_id) names.supplier = m.suppliers[pl.supplier_id] ? m.suppliers[pl.supplier_id].name : pl.supplier_id;
  if (pl.customer_id) names.customer = m.customerName(pl.customer_id);
  if (pl.items) names.items = pl.items.map((i: any) => m.itemName(i.sku));
  return { ...p, payload: pl, names };
}

export function recDict(r: Rec, m: Masters) {
  const sup = m.suppliers[r.supplier_id];
  return { ...r, item: m.itemName(r.sku), supplier: sup ? sup.short_name : r.supplier_id, supplier_name: sup ? sup.name : r.supplier_id };
}

export function poDict(po: PO, m: Masters) {
  const sup = m.suppliers[po.supplier_id];
  return { ...po, supplier: sup ? sup.short_name : po.supplier_id, supplier_name: sup ? sup.name : po.supplier_id, item: m.itemName(po.sku) };
}

export const approvalDict = (a: ApprovalRec) => ({ ...a });
export const scenarioDict = (s: ScenarioRec) => ({ ...s });

export function inventoryRows(db: DB, state = getState(db), m = new Masters(db), risks?: any[]) {
  const cfg = riskConfig(db);
  risks = risks ?? currentRisks(db, state, m);
  const riskBySku: Record<string, string> = {};
  for (const r of risks) if (r.sku && (r.type === "STOCKOUT" || r.type === "LOW_STOCK")) riskBySku[r.sku] = r.severity;
  return m.items.map((it) => {
    const ln = state.get(it.sku);
    const onHand = ln?.on_hand ?? 0, reserved = ln?.reserved ?? 0, incoming = ln?.incoming ?? 0;
    const cost = ln?.last_cost ?? null;
    const daily = itemDemand(state, it);
    return {
      sku: it.sku, name: it.name, category: it.category, unit: it.unit, on_hand: onHand, reserved, available: onHand - reserved, incoming,
      reorder_point: it.reorder_point, forecast_daily: daily, projected: pyRound(onHand - reserved + incoming - daily * cfg.horizon_days, 1),
      risk: riskBySku[it.sku] || "LOW", unit_cost: cost, selling_price: it.selling_price,
      margin: cost ? margin(it.selling_price, cost) : null, margin_pct: cost ? marginPercentage(it.selling_price, cost) : null,
      value: pyRound(onHand * (cost || 0), 2),
    };
  });
}

export function businessState(db: DB) {
  const m = new Masters(db);
  const events = db.events;
  const state = project(events);
  const risks = currentRisks(db, state, m);
  const inv = inventoryRows(db, state, m, risks);
  const risky = new Set(risks.filter((r) => r.type === "STOCKOUT").map((r) => r.sku));
  const orders = [...db.orders].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const orderRows = orders.map((o) => ({
    id: o.id, customer_id: o.customer_id, customer: m.customerName(o.customer_id), items: o.items.map((i: any) => ({ ...i, name: m.itemName(i.sku) })),
    value: o.value, due: o.due, status: o.status, risk: o.status === "OPEN" && o.items.some((i: any) => risky.has(i.sku)) ? "AT RISK" : "OK",
    created_at: o.created_at, created_event_id: o.created_event_id,
  }));
  const opening = events.filter((e) => e.type === "OPENING_CASH" && e.status !== "REVERSED").reduce((s, e) => s + e.payload.amount, 0);
  const inflow = state.cash_flow.filter((c) => c.delta > 0 && c.reason !== "Opening balance").reduce((s, c) => s + c.delta, 0);
  const outflow = -state.cash_flow.filter((c) => c.delta < 0).reduce((s, c) => s + c.delta, 0);
  const margins: any[] = [];
  for (const it of m.items) {
    const ln = state.get(it.sku);
    if (!ln || ln.last_cost === null) continue;
    margins.push({ sku: it.sku, name: it.name, selling_price: it.selling_price, cost: ln.last_cost, previous_cost: ln.prev_cost,
      margin: margin(it.selling_price, ln.last_cost), margin_pct: marginPercentage(it.selling_price, ln.last_cost),
      previous_margin_pct: ln.prev_cost ? marginPercentage(it.selling_price, ln.prev_cost) : null,
      anomaly: risks.some((r) => r.type === "MARGIN_ANOMALY" && r.sku === it.sku) });
  }
  const prices = Object.keys(state.offers).sort().map((k) => {
    const o = state.offers[k];
    const sup = m.suppliers[o.supplier_id];
    return { supplier_id: o.supplier_id, supplier: sup ? sup.short_name : o.supplier_id, supplier_name: sup ? sup.name : o.supplier_id, sku: o.sku,
      item: m.itemName(o.sku), unit_price: o.unit_price, moq: o.moq ?? null, delivery_days: o.delivery_days ?? null, credit_days: o.credit_days ?? null,
      quoted_at: o.quoted_at ?? null, source_event: o.source_event ?? null };
  });
  const suppliers = Object.values(m.suppliers).map((s) => ({ id: s.id, short_name: s.short_name, name: s.name, reliability: pyRound(s.reliability * 100), city: s.city,
    offers: prices.filter((p) => p.supplier_id === s.id).length, payable: pyRound(state.payables[s.id] || 0, 2) }));
  const invValue = pyRound(inv.filter((r) => r.on_hand > 0).reduce((s, r) => s + r.value, 0), 2);
  const totalRev = inv.filter((r) => r.unit_cost && r.on_hand > 0).reduce((s, r) => s + r.selling_price * r.on_hand, 0);
  const lastTs = events.reduce<string | null>((mx, e) => (!mx || e.ts > mx ? e.ts : mx), null);
  const summary = {
    inventory_value: invValue, inventory_units: pyRound(inv.reduce((s, r) => s + r.on_hand, 0)), skus: inv.length, cash: pyRound(state.cash, 2),
    open_orders: orderRows.filter((o) => o.status === "OPEN").length,
    open_order_value: pyRound(orderRows.filter((o) => o.status === "OPEN").reduce((s, o) => s + o.value, 0), 2),
    stockout_risks: risks.filter((r) => r.type === "STOCKOUT").length, low_stock: risks.filter((r) => r.type === "LOW_STOCK").length,
    margin_alerts: risks.filter((r) => ["MARGIN_ANOMALY", "PRICE_CHANGE", "QUOTE_INVOICE_MISMATCH"].includes(r.type)).length,
    pending_approvals: db.recommendations.filter((r) => r.status === "PENDING").length,
    needs_review: db.proposals.filter((p) => p.status === "NEEDS_REVIEW").length,
    receivables: pyRound(Object.values(state.receivables).filter((v) => v > 0).reduce((a, b) => a + b, 0), 2),
    payables: pyRound(Object.values(state.payables).filter((v) => v > 0).reduce((a, b) => a + b, 0), 2),
    weighted_margin_pct: totalRev ? pyRound(((totalRev - invValue) / totalRev) * 100, 1) : 0, events: events.length, last_event_at: lastTs,
  };
  return {
    summary, inventory: inv, orders: orderRows,
    cash: { opening: pyRound(opening, 2), inflow: pyRound(inflow, 2), outflow: pyRound(outflow, 2), current: pyRound(state.cash, 2),
      receivables: Object.entries(state.receivables).filter(([, v]) => Math.abs(v) > 0.001).map(([k, v]) => ({ customer_id: k, customer: m.customerName(k), amount: pyRound(v, 2) })),
      payables: Object.entries(state.payables).filter(([, v]) => Math.abs(v) > 0.001).map(([k, v]) => ({ supplier_id: k, supplier: m.supplierName(k), amount: pyRound(v, 2) })) },
    prices, margins, suppliers,
    purchase_orders: Object.entries(state.purchase_orders).map(([k, v]: [string, any]) => ({ id: k, status: v.status, sku: v.sku, qty: v.qty })),
  };
}

const fmt0 = (x: number) => Math.round(x).toLocaleString("en-US");
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function analytics(db: DB) {
  const m = new Masters(db);
  const events = db.events;
  const cfg = riskConfig(db);
  const now = Date.now();
  const days: string[] = [];
  for (let d = 7; d >= 0; d--) days.push(new Date(now - d * D).toISOString().slice(0, 10));
  const focus = ["SKU-1042", "SKU-1020", "SKU-1010", "SKU-1021"];
  const supNames = Object.fromEntries(Object.values(m.suppliers).map((s) => [s.id, s.short_name]));
  const custNames = Object.fromEntries(Object.values(m.customers).map((c) => [c.id, c.name]));
  const series = days.map((d) => {
    const end = `${d}T23:59:59.999999Z`;
    const evs = events.filter((e) => e.ts <= end);
    const st = project(evs);
    const risks = detectRisks(st, m.items, supNames, custNames, cfg);
    const dayEvs = evs.filter((e) => e.ts.slice(0, 10) === d && e.status !== "REVERSED");
    const sum = (f: (e: Ev) => number, pred: (e: Ev) => boolean) => dayEvs.filter(pred).reduce((s, e) => s + f(e), 0);
    const purchases = sum((e) => e.payload.qty * e.payload.unit_cost, (e) => e.type === "PURCHASE_RECEIVED");
    const inflow = sum((e) => e.payload.qty * e.payload.unit_price, (e) => e.type === "SALE") + sum((e) => e.payload.amount, (e) => e.type === "PAYMENT_RECEIVED");
    const outflow = sum((e) => e.payload.amount, (e) => e.type === "PAYMENT_MADE") +
      sum((e) => e.payload.qty * e.payload.unit_cost, (e) => e.type === "PURCHASE_RECEIVED" && !e.payload.credit_days);
    const lines = Object.values(st.inventory);
    const dt = new Date(`${d}T00:00:00Z`);
    const row: any = {
      date: d, label: `${DOW[dt.getUTCDay()]} ${d.slice(8, 10)}`,
      inventory_units: pyRound(lines.reduce((s, l) => s + l.on_hand, 0)), inventory_value: pyRound(lines.reduce((s, l) => s + l.on_hand * (l.last_cost || 0), 0)),
      cash: pyRound(st.cash), inflow: pyRound(inflow), outflow: pyRound(outflow), purchase_cost: pyRound(purchases),
      stockout_risks: risks.filter((r) => r.type === "STOCKOUT").length, low_stock: risks.filter((r) => r.type === "LOW_STOCK").length,
    };
    for (const sku of focus) {
      const ln = st.get(sku);
      const it = m.itemsBySku[sku];
      row[`margin_${sku}`] = ln && ln.last_cost && it ? marginPercentage(it.selling_price, ln.last_cost) : null;
      row[`stock_${sku}`] = ln ? ln.on_hand : 0;
    }
    return row;
  });
  const st = project(events);
  const cokeOffers = Object.values(st.offers).filter((o: any) => o.sku === "SKU-1042")
    .map((o: any) => ({ supplier: m.supplierName(o.supplier_id), price: o.unit_price, moq: o.moq ?? null, delivery_days: o.delivery_days ?? null, credit_days: o.credit_days ?? null }))
    .sort((a, b) => a.price - b.price);
  const last = series[series.length - 1], first = series[0];
  const insights = {
    inventory: `Stock on hand moved from ${fmt0(first.inventory_units)} to ${fmt0(last.inventory_units)} units over 8 days; ${last.stockout_risks} SKU(s) are predicted to run short.`,
    stockout: "Stockout risk is computed from stock on hand, reserved orders, incoming POs and forecast demand — act on spikes before committed orders fail.",
    purchases: `₹${fmt0(series.reduce((s, r) => s + r.purchase_cost, 0))} of stock was received in this period.`,
    margin: "Margins fall when supplier costs rise and selling prices do not — compare suppliers or re-price affected SKUs.",
    supplier_prices: cokeOffers.length ? `For Coca-Cola, the cheapest quote is ${cokeOffers[0].supplier} at ₹${cokeOffers[0].price}, but MOQ, delivery and credit decide the best buy.` : "",
    cash: `Cash moved from ₹${fmt0(first.cash)} to ₹${fmt0(last.cash)}; credit purchases defer outflows to payables.`,
  };
  return { series, focus: focus.map((s) => ({ sku: s, name: m.itemName(s) })), coke_offers: cokeOffers, insights, is_demo: true };
}

export function trace(db: DB, ev: Ev) {
  const m = new Masters(db);
  const byId = Object.fromEntries(db.events.map((e) => [e.id, e]));
  const up: any[] = [];
  const seen = new Set<string>();
  let cur: Ev | undefined = ev;
  while (cur && cur.caused_by && !seen.has(cur.caused_by)) {
    seen.add(cur.caused_by);
    cur = byId[cur.caused_by];
    if (cur) up.push(eventDict(cur, m));
  }
  const down = db.events.filter((e) => e.caused_by === ev.id).map((e) => eventDict(e, m));
  return { upstream: up.reverse(), downstream: down };
}
