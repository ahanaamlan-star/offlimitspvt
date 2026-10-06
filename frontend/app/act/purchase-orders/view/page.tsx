"use client";
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Clock, Download, PackageCheck, Share2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ErrorState, Loading } from "@/components/shared/bits";
import { useEventDrawer } from "@/components/shared/event-drawer";
import { useApi } from "@/hooks/useApi";
import { api, ApiError, notifyChanged } from "@/lib/api";
import { dateShort, dateTime, inr } from "@/lib/format";
import type { BusinessStateResp, PODetail } from "@/types";

export default function PODetailPage() {
  return (
    <React.Suspense fallback={<Loading />}>
      <PODetailInner />
    </React.Suspense>
  );
}

function PODetailInner() {
  const id = useSearchParams().get("id") || "";
  const { data: po, error, reload } = useApi<PODetail>(id ? `/api/purchase-orders/${encodeURIComponent(id)}` : null);
  const { data: bs } = useApi<BusinessStateResp>("/api/business-state");
  const drawer = useEventDrawer();
  const [busy, setBusy] = React.useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!po) return <Loading />;
  const row = bs?.inventory.find((r) => r.sku === po.sku);
  const chain = [...po.trace.upstream, ...(po.event ? [po.event] : []), ...po.trace.downstream];

  async function receive() {
    setBusy(true);
    try {
      await api.post(`/api/purchase-orders/${po!.id}/receive`, {});
      toast.success(`Goods received against ${po!.id} — stock on hand updated`);
      notifyChanged();
    } catch (e) { toast.error((e as ApiError).details.join("; ")); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="mb-6"><div className="label-xs mb-1 text-brand">Act</div><h1 className="text-[26px] font-bold tracking-tight">Purchase Orders</h1>
        <p className="mt-1 text-sm text-slate-500">Merchant-approved procurement actions.</p></div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="print:shadow-none" id="po-document">
          <CardContent className="p-8">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white"><Zap className="h-4 w-4" fill="currentColor" /></span>
                <div><div className="font-extrabold tracking-wide">OFFLIMITS</div><div className="text-xs text-slate-500">Merchant Intelligence Loop</div></div>
              </div>
              <div className="text-right"><div className="font-mono text-xl font-bold tracking-wider">PURCHASE ORDER</div>
                <Badge tone={po.status === "RECEIVED" ? "green" : "green"} className="mt-1">{po.status}</Badge></div>
            </div>
            <div className="grid gap-6 border-b border-slate-200 py-5 sm:grid-cols-2">
              <div><div className="label-xs">From (merchant)</div><div className="mt-1 font-semibold">{po.merchant.name}</div>
                <div className="text-sm text-slate-500">GST: DEMO-NOT-REAL<br />{po.merchant.city}</div></div>
              <div><div className="label-xs">To (supplier)</div><div className="mt-1 font-semibold">{po.supplier}</div>
                <div className="text-sm text-slate-500">{po.supplier_detail.name}<br />{po.supplier_detail.city}</div></div>
            </div>
            <div className="my-5 grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-4">
              {[["PO number", po.id], ["Date", dateShort(po.created_at)], ["Credit terms", po.credit_days ? `${po.credit_days} days` : "On delivery"],
                ["Delivery", po.delivery_days === 0 ? "Today" : po.delivery_days === 1 ? "Tomorrow" : `${po.delivery_days} days`]].map(([k, v]) => (
                <div key={k}><div className="label-xs !text-[10px]">{k}</div><div className="mt-0.5 font-mono text-sm font-semibold">{v}</div></div>
              ))}
            </div>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="py-2 text-left">#</th><th className="py-2 text-left">Product</th><th className="py-2 text-left">SKU</th><th className="py-2 text-right">Qty</th><th className="py-2 text-right">Unit price</th><th className="py-2 text-right">Amount</th></tr></thead>
              <tbody><tr className="border-b border-slate-100">
                <td className="py-3 text-slate-500">1</td><td className="py-3 font-semibold">{po.item}</td><td className="py-3 font-mono text-xs text-slate-500">{po.sku}</td>
                <td className="num py-3 text-right">{po.qty}</td><td className="num py-3 text-right">{inr(po.unit_price, true)}</td><td className="num py-3 text-right font-semibold">{inr(po.total, true)}</td></tr></tbody>
            </table>
            <div className="mt-4 flex justify-end gap-10"><span className="font-semibold">Total</span><span className="num text-xl font-bold">{inr(po.total, true)}</span></div>
            <div className="mt-6 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
              Approved by <b className="text-slate-700">{po.approved_by}</b>{po.approval ? ` on ${dateTime(po.approval.ts)} (${po.approval.id})` : ""}. Generated by OFFLIMITS from {po.recommendation_id ?? "a manual purchase"}. DEMO DATA — not a real purchase order.
            </div>
            <div className="mt-6 flex flex-wrap gap-2 print:hidden">
              <Button onClick={() => window.print()}><Download /> Download PDF</Button>
              <Button variant="outline" onClick={() => { navigator.clipboard?.writeText(window.location.href); toast.success("Link copied"); }}><Share2 /> Share</Button>
              {po.event_id && <Button variant="outline" onClick={() => drawer.open(po.event_id!)}><Clock /> View event trail</Button>}
              {po.status !== "RECEIVED" && <Button variant="success" onClick={receive} disabled={busy}><PackageCheck /> Mark goods received</Button>}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4 print:hidden">
          <Card className="border-emerald-200 bg-emerald-50/60">
            <CardHeader><CardTitle className="!text-emerald-800 flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> Business state updated</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {row && <div className="rounded-lg border border-emerald-200 bg-white p-2.5"><div className="label-xs !text-[10px]">Predicted shortage</div>
                <div className="font-semibold text-emerald-700">{Math.max(0, -Math.round(row.projected))} units now · {row.incoming} incoming · {row.on_hand} on hand</div></div>}
              <div className="rounded-lg border border-emerald-200 bg-white p-2.5"><div className="label-xs !text-[10px]">Procurement action</div><div className="font-semibold text-emerald-700">Logged · {po.event_id}</div></div>
              <div className="rounded-lg border border-emerald-200 bg-white p-2.5"><div className="label-xs !text-[10px]">Event ledger</div><div className="font-semibold text-emerald-700">{po.status === "RECEIVED" ? `Goods received · ${po.received_event_id}` : "Updated"}</div></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Traceability</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {chain.map((e) => (
                <button key={e.id} onClick={() => drawer.open(e.id)} className="flex w-full items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 text-left text-sm hover:bg-slate-50">
                  <span className="font-mono text-[11px] font-semibold text-brand">{e.id}</span><span className="truncate text-slate-700">{e.title}</span>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
