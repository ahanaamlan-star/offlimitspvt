"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Boxes, Camera, ClipboardCheck, IndianRupee, Percent, ShoppingBag, TrendingDown, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CategoryBadge, DemoTag, Empty, ErrorState, Loading, PageHeader, SeverityBadge, Stat } from "@/components/shared/bits";
import { LoopStrip } from "@/components/shared/loop";
import { ApprovalDialog, RejectButton } from "@/components/shared/approval-dialog";
import { useEventDrawer } from "@/components/shared/event-drawer";
import { useDemo } from "@/components/demo/demo-provider";
import { useApi } from "@/hooks/useApi";
import { inr, num, pct, time, dateShort, isToday } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Overview, Recommendation } from "@/types";

export default function OverviewPage() {
  const { data, error, loading, reload } = useApi<Overview>("/api/overview");
  const drawer = useEventDrawer();
  const demo = useDemo();
  const router = useRouter();
  const [approving, setApproving] = React.useState<Recommendation | null>(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading label="Loading business state…" />;
  if (!data) return null;
  const s = data.summary;
  const atRisk = [...data.inventory].filter((r) => r.risk !== "LOW").sort((a, b) => a.projected - b.projected).slice(0, 6);
  const maxBar = Math.max(1, ...atRisk.map((r) => Math.max(r.on_hand, r.reserved + r.forecast_daily)));

  return (
    <div>
      <PageHeader kicker="Overview" title="Merchant Command Center" subtitle="From messy activity to explainable business action."
        actions={<><DemoTag /><Button variant="outline" asChild><Link href="/see"><Camera /> Capture input</Link></Button>
          <Button variant="dark" onClick={demo.open}>Run 3-minute demo</Button></>} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Inventory value" value={inr(s.inventory_value)} sub={`${num(s.inventory_units)} units · ${s.skus} SKUs`} icon={<Boxes className="h-4 w-4" />} href="/state?tab=inventory" />
        <Stat label="Cash position" value={inr(s.cash)} sub={`Receivable ${inr(s.receivables)} · Payable ${inr(s.payables)}`} icon={<Wallet className="h-4 w-4" />} href="/state?tab=cash" />
        <Stat label="Open orders" value={s.open_orders} sub={`${inr(s.open_order_value)} committed`} icon={<ShoppingBag className="h-4 w-4" />} href="/state?tab=orders" />
        <Stat label="Stockout risks" value={s.stockout_risks} tone={s.stockout_risks ? "red" : "green"} sub={`${s.low_stock} more below reorder point`} icon={<AlertTriangle className="h-4 w-4" />} href="/think" />
        <Stat label="Margin alerts" value={s.margin_alerts} tone={s.margin_alerts ? "amber" : "green"} sub={`Weighted margin ${pct(s.weighted_margin_pct)}`} icon={<Percent className="h-4 w-4" />} href="/think?cat=Margins" />
        <Stat label="Pending approvals" value={s.pending_approvals} tone={s.pending_approvals ? "indigo" : "green"} sub={s.needs_review ? `${s.needs_review} input(s) need review` : "Human approval required"} icon={<ClipboardCheck className="h-4 w-4" />} href="/act" />
      </div>

      <Card className="mt-4">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <LoopStrip active={[]} compact />
          <span className="text-xs text-slate-500">{s.events} ledger events · last change {s.last_event_at ? `${dateShort(s.last_event_at)} ${time(s.last_event_at)}` : "—"}</span>
        </CardContent>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader><CardTitle>Live business state</CardTitle><Link href="/state" className="text-xs font-medium text-brand hover:underline">Open business state →</Link></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["Inventory", `${num(s.inventory_units)} units`, s.low_stock + s.stockout_risks ? "amber" : "green"],
                ["Orders", `${s.open_orders} active`, data.orders.some((o) => o.risk === "AT RISK") ? "red" : "green"],
                ["Cash", inr(s.cash), s.cash < 10000 ? "red" : "green"],
                ["Prices", `${data.risks.filter((r) => r.type === "PRICE_CHANGE").length} changes`, data.risks.some((r) => r.type === "PRICE_CHANGE") ? "amber" : "green"],
                ["Margin", pct(s.weighted_margin_pct), data.risks.some((r) => r.type === "MARGIN_ANOMALY") ? "amber" : "green"],
                ["Stockout risk", `${s.stockout_risks} SKU${s.stockout_risks === 1 ? "" : "s"}`, s.stockout_risks ? "red" : "green"],
              ].map(([k, v, t]) => (
                <div key={k} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center gap-1.5"><span className={cn("h-2 w-2 rounded-full", t === "red" ? "bg-red-500" : t === "amber" ? "bg-amber-500" : "bg-emerald-500")} /><span className="label-xs !text-[10px]">{k}</span></div>
                  <div className="num mt-1 text-[17px] font-bold">{v}</div>
                </div>
              ))}
            </div>
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between">
                <div className="label-xs">SKUs under pressure — on hand vs committed + 1-day demand</div>
                <div className="flex items-center gap-3 text-[11px] text-slate-500">
                  <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-slate-800" />On hand</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-red-300" />Reserved + forecast</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-indigo-300" />Incoming</span>
                </div>
              </div>
              {atRisk.length === 0 ? <Empty title="No SKUs at risk">All items cover committed orders and forecast demand.</Empty> : (
                <div className="space-y-2.5">
                  {atRisk.map((r) => (
                    <button key={r.sku} onClick={() => router.push(`/think?focus=${r.sku}`)} className="grid w-full grid-cols-[150px_1fr_110px] items-center gap-3 text-left hover:opacity-80">
                      <div className="min-w-0"><div className="truncate text-sm font-medium text-slate-800">{r.name}</div><div className="font-mono text-[11px] text-slate-400">{r.sku}</div></div>
                      <div className="space-y-1">
                        <div className="flex h-2.5 overflow-hidden rounded bg-slate-100">
                          <div className="bg-slate-800" style={{ width: `${(Math.max(r.on_hand, 0) / maxBar) * 100}%` }} />
                          <div className="bg-indigo-300" style={{ width: `${(r.incoming / maxBar) * 100}%` }} />
                        </div>
                        <div className="h-2.5 rounded bg-red-300" style={{ width: `${((r.reserved + r.forecast_daily) / maxBar) * 100}%` }} />
                      </div>
                      <div className="text-right"><SeverityBadge s={r.risk} /><div className="num mt-0.5 text-[11px] text-slate-500">projected {num(r.projected, 1)}</div></div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Approval required</CardTitle><Link href="/act" className="text-xs font-medium text-brand hover:underline">All actions →</Link></CardHeader>
          <CardContent className="space-y-2.5">
            {data.pending.length === 0 && <Empty title="Nothing to approve">Recommendations appear when OFFLIMITS detects a risk.</Empty>}
            {data.pending.slice(0, 4).map((r) => (
              <div key={r.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <Badge tone="indigo">Purchase recommendation</Badge><span className="font-mono text-[11px] text-slate-400">{r.id}</span>
                </div>
                <div className="mt-1.5 text-sm font-semibold text-slate-900">{r.item}</div>
                <div className="num text-xs text-slate-500">{r.sku} · {r.qty} units · {r.supplier} · <b className="text-slate-800">{inr(r.total)}</b></div>
                <div className="mt-2 flex gap-1.5">
                  <Button size="sm" variant="outline" asChild><Link href={`/act?rec=${r.id}`}>Review</Link></Button>
                  <Button size="sm" onClick={() => setApproving(r)}>Approve</Button>
                  <RejectButton rec={r} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader><CardTitle>Intelligence feed · latest business events</CardTitle><Link href="/ledger?view=timeline" className="text-xs font-medium text-brand hover:underline">Event timeline →</Link></CardHeader>
          <CardContent className="p-0 pb-2">
            <ul className="divide-y divide-slate-100">
              {data.feed.map((e) => (
                <li key={e.id}>
                  <button onClick={() => drawer.open(e.id)} className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-slate-50">
                    <span className="w-14 shrink-0 font-mono text-[11px] text-slate-400">{isToday(e.ts) ? time(e.ts) : dateShort(e.ts)}</span>
                    <CategoryBadge c={e.category} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800">{e.title}</span>
                      <span className="block truncate text-xs text-slate-500">{e.change}{e.source_ref ? ` · ${e.source_ref}` : ""}</span>
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Top risks</CardTitle><Link href="/think" className="text-xs font-medium text-brand hover:underline">Decision intelligence →</Link></CardHeader>
          <CardContent className="space-y-2">
            {data.risks.slice(0, 5).map((r) => (
              <Link key={r.key} href={r.sku ? `/think?focus=${r.sku}` : "/think"} className="block rounded-lg border border-slate-200 p-2.5 hover:bg-slate-50">
                <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-slate-800">{r.title}</span><SeverityBadge s={r.severity} /></div>
                <div className="mt-0.5 text-xs text-slate-500">{r.entity} — {r.reason}</div>
              </Link>
            ))}
            <div className="flex items-center gap-1.5 pt-1 text-[11px] text-slate-400"><TrendingDown className="h-3 w-3" />Risks are computed by deterministic rules, not by the language model.<IndianRupee className="hidden" /></div>
          </CardContent>
        </Card>
      </div>
      <ApprovalDialog rec={approving} open={!!approving} onOpenChange={(o) => !o && setApproving(null)} />
    </div>
  );
}
