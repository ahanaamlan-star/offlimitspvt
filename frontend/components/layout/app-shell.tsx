"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3, Bell, BookOpen, Brain, Calculator, Camera, ClipboardList, Database, FileText, HelpCircle, LayoutDashboard,
  ListChecks, Menu, PlayCircle, Search, Settings, ShoppingCart, TriangleAlert, Zap, X,
} from "lucide-react";
import { Toaster } from "sonner";
import { DemoProvider, useDemo } from "@/components/demo/demo-provider";
import { EventDrawerProvider } from "@/components/shared/event-drawer";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import type { Health, Summary } from "@/types";

type NavItem = { href: string; label: string; icon: React.ElementType; count?: keyof Summary; countTone?: string };
const NAV: { group?: string; items: NavItem[] }[] = [
  { items: [{ href: "/", label: "Overview", icon: LayoutDashboard }] },
  { group: "See", items: [
    { href: "/see", label: "Capture", icon: Camera },
    { href: "/review", label: "Needs Review", icon: TriangleAlert, count: "needs_review", countTone: "bg-amber-500" },
  ] },
  { group: "Think", items: [
    { href: "/think", label: "Intelligence", icon: Brain, count: "stockout_risks", countTone: "bg-red-500" },
    { href: "/think/simulator", label: "What-If Simulator", icon: Calculator },
  ] },
  { group: "Act", items: [
    { href: "/act", label: "Procurement", icon: ShoppingCart, count: "pending_approvals", countTone: "bg-brand" },
    { href: "/act/purchase-orders", label: "Purchase Orders", icon: FileText },
  ] },
  { group: "Trust", items: [
    { href: "/ledger", label: "Event Ledger", icon: BookOpen },
    { href: "/ledger?view=timeline", label: "Event Timeline", icon: ListChecks },
  ] },
  { group: "Business", items: [
    { href: "/state", label: "Business State", icon: Database },
    { href: "/analytics", label: "Analytics", icon: BarChart3 },
  ] },
];

function isActive(pathname: string, href: string) {
  const path = href.split("?")[0];
  if (path === "/") return pathname === "/";
  if (path === "/act") return pathname === "/act";
  if (path === "/think") return pathname === "/think";
  return pathname === path || pathname.startsWith(path + "/");
}

