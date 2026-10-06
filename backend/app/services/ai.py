"""SEE layer — multimodal understanding.

``GeminiService`` turns messy inputs (invoice, message, voice, image, receipt,
quotation, text) into *candidate* business events. It never writes to the ledger.

* LIVE MODE  — GEMINI_API_KEY is set: Gemini reads the document/image/audio and
  returns JSON, which is then normalised by deterministic code.
* DEMO MODE  — no key (or Gemini fails): a deterministic rule-based parser reads
  text (typed messages, voice transcripts, PDF text, demo-asset OCR fixtures).

In both modes entity resolution, ambiguity checks, confidence thresholds and all
arithmetic are done by plain Python, not by the model.
"""
from __future__ import annotations

import base64
import difflib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date, timedelta

import httpx

from app.config import settings

log = logging.getLogger("offlimits.ai")

EVENT_TYPES = ["PURCHASE_RECEIVED", "SUPPLIER_QUOTE", "CUSTOMER_ORDER", "PAYMENT_RECEIVED", "PAYMENT_MADE",
               "SALE", "DAMAGED_STOCK"]


@dataclass
class Catalog:
    items: list[dict]        # {sku, name, aliases, selling_price}
    suppliers: list[dict]    # {id, short_name, name, aliases}
    customers: list[dict]    # {id, name, aliases}


@dataclass
class ParsedEvent:
    type: str
    items: list[dict] = field(default_factory=list)   # {product, sku, qty, unit_price}
    supplier_text: str | None = None
    customer_text: str | None = None
    amount: float | None = None
    delivery_days: int | None = None
    moq: int | None = None
    credit_days: int | None = None
    due: str | None = None
    confidence: float = 0.9
    note: str = ""


@dataclass
class Understanding:
    mode: str                       # demo / gemini / fallback
    text: str | None = None         # transcript or extracted text
    document_type: str | None = None
    document_no: str | None = None
    supplier_text: str | None = None
    customer_text: str | None = None
    events: list[ParsedEvent] = field(default_factory=list)
    notice: str | None = None


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

NUM = r"(\d[\d,]*(?:\.\d+)?)"
RUPEE = r"(?:₹|rs\.?|inr|rupees?|rupaye|rupaiye|rupay)"
ORDER_WORDS = ["bhej", "bhejna", "bhejo", "send", "chahiye", "chaiye", "need", "needs", "deliver", "order", "dena", "dedo",
               "de dena", "supply", "book", "want", "require"]
PAY_IN_WORDS = ["diye", "de diye", "paid", "pay kiya", "payment", "received", "jama", "bheje", "transfer", "gpay", "upi",
                "phonepe", "cash diya"]
PAY_OUT_WORDS = ["paid to", "payment to", "ko diye", "ko bheje"]
QUOTE_WORDS = ["quote", "quotation", "rate", "price", "per unit", "each", "moq", "can deliver", "offer", "discount"]
SALE_WORDS = ["sold", "becha", "beche", "bik gaye", "bik gaya", "sale"]
DAMAGE_WORDS = ["damaged", "damage", "toot", "tuta", "toota", "broken", "expired", "kharab", "leak"]


def _num(s: str | None) -> float | None:
    if s is None:
        return None
    try:
        return float(str(s).replace(",", ""))
    except ValueError:
        return None


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w₹\s\-/.]", " ", s.lower())).strip()


def _contains_word(text: str, phrase: str) -> int:
    """Return the index of ``phrase`` in ``text`` as a whole word/phrase, else -1."""
    m = re.search(r"(?<![\w])" + re.escape(phrase) + r"(?![\w])", text)
    return m.start() if m else -1


