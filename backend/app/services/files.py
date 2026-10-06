"""Upload validation (size + magic-byte MIME check), storage and text extraction."""
from __future__ import annotations

import hashlib
import io
import json
import re
from pathlib import Path

from app.config import settings

ALLOWED = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf",
    "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
}


class UploadError(Exception):
    pass


def sniff_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data.startswith(b"%PDF"):
        return "application/pdf"
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return "audio/webm"
    if data.startswith(b"OggS"):
        return "audio/ogg"
    if data.startswith(b"ID3") or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    if data[4:8] == b"ftyp":
        return "audio/mp4"
    return None


def validate_upload(data: bytes, filename: str | None) -> str:
    if not data:
        raise UploadError("Upload failed: the file is empty.")
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise UploadError(f"File is larger than {settings.max_upload_mb:g} MB.")
    mime = sniff_mime(data)
    if mime not in ALLOWED:
        raise UploadError("Unsupported file type. Use PNG, JPG, WEBP, PDF or an audio file (webm/ogg/wav/mp3/m4a).")
    return mime


def safe_filename(name: str | None) -> str:
    name = Path(name or "upload").name
    return re.sub(r"[^A-Za-z0-9._\- ]", "_", name)[:120] or "upload"


def store(data: bytes, artifact_id: str, mime: str) -> Path:
    path = settings.upload_dir / f"{artifact_id}{ALLOWED[mime]}"
    path.write_bytes(data)
    return path


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sanitize_text(text: str | None, limit: int = 5000) -> str | None:
    if text is None:
        return None
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    text = re.sub(r"<[^>]{0,200}>", "", text)  # drop HTML tags
    return text.strip()[:limit] or None


def pdf_text(data: bytes) -> tuple[str | None, str | None, int | None]:
    """Return (text, notice, page_count). Never raises."""
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        pages = len(reader.pages)
        text = "\n".join((page.extract_text() or "") for page in reader.pages[:10]).strip()
        if not text:
            return None, "This PDF has no extractable text (it may be a scan). Add GEMINI_API_KEY to read scans, or enter details manually.", pages
        return text, None, pages
    except Exception:  # pragma: no cover - parser edge cases
        return None, "PDF text extraction failed. You can still enter the details manually.", None


def demo_fixtures() -> dict:
    path = settings.fixtures_dir / "demo_assets.json"
    if path.exists():
        return json.loads(path.read_text())
    return {}


def fixture_for(sha: str) -> dict | None:
    return demo_fixtures().get(sha)
