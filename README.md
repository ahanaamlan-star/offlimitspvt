# OFFLIMITS — Merchant Intelligence Loop

**From messy merchant activity to business action.**
`SEE → THINK → ACT → UPDATED STATE ↺` · HackSprint **PS21 · FinTech & Commerce**

> Prototype. Every merchant, supplier, customer, invoice and number in this repository is fictional **DEMO DATA**.

**Docs:** [SETUP.md](SETUP.md) (local, Docker, **Netlify**) · [DEMO.md](DEMO.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
[API.md](API.md) · [VALIDATION.md](VALIDATION.md)

### Deploy on Netlify in one minute
* **Git deploy:** push this folder, import it on Netlify — `netlify.toml` does the rest (static export + optional Gemini function).
* **Drag & drop:** drag the pre-built `offlimits-netlify-drop` folder (or `frontend/out` after `npm run build:static`) onto
  <https://app.netlify.com/drop>.

The whole SEE → THINK → ACT engine also runs **in the browser**, so the Netlify site needs no Python server. Details
and troubleshooting: [SETUP.md](SETUP.md).

---

## 1. Project overview
OFFLIMITS is an AI-native business intelligence and operations layer for small Indian merchants. It reads business
activity in the form it already exists (invoices, WhatsApp messages, voice notes, receipts, quotations, images),
turns it into structured, auditable **business events**, derives a **live business state** from those events,
detects consequences (stockouts, margin drops, supplier price changes, quote–invoice mismatches), recommends the
next action, and executes it **only after human approval**.

Design rule: **AI understands and explains · deterministic logic calculates · humans approve consequential actions.**

## 2. Problem
Small merchants generate useful information every day, but it is scattered across PDFs, chats, voice and paper.
The merchant is the "human bridge" who interprets it and types it into software. Most business software starts
*after* data is structured — so stockouts, margin leakage and bad purchase decisions are noticed late.

## 3. Solution
OFFLIMITS starts one step earlier. It understands the messy input, keeps an event-sourced business state, reasons
about what the new event means, compares options (price, MOQ, delivery, credit, cash impact — not just lowest
price), and turns the best option into a controlled, traceable action.

## 4. SEE → THINK → ACT architecture
| Layer | What it does | Where |
|---|---|---|
| **SEE** | Multimodal understanding → candidate events with source, confidence, timestamp; ambiguity → NEEDS REVIEW | `backend/app/services/ai.py`, `workflow.analyze_input` |
| **Ledger** | Append-only events; state = projection of events; reversals instead of edits | `services/ledger.py`, `engines/state.py` |
| **THINK** | Deterministic risk detection, forecasting, supplier comparison, what-if simulation | `engines/decision.py`, `engines/action.py` |
| **ACT** | Recommendation → human approval → purchase order → recorded → state updated | `workflow.approve_recommendation` |

## 5. Features
* **Capture (SEE)** — tabs for Invoice, Message, Voice, Image, Receipt, Quotation, Text; real drag-and-drop upload
  (PNG/JPG/JPEG/WEBP/PDF, MIME sniffing, 10 MB limit), image and PDF preview, file metadata, processing states.
* **Voice** — browser recording (MediaRecorder, webm/ogg/mp4 by browser) with live speech-to-text (Web Speech API,
  hi-IN/en-IN/mr-IN/ta-IN, auto-restarts after pauses, clear permission/network errors), audio upload, editable
  transcript → event extraction. Transcripts are labelled *Browser*, *Gemini* or **DEMO TRANSCRIPTION** (bundled fixture).
* **PDF** — real text extraction and **page count** (pypdf on the server, pdf.js in the browser).
* **Structured extraction** — every event shows source, confidence and timestamp; edit fields before confirming.
* **Ambiguity handling** — "Ramesh paid ₹3,000" matches *Ramesh Stores* and *Ramesh Kumar* → NEEDS REVIEW with
  choice buttons. Low confidence (< 75 %) also goes to review. OFFLIMITS never silently mutates state.
* **Event ledger** — table + visual timeline; search, category, **source, event type and date** filters; event
  detail with the **raw input**, structured interpretation, previous/new state, who approved, upstream/downstream
  trace, reversible corrections.
* **Live business state** — inventory, orders, cash, prices, margins, suppliers — all derived from the ledger.
* **Decision intelligence (THINK)** — stockout (with order risk), low stock, margin anomaly, supplier price change,
  quote–invoice mismatch, inventory mismatch (PO vs received), working capital, outstanding receivables.
* **What-if simulator** — 3 scenarios by default (up to 6); every edit (supplier, qty, price, discount, delivery,
  demand) **recalculates live**: cost, savings, cash now vs deferred, projected stock, excess, days to clear, capital
  locked, stockout risk, margin impact, chart, and **BEST COST / BEST SPEED / BEST STOCK COVERAGE / BEST BALANCED**.
* **Procurement (ACT)** — weighted supplier scoring, recommendation with explanation, **human approval screen**
  (ACTION · WHY · SOURCE · EXPECTED / FINANCIAL / INVENTORY IMPACT · RISK · CONFIDENCE; **Approve / Edit / Reject**;
  RECOMMENDED → APPROVED → EXECUTED → RECORDED or RECOMMENDED → REJECTED → RECORDED), purchase order, "mark goods received".
* **Analytics** — inventory, stockout risk, purchase cost, margin trend, supplier prices, cash movement — computed
  by replaying the ledger day by day, each with a "why this matters" note.
* **Guided demo** — **Run 3-minute demo**: 14 steps in 01 SEE · 02 THINK · 03 ACT · 04 UPDATED STATE, with
  Next / Back / Play / Pause / Reset demo; pauses for your approval.
* **Demo Mode** — the whole app works with no API keys, on the full stack or as a static site.

## 6. Tech stack
Next.js 16 (webpack build) · React 19 · TypeScript · Tailwind CSS · shadcn/ui-style components (Radix) · Lucide · Recharts ·
Python 3.11+ · FastAPI · SQLAlchemy 2 · SQLite (default) / PostgreSQL · Google Gemini API (optional) · pypdf · pytest ·
pdf.js · Netlify (static export + Functions) · node:test/tsx.

## 7. Folder structure
```
offlimits/
├── README.md  SETUP.md  DEMO.md  ARCHITECTURE.md  API.md  VALIDATION.md
├── netlify.toml  .env.example  .gitignore  docker-compose.yml
├── backend/
│   ├── app/
│   │   ├── main.py            FastAPI app (lifespan seeds demo data)
│   │   ├── config.py          env settings
│   │   ├── api/routes.py      all HTTP endpoints
│   │   ├── models/            ORM models (Merchant, User, InventoryItem, Supplier, Customer, Order,
│   │   │                      BusinessEvent, ProposedEvent, InputArtifact, Recommendation, Approval,
│   │   │                      PurchaseOrder, Scenario)
│   │   ├── engines/           state.py (projection + business maths) · decision.py · action.py
│   │   ├── services/          ai.py (Gemini + demo parser) · ledger.py · workflow.py · views.py · files.py · seed.py
│   │   ├── schemas/  db/
│   ├── tests/                 30 tests (business logic, API flow, uploads, fallback)
│   └── requirements.txt  Dockerfile
├── frontend/
│   ├── app/                   / · /see · /review · /think · /think/simulator · /act · /act/purchase-orders[/view?id=]
│   │                          /ledger · /state · /analytics · /settings
│   ├── components/{ui,layout,shared,demo}  hooks/  types/
│   ├── lib/api.ts             API client: FastAPI (remote) or in-browser engine (local)
│   ├── lib/engine/            TypeScript port of the backend engine for static hosting
│   ├── netlify/functions/     gemini.mts — server-side Gemini proxy (key never reaches the browser)
│   ├── public/demo/  public/vendor/pdfjs/   demo assets · pdf.js
│   ├── tests/engine.test.ts   10 engine tests
│   ├── scripts/               build-static.mjs · copy-pdfjs.mjs
│   └── netlify.toml           (used when Netlify's base directory is `frontend`)
├── data/demo/{images,documents,audio}   fictional demo assets (+ README)
├── data/fixtures/demo_assets.json        "OCR" text for demo images, keyed by SHA-256
├── docs/screenshots/
└── scripts/make_demo_assets.py
```

## 8. Environment variables
See `.env.example` and [SETUP.md](SETUP.md#6-environment-variables). Backend: `GEMINI_API_KEY`, `GEMINI_MODEL`,
`SARVAM_API_KEY` (optional), `DATABASE_URL`, `CONFIDENCE_THRESHOLD`, `MAX_UPLOAD_MB`, `UPLOAD_DIR`, `FRONTEND_ORIGINS`,
`DEMO_MODE`. Frontend: `BACKEND_URL`, `NEXT_PUBLIC_API_MODE` (`auto`/`remote`/`local`). Netlify: `GEMINI_API_KEY`,
`GEMINI_MODEL` (read only by the function). Keys are never exposed to the browser.

## 9. Local setup (quick start)
Requirements: Python 3.11+ (backend only), Node 20.9+.
```bash
git clone <your-repo-url> offlimits && cd offlimits

# terminal 1 — backend
cd backend
pip install -r requirements.txt
cp ../.env.example .env            # optional; works without it (Demo Mode)
uvicorn app.main:app --reload --port 8000

# terminal 2 — frontend
cd frontend
npm install
npm run dev                        # http://localhost:3000
```
Open **http://localhost:3000** and click **Run 3-minute demo**. No Python? `cd frontend && npm install && npm run dev`
alone works too — the in-browser engine takes over.

## 10. Backend setup
`uvicorn app.main:app --port 8000` creates the database and seeds the demo business on first start.
API docs: http://localhost:8000/docs · health: http://localhost:8000/api/health · tests: `cd backend && pytest -q`.

## 11. Frontend setup
`npm run dev` (development) · `npm run build && npm start` (server build with FastAPI proxy) ·
**`npm run build:static`** (static export to `out/` for Netlify) · `npm run typecheck` · `npm run test:engine`.
The browser calls `/api/*`; with a backend, Next.js proxies to `BACKEND_URL` (default `http://127.0.0.1:8000`).

## 12. Database setup
SQLite file `backend/offlimits.db` by default — nothing to install. For PostgreSQL set
`DATABASE_URL=postgresql+psycopg://user:pass@host:5432/offlimits` and `pip install "psycopg[binary]"`
(or use `docker compose up --build`). In standalone/Netlify mode data lives in the visitor's browser (localStorage +
IndexedDB). Reset the demo any time: **Settings → Reset demo data** or `POST /api/demo/reset`.

## 13. Gemini setup
Create a key at Google AI Studio, put `GEMINI_API_KEY=...` in `backend/.env` and restart the backend — or, on
Netlify, add `GEMINI_API_KEY` as a site environment variable and redeploy (the key is read only by the
`/api/gemini` function). The top bar switches to **LIVE MODE**. Gemini then reads images, PDFs and audio directly and writes 2-sentence explanations.
Its output is still normalised, entity-resolved, validated and confidence-checked by deterministic code. If a
Gemini call fails, OFFLIMITS falls back to the demo parser and says so ("AI SERVICE UNAVAILABLE").

## 14. Demo mode
With no key (default), SEE uses a deterministic Hinglish/English parser (orders, payments, quotes, sales, damage,
invoice line items), real PDF text extraction (pypdf / pdf.js), browser speech-to-text, bundled OCR fixtures for the
demo images and a bundled transcript for the demo audio (labelled DEMO TRANSCRIPTION). Everything
else (ledger, state, risks, simulator, approvals, POs, analytics) is identical in both modes.

## 15. Sample demo workflow
OVERVIEW → SEE: upload *Metro Beverages INV-2841* → structured events (purchase ×2 + price update ₹35→₹38, +8.6 %)
→ confirm → ledger → state (Coca-Cola 0 → 40, PO OFF-2026-087 closed) → message "Kal 25 Coke aur 10 Sprite bhej
dena" (Ramesh Stores) → THINK: shortage 11 units → What-If (15 % off for 100 units: saves ₹540 but locks ₹1,591)
→ ACT: suppliers compared, Supplier B recommended (20 × ₹39 = ₹780, today, 15-day credit) → human approval →
**PO OFF-2026-091** → ledger → updated state (shortage 11 → 0). Full script: [DEMO.md](DEMO.md).

## 16. API endpoints
`POST /api/inputs/analyze` · `POST /api/events` · `GET /api/events` · `GET /api/events/{id}` ·
`GET /api/inventory` · `GET /api/orders` · `GET /api/suppliers` · `GET /api/business-state` · `GET /api/risks` ·
`POST /api/simulations` · `GET /api/simulations/{id}` · `GET /api/recommendations` ·
`POST /api/recommendations/{id}/approve` · `POST /api/recommendations/{id}/reject` · `POST /api/purchase-orders` ·
`POST /api/simulations/preview` · `GET /api/analytics` · `GET /api/health` — plus proposals, reversal, receiving,
settings and demo endpoints. Full reference: [API.md](API.md).

## 17. Architecture diagram
```
REAL-WORLD INPUTS (invoice · message · voice · image · receipt · quotation · text)
        ↓
MULTIMODAL AI  (Gemini — or deterministic demo parser)
        ↓
STRUCTURED EVENTS  (typed payload · source · confidence · timestamp)
        ↓
CONFIDENCE / REVIEW  (ambiguous or < threshold → NEEDS REVIEW; human confirms)
        ↓
EVENT LEDGER  (append-only, deduplicated, reversible)
        ↓
LIVE BUSINESS STATE  (projection: inventory · orders · cash · prices · margins)
        ↓
DECISION ENGINE  (rules + weighted-moving-average forecast → risks)
        ↓
ACTION ENGINE  (supplier scoring · recommendation · what-if)
        ↓
HUMAN APPROVAL  (explicit acknowledgement)
        ↓
EXECUTE + RECORD  (purchase order + ledger events)
        ↓
UPDATED STATE ↺
```

## 18. Security notes
Secrets only in `.env` (git-ignored) or Netlify environment variables; keys stay server-side (browser talks to the
Next.js proxy, or to the Netlify Function, which validates request shape, size and MIME types and only calls the
configured Gemini model; the static bundle only learns a yes/no "AI available" flag). Uploads are size
limited and MIME-checked by magic bytes, stored under generated names; user text is sanitised (control characters
and HTML stripped, length-limited). Every state change is validated (no negative stock, positive quantities/prices,
known SKU/supplier/customer, duplicate invoices rejected). Consequential actions require `acknowledged=true`.
No authentication — this is a single-merchant prototype; add auth before any real deployment. In standalone mode
each visitor's data stays in their own browser.

## 19. Known limitations
* Demo-mode image reading only works for the bundled demo images (no local OCR engine); other images go to NEEDS
  REVIEW. Scanned PDFs need Gemini.
* Browser speech-to-text depends on the browser (Chrome/Edge). Server-side audio transcription needs Gemini;
  Sarvam AI is architecture-ready but not wired up.
* Forecasting is a simple weighted moving average by design. Single merchant, no auth, no real payments or messaging.
* PostgreSQL is supported through SQLAlchemy but the bundled tests run on SQLite.
* Standalone (Netlify) mode stores data per browser, not shared between visitors or devices. Netlify Drop has no
  functions, so it always runs in Demo Mode; use a Git deploy for Gemini.
* Live Gemini behaviour was verified against a mock in this build environment (no real key available).
* The UI follows the light design from the provided screenshots rather than the dark palette suggested in the spec.

## 20. Future scope
Sarvam AI for Indian-language voice, WhatsApp Business API ingestion, supplier messaging and PO sending (n8n),
GST-ready exports, multi-store and multi-user roles, payment reminders, better forecasting with seasonality,
pilot with real merchants to measure stockouts avoided and data entry saved.

### What is real vs simulated
| Real (implemented and tested) | Simulated / demo |
|---|---|
| Upload, content-based validation, storage, preview; PDF text + page count; voice recording and browser speech-to-text; rule-based extraction; entity resolution and ambiguity; event ledger, projection, reversal, dedupe; risk rules; forecasting; supplier scoring; live what-if maths and badges; approvals; PO generation and receiving; analytics replay; in-browser engine + persistence; Netlify Function for Gemini | Merchant, suppliers, customers, prices and history (DEMO DATA); OCR text for the demo images (fixture); placeholder demo audio (tone) with a DEMO TRANSCRIPTION; POs are not sent to a real supplier; no payments or messaging; Gemini requires your own key |
