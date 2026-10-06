"use client";
import * as React from "react";
import { CheckCircle2, Edit3 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Confidence, StatusBadge } from "@/components/shared/bits";
import { useEventDrawer } from "@/components/shared/event-drawer";
import { useApi } from "@/hooks/useApi";
import { api, ApiError, notifyChanged } from "@/lib/api";
import { inr, time, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Artifact, InventoryRow, LedgerEvent, Proposal } from "@/types";

const LABELS: Record<string, string> = { supplier_id: "Supplier", customer_id: "Customer", sku: "SKU", po_id: "Matched PO",
  invoice_no: "Invoice no.", unit_cost: "Unit cost", unit_price: "Unit price", moq: "MOQ", quoted_qty: "Quoted qty" };

export function ProposalCard({ p, threshold, onUpdate, artifact }: { p: Proposal; threshold: number; onUpdate: (p: Proposal) => void; artifact: Artifact }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, any>>(p.payload);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<{ event: LedgerEvent; intelligence: LedgerEvent[] } | null>(null);
  const [err, setErr] = React.useState<string[] | null>(null);
  const drawer = useEventDrawer();
  const { data: inv } = useApi<InventoryRow[]>(editing ? "/api/inventory" : null);
  React.useEffect(() => setDraft(p.payload), [p.payload]);

  async function confirm(overrides?: Record<string, any>) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ event: LedgerEvent; proposal: Proposal; intelligence: LedgerEvent[] }>(`/api/proposals/${p.id}/confirm`,
        { overrides: overrides ?? (editing ? draft : undefined) });
      setDone(r);
      onUpdate(r.proposal);
      setEditing(false);
      notifyChanged();
      toast.success(`${r.event.id} recorded in the event ledger`);
      r.intelligence.forEach((i) => toast.warning(`${i.title}: ${i.change}`));
    } catch (e) { setErr((e as ApiError).details); } finally { setBusy(false); }
  }
  async function act(path: string) {
    const r = await api.post<Proposal>(`/api/proposals/${p.id}/${path}`, {});
    onUpdate(r);
    notifyChanged();
  }

  const tone = p.type.includes("PRICE") ? "border-amber-200 bg-amber-50/60" : p.status === "NEEDS_REVIEW" ? "border-amber-300 bg-white" : "border-indigo-200 bg-indigo-50/40";
  const fields = Object.entries(p.payload).filter(([k]) => k !== "items");
  return (
    <div className={cn("rounded-lg border p-3", tone, p.status === "CONFIRMED" && "border-emerald-200 bg-emerald-50/50", p.status === "REJECTED" && "opacity-60")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cn("font-mono text-[11px] font-bold tracking-wide", p.type.includes("PRICE") ? "text-amber-700" : "text-indigo-700")}>{p.type}</span>
        <StatusBadge s={p.status} />
      </div>
      <div className="mt-1 text-sm font-semibold text-slate-900">{p.names.sku ?? p.names.customer ?? p.names.supplier ?? ""}</div>
      <div className="text-sm text-slate-600">{p.summary}</div>

      {!editing && (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {fields.map(([k, v]) => (
            <div key={k}><span className="text-slate-400">{LABELS[k] ?? titleCase(k)}: </span><span className="font-medium text-slate-700">
              {k === "supplier_id" ? p.names.supplier ?? v ?? "—" : k === "customer_id" ? p.names.customer ?? v ?? "—" : k === "sku" ? v ?? "—" :
                typeof v === "number" && /price|cost|amount/.test(k) ? inr(v) : v === null || v === undefined || v === "" ? "—" : String(v)}</span></div>
          ))}
          {p.payload.items?.map((it: any, i: number) => (
            <div key={i}><span className="text-slate-400">Item: </span><span className="font-medium text-slate-700">{it.qty ?? "?"} × {p.names.items?.[i] ?? it.sku ?? "unknown"}</span></div>
          ))}
        </div>
      )}

      {editing && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {fields.map(([k, v]) => (
            <div key={k}><Label>{LABELS[k] ?? titleCase(k)}</Label>
              {k === "sku" ? (
                <Select value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}>
                  <option value="">Select SKU</option>{inv?.map((r) => <option key={r.sku} value={r.sku}>{r.sku} · {r.name}</option>)}
                </Select>
              ) : (
                <Input value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: typeof v === "number" || /qty|price|cost|amount|days|moq/.test(k) ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value })} />
              )}
            </div>
          ))}
          {draft.items?.map((it: any, i: number) => (
            <div key={i} className="col-span-2 grid grid-cols-2 gap-2">
              <div><Label>Item {i + 1} SKU</Label><Select value={it.sku ?? ""} onChange={(e) => setDraft({ ...draft, items: draft.items.map((x: any, j: number) => j === i ? { ...x, sku: e.target.value } : x) })}>
                <option value="">Select SKU</option>{inv?.map((r) => <option key={r.sku} value={r.sku}>{r.sku} · {r.name}</option>)}</Select></div>
              <div><Label>Qty</Label><Input type="number" value={it.qty ?? ""} onChange={(e) => setDraft({ ...draft, items: draft.items.map((x: any, j: number) => j === i ? { ...x, qty: Number(e.target.value) } : x) })} /></div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/70 pt-2 text-[11px] text-slate-500">
        <span>Source: {artifact.filename ?? (artifact.sender ? `${titleCase(artifact.kind)} · ${artifact.sender}` : titleCase(artifact.kind))}</span>
        <span>{time(p.created_at)}</span>
        <Confidence value={p.confidence} threshold={threshold} />
      </div>

      {p.status === "NEEDS_REVIEW" && p.review_reason && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"><b>NEEDS REVIEW — </b>{p.review_reason}</div>
      )}
      {p.candidates.length > 0 && p.status !== "CONFIRMED" && p.status !== "REJECTED" && (
        <div className="mt-2">
          <div className="mb-1 text-xs font-semibold text-slate-700">Which {p.candidates[0].field === "customer_id" ? "customer" : "supplier"} is correct?</div>
          <div className="flex flex-wrap gap-1.5">
            {p.candidates.map((c) => <Button key={c.id} size="sm" variant="outline" disabled={busy} onClick={() => confirm({ [c.field]: c.id })}>{c.name}</Button>)}
            <Button size="sm" variant="ghost" onClick={() => act("review-later")}>Review later</Button>
          </div>
        </div>
      )}
      {err && <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err.join("; ")}</div>}

      {(p.status === "PROPOSED" || (p.status === "NEEDS_REVIEW" && !p.candidates.length)) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => confirm()} disabled={busy}><CheckCircle2 /> {editing ? "Save & confirm" : "Confirm"}</Button>
          <Button size="sm" variant="outline" onClick={() => setEditing((e) => !e)}><Edit3 /> {editing ? "Cancel edit" : "Edit"}</Button>
          <Button size="sm" variant="ghost" onClick={() => act("reject")}>Reject</Button>
          {p.status === "PROPOSED" && <Button size="sm" variant="ghost" onClick={() => act("review-later")}>Send to review</Button>}
        </div>
      )}
      {p.status === "CONFIRMED" && p.event_id && (
        <div className="mt-2 space-y-1">
          <button onClick={() => drawer.open(p.event_id!)} className="text-xs font-medium text-emerald-700 hover:underline">✓ Recorded as {p.event_id} — view in ledger</button>
          {done?.intelligence.map((i) => (
            <button key={i.id} onClick={() => drawer.open(i.id)} className="block text-left text-xs text-amber-800 hover:underline">⚠ {i.title}: {i.change}</button>
          ))}
        </div>
      )}
    </div>
  );
}
