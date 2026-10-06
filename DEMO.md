# OFFLIMITS — Demo script (≈ 3 minutes)
All data is fictional **DEMO DATA**. Works the same on Netlify (in-browser engine) and on the full stack.

## Fastest: the guided demo
Click **Run 3-minute demo** (top right) → **Start (resets demo data)**. Use **Next / Back / Play / Pause / Reset demo**.
Progress is grouped **01 SEE · 02 THINK · 03 ACT · 04 UPDATED STATE**; the demo stops at step 11 for your approval.

| # | Group | Step | What you see |
|---|---|---|---|
| 1 | SEE | Merchant overview | Cash ₹42,850, 20 SKUs, 5 open orders, live risks |
| 2 | SEE | Supplier invoice uploaded | Metro Beverages INV-2841 (demo image) on the SEE page |
| 3 | SEE | Event extracted | `SUPPLIER_PRICE_UPDATE` Coke ₹35 → ₹38 (+8.6 %), `PURCHASE_RECEIVED` Coke 40 @ ₹38 (matches PO OFF-2026-087), Sprite 30 @ ₹34 — each with confidence |
| 4 | SEE | Event reviewed & confirmed | Events enter the ledger only now |
| 5 | THINK | Inventory updated | Coca-Cola on hand 0 → 40, incoming 40 → 0 |
| 6 | THINK | WhatsApp order received | "Kal 25 Coke aur 10 Sprite bhej dena" (Ramesh Stores) |
| 7 | THINK | Stockout risk detected | Stock 40, reserved 45 → shortage **11** |
| 8 | THINK | Supplier comparison | 4 suppliers scored; Supplier B best (98) |
| 9 | THINK | What-if analysis | 15 % off for 100 units saves ₹540 but locks ₹1,591 in 52 excess units |
| 10 | ACT | Recommendation created | Buy 20 × ₹39 from Supplier B = ₹780, today, 15-day credit |
| 11 | ACT | Human approval | Approval screen: ACTION · WHY · SOURCE · EXPECTED / FINANCIAL / INVENTORY IMPACT · RISK · CONFIDENCE. Tick the acknowledgement → **Approve** (or **Edit** supplier/qty, or **Reject** with a reason). State flow RECOMMENDED → APPROVED → EXECUTED → RECORDED |
| 12 | ACT | Purchase order created | **OFF-2026-091**, approved by Rajesh Sharma (APR-0091) |
| 13 | UPDATED STATE | Event ledger updated | Timeline: input → intelligence → decision → approval → action |
| 14 | UPDATED STATE | Business state updated | Shortage 11 → 0, +20 incoming, cash unchanged (credit) |

**Back** revisits the previous step's screen; recorded events stay in the append-only ledger.

## Things to show beyond the script
* **What-if simulator** — edit any quantity, price, discount or delivery day: results, chart and the BEST COST /
  BEST SPEED / BEST STOCK COVERAGE / BEST BALANCED badges recalculate live. **Save scenario** stores it with an ID.
* **Voice** — SEE → Voice → tap the mic (Chrome/Edge show a live Hindi/English transcript), stop, **Extract event**.
  The *Demo voice note* button loads placeholder audio whose transcript is clearly labelled **DEMO TRANSCRIPTION**.
* **PDF** — SEE → Invoice → demo asset *Supplier invoice · Household Hub HH-7790 (PDF)* → real text extraction, **PDF · 1 page** badge.
* **Ambiguity** — SEE → Message → *Ambiguous payment* "Ramesh paid ₹3,000" → NEEDS REVIEW (Ramesh Stores / Ramesh Kumar).
* **Low confidence** — "Coke bhej dena" (no quantity) → NEEDS REVIEW.
* **Duplicate** — upload INV-2841 again and confirm → *Duplicate event*.
* **Ledger filters** — search, source, event type, date range; click any row → raw input, structured
  interpretation, previous/new state, who approved, upstream/downstream trace, **Reverse**.
* **Invalid upload** — a renamed non-image file is refused by content check.
* **Reload the page** — state persists (standalone: in your browser; full stack: in the database).
