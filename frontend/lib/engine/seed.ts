/** Seeded DEMO DATA (port of backend/app/services/seed.py). Fictional business, fictional people. */
import { appendEvent, getState, Masters } from "./ledger";
import { DB, emptyDb } from "./store";
import { D, H, pyRound } from "./util";
import { afterStateChange } from "./workflow";

export const DEFAULT_SETTINGS = {
  horizon_days: 1, cover_days: 7, min_margin_pct: 10, margin_drop_pp: 3, price_change_pct: 5,
  mismatch_pct: 2, min_cash_buffer: 10000, receivable_alert: 5000, confidence_threshold: 0.75,
  language: "Hindi + English", currency: "INR",
};

type ItemRow = [string, string, string, string, number, number, number, number, number, string[]];
const ITEMS: ItemRow[] = [
  ["SKU-1001", "Tata Salt 1kg", "Grocery", "pack", 28, 22, 60, 20, 6, ["salt", "namak", "tata salt"]],
  ["SKU-1002", "Aashirvaad Atta 5kg", "Grocery", "bag", 265, 238, 18, 8, 3, ["atta", "aata", "aashirvaad"]],
  ["SKU-1003", "Fortune Sunflower Oil 1L", "Grocery", "pouch", 155, 138, 9, 10, 3, ["oil", "tel", "fortune", "sunflower oil"]],
  ["SKU-1004", "India Gate Basmati 1kg", "Grocery", "pack", 140, 118, 22, 8, 2, ["basmati", "rice", "chawal", "india gate"]],
  ["SKU-1005", "Toor Dal 1kg", "Grocery", "pack", 165, 142, 25, 10, 3, ["toor dal", "arhar dal", "dal"]],
  ["SKU-1006", "Sugar 1kg", "Grocery", "pack", 48, 41, 40, 15, 5, ["sugar", "cheeni", "shakkar"]],
  ["SKU-1010", "Parle-G 250g", "FMCG", "pack", 25, 21, 30, 25, 8, ["parle-g", "parle g", "parleg", "biscuit"]],
  ["SKU-1011", "Maggi Noodles 4-pack", "FMCG", "pack", 60, 51, 35, 12, 4, ["maggi", "noodles"]],
  ["SKU-1012", "Lay's Classic 52g", "FMCG", "pack", 20, 16, 48, 15, 6, ["lays", "lay's", "chips"]],
  ["SKU-1013", "Britannia Good Day 200g", "FMCG", "pack", 40, 33, 26, 10, 3, ["good day", "britannia"]],
  ["SKU-1020", "Amul Butter 100g", "FMCG", "pack", 58, 50, 24, 8, 3, ["butter", "amul butter", "makhan"]],
  ["SKU-1021", "Amul Taaza Milk 1L", "FMCG", "pouch", 70, 62, 30, 20, 12, ["milk", "doodh", "amul milk", "taaza"]],
  ["SKU-1042", "Coca-Cola 300ml", "Beverages", "bottle", 45, 35, 0, 8, 6, ["coke", "coca cola", "coca-cola", "cola"]],
  ["SKU-1043", "Sprite 300ml", "Beverages", "bottle", 40, 34, 12, 10, 4, ["sprite"]],
  ["SKU-1044", "Thums Up 300ml", "Beverages", "bottle", 45, 35, 28, 12, 4, ["thums up", "thumbs up", "thumsup"]],
  ["SKU-1050", "Surf Excel 1kg", "Household", "pack", 140, 118, 6, 10, 2, ["surf", "surf excel", "detergent"]],
  ["SKU-1051", "Vim Bar 200g", "Household", "bar", 20, 16, 40, 12, 3, ["vim", "vim bar"]],
  ["SKU-1052", "Colgate Strong Teeth 200g", "Household", "tube", 110, 92, 18, 6, 2, ["colgate", "toothpaste"]],
  ["SKU-1053", "Dettol Soap 75g", "Household", "bar", 45, 37, 30, 10, 3, ["dettol", "soap"]],
  ["SKU-1054", "Harpic 500ml", "Household", "bottle", 99, 42, 14, 6, 1, ["harpic", "toilet cleaner"]],
];

