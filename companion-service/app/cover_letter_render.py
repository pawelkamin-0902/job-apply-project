from __future__ import annotations

import re
from pathlib import Path
from xml.sax.saxutils import escape

from docx import Document
from docx.shared import Pt
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


def normalize_cover_letter_text(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t).strip()
    t = re.sub(r"\*\*(.*?)\*\*", r"\1", t)
    t = re.sub(r"__(.*?)__", r"\1", t)
    t = re.sub(r"^#+\s*", "", t, flags=re.MULTILINE)
    return t.strip()


def build_plain_docx(text: str, out_path: Path) -> None:
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.font.bold = False
    for line in text.splitlines():
        p = doc.add_paragraph(line.rstrip())
        p.style = "Normal"
        for run in p.runs:
            run.bold = False
            run.italic = False
    doc.save(str(out_path))


def _cover_paragraphs(text: str) -> list[str]:
    """Split letter into paragraphs. Blank lines separate blocks; single newlines
    inside a block become spaces so ReportLab can wrap like Word."""
    blocks: list[str] = []
    buf: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.rstrip()
        if not line.strip():
            if buf:
                blocks.append(" ".join(buf))
                buf = []
            continue
        buf.append(line.strip())
    if buf:
        blocks.append(" ".join(buf))
    return blocks or [""]


def build_plain_pdf(text: str, out_path: Path) -> None:
    # Preformatted kept long lines unwrapped and clipped (cover_letter.pdf vs correct
    # cover_letter.docx). Use Paragraph so text wraps within margins like Word.
    doc = SimpleDocTemplate(
        str(out_path),
        pagesize=letter,
        leftMargin=72,
        rightMargin=72,
        topMargin=72,
        bottomMargin=72,
    )
    style = ParagraphStyle(
        "PlainCover",
        fontName="Helvetica",
        fontSize=11,
        leading=15,
        spaceAfter=0,
    )
    story = []
    paras = _cover_paragraphs(text)
    for i, para in enumerate(paras):
        story.append(Paragraph(escape(para), style))
        if i < len(paras) - 1:
            story.append(Spacer(1, 10))
    doc.build(story)
