/** Action Engine: supplier comparison + what-if simulator (port of backend/app/engines/action.py). */
import type { Item, Supplier } from "./decision";
import { BusinessState, marginPercentage, workingCapitalImpact } from "./state";
import { commas, g, pyRound } from "./util";

export const WEIGHTS: Record<string, number> = { price: 0.25, moq_fit: 0.2, delivery: 0.25, credit: 0.1, cash_impact: 0.2 };
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export function compareSuppliers(state: BusinessState, sku: string, needQty: number, targetMax: number, neededBy: number, suppliers: Record<string, Supplier>) {
  const offers = Object.values(state.offers).filter((o: any) => o.sku === sku) as any[];
  if (!offers.length) return { sku, options: [] as any[], recommended: null as string | null, need_qty: needQty, target_max: targetMax };
  const minPrice = Math.min(...offers.map((o) => o.unit_price));
  const options: any[] = offers.map((o) => {
    const sup = suppliers[o.supplier_id];
    const moq = Math.trunc(o.moq || 1);
    const qty = Math.max(moq, needQty);
    const total = pyRound(qty * o.unit_price, 2);
    const credit = Math.trunc(o.credit_days || 0);
    const delivery = Math.trunc(o.delivery_days || 0);
    const wc = workingCapitalImpact(total, credit);
    const excess = Math.max(0, qty - targetMax);
    const onTime = delivery <= neededBy;
    const scores: Record<string, number> = {
      price: pyRound((minPrice / o.unit_price) * 100),
      moq_fit: pyRound(clamp(100 - (excess / Math.max(targetMax, 1)) * 100)),
      delivery: onTime ? pyRound(clamp(100 - 25 * delivery)) : 20,
      credit: pyRound(clamp((credit / 15) * 100)),
      cash_impact: pyRound(clamp(100 - wc.cash_outflow_now / 50)),
    };
    const score = pyRound(Object.entries(WEIGHTS).reduce((s, [k, w]) => s + scores[k] * w, 0), 1);
    const notes: string[] = [];
    if (!onTime) notes.push(`Arrives in ${delivery} days — after the need-by date, stockout likely`);
    if (excess) notes.push(`MOQ ${moq} leaves ~${excess} excess units`);
    if (credit) notes.push(`${credit}-day credit: no immediate cash outflow`);
    return {
      supplier_id: o.supplier_id, supplier: sup ? sup.short_name : o.supplier_id, supplier_name: sup ? sup.name : o.supplier_id,
      reliability: pyRound((sup ? sup.reliability : 0.8) * 100), unit_price: o.unit_price, moq, qty, total, credit_days: credit,
      delivery_days: delivery, delivery_label: delivery === 0 ? "Today" : delivery === 1 ? "Tomorrow" : `${delivery} days`,
      cash_required: wc.cash_outflow_now, deferred_payable: wc.deferred_payable, excess_units: excess, on_time: onTime,
      risk: onTime && excess === 0 ? "Low" : !onTime ? "High" : "Medium", scores, score, notes,
    };
  });
  options.sort((a, b) => b.score - a.score || a.total - b.total);
  const feasible = options.filter((o) => o.on_time);
  const best = (feasible.length ? feasible : options)[0];
  best.recommended = true;
  const cheapest = options.reduce((m, o) => (o.unit_price < m.unit_price ? o : m), options[0]);
  const why = [`${best.supplier} scores ${best.score} on price, MOQ fit, delivery, credit and cash impact.`];
  if (cheapest.supplier_id !== best.supplier_id) why.push(`${cheapest.supplier} is cheaper per unit (₹${g(cheapest.unit_price)}) but ${cheapest.notes.join("; ") || "scores lower overall"}.`);
  return { sku, need_qty: needQty, target_max: targetMax, options, recommended: best.supplier_id as string | null, why, weights: WEIGHTS };
}

