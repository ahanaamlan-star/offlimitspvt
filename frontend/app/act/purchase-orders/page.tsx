"use client";
import Link from "next/link";
import { FileText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { Empty, ErrorState, Loading, PageHeader, StatusBadge } from "@/components/shared/bits";
import { useApi } from "@/hooks/useApi";
import { dateTime, inr } from "@/lib/format";
import type { PurchaseOrder } from "@/types";

export default function PurchaseOrdersPage() {
  const { data, error, loading, reload } = useApi<PurchaseOrder[]>("/api/purchase-orders");
  return (
    <div>
      <PageHeader kicker="Act" title="Purchase Orders" subtitle="Merchant-approved procurement actions. Every PO links back to the approval, the decision and the input that caused it." />
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <Loading />}
      {data && data.length === 0 && <Empty title="No purchase orders yet" icon={<FileText className="h-8 w-8" />}>Approve a recommendation on Procurement to create one.</Empty>}
      {data && data.length > 0 && (
        <Card><CardContent className="p-0">
          <Table>
            <THead><tr><TH>PO number</TH><TH>Date</TH><TH>Supplier</TH><TH>Product</TH><TH className="text-right">Qty</TH><TH className="text-right">Unit price</TH><TH className="text-right">Total</TH><TH>Terms</TH><TH>Approved by</TH><TH>Status</TH></tr></THead>
            <TBody>
              {data.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <TD><Link href={`/act/purchase-orders/view?id=${p.id}`} className="font-mono text-xs font-semibold text-brand hover:underline">{p.id}</Link></TD>
                  <TD>{dateTime(p.created_at)}</TD><TD>{p.supplier}</TD><TD>{p.item}</TD>
                  <TD className="num text-right">{p.qty}</TD><TD className="num text-right">{inr(p.unit_price, true)}</TD><TD className="num text-right font-semibold">{inr(p.total, true)}</TD>
                  <TD>{p.credit_days ? `${p.credit_days}-day credit` : "On delivery"}</TD><TD>{p.approved_by ?? "—"}</TD><TD><StatusBadge s={p.status} /></TD>
                </tr>
              ))}
            </TBody>
          </Table>
        </CardContent></Card>
      )}
    </div>
  );
}
