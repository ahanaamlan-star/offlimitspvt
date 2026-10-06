/** Event ledger — the only write path for business state (port of backend/app/services/ledger.py). */
import type { Customer, Item, Supplier } from "./decision";
import { apply, BusinessState, Ev, project, snapshot, STATE_EVENT_TYPES, validateEvent } from "./state";
import type { DB } from "./store";
import { commas, EngineError, g, nowIso, signed } from "./util";

export function nextId(db: DB, name: string, prefix: string, start: number, width = 0): string {
  const v = (db.counters[name] ?? start) + 1;
  db.counters[name] = v;
  return `${prefix}${width ? String(v).padStart(width, "0") : v}`;
}

export const getState = (db: DB) => project(db.events);

export class Masters {
  items: Item[]; itemsBySku: Record<string, Item>; suppliers: Record<string, Supplier>; customers: Record<string, Customer>;
  constructor(db: DB) {
    this.items = [...db.items].sort((a, b) => (a.sku < b.sku ? -1 : 1));
    this.itemsBySku = Object.fromEntries(this.items.map((i) => [i.sku, i]));
    this.suppliers = Object.fromEntries([...db.suppliers].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => [s.id, s]));
    this.customers = Object.fromEntries([...db.customers].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => [c.id, c]));
  }
  itemName = (sku?: string | null) => (sku && this.itemsBySku[sku] ? this.itemsBySku[sku].name : sku || "");
  supplierName = (id?: string | null) => (id && this.suppliers[id] ? this.suppliers[id].short_name : id || "");
  customerName = (id?: string | null) => (id && this.customers[id] ? this.customers[id].name : id || "");
}

export function describe(etype: string, p: any, m: Masters): [string, string, string | null] {
  switch (etype) {
    case "PURCHASE_RECEIVED": return [`${g(p.qty)} ${m.itemName(p.sku)} received @ ₹${g(p.unit_cost)}`, `+${g(p.qty)} ${p.sku}`, p.sku];
    case "SUPPLIER_QUOTE": return [`${m.supplierName(p.supplier_id)} quote: ${m.itemName(p.sku)} @ ₹${g(p.unit_price)}`, `quote ₹${g(p.unit_price)}`, p.sku];
    case "SUPPLIER_PRICE_UPDATE": {
      const pct = p.change_pct;
      return [`${m.itemName(p.sku)} price ₹${p.old_price ?? "None"} → ₹${g(p.new_price)}` + (pct !== null && pct !== undefined ? ` (${signed(pct)}%)` : ""),
        pct !== null && pct !== undefined ? `${signed(pct)}%` : `₹${g(p.new_price)}`, p.sku];
    }
    case "CUSTOMER_ORDER": return [`${p.items.map((i: any) => `${g(i.qty)} ${m.itemName(i.sku)}`).join(" + ")} reserved`,
      p.items.map((i: any) => `+${g(i.qty)} reserved ${i.sku}`).join(", "), p.customer_id];
    case "ORDER_FULFILLED": return [`Order ${p.order_id} fulfilled`, "stock out, receivable up", p.order_id];
    case "SALE": return [`${g(p.qty)} ${m.itemName(p.sku)} sold @ ₹${g(p.unit_price)}`, `-${g(p.qty)} ${p.sku}`, p.sku];
    case "PAYMENT_RECEIVED": return [`₹${commas(p.amount)} received from ${m.customerName(p.customer_id)}`, `+₹${commas(p.amount)} cash`, p.customer_id];
    case "PAYMENT_MADE": return [`₹${commas(p.amount)} paid to ${m.supplierName(p.supplier_id)}`, `-₹${commas(p.amount)} cash`, p.supplier_id];
    case "DAMAGED_STOCK": return [`${g(p.qty)} ${m.itemName(p.sku)} written off (damaged)`, `-${g(p.qty)} ${p.sku}`, p.sku];
    case "PURCHASE_ORDER_CREATED": return [`Purchase Order ${p.po_id} generated`, `+${g(p.qty)} incoming ${p.sku}`, p.sku];
    case "OPENING_STOCK": return [`Opening stock: ${g(p.qty)} ${m.itemName(p.sku)}`, `+${g(p.qty)} ${p.sku}`, p.sku];
    case "OPENING_CASH": return ["Opening cash balance", `₹${commas(p.amount)}`, "cash"];
    case "OPENING_RECEIVABLE": return [`Opening receivable: ${m.customerName(p.customer_id)}`, `₹${commas(p.amount)}`, p.customer_id];
    case "OPENING_PAYABLE": return [`Opening payable: ${m.supplierName(p.supplier_id)}`, `₹${commas(p.amount)}`, p.supplier_id];
    case "EVENT_REVERSED": return [`Event ${p.reverses} reversed`, "correction", p.reverses];
  }
  return [etype.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), "", null];
}

