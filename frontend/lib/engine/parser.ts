/**
 * SEE layer — deterministic Hinglish/English parser + entity resolution (port of backend/app/services/ai.py).
 * Used in Demo Mode and as the fallback when Gemini is unavailable.
 */
import { containsWord, escapeRe } from "./util";

export interface Catalog {
  items: { sku: string; name: string; aliases: string[]; selling_price: number }[];
  suppliers: { id: string; short_name: string; name: string; aliases: string[] }[];
  customers: { id: string; name: string; aliases: string[] }[];
}
export interface ParsedItem { product?: string | null; sku?: string | null; qty?: number | null; unit_price?: number | null; match_conf?: number }
export interface ParsedEvent {
  type: string; items: ParsedItem[]; supplier_text?: string | null; customer_text?: string | null; amount?: number | null;
  delivery_days?: number | null; moq?: number | null; credit_days?: number | null; due?: string | null; confidence: number; note: string;
}
export interface Understanding {
  mode: "demo" | "gemini" | "fallback"; text: string | null; document_type: string | null; document_no: string | null;
  supplier_text: string | null; customer_text: string | null; events: ParsedEvent[]; notice: string | null;
}

const NUM = "(\\d[\\d,]*(?:\\.\\d+)?)";
const RUPEE = "(?:₹|rs\\.?|inr|rupees?|rupaye|rupaiye|rupay)";
const ORDER_WORDS = ["bhej", "bhejna", "bhejo", "send", "chahiye", "chaiye", "need", "needs", "deliver", "order", "dena", "dedo", "de dena", "supply", "book", "want", "require"];
const PAY_IN_WORDS = ["diye", "de diye", "paid", "pay kiya", "payment", "received", "jama", "bheje", "transfer", "gpay", "upi", "phonepe", "cash diya"];
const PAY_OUT_WORDS = ["paid to", "payment to", "ko diye", "ko bheje"];
const QUOTE_WORDS = ["quote", "quotation", "rate", "price", "per unit", "each", "moq", "can deliver", "offer", "discount"];
const SALE_WORDS = ["sold", "becha", "beche", "bik gaye", "bik gaya", "sale"];
const DAMAGE_WORDS = ["damaged", "damage", "toot", "tuta", "toota", "broken", "expired", "kharab", "leak"];

const num = (s: string | undefined | null): number | null => {
  if (s === null || s === undefined) return null;
  const v = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
};
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}_₹\s\-/.]/gu, " ").replace(/\s+/g, " ").trim();

/** difflib.SequenceMatcher(None, a, b).ratio() equivalent (Ratcliff/Obershelp). */
function matchingChars(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let best = 0, ai = 0, bi = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) { best = k; ai = i; bi = j; }
    }
  }
  if (!best) return 0;
  return best + matchingChars(a.slice(0, ai), b.slice(0, bi)) + matchingChars(a.slice(ai + best), b.slice(bi + best));
}
export const seqRatio = (a: string, b: string) => (a.length + b.length ? (2 * matchingChars(a, b)) / (a.length + b.length) : 1);

export class EntityMatcher {
  c: Catalog;
  productAliases: [string, string][] = [];
  constructor(c: Catalog) {
    this.c = c;
    for (const it of c.items) {
      const names = new Set([it.sku.toLowerCase(), it.name.toLowerCase(), ...(it.aliases || []).map((a) => a.toLowerCase())]);
      names.forEach((n) => this.productAliases.push([n, it.sku]));
    }
    this.productAliases.sort((a, b) => b[0].length - a[0].length);
  }

