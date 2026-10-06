"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

export function Tabs<T extends string>({ value, onChange, items, className }:
  { value: T; onChange: (v: T) => void; items: { value: T; label: React.ReactNode; count?: number }[]; className?: string }) {
  return (
    <div role="tablist" className={cn("inline-flex flex-wrap gap-1.5", className)}>
      {items.map((it) => (
        <button key={it.value} role="tab" aria-selected={value === it.value} onClick={() => onChange(it.value)}
          className={cn("rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors",
            value === it.value ? "border-brand bg-brand text-white shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}>
          {it.label}
          {typeof it.count === "number" && <span className={cn("ml-1.5 rounded-full px-1.5 text-[11px]", value === it.value ? "bg-white/20" : "bg-slate-100")}>{it.count}</span>}
        </button>
      ))}
    </div>
  );
}
