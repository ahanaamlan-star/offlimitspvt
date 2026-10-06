"use client";
import * as React from "react";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;

export function DialogContent({ className, children, title, description, wide, side }:
  { className?: string; children: React.ReactNode; title: string; description?: string; wide?: boolean; side?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px]" />
      <D.Content
        className={cn(
          "fixed z-50 bg-white shadow-xl focus:outline-none",
          side
            ? "right-0 top-0 h-full w-full max-w-xl overflow-y-auto border-l border-slate-200"
            : "left-1/2 top-1/2 max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl",
          !side && (wide ? "max-w-3xl" : "max-w-lg"),
          className,
        )}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-100 bg-white px-6 py-4">
          <div>
            <D.Title className="text-lg font-semibold text-slate-900">{title}</D.Title>
            {description ? <D.Description className="mt-0.5 text-sm text-slate-500">{description}</D.Description> :
              <D.Description className="sr-only">{title}</D.Description>}
          </div>
          <D.Close className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close">
            <X className="h-4 w-4" />
          </D.Close>
        </div>
        <div className="px-6 py-5">{children}</div>
      </D.Content>
    </D.Portal>
  );
}