  findProducts(text: string): [number, number, string][] {
    const t = text.toLowerCase();
    const taken: [number, number][] = [];
    const found: [number, number, string][] = [];
    for (const [alias, sku] of this.productAliases) {
      const re = new RegExp(`(?<![\\w])${escapeRe(alias)}(?![\\w])`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(t))) {
        const s = m.index, e = s + m[0].length;
        if (!taken.some(([a, b]) => !(e <= a || s >= b))) { taken.push([s, e]); found.push([s, e, sku]); }
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    return found.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  }

  productToSku(name?: string | null): [string | null, number] {
    if (!name) return [null, 0];
    const n = name.toLowerCase().trim();
    const mentions = this.findProducts(n);
    if (mentions.length) return [mentions[0][2], 0.95];
    let bestAlias: string | null = null, bestRatio = 0;
    for (const [alias] of this.productAliases) {
      const r = seqRatio(n, alias);
      if (r > bestRatio) { bestRatio = r; bestAlias = alias; }
    }
    if (bestAlias && bestRatio >= 0.6) {
      const sku = this.productAliases.find(([a]) => a === bestAlias)![1];
      return [sku, Math.round((0.6 + 0.35 * bestRatio) * 100) / 100];
    }
    return [null, 0];
  }

  private resolve<T extends { id: string; name: string }>(text: string | null | undefined, list: T[], names: (x: T) => string[]): [string | null, { id: string; name: string }[]] {
    if (!text) return [null, []];
    const t = text.toLowerCase();
    const hits: [number, T][] = [];
    for (const x of list) {
      const best = Math.max(0, ...names(x).filter((n) => containsWord(t, n) >= 0).map((n) => n.length));
      if (best) hits.push([best, x]);
    }
    if (!hits.length) return [null, []];
    const top = Math.max(...hits.map((h) => h[0]));
    const winners = hits.filter((h) => h[0] === top).map((h) => h[1]);
    if (winners.length === 1) return [winners[0].id, []];
    return [null, winners.map((w) => ({ id: w.id, name: w.name }))];
  }
  supplier(text?: string | null) {
    return this.resolve(text, this.c.suppliers, (s) => [s.name, s.short_name, ...(s.aliases || [])].map((x) => x.toLowerCase()));
  }
  customer(text?: string | null) {
    return this.resolve(text, this.c.customers, (c) => [c.name, ...(c.aliases || [])].map((x) => x.toLowerCase()));
  }
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
function dueFromText(t: string): string | null {
  const today = new Date();
  const plus = (n: number) => isoDay(new Date(today.getTime() + n * 86400000));
  if (["kal", "tomorrow", "tmrw"].some((w) => t.includes(w))) return plus(1);
  if (t.includes("parso") || t.includes("day after")) return plus(2);
  if (t.includes("aaj") || t.includes("today")) return plus(0);
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  for (let i = 0; i < days.length; i++) {
    if (t.includes(days[i])) {
      const wd = (today.getDay() + 6) % 7; // Monday = 0 like Python
      const delta = ((i - wd) % 7 + 7) % 7 || 7;
      return plus(delta);
    }
  }
  return null;
}

function qtyForMention(text: string, start: number, end: number): number | null {
  const before = text.slice(Math.max(0, start - 30), start);
  const after = text.slice(end, end + 25);
  let m = new RegExp(NUM + "\\s*(?:units?|pcs|pieces|nos|bottles?|packets?|boxes?|cases?|kg|x)?\\s*(?:of\\s*)?$").exec(before);
  if (m) return num(m[1]);
  m = new RegExp("^\\s*[:x×\\-]?\\s*" + NUM + "(?!\\s*(?:%|₹|rs|rupees?|rupaye|each|per|days?))").exec(after);
  if (m) return num(m[1]);
  return null;
}

export function parseInvoiceLines(text: string, matcher: EntityMatcher) {
  const out: any[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([A-Za-z][A-Za-z0-9 .\-&'/()]*?)\s+(\d+)\s+(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)(?:\s+(?:₹|rs\.?\s*)?(\d[\d,]*(?:\.\d+)?))?\s*$/i.exec(line);
    if (!m) continue;
    const name = m[1];
    const [sku, conf] = matcher.productToSku(name);
    if (!sku && ["total", "subtotal", "grand total"].includes(name.trim().toLowerCase())) continue;
    const qty = num(m[2]), rate = num(m[3]), amt = num(m[4]);
    const consistent = amt === null || Math.abs((qty || 0) * (rate || 0) - amt) < 0.5;
    out.push({ product: name.trim(), sku, qty, unit_price: rate, line_total: amt, match_conf: conf, consistent });
  }
  return out;
}

export function ruleParse(text: string, kind: string, matcher: EntityMatcher, sender?: string | null): Understanding {
  const u: Understanding = { mode: "demo", text, document_type: null, document_no: null, supplier_text: null, customer_text: null, events: [], notice: null };
  const t = norm(text);
  const raw = text.toLowerCase();

  const doc = /(?:invoice|inv|bill)\s*(?:no\.?|number|#|:)?\s*[:#]?\s*([A-Z]{2,5}-?\d{2,6})/i.exec(text);
  if (doc) u.document_no = doc[1].toUpperCase();
  const [supId] = matcher.supplier(text);
  u.supplier_text = supId ? matcher.c.suppliers.find((s) => s.id === supId)?.name ?? null : null;
  const credit = /(\d+)\s*[- ]?days?\s*credit|credit\s*(?:of|:)?\s*(\d+)\s*days?/.exec(raw);
  const creditDays = credit ? parseInt(credit[1] || credit[2], 10) : null;
  const delivery = /(?:deliver(?:y)?|dispatch)\D{0,20}?(\d+)\s*days?|(\d+)\s*days?\s*(?:me|mein)?\s*deliver/.exec(raw);
  const deliveryDays = delivery ? parseInt(delivery[1] || delivery[2], 10) : /deliver\w*\s+(?:today|aaj)/.test(raw) ? 0 : null;
  const moqM = /moq\s*[:\-]?\s*(\d+)|minimum\s*(?:order)?\s*(?:of)?\s*(\d+)/.exec(raw);
  const moq = moqM ? parseInt(moqM[1] || moqM[2], 10) : null;

  const lines = parseInvoiceLines(text, matcher);
  const isQuote = kind === "quotation" || t.includes("quotation") || (t.includes("quote") && kind !== "invoice");
  if (lines.length && ["invoice", "receipt", "quotation", "image", "text"].includes(kind) && (supId || ["invoice", "receipt", "quotation"].includes(kind))) {
    u.document_type = isQuote ? "quotation" : kind === "receipt" ? "receipt" : "invoice";
    for (const ln of lines) {
      let conf = ln.sku && ln.consistent ? 0.97 : ln.sku ? 0.7 : 0.4;
      if (ln.match_conf < 0.9) conf = Math.min(conf, ln.match_conf || 0.4);
      u.events.push({ type: isQuote ? "SUPPLIER_QUOTE" : "PURCHASE_RECEIVED", items: [{ product: ln.product, sku: ln.sku, qty: ln.qty, unit_price: ln.unit_price }],
        supplier_text: u.supplier_text, credit_days: creditDays, delivery_days: deliveryDays, moq, confidence: conf,
        note: ln.consistent ? "" : `Line total ${ln.line_total} ≠ qty × rate` });
    }
    return u;
  }

  u.document_type = "message";
  const mentions = matcher.findProducts(text);
  const amountM = new RegExp(RUPEE + "\\s*" + NUM + "|" + NUM + "\\s*" + RUPEE).exec(raw);
  const amount = amountM ? num(amountM[1] || amountM[2]) : null;
  const custText = sender ? `${sender} ${text}` : text;
  const [cid, cands] = matcher.customer(custText);
  const customerMentioned = cid !== null || cands.length > 0;
  const has = (words: string[]) => words.some((w) => containsWord(t, w) >= 0);

  if (has(QUOTE_WORDS) && supId && mentions.length) {
    for (const [s, e, sku] of mentions.slice(0, 3)) {
      const pm = new RegExp("(?:₹|rs\\.?\\s*)\\s*" + NUM + "|" + NUM + "\\s*(?:each|per unit|/unit|rupees? each)").exec(raw);
      const price = pm ? num(pm[1] || pm[2]) : null;
      const qty = qtyForMention(raw, s, e);
      u.events.push({ type: "SUPPLIER_QUOTE", supplier_text: u.supplier_text, items: [{ product: text.slice(s, e), sku, qty, unit_price: price }],
        delivery_days: deliveryDays, moq: moq || (qty ? Math.trunc(qty) : null), credit_days: creditDays, confidence: price ? 0.94 : 0.6,
        note: price ? "" : "Unit price not found" });
    }
    return u;
  }
  if (has(DAMAGE_WORDS) && mentions.length) {
    for (const [s, e, sku] of mentions) {
      const qty = qtyForMention(raw, s, e);
      u.events.push({ type: "DAMAGED_STOCK", items: [{ product: text.slice(s, e), sku, qty }], confidence: qty ? 0.9 : 0.55, note: qty ? "" : "Quantity not found" });
    }
    return u;
  }
  if (has(SALE_WORDS) && mentions.length) {
    for (const [s, e, sku] of mentions) {
      const qty = qtyForMention(raw, s, e);
      u.events.push({ type: "SALE", items: [{ product: text.slice(s, e), sku, qty, unit_price: null }], confidence: qty ? 0.88 : 0.55, note: "" });
    }
    return u;
  }
  if (amount && has(PAY_IN_WORDS) && !mentions.length) {
    if (supId && has(PAY_OUT_WORDS)) u.events.push({ type: "PAYMENT_MADE", items: [], supplier_text: u.supplier_text, amount, confidence: 0.9, note: "" });
    else u.events.push({ type: "PAYMENT_RECEIVED", items: [], customer_text: custText, amount, confidence: customerMentioned ? 0.94 : 0.5, note: customerMentioned ? "" : "Payer not identified" });
    return u;
  }
  if (mentions.length && (has(ORDER_WORDS) || ["message", "voice"].includes(kind))) {
    const items = mentions.map(([s, e, sku]) => ({ product: text.slice(s, e), sku, qty: qtyForMention(raw, s, e) }));
    const missing = items.some((i) => i.qty === null);
    u.events.push({ type: "CUSTOMER_ORDER", items, customer_text: custText, due: dueFromText(t),
      confidence: !missing && customerMentioned ? 0.95 : !missing ? 0.7 : 0.5,
      note: [missing ? "Quantity missing for some items" : "", customerMentioned ? "" : "Customer not identified"].filter(Boolean).join("; ") });
    if (amount && has(PAY_IN_WORDS)) u.events.unshift({ type: "PAYMENT_RECEIVED", items: [], customer_text: custText, amount, confidence: customerMentioned ? 0.93 : 0.5, note: "" });
    return u;
  }
  u.notice = "No business event recognised. Rephrase, add quantities/prices, or enter it manually.";
  return u;
}

export const EVENT_TYPES = ["PURCHASE_RECEIVED", "SUPPLIER_QUOTE", "CUSTOMER_ORDER", "PAYMENT_RECEIVED", "PAYMENT_MADE", "SALE", "DAMAGED_STOCK"];

export function geminiPrompt(c: Catalog, kind: string, sender: string | null | undefined) {
  return `You are the SEE layer of OFFLIMITS, a merchant intelligence system for an Indian small shop.
Read the input (it may be Hindi, English or Hinglish) and extract business events.
Use ONLY information present in the input. Do not invent quantities or prices; use null when absent.
Event types: PURCHASE_RECEIVED (supplier invoice/receipt lines), SUPPLIER_QUOTE (quotation/price offer),
CUSTOMER_ORDER (a customer wants goods), PAYMENT_RECEIVED (a customer paid us), PAYMENT_MADE (we paid a supplier),
SALE (counter sale), DAMAGED_STOCK.
Known products: ${c.items.map((i) => `${i.sku} ${i.name}`).join(", ")}
Known suppliers: ${c.suppliers.map((s) => `${s.short_name} (${s.name})`).join(", ")}
Known customers: ${c.customers.map((x) => x.name).join(", ")}
Input kind: ${kind}. Sender (if known): ${sender || "unknown"}.
Return JSON exactly in this shape:
{"transcript": string|null, "document_type": "invoice"|"quotation"|"receipt"|"message"|"other",
 "document_no": string|null, "supplier": string|null, "customer": string|null,
 "events": [{"type": string, "items": [{"product": string, "qty": number|null, "unit_price": number|null}],
   "amount": number|null, "delivery_days": integer|null, "moq": integer|null, "credit_days": integer|null,
   "due": "today"|"tomorrow"|string|null, "confidence": number, "note": string}]}
For audio, put the verbatim transcript in "transcript". Confidence is your certainty 0..1.`;
}

/** Normalise Gemini JSON into the same Understanding the rule parser produces. */
export function fromGemini(raw: any, matcher: EntityMatcher, text: string | null, sender?: string | null): Understanding {
  const u: Understanding = { mode: "gemini", text: raw.transcript || text, document_type: raw.document_type ?? null, document_no: raw.document_no ?? null,
    supplier_text: raw.supplier ?? null, customer_text: raw.customer ?? null, events: [], notice: null };
  for (const e of raw.events || []) {
    if (!EVENT_TYPES.includes(e.type)) continue;
    const items = (e.items || []).map((it: any) => { const [sku, mc] = matcher.productToSku(it.product); return { product: it.product, sku, qty: it.qty, unit_price: it.unit_price, match_conf: mc }; });
    let due = e.due;
    if (due === "today" || due === "tomorrow") due = new Date(Date.now() + (due === "tomorrow" ? 86400000 : 0)).toISOString().slice(0, 10);
    let conf = Number(e.confidence || 0.8);
    if (items.some((i: any) => !i.sku)) conf = Math.min(conf, 0.5);
    u.events.push({ type: e.type, items, supplier_text: u.supplier_text, customer_text: [u.customer_text, sender, text].filter(Boolean).join(" ") || null,
      amount: e.amount, delivery_days: e.delivery_days, moq: e.moq, credit_days: e.credit_days, due, confidence: Math.round(conf * 100) / 100, note: e.note || "" });
  }
  if (!u.events.length) u.notice = "Gemini did not find a business event in this input.";
  return u;
}
