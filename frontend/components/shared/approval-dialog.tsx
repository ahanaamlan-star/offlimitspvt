"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Pencil, ShieldAlert, TriangleAlert, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { KV } from "@/components/shared/bits";
import { api, ApiError, notifyChanged } from "@/lib/api";
import { inr } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PurchaseOrder, Recommendation } from "@/types";

export interface ApproveResult {
  purchase_order: PurchaseOrder; approval: { id: string; actor: string }; before: any; after: any;
}

const FLOW_OK = ["RECOMMENDED", "APPROVED", "EXECUTED", "RECORDED"];
const FLOW_NO = ["RECOMMENDED", "REJECTED", "RECORDED"];

/** Visual state machine: RECOMMENDED → APPROVED → EXECUTED → RECORDED (or → REJECTED → RECORDED). */
export function StateFlow({ rejected, reached }: { rejected?: boolean; reached: number }) {
  const flow = rejected ? FLOW_NO : FLOW_OK;
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[10.5px] font-bold tracking-wider" aria-label="Decision state">
      {flow.map((st, i) => (
        <React.Fragment key={st}>
          <li className={cn("rounded-full px-2 py-1", i <= reached ? (st === "REJECTED" ? "bg-red-600 text-white" : "bg-emerald-600 text-white") : "bg-slate-100 text-slate-400",
            i === reached && "ring-2 ring-offset-1 " + (st === "REJECTED" ? "ring-red-300" : "ring-emerald-300"))}>{st}</li>
          {i < flow.length - 1 && <ArrowRight className={cn("h-3 w-3", i < reached ? "text-emerald-600" : "text-slate-300")} />}
        </React.Fragment>
      ))}
    </ol>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[118px_minmax(0,1fr)] gap-2 border-b border-slate-100 py-2 last:border-0">
      <div className="pt-0.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-slate-500">{k}</div>
      <div className="min-w-0 text-sm text-slate-800">{children}</div>
    </div>
  );
}