class EntityMatcher:
    def __init__(self, catalog: Catalog):
        self.c = catalog
        self.product_aliases: list[tuple[str, str]] = []
        for it in catalog.items:
            names = {it["sku"].lower(), it["name"].lower(), *[a.lower() for a in it.get("aliases", [])]}
            for n in names:
                self.product_aliases.append((n, it["sku"]))
        self.product_aliases.sort(key=lambda x: -len(x[0]))

    # products -------------------------------------------------------------
    def find_products(self, text: str) -> list[tuple[int, int, str]]:
        """All product mentions as (start, end, sku), longest alias wins, no overlaps."""
        t = text.lower()
        taken: list[tuple[int, int]] = []
        found = []
        for alias, sku in self.product_aliases:
            for m in re.finditer(r"(?<![\w])" + re.escape(alias) + r"(?![\w])", t):
                s, e = m.start(), m.end()
                if any(not (e <= a or s >= b) for a, b in taken):
                    continue
                taken.append((s, e))
                found.append((s, e, sku))
        return sorted(found)

    def product_to_sku(self, name: str | None) -> tuple[str | None, float]:
        if not name:
            return None, 0.0
        n = name.lower().strip()
        mentions = self.find_products(n)
        if mentions:
            return mentions[0][2], 0.95
        choices = {a: s for a, s in self.product_aliases}
        best = difflib.get_close_matches(n, list(choices), n=1, cutoff=0.6)
        if best:
            ratio = difflib.SequenceMatcher(None, n, best[0]).ratio()
            return choices[best[0]], round(0.6 + 0.35 * ratio, 2)
        return None, 0.0

    # suppliers --------------------------------------------------------------
    def supplier(self, text: str | None) -> tuple[str | None, list[dict]]:
        if not text:
            return None, []
        t = text.lower()
        hits = []
        for s in self.c.suppliers:
            names = [s["name"].lower(), s["short_name"].lower(), *[a.lower() for a in s.get("aliases", [])]]
            best = max((len(n) for n in names if _contains_word(t, n) >= 0), default=0)
            if best:
                hits.append((best, s))
        if not hits:
            return None, []
        top = max(h[0] for h in hits)
        winners = [h[1] for h in hits if h[0] == top]
        if len(winners) == 1:
            return winners[0]["id"], []
        return None, [{"id": w["id"], "name": w["name"]} for w in winners]

    # customers (with ambiguity) ----------------------------------------------------------
    def customer(self, text: str | None) -> tuple[str | None, list[dict]]:
        if not text:
            return None, []
        t = text.lower()
        hits = []
        for c in self.c.customers:
            names = [c["name"].lower(), *[a.lower() for a in c.get("aliases", [])]]
            best = max((len(n) for n in names if _contains_word(t, n) >= 0), default=0)
            if best:
                hits.append((best, c))
        if not hits:
            return None, []
        top = max(h[0] for h in hits)
        winners = [h[1] for h in hits if h[0] == top]
        if len(winners) == 1:
            return winners[0]["id"], []
        return None, [{"id": w["id"], "name": w["name"]} for w in winners]


# ---------------------------------------------------------------------------
# Deterministic rule-based parser (Demo Mode, and fallback)
# ---------------------------------------------------------------------------

def _due_from_text(t: str) -> str | None:
    today = date.today()
    if any(w in t for w in ["kal", "tomorrow", "tmrw"]):
        return (today + timedelta(days=1)).isoformat()
    if "parso" in t or "day after" in t:
        return (today + timedelta(days=2)).isoformat()
    if "aaj" in t or "today" in t:
        return today.isoformat()
    for i, d in enumerate(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]):
        if d in t:
            delta = (i - today.weekday()) % 7 or 7
            return (today + timedelta(days=delta)).isoformat()
    return None


def _qty_for_mention(text: str, start: int, end: int) -> float | None:
    before = text[max(0, start - 30):start]
    after = text[end:end + 25]
    m = re.search(NUM + r"\s*(?:units?|pcs|pieces|nos|bottles?|packets?|boxes?|cases?|kg|x)?\s*(?:of\s*)?$", before)
    if m:
        return _num(m.group(1))
    m = re.match(r"\s*[:x×\-]?\s*" + NUM + r"(?!\s*(?:%|₹|rs|rupees?|rupaye|each|per|days?))", after)
    if m:
        return _num(m.group(1))
    return None


def parse_invoice_lines(text: str, matcher: EntityMatcher) -> list[dict]:
    lines = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"^(?P<name>[A-Za-z][A-Za-z0-9 .\-&'/()]*?)\s+(?P<qty>\d+)\s+(?:₹|rs\.?\s*)?(?P<rate>\d+(?:\.\d+)?)"
                     r"(?:\s+(?:₹|rs\.?\s*)?(?P<amt>\d[\d,]*(?:\.\d+)?))?\s*$", line, re.I)
        if not m:
            continue
        sku, conf = matcher.product_to_sku(m.group("name"))
        if not sku and m.group("name").strip().lower() in ("total", "subtotal", "grand total"):
            continue
        qty, rate, amt = _num(m.group("qty")), _num(m.group("rate")), _num(m.group("amt"))
        consistent = amt is None or abs((qty or 0) * (rate or 0) - amt) < 0.5
        lines.append({"product": m.group("name").strip(), "sku": sku, "qty": qty, "unit_price": rate,
                      "line_total": amt, "match_conf": conf, "consistent": consistent})
    return lines


