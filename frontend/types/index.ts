export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface LedgerEvent {
  id: string; seq: number; ts: string; category: string; type: string; source_type: string;
  source_ref: string | null; actor: string; entity: string | null; entity_name: string | null;
  title: string; change: string; payload: Record<string, any>; confidence: number | null; status: string;
  reason: string | null; prev_state: Record<string, any>; new_state: Record<string, any>;
  artifact_id: string | null; approval_id: string | null; caused_by: string | null; is_demo: boolean;
}

export interface EventDetail extends LedgerEvent {
  artifact: Artifact | null; approval: ApprovalRec | null; purchase_order: PurchaseOrder | null;
  recommendation: Recommendation | null; trace: { upstream: LedgerEvent[]; downstream: LedgerEvent[] };
}

export interface Artifact {
  id: string; kind: string; filename: string | null; mime: string | null; size: number | null; sha256: string | null;
  text_content: string | null; sender: string | null; analysis_mode: string; note: string | null; is_demo: boolean;
  created_at: string; has_file: boolean; file_url: string | null; page_count?: number | null; transcription?: string | null;
}

export interface Candidate { field: string; id: string; name: string }

export interface Proposal {
  id: string; artifact_id: string; type: string; payload: Record<string, any>; names: Record<string, any>; summary: string;
  confidence: number; status: "PROPOSED" | "NEEDS_REVIEW" | "CONFIRMED" | "REJECTED"; review_reason: string | null;
  candidates: Candidate[]; event_id: string | null; created_at: string;
}

export interface Understanding {
  mode: "demo" | "gemini" | "fallback"; text: string | null; document_type: string | null; document_no: string | null;
  supplier: string | null; notice: string | null; ai_confidence: number | null;
}

export interface AnalyzeResult { artifact: Artifact; proposals: Proposal[]; understanding: Understanding; source_event: LedgerEvent }

export interface Risk {
  key: string; type: string; category: string; severity: Severity; sku: string | null; entity: string; title: string;
  metrics: Record<string, any>; reason: string; recommendation: string; action: string; orders?: string[];
  need_qty?: number; target_max?: number; evidence?: string[];
}

export interface SupplierOption {
  supplier_id: string; supplier: string; supplier_name: string; reliability: number; unit_price: number; moq: number;
  qty: number; total: number; credit_days: number; delivery_days: number; delivery_label: string; cash_required: number;
  deferred_payable: number; excess_units: number; on_time: boolean; risk: string; scores: Record<string, number>;
  score: number; notes: string[]; recommended?: boolean;
}

export interface Comparison {
  sku: string; need_qty: number; target_max: number; options: SupplierOption[]; recommended: string | null;
  why?: string[]; weights?: Record<string, number>; risk?: Risk; item?: string;
}

export interface Recommendation {
  id: string; kind: string; risk_key: string; sku: string; item: string; supplier_id: string; supplier: string;
  supplier_name: string; qty: number; unit_price: number; total: number; reason: string; explanation: string;
  comparison: Comparison; status: "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED"; trigger_event_id: string | null;
  decision_event_id: string | null; po_id: string | null; created_at: string; decided_at: string | null; decided_by: string | null;
}

export interface PurchaseOrder {
  id: string; supplier_id: string; supplier: string; supplier_name: string; sku: string; item: string; qty: number;
  unit_price: number; total: number; credit_days: number; delivery_days: number; status: string;
  recommendation_id: string | null; approval_id: string | null; approved_by: string | null; event_id: string | null;
  received_event_id: string | null; created_at: string;
}

export interface PODetail extends PurchaseOrder {
  merchant: { name: string; owner: string; city: string }; supplier_detail: { name: string; city: string };
  approval: ApprovalRec | null; trace: { upstream: LedgerEvent[]; downstream: LedgerEvent[] }; event: LedgerEvent | null;
}

export interface ApprovalRec { id: string; recommendation_id: string | null; actor: string; decision: string; note: string | null; snapshot: Record<string, any>; ts: string }

export interface InventoryRow {
  sku: string; name: string; category: string; unit: string; on_hand: number; reserved: number; available: number;
  incoming: number; reorder_point: number; forecast_daily: number; projected: number; risk: Severity;
  unit_cost: number | null; selling_price: number; margin: number | null; margin_pct: number | null; value: number;
}

export interface OrderRow {
  id: string; customer_id: string; customer: string; items: { sku: string; qty: number; unit_price: number; name: string }[];
  value: number; due: string; status: string; risk: string; created_at: string; created_event_id: string | null;
}

export interface Summary {
  inventory_value: number; inventory_units: number; skus: number; cash: number; open_orders: number; open_order_value: number;
  stockout_risks: number; low_stock: number; margin_alerts: number; pending_approvals: number; needs_review: number;
  receivables: number; payables: number; weighted_margin_pct: number; events: number; last_event_at: string | null;
}

export interface BusinessStateResp {
  summary: Summary; inventory: InventoryRow[]; orders: OrderRow[];
  cash: { opening: number; inflow: number; outflow: number; current: number;
          receivables: { customer_id: string; customer: string; amount: number }[];
          payables: { supplier_id: string; supplier: string; amount: number }[] };
  prices: { supplier_id: string; supplier: string; supplier_name: string; sku: string; item: string; unit_price: number;
            moq: number; delivery_days: number; credit_days: number; quoted_at: string | null; source_event: string }[];
  margins: { sku: string; name: string; selling_price: number; cost: number; previous_cost: number | null; margin: number;
             margin_pct: number; previous_margin_pct: number | null; anomaly: boolean }[];
  suppliers: { id: string; short_name: string; name: string; reliability: number; city: string; offers: number; payable: number }[];
}

export interface Health {
  status: string; version: string; mode: "DEMO" | "LIVE";
  ai: { provider: string; configured: boolean; live: boolean; model: string };
  voice: { provider: string; sarvam_configured: boolean };
  database: { ok: boolean; engine: string }; confidence_threshold: number; max_upload_mb: number;
}

export interface Overview {
  summary: Summary; inventory: InventoryRow[]; cash: BusinessStateResp["cash"]; orders: OrderRow[]; risks: Risk[];
  feed: LedgerEvent[]; pending: Recommendation[]; health: Health;
}

export interface SimResult {
  label: string; supplier_id: string | null; qty: number; unit_price: number; discount_pct: number; effective_price: number;
  delivery_days: number; credit_days: number; daily_demand: number; purchase_cost: number; purchase_savings: number;
  cash_outflow_now: number; deferred_payable: number; projected_stock: number; stock_at_need_by: number;
  excess_units: number; days_to_clear: number | null; capital_locked_in_excess: number; stockout_risk: string;
  margin_pct_before: number; margin_pct_after: number; margin_impact_pp: number; working_capital_impact: string;
  suggested_qty: number;
}

export interface Simulation {
  id: string; name: string; question: string | null; inputs: Record<string, any>;
  results: { scenarios: SimResult[]; verdict: { best_label: string; lines: string[]; suggested_qty: number; badges?: { best_cost: string; best_speed: string; best_coverage: string; best_balanced: string } }; sku: string; item: string; daily_demand: number };
  created_at: string;
}

export interface DemoAssets {
  assets: { name: string; folder: string; size: number; url: string; kind: string | null; label: string; transcript: string | null }[];
  messages: { label: string; kind: string; sender: string; text: string }[];
}
