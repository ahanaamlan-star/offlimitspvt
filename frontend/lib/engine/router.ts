/**
 * In-browser implementation of the OFFLIMITS REST API.
 * Same paths and JSON shapes as backend/app/api/routes.py, so the UI is identical in both modes.
 * Requests are serialised; a failed mutation is rolled back; successful ones are persisted to localStorage.
 */
import { compareSuppliers } from "./action";
import { appendEvent, getState, Masters, nextId } from "./ledger";
import { seed } from "./seed";
import { analyzeInput, demoFixtures, geminiStatus, MAX_UPLOAD_MB } from "./see";
import { clearFiles, DB, DB_KEY, getFile, loadDb, saveDb } from "./store";
import { EngineError, pyRound, sanitizeText } from "./util";
import * as views from "./views";
import * as wf from "./workflow";

export const VERSION = "1.0.0";
let DBI: DB | null = null;
const db = (): DB => {
  if (!DBI) {
    DBI = loadDb();
    if (!DBI) { DBI = seed(); saveDb(DBI); }
  }
  return DBI;
};

const objectUrls = new Map<string, string>();
async function fileUrl(id: string): Promise<string | null> {
  if (objectUrls.has(id)) return objectUrls.get(id)!;
  const b = await getFile(id);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  objectUrls.set(id, u);
  return u;
}
async function art(a: any) {
  if (!a) return null;
  const d: any = views.artifactDict(a);
  d.file_url = a.has_file ? await fileUrl(a.id) : null;
  return d;
}

async function health() {
  const ai = await geminiStatus();
  return {
    status: "online", version: VERSION, mode: ai.configured ? "LIVE" : "DEMO", runtime: "browser",
    ai: { provider: "Google Gemini (via server-side function)", configured: ai.configured, live: ai.configured, model: ai.model },
    voice: { provider: "Browser speech recognition / Gemini audio", sarvam_configured: false },
    database: { ok: true, engine: "browser (localStorage + IndexedDB)" },
    confidence_threshold: wf.threshold(db()), max_upload_mb: MAX_UPLOAD_MB,
  };
}

function settingsView() {
  const m = db().merchant;
  return { merchant: { id: m.id, name: m.name, owner: m.owner, city: m.city, currency: m.currency, is_demo: m.is_demo }, settings: m.settings };
}

const MANUAL_TYPES = new Set(["PURCHASE_RECEIVED", "SUPPLIER_QUOTE", "SUPPLIER_PRICE_UPDATE", "CUSTOMER_ORDER", "ORDER_FULFILLED", "SALE", "PAYMENT_RECEIVED", "PAYMENT_MADE", "DAMAGED_STOCK"]);
const byDesc = <T,>(arr: T[], k: (x: T) => string) => [...arr].sort((a, b) => (k(a) < k(b) ? 1 : k(a) > k(b) ? -1 : 0));
const evDesc = (evs: any[]) => [...evs].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.seq - a.seq));
const notFound = (what: string) => new EngineError(what, 404);

type Handler = (p: Record<string, string>, q: URLSearchParams, body: any) => any | Promise<any>;
const routes: [string, string, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) => routes.push([method, pattern, h]);

