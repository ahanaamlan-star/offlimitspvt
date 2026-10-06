/**
 * SEE layer for the in-browser engine (port of analyze_input + files.py).
 * - Uploads: size limit, magic-byte MIME check, SHA-256, stored in IndexedDB.
 * - PDF: real text + page count with pdf.js (loaded from /vendor/pdfjs at runtime).
 * - Images / audio: Gemini (through the server-side Netlify Function) when configured,
 *   otherwise bundled demo fixtures (labelled) or the transcript the browser produced.
 */
import fixtures from "./fixtures.json";
import { appendEvent, getState, Masters, nextId } from "./ledger";
import { EntityMatcher, fromGemini, geminiPrompt, ruleParse, Understanding } from "./parser";
import type { Artifact, DB, Proposal } from "./store";
import { putFile } from "./store";
import { EngineError, nowIso, pyRound, sanitizeText, sha256Hex } from "./util";
import { buildProposals, catalog, KIND_LABEL, threshold } from "./workflow";

export const MAX_UPLOAD_MB = 10;
export const ALLOWED: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf",
  "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
};
const FIXTURES = fixtures as Record<string, { filename: string; kind: string; label: string; ocr_text?: string; transcript?: string }>;
export const DEMO_TRANSCRIPTION = "DEMO TRANSCRIPTION";

export function sniffMime(b: Uint8Array): string | null {
  const at = (off: number, s: string) => s.split("").every((c, i) => b[off + i] === c.charCodeAt(0));
  const bytes = (off: number, arr: number[]) => arr.every((v, i) => b[off + i] === v);
  if (bytes(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(0, "RIFF") && at(8, "WAVE")) return "audio/wav";
  if (at(0, "%PDF")) return "application/pdf";
  if (bytes(0, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
  if (at(0, "OggS")) return "audio/ogg";
  if (at(0, "ID3") || (b[0] === 0xff && [0xfb, 0xf3, 0xf2].includes(b[1]))) return "audio/mpeg";
  if (at(4, "ftyp")) return "audio/mp4";
  return null;
}

export function validateUpload(b: Uint8Array): string {
  if (!b.length) throw new EngineError("Upload failed: the file is empty.", 415);
  if (b.length > MAX_UPLOAD_MB * 1024 * 1024) throw new EngineError(`File is larger than ${MAX_UPLOAD_MB} MB.`, 415);
  const mime = sniffMime(b);
  if (!mime || !ALLOWED[mime]) throw new EngineError("Unsupported file type. Use PNG, JPG, WEBP, PDF or an audio file (webm/ogg/wav/mp3/m4a).", 415);
  return mime;
}

export const safeFilename = (name?: string | null) => (name || "upload").split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._\- ]/g, "_").slice(0, 120) || "upload";

// ---------------------------------------------------------------- PDF (pdf.js)

let pdfjsP: Promise<any> | null = null;
function pdfjs() {
  const injected = (globalThis as any).__OFFLIMITS_PDFJS__; // used by Node tests (pdfjs-dist legacy build)
  if (injected) return Promise.resolve(injected);
  if (!pdfjsP) {
    pdfjsP = import(/* webpackIgnore: true */ "/vendor/pdfjs/pdf.min.mjs" as string).then((mod: any) => {
      mod.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
      return mod;
    });
    pdfjsP.catch(() => { pdfjsP = null; });
  }
  return pdfjsP;
}

/** Returns text (first 10 pages, line-ordered), page count and an optional notice. Never throws. */
export async function pdfText(b: Uint8Array): Promise<{ text: string | null; pages: number | null; notice: string | null }> {
  try {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: b.slice(), isEvalSupported: false }).promise;
    const pages = doc.numPages as number;
    const out: string[] = [];
    for (let p = 1; p <= Math.min(pages, 10); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      // Group text runs into lines by their y position, then sort left → right.
      const rows = new Map<number, { x: number; s: string }[]>();
      for (const it of tc.items as any[]) {
        if (!("str" in it) || !it.str.trim()) continue;
        const y = Math.round(it.transform[5]);
        const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key)!.push({ x: it.transform[4], s: it.str });
      }
      [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, r]) => out.push(r.sort((a, b) => a.x - b.x).map((x) => x.s.trim()).join(" ")));
    }
    await doc.destroy?.();
    const text = out.join("\n").trim();
    if (!text) return { text: null, pages, notice: "This PDF has no extractable text (it may be a scan). Configure GEMINI_API_KEY to read scans, or enter details manually." };
    return { text, pages, notice: null };
  } catch {
    return { text: null, pages: null, notice: "PDF text extraction failed. You can still enter the details manually." };
  }
}