def rule_parse(text: str, kind: str, matcher: EntityMatcher, sender: str | None = None) -> Understanding:
    u = Understanding(mode="demo", text=text)
    t = _norm(text)
    raw_lower = text.lower()

    m = re.search(r"(?:invoice|inv|bill)\s*(?:no\.?|number|#|:)?\s*[:#]?\s*([A-Z]{2,5}-?\d{2,6})", text, re.I)
    if m:
        u.document_no = m.group(1).upper()
    sup_id, _ = matcher.supplier(text)
    u.supplier_text = next((s["name"] for s in matcher.c.suppliers if s["id"] == sup_id), None) if sup_id else None
    credit = re.search(r"(\d+)\s*[- ]?days?\s*credit|credit\s*(?:of|:)?\s*(\d+)\s*days?", raw_lower)
    credit_days = int(credit.group(1) or credit.group(2)) if credit else None
    delivery = re.search(r"(?:deliver(?:y)?|dispatch)\D{0,20}?(\d+)\s*days?|(\d+)\s*days?\s*(?:me|mein)?\s*deliver", raw_lower)
    delivery_days = int(delivery.group(1) or delivery.group(2)) if delivery else (
        0 if re.search(r"deliver\w*\s+(?:today|aaj)", raw_lower) else None)
    moq = re.search(r"moq\s*[:\-]?\s*(\d+)|minimum\s*(?:order)?\s*(?:of)?\s*(\d+)", raw_lower)
    moq_v = int(moq.group(1) or moq.group(2)) if moq else None

    # 1) Documents with item lines: invoice / receipt / quotation
    lines = parse_invoice_lines(text, matcher)
    is_quote = kind == "quotation" or "quotation" in t or ("quote" in t and kind != "invoice")
    if lines and kind in ("invoice", "receipt", "quotation", "image", "text") and (sup_id or kind in ("invoice", "receipt", "quotation")):
        u.document_type = "quotation" if is_quote else ("receipt" if kind == "receipt" else "invoice")
        for ln in lines:
            conf = 0.97 if ln["sku"] and ln["consistent"] else (0.7 if ln["sku"] else 0.4)
            conf = min(conf, ln["match_conf"] or 0.4) if ln["match_conf"] < 0.9 else conf
            ev = ParsedEvent(type="SUPPLIER_QUOTE" if is_quote else "PURCHASE_RECEIVED",
                             items=[{k: ln[k] for k in ("product", "sku", "qty", "unit_price")}],
                             supplier_text=u.supplier_text, credit_days=credit_days, delivery_days=delivery_days,
                             moq=moq_v, confidence=conf,
                             note="" if ln["consistent"] else f"Line total {ln['line_total']} ≠ qty × rate")
            u.events.append(ev)
        return u

    # 2) Free text: message / voice / text
    u.document_type = "message"
    mentions = matcher.find_products(text)
    amount_m = re.search(RUPEE + r"\s*" + NUM + r"|" + NUM + r"\s*" + RUPEE, raw_lower)
    amount = _num(amount_m.group(1) or amount_m.group(2)) if amount_m else None
    cust_text = text if not sender else f"{sender} {text}"
    customer_mentioned = matcher.customer(cust_text)[0] is not None or bool(matcher.customer(cust_text)[1])

    has = lambda words: any(_contains_word(t, w) >= 0 for w in words)  # noqa: E731

    if has(QUOTE_WORDS) and sup_id and mentions:
        for s, e, sku in mentions[:3]:
            price_m = re.search(r"(?:₹|rs\.?\s*)\s*" + NUM + r"|" + NUM + r"\s*(?:each|per unit|/unit|rupees? each)", raw_lower)
            price = _num(price_m.group(1) or price_m.group(2)) if price_m else None
            qty = _qty_for_mention(raw_lower, s, e)
            u.events.append(ParsedEvent(type="SUPPLIER_QUOTE", supplier_text=u.supplier_text,
                                        items=[{"product": text[s:e], "sku": sku, "qty": qty, "unit_price": price}],
                                        delivery_days=delivery_days, moq=moq_v or (int(qty) if qty else None),
                                        credit_days=credit_days, confidence=0.94 if price else 0.6,
                                        note="" if price else "Unit price not found"))
        return u

    if has(DAMAGE_WORDS) and mentions:
        for s, e, sku in mentions:
            qty = _qty_for_mention(raw_lower, s, e)
            u.events.append(ParsedEvent(type="DAMAGED_STOCK", items=[{"product": text[s:e], "sku": sku, "qty": qty}],
                                        confidence=0.9 if qty else 0.55, note="" if qty else "Quantity not found"))
        return u

    if has(SALE_WORDS) and mentions:
        for s, e, sku in mentions:
            qty = _qty_for_mention(raw_lower, s, e)
            u.events.append(ParsedEvent(type="SALE", items=[{"product": text[s:e], "sku": sku, "qty": qty, "unit_price": None}],
                                        confidence=0.88 if qty else 0.55))
        return u

    if amount and has(PAY_IN_WORDS) and not mentions:
        if sup_id and has(PAY_OUT_WORDS):
            u.events.append(ParsedEvent(type="PAYMENT_MADE", supplier_text=u.supplier_text, amount=amount, confidence=0.9))
        else:
            u.events.append(ParsedEvent(type="PAYMENT_RECEIVED", customer_text=cust_text, amount=amount,
                                        confidence=0.94 if customer_mentioned else 0.5,
                                        note="" if customer_mentioned else "Payer not identified"))
        return u

    if mentions and (has(ORDER_WORDS) or kind in ("message", "voice")):
        items = []
        for s, e, sku in mentions:
            qty = _qty_for_mention(raw_lower, s, e)
            items.append({"product": text[s:e], "sku": sku, "qty": qty})
        missing_qty = any(i["qty"] is None for i in items)
        u.events.append(ParsedEvent(type="CUSTOMER_ORDER", items=items, customer_text=cust_text, due=_due_from_text(t),
                                    confidence=0.95 if not missing_qty and customer_mentioned else (0.7 if not missing_qty else 0.5),
                                    note="; ".join(filter(None, ["Quantity missing for some items" if missing_qty else "",
                                                                  "" if customer_mentioned else "Customer not identified"]))))
        # A payment in the same sentence ("Ramesh ne 3000 diye aur kal 20 Coke chahiye")
        if amount and has(PAY_IN_WORDS):
            u.events.insert(0, ParsedEvent(type="PAYMENT_RECEIVED", customer_text=cust_text, amount=amount,
                                           confidence=0.93 if customer_mentioned else 0.5))
        return u

    u.notice = "No business event recognised. Rephrase, add quantities/prices, or enter it manually."
    return u


