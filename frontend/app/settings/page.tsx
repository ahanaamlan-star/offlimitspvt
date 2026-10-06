"use client";
import * as React from "react";
import { RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { ErrorState, KV, Loading, Notice, PageHeader } from "@/components/shared/bits";
import { useDemo } from "@/components/demo/demo-provider";
import { useApi } from "@/hooks/useApi";
import { api, ApiError, notifyChanged } from "@/lib/api";
import type { BusinessStateResp, Health } from "@/types";

interface SettingsResp { merchant: { id: string; name: string; owner: string; city: string; currency: string; is_demo: boolean }; settings: Record<string, any>; health: Health }

const FIELDS: { key: string; label: string; hint: string; group: "inventory" | "risk" }[] = [
  { key: "horizon_days", label: "Planning horizon (days)", hint: "Window for stockout prediction (“required by tomorrow” = 1)", group: "inventory" },
  { key: "cover_days", label: "Purchase cover (days)", hint: "Days of demand a purchase should cover before stock counts as excess", group: "inventory" },
  { key: "min_margin_pct", label: "Minimum margin %", hint: "Flag SKUs whose margin falls below this", group: "risk" },
  { key: "margin_drop_pp", label: "Margin drop alert (pp)", hint: "Flag a drop of this many percentage points after a cost change", group: "risk" },
  { key: "price_change_pct", label: "Supplier price change alert %", hint: "Flag supplier price changes at or above this", group: "risk" },
  { key: "mismatch_pct", label: "Quote–invoice mismatch %", hint: "Flag invoices priced above the quote by this much", group: "risk" },
  { key: "min_cash_buffer", label: "Minimum cash buffer ₹", hint: "Warn when cash drops below this", group: "risk" },
  { key: "receivable_alert", label: "Receivable alert ₹", hint: "Surface customers owing at least this much", group: "risk" },
];

export default function SettingsPage() {
  const { data, error, reload } = useApi<SettingsResp>("/api/settings");
  const { data: bs } = useApi<BusinessStateResp>("/api/business-state");
  const demo = useDemo();
  const [form, setForm] = React.useState<Record<string, any>>({});
  const [name, setName] = React.useState("");
  const [owner, setOwner] = React.useState("");
  React.useEffect(() => { if (data) { setForm(data.settings); setName(data.merchant.name); setOwner(data.merchant.owner); } }, [data]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const h = data.health;

  async function save() {
    try {
      const numeric = Object.fromEntries(FIELDS.map((f) => [f.key, Number(form[f.key])]));
      await api.put("/api/settings", { name, owner, settings: numeric });
      toast.success("Settings saved — risks re-evaluated on next change");
      notifyChanged();
    } catch (e) { toast.error((e as ApiError).details.join("; ")); }
  }

  return (
    <div>
      <PageHeader kicker="Settings" title="Settings" subtitle="Business profile, thresholds, AI configuration and demo controls." actions={<Button onClick={save}><Save /> Save settings</Button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Business profile</CardTitle>{data.merchant.is_demo && <Badge tone="amber">Demo business</Badge>}</CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="bn">Business name</Label><Input id="bn" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><Label htmlFor="ow">Owner / approver</Label><Input id="ow" value={owner} onChange={(e) => setOwner(e.target.value)} /></div>
            <KV label="Currency" value={`${data.merchant.currency} (₹)`} /><KV label="City" value={data.merchant.city} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>AI settings</CardTitle><Badge tone={h.mode === "LIVE" ? "indigo" : "amber"}>{h.mode} MODE</Badge></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <KV label="Provider" value={h.ai.provider} /><KV label="Model" value={h.ai.model} mono />
              <KV label="GEMINI_API_KEY" value={h.ai.configured ? "Configured (server-side)" : "Not set"} /><KV label="Confidence threshold" value={`${Math.round(h.confidence_threshold * 100)}% → below = NEEDS REVIEW`} />
              <KV label="Voice" value={h.voice.provider} /><KV label="Sarvam AI" value={h.voice.sarvam_configured ? "Configured" : "Future integration"} />
            </div>
            <Notice tone="slate">API keys are read from <code>backend/.env</code> and never sent to the browser. Without a key OFFLIMITS runs in Demo Mode: rule-based extraction plus bundled fixtures; every workflow still works.</Notice>
          </CardContent>
        </Card>
        {(["inventory", "risk"] as const).map((g) => (
          <Card key={g}>
            <CardHeader><CardTitle>{g === "inventory" ? "Inventory thresholds" : "Risk thresholds"}</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {FIELDS.filter((f) => f.group === g).map((f) => (
                <div key={f.key}><Label htmlFor={f.key}>{f.label}</Label>
                  <Input id={f.key} type="number" min={0} step="any" value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                  <p className="mt-1 text-[11px] text-slate-500">{f.hint}</p></div>
              ))}
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader><CardTitle>Supplier settings</CardTitle></CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {bs?.suppliers.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-1.5">
                <span><b>{s.short_name}</b> <span className="text-slate-500">{s.name}</span></span>
                <span className="text-xs text-slate-500">reliability {s.reliability}% · {s.offers} quotes</span>
              </div>
            ))}
            <p className="pt-1 text-[11px] text-slate-500">Supplier prices are updated by confirming quotations and invoices on SEE (event-sourced, never edited in place).</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Demo mode &amp; API status</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <KV label="System" value={h.status.toUpperCase()} /><KV label="Database" value={`${h.database.engine} · ${h.database.ok ? "OK" : "DOWN"}`} />
              <KV label="API version" value={h.version} mono /><KV label="Max upload" value={`${h.max_upload_mb} MB`} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="dark" onClick={demo.open}>Run 3-minute demo</Button>
              <Button variant="outline" onClick={async () => {
                if (!window.confirm("Reset the demo business? All events created in this session are removed.")) return;
                await api.post("/api/demo/reset"); notifyChanged(); toast.success("Demo business reset"); reload();
              }}><RotateCcw /> Reset demo data</Button>
            </div>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2" id="help">
          <CardHeader><CardTitle>Help · the 3-minute demo</CardTitle></CardHeader>
          <CardContent className="grid gap-4 text-sm text-slate-700 md:grid-cols-3">
            <div><div className="mb-1 font-semibold text-slate-900">1 · SEE</div>Upload the demo invoice (Metro Beverages INV-2841) on Capture, confirm the events. Paste “Kal 25 Coke aur 10 Sprite bhej dena” as a message from Ramesh Stores. Try “Ramesh paid ₹3,000” to see ambiguity handling.</div>
            <div><div className="mb-1 font-semibold text-slate-900">2 · THINK</div>Intelligence shows the Coca-Cola shortage (11 units). Open the What-If Simulator and test the “15% off for 100 units” deal.</div>
            <div><div className="mb-1 font-semibold text-slate-900">3 · ACT</div>On Procurement, compare suppliers, approve Supplier B, and open the purchase order. The Event Timeline shows every step; Business State shows the updated numbers.</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