// ---------------------------------------------------------------- health, settings, demo
on("GET", "/api/health", () => health());
on("GET", "/api/settings", async () => ({ ...settingsView(), health: await health() }));
on("PUT", "/api/settings", async (_p, _q, b) => {
  const m = db().merchant;
  if (b?.name) m.name = sanitizeText(b.name, 120) || m.name;
  if (b?.owner) m.owner = sanitizeText(b.owner, 120) || m.owner;
  if (b?.settings) {
    for (const [k, v] of Object.entries(b.settings)) if (typeof v === "number" && v < 0) throw new EngineError(`${k} cannot be negative`);
    m.settings = { ...m.settings, ...b.settings };
  }
  return { ...settingsView(), health: await health() };
});
on("POST", "/api/demo/reset", async () => {
  await clearFiles();
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls.clear();
  DBI = seed();
  return { ok: true, message: "Demo business reset to its starting state." };
});
const ASSETS: [string, string, number][] = [
  ["images", "demo_invoice_metro_INV-2841.png", 72794], ["images", "demo_quotation_supplierB_QT-552.png", 67157],
  ["images", "demo_receipt_householdhub_HH-7802.png", 58932], ["documents", "demo_invoice_householdhub_HH-7790.pdf", 1970],
  ["audio", "demo_voice_payment_ramesh.wav", 64044],
];
on("GET", "/api/demo/assets", () => {
  const byName = Object.fromEntries(Object.values(demoFixtures()).map((v) => [v.filename, v]));
  return {
    assets: ASSETS.map(([folder, name, size]) => {
      const meta: any = byName[name] || {};
      return { name, folder, size, url: `/demo/${folder}/${name}`, kind: meta.kind ?? (folder === "documents" ? "invoice" : null), label: meta.label ?? name.replace(/\.[^.]+$/, ""), transcript: meta.transcript ?? null };
    }),
    messages: [
      { label: "Customer order (Hinglish)", kind: "message", sender: "Ramesh Stores", text: "Kal 25 Coke aur 10 Sprite bhej dena" },
      { label: "Ambiguous payment", kind: "message", sender: "", text: "Ramesh paid ₹3,000" },
      { label: "Supplier quote", kind: "quotation", sender: "Supplier B", text: "Supplier B says the price for 20 units of Coke is ₹39 each, can deliver today, 15 days credit." },
      { label: "Voice: payment (Hindi)", kind: "voice", sender: "", text: "Ramesh Stores ne 3000 rupaye de diye" },
      { label: "Counter sale", kind: "text", sender: "", text: "Aaj 5 Maggi becha" },
      { label: "Damaged stock", kind: "text", sender: "", text: "2 Sprite bottles damaged in delivery" },
    ],
  };
});

// ---------------------------------------------------------------- SEE
on("POST", "/api/inputs/analyze", async (_p, _q, form: FormData) => {
  const file = form.get("file");
  const res = await analyzeInput(db, {
    kind: String(form.get("kind") || "text"), text: (form.get("text") as string) || null, sender: (form.get("sender") as string) || null,
    file: file instanceof Blob && file.size ? file : file instanceof Blob ? file : null, filename: file instanceof File ? file.name : (form.get("filename") as string) || "upload",
  });
  const m = new Masters(db());
  return { artifact: await art(res.artifact), proposals: res.proposals.map((p) => views.proposalDict(p, m)), understanding: res.understanding,
    source_event: views.eventDict(res.source_event, m) };
});
on("GET", "/api/inputs", async (_p, q) => {
  const limit = Number(q.get("limit") || 30);
  return Promise.all(byDesc(db().artifacts, (a) => a.created_at).slice(0, limit).map(art));
});
on("GET", "/api/inputs/:id", async ({ id }) => {
  const a = db().artifacts.find((x) => x.id === id);
  if (!a) throw notFound("Unknown input");
  const m = new Masters(db());
  return { artifact: await art(a), proposals: db().proposals.filter((p) => p.artifact_id === id).map((p) => views.proposalDict(p, m)) };
});
on("GET", "/api/proposals", (_p, q) => {
  const st = q.get("status");
  const m = new Masters(db());
  return byDesc(db().proposals, (p) => p.created_at).filter((p) => !st || p.status === st).slice(0, 100).map((p) => views.proposalDict(p, m));
});
on("POST", "/api/proposals/:id/confirm", ({ id }, _q, b) => {
  const res = wf.confirmProposal(db(), id, b?.overrides, b?.actor);
  const m = new Masters(db());
  return { event: views.eventDict(res.event, m), proposal: views.proposalDict(res.proposal, m), intelligence: res.intelligence.map((e) => views.eventDict(e, m)),
    recommendations: res.recommendations.map((r) => views.recDict(r, m)) };
});
on("POST", "/api/proposals/:id/reject", ({ id }, _q, b) => views.proposalDict(wf.rejectProposal(db(), id, sanitizeText(b?.reason)), new Masters(db())));
on("POST", "/api/proposals/:id/review-later", ({ id }) => views.proposalDict(wf.reviewLater(db(), id), new Masters(db())));

