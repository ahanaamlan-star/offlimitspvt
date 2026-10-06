import os
import sys
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="offlimits-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["UPLOAD_DIR"] = f"{_tmp}/uploads"
os.environ["GEMINI_API_KEY"] = ""          # tests always run in Demo Mode
os.environ["DEMO_MODE"] = "true"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.services.seed import reset_database, seed  # noqa: E402

DEMO = Path(__file__).resolve().parents[2] / "data" / "demo"


@pytest.fixture()
def client():
    db = SessionLocal()
    reset_database(db)
    fresh = SessionLocal()
    seed(fresh)
    fresh.close()
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def db():
    s = SessionLocal()
    yield s
    s.close()


def upload(client, path: Path, kind: str):
    with open(path, "rb") as fh:
        return client.post("/api/inputs/analyze", data={"kind": kind}, files={"file": (path.name, fh)})


def analyze_text(client, text: str, kind="message", sender=""):
    return client.post("/api/inputs/analyze", data={"kind": kind, "text": text, "sender": sender})


def confirm_all(client, proposals):
    out = []
    for p in proposals:
        r = client.post(f"/api/proposals/{p['id']}/confirm", json={})
        assert r.status_code == 200, r.text
        out.append(r.json())
    return out
