/** SEE → THINK → ACT orchestration (port of backend/app/services/workflow.py). */
import { compareScenarios, compareSuppliers, simulate } from "./action";
import { DEFAULT_RISK, detectRisks, itemDemand, RiskConfig } from "./decision";
import { appendEvent, getState, Masters, nextId } from "./ledger";
import { Catalog, EntityMatcher, ParsedEvent, Understanding } from "./parser";
import { BusinessState, project, STATE_EVENT_TYPES, validateEvent } from "./state";
import type { DB, Proposal, Rec } from "./store";
import { EngineError, g, nowIso, pyRound, signed } from "./util";

export const INTEL_TYPES = new Set(["STOCKOUT", "LOW_STOCK", "PRICE_CHANGE", "MARGIN_ANOMALY", "QUOTE_INVOICE_MISMATCH", "INVENTORY_MISMATCH", "WORKING_CAPITAL"]);
export const KIND_LABEL: Record<string, string> = {
  invoice: "Supplier invoice received", receipt: "Receipt received", quotation: "Supplier quotation received", message: "Customer message received",
  voice: "Voice note received", image: "Image received", text: "Quick entry received",
};
export const CONFIDENCE_THRESHOLD = 0.75;

export function riskConfig(db: DB): RiskConfig {
  const s = db.merchant?.settings || {};
  const cfg = { ...DEFAULT_RISK };
  for (const k of Object.keys(DEFAULT_RISK) as (keyof RiskConfig)[]) if (k in s) cfg[k] = Number(s[k]);
  return cfg;
}
export const ownerName = (db: DB) => db.merchant?.owner || "Merchant";
export const threshold = (db: DB) => Number(db.merchant?.settings?.confidence_threshold ?? CONFIDENCE_THRESHOLD);

export function catalog(m: Masters): Catalog {
  return {
    items: m.items.map((i) => ({ sku: i.sku, name: i.name, aliases: i.aliases || [], selling_price: i.selling_price })),
    suppliers: Object.values(m.suppliers).map((s) => ({ id: s.id, short_name: s.short_name, name: s.name, aliases: s.aliases || [] })),
    customers: Object.values(m.customers).map((c) => ({ id: c.id, name: c.name, aliases: c.aliases || [] })),
  };
}

const n = (v: any) => (v === null || v === undefined ? "?" : typeof v === "number" ? g(v) : String(v));
const offerOf = (state: BusinessState, sup?: string | null, sku?: string | null) => (sup && sku ? state.offers[`${sup}|${sku}`] || null : null);

// ------------------------------------------------------------------ SEE

