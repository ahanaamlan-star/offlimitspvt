"use client";
import * as React from "react";
import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Calculator, FileSearch, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { Empty, ErrorState, Loading, PageHeader, SeverityBadge } from "@/components/shared/bits";
import { useEventDrawer } from "@/components/shared/event-drawer";
import { useApi } from "@/hooks/useApi";
import { inr, num, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BusinessStateResp, Recommendation, Risk } from "@/types";

const CATS = ["All", "Inventory", "Margins", "Suppliers", "Cash", "Payments"] as const;
type Cat = (typeof CATS)[number];

export default function ThinkPage() {
  return <Suspense fallback={<Loading />}><Think /></Suspense>;
}

function metricLabel(k: string) {
  return k.replace(/_/g, " ").toUpperCase();
}
function metricValue(k: string, v: any) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    if (/days/.test(k)) return `${num(v, 1)} days`;
    if (/price|cost|amount|cash|buffer|payables/.test(k)) return inr(v);
    if (/pct/.test(k)) return pct(v);
    if (/shortage|stock|reserved|available|incoming|projected|forecast|ordered|received|reorder/.test(k)) return `${num(v, 1)} units`;
    return num(v, 1);
  }
  return String(v);
}

function Think() {
  const params = useSearchParams();
  const focus = params.get("focus");
  const [cat, setCat] = React.useState<Cat>((params.get("cat") as Cat) || (focus ? "Inventory" : "All"));
  const risks = useApi<Risk[]>("/api/risks");
  const recs = useApi<Recommendation[]>("/api/recommendations?status=PENDING");
  const state = useApi<BusinessStateResp>("/api/business-state");
  const drawer = useEventDrawer();
  const refs = React.useRef<Record<string, HTMLDivElement | null>>({});

  React.useEffect(() => {
    if (focus && risks.data) setTimeout(() => refs.current[focus]?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
  }, [focus, risks.data]);

  if (risks.error) return <ErrorState error={risks.error} onRetry={risks.reload} />;
  if (!risks.data) return <Loading label="Evaluating business state…" />;
  const list = risks.data.filter((r) => cat === "All" || r.category === cat);
  const recBySku = new Map((recs.data ?? []).map((r) => [r.sku, r]));
  const focusRow = state.data?.inventory.find((r) => r.sku === focus);
  const s = state.data?.summary;

  return (
    <div>
      <PageHeader kicker="Think" title="Decision Intelligence" subtitle="Understand what the event means — risks, opportunities and consequences detected from your live business state."
        actions={<Button variant="outline" asChild><Link href="/think/simulator"><Calculator /> What-If Simulator</Link></Button>} />

      {s && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {[["Inventory value", inr(s.inventory_value)], ["Cash", inr(s.cash)], ["Open orders", `${s.open_orders} · ${inr(s.open_order_value)}`],
            ["Receivables", inr(s.receivables)], ["Payables", inr(s.payables)], ["Weighted margin", pct(s.weighted_margin_pct)]].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-slate-200 bg-white px-3 py-2"><div className="label-xs !text-[10px]">{k}</div><div className="num text-sm font-bold">{v}</div></div>
          ))}
        </div>
      )}

      {focusRow && (
        <Card className="mb-4 border-indigo-200">
          <CardHeader><CardTitle>Stockout analysis · {focusRow.sku} {focusRow.name}</CardTitle><SeverityBadge s={focusRow.risk} /></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
              {[["Current stock", focusRow.on_hand], ["Committed", focusRow.reserved], ["Available", focusRow.available], ["Incoming", focusRow.incoming],
                ["Forecast demand (1 day)", focusRow.forecast_daily], ["Projected", focusRow.projected], ["Projected shortfall", Math.max(0, -Math.round(focusRow.projected))]].map(([k, v]) => (
                <div key={k as string} className="rounded-lg bg-slate-50 p-2.5"><div className="label-xs !text-[10px]">{k}</div>
                  <div className={cn("num text-lg font-bold", k === "Projected shortfall" && (v as number) > 0 && "text-red-600")}>{num(v as number, 1)}</div></div>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">available = on hand − reserved · projected = available + incoming − forecast demand · forecast = weighted 7-day moving average of sales (deterministic).</p>
          </CardContent>
        </Card>
      )}

      <Tabs value={cat} onChange={setCat} items={CATS.map((c) => ({ value: c, label: c, count: c === "All" ? risks.data!.length : risks.data!.filter((r) => r.category === c).length }))} className="mb-4" />

      {list.length === 0 && <Empty title="No risks in this category" icon={<TriangleAlert className="h-8 w-8" />}>Business state looks healthy here.</Empty>}
      <div className="space-y-3">
        {list.map((r) => {
          const rec = r.sku ? recBySku.get(r.sku) : undefined;
          const isFocus = !!focus && r.sku === focus;
          const border = r.severity === "CRITICAL" ? "border-l-red-500" : r.severity === "HIGH" ? "border-l-amber-500" : "border-l-sky-500";
          return (
            <div key={r.key} ref={(el) => { if (r.sku) refs.current[r.sku] = refs.current[r.sku] ?? el; }}
              className={cn("rounded-xl border border-l-4 border-slate-200 bg-white p-4 shadow-card", border, isFocus && "ring-2 ring-brand-ring animate-flash")}>
              <div className="flex items-start gap-3">
                <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", r.severity === "CRITICAL" ? "bg-red-50 text-red-600" : r.severity === "HIGH" ? "bg-amber-50 text-amber-600" : "bg-sky-50 text-sky-600")}>
                  <TriangleAlert className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge s={r.severity} />
                    <span className="text-[15px] font-bold text-slate-900">{r.title}</span>
                    <span className="text-sm text-slate-400">— {r.entity}</span>
                    <span className="ml-auto font-mono text-[11px] text-slate-400">{r.category}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                    {Object.entries(r.metrics).slice(0, 8).map(([k, v]) => (
                      <div key={k}><div className="text-[10.5px] font-semibold tracking-wider text-slate-400">{metricLabel(k)}</div>
                        <div className={cn("num text-sm font-semibold", k === "expected_shortage" && "text-red-600")}>{metricValue(k, v)}</div></div>
                    ))}
                  </div>
                  <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-[13px] text-slate-700">
                    <div><b>Reason:</b> {r.reason}</div>
                    <div><b>Recommendation:</b> {r.recommendation}</div>
                    {r.orders && r.orders.length > 0 && <div className="text-xs text-slate-500">Affected orders: {r.orders.join(", ")}</div>}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {r.action === "evaluate_suppliers" && rec && <Button size="sm" asChild><Link href={`/act?rec=${rec.id}`}>Evaluate Suppliers <ArrowRight /></Link></Button>}
                    {r.action === "evaluate_suppliers" && !rec && r.sku && <Button size="sm" variant="outline" asChild><Link href={`/act?sku=${r.sku}`}>Compare suppliers</Link></Button>}
                    {r.sku && <Button size="sm" variant="outline" asChild><Link href={`/think/simulator?sku=${r.sku}`}><Calculator /> Run What-If</Link></Button>}
                    {r.evidence?.map((ev) => <Button key={ev} size="sm" variant="ghost" onClick={() => drawer.open(ev)}><FileSearch /> Source {ev}</Button>)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
