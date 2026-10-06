import { ArrowRight, Brain, CheckCircle2, FileInput, RefreshCcw, ScanSearch, ShieldCheck, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { key: "INPUT", label: "Input", icon: FileInput, hint: "Invoice · message · voice" },
  { key: "UNDERSTAND", label: "Understand", icon: ScanSearch, hint: "Structured event" },
  { key: "DECIDE", label: "Decide", icon: Brain, hint: "Risk + options" },
  { key: "APPROVE", label: "Approve", icon: ShieldCheck, hint: "Human in control" },
  { key: "ACT", label: "Act", icon: Zap, hint: "Execute + record" },
  { key: "STATE", label: "Updated state", icon: RefreshCcw, hint: "Ledger → state" },
];

/** The closed loop as a compact visual: INPUT → UNDERSTAND → DECIDE → APPROVE → ACT → UPDATED STATE ↺ */
export function LoopStrip({ active = [], compact }: { active?: string[]; compact?: boolean }) {
  return (
    <div className="flex flex-wrap items-stretch gap-1.5">
      {STEPS.map((s, i) => {
        const on = active.includes(s.key);
        const Icon = on ? CheckCircle2 : s.icon;
        return (
          <div key={s.key} className="flex items-center gap-1.5">
            <div className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-2",
              on ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white")}>
              <Icon className={cn("h-4 w-4", on ? "text-emerald-600" : "text-slate-400")} />
              <div>
                <div className={cn("text-[11px] font-bold uppercase tracking-wider", on ? "text-emerald-800" : "text-slate-700")}>{s.label}</div>
                {!compact && <div className="text-[11px] text-slate-500">{s.hint}</div>}
              </div>
            </div>
            {i < STEPS.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-slate-300" />}
          </div>
        );
      })}
      <div className="flex items-center pl-1 text-lg text-slate-300" aria-hidden>↺</div>
    </div>
  );
}
