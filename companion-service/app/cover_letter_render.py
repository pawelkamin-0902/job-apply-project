from __future__ import annotations

import re
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Preformatted, SimpleDocTemplate


def normalize_cover_letter_text(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t).strip()
    t = re.sub(r"\*\*(.*?)\*\*", r"\1", t)
    t = re.sub(r"__(.*?)__", r"\1", t)
    t = re.sub(r"^#+\s*", "", t, flags=re.MULTILINE)
    return t.strip()


def build_plain_pdf(text: str, out_path: Path) -> None:
    doc = SimpleDocTemplate(
        str(out_path),
        pagesize=letter,
        leftMargin=72,
        rightMargin=72,
        topMargin=72,
        bottomMargin=72,
    )
    style = ParagraphStyle("PlainCover", fontName="Helvetica", fontSize=11, leading=14)
    doc.build([Preformatted(text, style)])
