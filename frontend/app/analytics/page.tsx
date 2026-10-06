"use client";
import * as React from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DemoTag, ErrorState, Loading, PageHeader } from "@/components/shared/bits";
import { useApi } from "@/hooks/useApi";
import { inr } from "@/lib/format";

interface Analytics {
  series: Record<string, any>[]; focus: { sku: string; name: string }[];
  coke_offers: { supplier: string; price: number; moq: number; delivery_days: number; credit_days: number }[];
  insights: Record<string, string>; is_demo: boolean;
}
const AX = { fontSize: 11, fill: "#64748b" };
const COLORS = ["#4f46e5", "#d97706", "#059669", "#db2777"];

function ChartCard({ title, why, children }: { title: string; why: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="h-56">{children}</div>
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600"><span className="font-semibold text-slate-800">Why this matters: </span>{why}</div>
      </CardContent>
    </Card>
  );
}

export default function AnalyticsPage() {
  const { data, error, reload } = useApi<Analytics>("/api/analytics");
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading label="Replaying the ledger day by day…" />;
  const s = data.series;
  return (
    <div>
      <PageHeader kicker="Business" title="Business Intelligence" subtitle="Each chart is computed by replaying the event ledger to the end of each day — and each supports a decision." actions={<DemoTag />} />
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Inventory trend (units on hand · value)" why={data.insights.inventory}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={s} margin={{ left: -10, right: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" tick={AX} />
              <YAxis yAxisId="u" tick={AX} /><YAxis yAxisId="v" orientation="right" tick={AX} tickFormatter={(v) => `₹${Math.round(v / 1000)}k`} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: any, n: any) => (n === "Value" ? inr(v) : v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="u" dataKey="inventory_units" name="Units" fill="#c7d2fe" radius={[3, 3, 0, 0]} />
              <Line yAxisId="v" dataKey="inventory_value" name="Value" stroke="#4f46e5" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Stockout risk (SKUs per day)" why={data.insights.stockout}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={s} margin={{ left: -20, right: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" tick={AX} /><YAxis allowDecimals={false} tick={AX} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="stockout_risks" name="Stockout (high/critical)" stackId="a" fill="#ef4444" />
              <Bar dataKey="low_stock" name="Below reorder point" stackId="a" fill="#fbbf24" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Purchase cost received (₹ per day)" why={data.insights.purchases}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={s} margin={{ left: -5, right: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" tick={AX} /><YAxis tick={AX} tickFormatter={(v) => `₹${v}`} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: any) => inr(v)} />
              <Bar dataKey="purchase_cost" name="Purchases" fill="#6366f1" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Margin trend (% at latest cost)" why={data.insights.margin}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={s} margin={{ left: -15, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" tick={AX} /><YAxis tick={AX} unit="%" domain={[0, "auto"]} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: any) => `${v}%`} /><Legend wrapperStyle={{ fontSize: 11 }} />
              {data.focus.map((f, i) => <Line key={f.sku} dataKey={`margin_${f.sku}`} name={f.name} stroke={COLORS[i]} strokeWidth={2} dot={false} connectNulls />)}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Supplier prices · Coca-Cola 300ml (₹/unit)" why={data.insights.supplier_prices}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.coke_offers} layout="vertical" margin={{ left: 10, right: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis type="number" tick={AX} domain={[0, "auto"]} /><YAxis type="category" dataKey="supplier" tick={AX} width={80} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: any, _n: any, p: any) => [`₹${v} · MOQ ${p.payload.moq} · ${p.payload.delivery_days}d delivery · ${p.payload.credit_days}d credit`, "Offer"]} />
              <Bar dataKey="price" radius={[0, 3, 3, 0]} label={{ position: "right", fontSize: 11, formatter: (v: any) => `₹${v}` }}>
                {data.coke_offers.map((o, i) => <Cell key={o.supplier} fill={i === 0 ? "#059669" : "#94a3b8"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Cash movement (₹)" why={data.insights.cash}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={s} margin={{ left: 0, right: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" tick={AX} /><YAxis tick={AX} tickFormatter={(v) => `₹${Math.round(v / 1000)}k`} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: any) => inr(v)} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="inflow" name="Inflow" fill="#86efac" radius={[3, 3, 0, 0]} />
              <Bar dataKey="outflow" name="Outflow" fill="#fca5a5" radius={[3, 3, 0, 0]} />
              <Line dataKey="cash" name="Cash balance" stroke="#0f172a" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
