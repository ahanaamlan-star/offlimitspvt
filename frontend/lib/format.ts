const inrFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inrFmt2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const inr = (v: number | null | undefined, decimals = false) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : `${v < 0 ? "-" : ""}₹${(decimals ? inrFmt2 : inrFmt).format(Math.abs(v))}`;

export const num = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(v);

export const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? "—" : `${v.toFixed(digits)}%`);

export const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

export const dateShort = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—";

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

export const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

export const bytes = (n: number | null | undefined) =>
  !n ? "—" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
