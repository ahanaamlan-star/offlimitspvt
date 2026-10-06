# OFFLIMITS — Setup & deployment

OFFLIMITS runs in two interchangeable ways. The UI is identical in both; only where the API runs differs.

| Mode | What runs | Use it for |
|---|---|---|
| **Full stack** | Next.js frontend + FastAPI backend + SQLite/PostgreSQL | Local development, Docker, any server host |
| **Standalone (static)** | Static Next.js export; the same SEE → THINK → ACT engine runs **in the browser** (`frontend/lib/engine`), data saved per visitor in `localStorage` + IndexedDB; optional Netlify Function for Gemini | **Netlify**, any static host, offline demos |

`NEXT_PUBLIC_API_MODE` picks the API: `auto` (default — FastAPI if `/api/health` answers, otherwise the in-browser engine), `remote` (always FastAPI) or `local` (always in-browser).

Requirements: **Node 20.9+**, **Python 3.11+** (backend only).

---

## 1. Deploy to Netlify (recommended for sharing)

### Why the previous Netlify deploy failed
Netlify hosts static files and serverless functions. It cannot run the FastAPI server, so every `/api/*` call the
old build made went nowhere (and a Next.js server build has no `index.html` to publish). The site now exports to
plain static files and carries its own API engine, so nothing on Netlify needs a Python server.

### Option A — Git deploy (gives you the optional Gemini function)
1. Push this folder to GitHub/GitLab (the repo root is the folder that contains `netlify.toml`, `frontend/`, `backend/`).
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. Leave the build settings empty — `netlify.toml` provides them:
   base `frontend`, command `npm run build:static`, publish `out`, functions `netlify/functions`, Node 20.
   (If you instead set the base directory to `frontend` in the UI, `frontend/netlify.toml` is used — same settings.)
4. Optional live AI: **Site configuration → Environment variables** → add `GEMINI_API_KEY` (and `GEMINI_MODEL` if you
   want another model) → **Deploys → Trigger deploy → Clear cache and deploy site**. The key is only read by the
   function `frontend/netlify/functions/gemini.mts`; the browser never receives it. The top bar then shows LIVE MODE.
5. Open the site → **Run 3-minute demo**.

### Option B — Netlify Drop (drag and drop, no Git)
1. Use the pre-built folder `offlimits-netlify-drop/` (or build it: `cd frontend && npm ci && npm run build:static` → `frontend/out/`).
2. Go to <https://app.netlify.com/drop> and drag **the folder itself** (`offlimits-netlify-drop` or `out`) onto the page.
3. Done. Drop deploys static files only, so the site runs in **Demo Mode** (no Gemini function); every workflow,
   including voice recording, PDF reading and the guided demo, still works.

Do **not** drag the whole project folder or a source zip onto Netlify Drop — Drop does not run builds.

### Other static hosts
`npm run build:static` → upload `frontend/out/`. The host must serve `about.html` for `/about` (Netlify, Vercel static,
Cloudflare Pages and `npx serve` do this). Test locally: `npx serve frontend/out`.

---

## 2. Run locally — full stack

```bash
# terminal 1 — backend (http://localhost:8000, API docs at /docs)
cd backend
pip install -r requirements.txt
cp ../.env.example .env          # optional — works without it (Demo Mode)
uvicorn app.main:app --reload --port 8000

# terminal 2 — frontend (http://localhost:3000)
cd frontend
npm install
npm run dev
```
The backend creates the database and seeds the demo business on first start. Next.js proxies `/api/*` to
`BACKEND_URL` (default `http://127.0.0.1:8000`).

### Frontend only (no Python)
`cd frontend && npm install && npm run dev` — with no backend running, `auto` mode switches to the in-browser engine.

### Docker
`docker compose up --build` → frontend :3000, backend :8000, PostgreSQL.

---

## 3. Database
* Full stack: SQLite file `backend/offlimits.db` by default. For PostgreSQL set
  `DATABASE_URL=postgresql+psycopg://user:pass@host:5432/offlimits` and `pip install "psycopg[binary]"`.
  Older demo databases are rebuilt automatically when the schema changes (all data is DEMO DATA).
* Standalone: `localStorage` key `offlimits-demo-db-v1` (business data) and IndexedDB `offlimits-files` (uploaded
  files), per browser. Nothing leaves the visitor's browser except optional Gemini calls through the function.
* Reset any time: **Settings → Reset demo data**, the guided demo's **Reset demo**, or `POST /api/demo/reset`.

## 4. Gemini
* Full stack: `GEMINI_API_KEY=...` in `backend/.env`, restart the backend.
* Netlify: environment variable `GEMINI_API_KEY`, redeploy.

Gemini then reads images, PDFs and audio. Its output is still normalised, entity-resolved, validated and
confidence-checked by deterministic code. If a call fails, OFFLIMITS falls back to the rule-based parser and shows
**AI SERVICE UNAVAILABLE**.

## 5. Tests & builds
```bash
cd backend  && python -m pytest -q          # 30 backend tests
cd frontend && npm run test:engine          # 10 in-browser engine tests (Node 20+)
cd frontend && npm run typecheck            # TypeScript
cd frontend && npm run build:static         # Netlify/static build → frontend/out
cd frontend && npm run build                # server build (with FastAPI proxy)
```

## 6. Environment variables
See `.env.example`.

| Variable | Where | Purpose |
|---|---|---|
| `GEMINI_API_KEY`, `GEMINI_MODEL` | backend `.env` / Netlify env | Live AI (optional). Server-side only. |
| `DATABASE_URL`, `UPLOAD_DIR`, `MAX_UPLOAD_MB`, `CONFIDENCE_THRESHOLD`, `FRONTEND_ORIGINS`, `DEMO_MODE`, `SARVAM_API_KEY` | backend `.env` | Backend settings |
| `BACKEND_URL` | frontend `.env.local` | FastAPI proxy target (server build only) |
| `NEXT_PUBLIC_API_MODE` | frontend | `auto` / `remote` / `local` |
| `STATIC_EXPORT` | build | `1` → static export (set by `npm run build:static` and `netlify.toml`) |
| `NEXT_PUBLIC_AI_PROXY` | build (automatic) | `1` when Netlify builds with a `GEMINI_API_KEY` present — a boolean only |

## 7. Troubleshooting
| Symptom | Fix |
|---|---|
| Netlify shows "Page not found" | Publish directory must be `out` with base `frontend` (already in `netlify.toml`). With Drop, drag the `out`/`offlimits-netlify-drop` folder, not the project. |
| Netlify build fails on Node | `NODE_VERSION = "20"` is set in `netlify.toml`; clear cache and redeploy. |
| Microphone does nothing | Recording needs HTTPS (Netlify is HTTPS) and microphone permission. Live speech-to-text needs Chrome or Edge; other browsers still record audio — type the transcript. |
| Still Demo Mode after adding the key on Netlify | Trigger a new deploy after adding `GEMINI_API_KEY` (Git deploys only — Drop has no functions). |
| Want a clean slate | Settings → Reset demo data. |