function Sidebar({ summary, health, onNavigate }: { summary: Summary | null; health: Health | null; onNavigate?: () => void }) {
  const pathname = usePathname();
  const [view, setView] = React.useState<string | null>(null);
  React.useEffect(() => { setView(new URLSearchParams(window.location.search).get("view")); }, [pathname]);
  return (
    <nav className="flex h-full flex-col bg-nav text-nav-text" aria-label="Primary">
      <div className="border-b border-nav-border px-5 py-5">
        <Link href="/" className="flex items-center gap-2.5" onClick={onNavigate}>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-white"><Zap className="h-4 w-4" fill="currentColor" /></span>
          <span>
            <span className="block text-[15px] font-extrabold tracking-wide text-white">OFFLIMITS</span>
            <span className="block text-[11px] text-nav-muted">Merchant Intelligence Loop</span>
          </span>
        </Link>
        <div className="mt-3 inline-block rounded border border-nav-border px-1.5 py-0.5 text-[10px] font-semibold tracking-widest text-nav-muted">PS21 · FINTECH & COMMERCE</div>
      </div>
      <div className="nav-scroll flex-1 overflow-y-auto px-3 py-3">
        {NAV.map((g, gi) => (
          <div key={gi} className="mb-3">
            {g.group && <div className="px-2 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-nav-muted">{g.group}</div>}
            {g.items.map((it) => {
              const hasView = it.href.includes("view=");
              const active = isActive(pathname, it.href) && (hasView ? view === "timeline" : !(it.href === "/ledger" && view === "timeline"));
              const count = it.count && summary ? (summary[it.count] as number) : 0;
              return (
                <Link key={it.href} href={it.href} onClick={onNavigate}
                  className={cn("relative mb-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] transition-colors",
                    active ? "bg-nav-active font-semibold text-white" : "hover:bg-nav-hover hover:text-white")}
                  aria-current={active ? "page" : undefined}>
                  {active && <span className="absolute right-0 top-1.5 h-6 w-0.5 rounded bg-indigo-400" />}
                  <it.icon className="h-4 w-4 shrink-0 opacity-80" />
                  <span className="flex-1">{it.label}</span>
                  {count > 0 && <span className={cn("rounded-full px-1.5 text-[10.5px] font-bold text-white", it.countTone)}>{count}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
      <div className="space-y-0.5 border-t border-nav-border px-3 py-3">
        <Link href="/settings" onClick={onNavigate} className={cn("flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] hover:bg-nav-hover hover:text-white", pathname === "/settings" && "bg-nav-active text-white")}>
          <Settings className="h-4 w-4 opacity-80" /> Settings
        </Link>
        <a href="/settings#help" className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] hover:bg-nav-hover hover:text-white"><HelpCircle className="h-4 w-4 opacity-80" /> Help</a>
        <div className="mt-2 flex items-center gap-2 rounded-md bg-white/5 px-2.5 py-2 text-[11px] text-nav-text">
          <span className={cn("h-1.5 w-1.5 rounded-full", health?.database.ok ? "bg-emerald-400" : "bg-red-400")} />
          {health?.database.ok ? "Business state synced from ledger" : "Backend offline"}
        </div>
      </div>
    </nav>
  );
}

function Topbar({ health, summary, onMenu }: { health: Health | null; summary: Summary | null; onMenu: () => void }) {
  const demo = useDemo();
  const router = useRouter();
  const [q, setQ] = React.useState("");
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:px-6">
      <button className="rounded p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={onMenu} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-semibold text-slate-800">Rajesh General Stores</span>
        <span className="hidden rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-700 sm:inline">DEMO BUSINESS</span>
      </div>
      <form className="ml-auto hidden md:block" onSubmit={(e) => { e.preventDefault(); if (q.trim()) router.push(`/ledger?q=${encodeURIComponent(q.trim())}`); }}>
        <label className="relative block">
          <span className="sr-only">Search the event ledger</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ledger (EVT, SKU, supplier)…"
            className="h-9 w-64 rounded-md border border-slate-200 bg-slate-50 pl-8 pr-3 text-sm placeholder:text-slate-400 focus:border-brand focus:bg-white focus:outline-none" />
        </label>
      </form>
      <div className="ml-auto flex items-center gap-2 md:ml-0">
        <Link href="/review" className="relative rounded-md border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" aria-label="Items needing review">
          <Bell className="h-4 w-4" />
          {!!summary?.needs_review && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" />}
        </Link>
        <span className={cn("hidden items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold sm:flex",
          health?.status === "online" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700")}>
          <span className={cn("h-1.5 w-1.5 rounded-full", health?.status === "online" ? "bg-emerald-500" : "bg-red-500")} />
          {health ? (health.status === "online" ? "SYSTEM ONLINE" : "DEGRADED") : "CONNECTING…"}
        </span>
        <Link href="/settings" className={cn("rounded-md border px-2.5 py-1.5 text-xs font-bold",
          health?.mode === "LIVE" ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-amber-200 bg-amber-50 text-amber-700")}
          title={health?.mode === "LIVE" ? "Gemini is configured" : "No GEMINI_API_KEY — deterministic demo extraction"}>
          {health?.mode === "LIVE" ? "LIVE MODE" : "DEMO MODE"}
        </Link>
        <button onClick={demo.open} className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
          <PlayCircle className="h-4 w-4" /> <span className="hidden sm:inline">Run 3-minute demo</span><span className="sm:hidden">Demo</span>
        </button>
        <span className="hidden h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-bold text-white sm:flex" title="Rajesh Sharma (owner)">RS</span>
      </div>
    </header>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobile, setMobile] = React.useState(false);
  const { data: health } = useApi<Health>("/api/health");
  const { data: state } = useApi<{ summary: Summary }>("/api/business-state");
  React.useEffect(() => setMobile(false), [pathname]);
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 lg:block"><Sidebar summary={state?.summary ?? null} health={health} /></aside>
      {mobile && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setMobile(false)} />
          <div className="absolute inset-y-0 left-0 w-64">
            <button className="absolute right-2 top-2 z-10 rounded p-1 text-white/70 hover:bg-white/10" onClick={() => setMobile(false)} aria-label="Close menu"><X className="h-4 w-4" /></button>
            <Sidebar summary={state?.summary ?? null} health={health} onNavigate={() => setMobile(false)} />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <Topbar health={health} summary={state?.summary ?? null} onMenu={() => setMobile(true)} />
        {health && health.mode === "DEMO" && <ModeBanner />}
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 lg:px-8">{children}</main>
        <footer className="border-t border-slate-200 px-8 py-3 text-[11px] text-slate-400">
          OFFLIMITS · Merchant Intelligence Loop — prototype. All business data shown is fictional DEMO DATA. AI understands and explains · deterministic logic calculates · humans approve.
        </footer>
      </div>
    </div>
  );
}

function ModeBanner() {
  const [hidden, setHidden] = React.useState(false);
  if (hidden) return null;
  return (
    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900 lg:px-8">
      <ClipboardList className="h-3.5 w-3.5" />
      <span><b>Demo Mode</b> — no GEMINI_API_KEY configured. Extraction uses deterministic rules and bundled demo fixtures; all workflows remain available.</span>
      <button className="ml-auto text-amber-700 hover:underline" onClick={() => setHidden(true)}>Dismiss</button>
    </div>
  );
}

/** Toasts are client-only (nothing to pre-render), which keeps static-export hydration deterministic. */
function ClientToaster() {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted ? <Toaster position="top-right" richColors closeButton /> : null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DemoProvider>
      <EventDrawerProvider>
        <Shell>{children}</Shell>
        <ClientToaster />
      </EventDrawerProvider>
    </DemoProvider>
  );
}
