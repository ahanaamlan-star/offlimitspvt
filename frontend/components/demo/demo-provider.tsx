"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, Hand, Loader2, Pause, Play, RotateCcw, SkipBack, SkipForward, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, ApiError, notifyChanged } from "@/lib/api";
import { inr } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AnalyzeResult, InventoryRow, Recommendation, Simulation } from "@/types";

type Status = "idle" | "running" | "done" | "waiting" | "error";
interface Ctx { routes: Record<number, string>; artifactId?: string; proposals?: AnalyzeResult["proposals"]; recId?: string; simId?: string; poId?: string;
  cokeBefore?: InventoryRow; approval?: { before: any; after: any } }

const STEPS = [
  { group: 0, title: "Merchant overview", detail: "Rajesh General Stores (DEMO DATA): cash, stock, open orders and live risks on the Command Center.", route: "/" },
  { group: 0, title: "Supplier invoice uploaded", detail: "Metro Beverages invoice INV-2841 (demo image) is uploaded on SEE.", route: "/see" },
  { group: 0, title: "Event extracted", detail: "The image becomes structured events with source, confidence and timestamp.", route: "/see" },
  { group: 0, title: "Event reviewed & confirmed", detail: "The merchant confirms the extracted events — only now do they enter the ledger.", route: "/see" },
  { group: 1, title: "Inventory updated", detail: "Business state is re-derived from the ledger: Coke stock rises and the open PO closes.", route: "/state?tab=inventory&highlight=SKU-1042" },
  { group: 1, title: "WhatsApp order received", detail: "“Kal 25 Coke aur 10 Sprite bhej dena” from Ramesh Stores reserves stock.", route: "/see" },
  { group: 1, title: "Stockout risk detected", detail: "Reserved orders + forecast demand exceed stock → shortage predicted.", route: "/think?focus=SKU-1042" },
  { group: 1, title: "Supplier comparison", detail: "Suppliers are scored on price, MOQ, delivery, credit and cash impact.", route: "/act" },
  { group: 1, title: "What-if analysis", detail: "“Supplier is giving 15% discount if I buy 100 units. Should I take it?”", route: "/think/simulator" },
  { group: 2, title: "Recommendation created", detail: "A deterministic recommendation with an explanation of why.", route: "/act" },
  { group: 2, title: "Human approval", detail: "Consequential action: the merchant must review and click Approve.", route: "/act" },
  { group: 2, title: "Purchase order created", detail: "Approved purchase order with full traceability.", route: "/act/purchase-orders" },
  { group: 3, title: "Event ledger updated", detail: "Input → intelligence → decision → approval → action, all on the timeline.", route: "/ledger?view=timeline" },
  { group: 3, title: "Business state updated", detail: "Shortage cleared, incoming stock recorded, payable deferred on credit.", route: "/state?tab=inventory&highlight=SKU-1042" },
];
const GROUPS = ["01 SEE", "02 THINK", "03 ACT", "04 UPDATED STATE"];
const APPROVAL = 10;

