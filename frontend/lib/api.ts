/**
 * API client with two interchangeable backends:
 *  - "remote": the FastAPI server (same-origin /api, proxied by Next in dev / Docker).
 *  - "local":  the in-browser engine (lib/engine) — used for static hosting such as Netlify.
 * NEXT_PUBLIC_API_MODE = local | remote | auto (default auto: use FastAPI if /api/health answers, else local).
 */
export class ApiError extends Error {
  status: number;
  details: string[];
  constructor(status: number, details: string[]) {
    super(details.join("; "));
    this.status = status;
    this.details = details;
  }
}

type Mode = "local" | "remote";
const CONFIGURED = (process.env.NEXT_PUBLIC_API_MODE || "auto").toLowerCase();
let modeP: Promise<Mode> | null = null;

async function detectMode(): Promise<Mode> {
  if (CONFIGURED === "local" || CONFIGURED === "remote") return CONFIGURED;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
      const j = await r.json();
      if (j && j.status && j.version) return "remote";
    }
  } catch {
    /* fall through */
  }
  return "local";
}

export function apiMode(): Promise<Mode> {
  if (!modeP) modeP = detectMode();
  return modeP;
}

function details(status: number, body: any): string[] {
  if (body && Array.isArray(body.detail)) return body.detail.map((d: any) => (typeof d === "string" ? d : d.msg ?? JSON.stringify(d)));
  if (body && body.detail) return [String(body.detail)];
  return [`Request failed (${status})`];
}

async function remote<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new ApiError(0, ["Network error — cannot reach the OFFLIMITS backend."]);
  }
  if (res.ok) return (await res.json()) as T;
  let body: any = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!body && res.status >= 500) throw new ApiError(res.status, ["Backend unavailable — is the FastAPI server running on port 8000?"]);
  throw new ApiError(res.status, details(res.status, body));
}

async function local<T>(method: string, path: string, body?: any): Promise<T> {
  const { handleLocal } = await import("./engine/router");
  const r = await handleLocal(method, path, body);
  if (r.status >= 400) throw new ApiError(r.status, details(r.status, r.body));
  return r.body as T;
}

async function request<T>(method: string, path: string, body?: any, form?: FormData): Promise<T> {
  const mode = await apiMode();
  if (mode === "local") return local<T>(method, path, form ?? body);
  if (form) return remote<T>(path, { method, body: form });
  if (method === "GET") return remote<T>(path);
  return remote<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  form: <T>(path: string, form: FormData) => request<T>("POST", path, undefined, form),
};

/** Tell every mounted view that business state changed. */
export function notifyChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("offlimits:changed"));
}
