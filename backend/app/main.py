"""OFFLIMITS — Merchant Intelligence Loop API (FastAPI)."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.config import settings
from app.db.session import SessionLocal
from app.services.seed import ensure_seeded

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

@asynccontextmanager
async def lifespan(_: FastAPI):
    db = SessionLocal()
    try:
        ensure_seeded(db)
    finally:
        db.close()
    yield


app = FastAPI(lifespan=lifespan, title="OFFLIMITS — Merchant Intelligence Loop", version="1.0.0",
              description="SEE → THINK → ACT → UPDATED STATE. PS21 · FinTech & Commerce. All seeded data is DEMO DATA.")
app.add_middleware(CORSMiddleware, allow_origins=settings.frontend_origins, allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(router)


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):  # pragma: no cover - safety net
    logging.getLogger("offlimits").exception("Unhandled error on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": ["Internal error — the ledger was not changed."]})


@app.get("/")
def root():
    return {"name": "OFFLIMITS API", "docs": "/docs", "health": "/api/health"}