export function buildProposals(pe: ParsedEvent, u: Understanding, m: Masters, state: BusinessState, thr: number) {
  const matcher = new EntityMatcher(catalog(m));
  const reasons: string[] = pe.note ? [pe.note] : [];
  const candidates: any[] = [];
  const conf = pe.confidence;
  const out: [string, any, string][] = [];
  const resolveSupplier = () => {
    const [sid, c] = matcher.supplier(pe.supplier_text || u.supplier_text);
    if (c.length) { reasons.push(`${c.length} possible suppliers — which one?`); candidates.push(...c.map((x) => ({ field: "supplier_id", ...x }))); }
    else if (!sid) reasons.push("Supplier not identified");
    return sid;
  };
  const resolveCustomer = () => {
    const [cid, c] = matcher.customer(pe.customer_text);
    if (c.length) { reasons.push(`${c.length} possible matches — ${c.map((x) => x.name).join(" / ")}. Which customer?`); candidates.push(...c.map((x) => ({ field: "customer_id", ...x }))); }
    else if (!cid) reasons.push("Customer not identified");
    return cid;
  };
  const first: any = pe.items[0] || {};
  if (pe.type === "PURCHASE_RECEIVED") {
    const sid = resolveSupplier();
    const sku = first.sku;
    const offer = offerOf(state, sid, sku);
    const payload: any = { supplier_id: sid, sku, qty: first.qty ?? null, unit_cost: first.unit_price ?? null, invoice_no: u.document_no,
      credit_days: pe.credit_days ?? (offer ? offer.credit_days ?? 0 : 0) };
    let summary = `${first.product}: ${n(first.qty)} units @ ₹${n(first.unit_price)}`;
    const openPo = Object.values(state.purchase_orders).find((po: any) => po.status === "APPROVED" && po.supplier_id === sid && po.sku === sku) as any;
    if (openPo) {
      payload.po_id = openPo.po_id;
      payload.credit_days = openPo.credit_days ?? payload.credit_days;
      summary += ` · matches ${openPo.po_id}`;
      if (first.qty && first.qty !== openPo.qty) reasons.push(`Quantity ${g(first.qty)} differs from ${openPo.po_id} (${openPo.qty})`);
    }
    out.push(["PURCHASE_RECEIVED", payload, summary]);
    if (offer && first.unit_price && Math.abs(offer.unit_price - first.unit_price) > 0.001) {
      const old = offer.unit_price, nw = first.unit_price;
      const pct = pyRound(((nw - old) / old) * 100, 1);
      out.unshift(["SUPPLIER_PRICE_UPDATE", { supplier_id: sid, sku, old_price: old, new_price: nw, change_pct: pct, invoice_no: u.document_no },
        `${m.itemName(sku)}: ₹${g(old)} → ₹${g(nw)} (${signed(pct)}%)`]);
    }
  } else if (pe.type === "SUPPLIER_QUOTE") {
    const sid = resolveSupplier();
    const sku = first.sku;
    const offer = offerOf(state, sid, sku) || {};
    const payload = { supplier_id: sid, sku, unit_price: first.unit_price ?? null,
      moq: pe.moq || offer.moq || (first.qty ? Math.trunc(first.qty) : 1),
      delivery_days: pe.delivery_days ?? offer.delivery_days ?? 2, credit_days: pe.credit_days ?? offer.credit_days ?? 0, quoted_qty: first.qty ?? null };
    out.push(["SUPPLIER_QUOTE", payload, `${first.product}: ₹${n(first.unit_price)} each` + (payload.delivery_days !== null ? `, ${payload.delivery_days}-day delivery` : "")]);
  } else if (pe.type === "CUSTOMER_ORDER") {
    const cid = resolveCustomer();
    const items = pe.items.map((i) => ({ sku: i.sku ?? null, qty: i.qty ?? null }));
    const summary = pe.items.map((i) => `${i.qty || "?"} ${m.itemName(i.sku)}`).join(" + ");
    out.push(["CUSTOMER_ORDER", { customer_id: cid, items, due: pe.due ?? null }, summary + (pe.due ? ` · due ${pe.due}` : "")]);
  } else if (pe.type === "PAYMENT_RECEIVED") {
    const cid = resolveCustomer();
    out.push(["PAYMENT_RECEIVED", { customer_id: cid, amount: pe.amount ?? null, mode: "cash/UPI" }, pe.amount ? `₹${pe.amount.toLocaleString("en-US")} received` : "Payment received"]);
  } else if (pe.type === "PAYMENT_MADE") {
    const sid = resolveSupplier();
    out.push(["PAYMENT_MADE", { supplier_id: sid, amount: pe.amount ?? null }, pe.amount ? `₹${pe.amount.toLocaleString("en-US")} paid` : "Payment made"]);
  } else if (pe.type === "SALE") {
    const sku = first.sku;
    const price = first.unit_price || (sku && m.itemsBySku[sku] ? m.itemsBySku[sku].selling_price : null);
    out.push(["SALE", { sku, qty: first.qty ?? null, unit_price: price }, `${first.qty || "?"} ${m.itemName(sku)} sold`]);
  } else if (pe.type === "DAMAGED_STOCK") {
    out.push(["DAMAGED_STOCK", { sku: first.sku, qty: first.qty ?? null }, `${first.qty || "?"} ${m.itemName(first.sku)} damaged`]);
  }
  return out.map(([type, payload, summary]) => {
    const r = [...reasons];
    if (!candidates.length) {
      const errs = validateEvent(state, type, payload, new Set(Object.keys(m.itemsBySku)), new Set(Object.keys(m.suppliers)), new Set(Object.keys(m.customers)));
      for (const e of errs) if (!r.includes(e) && !e.startsWith("Missing customer") && !e.startsWith("Missing supplier")) r.push(e);
    }
    const status = candidates.length || r.length || conf < thr ? "NEEDS_REVIEW" : "PROPOSED";
    if (conf < thr) r.push(`Low confidence (${Math.round(conf * 100)}%) — below the ${Math.round(thr * 100)}% threshold`);
    const reason = Array.from(new Set(r.filter(Boolean))).join("; ") || null;
    return { type, payload, summary, confidence: pyRound(conf, 2), status, review_reason: reason, candidates };
  });
}

