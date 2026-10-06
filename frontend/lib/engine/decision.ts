/** Decision Intelligence Engine (port of backend/app/engines/decision.py). Deterministic rules only. */
import { BusinessState, forecastDailyDemand, marginPercentage, stockoutAssessment } from "./state";
import { commas, g, pyRound, signed } from "./util";

export interface Item { sku: string; name: string; category: string; unit: string; selling_price: number; reorder_point: number; daily_demand: number; aliases: string[] }
export interface Supplier { id: string; short_name: string; name: string; reliability: number; city: string; aliases: string[] }
export interface Customer { id: string; name: string; kind: string; aliases: string[] }

export interface RiskConfig {
  horizon_days: number; cover_days: number; min_margin_pct: number; margin_drop_pp: number; price_change_pct: number;
  mismatch_pct: number; min_cash_buffer: number; receivable_alert: number;
}
export const DEFAULT_RISK: RiskConfig = { horizon_days: 1, cover_days: 7, min_margin_pct: 10, margin_drop_pp: 3, price_change_pct: 5, mismatch_pct: 2, min_cash_buffer: 10000, receivable_alert: 5000 };
const SEV: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export function itemDemand(state: BusinessState, item: Item): number {
  const days = Object.entries(state.daily_sales[item.sku] || {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return forecastDailyDemand(days.map(([, v]) => v), item.daily_demand);
}

export function stockView(state: BusinessState, item: Item, cfg: RiskConfig) {
  const ln = state.get(item.sku);
  const daily = itemDemand(state, item);
  const a = stockoutAssessment(ln?.on_hand ?? 0, ln?.reserved ?? 0, ln?.incoming ?? 0, daily, cfg.horizon_days, item.reorder_point);
  return { ...a, daily_demand: daily, unit_cost: ln?.last_cost ?? null };
}

export function detectRisks(state: BusinessState, items: Item[], suppliers: Record<string, string>, customers: Record<string, string>, cfg: RiskConfig = DEFAULT_RISK): any[] {
  const risks: any[] = [];
  const bySku: Record<string, Item> = Object.fromEntries(items.map((i) => [i.sku, i]));

  for (const item of items) {
    const v = stockView(state, item, cfg);
    const affected = Object.entries(state.orders).filter(([, o]) => o.status === "OPEN" && o.items.some((it: any) => it.sku === item.sku)).map(([id]) => id);
    if (v.level === "CRITICAL" || v.level === "HIGH") {
      const shortfall = Math.trunc(pyRound(v.shortfall));
      const high = Math.trunc(5 * pyRound((shortfall + v.daily_demand * cfg.cover_days) / 5));
      const reason = v.available < 0 ? `Committed orders (${g(v.reserved)}) exceed stock on hand (${g(v.on_hand)}).`
        : `Forecast demand (${g(v.forecast_demand)}) exceeds available stock (${g(v.available)}).`;
      risks.push({
        key: `STOCKOUT:${item.sku}`, type: "STOCKOUT", category: "Inventory", severity: v.level, sku: item.sku, entity: item.name,
        title: "Stock Shortage Predicted",
        metrics: { current_stock: v.on_hand, reserved: v.reserved, available: v.available, incoming: v.incoming, forecast_demand: v.forecast_demand,
          expected_shortage: shortfall, required_by: "Tomorrow", recommended_purchase: `${shortfall}–${Math.max(high, shortfall)} units` },
        reason, orders: affected, recommendation: "Replenish inventory before tomorrow morning.", action: "evaluate_suppliers",
        need_qty: Math.max(shortfall, 1), target_max: Math.max(high, shortfall),
      });
    } else if (v.level === "MEDIUM") {
      const need = Math.trunc(pyRound(item.reorder_point + v.daily_demand * 3 - v.projected));
      risks.push({
        key: `LOW_STOCK:${item.sku}`, type: "LOW_STOCK", category: "Inventory", severity: "MEDIUM", sku: item.sku, entity: item.name,
        title: "Below Reorder Point",
        metrics: { current_stock: v.on_hand, reserved: v.reserved, available: v.available, projected: v.projected, reorder_point: item.reorder_point, days_to_stockout: v.days_to_stockout },
        reason: `Projected stock (${g(v.projected)}) is below the reorder point (${item.reorder_point}).`, orders: affected,
        recommendation: "Plan a replenishment order in the next few days.", action: "evaluate_suppliers", need_qty: Math.max(need, 1),
        target_max: Math.max(need, Math.trunc(item.reorder_point + v.daily_demand * cfg.cover_days - v.projected)),
      });
    }
  }

  const latest: Record<string, any> = {};
  for (const ch of state.price_changes) latest[`${ch.supplier_id}|${ch.sku}`] = ch;
  for (const ch of Object.values(latest)) {
    let pct = ch.change_pct;
    if ((pct === null || pct === undefined) && ch.old_price) pct = pyRound(((ch.new_price - ch.old_price) / ch.old_price) * 100, 1);
    if (pct !== null && pct !== undefined && Math.abs(pct) >= cfg.price_change_pct && bySku[ch.sku]) {
      const sup = suppliers[ch.supplier_id] ?? ch.supplier_id;
      risks.push({
        key: `PRICE_CHANGE:${ch.supplier_id}:${ch.sku}:${ch.new_price}`, type: "PRICE_CHANGE", category: "Suppliers", severity: "MEDIUM", sku: ch.sku,
        entity: bySku[ch.sku].name, title: "Supplier Price Change",
        metrics: { supplier: sup, old_price: ch.old_price, new_price: ch.new_price, change_pct: pct },
        reason: `${sup} changed ${bySku[ch.sku].name} from ₹${ch.old_price} to ₹${ch.new_price} (${signed(pct)}%).`,
        recommendation: "Check margin impact and compare other suppliers before the next purchase.", action: "compare_suppliers",
      });
    }
  }

  for (const item of items) {
    const ln = state.get(item.sku);
    if (!ln || ln.last_cost === null) continue;
    const nowPct = marginPercentage(item.selling_price, ln.last_cost);
    const beforePct = ln.prev_cost ? marginPercentage(item.selling_price, ln.prev_cost) : null;
    const dropped = beforePct !== null && beforePct - nowPct >= cfg.margin_drop_pp && nowPct < 20;
    if (dropped || nowPct < cfg.min_margin_pct) {
      risks.push({
        key: `MARGIN:${item.sku}:${ln.last_cost}`, type: "MARGIN_ANOMALY", category: "Margins", severity: nowPct < cfg.min_margin_pct ? "HIGH" : "MEDIUM",
        sku: item.sku, entity: item.name, title: "Margin Anomaly",
        metrics: { selling_price: item.selling_price, unit_cost: ln.last_cost, previous_cost: ln.prev_cost, margin_pct: nowPct, previous_margin_pct: beforePct },
        reason: dropped ? `Cost rose from ₹${g(ln.prev_cost)} to ₹${g(ln.last_cost)}; margin fell from ${beforePct}% to ${nowPct}%.` : `Margin is only ${nowPct}% (threshold ${g(cfg.min_margin_pct)}%).`,
        recommendation: `Review the selling price of ${item.name} or source from a cheaper supplier.`, action: "compare_suppliers",
      });
    }
  }

  const refs = [...state.quotes, ...state.price_changes.map((c) => ({ supplier_id: c.supplier_id, sku: c.sku, unit_price: c.new_price, ts: c.ts, event: c.event }))];
  for (const inv of state.invoice_prices) {
    const quotes = refs.filter((q) => q.supplier_id === inv.supplier_id && q.sku === inv.sku && q.ts <= inv.ts).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    if (!quotes.length) continue;
    const q = quotes[quotes.length - 1];
    const diff = pyRound(((inv.unit_price - q.unit_price) / q.unit_price) * 100, 1);
    if (diff >= cfg.mismatch_pct && bySku[inv.sku]) {
      risks.push({
        key: `MISMATCH:${inv.event}`, type: "QUOTE_INVOICE_MISMATCH", category: "Suppliers", severity: diff >= 5 ? "HIGH" : "MEDIUM", sku: inv.sku,
        entity: bySku[inv.sku].name, title: "Quote–Invoice Mismatch",
        metrics: { supplier: suppliers[inv.supplier_id] ?? inv.supplier_id, quoted_price: q.unit_price, invoiced_price: inv.unit_price, difference_pct: diff },
        reason: `Quoted ₹${g(q.unit_price)}/unit but invoiced ₹${g(inv.unit_price)}/unit (${signed(diff)}%).`, evidence: [q.event, inv.event],
        recommendation: "Raise the difference with the supplier before paying the invoice.", action: "review_sources",
      });
    }
  }

  for (const [poId, po] of Object.entries(state.purchase_orders)) {
    if (po.received_qty !== undefined && po.received_qty !== null && po.received_qty !== po.qty) {
      risks.push({
        key: `INV_MISMATCH:${poId}`, type: "INVENTORY_MISMATCH", category: "Inventory", severity: "MEDIUM", sku: po.sku, entity: bySku[po.sku]?.name ?? po.sku,
        title: "Inventory Mismatch", metrics: { po: poId, ordered: po.qty, received: po.received_qty },
        reason: `${poId}: ordered ${po.qty} but received ${po.received_qty}.`, recommendation: "Confirm the delivery note with the supplier.", action: "review_sources",
      });
    }
  }

  const payables = Object.values(state.payables).filter((v) => v > 0).reduce((a, b) => a + b, 0);
  if (state.cash < cfg.min_cash_buffer) {
    risks.push({
      key: "CASH:LOW", type: "WORKING_CAPITAL", category: "Cash", severity: "HIGH", sku: null, entity: "Cash position", title: "Low Cash Buffer",
      metrics: { cash: pyRound(state.cash, 2), buffer: cfg.min_cash_buffer, payables: pyRound(payables, 2) },
      reason: `Cash ₹${commas(state.cash)} is below the ₹${commas(cfg.min_cash_buffer)} buffer.`, recommendation: "Prefer credit terms and delay non-urgent purchases.", action: "none",
    });
  }
  for (const [cid, amt] of Object.entries(state.receivables)) {
    if (amt >= cfg.receivable_alert) {
      const name = customers[cid] ?? cid;
      risks.push({
        key: `RECEIVABLE:${cid}`, type: "OUTSTANDING_PAYMENT", category: "Payments", severity: "MEDIUM", sku: null, entity: name, title: "Outstanding Receivable",
        metrics: { customer: name, amount: pyRound(amt, 2) }, reason: `${name} owes ₹${commas(amt)}.`, recommendation: "Send a payment reminder.", action: "none",
      });
    }
  }
  risks.sort((a, b) => SEV[a.severity] - SEV[b.severity] || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return risks;
}