const SUPPLIERS: [string, string, string, number, string[]][] = [
  ["SUP-A", "Supplier A", "Shree Wholesale Mart", 0.9, ["shree wholesale", "shree"]],
  ["SUP-B", "Supplier B", "Beverages Distribution Co.", 0.95, ["beverages distribution", "bdc"]],
  ["SUP-C", "Supplier C", "City Cash & Carry", 0.85, ["city cash", "cash and carry", "cash & carry"]],
  ["SUP-D", "Supplier D", "Metro Beverages", 0.92, ["metro beverages", "metro"]],
  ["SUP-E", "Supplier E", "Household Hub Distributors", 0.88, ["household hub"]],
];

const CUSTOMERS: [string, string, string, string[]][] = [
  ["CUST-01", "Ramesh Stores", "retailer", ["ramesh", "ramesh bhai", "ramesh stores", "ramesh store"]],
  ["CUST-02", "Ramesh Kumar", "retailer", ["ramesh", "ramesh kumar", "rameshji"]],
  ["CUST-03", "Sharma Kirana", "retailer", ["sharma", "sharma ji", "sharma kirana"]],
  ["CUST-04", "Hotel Annapurna", "horeca", ["annapurna", "hotel annapurna"]],
  ["CUST-05", "Priya Caterers", "horeca", ["priya", "priya caterers"]],
];

const QUOTES: [string, string, number, number, number, number][] = [
  ["SUP-A", "SKU-1042", 36, 100, 2, 0], ["SUP-B", "SKU-1042", 39, 20, 0, 15], ["SUP-C", "SKU-1042", 37, 50, 1, 0],
  ["SUP-D", "SKU-1042", 35, 40, 3, 7],
  ["SUP-B", "SKU-1043", 35, 20, 0, 15], ["SUP-D", "SKU-1043", 34, 30, 3, 7], ["SUP-C", "SKU-1043", 34.5, 48, 1, 0],
  ["SUP-B", "SKU-1044", 36, 24, 0, 15], ["SUP-D", "SKU-1044", 35, 40, 3, 7],
  ["SUP-A", "SKU-1003", 136, 24, 1, 0], ["SUP-C", "SKU-1003", 138, 12, 0, 0], ["SUP-E", "SKU-1003", 141, 10, 1, 10],
  ["SUP-A", "SKU-1010", 20.5, 96, 1, 0], ["SUP-C", "SKU-1010", 21, 48, 0, 0],
  ["SUP-A", "SKU-1050", 116, 24, 2, 0], ["SUP-E", "SKU-1050", 118, 12, 1, 15],
  ["SUP-E", "SKU-1054", 42, 12, 2, 15], ["SUP-E", "SKU-1051", 16, 36, 1, 15], ["SUP-E", "SKU-1053", 37, 24, 1, 15],
  ["SUP-E", "SKU-1052", 92, 12, 2, 15],
  ["SUP-A", "SKU-1001", 22, 50, 1, 0], ["SUP-A", "SKU-1002", 238, 10, 1, 0], ["SUP-A", "SKU-1004", 118, 20, 1, 0],
  ["SUP-A", "SKU-1005", 142, 20, 1, 0], ["SUP-A", "SKU-1006", 41, 50, 1, 0], ["SUP-C", "SKU-1011", 51, 24, 0, 0],
  ["SUP-C", "SKU-1012", 16, 48, 0, 0], ["SUP-C", "SKU-1013", 33, 24, 0, 0], ["SUP-C", "SKU-1020", 50, 20, 0, 0],
  ["SUP-C", "SKU-1021", 62, 24, 0, 0],
];