// ---------------------------------------------------------------- Gemini via Netlify Function

let aiStatus: { configured: boolean; model: string | null; checked: number } | null = null;

/** Asks the serverless function whether a key is configured. The key itself never reaches the browser. */
export async function geminiStatus(force = false): Promise<{ configured: boolean; model: string | null }> {
  if (aiStatus && !force && Date.now() - aiStatus.checked < 60_000) return aiStatus;
  // Static hosts without the serverless function (Netlify Drop, `npx serve`) skip the probe entirely.
  if (process.env.NEXT_PUBLIC_AI_PROXY !== "1") {
    aiStatus = { configured: false, model: null, checked: Date.now() + 1e12 };
    return aiStatus;
  }
  try {
    const r = await fetch("/api/gemini", { method: "GET", headers: { accept: "application/json" } });
    const j = r.ok && (r.headers.get("content-type") || "").includes("json") ? await r.json() : null;
    aiStatus = { configured: !!j?.configured, model: j?.model || null, checked: Date.now() };
  } catch {
    aiStatus = { configured: false, model: null, checked: Date.now() };
  }
  return aiStatus;
}

async function callGemini(parts: any[]): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const r = await fetch("/api/gemini", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts, json: true }), signal: ctrl.signal });
    if (!r.ok) throw new Error(`Gemini function returned ${r.status}`);
    const j = await r.json();
    if (typeof j.text !== "string") throw new Error("Empty AI response");
    return j.text;
  } finally {
    clearTimeout(t);
  }
}

function b64(b: Uint8Array) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

async function understand(m: Masters, live: boolean, kind: string, data: Uint8Array | null, mime: string | null, text: string | null, sender: string | null): Promise<Understanding> {
  const matcher = new EntityMatcher(catalog(m));
  if (live && (data || text)) {
    try {
      const parts: any[] = [{ text: geminiPrompt(catalog(m), kind, sender) }];
      if (text) parts.push({ text: "INPUT TEXT:\n" + text });
      if (data && mime) parts.push({ inline_data: { mime_type: mime, data: b64(data) } });
      const raw = JSON.parse(await callGemini(parts));
      return fromGemini(raw, matcher, text, sender);
    } catch {
      if (text) {
        const u = ruleParse(text, kind, matcher, sender);
        u.mode = "fallback";
        u.notice = "AI SERVICE UNAVAILABLE — OFFLIMITS used Demo Mode rules for this input.";
        return u;
      }
      return { mode: "fallback", text: null, document_type: null, document_no: null, supplier_text: null, customer_text: null, events: [],
        notice: "AI SERVICE UNAVAILABLE — OFFLIMITS has switched to Demo Mode. This file could not be read; enter the details manually." };
    }
  }
  if (text) return ruleParse(text, kind, matcher, sender);
  return { mode: "demo", text: null, document_type: null, document_no: null, supplier_text: null, customer_text: null, events: [],
    notice: "AI is not configured (Demo Mode), so this file cannot be read automatically. Use one of the demo assets, configure GEMINI_API_KEY on the server, or enter the details manually." };
}

// ---------------------------------------------------------------- analyze

export interface AnalyzeIn { kind?: string; text?: string | null; sender?: string | null; file?: Blob | null; filename?: string | null }

