"""ORM models.

Quantities (stock, cash, receivables, prices) are NOT stored on these rows: they are
derived from the append-only ``BusinessEvent`` ledger by ``app.engines.state``.
Master data (items, suppliers, customers) and workflow records (proposals,
recommendations, approvals, purchase orders) live in their own tables.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Merchant(Base):
    __tablename__ = "merchants"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    owner: Mapped[str] = mapped_column(String(120))
    city: Mapped[str] = mapped_column(String(80), default="")
    currency: Mapped[str] = mapped_column(String(8), default="INR")
    settings: Mapped[dict] = mapped_column(JSON, default=dict)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=True)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"))
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(40), default="owner")


class InventoryItem(Base):
    __tablename__ = "inventory_items"
    sku: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(40))
    unit: Mapped[str] = mapped_column(String(20), default="unit")
    selling_price: Mapped[float] = mapped_column(Float)
    reorder_point: Mapped[int] = mapped_column(Integer, default=10)
    daily_demand: Mapped[float] = mapped_column(Float, default=1.0)
    aliases: Mapped[list] = mapped_column(JSON, default=list)


class Supplier(Base):
    __tablename__ = "suppliers"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    short_name: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(120))
    reliability: Mapped[float] = mapped_column(Float, default=0.9)
    city: Mapped[str] = mapped_column(String(80), default="")
    aliases: Mapped[list] = mapped_column(JSON, default=list)


class Customer(Base):
    __tablename__ = "customers"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(40), default="retail")
    aliases: Mapped[list] = mapped_column(JSON, default=list)


class InputArtifact(Base):
    __tablename__ = "input_artifacts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))  # invoice/message/voice/image/receipt/quotation/text
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mime: Mapped[str | None] = mapped_column(String(80), nullable=True)
    size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    path: Mapped[str | None] = mapped_column(String(400), nullable=True)
    text_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    sender: Mapped[str | None] = mapped_column(String(120), nullable=True)
    analysis_mode: Mapped[str] = mapped_column(String(20), default="demo")  # demo / gemini / fallback
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    transcription: Mapped[str | None] = mapped_column(String(32), nullable=True)  # BROWSER / GEMINI / DEMO TRANSCRIPTION
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProposedEvent(Base):
    """An AI interpretation awaiting confirmation. Never mutates state by itself."""
    __tablename__ = "proposed_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    artifact_id: Mapped[str] = mapped_column(ForeignKey("input_artifacts.id"))
    type: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    summary: Mapped[str] = mapped_column(String(300), default="")
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(20), default="PROPOSED")  # PROPOSED/NEEDS_REVIEW/CONFIRMED/REJECTED
    review_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    candidates: Mapped[list] = mapped_column(JSON, default=list)
    event_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class BusinessEvent(Base):
    """Append-only ledger. Business state is a projection of these rows."""
    __tablename__ = "business_events"
    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    category: Mapped[str] = mapped_column(String(20))  # OPENING/SOURCE/EVENT/INTELLIGENCE/DECISION/APPROVAL/ACTION/CORRECTION
    type: Mapped[str] = mapped_column(String(40), index=True)
    source_type: Mapped[str] = mapped_column(String(20), default="system")
    source_ref: Mapped[str | None] = mapped_column(String(120), nullable=True)
    actor: Mapped[str] = mapped_column(String(120), default="system")
    entity: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    change: Mapped[str] = mapped_column(String(200), default="")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="CONFIRMED")
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    prev_state: Mapped[dict] = mapped_column(JSON, default=dict)
    new_state: Mapped[dict] = mapped_column(JSON, default=dict)
    artifact_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    approval_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    caused_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    dedupe_key: Mapped[str | None] = mapped_column(String(200), nullable=True, unique=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=True)


class Order(Base):
    __tablename__ = "orders"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    customer_id: Mapped[str] = mapped_column(ForeignKey("customers.id"))
    items: Mapped[list] = mapped_column(JSON, default=list)  # [{sku, qty, unit_price}]
    value: Mapped[float] = mapped_column(Float, default=0)
    due: Mapped[str] = mapped_column(String(40), default="")
    status: Mapped[str] = mapped_column(String(20), default="OPEN")
    created_event_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    fulfilled_event_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Recommendation(Base):
    __tablename__ = "recommendations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    kind: Mapped[str] = mapped_column(String(30), default="PURCHASE")
    risk_key: Mapped[str] = mapped_column(String(80), index=True)
    sku: Mapped[str] = mapped_column(String(32))
    supplier_id: Mapped[str] = mapped_column(String(32))
    qty: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[float] = mapped_column(Float)
    total: Mapped[float] = mapped_column(Float)
    reason: Mapped[str] = mapped_column(Text, default="")
    explanation: Mapped[str] = mapped_column(Text, default="")
    comparison: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="PENDING")
    trigger_event_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    decision_event_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    po_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decided_by: Mapped[str | None] = mapped_column(String(120), nullable=True)


class Approval(Base):
    __tablename__ = "approvals"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    recommendation_id: Mapped[str | None] = mapped_column(ForeignKey("recommendations.id"), nullable=True)
    actor: Mapped[str] = mapped_column(String(120))
    decision: Mapped[str] = mapped_column(String(20))  # APPROVED / REJECTED
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    supplier_id: Mapped[str] = mapped_column(ForeignKey("suppliers.id"))
    sku: Mapped[str] = mapped_column(ForeignKey("inventory_items.sku"))
    qty: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[float] = mapped_column(Float)
    total: Mapped[float] = mapped_column(Float)
    credit_days: Mapped[int] = mapped_column(Integer, default=0)
    delivery_days: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="APPROVED")  # APPROVED / RECEIVED
    recommendation_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    approval_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    event_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    received_event_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Scenario(Base):
    __tablename__ = "scenarios"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    question: Mapped[str | None] = mapped_column(Text, nullable=True)
    inputs: Mapped[dict] = mapped_column(JSON, default=dict)
    results: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Counter(Base):
    """Simple named sequences for human-readable IDs (EVT-1001, OFF-2026-091 …)."""
    __tablename__ = "counters"
    name: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, default=0)