// ---------------------------------------------------------------- Ledger
on("GET", "/api/events", (_p, q) => {
  let evs = evDesc(db().events);
  const cat = q.get("category"), type = q.get("type"), text = q.get("q"), entity = q.get("entity"), source = q.get("source");
  const from = q.get("from"), to = q.get("to");
  if (cat) { const s = new Set(cat.split(",")); evs = evs.filter((e) => s.has(e.category)); }
  else if (q.get("include_opening") !== "true") evs = evs.filter((e) => e.category !== "OPENING");
  if (q.get("include_pos") === "false") evs = evs.filter((e) => e.source_type !== "pos");
  if (type) { const s = new Set(type.split(",")); evs = evs.filter((e) => s.has(e.type)); }
  if (source) { const s = new Set(source.split(",")); evs = evs.filter((e) => s.has(e.source_type)); }
  if (entity) evs = evs.filter((e) => e.entity === entity);
  if (from) evs = evs.filter((e) => e.ts.slice(0, 10) >= from);
  if (to) evs = evs.filter((e) => e.ts.slice(0, 10) <= to);
  if (text) {
    const t = text.toLowerCase();
    evs = evs.filter((e) => [e.title, e.id, e.change, e.source_ref, e.entity].some((f) => (f || "").toLowerCase().includes(t)));
  }
  const m = new Masters(db());
  return evs.slice(0, Math.min(Number(q.get("limit") || 200), 1000)).map((e) => views.eventDict(e, m));
});
on("GET", "/api/events/:id", async ({ id }) => {
  const d = db();
  const e = d.events.find((x) => x.id === id);
  if (!e) throw notFound("Unknown event");
  const m = new Masters(d);
  const out: any = views.eventDict(e, m);
  out.artifact = await art(e.artifact_id ? d.artifacts.find((a) => a.id === e.artifact_id) : null);
  const apr = e.approval_id ? d.approvals.find((a) => a.id === e.approval_id) : null;
  out.approval = apr ? views.approvalDict(apr) : null;
  const po = e.payload?.po_id ? d.purchase_orders.find((p) => p.id === e.payload.po_id) : null;
  out.purchase_order = po ? views.poDict(po, m) : null;
  const rec = e.payload?.recommendation_id ? d.recommendations.find((r) => r.id === e.payload.recommendation_id) : null;
  out.recommendation = rec ? views.recDict(rec, m) : null;
  out.trace = views.trace(d, e);
  return out;
});
on("POST", "/api/events", (_p, _q, b) => {
  if (!MANUAL_TYPES.has(b?.type)) throw new EngineError(`Event type must be one of ${[...MANUAL_TYPES].sort().join(", ")}`);
  const payload = { ...(b.payload || {}) };
  if (b.type === "CUSTOMER_ORDER" && !payload.order_id) payload.order_id = nextId(db(), "order", "ORD-", 600);
  const ev = appendEvent(db(), b.type, payload, { category: "EVENT", source_type: "user", source_ref: "Manual entry", actor: b.actor || wf.ownerName(db()),
    reason: sanitizeText(b.reason) || "Manual entry", confidence: 1.0 });
  const fx = wf.afterStateChange(db(), ev.id);
  const m = new Masters(db());
  return { event: views.eventDict(ev, m), intelligence: fx.intelligence.map((e) => views.eventDict(e, m)) };
});
on("POST", "/api/events/:id/reverse", ({ id }, _q, b) => ({ event: views.eventDict(wf.reverseEvent(db(), id, b?.actor, sanitizeText(b?.reason)).event, new Masters(db())) }));

