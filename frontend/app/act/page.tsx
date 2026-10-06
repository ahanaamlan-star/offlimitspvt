"use client";
import * as React from "react";
import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Calculator, CheckCircle2, Info, PackageCheck, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Empty, ErrorState, Loading, PageHeader, StatusBadge } from "@/components/shared/bits";
import { ApprovalDialog, type ApproveResult, RejectButton } from "@/components/shared/approval-dialog";
import { useEventDrawer } from "@/components/shared/event-drawer";
import { useApi } from "@/hooks/useApi";
import { api, ApiError, notifyChanged } from "@/lib/api";
import { dateTime, inr, num } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Comparison, Recommendation, Summary, SupplierOption } from "@/types";

export default function ActPage() {
  return <Suspense fallback={<Loading />}><Act /></Suspense>;
}

function Act() {
  const params = useSearchParams();
  const router = useRouter();
  const recs = useApi<Recommendation[]>("/api/recommendations");
  const state = useApi<{ summary: Summary }>("/api/business-state");
  const recParam = params.get("rec");
  const skuParam = params.get("sku");
  const [approveOpen, setApproveOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string | undefined>();
  const [result, setResult] = React.useState<ApproveResult | null>(null);

  const all = recs.data ?? [];
  const pending = all.filter((r) => r.status === "PENDING");
  const rec = recParam ? all.find((r) => r.id === recParam) : skuParam ? pending.find((r) => r.sku === skuParam) : pending[0];

  React.useEffect(() => { setSelected(rec?.supplier_id); }, [rec?.id, rec?.supplier_id]);
  React.useEffect(() => { if (params.get("approve") === "1" && rec?.status === "PENDING") setApproveOpen(true); }, [params, rec?.id, rec?.status]);
  React.useEffect(() => { setResult(null); }, [recParam]);

  if (recs.error) return <ErrorState error={recs.error} onRetry={recs.reload} />;
  if (!recs.data) return <Loading />;

  return (
    <div>
      <PageHeader kicker="Act" title="Procurement Decision" subtitle="Turn a recommendation into a controlled business action. Find the best option for the business — not simply the lowest price." />
      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader><CardTitle>Action queue</CardTitle><Badge tone="indigo">{pending.length} pending</Badge></CardHeader>
          <CardContent className="space-y-1.5 px-3">
            {all.length === 0 && <Empty title="No recommendations yet" />}
            {all.slice(0, 14).map((r) => (
              <button key={r.id} onClick={() => router.push(`/act?rec=${r.id}`)}
                className={cn("w-full rounded-lg border px-3 py-2 text-left transition-colors", rec?.id === r.id ? "border-brand bg-brand-soft" : "border-slate-200 hover:bg-slate-50")}>
                <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold text-slate-800">{r.item}</span><StatusBadge s={r.status} /></div>
                <div className="num text-xs text-slate-500">{r.id} · {r.qty} × {r.supplier} · {inr(r.total)}</div>
              </button>
            ))}
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          {result && <ResultPanel r={result} />}
          {rec ? (
            <RecView rec={rec} cash={state.data?.summary.cash ?? 0} selected={selected} setSelected={setSelected}
              onApprove={() => setApproveOpen(true)} />
          ) : skuParam ? <ManualCompare sku={skuParam} /> : (
            <Empty title="Nothing to decide right now" icon={<ShoppingCart className="h-8 w-8" />}>Recommendations appear when THINK detects a stockout or low-stock risk.</Empty>
          )}
        </div>
      </div>
      <ApprovalDialog rec={rec ?? null} open={approveOpen} initialSupplierId={selected}
        onOpenChange={(o) => { setApproveOpen(o); if (!o && params.get("approve")) router.replace(`/act?rec=${rec?.id}`, { scroll: false }); }}
        onDone={(r) => setResult(r)} />
    </div>
  );
}

function ResultPanel({ r }: { r: ApproveResult }) {
  const b = r.before, a = r.after;
  return (
    <Card className="border-emerald-200 bg-emerald-50/50">
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-emerald-800"><CheckCircle2 className="h-5 w-5" /><span className="font-semibold">Approved by {r.approval.actor} → {r.purchase_order.id} executed and recorded</span></div>
          <Button size="sm" asChild><Link href={`/act/purchase-orders/view?id=${r.purchase_order.id}`}>View purchase order <ArrowRight /></Link></Button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          {[["Predicted shortage", `${b.predicted_shortage} units`, `${a.predicted_shortage} units`], ["Incoming stock", `${num(b.incoming)}`, `${num(a.incoming)}`],
            ["Cash", inr(b.cash), inr(a.cash)], ["Payables", inr(b.payables), inr(a.payables)]].map(([k, x, y]) => (
            <div key={k} className="rounded-lg border border-emerald-200 bg-white p-2.5">
              <div className="label-xs !text-[10px]">{k}</div>
              <div className="num mt-0.5 text-sm"><span className="text-slate-400 line-through">{x}</span> → <b className="text-emerald-700">{y}</b></div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-emerald-800">Payment is on supplier credit, so cash changes only when the invoice is paid. Stock on hand increases when the goods are received (Purchase Orders → Mark received).</p>
      </CardContent>
    </Card>
  );
}

function ScoreBar({ label, value, best }: { label: string; value: number; best: boolean }) {
  return (
    <div>
      <div className="flex justify-between text-[11px] text-slate-500"><span>{label}</span><span className="font-mono">{value}</span></div>
      <Progress value={value} className="h-1" tone={value >= 80 ? (best ? "bg-emerald-500" : "bg-indigo-500") : value >= 50 ? "bg-indigo-400" : "bg-amber-500"} />
    </div>
  );
}

function SupplierCards({ cmp, selected, setSelected }: { cmp: Comparison; selected?: string; setSelected: (s: string) => void }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
      {cmp.options.map((o: SupplierOption) => (
        <div key={o.supplier_id} className={cn("relative rounded-xl border bg-white p-4 shadow-card transition-all",
          selected === o.supplier_id ? "border-brand ring-2 ring-brand-ring" : "border-slate-200")}>
          {o.recommended && <span className="absolute -top-2.5 left-3 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Recommended</span>}
          <div className="flex items-center justify-between"><div className="text-[15px] font-bold">{o.supplier}</div><span className="font-mono text-xs text-slate-400">{o.score}</span></div>
          <div className="truncate text-xs text-slate-500">{o.supplier_name}</div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            {[["Price/unit", inr(o.unit_price)], ["MOQ", `${o.moq} units`], ["Credit", o.credit_days ? `${o.credit_days} days` : "None"], ["Delivery", o.delivery_label],
              ["Cash required", inr(o.cash_required)], ["Risk", o.risk + (o.excess_units ? " · excess" : "")]].map(([k, v]) => (
              <div key={k}><div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{k}</div><div className={cn("font-semibold", k === "Risk" && o.risk === "High" && "text-red-600")}>{v}</div></div>
            ))}
          </div>
          <div className="mt-3 space-y-1.5">
            <ScoreBar label="Price" value={o.scores.price} best={!!o.recommended} />
            <ScoreBar label="MOQ fit" value={o.scores.moq_fit} best={!!o.recommended} />
            <ScoreBar label="Delivery" value={o.scores.delivery} best={!!o.recommended} />
            <ScoreBar label="Credit" value={o.scores.credit} best={!!o.recommended} />
            <ScoreBar label="Cash impact" value={o.scores.cash_impact} best={!!o.recommended} />
          </div>
          {o.notes.length > 0 && <ul className="mt-2 space-y-0.5 text-[11px] text-slate-500">{o.notes.map((n) => <li key={n}>• {n}</li>)}</ul>}
          <Button size="sm" variant={selected === o.supplier_id ? "default" : "outline"} className="mt-3 w-full" onClick={() => setSelected(o.supplier_id)}>
            {selected === o.supplier_id ? "Selected" : "Select supplier"}
          </Button>
        </div>
      ))}
    </div>
  );
}

function RecView({ rec, cash, selected, setSelected, onApprove }: { rec: Recommendation; cash: number; selected?: string; setSelected: (s: string) => void; onApprove: () => void }) {
  const drawer = useEventDrawer();
  const cmp = rec.comparison;
  const risk = cmp.risk;
  const sel = cmp.options.find((o) => o.supplier_id === selected) ?? cmp.options[0];
  return (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-red-200 bg-red-200 md:grid-cols-4">
        {[[risk?.type === "LOW_STOCK" ? `${rec.item} below reorder point` : `${rec.item} shortage predicted`, risk?.type === "LOW_STOCK" ? `projected ${num(risk?.metrics?.projected, 1)}` : `${cmp.need_qty} units`],
          ["Recommended purchase", `${cmp.need_qty}–${cmp.target_max} units`], ["Needed", risk?.type === "LOW_STOCK" ? "This week" : "Before tomorrow"], ["Available cash", inr(cash)]].map(([k, v]) => (
          <div key={k} className="bg-red-50/80 px-4 py-3"><div className="label-xs !text-[10px] !text-red-800/70">{k}</div><div className="num text-[15px] font-bold text-slate-900">{v}</div></div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge s={rec.status} /><span className="font-mono text-xs text-slate-500">{rec.id} · created {dateTime(rec.created_at)}</span>
        {rec.decision_event_id && <button className="text-xs text-brand hover:underline" onClick={() => drawer.open(rec.decision_event_id!)}>Decision {rec.decision_event_id}</button>}
        {rec.trigger_event_id && <button className="text-xs text-brand hover:underline" onClick={() => drawer.open(rec.trigger_event_id!)}>Triggered by {rec.trigger_event_id}</button>}
        {rec.po_id && <Link className="text-xs font-semibold text-emerald-700 hover:underline" href={`/act/purchase-orders/view?id=${rec.po_id}`}>→ {rec.po_id}</Link>}
        {rec.decided_by && <span className="text-xs text-slate-500">· {rec.status.toLowerCase()} by {rec.decided_by}</span>}
      </div>

      <SupplierCards cmp={cmp} selected={selected} setSelected={setSelected} />

      <Card>
        <CardHeader><CardTitle>Supplier comparison</CardTitle><span className="text-[11px] text-slate-400">Weights: price 25% · MOQ 20% · delivery 25% · credit 10% · cash 20%</span></CardHeader>
        <CardContent className="overflow-x-auto p-0 pb-2">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
              {["Supplier", "Price", "Quantity", "Delivery", "Reliability", "Total cost", "Cash now", "Score"].map((h) => <th key={h} className="px-4 py-2 text-left">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {cmp.options.map((o) => (
                <tr key={o.supplier_id} className={cn(o.recommended && "bg-emerald-50/50")}>
                  <td className="px-4 py-2 font-semibold">{o.supplier}{o.recommended && <span className="ml-1 text-emerald-700">✓</span>}</td>
                  <td className="num px-4 py-2">{inr(o.unit_price)}</td><td className="num px-4 py-2">{o.qty}</td>
                  <td className={cn("px-4 py-2", !o.on_time && "text-red-600")}>{o.delivery_label}</td><td className="num px-4 py-2">{o.reliability}%</td>
                  <td className="num px-4 py-2">{inr(o.total)}</td><td className="num px-4 py-2">{inr(o.cash_required)}</td><td className="num px-4 py-2 font-semibold">{o.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="border-l-4 border-l-brand">
        <CardContent className="space-y-2 pt-4 text-sm text-slate-700">
          <div className="flex items-center gap-2 font-semibold text-slate-900"><Info className="h-4 w-4 text-brand" /> Recommended action: purchase {rec.qty} units of {rec.item} from {rec.supplier} — {inr(rec.total)}</div>
          <p>{rec.explanation}</p>
          <p className="text-xs text-slate-500">Reason: {rec.reason}</p>
          <div className="grid grid-cols-2 gap-2 pt-1 md:grid-cols-4">
            {[["Expected cost", inr(sel.total)], ["Expected inventory", `+${sel.qty} incoming`], ["Stockout risk", sel.on_time && sel.qty >= cmp.need_qty ? "Prevented" : "Remains"], ["Cash impact", sel.cash_required ? `-${inr(sel.cash_required)} now` : `₹0 now · ${inr(sel.deferred_payable)} in ${sel.credit_days}d`]].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-slate-50 p-2"><div className="label-xs !text-[10px]">{k}</div><div className="num font-semibold">{v}</div></div>
            ))}
          </div>
        </CardContent>
      </Card>

      {rec.status === "PENDING" ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={onApprove}><PackageCheck /> Approve {sel.supplier}</Button>
          <Button variant="outline" onClick={onApprove}>Modify quantity</Button>
          <Button variant="outline" asChild><Link href={`/think/simulator?sku=${rec.sku}`}><Calculator /> Run What-If</Link></Button>
          <RejectButton rec={rec} size="default" />
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">This recommendation is <b>{rec.status.toLowerCase()}</b>{rec.decided_by ? ` by ${rec.decided_by}` : ""}. {rec.status === "SUPERSEDED" ? "The underlying risk no longer exists." : ""}</div>
      )}
    </>
  );
}

function ManualCompare({ sku }: { sku: string }) {
  const { data, error } = useApi<Comparison>(`/api/suppliers/compare/${sku}`);
  const [selected, setSelected] = React.useState<string | undefined>();
  const [qty, setQty] = React.useState(0);
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (data?.recommended) { setSelected(data.recommended); setQty(data.options.find((o) => o.recommended)?.qty ?? 0); } }, [data]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  if (!data.options.length) return <Empty title="No supplier offers for this SKU">Add a supplier quotation on SEE to compare options.</Empty>;
  return (
    <>
      <Card><CardContent className="pt-4 text-sm text-slate-600">Manual comparison for <b>{data.item}</b> ({sku}) — no active risk, so no automatic recommendation. Any purchase still requires your approval.</CardContent></Card>
      <SupplierCards cmp={data} selected={selected} setSelected={(s) => { setSelected(s); setQty(data.options.find((o) => o.supplier_id === s)?.qty ?? qty); }} />
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div><Label>Supplier</Label><Select value={selected} onChange={(e) => setSelected(e.target.value)}>{data.options.map((o) => <option key={o.supplier_id} value={o.supplier_id}>{o.supplier}</option>)}</Select></div>
          <div className="w-28"><Label>Quantity</Label><Input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="h-4 w-4 accent-indigo-600" /> I approve this purchase</label>
          <Button disabled={!ack || busy || !selected} onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post<{ purchase_order: { id: string } }>("/api/purchase-orders", { sku, supplier_id: selected, qty, acknowledged: ack });
              toast.success(`${r.purchase_order.id} created`);
              notifyChanged();
            } catch (e) { toast.error((e as ApiError).details.join("; ")); } finally { setBusy(false); }
          }}>Create purchase order</Button>
        </CardContent>
      </Card>
    </>
  );
}
