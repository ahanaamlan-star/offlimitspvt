"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, FileText, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CategoryBadge, Confidence, ErrorState, KV, Loading, StatusBadge } from "@/components/shared/bits";
import { api, ApiError, notifyChanged } from "@/lib/api";
import { dateTime, inr, titleCase } from "@/lib/format";
import type { EventDetail, LedgerEvent } from "@/types";

const Ctx = React.createContext<{ open: (id: string) => void }>({ open: () => {} });
export const useEventDrawer = () => React.useContext(Ctx);

const REVERSIBLE = new Set(["PURCHASE_RECEIVED", "SUPPLIER_QUOTE", "SUPPLIER_PRICE_UPDATE", "CUSTOMER_ORDER", "ORDER_FULFILLED",
  "SALE", "PAYMENT_RECEIVED", "PAYMENT_MADE", "DAMAGED_STOCK"]);

export function EventDrawerProvider({ children }: { children: React.ReactNode }) {
  const [id, setId] = React.useState<string | null>(null);
  const [data, setData] = React.useState<EventDetail | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    api.get<EventDetail>(`/api/events/${id}`).then(setData).catch(setError);
  }, [id]);

  async function reverse() {
    if (!data) return;
    const reason = window.prompt("Why reverse this event? (kept in the audit trail)", "Correction");
    if (reason === null) return;
    try {
      await api.post(`/api/events/${data.id}/reverse`, { reason });
      toast.success(`${data.id} reversed — history preserved`);
      notifyChanged();
      setId(null);
    } catch (e) {
      toast.error((e as ApiError).details.join("; "));
    }
  }

  return (
    <Ctx.Provider value={{ open: setId }}>
      {children}
      <Dialog open={!!id} onOpenChange={(o) => !o && setId(null)}>
        {id && (
          <DialogContent side title={data ? data.title : id} description={data ? `${data.id} · ${dateTime(data.ts)}` : undefined}>
            {error && <ErrorState error={error} />}
            {!data && !error && <Loading />}
            {data && <EventBody e={data} onJump={setId} onReverse={reverse} />}
          </DialogContent>
        )}
      </Dialog>
    </Ctx.Provider>
  );
}

function fmtVal(k: string, v: any) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number" && (k.includes("cash") || k.includes("receivable") || k.includes("payable") || k.includes("cost") || k.includes("price"))) return inr(v);
  return String(v);
}

