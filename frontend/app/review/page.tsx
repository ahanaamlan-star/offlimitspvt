"use client";
import * as React from "react";
import Link from "next/link";
import { ShieldQuestion } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, ErrorState, Loading, PageHeader } from "@/components/shared/bits";
import { ProposalCard } from "@/components/shared/proposal-card";
import { useApi } from "@/hooks/useApi";
import { titleCase, dateTime } from "@/lib/format";
import type { Artifact, Health, Proposal } from "@/types";

export default function ReviewPage() {
  const { data, error, loading, reload, setData } = useApi<Proposal[]>("/api/proposals?status=NEEDS_REVIEW");
  const { data: health } = useApi<Health>("/api/health");
  const [artifacts, setArtifacts] = React.useState<Record<string, Artifact>>({});

  React.useEffect(() => {
    const ids = Array.from(new Set((data ?? []).map((p) => p.artifact_id))).filter((id) => !artifacts[id]);
    ids.forEach((id) => fetch(`/api/inputs/${id}`).then((r) => r.json()).then((d) => setArtifacts((a) => ({ ...a, [id]: d.artifact }))));
  }, [data, artifacts]);

  return (
    <div>
      <PageHeader kicker="See · Trust" title="Needs Review" subtitle="Ambiguous or low-confidence interpretations. OFFLIMITS never silently mutates business state from an uncertain extraction." />
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <Loading />}
      {data && data.length === 0 && (
        <Empty title="Nothing waiting for review" icon={<ShieldQuestion className="h-8 w-8" />}>
          Try <Link className="text-brand underline" href="/see?tab=message">“Ramesh paid ₹3,000”</Link> — two customers are named Ramesh, so OFFLIMITS will ask which one.
        </Empty>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((p) => {
          const a = artifacts[p.artifact_id];
          return (
            <Card key={p.id}>
              <CardHeader><CardTitle>{a ? `${titleCase(a.kind)} · ${a.id}` : p.artifact_id}</CardTitle><span className="text-xs text-slate-400">{dateTime(p.created_at)}</span></CardHeader>
              <CardContent className="space-y-3">
                {a?.text_content && <p className="rounded-lg bg-slate-50 p-2.5 text-sm italic text-slate-700">“{a.text_content.slice(0, 300)}”</p>}
                {a && <ProposalCard p={p} artifact={a} threshold={health?.confidence_threshold ?? 0.75}
                  onUpdate={(np) => setData((d) => (d ?? []).map((x) => (x.id === np.id ? np : x)))} />}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
