/** Small helpers shared by the in-browser engine (mirrors Python behaviour where it matters). */

export class EngineError extends Error {
  status: number;
  errors: string[];
  constructor(errors: string[] | string, status = 400) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(list.join("; "));
    this.errors = list;
    this.status = status;
  }
}

/** Python-style round (half-to-even) to `nd` decimals. */
export function pyRound(x: number, nd = 0): number {
  const m = Math.pow(10, nd);
  const v = x * m;
  const r = Math.round(v);
  const diff = Math.abs(v % 1);
  if (Math.abs(diff - 0.5) < 1e-9) {
    const fl = Math.floor(v);
    return (fl % 2 === 0 ? fl : fl + 1) / m;
  }
  return r / m;
}

/** Python `f"{x:g}"`-ish compact number. */
export function g(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "None";
  return String(Number(x.toPrecision(6)));
}

export function commas(x: number, digits = 0): string {
  return Number(pyRound(x, digits)).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signed(x: number, digits = 1): string {
  const s = Math.abs(x).toFixed(digits);
  return (x < 0 ? "-" : "+") + s;
}

export const nowIso = () => new Date().toISOString();
export const addMs = (iso: string | Date, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();
export const H = 3600_000;
export const D = 24 * H;
export const dayKey = (iso: string) => iso.slice(0, 10);
export const todayIso = () => new Date().toISOString().slice(0, 10);

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function sanitizeText(text: string | null | undefined, limit = 5000): string | null {
  if (text === null || text === undefined) return null;
  const t = String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replace(/<[^>]{0,200}>/g, "").trim().slice(0, limit);
  return t || null;
}

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word/phrase search (like Python `(?<![\w])phrase(?![\w])`). */
export function containsWord(text: string, phrase: string): number {
  const m = new RegExp(`(?<![\\w])${escapeRe(phrase)}(?![\\w])`).exec(text);
  return m ? m.index : -1;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