export function confirmProposal(db: DB, id: string, overrides: any, actor?: string | null) {
  const prp = db.proposals.find((p) => p.id === id);
  if (!prp) throw new EngineError(`Unknown proposal ${id}`, 404);
  if (prp.status === "CONFIRMED" || prp.status === "REJECTED") throw new EngineError(`Proposal ${id} is already ${prp.status.toLowerCase()}`);
  const art = db.artifacts.find((a) => a.id === prp.artifact_id)!;
  const payload = { ...prp.payload, ...(overrides || {}) };
  if (prp.candidates.length) {
    for (const f of new Set(prp.candidates.map((c: any) => c.field))) {
      const allowed = new Set([...prp.candidates.filter((c: any) => c.field === f).map((c: any) => c.id), overrides?.[f as string]]);
      if (!payload[f as string] || !allowed.has(payload[f as string])) throw new EngineError("Ambiguous entity — choose the correct match before confirming.");
    }
  }
  if (prp.type === "CUSTOMER_ORDER") payload.order_id = payload.order_id || nextId(db, "order", "ORD-", 600);
  actor = actor || ownerName(db);
  let src: string | null = art.filename || null;
  if (prp.payload.invoice_no) src = prp.payload.invoice_no;
  else if (["message", "voice", "text"].includes(art.kind)) src = ({ message: "WhatsApp", voice: "Voice note", text: "Quick entry" } as any)[art.kind] + (art.sender ? ` · ${art.sender}` : "");
  let dedupe = `${art.sha256}:${prp.type}:${JSON.stringify(Object.entries(prp.payload).sort())}`;
  if ((prp.type === "PURCHASE_RECEIVED" || prp.type === "SUPPLIER_PRICE_UPDATE") && payload.invoice_no && payload.supplier_id)
    dedupe = `INVOICE:${payload.supplier_id}:${payload.invoice_no}:${payload.sku}:${prp.type}`;
  const ev = appendEvent(db, prp.type, payload, { category: "EVENT", source_type: art.kind, source_ref: src, actor, confidence: prp.confidence,
    reason: `Confirmed by ${actor}` + (prp.status === "NEEDS_REVIEW" ? " after review" : ""), artifact_id: art.id, dedupe_key: dedupe });
  prp.status = "CONFIRMED"; prp.event_id = ev.id; prp.payload = payload;
  const effects = afterStateChange(db, ev.id);
  return { event: ev, proposal: prp, ...effects };
}

export function rejectProposal(db: DB, id: string, reason?: string | null) {
  const p = db.proposals.find((x) => x.id === id);
  if (!p) throw new EngineError(`Unknown proposal ${id}`, 404);
  if (p.status === "CONFIRMED") throw new EngineError("Already confirmed — reverse the ledger event instead.");
  p.status = "REJECTED"; p.review_reason = reason || p.review_reason;
  return p;
}
export function reviewLater(db: DB, id: string) {
  const p = db.proposals.find((x) => x.id === id);
  if (!p) throw new EngineError(`Unknown proposal ${id}`, 404);
  p.status = "NEEDS_REVIEW"; p.review_reason = p.review_reason || "Deferred for later review";
  return p;
}

// ------------------------------------------------------------------ THINK

