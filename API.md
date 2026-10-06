# OFFLIMITS — API reference
The same API exists twice: the FastAPI backend (`http://localhost:8000`, interactive docs at `/docs`, or `/api` through
the Next.js proxy) and the in-browser engine (`frontend/lib/engine/router.ts`) used on Netlify/static hosting.
Errors return `{"detail": ["message", …]}` with 400 (validation), 404, 409 (duplicate), 415 (bad upload) or 422.

## SEE
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/inputs/analyze` | multipart: `kind` (invoice/message/voice/image/receipt/quotation/text), `text?`, `sender?`, `file?` | `{artifact, proposals[], understanding{mode,text,document_no,supplier,notice,page_count,transcription,ai_confidence}, source_event}` |
| GET | `/api/inputs?limit=` · `/api/inputs/{id}` | — | artifacts (incl. `page_count`, `transcription`, `file_url`) / artifact + proposals |
| GET | `/api/inputs/{id}/file` | — | original file (backend; standalone mode uses a browser object URL) |
| GET | `/api/proposals?status=NEEDS_REVIEW` | — | proposals |
| POST | `/api/proposals/{id}/confirm` | `{overrides?: {...}, actor?}` | `{event, proposal, intelligence[], recommendations[]}` |
| POST | `/api/proposals/{id}/reject` · `/review-later` | `{reason?}` | proposal |

`transcription` is `BROWSER` (speech-to-text in the browser), `GEMINI`, or `DEMO TRANSCRIPTION` (bundled fixture).

## Ledger
| Method | Path | Notes |
|---|---|---|
| GET | `/api/events?category=&type=&source=&from=YYYY-MM-DD&to=YYYY-MM-DD&q=&entity=&include_opening=&include_pos=&limit=` | newest first; `category`, `type`, `source` accept comma lists |
| GET | `/api/events/{id}` | + artifact (raw input), approval, purchase_order, recommendation, trace{upstream,downstream} |
| POST | `/api/events` | manual validated event `{type, payload, actor?, reason?}` |
| POST | `/api/events/{id}/reverse` | `{reason?}` → CORRECTION event |

## Business state
`GET /api/business-state` · `GET /api/inventory` · `GET /api/orders` · `POST /api/orders/{id}/fulfill` ·
`GET /api/suppliers` · `GET /api/customers` · `GET /api/overview`.

## THINK
| Method | Path | Body |
|---|---|---|
| GET | `/api/risks` | — |
| GET | `/api/suppliers/compare/{sku}?qty=` | — |
| POST | `/api/simulations/preview` | same as below; **not saved** — used for live recalculation |
| POST | `/api/simulations` | `{sku, question?, name?, scenarios:[{supplier_id?, qty, unit_price?, discount_pct?, delivery_days?, credit_days?, daily_demand?, cover_days?, label?}]}` (1–6 scenarios) |
| GET | `/api/simulations` · `/api/simulations/{id}` | — |

Simulation results include `verdict.badges = {best_cost, best_speed, best_coverage, best_balanced}` (scenario labels).

## ACT
| Method | Path | Body |
|---|---|---|
| GET | `/api/recommendations?status=PENDING` · `/api/recommendations/{id}` | — |
| POST | `/api/recommendations/{id}/approve` | `{acknowledged: true, supplier_id?, qty?, note?, actor?}` → `{purchase_order, approval, events, before, after}` |
| POST | `/api/recommendations/{id}/reject` | `{reason?, actor?}` |
| GET | `/api/purchase-orders` · `/api/purchase-orders/{id}` | — |
| POST | `/api/purchase-orders` | `{sku, supplier_id, qty, acknowledged: true}` |
| POST | `/api/purchase-orders/{id}/receive` | `{qty?}` |

## System
`GET /api/health` (mode LIVE/DEMO, `runtime: "browser"` in standalone mode) · `GET/PUT /api/settings` ·
`POST /api/demo/reset` · `GET /api/demo/assets` · `GET /api/analytics`.

## Netlify Function (standalone mode only)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/gemini` | `{configured, model}` — never returns the key |
| POST | `/api/gemini` | `{parts: [{text} | {inline_data:{mime_type,data}}], json?: boolean}` → `{text}`; 400 invalid, 413 too large, 502 upstream failure, 503 not configured |

### Example (backend)
```bash
curl -s -X POST localhost:8000/api/inputs/analyze -F kind=message -F sender="Ramesh Stores" \
     -F text="Kal 25 Coke aur 10 Sprite bhej dena"
curl -s -X POST localhost:8000/api/proposals/PRP-3001/confirm -H 'content-type: application/json' -d '{}'
curl -s "localhost:8000/api/events?source=invoice&from=2026-10-01"
```
