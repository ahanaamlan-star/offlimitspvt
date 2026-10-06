"use client";
import * as React from "react";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileText, GitBranch, MessageSquare, ShoppingCart, ThumbsUp, Undo2, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { CategoryBadge, Empty, ErrorState, Loading, PageHeader, StatusBadge } from "@/components/shared/bits";
import { LoopStrip } from "@/components/shared/loop";
import { useEventDrawer } from "@/components/shared/event-drawer";
import { useApi } from "@/hooks/useApi";
import { dateShort, isToday, time, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LedgerEvent } from "@/types";

const SOURCES = [["", "All sources"], ["invoice", "Invoice"], ["receipt", "Receipt"], ["quotation", "Quotation"], ["message", "Message"], ["voice", "Voice"],
  ["image", "Image"], ["text", "Quick entry"], ["user", "Merchant (manual)"], ["engine", "OFFLIMITS engine"], ["delivery", "Delivery"], ["pos", "POS"], ["seed", "Demo seed"]] as const;
const TYPES = ["INPUT_RECEIVED", "PURCHASE_RECEIVED", "SUPPLIER_QUOTE", "SUPPLIER_PRICE_UPDATE", "CUSTOMER_ORDER", "ORDER_FULFILLED", "SALE", "PAYMENT_RECEIVED",
  "PAYMENT_MADE", "DAMAGED_STOCK", "RISK_DETECTED", "SUPPLIERS_EVALUATED", "PROCUREMENT_APPROVED", "RECOMMENDATION_REJECTED", "PURCHASE_ORDER_CREATED", "EVENT_REVERSED"];
const CATS = ["ALL", "SOURCE", "EVENT", "INTELLIGENCE", "DECISION", "APPROVAL", "ACTION", "CORRECTION"] as const;

export default function LedgerPage() {
  return <Suspense fallback={<Loading />}><Ledger /></Suspense>;
}

const ICON: Record<string, React.ElementType> = {
  SOURCE: FileText, EVENT: CheckCircle2, INTELLIGENCE: AlertTriangle, DECISION: GitBranch, APPROVAL: ThumbsUp, ACTION: ShoppingCart,
  CORRECTION: Undo2, OPENING: FileText,
};
const RING: Record<string, string> = {
  SOURCE: "border-slate-300 bg-slate-50 text-slate-500", EVENT: "border-emerald-300 bg-emerald-50 text-emerald-600",
  INTELLIGENCE: "border-amber-300 bg-amber-50 text-amber-600", DECISION: "border-violet-300 bg-violet-50 text-violet-600",
  APPROVAL: "border-emerald-300 bg-emerald-50 text-emerald-600", ACTION: "border-indigo-300 bg-indigo-50 text-indigo-600",
  CORRECTION: "border-red-300 bg-red-50 text-red-600", OPENING: "border-slate-300 bg-slate-50 text-slate-500",
};

