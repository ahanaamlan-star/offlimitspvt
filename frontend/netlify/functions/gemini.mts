/**
 * Netlify Function: server-side proxy to Google Gemini.
 * The API key lives only in Netlify environment variables (GEMINI_API_KEY) — never in the browser bundle.
 *   GET  /api/gemini  → { configured, model }
 *   POST /api/gemini  { parts: [...], json?: boolean } → { text }
 */
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_BODY = 14 * 1024 * 1024; // base64 of a 10 MB upload + prompt

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function validParts(parts: unknown): parts is Record<string, unknown>[] {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 6) return false;
  return parts.every((p) => {
    if (!p || typeof p !== "object") return false;
    const o = p as Record<string, any>;
    if (typeof o.text === "string") return o.text.length <= 60_000 && Object.keys(o).length === 1;
    if (o.inline_data && typeof o.inline_data.data === "string" && typeof o.inline_data.mime_type === "string")
      return /^(image\/(png|jpeg|webp)|application\/pdf|audio\/(webm|ogg|wav|mpeg|mp4))$/.test(o.inline_data.mime_type) && Object.keys(o).length === 1;
    return false;
  });
}

export default async (req: Request) => {
  const key = process.env.GEMINI_API_KEY;
  if (req.method === "GET") return json({ configured: !!key, model: key ? MODEL : null });
  if (req.method !== "POST") return json({ detail: ["Method not allowed"] }, 405);
  if (!key) return json({ detail: ["AI is not configured on the server"] }, 503);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return json({ detail: ["Request too large"] }, 413);
  let body: any;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ detail: ["Request too large"] }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ detail: ["Invalid JSON"] }, 400);
  }
  if (!validParts(body?.parts)) return json({ detail: ["Invalid request"] }, 400);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: body.parts }],
        generationConfig: { temperature: 0, ...(body.json === false ? {} : { responseMimeType: "application/json" }) },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) return json({ detail: [`AI service error (${r.status})`] }, 502);
    const data: any = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") return json({ detail: ["Empty AI response"] }, 502);
    return json({ text });
  } catch {
    return json({ detail: ["AI service unavailable"] }, 502);
  } finally {
    clearTimeout(timer);
  }
};

export const config = { path: "/api/gemini" };