export function currentRisks(db: DB, state?: BusinessState, m?: Masters) {
  m = m || new Masters(db);
  state = state || getState(db);
  return detectRisks(state, m.items, Object.fromEntries(Object.values(m.suppliers).map((s) => [s.id, s.short_name])),
    Object.fromEntries(Object.values(m.customers).map((c) => [c.id, c.name])), riskConfig(db));
}

function intelText(r: any, m: Masters): [string, string] {
  const mt = r.metrics;
  switch (r.type) {
    case "STOCKOUT": return ["Stock shortage predicted", `${m.itemName(r.sku)} shortage: ${mt.expected_shortage} units • Required by tomorrow`];
    case "LOW_STOCK": return ["Below reorder point", `${m.itemName(r.sku)}: projected ${g(mt.projected)} vs reorder point ${mt.reorder_point}`];
    case "PRICE_CHANGE": return ["Price anomaly detected", `${m.itemName(r.sku)} ₹${g(mt.old_price)} → ₹${g(mt.new_price)} (${signed(mt.change_pct)}%)`];
    case "MARGIN_ANOMALY": return ["Margin anomaly detected", mt.previous_margin_pct !== null && mt.previous_margin_pct !== undefined
      ? `${m.itemName(r.sku)} margin ${mt.previous_margin_pct}% → ${mt.margin_pct}%` : `${m.itemName(r.sku)} margin ${mt.margin_pct}%`];
    case "QUOTE_INVOICE_MISMATCH": return ["Quote–invoice mismatch", `${m.itemName(r.sku)} quoted ₹${g(mt.quoted_price)}, invoiced ₹${g(mt.invoiced_price)} (${signed(mt.difference_pct)}%)`];
    case "INVENTORY_MISMATCH": return ["Inventory mismatch", r.reason];
  }
  return [r.title, r.reason];
}

export function afterStateChange(db: DB, causedBy: string | null, ts?: string) {
  const m = new Masters(db);
  const state = getState(db);
  const risks = currentRisks(db, state, m);
  const intelligence = [];
  for (const r of risks) {
    if (!INTEL_TYPES.has(r.type)) continue;
    const key = `INTEL:${r.key}${r.type === "STOCKOUT" ? `:${r.metrics.expected_shortage}` : ""}`;
    if (db.events.some((e) => e.dedupe_key === key)) continue;
    const [title, change] = intelText(r, m);
    const { orders, ...risk } = r;
    intelligence.push(appendEvent(db, "RISK_DETECTED", { risk, orders: orders || [] }, { category: "INTELLIGENCE", source_type: "engine", source_ref: "Decision engine",
      actor: "OFFLIMITS", title, change, entity: r.sku || r.entity, reason: r.reason, caused_by: causedBy, dedupe_key: key, ts, masters: m, state }));
  }
  const recommendations = syncRecommendations(db, state, risks, m, causedBy, ts);
  return { intelligence, recommendations };
}

function explanation(best: any, cmp: any, risk: any, m: Masters) {
  const cheapest = cmp.options.reduce((a: any, o: any) => (o.unit_price < a.unit_price ? o : a), cmp.options[0]);
  let head = `${best.supplier} is recommended`;
  if (cheapest.supplier_id !== best.supplier_id) head += ` despite a higher unit price than ${cheapest.supplier} (₹${g(best.unit_price)} vs ₹${g(cheapest.unit_price)})`;
  const reasons: string[] = [];
  if (best.moq <= cmp.target_max) reasons.push(`its MOQ of ${best.moq} fits the need`);
  reasons.push(best.on_time ? `delivery ${best.delivery_label.toLowerCase()} arrives before the need-by date` : "");
  if (best.credit_days) reasons.push(`${best.credit_days}-day credit means no immediate cash outflow`);
  let text = `${head}: ${reasons.filter(Boolean).join(", ")}. This prevents the predicted ${m.itemName(risk.sku)} shortage of ${risk.need_qty} units`;
  if (cheapest.supplier_id !== best.supplier_id && cheapest.notes?.length) text += `. ${cheapest.supplier}: ${cheapest.notes.join("; ").toLowerCase()}`;
  return text + ".";
}