export function simulate(state: BusinessState, item: Item, dailyDemand: number, sc: any) {
  const ln = state.get(item.sku);
  const onHand = ln?.on_hand ?? 0, reserved = ln?.reserved ?? 0, incoming = ln?.incoming ?? 0;
  const unitCostNow = ln && ln.last_cost ? ln.last_cost : sc.unit_price || 0;
  const qty = Math.trunc(sc.qty);
  const base = Number(sc.unit_price);
  const discount = Number(sc.discount_pct || 0);
  const eff = pyRound(base * (1 - discount / 100), 2);
  const delivery = Math.trunc(sc.delivery_days || 0);
  const credit = Math.trunc(sc.credit_days || 0);
  const demand = Number(sc.daily_demand || dailyDemand);
  const cover = Number(sc.cover_days ?? 7);
  const needBy = Number(sc.needed_by_days ?? 1);
  const available = onHand - reserved;
  const purchaseCost = pyRound(qty * eff, 2);
  const savings = pyRound(qty * (base - eff), 2);
  const inTime = delivery <= needBy;
  const atNeedBy = available + incoming - demand * needBy + (inTime ? qty : 0);
  const afterCover = available + incoming + qty - demand * cover;
  const excess = Math.max(0, pyRound(afterCover));
  const daysToClear = demand > 0 ? pyRound(Math.max(available + incoming + qty, 0) / demand, 1) : null;
  const risk = atNeedBy < 0 ? "HIGH" : afterCover < 0 ? "MEDIUM" : "LOW";
  const wc = workingCapitalImpact(purchaseCost, credit);
  const locked = pyRound(excess * eff, 2);
  const mNow = marginPercentage(item.selling_price, unitCostNow);
  const mNew = marginPercentage(item.selling_price, eff);
  let suggested = Math.max(0, -(available + incoming)) + demand * cover;
  suggested = suggested > 0 ? Math.trunc(5 * Math.ceil(suggested / 5)) : 0;
  return {
    label: sc.label || `${qty} units`, supplier_id: sc.supplier_id ?? null, qty, unit_price: base, discount_pct: discount, effective_price: eff,
    delivery_days: delivery, credit_days: credit, daily_demand: pyRound(demand, 2), purchase_cost: purchaseCost, purchase_savings: savings,
    cash_outflow_now: wc.cash_outflow_now, deferred_payable: wc.deferred_payable, projected_stock: pyRound(available + incoming + qty, 1),
    stock_at_need_by: pyRound(atNeedBy, 1), excess_units: excess, days_to_clear: daysToClear, capital_locked_in_excess: locked,
    stockout_risk: risk, margin_pct_before: mNow, margin_pct_after: mNew, margin_impact_pp: pyRound(mNew - mNow, 1),
    working_capital_impact: locked > savings ? "NEGATIVE" : locked === 0 ? "NEUTRAL" : "POSITIVE", suggested_qty: suggested,
  };
}

export function compareScenarios(results: ReturnType<typeof simulate>[]) {
  const key = (r: any): [number, number] => [r.stockout_risk !== "LOW" ? 1 : 0, r.cash_outflow_now + r.capital_locked_in_excess - r.purchase_savings];
  const best = results.reduce((m, r) => { const a = key(r), b = key(m); return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? r : m; }, results[0]);
  const lines = results.map((r) => {
    if (r.purchase_savings > 0 && r.capital_locked_in_excess > r.purchase_savings)
      return `${r.label}: saves ₹${commas(r.purchase_savings)} but locks ₹${commas(r.capital_locked_in_excess)} in ${r.excess_units} excess units (~${r.days_to_clear} days to clear).`;
    if (r.stockout_risk !== "LOW") return `${r.label}: stockout risk ${r.stockout_risk.toLowerCase()} — stock at need-by date ${g(r.stock_at_need_by)}.`;
    return `${r.label}: ₹${commas(r.purchase_cost)} purchase, ${r.excess_units} excess units, risk low.`;
  });
  return { best_label: best.label, lines, suggested_qty: best.suggested_qty, badges: scenarioBadges(results, best.label) };
}

/** BEST COST / BEST SPEED / BEST STOCK COVERAGE / BEST BALANCED. */
export function scenarioBadges(results: any[], balanced: string) {
  const by = (f: (r: any) => number, dir: 1 | -1) => results.reduce((m, r) => (dir * (f(r) - f(m)) < 0 ? r : m), results[0]).label;
  return {
    best_cost: by((r) => r.effective_price * 1e6 + r.purchase_cost, 1),
    best_speed: by((r) => r.delivery_days * 1e6 + r.effective_price, 1),
    best_coverage: by((r) => r.stock_at_need_by * 1e3 - r.excess_units, -1),
    best_balanced: balanced,
  };
}