export interface AppendOpts {
  category?: string; source_type?: string; source_ref?: string | null; actor?: string; title?: string; change?: string; entity?: string | null;
  confidence?: number | null; reason?: string | null; artifact_id?: string | null; approval_id?: string | null; caused_by?: string | null;
  dedupe_key?: string | null; ts?: string; is_demo?: boolean; state?: BusinessState; masters?: Masters;
}

export function appendEvent(db: DB, etype: string, payload: any, o: AppendOpts = {}): Ev {
  if (o.dedupe_key && db.events.some((e) => e.dedupe_key === o.dedupe_key))
    throw new EngineError(`Duplicate event: this input was already recorded (${o.dedupe_key}).`, 409);
  const m = o.masters || new Masters(db);
  const st = o.state || getState(db);
  if (etype === "CUSTOMER_ORDER") {
    payload = { ...payload, items: (payload.items || []).map((i: any) => ({ ...i, unit_price: i.unit_price || (m.itemsBySku[i.sku] ? m.itemsBySku[i.sku].selling_price : null) })) };
  }
  let prev = {}, next = {};
  const ts = o.ts || nowIso();
  let auto: [string, string, string | null];
  if (STATE_EVENT_TYPES.has(etype)) {
    const errors = validateEvent(st, etype, payload, new Set(Object.keys(m.itemsBySku)), new Set(Object.keys(m.suppliers)), new Set(Object.keys(m.customers)));
    if (errors.length) throw new EngineError(errors);
    auto = describe(etype, payload, m);
    prev = snapshot(st, etype, payload);
    apply(st, etype, payload, ts);
    next = snapshot(st, etype, payload);
  } else auto = describe(etype, payload, m);
  db.seq += 1;
  const ev: Ev = {
    seq: db.seq, id: nextId(db, "event", "EVT-", 1000), ts, category: o.category || "EVENT", type: etype, source_type: o.source_type || "system",
    source_ref: o.source_ref ?? null, actor: o.actor || "system", entity: o.entity ?? auto[2], title: o.title || auto[0],
    change: o.change !== undefined ? o.change : auto[1], payload, confidence: o.confidence ?? null, status: "CONFIRMED", reason: o.reason ?? null,
    prev_state: prev, new_state: next, artifact_id: o.artifact_id ?? null, approval_id: o.approval_id ?? null, caused_by: o.caused_by ?? null,
    dedupe_key: o.dedupe_key ?? null, is_demo: o.is_demo ?? true,
  };
  db.events.push(ev);
  applyRecords(db, ev);
  return ev;
}

function applyRecords(db: DB, ev: Ev) {
  const p = ev.payload;
  if (ev.type === "CUSTOMER_ORDER") {
    if (!db.orders.some((o) => o.id === p.order_id))
      db.orders.push({ id: p.order_id, customer_id: p.customer_id, items: p.items, value: Math.round(p.items.reduce((s: number, i: any) => s + i.qty * i.unit_price, 0) * 100) / 100,
        due: p.due || "", status: "OPEN", created_event_id: ev.id, fulfilled_event_id: null, created_at: ev.ts });
  } else if (ev.type === "ORDER_FULFILLED") {
    const o = db.orders.find((x) => x.id === p.order_id);
    if (o) { o.status = "FULFILLED"; o.fulfilled_event_id = ev.id; }
  } else if (ev.type === "PURCHASE_RECEIVED" && p.po_id) {
    const po = db.purchase_orders.find((x) => x.id === p.po_id);
    if (po) { po.status = "RECEIVED"; po.received_event_id = ev.id; }
  } else if (ev.type === "EVENT_REVERSED") {
    const t = db.events.find((e) => e.id === p.reverses);
    if (t) t.status = "REVERSED";
  }
}