export function syncRecommendations(db: DB, state: BusinessState, risks: any[], m: Masters, causedBy: string | null, ts?: string): Rec[] {
  const cfg = riskConfig(db);
  const active = new Set<string>();
  const created: Rec[] = [];
  for (const r of risks) {
    if (r.action !== "evaluate_suppliers") continue;
    const cmp: any = compareSuppliers(state, r.sku, Math.trunc(r.need_qty), Math.trunc(r.target_max), cfg.horizon_days, m.suppliers);
    if (!cmp.options.length) continue;
    const best = cmp.options.find((o: any) => o.recommended);
    active.add(r.key);
    const reason = r.type === "STOCKOUT" ? `${r.reason} Projected shortfall ${r.need_qty} units.` : r.reason;
    const { orders, ...riskNoOrders } = r;
    const cmpStore = { ...cmp, risk: riskNoOrders };
    const fallback = explanation(best, cmp, r, m);
    const existing = db.recommendations.find((x) => x.risk_key === r.key && x.status === "PENDING");
    if (existing) {
      if (existing.qty !== best.qty || existing.supplier_id !== best.supplier_id || existing.unit_price !== best.unit_price) {
        Object.assign(existing, { supplier_id: best.supplier_id, qty: best.qty, unit_price: best.unit_price, total: best.total, explanation: fallback });
      }
      existing.comparison = cmpStore; existing.reason = reason;
      continue;
    }
    if (db.recommendations.some((x) => x.risk_key === r.key && x.status === "REJECTED" && x.qty === best.qty && x.supplier_id === best.supplier_id)) continue;
    const recId = nextId(db, "rec", "REC-", 1040);
    const tags = [best.scores.moq_fit >= 90 ? "best MOQ" : "", best.on_time ? "delivery" : "", best.credit_days ? "credit" : ""].filter(Boolean).join(", ");
    const dec = appendEvent(db, "SUPPLIERS_EVALUATED", { recommendation_id: recId, sku: r.sku, options: cmp.options.length, recommended: best.supplier_id },
      { category: "DECISION", source_type: "engine", source_ref: "Action engine", actor: "OFFLIMITS", title: "Suppliers evaluated",
        change: `${best.supplier} recommended — ${tags}`, entity: r.sku, reason: (cmp.why || [""])[0], caused_by: causedBy, ts, masters: m, state });
    const rec: Rec = { id: recId, kind: "PURCHASE", risk_key: r.key, sku: r.sku, supplier_id: best.supplier_id, qty: best.qty, unit_price: best.unit_price,
      total: best.total, reason, explanation: fallback, comparison: cmpStore, status: "PENDING", trigger_event_id: causedBy, decision_event_id: dec.id,
      po_id: null, created_at: ts || nowIso(), decided_at: null, decided_by: null };
    db.recommendations.push(rec);
    created.push(rec);
  }
  for (const rec of db.recommendations) {
    if (rec.status === "PENDING" && !active.has(rec.risk_key)) {
      rec.status = "SUPERSEDED";
      rec.reason = (rec.reason || "") + " — superseded: the risk is no longer present.";
    }
  }
  return created;
}

