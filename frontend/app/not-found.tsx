import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center py-24 text-center">
      <div className="font-mono text-sm text-slate-400">404</div>
      <h1 className="mt-2 text-xl font-bold">Page not found</h1>
      <Link href="/" className="mt-4 text-sm font-medium text-brand hover:underline">Back to the command center</Link>
    </div>
  );
}
