"use client";
import * as React from "react";
import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Clock, Edit3, FileText, Image as ImageIcon, Mic, MicOff, Receipt, Send, Sparkles, Square, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { Confidence, Empty, Loading, Notice, PageHeader, StatusBadge } from "@/components/shared/bits";
import { ProposalCard } from "@/components/shared/proposal-card";
import { useApi } from "@/hooks/useApi";
import { api, ApiError, notifyChanged } from "@/lib/api";
import { bytes, dateTime, inr, time, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AnalyzeResult, Artifact, DemoAssets, Health, InventoryRow, LedgerEvent, Proposal } from "@/types";

type Kind = "invoice" | "message" | "voice" | "image" | "receipt" | "quotation" | "text";
const FILE_KINDS: Kind[] = ["invoice", "image", "receipt", "quotation"];
const ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";
const ACCEPT_EXT = /\.(png|jpe?g|webp|pdf)$/i;

export default function SeePage() {
  return <Suspense fallback={<Loading />}><See /></Suspense>;
}

function See() {
  const params = useSearchParams();
  const router = useRouter();
  const [kind, setKind] = React.useState<Kind>((params.get("tab") as Kind) || "invoice");
  const [result, setResult] = React.useState<AnalyzeResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string[] | null>(null);
  const { data: health } = useApi<Health>("/api/health");
  const { data: assets } = useApi<DemoAssets>("/api/demo/assets");
  const recent = useApi<Artifact[]>("/api/inputs?limit=8");
  const artifactParam = params.get("artifact");

  React.useEffect(() => {
    if (!artifactParam) return;
    api.get<{ artifact: Artifact; proposals: Proposal[] }>(`/api/inputs/${artifactParam}`).then((r) => {
      setResult({ artifact: r.artifact, proposals: r.proposals, source_event: null as unknown as LedgerEvent,
        understanding: { mode: r.artifact.analysis_mode as any, text: r.artifact.text_content, document_type: null,
          document_no: r.proposals[0]?.payload?.invoice_no ?? null, supplier: r.proposals[0]?.names?.supplier ?? null, notice: r.artifact.note, ai_confidence: null } });
      setKind((r.artifact.kind as Kind) || "invoice");
    }).catch(() => {});
  }, [artifactParam]);

  async function analyze(fd: FormData) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.form<AnalyzeResult>("/api/inputs/analyze", fd);
      setResult(r);
      router.replace(`/see?artifact=${r.artifact.id}`, { scroll: false });
      notifyChanged();
    } catch (e) {
      setError((e as ApiError).details);
    } finally {
      setBusy(false);
    }
  }

  const tabs: { value: Kind; label: React.ReactNode }[] = [
    { value: "invoice", label: "Invoice" }, { value: "message", label: "Message" }, { value: "voice", label: "Voice" },
    { value: "image", label: "Image" }, { value: "receipt", label: "Receipt" }, { value: "quotation", label: "Quotation" }, { value: "text", label: "Text" },
  ];

  return (
    <div>
      <PageHeader kicker="See" title="Understand what happened" subtitle="Send business information the way it already exists — OFFLIMITS structures it into business events."
        actions={<Badge tone={health?.mode === "LIVE" ? "indigo" : "amber"}>{health?.mode === "LIVE" ? `Gemini · ${health.ai.model}` : "Demo Mode · rule-based extraction"}</Badge>} />
      <Tabs value={kind} onChange={(k) => { setKind(k); setError(null); }} items={tabs} className="mb-4" />

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          {FILE_KINDS.includes(kind) && <FileInput kind={kind} busy={busy} onAnalyze={analyze} assets={assets} />}
          {(kind === "message" || kind === "text") && <TextInput kind={kind} busy={busy} onAnalyze={analyze} samples={assets?.messages ?? []} />}
          {kind === "voice" && <VoiceInput busy={busy} onAnalyze={analyze} assets={assets} />}
          {error && <Notice tone="red" title="UPLOAD FAILED">{error.join("; ")}</Notice>}
          {result && <RawInput artifact={result.artifact} />}
        </div>
        <div>
          <Extraction result={result} busy={busy} threshold={health?.confidence_threshold ?? 0.75}
            onUpdate={(p) => setResult((r) => r && { ...r, proposals: r.proposals.map((x) => (x.id === p.id ? p : x)) })} />
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>Recent inputs</CardTitle></CardHeader>
        <CardContent className="p-0 pb-2">
          {recent.data?.length ? (
            <ul className="divide-y divide-slate-100">
              {recent.data.map((a) => (
                <li key={a.id}>
                  <Link href={`/see?artifact=${a.id}`} className="flex items-center gap-3 px-5 py-2 text-sm hover:bg-slate-50">
                    <span className="font-mono text-[11px] text-brand">{a.id}</span>
                    <Badge>{a.kind}</Badge>
                    <span className="min-w-0 flex-1 truncate text-slate-700">{a.filename ?? a.text_content ?? "—"}</span>
                    {a.is_demo && <Badge tone="amber">Demo asset</Badge>}
                    <span className="text-xs text-slate-400">{dateTime(a.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <div className="px-5 pb-4 text-sm text-slate-500">No inputs yet in this session.</div>}
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ file upload

function FileInput({ kind, busy, onAnalyze, assets }: { kind: Kind; busy: boolean; onAnalyze: (fd: FormData) => void; assets: DemoAssets | null }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [addedAt, setAddedAt] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState(false);
  const [localErr, setLocalErr] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  React.useEffect(() => { setFile(null); setPreview(null); }, [kind]);

  function take(f: File | null | undefined) {
    setLocalErr(null);
    if (!f) return;
    if (!ACCEPT.split(",").includes(f.type) && !(f.type === "" && ACCEPT_EXT.test(f.name))) { setLocalErr("Unsupported file type — use PNG, JPG, JPEG, WEBP or PDF."); return; }
    if (f.size > 10 * 1024 * 1024) { setLocalErr("File is larger than 10 MB."); return; }
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setAddedAt(new Date().toISOString());
  }

  async function useAsset(url: string, name: string) {
    const blob = await (await fetch(url)).blob();
    take(new File([blob], name, { type: blob.type || (name.endsWith(".pdf") ? "application/pdf" : "image/png") }));
  }

  const docAssets = assets?.assets.filter((a) => a.folder !== "audio") ?? [];
  const verb = file?.type === "application/pdf" ? "Extract business event" : "Analyze input";

  return (
    <Card>
      <CardHeader><CardTitle>{titleCase(kind)} · upload</CardTitle><span className="text-[11px] text-slate-400">PNG · JPG · JPEG · WEBP · PDF · max 10 MB</span></CardHeader>
      <CardContent>
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files?.[0]); }}
          onClick={() => ref.current?.click()} role="button" tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && ref.current?.click()}
          className={cn("flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors",
            drag ? "border-brand bg-brand-soft" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50")}
          aria-label="Upload a document">
          <Upload className="mb-2 h-6 w-6 text-slate-400" />
          <div className="text-sm font-medium text-slate-700">Drag & drop an invoice, bill, receipt, quotation or image</div>
          <div className="text-xs text-slate-500">or click to browse</div>
          <input ref={ref} type="file" accept={ACCEPT} className="hidden" onChange={(e) => take(e.target.files?.[0])} />
        </div>
        {localErr && <p className="mt-2 text-sm text-red-600">{localErr}</p>}

        {docAssets.length > 0 && (
          <div className="mt-3">
            <div className="label-xs mb-1.5">Demo assets (fictional)</div>
            <div className="flex flex-wrap gap-1.5">
              {docAssets.map((a) => (
                <button key={a.name} onClick={() => useAsset(a.url, a.name)} className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:border-brand hover:text-brand">
                  {a.name.endsWith(".pdf") ? <FileText className="h-3.5 w-3.5" /> : a.kind === "receipt" ? <Receipt className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {file && preview && (
          <div className="mt-4 rounded-lg border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs">
              <div className="min-w-0"><div className="truncate font-medium text-slate-800">{file.name}</div>
                <div className="text-slate-500">{bytes(file.size)} · {file.type} · added {time(addedAt)}</div></div>
              <button onClick={() => { setFile(null); setPreview(null); }} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Remove file"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex justify-center bg-slate-50 p-3">
              {file.type === "application/pdf"
                ? <object data={preview} type="application/pdf" className="h-72 w-full rounded border border-slate-200 bg-white"><p className="p-3 text-xs text-slate-500">PDF preview unavailable — the file will still be parsed.</p></object>
                // eslint-disable-next-line @next/next/no-img-element
                : <img src={preview} alt="Upload preview" className="max-h-72 rounded border border-slate-200 object-contain" />}
            </div>
            <div className="flex items-center gap-2 border-t border-slate-100 p-3">
              <Button onClick={() => { const fd = new FormData(); fd.append("kind", kind); fd.append("file", file); onAnalyze(fd); }} disabled={busy}>
                <Sparkles /> {busy ? "Processing…" : verb}
              </Button>
              {busy && <span className="text-xs text-slate-500">Reading document · extracting events · checking confidence…</span>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ message / text

function TextInput({ kind, busy, onAnalyze, samples }: { kind: Kind; busy: boolean; onAnalyze: (fd: FormData) => void; samples: DemoAssets["messages"] }) {
  const [text, setText] = React.useState("");
  const [sender, setSender] = React.useState("");
  const [sendKind, setSendKind] = React.useState<string>(kind);
  React.useEffect(() => setSendKind(kind), [kind]);
  const relevant = samples.filter((s) => (kind === "message" ? ["message", "quotation"] : ["text"]).includes(s.kind) || kind === "text");
  return (
    <Card>
      <CardHeader><CardTitle>{kind === "message" ? "Paste customer or supplier message" : "Quick entry · type any business activity"}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {kind === "message" && (
          <div><Label htmlFor="sender">From (optional)</Label>
            <Input id="sender" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="e.g. Ramesh Stores (WhatsApp)" /></div>
        )}
        <div><Label htmlFor="msg">{kind === "message" ? "Message" : "Activity"}</Label>
          <Textarea id="msg" rows={4} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={kind === "message" ? "“Ramesh bhai says he needs 20 Coke by Friday.”" : "“Aaj 5 Maggi becha” · “2 Sprite damaged”"} /></div>
        <div>
          <div className="label-xs mb-1.5">Try a sample (demo)</div>
          <div className="flex flex-wrap gap-1.5">
            {relevant.map((s) => (
              <button key={s.label} onClick={() => { setText(s.text); setSender(s.sender); setSendKind(s.kind === "voice" ? "message" : s.kind); }}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:border-brand hover:text-brand">{s.label}</button>
            ))}
          </div>
        </div>
        <Button disabled={!text.trim() || busy} onClick={() => { const fd = new FormData(); fd.append("kind", sendKind); fd.append("text", text); if (sender) fd.append("sender", sender); onAnalyze(fd); }}>
          <Send /> {busy ? "Understanding…" : kind === "message" ? "Understand message" : "Extract event"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ voice

type SR = any;
function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4", "audio/mpeg"].find((m) => MediaRecorder.isTypeSupported(m));
}
const extFor = (mime: string) => (mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : "webm");

function VoiceInput({ busy, onAnalyze, assets }: { busy: boolean; onAnalyze: (fd: FormData) => void; assets: DemoAssets | null }) {
  const [recording, setRecording] = React.useState(false);
  const [seconds, setSeconds] = React.useState(0);
  const [transcript, setTranscript] = React.useState("");
  const [audio, setAudio] = React.useState<Blob | null>(null);
  const [audioName, setAudioName] = React.useState("voice-note.webm");
  const [lang, setLang] = React.useState("hi-IN");
  const [status, setStatus] = React.useState<string | null>(null);
  const [listening, setListening] = React.useState(false);
  const [isDemoAudio, setIsDemoAudio] = React.useState(false);
  const rec = React.useRef<MediaRecorder | null>(null);
  const stream = React.useRef<MediaStream | null>(null);
  const sr = React.useRef<SR | null>(null);
  const active = React.useRef(false);
  const finalText = React.useRef("");
  const chunks = React.useRef<Blob[]>([]);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const [supportsRec, setSupportsRec] = React.useState(true);
  const [SRClass, setSRClass] = React.useState<any>(null);
  React.useEffect(() => {
    setSupportsRec(!!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined" && window.isSecureContext);
    setSRClass(() => (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null);
    return () => { active.current = false; try { sr.current?.abort?.(); } catch {} ; stream.current?.getTracks().forEach((t) => t.stop()); if (timer.current) clearInterval(timer.current); };
  }, []);

  function startRecognition() {
    if (!SRClass) return;
    const s = new SRClass();
    s.lang = lang; s.interimResults = true; s.continuous = true; s.maxAlternatives = 1;
    s.onstart = () => setListening(true);
    s.onresult = (ev: any) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) finalText.current += ev.results[i][0].transcript.trim() + " ";
        else interim += ev.results[i][0].transcript;
      }
      setTranscript((finalText.current + interim).trim());
    };
    s.onerror = (ev: any) => {
      const code = ev?.error;
      if (code === "no-speech" || code === "aborted") return; // onend restarts
      if (code === "not-allowed" || code === "service-not-allowed") { active.current = false; setStatus("Speech recognition was blocked. Allow microphone access, or type the transcript below."); }
      else if (code === "network") setStatus("Live speech-to-text needs an internet connection to the browser's speech service. The audio is still recorded — type the transcript or configure Gemini.");
      else if (code === "language-not-supported") setStatus(`Speech recognition does not support ${lang} in this browser — choose another language or type the transcript.`);
      else setStatus(`Live transcription stopped (${code ?? "unknown error"}). The audio is still recorded.`);
    };
    // Chrome ends recognition after a pause; restart while the user is still recording.
    s.onend = () => { setListening(false); if (active.current) { try { s.start(); } catch { /* already started */ } } };
    try { s.start(); sr.current = s; } catch { setStatus("Live transcription could not start — type the transcript below."); }
  }

  async function start() {
    setStatus(null);
    setIsDemoAudio(false);
    if (!window.isSecureContext) { setStatus("Recording needs a secure (https) page."); return; }
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = st;
      chunks.current = [];
      finalText.current = "";
      setTranscript("");
      setAudio(null);
      const mime = pickMime();
      const mr = mime ? new MediaRecorder(st, { mimeType: mime }) : new MediaRecorder(st);
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.current.push(e.data); };
      mr.onstop = () => {
        const type = (mr.mimeType || mime || "audio/webm").split(";")[0];
        const blob = new Blob(chunks.current, { type });
        if (blob.size) { setAudio(blob); setAudioName(`voice-note.${extFor(type)}`); }
        else setStatus("No audio was captured — check your microphone and try again.");
        st.getTracks().forEach((t) => t.stop());
        stream.current = null;
      };
      mr.onerror = () => setStatus("Recording failed — try again or upload an audio file.");
      mr.start(250);
      rec.current = mr;
      active.current = true;
      if (SRClass) startRecognition();
      else setStatus("This browser has no live speech-to-text (try Chrome or Edge). Type what was said, or configure Gemini to transcribe the audio on the server.");
      setSeconds(0);
      timer.current = setInterval(() => setSeconds((x) => { if (x + 1 >= 120) stop(); return x + 1; }), 1000);
      setRecording(true);
    } catch (e: any) {
      setStatus(e?.name === "NotAllowedError" ? "Microphone permission denied. Allow microphone access in the browser, upload an audio file, or type the transcript."
        : e?.name === "NotFoundError" ? "No microphone found. Upload an audio file or type the transcript instead." : "Microphone unavailable. Upload an audio file or type the transcript instead.");
    }
  }
  function stop() {
    active.current = false;
    try { if (rec.current && rec.current.state !== "inactive") rec.current.stop(); } catch {}
    try { sr.current?.stop?.(); } catch {}
    if (timer.current) clearInterval(timer.current);
    setRecording(false);
    setListening(false);
  }

  const demoAudio = assets?.assets.find((a) => a.folder === "audio");
  const audioUrl = React.useMemo(() => (audio ? URL.createObjectURL(audio) : null), [audio]);
  React.useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  return (
    <Card>
      <CardHeader><CardTitle>Recording</CardTitle><span className="text-[11px] text-slate-400">Speak naturally in Hindi, English or Hinglish</span></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col items-center rounded-lg bg-[#0e1526] px-6 py-6 text-white">
          <button onClick={recording ? stop : start} disabled={!supportsRec || busy}
            className={cn("flex h-16 w-16 items-center justify-center rounded-full ring-8 transition-colors disabled:opacity-40",
              recording ? "bg-red-500 ring-red-500/25" : "bg-red-500/90 ring-white/10 hover:bg-red-500")} aria-label={recording ? "Stop recording" : "Start recording"}>
            {recording ? <Square className="h-6 w-6" fill="currentColor" /> : <Mic className="h-7 w-7" />}
          </button>
          <div className="mt-4 flex h-8 items-end gap-[3px]" aria-hidden>
            {Array.from({ length: 34 }).map((_, i) => (
              <span key={i} className={cn("w-[3px] rounded bg-red-400", recording ? "animate-pulsebar" : "opacity-40")}
                style={{ height: `${10 + ((i * 37) % 22)}px`, animationDelay: `${(i % 7) * 0.09}s`, transformOrigin: "bottom" }} />
            ))}
          </div>
          <div className="mt-2 text-xs text-slate-300">
            {recording ? `Recording… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} — tap to stop` :
              audio ? `Recorded ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : supportsRec ? "Tap to record (max 2 min)" : "Recording not supported in this browser"}
          </div>
          {recording && <div className="mt-1 text-[11px] text-slate-400">{listening ? "● Live speech-to-text on" : SRClass ? "Starting speech-to-text…" : "Audio only (no live speech-to-text in this browser)"}</div>}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40"><Label htmlFor="lang">Speech language</Label>
            <Select id="lang" value={lang} onChange={(e) => setLang(e.target.value)} disabled={recording}>
              <option value="hi-IN">Hindi (hi-IN)</option><option value="en-IN">English (en-IN)</option>
              <option value="mr-IN">Marathi (mr-IN)</option><option value="ta-IN">Tamil (ta-IN)</option>
            </Select></div>
          <label className="cursor-pointer rounded-md border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
            Upload audio file
            <input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return;
              if (f.size > 10 * 1024 * 1024) { setStatus("Audio file is larger than 10 MB."); return; }
              setStatus(null); setIsDemoAudio(false); setAudio(f); setAudioName(f.name); }} />
          </label>
          {demoAudio && <button className="rounded-md border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:border-brand hover:text-brand"
            onClick={async () => { const b = await (await fetch(demoAudio.url)).blob(); setAudio(b); setAudioName(demoAudio.name); setTranscript(""); setIsDemoAudio(true); toast("Demo voice note loaded (placeholder audio with a bundled DEMO TRANSCRIPTION)"); }}>
            Demo voice note</button>}
          <button className="rounded-md border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:border-brand hover:text-brand" onClick={() => setTranscript("Ramesh Stores ne 3000 rupaye de diye")}>Sample transcript</button>
        </div>
        {status && <Notice tone="amber"><span className="flex items-center gap-1"><MicOff className="h-3.5 w-3.5" />{status}</span></Notice>}
        {audio && <div className="flex items-center gap-2 text-xs text-slate-600"><Clock className="h-3.5 w-3.5" /> {audioName} · {bytes(audio.size)}
          {audioUrl && <audio controls src={audioUrl} className="h-8" />}
          {isDemoAudio && <Badge tone="amber">DEMO TRANSCRIPTION</Badge>}</div>}
        <div><Label htmlFor="transcript">Transcript {SRClass ? "(live, editable)" : "(type or paste)"}</Label>
          <Textarea id="transcript" rows={3} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="“Ramesh ne 3000 rupaye de diye.”" /></div>
        <Button disabled={busy || (!transcript.trim() && !audio)} onClick={() => {
          const fd = new FormData();
          fd.append("kind", "voice");
          if (transcript.trim()) fd.append("text", transcript.trim());
          if (audio) fd.append("file", new File([audio], audioName, { type: audio.type || "audio/webm" }));
          onAnalyze(fd);
        }}><Sparkles /> {busy ? "Transcribing…" : "Extract event"}</Button>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ raw input

function RawInput({ artifact }: { artifact: Artifact }) {
  return (
    <Card>
      <CardHeader><CardTitle>Raw input · {artifact.id}</CardTitle>
        <div className="flex flex-wrap gap-1.5">
          {artifact.page_count != null && <Badge tone="slate">PDF · {artifact.page_count} page{artifact.page_count === 1 ? "" : "s"}</Badge>}
          {artifact.transcription === "DEMO TRANSCRIPTION" && <Badge tone="amber">DEMO TRANSCRIPTION</Badge>}
          {artifact.transcription === "BROWSER" && <Badge tone="slate">Browser transcript</Badge>}
          {artifact.transcription === "GEMINI" && <Badge tone="indigo">Gemini transcript</Badge>}
          {artifact.is_demo && <Badge tone="amber">DEMO DATA</Badge>}
        </div></CardHeader>
      <CardContent className="space-y-2 text-sm">
        {artifact.file_url && artifact.mime?.startsWith("image/") && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={artifact.file_url} alt="Uploaded document" className="max-h-80 w-full rounded border border-slate-200 bg-slate-50 object-contain" />
        )}
        {artifact.file_url && artifact.mime?.startsWith("audio/") && <audio controls src={artifact.file_url} className="w-full" />}
        {artifact.file_url && artifact.mime === "application/pdf" && <a href={artifact.file_url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-brand hover:underline">Open PDF ↗</a>}
        {artifact.text_content && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="label-xs mb-1">{artifact.kind === "voice" ? "Transcript" : artifact.mime ? "Extracted text" : "Message"}</div>
            <p className="whitespace-pre-wrap text-[13px] italic text-slate-700">“{artifact.text_content}”</p>
          </div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          {artifact.filename && <span>{artifact.filename}</span>}{artifact.size ? <span>{bytes(artifact.size)}</span> : null}
          {artifact.sender && <span>From: {artifact.sender}</span>}<span>Recorded: {dateTime(artifact.created_at)}</span>
          {artifact.page_count != null && <span>Pages: {artifact.page_count}</span>}
          <span>Mode: {artifact.analysis_mode}</span>
        </div>
        {artifact.note && <p className="text-xs text-slate-500">{artifact.note}</p>}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ extraction & review

function Extraction({ result, busy, threshold, onUpdate }: { result: AnalyzeResult | null; busy: boolean; threshold: number; onUpdate: (p: Proposal) => void }) {
  const [confirming, setConfirming] = React.useState(false);
  if (busy) return <Card><CardContent className="py-10"><Loading label="Processing input — understanding, extracting, validating…" /></CardContent></Card>;
  if (!result) return (
    <Card><CardHeader><CardTitle>AI extraction</CardTitle></CardHeader>
      <CardContent><Empty title="No input analysed yet" icon={<Sparkles className="h-8 w-8" />}>Upload a document, paste a message or record a voice note. Detected events appear here with source, confidence and timestamp.</Empty></CardContent></Card>
  );
  const u = result.understanding;
  const open = result.proposals.filter((p) => p.status === "PROPOSED");
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI extraction</CardTitle>
        <div className="flex items-center gap-2">
          <Badge tone={u.mode === "gemini" ? "indigo" : u.mode === "fallback" ? "red" : "amber"}>{u.mode === "gemini" ? "Gemini" : u.mode === "fallback" ? "Fallback rules" : "Demo rules"}</Badge>
          {result.proposals.length > 0 && <span className="text-xs font-medium text-emerald-700">● Lowest confidence {Math.round(Math.min(...result.proposals.map((p) => p.confidence)) * 100)}%</span>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {(u.supplier || u.document_no) && (
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
            <div><div className="label-xs !text-[10px]">{u.supplier ? "Supplier" : "Document"}</div><div className="text-sm font-semibold">{u.supplier ?? "—"}</div></div>
            {u.document_no && <Badge tone="indigo">{u.document_no}</Badge>}
          </div>
        )}
        {u.notice && <Notice tone={u.mode === "fallback" ? "red" : "amber"} title={u.mode === "fallback" ? "AI SERVICE UNAVAILABLE" : result.proposals.length ? undefined : "NO EVENT DETECTED"}>{u.notice}</Notice>}
        {result.proposals.length > 0 && <div className="label-xs">Detected events</div>}
        {result.proposals.map((p) => <ProposalCard key={p.id} p={p} threshold={threshold} onUpdate={onUpdate} artifact={result.artifact} />)}
        {open.length > 1 && (
          <Button disabled={confirming} onClick={async () => {
            setConfirming(true);
            for (const p of open) {
              try {
                const r = await api.post<{ proposal: Proposal; intelligence: LedgerEvent[] }>(`/api/proposals/${p.id}/confirm`, {});
                onUpdate(r.proposal);
                r.intelligence.forEach((i) => toast.warning(`${i.title}: ${i.change}`));
              } catch (e) { toast.error((e as ApiError).details.join("; ")); }
            }
            notifyChanged();
            setConfirming(false);
          }}><CheckCircle2 /> Confirm all {open.length} events</Button>
        )}
      </CardContent>
    </Card>
  );
}