const DemoCtx = React.createContext<{ open: () => void; running: boolean }>({ open: () => {}, running: false });
export const useDemo = () => React.useContext(DemoCtx);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [visible, setVisible] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const [statuses, setStatuses] = React.useState<Status[]>(STEPS.map(() => "idle"));
  const [notes, setNotes] = React.useState<string[]>(STEPS.map(() => ""));
  const [next, setNext] = React.useState(0);
  const [auto, setAuto] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const ctx = React.useRef<Ctx>({ routes: {} });
  const autoRef = React.useRef(false);
  autoRef.current = auto;

  const set = (i: number, s: Status, note?: string) => {
    setStatuses((p) => p.map((x, j) => (j === i ? s : x)));
    if (note !== undefined) setNotes((p) => p.map((x, j) => (j === i ? note : x)));
  };

  const findCokeRec = async () => {
    const recs = await api.get<Recommendation[]>("/api/recommendations?status=PENDING");
    return recs.find((r) => r.sku === "SKU-1042");
  };

  const run = React.useCallback(async (i: number): Promise<boolean> => {
    const c = ctx.current;
    set(i, "running");
    try {
      switch (i) {
        case 0: {
          const ov = await api.get<any>("/api/overview");
          c.cokeBefore = (ov.inventory as InventoryRow[]).find((r) => r.sku === "SKU-1042");
          c.routes[0] = "/";
          router.push("/");
          set(i, "done", `Cash ${inr(ov.summary.cash)} · ${ov.summary.skus} SKUs · ${ov.summary.open_orders} open orders · ${ov.risks.length} risks`);
          break;
        }
        case 1: {
          const blob = await (await fetch("/demo/images/demo_invoice_metro_INV-2841.png")).blob();
          const fd = new FormData();
          fd.append("kind", "invoice");
          fd.append("file", new File([blob], "demo_invoice_metro_INV-2841.png", { type: "image/png" }));
          const res = await api.form<AnalyzeResult>("/api/inputs/analyze", fd);
          c.artifactId = res.artifact.id;
          c.proposals = res.proposals;
          c.routes[1] = c.routes[2] = c.routes[3] = `/see?artifact=${res.artifact.id}`;
          router.push(c.routes[1]);
          set(i, "done", `${res.artifact.id} · ${res.understanding.document_no ?? "document"} from ${res.understanding.supplier ?? "supplier"} (${res.understanding.mode === "gemini" ? "Gemini" : "demo OCR fixture"})`);
          break;
        }
        case 2: {
          const p = c.proposals ?? [];
          if (!p.length) throw new Error("No events were extracted — reset the demo and try again.");
          set(i, "done", p.map((x) => `${x.type} (${Math.round(x.confidence * 100)}%)`).join(" · "));
          break;
        }
        case 3: {
          const ids: string[] = [];
          for (const p of c.proposals ?? []) {
            const r = await api.post<{ event: { id: string } }>(`/api/proposals/${p.id}/confirm`, {});
            ids.push(r.event.id);
          }
          notifyChanged();
          set(i, "done", `${ids.length} events confirmed → ${ids.join(", ")}`);
          break;
        }
        case 4: {
          const inv = await api.get<InventoryRow[]>("/api/inventory");
          const now = inv.find((r) => r.sku === "SKU-1042")!;
          router.push(STEPS[4].route);
          set(i, "done", `Coca-Cola on hand ${c.cokeBefore?.on_hand ?? "?"} → ${now.on_hand}; incoming ${c.cokeBefore?.incoming ?? "?"} → ${now.incoming} (PO OFF-2026-087 closed)`);
          break;
        }
        case 5: {
          const fd = new FormData();
          fd.append("kind", "message");
          fd.append("sender", "Ramesh Stores");
          fd.append("text", "Kal 25 Coke aur 10 Sprite bhej dena");
          const res = await api.form<AnalyzeResult>("/api/inputs/analyze", fd);
          c.routes[5] = `/see?artifact=${res.artifact.id}`;
          router.push(c.routes[5]);
          for (const p of res.proposals) await api.post(`/api/proposals/${p.id}/confirm`, {});
          notifyChanged();
          set(i, "done", `${res.proposals.map((p) => p.summary).join("; ")} — confirmed`);
          break;
        }
        case 6: {
          router.push(STEPS[6].route);
          const risks = await api.get<any[]>("/api/risks");
          const r = risks.find((x) => x.type === "STOCKOUT" && x.sku === "SKU-1042");
          set(i, "done", r ? `Coca-Cola: stock ${r.metrics.current_stock}, reserved ${r.metrics.reserved} → shortage ${r.metrics.expected_shortage} units` : "No Coca-Cola shortage detected");
          break;
        }
        case 7: {
          const rec = await findCokeRec();
          if (!rec) throw new Error("No pending Coca-Cola recommendation — reset the demo and start again.");
          c.recId = rec.id;
          c.routes[7] = c.routes[9] = `/act?rec=${rec.id}`;
          router.push(c.routes[7]);
          set(i, "done", `${rec.comparison.options.length} suppliers scored · ${rec.supplier} best (${rec.comparison.options.find((o) => o.recommended)?.score})`);
          break;
        }
        case 8: {
          const sim = await api.post<Simulation>("/api/simulations", {
            sku: "SKU-1042", question: "Supplier is giving me 15% discount if I buy 100 units. Should I take it?",
            scenarios: [{ supplier_id: "SUP-A", qty: 100, discount_pct: 15, label: "Discount deal · 100 units" },
              { supplier_id: "SUP-B", qty: 20 }, { supplier_id: "SUP-B", qty: 55 }],
          });
          c.simId = sim.id;
          c.routes[8] = `/think/simulator?sim=${sim.id}`;
          router.push(c.routes[8]);
          set(i, "done", sim.results.verdict.lines[0] ?? "Scenarios compared");
          break;
        }
        case 9: {
          const rec = c.recId ? await api.get<Recommendation>(`/api/recommendations/${c.recId}`) : await findCokeRec();
          if (!rec) throw new Error("Recommendation not found");
          router.push(`/act?rec=${rec.id}`);
          set(i, "done", `Purchase ${rec.qty} × ${inr(rec.unit_price)} from ${rec.supplier} = ${inr(rec.total)}`);
          break;
        }
        case 10: {
          c.routes[10] = `/act?rec=${c.recId}&approve=1`;
          router.push(c.routes[10]);
          set(i, "waiting", "Waiting for the merchant to approve in the dialog…");
          return false; // completes when the approval event arrives
        }
        case 11: {
          if (!c.poId) throw new Error("Approve the recommendation first");
          c.routes[11] = `/act/purchase-orders/view?id=${c.poId}`;
          router.push(c.routes[11]);
          set(i, "done", `${c.poId} · APPROVED → recorded in the ledger`);
          break;
        }
        case 12: {
          router.push(STEPS[12].route);
          set(i, "done", "Input → intelligence → decision → approval → action, all traceable");
          break;
        }
        case 13: {
          router.push(STEPS[13].route);
          const a = c.approval;
          set(i, "done", a ? `Shortage ${a.before.predicted_shortage} → ${a.after.predicted_shortage} · incoming +${a.after.incoming - a.before.incoming} · cash ${inr(a.after.cash)} (credit)` : "State updated");
          break;
        }
      }
      return true;
    } catch (e) {
      const msg = (e as ApiError).details?.join("; ") ?? (e as Error).message;
      set(i, "error", msg);
      toast.error(msg);
      setAuto(false);
      return false;
    }
  }, [router]);

  // approval arrives from the ACT page
  React.useEffect(() => {
    const h = (ev: Event) => {
      const d = (ev as CustomEvent).detail;
      ctx.current.poId = d.po_id;
      ctx.current.approval = { before: d.before, after: d.after };
      setStatuses((p) => p.map((x, j) => (j === APPROVAL && x === "waiting" ? "done" : x)));
      setNotes((p) => p.map((x, j) => (j === APPROVAL ? `Approved by ${d.actor} → ${d.po_id}` : x)));
      setNext((n) => (n === APPROVAL ? APPROVAL + 1 : n));
    };
    window.addEventListener("offlimits:approved", h);
    return () => window.removeEventListener("offlimits:approved", h);
  }, []);

  const step = React.useCallback(async () => {
    if (busy || next >= STEPS.length) return;
    setBusy(true);
    const ok = await run(next);
    setBusy(false);
    if (ok) setNext((n) => n + 1);
  }, [busy, next, run]);

  // auto-play
  React.useEffect(() => {
    if (!auto || busy || next >= STEPS.length || statuses[next] === "waiting" || statuses[APPROVAL] === "waiting") return;
    const t = setTimeout(() => { if (autoRef.current) step(); }, next === 0 ? 300 : 4500);
    return () => clearTimeout(t);
  }, [auto, busy, next, statuses, step]);

  /** Back revisits the previous step's screen. Recorded events stay in the ledger (it is append-only). */
  const [viewing, setViewing] = React.useState<number | null>(null);
  const back = () => {
    const cur = viewing ?? Math.min(next, STEPS.length) - 1;
    const prev = Math.max(0, cur - 1);
    setAuto(false);
    setViewing(prev);
    router.push(ctx.current.routes[prev] || STEPS[prev].route);
  };
  React.useEffect(() => { setViewing(null); }, [next]);

  const reset = async (start = false) => {
    setBusy(true);
    try {
      await api.post("/api/demo/reset");
      ctx.current = { routes: {} };
      setStatuses(STEPS.map(() => "idle"));
      setNotes(STEPS.map(() => ""));
      setNext(0);
      setViewing(null);
      notifyChanged();
      toast.success("Demo business reset");
      if (!start) router.push("/");
    } catch (e) {
      toast.error((e as ApiError).details?.join("; ") ?? "Reset failed");
    } finally {
      setBusy(false);
    }
    if (start) setAuto(true);
  };

  const done = statuses.filter((s) => s === "done").length;

  return (
    <DemoCtx.Provider value={{ open: () => { setVisible(true); setCollapsed(false); }, running: auto }}>
      {children}
      {visible && (
        <div className="fixed bottom-4 right-4 z-40 w-[390px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl" role="region" aria-label="Guided demo">
          <div className="flex items-center justify-between bg-slate-900 px-4 py-3 text-white">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-indigo-300">Guided demo · Demo data</div>
              <div className="text-sm font-semibold">Run 3-minute demo · {done}/{STEPS.length}</div>
            </div>
            <div className="flex items-center gap-1">
              <button className="rounded p-1 hover:bg-white/10" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expand" : "Collapse"}>
                {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              <button className="rounded p-1 hover:bg-white/10" onClick={() => { setVisible(false); setAuto(false); }} aria-label="Close guided demo"><X className="h-4 w-4" /></button>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1 bg-slate-900 px-4 pb-3">
            {GROUPS.map((g, gi) => {
              const idx = STEPS.map((x, i) => (x.group === gi ? i : -1)).filter((i) => i >= 0);
              const d = idx.filter((i) => statuses[i] === "done").length;
              const active = idx.includes(Math.min(next, STEPS.length - 1)) && next < STEPS.length;
              return (
                <div key={g} title={g}>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${(d / idx.length) * 100}%` }} /></div>
                  <div className={cn("mt-1 truncate text-[9.5px] font-semibold uppercase tracking-wider", active ? "text-white" : "text-slate-400")}>{g}</div>
                </div>
              );
            })}
          </div>
          {!collapsed && (
            <>
              <ol className="max-h-[46vh] space-y-0.5 overflow-y-auto p-2 scrollbar-thin">
                {STEPS.map((s, i) => {
                  const st = statuses[i];
                  const Icon = st === "done" ? CheckCircle2 : st === "running" ? Loader2 : st === "waiting" ? Hand : st === "error" ? XCircle : Circle;
                  const head = i === 0 || STEPS[i - 1].group !== s.group;
                  return (
                    <React.Fragment key={i}>
                      {head && <li className="px-2.5 pb-0.5 pt-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-indigo-600">{GROUPS[s.group]}</li>}
                      <li className={cn("rounded-lg px-2.5 py-1.5", (viewing === i || (viewing === null && i === next && st !== "done")) && "bg-indigo-50")}>
                        <div className="flex items-start gap-2">
                          <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", st === "done" ? "text-emerald-600" : st === "running" ? "animate-spin text-brand" :
                            st === "waiting" ? "text-amber-500" : st === "error" ? "text-red-600" : "text-slate-300")} />
                          <div className="min-w-0">
                            <div className={cn("text-[13px] font-semibold", st === "idle" ? "text-slate-500" : "text-slate-900")}>
                              <span className="mr-1 font-mono text-[11px] text-slate-400">{String(i + 1).padStart(2, "0")}</span>{s.title}
                            </div>
                            {(i === next || notes[i] || viewing === i) && <div className="text-xs text-slate-500">{notes[i] || s.detail}</div>}
                          </div>
                        </div>
                      </li>
                    </React.Fragment>
                  );
                })}
              </ol>
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 p-3">
                {next === 0 && done === 0 ? (
                  <Button size="sm" onClick={() => reset(true)} disabled={busy}><Play /> Start (resets demo data)</Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={back} disabled={busy || (viewing ?? next - 1) <= 0} aria-label="Back"><SkipBack /> Back</Button>
                    <Button size="sm" onClick={() => {
                        if (viewing === null) return step();
                        const nv = viewing + 1;
                        setViewing(nv >= next - 1 ? null : nv);
                        router.push(ctx.current.routes[nv] || STEPS[nv].route);
                      }}
                      disabled={busy || (viewing === null && (next >= STEPS.length || statuses[APPROVAL] === "waiting"))}><SkipForward /> Next</Button>
                    <Button size="sm" variant="outline" onClick={() => setAuto((a) => !a)} disabled={next >= STEPS.length}>
                      {auto ? <><Pause /> Pause</> : <><Play /> Play</>}
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost" onClick={() => reset(false)} disabled={busy}><RotateCcw /> Reset demo</Button>
                {statuses[APPROVAL] === "waiting" && <p className="w-full text-xs text-amber-700">Paused for human approval — review the dialog and click Approve (or Reject).</p>}
                {viewing !== null && <p className="w-full text-xs text-slate-500">Revisiting step {viewing + 1}. Recorded events stay in the append-only ledger.</p>}
              </div>
            </>
          )}
        </div>
      )}
    </DemoCtx.Provider>
  );
}
