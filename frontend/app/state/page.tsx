"use client";
import * as React from "react";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { DemoTag, ErrorState, Loading, PageHeader, SeverityBadge, Stat, StatusBadge } from "@/components/shared/bits";
import { useEventDrawer } from "@/components/shared/event-drawer";
import { useApi } from "@/hooks/useApi";
import { api, ApiError, notifyChanged } from "@/lib/api";
import { dateShort, dateTime, inr, num, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BusinessStateResp } from "@/types";

const TABS = ["inventory", "orders", "cash", "prices", "margins", "suppliers"] as const;
type Tab = (typeof TABS)[number];

export default function StatePage() {
  return <Suspense fallback={<Loading />}><State /></Suspense>;
}

function State() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS.includes(params.get("tab") as Tab) ? params.get("tab") : "inventory") as Tab;
  const highlight = params.get("highlight");
  const { data, error, reload } = useApi<BusinessStateResp>("/api/business-state");
  const drawer = useEventDrawer();
  const [q, setQ] = React.useState("");
  const [catF, setCatF] = React.useState("all");
  const [riskF, setRiskF] = React.useState("all");

  React.useEffect(() => {
    if (highlight && data) setTimeout(() => document.getElementById(`row-${highlight}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
  }, [highlight, data, tab]);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading label="Deriving business state from the event ledger…" />;
  const s = data.summary;
  const cats = Array.from(new Set(data.inventory.map((r) => r.category)));
  const inv = data.inventory.filter((r) => (catF === "all" || r.category === catF) && (riskF === "all" || (riskF === "risk" ? r.risk !== "LOW" : r.risk === riskF))
    && (!q || `${r.sku} ${r.name}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <div>
      <PageHeader kicker="Business" title="Live Business State" subtitle={`Derived from ${s.events} ledger events — every number below can be traced to the events that produced it.`} actions={<DemoTag />} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Inventory value" value={inr(s.inventory_value)} sub={`${num(s.inventory_units)} units`} />
        <Stat label="Cash" value={inr(s.cash)} sub={`+${inr(data.cash.inflow)} in · -${inr(data.cash.outflow)} out`} />
        <Stat label="Receivables / payables" value={`${inr(s.receivables)} / ${inr(s.payables)}`} />
        <Stat label="Weighted margin" value={pct(s.weighted_margin_pct)} sub={`${s.margin_alerts} margin/price alerts`} tone={s.margin_alerts ? "amber" : undefined} />
      </div>
      <Tabs value={tab} onChange={(t) => router.replace(`/state?tab=${t}`)} className="mb-4"
        items={TABS.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1), count: t === "orders" ? s.open_orders : undefined }))} />

      {tab === "inventory" && (
        <Card>
          <CardHeader className="flex-wrap">
            <CardTitle>Inventory · {inv.length} of {data.inventory.length} SKUs</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Input placeholder="Filter SKU or item" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-44" aria-label="Filter items" />
              <Select value={catF} onChange={(e) => setCatF(e.target.value)} className="h-8 w-36" aria-label="Category"><option value="all">All categories</option>{cats.map((c) => <option key={c}>{c}</option>)}</Select>
              <Select value={riskF} onChange={(e) => setRiskF(e.target.value)} className="h-8 w-36" aria-label="Risk"><option value="all">All risk levels</option><option value="risk">At risk</option><option value="CRITICAL">Critical</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></Select>
            </div>
          </CardHeader>
          <CardContent className="p-0 pt-3">
            <Table>
              <THead><tr><TH>SKU</TH><TH>Item</TH><TH>Category</TH><TH className="text-right">Stock</TH><TH className="text-right">Reserved</TH><TH className="text-right">Available</TH><TH className="text-right">Incoming</TH><TH className="text-right">Forecast/day</TH><TH className="text-right">Reorder point</TH><TH className="text-right">Unit cost</TH><TH className="text-right">Value</TH><TH>Risk</TH></tr></THead>
              <TBody>
                {inv.map((r) => (
                  <tr key={r.sku} id={`row-${r.sku}`} className={cn(r.sku === highlight && "animate-flash bg-indigo-50/60")}>
                    <TD className="font-mono text-xs">{r.sku}</TD><TD className="font-medium text-slate-800">{r.name}</TD><TD>{r.category}</TD>
                    <TD className="num text-right font-semibold">{num(r.on_hand)}</TD><TD className="num text-right">{num(r.reserved)}</TD>
                    <TD className={cn("num text-right", r.available < 0 && "font-semibold text-red-600")}>{num(r.available)}</TD>
                    <TD className="num text-right">{r.incoming ? <span className="text-brand">+{r.incoming}</span> : "—"}</TD>
                    <TD className="num text-right">{num(r.forecast_daily, 1)}</TD><TD className="num text-right">{r.reorder_point}</TD>
                    <TD className="num text-right">{inr(r.unit_cost)}</TD><TD className="num text-right">{inr(r.value)}</TD><TD><SeverityBadge s={r.risk} /></TD>
                  </tr>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {tab === "orders" && (
        <Card><CardContent className="p-0">
          <Table>
            <THead><tr><TH>Order ID</TH><TH>Customer</TH><TH>Items</TH><TH className="text-right">Value</TH><TH>Due</TH><TH>Status</TH><TH>Risk</TH><TH></TH></tr></THead>
            <TBody>
              {data.orders.map((o) => (
                <tr key={o.id}>
                  <TD><button className="font-mono text-xs font-semibold text-brand hover:underline" onClick={() => o.created_event_id && drawer.open(o.created_event_id)}>{o.id}</button></TD>
                  <TD className="font-medium">{o.customer}</TD><TD className="whitespace-normal text-xs">{o.items.map((i) => `${i.qty} × ${i.name}`).join(", ")}</TD>
                  <TD className="num text-right">{inr(o.value)}</TD><TD>{o.due ? dateShort(o.due) : "—"}</TD><TD><StatusBadge s={o.status} /></TD><TD><StatusBadge s={o.risk} /></TD>
                  <TD>{o.status === "OPEN" && <Button size="sm" variant="outline" onClick={async () => {
                    try { await api.post(`/api/orders/${o.id}/fulfill`, {}); toast.success(`${o.id} fulfilled — stock and receivables updated`); notifyChanged(); }
                    catch (e) { toast.error((e as ApiError).details.join("; ")); }
                  }}>Mark fulfilled</Button>}</TD>
                </tr>
              ))}
            </TBody>
          </Table>
        </CardContent></Card>
      )}

      {tab === "cash" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Opening" value={inr(data.cash.opening)} /><Stat label="Inflow" value={`+${inr(data.cash.inflow)}`} tone="green" />
            <Stat label="Outflow" value={`-${inr(data.cash.outflow)}`} tone="red" /><Stat label="Current" value={inr(data.cash.current)} tone="indigo" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card><CardHeader><CardTitle>Receivables (customers owe)</CardTitle></CardHeader><CardContent className="p-0 pb-2">
              <Table><THead><tr><TH>Customer</TH><TH className="text-right">Amount</TH></tr></THead><TBody>
                {data.cash.receivables.map((r) => <tr key={r.customer_id}><TD>{r.customer}</TD><TD className="num text-right font-semibold">{inr(r.amount)}</TD></tr>)}
              </TBody></Table></CardContent></Card>
            <Card><CardHeader><CardTitle>Payables (we owe suppliers)</CardTitle></CardHeader><CardContent className="p-0 pb-2">
              <Table><THead><tr><TH>Supplier</TH><TH className="text-right">Amount</TH></tr></THead><TBody>
                {data.cash.payables.map((r) => <tr key={r.supplier_id}><TD>{r.supplier}</TD><TD className="num text-right font-semibold">{inr(r.amount)}</TD></tr>)}
              </TBody></Table></CardContent></Card>
          </div>
        </div>
      )}

      {tab === "prices" && (
        <Card><CardContent className="p-0">
          <Table>
            <THead><tr><TH>Item</TH><TH>Supplier</TH><TH className="text-right">Unit price</TH><TH className="text-right">MOQ</TH><TH>Delivery</TH><TH>Credit</TH><TH>Last quoted</TH><TH>Source</TH></tr></THead>
            <TBody>
              {data.prices.map((p) => (
                <tr key={`${p.supplier_id}-${p.sku}`}>
                  <TD className="font-medium">{p.item}</TD><TD>{p.supplier} <span className="text-xs text-slate-400">{p.supplier_name}</span></TD>
                  <TD className="num text-right font-semibold">{inr(p.unit_price, true)}</TD><TD className="num text-right">{p.moq}</TD>
                  <TD>{p.delivery_days === 0 ? "Today" : `${p.delivery_days} d`}</TD><TD>{p.credit_days ? `${p.credit_days} d` : "—"}</TD>
                  <TD className="text-xs">{dateTime(p.quoted_at)}</TD>
                  <TD><button className="font-mono text-xs text-brand hover:underline" onClick={() => drawer.open(p.source_event)}>{p.source_event}</button></TD>
                </tr>
              ))}
            </TBody>
          </Table>
        </CardContent></Card>
      )}

      {tab === "margins" && (
        <Card><CardContent className="p-0">
          <Table>
            <THead><tr><TH>SKU</TH><TH>Item</TH><TH className="text-right">Selling price</TH><TH className="text-right">Cost</TH><TH className="text-right">Margin</TH><TH className="text-right">Margin %</TH><TH className="text-right">Previous %</TH><TH>Status</TH></tr></THead>
            <TBody>
              {data.margins.map((m) => (
                <tr key={m.sku} className={cn(m.anomaly && "bg-amber-50/70")}>
                  <TD className="font-mono text-xs">{m.sku}</TD><TD className="font-medium">{m.name}</TD><TD className="num text-right">{inr(m.selling_price)}</TD>
                  <TD className="num text-right">{inr(m.cost)}{m.previous_cost ? <span className="ml-1 text-xs text-slate-400 line-through">{inr(m.previous_cost)}</span> : null}</TD>
                  <TD className="num text-right">{inr(m.margin, true)}</TD><TD className={cn("num text-right font-semibold", m.anomaly && "text-amber-700")}>{pct(m.margin_pct)}</TD>
                  <TD className="num text-right text-slate-500">{pct(m.previous_margin_pct)}</TD>
                  <TD>{m.anomaly ? <StatusBadge s="AT RISK" /> : <StatusBadge s="OK" />}</TD>
                </tr>
              ))}
            </TBody>
          </Table>
        </CardContent></Card>
      )}

      {tab === "suppliers" && (
        <Card><CardContent className="p-0">
          <Table>
            <THead><tr><TH>ID</TH><TH>Supplier</TH><TH>Legal name (demo)</TH><TH className="text-right">Reliability</TH><TH className="text-right">Products quoted</TH><TH className="text-right">Payable</TH><TH>City</TH></tr></THead>
            <TBody>
              {data.suppliers.map((p) => (
                <tr key={p.id}><TD className="font-mono text-xs">{p.id}</TD><TD className="font-semibold">{p.short_name}</TD><TD>{p.name}</TD>
                  <TD className="num text-right">{p.reliability}%</TD><TD className="num text-right">{p.offers}</TD><TD className="num text-right">{inr(p.payable)}</TD><TD>{p.city}</TD></tr>
              ))}
            </TBody>
          </Table>
        </CardContent></Card>
      )}
    </div>
  );
}