// ---------------------------------------------------------------- Business state
on("GET", "/api/business-state", () => views.businessState(db()));
on("GET", "/api/inventory", () => views.inventoryRows(db()));
on("GET", "/api/orders", () => views.businessState(db()).orders);
on("POST", "/api/orders/:id/fulfill", ({ id }, _q, b) => ({ event: views.eventDict(wf.fulfilOrder(db(), id, b?.actor).event, new Masters(db())) }));
on("GET", "/api/suppliers", () => {
  const bs = views.businessState(db());
  return bs.suppliers.map((s) => ({ ...s, prices: bs.prices.filter((p) => p.supplier_id === s.id) }));
});
on("GET", "/api/customers", () => {
  const st = getState(db());
  return [...db().customers].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => ({ ...c, receivable: pyRound(st.receivables[c.id] || 0, 2) }));
});

// ---------------------------------------------------------------- THINK
on("GET", "/api/risks", () => wf.currentRisks(db()));
on("GET", "/api/suppliers/compare/:sku", ({ sku }, q) => {
  const d = db();
  const m = new Masters(d);
  if (!m.itemsBySku[sku]) throw notFound("Unknown SKU");
  const state = getState(d);
  const cfg = wf.riskConfig(d);
  const risk = wf.currentRisks(d, state, m).find((r) => r.sku === sku && r.need_qty) || null;
  const need = Number(q.get("qty")) || (risk ? risk.need_qty : 1);
  const target = Math.max(need, risk ? risk.target_max : need);
  return { ...compareSuppliers(state, sku, need, target, cfg.horizon_days, m.suppliers), risk, item: m.itemName(sku) };
});
const simCheck = (b: any) => {
  if (!b?.sku || !Array.isArray(b.scenarios) || b.scenarios.length < 1 || b.scenarios.length > 6) throw new EngineError("Provide a SKU and 1–6 scenarios.", 422);
};
on("POST", "/api/simulations/preview", (_p, _q, b) => { simCheck(b); return wf.previewSimulation(db(), b.sku, b.scenarios); });
on("POST", "/api/simulations", (_p, _q, b) => { simCheck(b); return views.scenarioDict(wf.runSimulation(db(), b.sku, b.scenarios, sanitizeText(b.name, 160), sanitizeText(b.question, 500))); });
on("GET", "/api/simulations", () => byDesc(db().scenarios, (s) => s.created_at).slice(0, 20).map(views.scenarioDict));
on("GET", "/api/simulations/:id", ({ id }) => {
  const s = db().scenarios.find((x) => x.id === id);
  if (!s) throw notFound("Unknown simulation");
  return views.scenarioDict(s);
});

