"""Runtime configuration, read from environment variables (see .env.example)."""
from __future__ import annotations

import os
from pathlib import Path


def _load_dotenv() -> None:
    """Minimal .env loader so the backend works without python-dotenv."""
    for candidate in (Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env",
                      Path(__file__).resolve().parents[1] / ".env"):
        if candidate.exists():
            for line in candidate.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
            break


_load_dotenv()

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
DATA_DIR = Path(os.getenv("OFFLIMITS_DATA_DIR", REPO_DIR / "data"))


class Settings:
    database_url: str = os.getenv("DATABASE_URL", f"sqlite:///{BACKEND_DIR / 'offlimits.db'}")
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "").strip()
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    sarvam_api_key: str = os.getenv("SARVAM_API_KEY", "").strip()
    confidence_threshold: float = float(os.getenv("CONFIDENCE_THRESHOLD", "0.75"))
    max_upload_mb: float = float(os.getenv("MAX_UPLOAD_MB", "10"))
    upload_dir: Path = Path(os.getenv("UPLOAD_DIR", BACKEND_DIR / "uploads"))
    frontend_origins: list[str] = [o.strip() for o in os.getenv(
        "FRONTEND_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()]
    force_demo_mode: bool = os.getenv("DEMO_MODE", "auto").lower() in ("1", "true", "yes", "on")
    demo_dir: Path = DATA_DIR / "demo"
    fixtures_dir: Path = DATA_DIR / "fixtures"

    @property
    def ai_live(self) -> bool:
        return bool(self.gemini_api_key) and not self.force_demo_mode


settings = Settings()
settings.upload_dir.mkdir(parents=True, exist_ok=True)