const SALES: Record<string, number[]> = {
  "SKU-1042": [5, 7, 6, 4, 8, 6, 6], "SKU-1043": [3, 4, 5, 3, 4, 4, 5], "SKU-1010": [7, 9, 8, 6, 9, 8, 9],
  "SKU-1021": [11, 13, 12, 10, 14, 12, 12], "SKU-1003": [2, 3, 3, 4, 3, 2, 4], "SKU-1011": [4, 3, 5, 4, 4, 3, 5],
  "SKU-1050": [2, 1, 3, 2, 2, 2, 2], "SKU-1012": [5, 7, 6, 6, 5, 7, 6],
};

const ORDERS: [string, string, [string, number][], number, number][] = [
  ["ORD-501", "CUST-03", [["SKU-1042", 20]], 1, 20],
  ["ORD-502", "CUST-04", [["SKU-1020", 6], ["SKU-1021", 10]], 1, 6],
  ["ORD-503", "CUST-04", [["SKU-1003", 8]], 1, 5],
  ["ORD-504", "CUST-02", [["SKU-1010", 40]], 1, 4],
  ["ORD-505", "CUST-05", [["SKU-1002", 4], ["SKU-1005", 5]], 2, 3],
];

export function seed(): DB {
  const db = emptyDb();
  const nowMs = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const s = new Date(nowMs - 8 * D);
  s.setUTCHours(3, 30, 0, 0);
  const start = s.getTime();

  db.merchant = { id: "MER-001", name: "Rajesh General Stores", owner: "Rajesh Sharma", city: "Mumbai (demo)", currency: "INR", settings: { ...DEFAULT_SETTINGS }, is_demo: true };
  db.users = [{ id: "USR-001", merchant_id: "MER-001", name: "Rajesh Sharma", role: "owner" }];
  db.items = ITEMS.map(([sku, name, category, unit, sell, , , rop, daily, aliases]) => ({ sku, name, category, unit, selling_price: sell, reorder_point: rop, daily_demand: daily, aliases }));
  db.suppliers = SUPPLIERS.map(([id, short_name, name, reliability, aliases]) => ({ id, short_name, name, reliability, city: "Mumbai (demo)", aliases }));
  db.customers = CUSTOMERS.map(([id, name, kind, aliases]) => ({ id, name, kind, aliases }));
  const m = new Masters(db);

  const ev = (etype: string, payload: any, tsMs: number, o: any = {}) =>
    appendEvent(db, etype, payload, { category: "EVENT", source_type: "seed", actor: "Demo seed", ...o, ts: iso(tsMs), masters: m });

  const sold: Record<string, number> = Object.fromEntries(Object.entries(SALES).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0)]));
  const receivedLater: Record<string, number> = { "SKU-1020": 20, "SKU-1054": 12 };
  for (const [sku, , , , , cost, target] of ITEMS) {
    const opening = target + (sold[sku] || 0) - (receivedLater[sku] || 0);
    if (opening > 0) ev("OPENING_STOCK", { sku, qty: opening, unit_cost: cost }, start, { category: "OPENING", source_ref: "Opening stock count (demo)" });
  }
  for (const [sid, sku, price, moq, dd, cd] of QUOTES)
    ev("SUPPLIER_QUOTE", { supplier_id: sid, sku, unit_price: price, moq, delivery_days: dd, credit_days: cd }, start + 5 * 60_000, { category: "OPENING", source_ref: "Supplier price list (demo)" });
  ev("OPENING_RECEIVABLE", { customer_id: "CUST-01", amount: 7500 }, start, { category: "OPENING", source_ref: "Khata book (demo)" });
  ev("OPENING_RECEIVABLE", { customer_id: "CUST-04", amount: 2400 }, start, { category: "OPENING", source_ref: "Khata book (demo)" });
  ev("OPENING_PAYABLE", { supplier_id: "SUP-A", amount: 3200 }, start, { category: "OPENING", source_ref: "Supplier ledger (demo)" });

  for (let d = 0; d < 7; d++) {
    const day = start + (d + 1) * D + 15 * H;
    for (const [sku, series] of Object.entries(SALES)) {
      const price = m.itemsBySku[sku].selling_price;
      ev("SALE", { sku, qty: series[d], unit_price: price }, day, { source_type: "pos", source_ref: "Daily POS summary (demo)", title: `${series[d]} ${m.itemName(sku)} sold (daily summary)` });
    }
  }
  ev("SUPPLIER_QUOTE", { supplier_id: "SUP-E", sku: "SKU-1054", unit_price: 42, moq: 12, delivery_days: 2, credit_days: 15 }, start + 2 * D + 6 * H,
    { source_type: "quotation", source_ref: "QT-118 (demo)", actor: "Rajesh Sharma", confidence: 0.96 });
  ev("PURCHASE_RECEIVED", { supplier_id: "SUP-E", sku: "SKU-1054", qty: 12, unit_cost: 46, credit_days: 15, invoice_no: "HH-7731" }, start + 4 * D + 5 * H,
    { source_type: "invoice", source_ref: "HH-7731 (demo)", actor: "Rajesh Sharma", confidence: 0.95 });
  ev("SUPPLIER_PRICE_UPDATE", { supplier_id: "SUP-C", sku: "SKU-1020", old_price: 50, new_price: 54, change_pct: 8.0 }, start + 5 * D + 4 * H,
    { source_type: "message", source_ref: "WhatsApp · City Cash & Carry (demo)", actor: "Rajesh Sharma", confidence: 0.93 });
  ev("PURCHASE_RECEIVED", { supplier_id: "SUP-C", sku: "SKU-1020", qty: 20, unit_cost: 54, credit_days: 0, invoice_no: "CCC-5520" }, start + 5 * D + 6 * H,
    { source_type: "invoice", source_ref: "CCC-5520 (demo)", actor: "Rajesh Sharma", confidence: 0.97 });
  ev("PAYMENT_RECEIVED", { customer_id: "CUST-04", amount: 2400, mode: "UPI" }, start + 6 * D + 7 * H,
    { source_type: "message", source_ref: "UPI SMS (demo)", actor: "Rajesh Sharma", confidence: 0.98 });
  ev("PAYMENT_MADE", { supplier_id: "SUP-A", amount: 3200 }, start + 6 * D + 9 * H, { source_type: "user", source_ref: "Bank transfer (demo)", actor: "Rajesh Sharma" });

  const poTs = nowMs - 3 * D;
  db.approvals.push({ id: "APR-0087", recommendation_id: null, actor: "Rajesh Sharma", decision: "APPROVED", note: "Weekly beverage reorder (demo)", snapshot: {}, ts: iso(poTs) });
  const poEv = ev("PURCHASE_ORDER_CREATED", { po_id: "OFF-2026-087", supplier_id: "SUP-D", sku: "SKU-1042", qty: 40, unit_price: 35, total: 1400, credit_days: 7, delivery_days: 3, approval_id: "APR-0087" },
    poTs, { category: "ACTION", source_type: "user", actor: "Rajesh Sharma", approval_id: "APR-0087", reason: "Weekly beverage reorder (demo)" });
  db.purchase_orders.push({ id: "OFF-2026-087", supplier_id: "SUP-D", sku: "SKU-1042", qty: 40, unit_price: 35, total: 1400, credit_days: 7, delivery_days: 3,
    status: "APPROVED", recommendation_id: null, approval_id: "APR-0087", approved_by: "Rajesh Sharma", event_id: poEv.id, received_event_id: null, created_at: iso(poTs) });

  for (const [oid, cid, items, dueDays, hoursAgo] of ORDERS) {
    ev("CUSTOMER_ORDER", { order_id: oid, customer_id: cid, items: items.map(([sku, qty]) => ({ sku, qty })), due: iso(nowMs + dueDays * D).slice(0, 10) },
      nowMs - hoursAgo * H, { source_type: "message", source_ref: "WhatsApp (demo)", actor: "Rajesh Sharma", confidence: 0.95 });
  }

  const cashNow = getState(db).cash;
  ev("OPENING_CASH", { amount: pyRound(42850 - cashNow, 2) }, start - 60_000, { category: "OPENING", source_ref: "Cash count (demo)" });
  afterStateChange(db, null, iso(nowMs - 2 * H));
  return db;
}
