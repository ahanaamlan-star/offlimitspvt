"use client";
import * as React from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, ServerCrash } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ApiError } from "@/lib/api";
import type { Severity } from "@/types";

export function PageHeader({ title, subtitle, kicker, actions }: { title: string; subtitle?: string; kicker?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {kicker && <div className="label-xs mb-1 text-brand">{kicker}</div>}
        <h1 className="text-[26px] font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 py-12 text-sm text-slate-500", className)}>
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  if (!error) return null;
  const details = (error as ApiError).details ?? [error.message];
  const offline = (error as ApiError).status === 0 || /unavailable|Network/.test(details.join(" "));
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
      <ServerCrash className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <div className="font-semibold">{offline ? "DATABASE / BACKEND UNAVAILABLE" : "Something went wrong"}</div>
        <ul className="mt-1 list-disc pl-4">{details.map((d, i) => <li key={i}>{d}</li>)}</ul>
        {offline && <p className="mt-1 text-red-700">Start the API with <code className="rounded bg-red-100 px-1">uvicorn app.main:app --port 8000</code>.</p>}
      </div>
      {onRetry && <button onClick={onRetry} className="rounded border border-red-300 px-2 py-1 text-xs font-medium hover:bg-red-100">Retry</button>}
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 px-6 py-10 text-center">
      <div className="mb-2 text-slate-300">{icon ?? <CircleDashed className="h-8 w-8" />}</div>
      <div className="text-sm font-semibold text-slate-700">{title}</div>
      {children && <div className="mt-1 max-w-sm text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export const severityTone: Record<Severity, Tone> = { CRITICAL: "red", HIGH: "amber", MEDIUM: "sky", LOW: "green" };

export function SeverityBadge({ s }: { s: Severity }) {
  return <Badge tone={severityTone[s]}>{s}</Badge>;
}

export const categoryTone: Record<string, Tone> = {
  SOURCE: "slate", EVENT: "green", INTELLIGENCE: "amber", DECISION: "violet", APPROVAL: "green", ACTION: "indigo",
  OPENING: "slate", CORRECTION: "red",
};

export function CategoryBadge({ c }: { c: string }) {
  return <Badge tone={categoryTone[c] ?? "slate"}>{c}</Badge>;
}

export function StatusBadge({ s }: { s: string }) {
  const tone: Tone = ({ PROPOSED: "indigo", NEEDS_REVIEW: "amber", CONFIRMED: "green", REJECTED: "red", PENDING: "amber",
    APPROVED: "green", SUPERSEDED: "slate", RECEIVED: "green", OPEN: "sky", FULFILLED: "green", REVERSED: "red",
    "AT RISK": "red", OK: "green" } as Record<string, Tone>)[s] ?? "slate";
  return <Badge tone={tone}>{s.replace("_", " ")}</Badge>;
}

export function Confidence({ value, threshold = 0.75, className }: { value: number | null | undefined; threshold?: number; className?: string }) {
  if (value === null || value === undefined) return <span className="text-xs text-slate-400">—</span>;
  const pct = Math.round(value * 100);
  const low = value < threshold;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Progress value={pct} className="w-20" tone={low ? "bg-amber-500" : "bg-emerald-500"} />
      <span className={cn("font-mono text-[11px]", low ? "text-amber-700" : "text-slate-500")}>{pct}% confidence</span>
    </div>
  );
}

export function DemoTag({ className }: { className?: string }) {
  return <Badge tone="amber" className={className}>DEMO DATA</Badge>;
}

export function Stat({ label, value, sub, tone, icon, href }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "red" | "amber" | "green" | "indigo"; icon?: React.ReactNode; href?: string }) {
  const color = tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : tone === "green" ? "text-emerald-700" : tone === "indigo" ? "text-brand" : "text-slate-900";
  const inner = (
    <div className="h-full rounded-xl border border-slate-200 bg-white p-4 shadow-card transition-colors hover:border-slate-300">
      <div className="flex items-center justify-between">
        <span className="label-xs">{label}</span>
        <span className="text-slate-300">{icon}</span>
      </div>
      <div className={cn("num mt-2 text-[22px] font-bold leading-none", color)}>{value}</div>
      {sub && <div className="mt-1.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
  return href ? <a href={href} className="block">{inner}</a> : inner;
}

export function Notice({ tone = "amber", title, children, icon }: { tone?: "amber" | "red" | "green" | "indigo" | "slate"; title?: string; children: React.ReactNode; icon?: React.ReactNode }) {
  const styles = {
    amber: "border-amber-200 bg-amber-50 text-amber-900", red: "border-red-200 bg-red-50 text-red-900",
    green: "border-emerald-200 bg-emerald-50 text-emerald-900", indigo: "border-indigo-200 bg-indigo-50 text-indigo-900",
    slate: "border-slate-200 bg-slate-50 text-slate-700",
  }[tone];
  const Icon = tone === "green" ? CheckCircle2 : AlertTriangle;
  return (
    <div className={cn("flex items-start gap-2.5 rounded-lg border p-3 text-sm", styles)}>
      <span className="mt-0.5 shrink-0">{icon ?? <Icon className="h-4 w-4" />}</span>
      <div>{title && <div className="font-semibold">{title}</div>}<div className={title ? "mt-0.5" : ""}>{children}</div></div>
    </div>
  );
}

export function KV({ label, value, mono, className }: { label: string; value: React.ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-slate-200 bg-white px-3 py-2", className)}>
      <div className="label-xs !text-[10px]">{label}</div>
      <div className={cn("mt-0.5 text-sm font-semibold text-slate-900", mono && "font-mono")}>{value}</div>
    </div>
  );
}
