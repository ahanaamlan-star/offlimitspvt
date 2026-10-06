# OFFLIMITS — Architecture

```
REAL-WORLD INPUTS → MULTIMODAL AI → STRUCTURED EVENTS → CONFIDENCE / REVIEW → EVENT LEDGER
→ LIVE BUSINESS STATE → DECISION ENGINE → ACTION ENGINE → HUMAN APPROVAL → EXECUTE + RECORD → UPDATED STATE ↺
```
Design rule: **AI understands and explains · deterministic logic calculates · humans approve consequential actions.**

## Two runtimes, one engine
```
                        ┌──────────────── Browser (Next.js UI) ────────────────┐
                        │  pages → lib/api.ts ──┬── remote ──► /api/* ──► FastAPI (backend/app)
                        │                       └── local  ──► lib/engine/router.ts (in-browser engine)
                        └───────────────────────────────────────────────────────┘
 local mode persistence: localStorage "offlimits-demo-db-v1" (JSON business data) + IndexedDB "offlimits-files" (uploads)
 local mode AI (optional): POST /api/gemini → Netlify Function (key in Netlify env) → Google Gemini
```
`frontend/lib/engine/*` is a line-by-line TypeScript port of the Python engines and services, with the same endpoint
paths and JSON shapes (`router.ts` maps `GET /api/overview`, `POST /api/inputs/analyze`, …). Both are covered by tests
that assert the same demo outcomes (shortage 11 → Supplier B 20 × ₹39 = ₹780 → PO OFF-2026-091).

| Python (full stack) | TypeScript (standalone) | Responsibility |
|---|---|---|
| `engines/state.py` | `lib/engine/state.ts` | Projection of the ledger into business state; business formulas; event validation |
| `engines/decision.py` | `lib/engine/decision.ts` | Risk rules and forecast |
| `engines/action.py` | `lib/engine/action.ts` | Supplier scoring, what-if simulation, BEST badges |
| `services/ai.py` | `lib/engine/parser.ts` + `see.ts` | Hinglish/English rule parser, entity matching, Gemini prompt + normalisation |
| `services/files.py` | `lib/engine/see.ts` | Magic-byte MIME check, 10 MB limit, SHA-256, PDF text + page count (pypdf / pdf.js) |
| `services/ledger.py` | `lib/engine/ledger.ts` | Single write path: validate, snapshot, dedupe, append |
| `services/workflow.py` | `lib/engine/workflow.ts` | Proposals, confirm, after-state-change, recommendations, approvals, POs, reversal |
| `services/views.py` | `lib/engine/views.ts` | Read models (business state, analytics, trace) |
| `services/seed.py` | `lib/engine/seed.ts` | Fictional DEMO DATA business |
| `api/routes.py` | `lib/engine/router.ts` | HTTP surface |
| SQLAlchemy models | `lib/engine/store.ts` | Persistence |

## Stages
| Stage | Notes |
|---|---|
| Real-world inputs | Multipart upload or text. Magic-byte MIME check (PNG/JPEG/WEBP/PDF/WEBM/OGG/WAV/MP3/M4A), 10 MB limit, sanitised text. |
| Multimodal AI | LIVE: Gemini with JSON output (backend directly, or via the Netlify Function). DEMO: rule parser, real PDF text, bundled OCR fixtures for demo images, bundled transcript for the demo audio (labelled **DEMO TRANSCRIPTION**). Browser speech-to-text transcripts are labelled *Browser transcript*. |
| Structured events | Typed payloads, entity resolution, PO matching, price-change derivation. |
| Confidence / review | Ambiguity, missing fields, rule violations or confidence < 0.75 → `NEEDS_REVIEW`. Proposals never touch state. |
| Event ledger | Append-only. Categories: OPENING, SOURCE, EVENT, INTELLIGENCE, DECISION, APPROVAL, ACTION, CORRECTION. Dedupe keys prevent double booking. |
| Live business state | Pure fold over confirmed events (reversed events skipped). |
| Decision engine | Stockout & order risk, low stock, margin anomaly, price change, quote–invoice mismatch, inventory mismatch, low cash, receivables. |
| Action engine | Weighted scoring: price 25 %, MOQ fit 20 %, delivery 25 %, credit 10 %, cash impact 20 %; late delivery infeasible. What-if maths with BEST COST / SPEED / STOCK COVERAGE / BALANCED. |
| Human approval | Approval screen shows ACTION, WHY, SOURCE, EXPECTED / FINANCIAL / INVENTORY IMPACT, RISK, CONFIDENCE; Approve / Edit / Reject; requires explicit acknowledgement. |
| Execute + record | `PROCUREMENT_APPROVED` + `PURCHASE_ORDER_CREATED` events and purchase order `OFF-2026-###`. States: RECOMMENDED → APPROVED → EXECUTED → RECORDED, or RECOMMENDED → REJECTED → RECORDED. |
| Updated state ↺ | After every change: new INTELLIGENCE events, recommendations refreshed or superseded. |

## Business formulas
```
available_stock        = on_hand − reserved
projected_stock        = available + incoming − forecast_demand        (forecast = weighted 7-day moving average)
stockout level         = CRITICAL if available + incoming < 0; HIGH if projected < 0; MEDIUM if projected < reorder point
margin                 = selling_price − unit_cost;  margin % = margin / selling_price × 100
working_capital_impact = purchase_cost (cash now if no credit, else deferred payable)
simulation             = stock at need-by, excess units, days to clear, capital locked, savings, margin impact
```

## Frontend
Next.js App Router. `hooks/useApi` refetches whenever a component dispatches `offlimits:changed`, so all open views
stay consistent with the ledger. The guided demo (`components/demo/demo-provider.tsx`, 14 steps in four groups
01 SEE · 02 THINK · 03 ACT · 04 UPDATED STATE) drives the same public API a user would and pauses for human approval.
The PO detail page uses `/act/purchase-orders/view?id=…` so the site can be exported statically.

## Security model
* Keys only on servers (`backend/.env` or Netlify environment). The static bundle receives a boolean flag only.
* The Netlify Function accepts a strict request shape (≤ 6 text/inline-data parts, allow-listed MIME types, ≤ 14 MB) and
  only forwards to the configured Gemini model.
* Uploads are validated by content (magic bytes), not by extension; files are stored under generated IDs.
* Every state change goes through validation (no negative stock, positive quantities/prices, known entities,
  duplicates refused). Consequential actions require `acknowledged=true`.
* No authentication (single-merchant prototype). Standalone mode stores data only in the visitor's browser.