export function ApprovalDialog({ rec: recProp, open, onOpenChange, onDone, initialSupplierId }:
  { rec: Recommendation | null; open: boolean; onOpenChange: (o: boolean) => void; onDone?: (r: ApproveResult) => void; initialSupplierId?: string }) {
  // Keep the reviewed recommendation on screen after it leaves the pending list (approved / rejected).
  const last = React.useRef<Recommendation | null>(null);
  if (recProp) last.current = recProp;
  const rec = recProp ?? (open ? last.current : null);
  const recId = rec?.id;
  const [supplierId, setSupplierId] = React.useState("");
  const [qty, setQty] = React.useState<number>(0);
  const [ack, setAck] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string[] | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState("Not needed right now");
  const [outcome, setOutcome] = React.useState<{ kind: "approved"; res: ApproveResult } | { kind: "rejected"; id: string } | null>(null);
  const [source, setSource] = React.useState<{ title: string; id: string; ref: string | null; conf: number | null } | null>(null);

  React.useEffect(() => {
    if (rec && open) {
      const sid = initialSupplierId ?? rec.supplier_id;
      const o = rec.comparison.options.find((x) => x.supplier_id === sid);
      setSupplierId(sid);
      setQty(sid === rec.supplier_id ? rec.qty : o?.qty ?? rec.qty);
      setAck(false); setNote(""); setErr(null); setEditing(sid !== rec.supplier_id); setRejecting(false); setOutcome(null); setSource(null);
      if (rec.trigger_event_id) {
        api.get<any>(`/api/events/${rec.trigger_event_id}`).then((e) => {
          const chain = [...(e.trace?.upstream ?? []), e];
          const confs = chain.map((x: any) => x.confidence).filter((c: any) => typeof c === "number");
          const origin = chain.find((x: any) => x.category === "SOURCE") ?? chain[0];
          setSource({ title: e.title, id: e.id, ref: origin?.source_ref ?? e.source_ref, conf: confs.length ? Math.min(...confs) : null });
        }).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recId, open, initialSupplierId]);

  if (!rec) return null;
  const opt = rec.comparison.options.find((o) => o.supplier_id === supplierId) ?? rec.comparison.options[0];
  const total = Math.round(qty * opt.unit_price * 100) / 100;
  const cashNow = opt.credit_days > 0 ? 0 : total;
  const covers = qty >= rec.comparison.need_qty;
  const excess = Math.max(0, qty - rec.comparison.target_max);
  const tooSmall = qty < opt.moq;
  const risk: any = (rec.comparison as any).risk;
  const actionRisk = !covers || !opt.on_time ? "HIGH" : excess > 0 ? "MEDIUM" : "LOW";

  async function approve() {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<ApproveResult>(`/api/recommendations/${rec!.id}/approve`,
        { supplier_id: supplierId, qty, note: note || undefined, acknowledged: ack });
      toast.success(`${res.purchase_order.id} generated · approved by ${res.approval.actor}`);
      setOutcome({ kind: "approved", res });
      notifyChanged();
      window.dispatchEvent(new CustomEvent("offlimits:approved", { detail: { po_id: res.purchase_order.id, actor: res.approval.actor, before: res.before, after: res.after } }));
      onDone?.(res);
    } catch (e) {
      setErr((e as ApiError).details);
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/api/recommendations/${rec!.id}/reject`, { reason });
      toast.success(`${rec!.id} rejected — recorded in the ledger`);
      setOutcome({ kind: "rejected", id: rec!.id });
      notifyChanged();
    } catch (e) {
      setErr((e as ApiError).details);
    } finally {
      setBusy(false);
    }
  }

  const reached = outcome?.kind === "approved" ? 3 : outcome?.kind === "rejected" ? 2 : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title={outcome ? (outcome.kind === "approved" ? "Approved & recorded" : "Rejected & recorded") : "Human approval required"} description={`${rec.id} · ${rec.item}`}>
        <div className="mb-3"><StateFlow rejected={rejecting || outcome?.kind === "rejected"} reached={reached} /></div>

        {outcome?.kind === "approved" ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <b>{outcome.res.approval.actor}</b> approved ({outcome.res.approval.id}) → <b>{outcome.res.purchase_order.id}</b> executed → events recorded in the ledger.
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[["Predicted shortage", `${outcome.res.before.predicted_shortage}`, `${outcome.res.after.predicted_shortage} units`], ["Incoming", `${outcome.res.before.incoming}`, `${outcome.res.after.incoming}`],
                ["Cash", inr(outcome.res.before.cash), inr(outcome.res.after.cash)], ["Payables", inr(outcome.res.before.payables), inr(outcome.res.after.payables)]].map(([k, x, y]) => (
                <KV key={k} label={k} value={<span className="num"><span className="text-slate-400 line-through">{x}</span> → <span className="text-emerald-700">{y}</span></span>} />
              ))}
            </div>
            <div className="flex gap-2">
              <Button className="flex-1" asChild><Link href={`/act/purchase-orders/view?id=${outcome.res.purchase_order.id}`} onClick={() => onOpenChange(false)}>View purchase order</Link></Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
            </div>
          </div>
        ) : outcome?.kind === "rejected" ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">Recommendation {outcome.id} rejected. The decision and reason are recorded in the ledger; nothing was purchased.</div>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <div><b>This action changes business state.</b> Nothing happens until you approve. Approval creates a purchase order and records it in the event ledger.</div>
            </div>
            <div className="rounded-lg border border-slate-200 px-3">
              <Row k="Action">Buy <b>{qty} × {rec.item}</b> from <b>{opt.supplier_name ?? opt.supplier}</b> ({opt.supplier}) @ {inr(opt.unit_price)} = <b>{inr(total)}</b> · delivery {opt.delivery_label.toLowerCase()}</Row>
              <Row k="Why">{rec.explanation}</Row>
              <Row k="Source">{source ? <span>{source.title} <span className="font-mono text-xs text-slate-500">({source.id}{source.ref ? ` · ${source.ref}` : ""})</span></span> : rec.trigger_event_id ? <span className="font-mono text-xs">{rec.trigger_event_id}</span> : "Seeded demo history (DEMO DATA)"}
                {risk && <div className="text-xs text-slate-500">{risk.reason}</div>}</Row>
              <Row k="Expected impact">{covers ? `Prevents the predicted shortage of ${rec.comparison.need_qty} units` : `Covers only ${qty} of ${rec.comparison.need_qty} short units — stockout risk remains`}{opt.on_time ? ", arriving before the need-by date." : " — but arrives after the need-by date."}</Row>
              <Row k="Financial impact">{inr(total)} purchase · cash now <b>{cashNow ? `−${inr(cashNow)}` : "₹0"}</b>{opt.credit_days ? ` · ${inr(total)} payable in ${opt.credit_days} days` : " · paid on delivery"}</Row>
              <Row k="Inventory impact">+{qty} incoming {rec.item}{excess ? ` · ~${excess} units above the 7-day need` : " · no excess beyond the 7-day need"}</Row>
              <Row k="Risk"><span className={cn("rounded px-1.5 py-0.5 font-mono text-xs font-bold", actionRisk === "LOW" ? "bg-emerald-100 text-emerald-800" : actionRisk === "MEDIUM" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800")}>{actionRisk}</span>
                <span className="ml-2 text-xs text-slate-500">Business risk addressed: {risk?.severity ?? "—"} {risk?.type?.replace(/_/g, " ").toLowerCase() ?? ""}</span></Row>
              <Row k="Confidence">{source?.conf != null ? <><b>{Math.round(source.conf * 100)}%</b> <span className="text-xs text-slate-500">lowest confidence among the source inputs</span></> : <b>High</b>}
                <div className="text-xs text-slate-500">Quantities, prices and scores are deterministic business rules (supplier score {opt.score}/100).</div></Row>
            </div>

            {editing && (
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3">
                <div>
                  <Label htmlFor="sup">Supplier</Label>
                  <Select id="sup" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); const o = rec.comparison.options.find((x) => x.supplier_id === e.target.value); if (o) setQty(o.qty); }}>
                    {rec.comparison.options.map((o) => <option key={o.supplier_id} value={o.supplier_id}>{o.supplier} · ₹{o.unit_price}{o.recommended ? " (recommended)" : ""}</option>)}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="qty">Quantity</Label>
                  <Input id="qty" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(0, parseInt(e.target.value || "0", 10)))} />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="note">Note (optional)</Label>
                  <Textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Confirmed delivery slot by phone" />
                </div>
                {tooSmall && <p className="col-span-2 text-sm text-red-600">{opt.supplier} requires at least {opt.moq} units.</p>}
              </div>
            )}

            {rejecting ? (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50/50 p-3">
                <Label htmlFor="reason">Reason for rejecting (recorded in the ledger)</Label>
                <Textarea id="reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="mt-2 flex gap-2">
                  <Button variant="danger" onClick={reject} disabled={busy || !reason.trim()}>{busy ? "Rejecting…" : "Confirm reject"}</Button>
                  <Button variant="outline" onClick={() => setRejecting(false)}>Back</Button>
                </div>
              </div>
            ) : (
              <>
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-4 w-4 accent-indigo-600" />
                  I reviewed the action, its impact and the supporting evidence.
                </label>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button className="flex-1" onClick={approve} disabled={!ack || busy || tooSmall || qty <= 0}><CheckCircle2 /> {busy ? "Approving…" : "Approve"}</Button>
                  <Button variant="outline" onClick={() => setEditing((e) => !e)}><Pencil /> {editing ? "Done editing" : "Edit"}</Button>
                  <Button variant="danger" onClick={() => setRejecting(true)}><XCircle /> Reject</Button>
                </div>
              </>
            )}
          </>
        )}
        {err && <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{err.join("; ")}</div>}
      </DialogContent>
    </Dialog>
  );
}

function Check({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={`flex items-center gap-2 ${ok ? "text-emerald-800" : "text-amber-800"}`}>
      {ok ? <CheckCircle2 className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />} {text}
    </li>
  );
}

export function RejectButton({ rec, size = "sm" }: { rec: Recommendation; size?: "sm" | "default" }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Button variant="danger" size={size} disabled={busy} onClick={async () => {
      const reason = window.prompt("Reason for rejecting (recorded in the ledger)", "Not needed right now");
      if (reason === null) return;
      setBusy(true);
      try {
        await api.post(`/api/recommendations/${rec.id}/reject`, { reason });
        toast.success(`${rec.id} rejected`);
        notifyChanged();
      } catch (e) {
        toast.error((e as ApiError).details.join("; "));
      } finally {
        setBusy(false);
      }
    }}>Reject</Button>
  );
}