export function runSimulation(db: DB, sku: string, scenarios: any[], name?: string | null, question?: string | null) {
  const m = new Masters(db);
  const item = m.itemsBySku[sku];
  if (!item) throw new EngineError(`Unknown SKU ${sku}`);
  const state = getState(db);
  const daily = itemDemand(state, item);
  const results = scenarios.map((sc0) => {
    let sc = { ...sc0 };
    if (typeof sc.qty !== "number" || !(sc.qty > 0)) throw new EngineError("Each scenario needs a positive quantity");
    if (sc.supplier_id && !sc.unit_price) {
      const offer = offerOf(state, sc.supplier_id, sku);
      if (!offer) throw new EngineError(`${sc.supplier_id} has no price for ${sku}`);
      sc = { unit_price: offer.unit_price, delivery_days: offer.delivery_days, credit_days: offer.credit_days, ...sc };
      for (const k of ["unit_price", "delivery_days", "credit_days"]) if (sc[k] === undefined || sc[k] === null) sc[k] = offer[k];
    }
    if (!sc.unit_price || sc.unit_price <= 0) throw new EngineError("Each scenario needs a unit price above 0");
    if (sc.supplier_id && m.suppliers[sc.supplier_id] && !sc.label) sc.label = `${m.suppliers[sc.supplier_id].short_name} · ${Math.trunc(sc.qty)} units`;
    return simulate(state, item, daily, sc);
  });
  const seen: Record<string, number> = {};
  for (const r of results) { seen[r.label] = (seen[r.label] || 0) + 1; if (seen[r.label] > 1) r.label = `${r.label} (${seen[r.label]})`; }
  const verdict = compareScenarios(results);
  const sim = { id: nextId(db, "sim", "SIM-", 100), name: name || `What-if · ${item.name}`, question: question ?? null, inputs: { sku, scenarios },
    results: { scenarios: results, verdict, sku, item: item.name, daily_demand: daily }, created_at: nowIso() };
  db.scenarios.push(sim);
  return sim;
}

/** Same maths without saving — used for live recalculation while editing. */
export function previewSimulation(db: DB, sku: string, scenarios: any[]) {
  const copy: DB = { ...db, counters: { ...db.counters }, scenarios: [] };
  return runSimulation(copy, sku, scenarios).results;
}

// ------------------------------------------------------------------ ACT

function metrics(db: DB, state: BusinessState, sku: string) {
  const m = new Masters(db);
  const item = m.itemsBySku[sku];
  const cfg = riskConfig(db);
  const ln = state.get(sku);
  const daily = itemDemand(state, item);
  const onHand = ln?.on_hand ?? 0, reserved = ln?.reserved ?? 0, incoming = ln?.incoming ?? 0;
  const projected = onHand - reserved + incoming - daily * cfg.horizon_days;
  return { sku, on_hand: onHand, reserved, incoming, predicted_shortage: Math.max(0, pyRound(-projected)), cash: pyRound(state.cash, 2),
    payables: pyRound(Object.values(state.payables).reduce((a, b) => a + b, 0), 2) };
}

