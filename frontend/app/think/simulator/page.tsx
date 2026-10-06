"use client";
import * as React from "react";
import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Lightbulb, Play, Plus, Trash2 } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ErrorState, Loading, PageHeader } from "@/components/shared/bits";
import { useApi } from "@/hooks/useApi";
import { api, ApiError } from "@/lib/api";
import { dateTime, inr, num, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BusinessStateResp, SimResult, Simulation } from "@/types";

interface Scn { supplier_id: string; qty: number; unit_price: number; discount_pct: number; delivery_days: number; credit_days: number; label?: string }
const COLORS = ["#4f46e5", "#059669", "#d97706", "#db2777"];

export default function SimulatorPage() {
  return <Suspense fallback={<Loading />}><Simulator /></Suspense>;
}

function Simulator() {
  const params = useSearchParams();
  const router = useRouter();
  const { data: bs, error } = useApi<BusinessStateResp>("/api/business-state");
  const saved = useApi<Simulation[]>("/api/simulations");
  const [sku, setSku] = React.useState(params.get("sku") || "SKU-1042");
  const [question, setQuestion] = React.useState("Supplier is giving me 15% discount if I buy 100 units. Should I take it?");
  const [demand, setDemand] = React.useState<number | "">("");
  const [scns, setScns] = React.useState<Scn[]>([]);
  const [sim, setSim] = React.useState<Simulation | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string[] | null>(null);
  const simParam = params.get("sim");
  const [preview, setPreview] = React.useState<Simulation["results"] | null>(null);
  const [previewErr, setPreviewErr] = React.useState<string[] | null>(null);
  const [dirty, setDirty] = React.useState(false);

  const offers = React.useMemo(() => (bs?.prices ?? []).filter((p) => p.sku === sku), [bs, sku]);
  const row = bs?.inventory.find((r) => r.sku === sku);

  React.useEffect(() => {
    if (simParam) api.get<Simulation>(`/api/simulations/${simParam}`).then((s) => {
      setSim(s); setSku(s.results.sku); if (s.question) setQuestion(s.question);
      setScns(s.results.scenarios.map((r) => ({ supplier_id: r.supplier_id ?? "", qty: r.qty, unit_price: r.unit_price, discount_pct: r.discount_pct,
        delivery_days: r.delivery_days, credit_days: r.credit_days, label: r.label })));
    }).catch(() => {});
  }, [simParam]);

  React.useEffect(() => {
    if (!offers.length || simParam) return;
    const by = (id: string) => offers.find((o) => o.supplier_id === id);
    const cheapest = [...offers].sort((a, b) => a.unit_price - b.unit_price)[0];
    const fastest = [...offers].sort((a, b) => a.delivery_days - b.delivery_days || a.unit_price - b.unit_price)[0];
    const mk = (o: typeof offers[number], qty: number, disc = 0): Scn => ({ supplier_id: o.supplier_id, qty, unit_price: o.unit_price, discount_pct: disc, delivery_days: o.delivery_days, credit_days: o.credit_days });
    setScns(sku === "SKU-1042" && by("SUP-A") && by("SUP-B")
      ? [{ ...mk(by("SUP-A")!, 100, 15), label: "Discount deal · 100 units" }, mk(by("SUP-B")!, 55), mk(by("SUP-B")!, 20)]
      : [mk(cheapest, Math.max(cheapest.moq, 20)), mk(fastest, Math.max(fastest.moq, 20)), mk(cheapest, Math.max(cheapest.moq, 20) * 2)]);
    setDemand("");
  }, [offers, sku, simParam]);

  // Live recalculation: every edit re-runs the deterministic maths (not saved until "Save scenario").
  React.useEffect(() => {
    if (!scns.length || scns.some((x) => !(x.qty > 0) || !(x.unit_price > 0))) { setPreview(null); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.post<Simulation["results"]>("/api/simulations/preview", {
          sku, scenarios: scns.map((x) => ({ ...x, daily_demand: demand === "" ? undefined : demand })),
        });
        setPreview(r); setPreviewErr(null);
      } catch (e) { setPreviewErr((e as ApiError).details); }
    }, 250);
    return () => clearTimeout(t);
  }, [scns, demand, sku]);
  const edit = (next: Scn[]) => { setScns(next); setDirty(true); };

  async function run(extra?: Scn) {
    setBusy(true);
    setErr(null);
    const list = extra ? [...scns, extra] : scns;
    if (extra) setScns(list);
    try {
      const s = await api.post<Simulation>("/api/simulations", {
        sku, question, scenarios: list.map((x) => ({ ...x, daily_demand: demand === "" ? undefined : demand })),
      });
      setSim(s);
      setDirty(false);
      router.replace(`/think/simulator?sim=${s.id}`, { scroll: false });
      saved.reload();
    } catch (e) { setErr((e as ApiError).details); } finally { setBusy(false); }
  }

  if (error) return <ErrorState error={error} />;
  if (!bs) return <Loading />;
  const res = preview ?? sim?.results;
  const badges = res?.verdict.badges;
  const BADGES: [keyof NonNullable<typeof badges>, string, string][] = [["best_cost", "BEST COST", "bg-sky-100 text-sky-800"], ["best_speed", "BEST SPEED", "bg-violet-100 text-violet-800"],
    ["best_coverage", "BEST STOCK COVERAGE", "bg-amber-100 text-amber-800"], ["best_balanced", "BEST BALANCED", "bg-emerald-100 text-emerald-800"]];
  const best = res?.verdict.best_label;

  const chart = res ? Array.from({ length: 15 }, (_, d) => {
    const pt: Record<string, number | string> = { day: d === 0 ? "Today" : `D+${d}` };
    res.scenarios.forEach((r) => {
      const start = r.projected_stock - r.qty;
      pt[r.label] = Math.round((start + (d >= r.delivery_days ? r.qty : 0) - r.daily_demand * d) * 10) / 10;
    });
    return pt;
  }) : [];

  return (
    <div>
      <PageHeader kicker="Think" title="What-If Simulator" subtitle="Test a business decision before committing cash. Deterministic maths; the language model only explains." />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Your question</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} className="border-indigo-200 italic" />
              <div className="grid grid-cols-2 gap-2">
                <div><Label htmlFor="sku">Product</Label>
                  <Select id="sku" value={sku} onChange={(e) => { setSku(e.target.value); setSim(null); router.replace(`/think/simulator?sku=${e.target.value}`); }}>
                    {bs.inventory.filter((r) => bs.prices.some((p) => p.sku === r.sku)).map((r) => <option key={r.sku} value={r.sku}>{r.sku} · {r.name}</option>)}
                  </Select></div>
                <div><Label htmlFor="demand">Expected daily demand</Label>
                  <Input id="demand" type="number" step="0.5" placeholder={row ? `${row.forecast_daily} (forecast)` : ""} value={demand}
                    onChange={(e) => { setDemand(e.target.value === "" ? "" : Number(e.target.value)); setDirty(true); }} /></div>
              </div>
              {row && <div className="grid grid-cols-4 gap-1.5 text-center text-xs">
                {[["On hand", row.on_hand], ["Reserved", row.reserved], ["Incoming", row.incoming], ["Forecast/day", row.forecast_daily]].map(([k, v]) => (
                  <div key={k as string} className="rounded-md bg-slate-50 py-1.5"><div className="text-[10px] text-slate-500">{k}</div><div className="num font-bold">{num(v as number, 1)}</div></div>))}
              </div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Scenarios</CardTitle>
              <Button size="sm" variant="ghost" disabled={scns.length >= 6 || !offers.length}
                onClick={() => { const o = offers[0]; edit([...scns, { supplier_id: o.supplier_id, qty: o.moq, unit_price: o.unit_price, discount_pct: 0, delivery_days: o.delivery_days, credit_days: o.credit_days }]); }}>
                <Plus /> Add</Button></CardHeader>
            <CardContent className="space-y-2.5">
              {scns.map((s, i) => (
                <div key={i} className="rounded-lg border border-slate-200 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-bold" style={{ color: COLORS[i] }}>● Option {String.fromCharCode(65 + i)}</span>
                    <button onClick={() => edit(scns.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-600" aria-label="Remove scenario"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                    <div className="col-span-3 sm:col-span-2"><Label>Supplier</Label>
                      <Select value={s.supplier_id} onChange={(e) => { const o = offers.find((x) => x.supplier_id === e.target.value)!; edit(scns.map((x, j) => j === i ? { ...x, supplier_id: o.supplier_id, unit_price: o.unit_price, delivery_days: o.delivery_days, credit_days: o.credit_days, label: undefined } : x)); }}>
                        {offers.map((o) => <option key={o.supplier_id} value={o.supplier_id}>{o.supplier} · ₹{o.unit_price}</option>)}
                      </Select></div>
                    {(["qty", "unit_price", "discount_pct", "delivery_days"] as const).map((k) => (
                      <div key={k}><Label>{{ qty: "Qty", unit_price: "Price ₹", discount_pct: "Disc %", delivery_days: "Days" }[k]}</Label>
                        <Input type="number" min={0} aria-label={`Option ${String.fromCharCode(65 + i)} ${k}`} value={s[k]} onChange={(e) => edit(scns.map((x, j) => j === i ? { ...x, [k]: e.target.value === "" ? 0 : Number(e.target.value), label: k === "qty" ? undefined : x.label } : x))} className="px-2" /></div>
                    ))}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
                    <span>{s.credit_days ? `${s.credit_days}-day credit` : "No credit"} · MOQ {offers.find((o) => o.supplier_id === s.supplier_id)?.moq ?? "—"}</span>
                    {badges && preview && BADGES.filter(([k]) => badges[k] === preview.scenarios[i]?.label).map(([k, t, c]) => <span key={k} className={cn("rounded px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide", c)}>{t}</span>)}
                  </div>
                </div>
              ))}
              {previewErr && <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">{previewErr.join("; ")}</div>}
              {err && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err.join("; ")}</div>}
              <Button className="w-full" onClick={() => run()} disabled={busy || !scns.length}><Play /> {busy ? "Saving…" : sim && !dirty ? "Saved ✓ — save again" : "Save scenario"}</Button>
              <p className="text-center text-[11px] text-slate-500">Results update live as you edit. Saving stores the scenario set (with an ID) for later comparison.</p>
            </CardContent>
          </Card>

          {saved.data && saved.data.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Saved scenarios</CardTitle></CardHeader>
              <CardContent className="space-y-1">
                {saved.data.slice(0, 6).map((s) => (
                  <Link key={s.id} href={`/think/simulator?sim=${s.id}`} className={cn("flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-slate-50", sim?.id === s.id && "bg-indigo-50")}>
                    <span className="truncate">{s.name}</span><span className="font-mono text-[11px] text-slate-400">{s.id} · {dateTime(s.created_at)}</span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Projected stock by scenario (units)</CardTitle><span className="text-[11px] text-slate-400">stock = available + incoming + delivered qty − demand × days</span></CardHeader>
            <CardContent className="h-64 min-w-0">
              {res ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} margin={{ left: -10, right: 10, top: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <ReferenceLine y={0} stroke="#dc2626" strokeDasharray="4 4" label={{ value: "stockout", fontSize: 10, fill: "#dc2626", position: "insideBottomRight" }} />
                    {res.scenarios.map((r, i) => <Line key={r.label} type="linear" dataKey={r.label} stroke={COLORS[i]} strokeWidth={r.label === best ? 3 : 1.5} dot={false} />)}
                  </LineChart>
                </ResponsiveContainer>
              ) : <div className="flex h-full items-center justify-center text-sm text-slate-400">Run a simulation to see projected stock.</div>}
            </CardContent>
          </Card>

          {res && (
            <>
              <Card>
                <CardHeader><CardTitle>Simulation results · {res.item}</CardTitle><Badge tone="slate">{sim && !dirty ? sim.id : "LIVE · not saved"}</Badge></CardHeader>
                <CardContent className="overflow-x-auto p-0 pb-3">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                      <th className="px-4 py-2 text-left">Metric</th>
                      {res.scenarios.map((r, i) => <th key={r.label} className={cn("px-3 py-2 text-right", r.label === best && "bg-emerald-50 text-emerald-800")} style={{ color: r.label === best ? undefined : COLORS[i] }}>{r.label}{r.label === best ? " ✓" : ""}</th>)}
                    </tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {badges && <tr><td className="px-4 py-1.5 text-slate-600">Best for</td>{res.scenarios.map((r) => <td key={r.label} className="px-3 py-1.5 text-right">
                        <div className="flex flex-wrap justify-end gap-1">{BADGES.filter(([k]) => badges[k] === r.label).map(([k, t, c]) => <span key={k} className={cn("rounded px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide", c)}>{t}</span>)}</div></td>)}</tr>}
                      {([["Purchase cost", (r: SimResult) => inr(r.purchase_cost)], ["Purchase savings", (r: SimResult) => r.purchase_savings ? `+${inr(r.purchase_savings)}` : "—"],
                        ["Cash out now", (r: SimResult) => inr(r.cash_outflow_now)], ["Deferred payable", (r: SimResult) => r.deferred_payable ? inr(r.deferred_payable) : "—"],
                        ["Projected stock", (r: SimResult) => num(r.projected_stock, 1)], ["Stock at need-by", (r: SimResult) => num(r.stock_at_need_by, 1)],
                        ["Expected excess inventory", (r: SimResult) => `${r.excess_units} units`], ["Estimated days to clear", (r: SimResult) => r.days_to_clear !== null ? `${r.days_to_clear} days` : "—"],
                        ["Capital locked in excess", (r: SimResult) => inr(r.capital_locked_in_excess)],
                        ["Stockout risk", (r: SimResult) => <span className={cn("font-mono text-xs font-bold", r.stockout_risk === "LOW" ? "text-emerald-700" : r.stockout_risk === "MEDIUM" ? "text-amber-700" : "text-red-700")}>{r.stockout_risk}</span>],
                        ["Margin", (r: SimResult) => `${pct(r.margin_pct_before)} → ${pct(r.margin_pct_after)}`],
                        ["Working capital impact", (r: SimResult) => <span className={cn("font-mono text-xs font-bold", r.working_capital_impact === "NEGATIVE" ? "text-red-700" : "text-slate-700")}>{r.working_capital_impact}</span>],
                      ] as [string, (r: SimResult) => React.ReactNode][]).map(([k, f]) => (
                        <tr key={k}><td className="px-4 py-1.5 text-slate-600">{k}</td>{res.scenarios.map((r) => <td key={r.label} className={cn("num px-3 py-1.5 text-right font-medium", r.label === best && "bg-emerald-50/50")}>{f(r)}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>

              {badges && (
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  {BADGES.map(([k, t, c]) => (
                    <div key={k} className="rounded-lg border border-slate-200 bg-white p-3">
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide", c)}>{t}</span>
                      <div className="mt-1.5 truncate text-sm font-semibold" title={badges[k]}>{badges[k]}</div>
                      <div className="text-[11px] text-slate-500">{{ best_cost: "lowest effective unit price", best_speed: "fastest delivery", best_coverage: "most stock at the need-by date", best_balanced: "no stockout, least cash tied up" }[k]}</div>
                    </div>
                  ))}
                </div>
              )}

              <Card className="border-l-4 border-l-brand">
                <CardContent className="space-y-3 pt-4">
                  <div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand"><Lightbulb className="h-4 w-4" /></span>
                    <span className="text-lg font-bold">Recommendation</span></div>
                  {res.scenarios.some((r) => r.purchase_savings > 0 && r.capital_locked_in_excess > r.purchase_savings) && (
                    <p className="font-semibold text-red-600">Do not take the discount on the full quantity.</p>)}
                  <ul className="space-y-1 text-sm text-slate-700">{res.verdict.lines.map((l) => <li key={l}>• {l}</li>)}</ul>
                  <p className="text-sm font-semibold">Best option: {best} · Suggested quantity: approximately {res.verdict.suggested_qty} units.</p>
                  <div>
                    <div className="label-xs mb-1.5">Why this decision?</div>
                    <div className="flex flex-wrap gap-1.5">
                      {["Current inventory", "Pending orders", "Recent sales velocity", "Supplier MOQ", "Available cash", "Credit terms", "Expected demand"].map((c) =>
                        <span key={c} className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs text-indigo-700">{c}</span>)}
                    </div>
                  </div>
                  <p className="text-[11px] italic text-slate-500">AI explains the recommendation. Financial and inventory calculations are performed using deterministic business rules.</p>
                  <div className="flex flex-wrap gap-2">
                    {offers.length > 0 && <Button size="sm" disabled={busy} onClick={() => { const o = [...offers].sort((a, b) => a.delivery_days - b.delivery_days || (b.credit_days - a.credit_days))[0];
                      run({ supplier_id: o.supplier_id, qty: Math.max(res.verdict.suggested_qty, o.moq), unit_price: o.unit_price, discount_pct: 0, delivery_days: o.delivery_days, credit_days: o.credit_days }); }}>
                      Simulate {res.verdict.suggested_qty} units</Button>}
                    <Button size="sm" variant="outline" asChild><Link href={`/act?sku=${sku}`}>Compare suppliers</Link></Button>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