/** Two-phase so the DB is only mutated synchronously at the end (no half-written state if AI is slow). */
export async function analyzeInput(getDb: () => DB, input: AnalyzeIn) {
  const kind = input.kind && KIND_LABEL[input.kind] ? input.kind : "text";
  let text = sanitizeText(input.text);
  const sender = sanitizeText(input.sender, 120);
  const data = input.file ? new Uint8Array(await input.file.arrayBuffer()) : null;
  if (!data && !text) throw new EngineError("Provide a file or some text to analyze.");
  const ai = await geminiStatus();
  const live = ai.configured;

  let mime: string | null = null, sha: string, fixture: (typeof FIXTURES)[string] | null = null;
  let pageCount: number | null = null, transcription: string | null = null, note: string | null = null, notice: string | null = null;
  let isDemo = true;
  if (data) {
    mime = validateUpload(data);
    sha = await sha256Hex(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    fixture = FIXTURES[sha] || null;
    isDemo = !!fixture;
  } else sha = await sha256Hex(`${kind}|${sender || ""}|${text}`);

  let db = getDb();
  let m = new Masters(db);
  let u: Understanding;
  let artText = text;
  if (data && mime === "application/pdf") {
    const pdf = await pdfText(data);
    pageCount = pdf.pages;
    notice = pdf.notice;
    artText = pdf.text || text;
    u = await understand(m, live, ["invoice", "receipt", "quotation"].includes(kind) ? kind : "invoice", live ? data : null, mime, artText, null);
  } else if (data && mime!.startsWith("image/")) {
    const ocr = fixture?.ocr_text || text;
    if (fixture && !live) note = "Demo asset: text read from the bundled OCR fixture (DEMO DATA).";
    u = await understand(m, live, kind, data, mime, live ? null : ocr, null);
    if (live && !u.events.length && ocr) u = await understand(m, live, kind, data, mime, ocr, null);
    artText = u.text || ocr;
  } else if (data && mime!.startsWith("audio/")) {
    let transcript = text;
    if (!transcript && live) {
      u = await understand(m, live, "voice", data, mime, null, sender);
      if (u.mode === "gemini" && u.text) transcription = "GEMINI";
      else if (fixture?.transcript) {
        transcript = fixture.transcript;
        transcription = DEMO_TRANSCRIPTION;
        u = await understand(m, false, "voice", null, null, transcript, sender);
        u.notice = "AI SERVICE UNAVAILABLE — used the bundled demo transcript (DEMO TRANSCRIPTION).";
      }
    } else {
      if (!transcript && fixture?.transcript) { transcript = fixture.transcript; transcription = DEMO_TRANSCRIPTION; }
      else if (transcript) transcription = "BROWSER";
      if (transcript) {
        u = await understand(m, live, "voice", null, null, transcript, sender);
        u.text = transcript;
      } else {
        u = { mode: "demo", text: null, document_type: null, document_no: null, supplier_text: null, customer_text: null, events: [],
          notice: "Transcription is unavailable in Demo Mode for this recording. Type the transcript, use live speech-to-text while recording (Chrome/Edge), or configure GEMINI_API_KEY." };
      }
    }
    u = u!;
    artText = u.text || transcript;
    if (transcription === DEMO_TRANSCRIPTION) note = `${DEMO_TRANSCRIPTION}: transcript taken from the bundled demo fixture, not live speech recognition.`;
  } else {
    u = await understand(m, live, kind, null, null, text || "", sender);
  }
  notice = u.notice || notice;

  // ---- commit (synchronous)
  db = getDb();
  m = new Masters(db);
  const artId = nextId(db, "artifact", "ART-", 2000);
  if (data && input.file) await putFile(artId, new Blob([data as BlobPart], { type: mime! }));
  db = getDb();
  const art: Artifact = {
    id: artId, kind, filename: data ? safeFilename(input.filename) : null, mime, size: data ? data.length : null, sha256: sha, has_file: !!data,
    text_content: artText, sender, analysis_mode: u.mode, note, is_demo: isDemo, created_at: nowIso(), page_count: pageCount, transcription,
  };
  db.artifacts.push(art);
  const srcChange = art.filename || u.document_no
    ? [u.supplier_text || sender, u.document_no || art.filename].filter(Boolean).join(" • ")
    : text ? `“${text.slice(0, 70)}”` : "";
  const sourceEv = appendEvent(db, "INPUT_RECEIVED", { artifact_id: art.id, kind, filename: art.filename, page_count: pageCount, transcription },
    { category: "SOURCE", source_type: kind, source_ref: u.document_no || art.filename || sender || kind, actor: sender || "merchant", title: KIND_LABEL[kind],
      change: srcChange, artifact_id: art.id, masters: m });
  const state = getState(db);
  const proposals: Proposal[] = [];
  for (const pe of u.events) {
    for (const prop of buildProposals(pe, u, m, state, threshold(db))) {
      const p: Proposal = { id: nextId(db, "proposal", "PRP-", 3000), artifact_id: art.id, ...prop, event_id: null, created_at: nowIso() };
      db.proposals.push(p);
      proposals.push(p);
    }
  }
  return {
    artifact: art, proposals, source_event: sourceEv,
    understanding: { mode: u.mode, text: art.text_content, document_type: u.document_type, document_no: u.document_no, supplier: u.supplier_text, notice,
      page_count: pageCount, transcription, ai_confidence: proposals.length ? pyRound(Math.min(...proposals.map((p) => p.confidence)), 2) : null },
  };
}

export const demoFixtures = () => FIXTURES;
