/**
 * In-browser engine tests (the code that runs on Netlify / static hosting).
 * Run: npm run test:engine   (Node 20+, uses node:test via tsx)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, describe, it } from "node:test";
import { handleLocal } from "../lib/engine/router";

const ROOT = new URL("../public/demo/", import.meta.url);
const file = (rel: string) => new Blob([readFileSync(new URL(rel, ROOT))]);
async function call(method: string, url: string, body?: any) {
  return handleLocal(method, url, body);
}
async function ok(method: string, url: string, body?: any) {
  const r = await call(method, url, body);
  assert.ok(r.status < 400, `${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
function form(fields: Record<string, string | Blob>, filename = "upload") {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) v instanceof Blob ? fd.set(k, v, filename) : fd.set(k, v);
  return fd;
}

before(async () => {
  (globalThis as any).__OFFLIMITS_PDFJS__ = await import("pdfjs-dist/legacy/build/pdf.mjs");
});
beforeEach(async () => { delete process.env.NEXT_PUBLIC_AI_PROXY; await ok("POST", "/api/demo/reset"); });

describe("seed & state", () => {
  it("starts from the fictional demo business", async () => {
    const ov = await ok("GET", "/api/overview");
    assert.equal(ov.summary.cash, 42850);
    assert.equal(ov.summary.skus, 20);
    assert.equal(ov.summary.open_orders, 5);
    assert.equal(ov.health.mode, "DEMO");
    assert.equal(ov.health.runtime, "browser");
  });
});

describe("SEE uploads", () => {
  it("image invoice → 3 proposals (demo OCR fixture) → confirm → inventory + PO closed; duplicate refused", async () => {
    const a = await ok("POST", "/api/inputs/analyze", form({ kind: "invoice", file: file("images/demo_invoice_metro_INV-2841.png") }, "inv.png"));
    assert.equal(a.artifact.mime, "image/png");
    assert.equal(a.artifact.is_demo, true);
    assert.deepEqual(a.proposals.map((p: any) => p.type), ["SUPPLIER_PRICE_UPDATE", "PURCHASE_RECEIVED", "PURCHASE_RECEIVED"]);
    for (const p of a.proposals) await ok("POST", `/api/proposals/${p.id}/confirm`, {});
    const coke = (await ok("GET", "/api/inventory")).find((r: any) => r.sku === "SKU-1042");
    assert.equal(coke.on_hand, 40);
    assert.equal(coke.incoming, 0);
    const again = await ok("POST", "/api/inputs/analyze", form({ kind: "invoice", file: file("images/demo_invoice_metro_INV-2841.png") }, "inv.png"));
    const dup = await call("POST", `/api/proposals/${again.proposals[1].id}/confirm`, {});
    assert.equal(dup.status, 409);
  });

  it("PDF → real text extraction with page count", async () => {
    const a = await ok("POST", "/api/inputs/analyze", form({ kind: "invoice", file: file("documents/demo_invoice_householdhub_HH-7790.pdf") }, "x.pdf"));
    assert.equal(a.artifact.page_count, 1);
    assert.equal(a.understanding.page_count, 1);
    assert.ok(a.artifact.text_content && a.artifact.text_content.length > 20);
    assert.ok(a.proposals.length >= 1, "PDF should yield events");
  });

  it("audio → DEMO TRANSCRIPTION label; browser transcript → BROWSER", async () => {
    const a = await ok("POST", "/api/inputs/analyze", form({ kind: "voice", file: file("audio/demo_voice_payment_ramesh.wav") }, "v.wav"));
    assert.equal(a.artifact.transcription, "DEMO TRANSCRIPTION");
    assert.equal(a.proposals[0].type, "PAYMENT_RECEIVED");
    const b = await ok("POST", "/api/inputs/analyze", form({ kind: "voice", text: "Aaj 5 Maggi becha", file: file("audio/demo_voice_payment_ramesh.wav") }, "v.wav"));
    assert.equal(b.artifact.transcription, "BROWSER");
    assert.equal(b.proposals[0].type, "SALE");
  });

  it("rejects fake / oversized files and empty input", async () => {
    const fake = await call("POST", "/api/inputs/analyze", form({ kind: "image", file: new Blob(["not an image"]) }, "x.png"));
    assert.equal(fake.status, 415);
    const big = await call("POST", "/api/inputs/analyze", form({ kind: "image", file: new Blob([new Uint8Array(11 * 1024 * 1024)]) }, "x.png"));
    assert.equal(big.status, 415);
    const empty = await call("POST", "/api/inputs/analyze", form({ kind: "text" }));
    assert.equal(empty.status, 400);
  });

  it("ambiguous customer → NEEDS_REVIEW; confirm refused until resolved", async () => {
    const a = await ok("POST", "/api/inputs/analyze", form({ kind: "message", text: "Ramesh paid ₹3,000" }));
    const [p] = a.proposals;
    assert.equal(p.status, "NEEDS_REVIEW");
    assert.equal((await call("POST", `/api/proposals/${p.id}/confirm`, {})).status, 400);
    await ok("POST", `/api/proposals/${p.id}/confirm`, { overrides: { customer_id: "CUST-01" } });
  });
});

describe("THINK → ACT", () => {
  it("order → shortage 11 → Supplier B 20 × ₹39 → approval → OFF-2026-091 → shortage 0", async () => {
    const a = await ok("POST", "/api/inputs/analyze", form({ kind: "invoice", file: file("images/demo_invoice_metro_INV-2841.png") }, "inv.png"));
    for (const p of a.proposals) await ok("POST", `/api/proposals/${p.id}/confirm`, {});
    const o = await ok("POST", "/api/inputs/analyze", form({ kind: "message", sender: "Ramesh Stores", text: "Kal 25 Coke aur 10 Sprite bhej dena" }));
    const c = await ok("POST", `/api/proposals/${o.proposals[0].id}/confirm`, {});
    assert.match(c.intelligence[0].change, /shortage: 11 units/);
    const rec = (await ok("GET", "/api/recommendations?status=PENDING")).find((r: any) => r.sku === "SKU-1042");
    assert.equal(rec.supplier_id, "SUP-B");
    assert.equal(rec.qty, 20);
    assert.equal(rec.total, 780);
    assert.equal((await call("POST", `/api/recommendations/${rec.id}/approve`, {})).status, 400, "approval needs acknowledgement");
    const ap = await ok("POST", `/api/recommendations/${rec.id}/approve`, { acknowledged: true });
    assert.equal(ap.purchase_order.id, "OFF-2026-091");
    assert.equal(ap.approval.id, "APR-0091");
    assert.equal(ap.before.predicted_shortage, 11);
    assert.equal(ap.after.predicted_shortage, 0);
  });

  it("simulation preview is live (not saved) and returns the four BEST badges", async () => {
    const before = (await ok("GET", "/api/simulations")).length;
    const r = await ok("POST", "/api/simulations/preview", { sku: "SKU-1042", scenarios: [
      { supplier_id: "SUP-A", qty: 100, discount_pct: 15 }, { supplier_id: "SUP-B", qty: 20 }, { supplier_id: "SUP-C", qty: 50 }] });
    assert.deepEqual(Object.keys(r.verdict.badges).sort(), ["best_balanced", "best_cost", "best_coverage", "best_speed"]);
    assert.match(r.verdict.badges.best_speed, /^Supplier B/);
    assert.equal((await ok("GET", "/api/simulations")).length, before);
    const saved = await ok("POST", "/api/simulations", { sku: "SKU-1042", scenarios: [{ supplier_id: "SUP-B", qty: 20 }] });
    assert.match(saved.id, /^SIM-/);
  });

  it("ledger filters by source, type and date", async () => {
    await ok("POST", "/api/inputs/analyze", form({ kind: "invoice", file: file("images/demo_invoice_metro_INV-2841.png") }, "inv.png"));
    const src = await ok("GET", "/api/events?source=invoice");
    assert.ok(src.length > 0 && src.every((e: any) => e.source_type === "invoice"));
    const t = await ok("GET", "/api/events?type=RISK_DETECTED");
    assert.ok(t.length > 0 && t.every((e: any) => e.type === "RISK_DETECTED"));
    const today = new Date().toISOString().slice(0, 10);
    const d = await ok("GET", `/api/events?from=${today}&to=${today}`);
    assert.ok(d.every((e: any) => e.ts.slice(0, 10) === today));
  });
});

describe("AI fallback", () => {
  it("Gemini configured but failing → rules fallback with AI SERVICE UNAVAILABLE", async () => {
    process.env.NEXT_PUBLIC_AI_PROXY = "1";
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).endsWith("/api/gemini") && (!init || init.method === "GET")) return new Response(JSON.stringify({ configured: true, model: "test" }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ detail: ["AI service error"] }), { status: 502 });
    }) as any;
    try {
      const { geminiStatus } = await import("../lib/engine/see");
      await geminiStatus(true);
      const a = await ok("POST", "/api/inputs/analyze", form({ kind: "text", text: "Aaj 5 Maggi becha" }));
      assert.equal(a.understanding.mode, "fallback");
      assert.match(a.understanding.notice, /AI SERVICE UNAVAILABLE/);
      assert.equal(a.proposals[0].type, "SALE");
    } finally {
      globalThis.fetch = real;
      delete process.env.NEXT_PUBLIC_AI_PROXY;
      const { geminiStatus } = await import("../lib/engine/see");
      await geminiStatus(true);
    }
  });
});
