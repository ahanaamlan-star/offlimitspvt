/**
 * Browser persistence for the standalone engine.
 * - Business data (JSON) → localStorage (per visitor, survives reloads).
 * - Uploaded files → IndexedDB (blobs can be large).
 * Everything is DEMO DATA and stays in this browser.
 */
import type { Customer, Item, Supplier } from "./decision";
import type { Ev } from "./state";

export interface Artifact {
  id: string; kind: string; filename: string | null; mime: string | null; size: number | null; sha256: string | null; has_file: boolean;
  text_content: string | null; sender: string | null; analysis_mode: string; note: string | null; is_demo: boolean; created_at: string;
  page_count: number | null; transcription: string | null;
}
export interface Proposal {
  id: string; artifact_id: string; type: string; payload: Record<string, any>; summary: string; confidence: number; status: string;
  review_reason: string | null; candidates: any[]; event_id: string | null; created_at: string;
}
export interface OrderRec { id: string; customer_id: string; items: any[]; value: number; due: string; status: string; created_event_id: string | null; fulfilled_event_id: string | null; created_at: string }
export interface Rec {
  id: string; kind: string; risk_key: string; sku: string; supplier_id: string; qty: number; unit_price: number; total: number; reason: string;
  explanation: string; comparison: any; status: string; trigger_event_id: string | null; decision_event_id: string | null; po_id: string | null;
  created_at: string; decided_at: string | null; decided_by: string | null;
}
export interface ApprovalRec { id: string; recommendation_id: string | null; actor: string; decision: string; note: string | null; snapshot: any; ts: string }
export interface PO {
  id: string; supplier_id: string; sku: string; qty: number; unit_price: number; total: number; credit_days: number; delivery_days: number;
  status: string; recommendation_id: string | null; approval_id: string | null; approved_by: string | null; event_id: string | null;
  received_event_id: string | null; created_at: string;
}
export interface ScenarioRec { id: string; name: string; question: string | null; inputs: any; results: any; created_at: string }

export interface DB {
  v: number; seq: number; counters: Record<string, number>;
  merchant: { id: string; name: string; owner: string; city: string; currency: string; settings: Record<string, any>; is_demo: boolean };
  users: any[]; items: Item[]; suppliers: Supplier[]; customers: Customer[]; events: Ev[]; artifacts: Artifact[]; proposals: Proposal[];
  orders: OrderRec[]; recommendations: Rec[]; approvals: ApprovalRec[]; purchase_orders: PO[]; scenarios: ScenarioRec[];
}

export const DB_KEY = "offlimits-demo-db-v1";
export const DB_VERSION = 1;

export function emptyDb(): DB {
  return { v: DB_VERSION, seq: 0, counters: {}, merchant: null as any, users: [], items: [], suppliers: [], customers: [], events: [], artifacts: [],
    proposals: [], orders: [], recommendations: [], approvals: [], purchase_orders: [], scenarios: [] };
}

export function loadDb(): DB | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DB_KEY) : null;
    if (!raw) return null;
    const db = JSON.parse(raw) as DB;
    return db.v === DB_VERSION ? db : null;
  } catch {
    return null;
  }
}

export function saveDb(db: DB) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
    // Quota or private mode: keep working in memory for this session.
  }
}

// ----------------------------------------------------------------- IndexedDB file store

const IDB = "offlimits-files";
function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open(IDB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}
const memFiles = new Map<string, Blob>();

export async function putFile(id: string, blob: Blob) {
  memFiles.set(id, blob);
  const db = await idb();
  if (!db) return;
  await new Promise<void>((res) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").put(blob, id); tx.oncomplete = () => res(); tx.onerror = () => res(); });
}
export async function getFile(id: string): Promise<Blob | null> {
  if (memFiles.has(id)) return memFiles.get(id)!;
  const db = await idb();
  if (!db) return null;
  return new Promise((res) => {
    const tx = db.transaction("files", "readonly");
    const r = tx.objectStore("files").get(id);
    r.onsuccess = () => { const b = (r.result as Blob) || null; if (b) memFiles.set(id, b); res(b); };
    r.onerror = () => res(null);
  });
}
export async function clearFiles() {
  memFiles.clear();
  const db = await idb();
  if (!db) return;
  await new Promise<void>((res) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").clear(); tx.oncomplete = () => res(); tx.onerror = () => res(); });
}
