from __future__ import annotations

from pathlib import Path


def extract_resume_file_text(path: Path) -> str:
    """Pull plain text from an uploaded resume (PDF / DOCX / plain text).

    Used by Auto Fill GPT when tailor mode is off — the model needs the actual resume
    wording for "what did you build / which tools…" questions, not just the job description.
    """
    if not path.is_file():
        raise FileNotFoundError(f"Resume file not found: {path}")
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return _extract_pdf(path)
    if suffix in {".docx", ".doc"}:
        return _extract_docx(path)
    # .txt / .md / unknown: best-effort UTF-8
    raw = path.read_bytes()
    for enc in ("utf-8", "utf-16", "cp1252", "latin-1"):
        try:
            return raw.decode(enc).strip()
        except UnicodeDecodeError:
            continue
    return ""


def _extract_pdf(path: Path) -> str:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    parts: list[str] = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        if text.strip():
            parts.append(text.strip())
    return "\n\n".join(parts).strip()


def _extract_docx(path: Path) -> str:
    from docx import Document

    doc = Document(str(path))
    parts = [p.text.strip() for p in doc.paragraphs if p.text and p.text.strip()]
    # Tables often hold skills / contact grids
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    return "\n".join(parts).strip()