function EventBody({ e, onJump, onReverse }: { e: EventDetail; onJump: (id: string) => void; onReverse: () => void }) {
  const keys = Array.from(new Set([...Object.keys(e.prev_state || {}), ...Object.keys(e.new_state || {})]));
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <CategoryBadge c={e.category} />
        <span className="font-mono text-xs text-slate-500">{e.type}</span>
        <StatusBadge s={e.status} />
        {e.is_demo && <span className="text-[11px] text-amber-700">DEMO DATA</span>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <KV label="Source" value={<span>{titleCase(e.source_type)}{e.source_ref ? ` · ${e.source_ref}` : ""}</span>} />
        <KV label="Actor / who" value={e.actor} />
        <KV label="When" value={dateTime(e.ts)} />
        <KV label="Confidence" value={e.confidence !== null ? <Confidence value={e.confidence} /> : "Rule / human"} />
      </div>
      {e.reason && <div className="rounded-lg bg-slate-50 p-3 text-slate-700"><span className="font-semibold">Why: </span>{e.reason}</div>}

      {keys.length > 0 && (
        <div>
          <div className="label-xs mb-2">Business state impact</div>
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <tr><th className="px-3 py-2 text-left">Field</th><th className="px-3 py-2 text-right">Previous</th><th className="px-3 py-2 text-right">New</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {keys.map((k) => {
                  const changed = JSON.stringify(e.prev_state?.[k]) !== JSON.stringify(e.new_state?.[k]);
                  return (
                    <tr key={k}>
                      <td className="px-3 py-1.5 font-mono text-xs text-slate-600">{k}</td>
                      <td className="num px-3 py-1.5 text-right text-slate-500">{fmtVal(k, e.prev_state?.[k])}</td>
                      <td className={`num px-3 py-1.5 text-right ${changed ? "font-semibold text-slate-900" : "text-slate-500"}`}>{fmtVal(k, e.new_state?.[k])}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <div className="label-xs mb-2">Structured interpretation</div>
        <pre className="max-h-56 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11.5px] leading-relaxed text-slate-100">{JSON.stringify(e.payload, null, 2)}</pre>
      </div>

      {e.artifact && (
        <div>
          <div className="label-xs mb-2">Raw input</div>
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-center gap-2 text-slate-700"><FileText className="h-4 w-4" />
              <span className="font-medium">{e.artifact.filename ?? titleCase(e.artifact.kind)}</span>
              <span className="font-mono text-[11px] text-slate-400">{e.artifact.id}</span>
              {e.artifact.is_demo && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">DEMO DATA</span>}
              {e.artifact.page_count != null && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-700">PDF · {e.artifact.page_count} page{e.artifact.page_count === 1 ? "" : "s"}</span>}
              {e.artifact.transcription === "DEMO TRANSCRIPTION" && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">DEMO TRANSCRIPTION</span>}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              {[titleCase(e.artifact.kind), e.artifact.mime, e.artifact.size ? `${Math.round(e.artifact.size / 102.4) / 10} KB` : null, e.artifact.sender ? `from ${e.artifact.sender}` : null,
                `read by ${e.artifact.analysis_mode === "gemini" ? "Gemini" : e.artifact.analysis_mode === "fallback" ? "rules (AI fallback)" : "Demo Mode rules"}`].filter(Boolean).join(" · ")}
            </div>
            {e.artifact.file_url && e.artifact.mime?.startsWith("image/") && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={e.artifact.file_url} alt="Source document" className="mt-2 max-h-48 rounded border border-slate-200 object-contain" />
            )}
            {e.artifact.file_url && e.artifact.mime?.startsWith("audio/") && <audio controls src={e.artifact.file_url} className="mt-2 w-full" />}
            {e.artifact.file_url && <a href={e.artifact.file_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-semibold text-brand hover:underline">Open original file ↗</a>}
            {e.artifact.text_content && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11.5px] text-slate-700">{e.artifact.text_content}</pre>}
            {e.artifact.note && <p className="mt-1 text-[11px] italic text-slate-500">{e.artifact.note}</p>}
          </div>
        </div>
      )}

      {e.approval && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
          <div className="font-semibold">Approved by {e.approval.actor}</div>
          <div className="text-xs">{e.approval.id} · {dateTime(e.approval.ts)} {e.approval.note ? `· “${e.approval.note}”` : ""}</div>
        </div>
      )}
      {e.purchase_order && (
        <Link href={`/act/purchase-orders/view?id=${e.purchase_order.id}`} className="block rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-indigo-900 hover:bg-indigo-100">
          <div className="font-semibold">Purchase Order {e.purchase_order.id} · {e.purchase_order.status}</div>
          <div className="text-xs">{e.purchase_order.supplier} · {e.purchase_order.qty} × {inr(e.purchase_order.unit_price)} = {inr(e.purchase_order.total)}</div>
        </Link>
      )}

      <TraceList title="Why it happened (upstream)" icon={<ArrowUp className="h-3.5 w-3.5" />} items={e.trace.upstream} onJump={onJump} />
      <TraceList title="What it caused (downstream)" icon={<ArrowDown className="h-3.5 w-3.5" />} items={e.trace.downstream} onJump={onJump} />

      {REVERSIBLE.has(e.type) && e.status !== "REVERSED" && e.category !== "OPENING" && (
        <div className="border-t border-slate-100 pt-4">
          <Button variant="outline" size="sm" onClick={onReverse}><Undo2 /> Reverse this event</Button>
          <p className="mt-1.5 text-xs text-slate-500">Reversal adds a correction event. Nothing is deleted from history.</p>
        </div>
      )}
    </div>
  );
}

function TraceList({ title, icon, items, onJump }: { title: string; icon: React.ReactNode; items: LedgerEvent[]; onJump: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="label-xs mb-2 flex items-center gap-1">{icon}{title}</div>
      <div className="space-y-1.5">
        {items.map((t) => (
          <button key={t.id} onClick={() => onJump(t.id)} className="flex w-full items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 text-left hover:bg-slate-50">
            <span className="font-mono text-[11px] text-brand">{t.id}</span>
            <CategoryBadge c={t.category} />
            <span className="truncate text-slate-700">{t.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