# ---------------------------------------------------------------------------
# Gemini (live mode)
# ---------------------------------------------------------------------------

GEMINI_PROMPT = """You are the SEE layer of OFFLIMITS, a merchant intelligence system for an Indian small shop.
Read the input (it may be Hindi, English or Hinglish) and extract business events.
Use ONLY information present in the input. Do not invent quantities or prices; use null when absent.
Event types: PURCHASE_RECEIVED (supplier invoice/receipt lines), SUPPLIER_QUOTE (quotation/price offer),
CUSTOMER_ORDER (a customer wants goods), PAYMENT_RECEIVED (a customer paid us), PAYMENT_MADE (we paid a supplier),
SALE (counter sale), DAMAGED_STOCK.
Known products: {products}
Known suppliers: {suppliers}
Known customers: {customers}
Input kind: {kind}. Sender (if known): {sender}.
Return JSON exactly in this shape:
{{"transcript": string|null, "document_type": "invoice"|"quotation"|"receipt"|"message"|"other",
 "document_no": string|null, "supplier": string|null, "customer": string|null,
 "events": [{{"type": string, "items": [{{"product": string, "qty": number|null, "unit_price": number|null}}],
   "amount": number|null, "delivery_days": integer|null, "moq": integer|null, "credit_days": integer|null,
   "due": "today"|"tomorrow"|string|null, "confidence": number, "note": string}}]}}
For audio, put the verbatim transcript in "transcript". Confidence is your certainty 0..1."""