function Ledger() {
  const params = useSearchParams();
  const router = useRouter();
  const view = params.get("view") === "timeline" ? "timeline" : "table";
  const [cat, setCat] = React.useState<(typeof CATS)[number]>("ALL");
  const [q, setQ] = React.useState(params.get("q") ?? "");
  const [opening, setOpening] = React.useState(false);
  const [pos, setPos] = React.useState(false);
  const [source, setSource] = React.useState("");
  const [etype, setEtype] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  React.useEffect(() => setQ(params.get("q") ?? ""), [params]);

  const qs = new URLSearchParams();
  if (cat !== "ALL") qs.set("category", cat);
  if (opening) qs.set("include_opening", "true");
  qs.set("include_pos", String(pos || source === "pos"));
  if (source) qs.set("source", source);
  if (etype) qs.set("type", etype);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (q.trim()) qs.set("q", q.trim());
  qs.set("limit", "300");
  const { data, error, loading, reload } = useApi<LedgerEvent[]>(`/api/events?${qs.toString()}`);
  const drawer = useEventDrawer();

  const today = (data ?? []).filter((e) => isToday(e.ts));
  const active = [
    today.some((e) => e.category === "SOURCE") && "INPUT", today.some((e) => e.category === "EVENT") && "UNDERSTAND",
    today.some((e) => e.category === "INTELLIGENCE" || e.category === "DECISION") && "DECIDE", today.some((e) => e.category === "APPROVAL") && "APPROVE",
    today.some((e) => e.category === "ACTION") && "ACT", today.some((e) => e.category === "ACTION") && "STATE",
  ].filter(Boolean) as string[];

  return (
    <div>
      <PageHeader kicker="Trust" title={view === "timeline" ? "Business Event Timeline" : "Event Ledger"}
        subtitle={view === "timeline" ? "Complete chronological audit of every event in this session." : "Every important state change is traceable. State is derived from these events — nothing is silently overwritten."}
        actions={<Tabs value={view} onChange={(v) => router.push(v === "timeline" ? "/ledger?view=timeline" : "/ledger")} items={[{ value: "table", label: "Ledger table" }, { value: "timeline", label: "Timeline" }]} />} />

      <Card className="mb-4"><CardContent className="py-3">
        <div className="label-xs mb-2">Today&apos;s loop · input → understand → decide → approve → act → updated state</div>
        <LoopStrip active={active} />
      </CardContent></Card>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={cat} onChange={setCat} items={CATS.map((c) => ({ value: c, label: c === "ALL" ? "All" : titleCase(c) }))} />
        <form className="relative ml-auto" onSubmit={(e) => { e.preventDefault(); router.replace(`/ledger?${view === "timeline" ? "view=timeline&" : ""}q=${encodeURIComponent(q)}`); }}>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search EVT-, SKU, supplier…" className="w-64 pl-8" aria-label="Search events" />
        </form>
        <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={opening} onChange={(e) => setOpening(e.target.checked)} className="accent-indigo-600" /> Opening balances</label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={pos} onChange={(e) => setPos(e.target.checked)} className="accent-indigo-600" /> Daily POS summaries</label>
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div><Label htmlFor="f-source">Source</Label>
          <Select id="f-source" value={source} onChange={(e) => setSource(e.target.value)} className="w-44">{SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
        <div><Label htmlFor="f-type">Event type</Label>
          <Select id="f-type" value={etype} onChange={(e) => setEtype(e.target.value)} className="w-56"><option value="">All event types</option>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></div>
        <div><Label htmlFor="f-from">From</Label><Input id="f-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /></div>
        <div><Label htmlFor="f-to">To</Label><Input id="f-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" /></div>
        {(source || etype || from || to || cat !== "ALL" || q) && <Button size="sm" variant="ghost" onClick={() => { setSource(""); setEtype(""); setFrom(""); setTo(""); setCat("ALL"); setQ(""); router.replace(view === "timeline" ? "/ledger?view=timeline" : "/ledger"); }}>Clear filters</Button>}
        {data && <span className="ml-auto text-xs text-slate-500">{data.length} event{data.length === 1 ? "" : "s"}</span>}
      </div>

      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <Loading />}
      {data && data.length === 0 && <Empty title="No events match" icon={<MessageSquare className="h-8 w-8" />}>Try clearing the filters.</Empty>}

      {data && data.length > 0 && view === "table" && (
        <Card><CardContent className="p-0">
          <Table>
            <THead><tr><TH>Timestamp</TH><TH>Event ID</TH><TH>Category</TH><TH>Source</TH><TH>Event type</TH><TH>Entity</TH><TH>Change</TH><TH className="text-right">Confidence</TH><TH>Actor</TH><TH>Status</TH></tr></THead>
            <TBody>
              {data.map((e) => (
                <tr key={e.id} onClick={() => drawer.open(e.id)} className={cn("cursor-pointer hover:bg-slate-50", e.status === "REVERSED" && "opacity-50 line-through")}>
                  <TD className="font-mono text-xs">{isToday(e.ts) ? time(e.ts) : `${dateShort(e.ts)} ${time(e.ts)}`}</TD>
                  <TD><span className="font-mono text-xs font-semibold text-brand">{e.id}</span></TD>
                  <TD><CategoryBadge c={e.category} /></TD>
                  <TD className="max-w-[180px] truncate text-xs">{titleCase(e.source_type)}{e.source_ref ? ` · ${e.source_ref}` : ""}</TD>
                  <TD className="font-mono text-[11px]">{e.type}</TD>
                  <TD className="max-w-[160px] truncate">{e.entity_name ?? "—"}</TD>
                  <TD className="max-w-[260px] truncate font-medium text-slate-800" title={e.title}>{e.change || e.title}</TD>
                  <TD className="num text-right text-xs">{e.confidence !== null ? `${Math.round(e.confidence * 100)}%` : "—"}</TD>
                  <TD className="text-xs">{e.actor}</TD>
                  <TD><StatusBadge s={e.status} /></TD>
                </tr>
              ))}
            </TBody>
          </Table>
        </CardContent></Card>
      )}

      {data && data.length > 0 && view === "timeline" && (
        <div className="relative max-w-4xl pl-12">
          <div className="absolute bottom-2 left-[19px] top-2 w-px bg-slate-200" aria-hidden />
          {data.map((e, i) => {
            const Icon = ICON[e.category] ?? FileText;
            const newDay = i === 0 || new Date(data[i - 1].ts).toDateString() !== new Date(e.ts).toDateString();
            return (
              <React.Fragment key={e.id}>
                {newDay && <div className="relative mb-2 mt-4 -ml-12 pl-12 text-xs font-semibold uppercase tracking-wider text-slate-400 first:mt-0">{isToday(e.ts) ? "Today" : new Date(e.ts).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}</div>}
                <div className="relative mb-2.5">
                  <span className={cn("absolute -left-12 top-3 flex h-[38px] w-[38px] items-center justify-center rounded-full border-2 bg-white", RING[e.category])}><Icon className="h-4 w-4" /></span>
                  <button onClick={() => drawer.open(e.id)} className={cn("flex w-full items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left shadow-card hover:border-slate-300", e.status === "REVERSED" && "opacity-50")}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] text-slate-400">{time(e.ts)}</span><CategoryBadge c={e.category} />
                        <span className="text-[14.5px] font-semibold text-slate-900">{e.title}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[13px] text-slate-500">{[e.change, e.source_ref].filter(Boolean).join(" • ")}</div>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-slate-300">{e.id} ›</span>
                  </button>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