export function approveRecommendation(db: DB, recId: string, o: { actor?: string | null; supplier_id?: string | null; qty?: number | null; note?: string | null; acknowledged?: boolean }) {
  const rec = db.recommendations.find((r) => r.id === recId);
  if (!rec) throw new EngineError(`Unknown recommendation ${recId}`, 404);
  if (rec.status !== "PENDING") throw new EngineError(`Recommendation ${recId} is ${rec.status.toLowerCase()}`);
  if (!o.acknowledged) throw new EngineError("Human approval required: confirm you reviewed the recommendation and supporting evidence.");
  const actor = o.actor || ownerName(db);
  const options: Record<string, any> = Object.fromEntries((rec.comparison.options || []).map((x: any) => [x.supplier_id, x]));
  const sup = o.supplier_id || rec.supplier_id;
  if (!options[sup]) throw new EngineError(`Supplier ${sup} has no offer for ${rec.sku}`);
  const opt = options[sup];
  const q = Math.trunc(o.qty ?? (sup === rec.supplier_id ? rec.qty : opt.qty));
  if (q <= 0) throw new EngineError("Quantity must be positive");
  if (q < opt.moq) throw new EngineError(`${opt.supplier} requires a minimum order of ${opt.moq} units`);
  const before = metrics(db, getState(db), rec.sku);
  const total = pyRound(q * opt.unit_price, 2);
  const m = new Masters(db);
  const apr = { id: nextId(db, "approval", "APR-", 90, 4), recommendation_id: rec.id, actor, decision: "APPROVED", note: o.note ?? null,
    snapshot: { supplier_id: sup, qty: q, unit_price: opt.unit_price, total, before }, ts: nowIso() };
  db.approvals.push(apr);
  const aprEv = appendEvent(db, "PROCUREMENT_APPROVED", { recommendation_id: rec.id, approval_id: apr.id, supplier_id: sup, qty: q }, { category: "APPROVAL",
    source_type: "user", source_ref: rec.id, actor, title: "Merchant approved procurement", change: `${actor} • ${m.supplierName(sup)}, ${q} units`, entity: rec.sku,
    reason: o.note || "Reviewed recommendation and supporting evidence", approval_id: apr.id, caused_by: rec.decision_event_id, masters: m });
  const poId = nextId(db, "po", "OFF-2026-", 90, 3);
  const payload = { po_id: poId, supplier_id: sup, sku: rec.sku, qty: q, unit_price: opt.unit_price, total, credit_days: opt.credit_days,
    delivery_days: opt.delivery_days, recommendation_id: rec.id, approval_id: apr.id };
  const poEv = appendEvent(db, "PURCHASE_ORDER_CREATED", payload, { category: "ACTION", source_type: "user", source_ref: rec.id, actor,
    change: `${m.supplierName(sup)} • ${q} ${m.itemName(rec.sku)} @ ₹${g(opt.unit_price)} • ₹${total.toLocaleString("en-US", { maximumFractionDigits: 0 })}` + (opt.credit_days ? ` • ${opt.credit_days}-day credit` : ""),
    reason: `Approved by ${actor} (${apr.id})`, approval_id: apr.id, caused_by: aprEv.id, masters: m });
  const po = { id: poId, supplier_id: sup, sku: rec.sku, qty: q, unit_price: opt.unit_price, total, credit_days: opt.credit_days, delivery_days: opt.delivery_days,
    status: "APPROVED", recommendation_id: rec.id, approval_id: apr.id, approved_by: actor, event_id: poEv.id, received_event_id: null, created_at: nowIso() };
  db.purchase_orders.push(po);
  Object.assign(rec, { status: "APPROVED", po_id: poId, decided_at: nowIso(), decided_by: actor });
  if (sup !== rec.supplier_id || q !== rec.qty) Object.assign(rec, { supplier_id: sup, qty: q, unit_price: opt.unit_price, total });
  const effects = afterStateChange(db, poEv.id);
  const after = metrics(db, getState(db), rec.sku);
  return { purchase_order: po, approval: apr, events: [aprEv, poEv], before, after, ...effects };
}

export function rejectRecommendation(db: DB, recId: string, actor?: string | null, reason?: string | null) {
  const rec = db.recommendations.find((r) => r.id === recId);
  if (!rec) throw new EngineError(`Unknown recommendation ${recId}`, 404);
  if (rec.status !== "PENDING") throw new EngineError(`Recommendation ${recId} is ${rec.status.toLowerCase()}`);
  actor = actor || ownerName(db);
  const apr = { id: nextId(db, "approval", "APR-", 90, 4), recommendation_id: rec.id, actor, decision: "REJECTED", note: reason ?? null, snapshot: {}, ts: nowIso() };
  db.approvals.push(apr);
  appendEvent(db, "RECOMMENDATION_REJECTED", { recommendation_id: rec.id, approval_id: apr.id }, { category: "APPROVAL", source_type: "user", source_ref: rec.id,
    actor, title: "Recommendation rejected", change: `${actor} • ${rec.id}`, entity: rec.sku, reason: reason || "Rejected by merchant", approval_id: apr.id, caused_by: rec.decision_event_id });
  Object.assign(rec, { status: "REJECTED", decided_at: nowIso(), decided_by: actor });
  return rec;
}