class GeminiService:
    def __init__(self, catalog: Catalog):
        self.catalog = catalog
        self.matcher = EntityMatcher(catalog)

    @property
    def live(self) -> bool:
        return settings.ai_live

    # public API (names follow the spec) -----------------------------------
    def extract_invoice(self, data: bytes | None, mime: str | None, text: str | None, kind: str = "invoice") -> Understanding:
        return self._understand(kind, data, mime, text, None)

    def extract_message(self, text: str, sender: str | None = None, kind: str = "message") -> Understanding:
        return self._understand(kind, None, None, text, sender)

    def extract_image(self, data: bytes, mime: str, ocr_text: str | None, kind: str = "image") -> Understanding:
        return self._understand(kind, data, mime, ocr_text, None)

    def summarize_voice(self, audio: bytes | None, mime: str | None, transcript: str | None, sender: str | None = None) -> Understanding:
        if transcript:
            u = self._understand("voice", None, None, transcript, sender)
            u.text = transcript
            return u
        if audio and self.live:
            return self._understand("voice", audio, mime, None, sender)
        return Understanding(mode="demo", notice="Transcription is unavailable in Demo Mode. Type the transcript, "
                             "use the browser recorder (live speech-to-text), or add GEMINI_API_KEY.")

    def explain_decision(self, facts: dict, fallback: str) -> str:
        """Explanations may use Gemini, but only restate the deterministic numbers given."""
        if not self.live:
            return fallback
        try:
            prompt = ("Rewrite this purchase recommendation for a small Indian shop owner in 2 short sentences. "
                      "Use only these facts and numbers; do not add new numbers.\n" + json.dumps(facts, default=str)
                      + "\nDraft: " + fallback)
            out = self._call_gemini([{"text": prompt}], json_mode=False)
            return out.strip() or fallback
        except Exception as exc:  # pragma: no cover - network
            log.warning("Gemini explanation failed: %s", exc)
            return fallback

    # internals ---------------------------------------------------------------
    def _understand(self, kind: str, data: bytes | None, mime: str | None, text: str | None, sender: str | None) -> Understanding:
        if self.live and (data or text):
            try:
                return self._gemini_understand(kind, data, mime, text, sender)
            except Exception as exc:  # pragma: no cover - network
                log.warning("Gemini failed, falling back to rules: %s", exc)
                if text:
                    u = rule_parse(text, kind, self.matcher, sender)
                    u.mode = "fallback"
                    u.notice = "AI SERVICE UNAVAILABLE — OFFLIMITS used Demo Mode rules for this input."
                    return u
                return Understanding(mode="fallback", notice="AI SERVICE UNAVAILABLE — OFFLIMITS has switched to Demo Mode. "
                                     "This file could not be read; enter the details manually.")
        if text:
            return rule_parse(text, kind, self.matcher, sender)
        return Understanding(mode="demo", notice="AI is not configured (Demo Mode), so this file cannot be read automatically. "
                             "Use one of the demo assets, add GEMINI_API_KEY, or enter the details manually.")

    def _call_gemini(self, parts: list[dict], json_mode: bool = True) -> str:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}:generateContent"
        body = {"contents": [{"role": "user", "parts": parts}],
                "generationConfig": {"temperature": 0, **({"responseMimeType": "application/json"} if json_mode else {})}}
        r = httpx.post(url, json=body, headers={"x-goog-api-key": settings.gemini_api_key}, timeout=45)
        r.raise_for_status()
        return r.json()["candidates"][0]["content"]["parts"][0]["text"]

    def _gemini_understand(self, kind, data, mime, text, sender) -> Understanding:
        c = self.catalog
        prompt = GEMINI_PROMPT.format(
            products=", ".join(f'{i["sku"]} {i["name"]}' for i in c.items),
            suppliers=", ".join(f'{s["short_name"]} ({s["name"]})' for s in c.suppliers),
            customers=", ".join(x["name"] for x in c.customers), kind=kind, sender=sender or "unknown")
        parts: list[dict] = [{"text": prompt}]
        if text:
            parts.append({"text": "INPUT TEXT:\n" + text})
        if data and mime:
            parts.append({"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}})
        raw = json.loads(self._call_gemini(parts))
        u = Understanding(mode="gemini", text=raw.get("transcript") or text, document_type=raw.get("document_type"),
                          document_no=raw.get("document_no"), supplier_text=raw.get("supplier"), customer_text=raw.get("customer"))
        for e in raw.get("events", []) or []:
            if e.get("type") not in EVENT_TYPES:
                continue
            items = []
            for it in e.get("items", []) or []:
                sku, mconf = self.matcher.product_to_sku(it.get("product"))
                items.append({"product": it.get("product"), "sku": sku, "qty": it.get("qty"), "unit_price": it.get("unit_price"),
                              "match_conf": mconf})
            due = e.get("due")
            if due in ("today", "tomorrow"):
                due = (date.today() + timedelta(days=1 if due == "tomorrow" else 0)).isoformat()
            conf = float(e.get("confidence") or 0.8)
            if any(i["sku"] is None for i in items):
                conf = min(conf, 0.5)
            u.events.append(ParsedEvent(type=e["type"], items=items, supplier_text=u.supplier_text,
                                        customer_text=" ".join(filter(None, [u.customer_text, sender, text])) or None,
                                        amount=e.get("amount"), delivery_days=e.get("delivery_days"), moq=e.get("moq"),
                                        credit_days=e.get("credit_days"), due=due, confidence=round(conf, 2), note=e.get("note") or ""))
        if not u.events:
            u.notice = "Gemini did not find a business event in this input."
        return u
