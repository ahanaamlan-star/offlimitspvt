"use client";
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800">
      <div className="font-semibold">Something went wrong on this page.</div>
      <p className="mt-1">{error.message}</p>
      <p className="mt-1 text-red-700">The event ledger was not changed by this error.</p>
      <button onClick={reset} className="mt-3 rounded border border-red-300 px-3 py-1 font-medium hover:bg-red-100">Try again</button>
    </div>
  );
}