export function createPurchaseOrder(db: DB, b: { sku: string; supplier_id: string; qty: number; actor?: string; acknowledged?: boolean; note?: string }) {
  if (!b.acknowledged) throw new EngineError("Human approval required: set acknowledged=true to confirm this purchase.");
  const m = new Masters(db);
  const state = getState(db);
  const offer = offerOf(state, b.supplier_id, b.sku);
  if (!m.suppliers[b.supplier_id]) throw new EngineError(`Unknown supplier ${b.supplier_id}`);
  if (!offer) throw new EngineError(`${b.supplier_id} has no price for ${b.sku}`);
  if (b.qty < (offer.moq || 1)) throw new EngineError(`Minimum order for this supplier is ${offer.moq} units`);
  const actor = b.actor || ownerName(db);
  const apr = { id: nextId(db, "approval", "APR-", 90, 4), recommendation_id: null, actor, decision: "APPROVED", note: b.note ?? null, snapshot: {}, ts: nowIso() };
  db.approvals.push(apr);
  const total = pyRound(b.qty * offer.unit_price, 2);
  const poId = nextId(db, "po", "OFF-2026-", 90, 3);
  const ev = appendEvent(db, "PURCHASE_ORDER_CREATED", { po_id: poId, supplier_id: b.supplier_id, sku: b.sku, qty: b.qty, unit_price: offer.unit_price, total,
    credit_days: offer.credit_days || 0, delivery_days: offer.delivery_days || 0, approval_id: apr.id },
    { category: "ACTION", source_type: "user", actor, reason: `Manual purchase approved by ${actor}`, approval_id: apr.id, masters: m });
  const po = { id: poId, supplier_id: b.supplier_id, sku: b.sku, qty: b.qty, unit_price: offer.unit_price, total, credit_days: offer.credit_days || 0,
    delivery_days: offer.delivery_days || 0, status: "APPROVED", recommendation_id: null, approval_id: apr.id, approved_by: actor, event_id: ev.id, received_event_id: null, created_at: nowIso() };
  db.purchase_orders.push(po);
  afterStateChange(db, ev.id);
  return { purchase_order: po, approval: apr };
}

export function receivePurchaseOrder(db: DB, poId: string, qty?: number | null, actor?: string | null) {
  const po = db.purchase_orders.find((p) => p.id === poId);
  if (!po) throw new EngineError(`Unknown purchase order ${poId}`, 404);
  if (po.status === "RECEIVED") throw new EngineError(`${poId} was already received`);
  const q = Math.trunc(qty || po.qty);
  const ev = appendEvent(db, "PURCHASE_RECEIVED", { po_id: po.id, supplier_id: po.supplier_id, sku: po.sku, qty: q, unit_cost: po.unit_price, credit_days: po.credit_days },
    { category: "EVENT", source_type: "delivery", source_ref: po.id, actor: actor || ownerName(db), reason: `Goods received against ${po.id}`, caused_by: po.event_id });
  afterStateChange(db, ev.id);
  return { event: ev, purchase_order: po };
}

export function fulfilOrder(db: DB, orderId: string, actor?: string | null) {
  const ev = appendEvent(db, "ORDER_FULFILLED", { order_id: orderId }, { category: "EVENT", source_type: "user", source_ref: orderId, actor: actor || ownerName(db), reason: "Order delivered to customer" });
  afterStateChange(db, ev.id);
  return { event: ev };
}

export function reverseEvent(db: DB, eventId: string, actor?: string | null, reason?: string | null) {
  const target = db.events.find((e) => e.id === eventId);
  if (!target) throw new EngineError(`Unknown event ${eventId}`, 404);
  if (!STATE_EVENT_TYPES.has(target.type) || target.type === "EVENT_REVERSED" || target.category === "OPENING")
    throw new EngineError("Only confirmed business events (not opening balances or system notes) can be reversed.");
  if (target.status === "REVERSED") throw new EngineError(`${eventId} is already reversed`);
  if (target.type === "PURCHASE_ORDER_CREATED") throw new EngineError("Purchase orders cannot be reversed from the ledger in this prototype.");
  const trial = project(db.events.filter((e) => e.id !== eventId));
  const neg = Object.entries(trial.inventory).filter(([, l]) => l.on_hand < 0).map(([s]) => s);
  if (neg.length) throw new EngineError(`Reversal would make inventory negative for ${neg.join(", ")}`);
  const ev = appendEvent(db, "EVENT_REVERSED", { reverses: eventId }, { category: "CORRECTION", source_type: "user", source_ref: eventId, actor: actor || ownerName(db), reason: reason || "Correction", caused_by: eventId });
  afterStateChange(db, ev.id);
  return { event: ev };
}

export type { Proposal };