// ---------------------------------------------------------------- ACT
on("GET", "/api/recommendations", (_p, q) => {
  const st = q.get("status");
  const s = st ? new Set(st.split(",")) : null;
  const m = new Masters(db());
  return byDesc(db().recommendations, (r) => r.created_at).filter((r) => !s || s.has(r.status)).map((r) => views.recDict(r, m));
});
on("GET", "/api/recommendations/:id", ({ id }) => {
  const r = db().recommendations.find((x) => x.id === id);
  if (!r) throw notFound("Unknown recommendation");
  return views.recDict(r, new Masters(db()));
});
on("POST", "/api/recommendations/:id/approve", ({ id }, _q, b) => {
  const res = wf.approveRecommendation(db(), id, { actor: b?.actor, supplier_id: b?.supplier_id, qty: b?.qty, note: sanitizeText(b?.note), acknowledged: !!b?.acknowledged });
  const m = new Masters(db());
  return { purchase_order: views.poDict(res.purchase_order, m), approval: views.approvalDict(res.approval), events: res.events.map((e) => views.eventDict(e, m)), before: res.before, after: res.after };
});
on("POST", "/api/recommendations/:id/reject", ({ id }, _q, b) => views.recDict(wf.rejectRecommendation(db(), id, b?.actor, sanitizeText(b?.reason)), new Masters(db())));
on("GET", "/api/purchase-orders", () => {
  const m = new Masters(db());
  return byDesc(db().purchase_orders, (p) => p.created_at).map((p) => views.poDict(p, m));
});
on("GET", "/api/purchase-orders/:id", ({ id }) => {
  const d = db();
  const po = d.purchase_orders.find((p) => p.id === id);
  if (!po) throw notFound("Unknown purchase order");
  const m = new Masters(d);
  const out: any = views.poDict(po, m);
  out.merchant = { name: d.merchant.name, owner: d.merchant.owner, city: d.merchant.city };
  out.supplier_detail = { name: m.suppliers[po.supplier_id].name, city: m.suppliers[po.supplier_id].city };
  const apr = po.approval_id ? d.approvals.find((a) => a.id === po.approval_id) : null;
  out.approval = apr ? views.approvalDict(apr) : null;
  const ev = po.event_id ? d.events.find((e) => e.id === po.event_id) : null;
  out.trace = ev ? views.trace(d, ev) : { upstream: [], downstream: [] };
  out.event = ev ? views.eventDict(ev, m) : null;
  return out;
});
on("POST", "/api/purchase-orders", (_p, _q, b) => {
  const res = wf.createPurchaseOrder(db(), { sku: b?.sku, supplier_id: b?.supplier_id, qty: Math.trunc(Number(b?.qty)), actor: b?.actor, acknowledged: !!b?.acknowledged, note: sanitizeText(b?.note) || undefined });
  return { purchase_order: views.poDict(res.purchase_order, new Masters(db())) };
});
on("POST", "/api/purchase-orders/:id/receive", ({ id }, _q, b) => {
  const res = wf.receivePurchaseOrder(db(), id, b?.qty, b?.actor);
  const m = new Masters(db());
  return { event: views.eventDict(res.event, m), purchase_order: views.poDict(res.purchase_order, m) };
});

// ---------------------------------------------------------------- Analytics & overview
on("GET", "/api/analytics", () => views.analytics(db()));
on("GET", "/api/overview", async () => {
  const d = db();
  const bs = views.businessState(d);
  const m = new Masters(d);
  const feed = evDesc(d.events.filter((e) => e.category !== "OPENING" && e.source_type !== "pos")).slice(0, 12);
  const pending = byDesc(d.recommendations.filter((r) => r.status === "PENDING"), (r) => r.created_at);
  return { summary: bs.summary, inventory: bs.inventory, cash: bs.cash, orders: bs.orders.slice(0, 6), risks: wf.currentRisks(d),
    feed: feed.map((e) => views.eventDict(e, m)), pending: pending.map((r) => views.recDict(r, m)), health: await health() };
});

// ---------------------------------------------------------------- dispatcher

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/"), b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

let queue: Promise<unknown> = Promise.resolve();

export interface LocalResponse { status: number; body: any }

/** Handle one API call entirely in the browser. */
export function handleLocal(method: string, url: string, body?: any): Promise<LocalResponse> {
  const run = async (): Promise<LocalResponse> => {
    const u = new URL(url, "http://local");
    const path = u.pathname.replace(/\/+$/, "");
    let found: [Handler, Record<string, string>] | null = null;
    for (const [mth, pat, h] of routes) {
      if (mth !== method) continue;
      const p = match(pat, path);
      if (p) { found = [h, p]; break; }
    }
    if (!found) return { status: 404, body: { detail: [`Not found: ${method} ${path}`] } };
    const mutating = method !== "GET";
    const before = mutating ? JSON.stringify(db()) : null;
    try {
      const out = await found[0](found[1], u.searchParams, body);
      if (mutating) saveDb(db());
      return { status: method === "POST" && /\/api\/(events|simulations|purchase-orders)$/.test(path) ? 201 : 200, body: JSON.parse(JSON.stringify(out ?? null)) };
    } catch (e: any) {
      if (before) DBI = JSON.parse(before);
      if (e instanceof EngineError) return { status: e.status, body: { detail: e.errors } };
      console.error("[offlimits engine]", e);
      return { status: 500, body: { detail: [`Internal error: ${e?.message || e}`] } };
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

/** For tests / debugging. */
export const _engine = { db, DB_KEY };
