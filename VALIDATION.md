# OFFLIMITS — Validation

## Results (this build)
| Check | Command | Result |
|---|---|---|
| Backend tests | `cd backend && python -m pytest -q` | **30 passed** |
| In-browser engine tests | `cd frontend && npm run test:engine` | **10 passed** |
| TypeScript | `cd frontend && npm run typecheck` | no errors |
| Static (Netlify) build | `cd frontend && npm run build:static` | all routes prerendered as static content in `out/` (Next.js 16, webpack) |
| Server build + FastAPI | `npm run build && npm start` with `uvicorn` | OK — UI uses the backend API (`remote` mode), no console errors |
| Dependency audit | `cd frontend && npm audit --omit=dev` | 0 vulnerabilities |
| Netlify Function | handler called directly (GET/POST, invalid shapes, upstream failure) | 200 / 503 / 400 / 502 as designed |
| Browser end-to-end | headless Chromium against the static export (see below) | all steps passed |

## Backend tests (`backend/tests`)
| File | Covers |
|---|---|
| `test_business_logic.py` | formulas (available/projected stock, margin, margin %, working capital, weighted forecast); stockout levels; shortage 11; supplier comparison (cheapest-but-late not chosen); simulation (discount locks capital); ledger rules (negative stock, bad qty/price, unknown entities); event sourcing and reversal |
| `test_api_flow.py` | seed; invoice image → 3 events → inventory + PO closed + price anomaly; duplicate invoice 409; PDF parsed; Hinglish order → shortage 11 → Supplier B 20 × ₹39; ambiguous payment → NEEDS REVIEW; voice payment; low confidence → review; approval needs acknowledgement → OFF-2026-091 / APR-0091, shortage 11 → 0; receive; reject; invalid inputs; simulations; reversal; analytics |
| `test_inputs_and_fallback.py` | **image upload** (demo OCR fixture → quote); **PDF page count**; **audio** labelled DEMO TRANSCRIPTION; audio + browser transcript → BROWSER; unknown audio without transcript explains Demo Mode (no invented events); **AI fallback** (Gemini failure → rules, "AI SERVICE UNAVAILABLE"); **demo reset**; simulation preview (not saved) with the four BEST badges; ledger filters (source, type, date, bad date → 422) |

## In-browser engine tests (`frontend/tests/engine.test.ts`)
Seed baseline (cash ₹42,850, Demo Mode, browser runtime) · image invoice → 3 proposals → confirm → Coke 0 → 40 →
duplicate 409 · **PDF text + page count with pdf.js** · **audio DEMO TRANSCRIPTION / BROWSER** · fake file, 11 MB file
and empty input refused · ambiguous customer → NEEDS REVIEW → resolved · full THINK → ACT chain (shortage 11 →
Supplier B 20 × ₹39 = ₹780 → acknowledgement required → OFF-2026-091 / APR-0091 → shortage 0) · live simulation
preview + badges + save · ledger filters · **API fallback** (Gemini function returns 502 → rules + notice).

## Browser end-to-end (static export served locally, Chromium with a fake microphone)
* Guided demo: all **14/14** steps, grouped 01 SEE · 02 THINK · 03 ACT · 04 UPDATED STATE; approval screen shows
  ACTION/WHY/SOURCE/EXPECTED/FINANCIAL/INVENTORY IMPACT/RISK/CONFIDENCE; Edit opens supplier/qty; Approve →
  RECOMMENDED → APPROVED → EXECUTED → RECORDED; PO OFF-2026-091; Back/Next navigation.
* Persistence across reload; PO detail page via `?id=`.
* Ledger: source, event type and date filters; event detail shows the raw input.
* Simulator: editing a quantity recalculates results live; BEST COST / SPEED / STOCK COVERAGE / BALANCED shown; save → SIM id.
* PDF upload → "PDF · 1 page". Voice: real MediaRecorder recording (webm) + transcript → event labelled *Browser
  transcript*; demo voice note → **DEMO TRANSCRIPTION**. Fake PNG refused. Mobile width: no horizontal page scroll.
* Live-AI path (mock Gemini function): text and audio understood in LIVE mode; a failing call falls back with
  **AI SERVICE UNAVAILABLE**.
* Console: no errors. A 112-page-load stress run shows no hydration warnings (an intermittent React #418 seen with
  Next 15.5 static exports was removed by moving to Next 16 and client-only toasts). With the static build and no
  function, `/api/gemini` is not requested at all.

## Input validation rules
* Quantities: positive whole numbers. Prices/amounts: > 0. SKU, supplier and customer must exist.
* No event may make on-hand stock negative. Duplicate invoice lines / identical inputs cannot be booked twice.
* Ambiguous entities and confidence < 0.75 → NEEDS REVIEW; confirm is refused until resolved.
* Uploads: ≤ 10 MB; PNG/JPEG/WEBP/PDF/WEBM/OGG/WAV/MP3/M4A detected from file content (extension ignored).
* Text: control characters and HTML tags stripped, length-limited. Simulations: 1–6 scenarios, qty and price > 0.
* Purchase orders require explicit `acknowledged=true`.

## Honesty statement
No real AI accuracy, savings, merchants, transactions or supplier relationships are claimed. All seeded data is
fictional and labelled DEMO DATA. Demo image "OCR" comes from a fixture file; the demo audio is a placeholder tone
whose transcript is labelled DEMO TRANSCRIPTION. Live Gemini behaviour was tested against a mock, not the real API
(no key was available in the build environment).
