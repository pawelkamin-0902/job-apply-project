from __future__ import annotations

import xml.sax.saxutils as saxutils
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import (
    Flowable,
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER

from app.pdf_text import render_markdown_text
from app.schemas import ResumeData

ACCENT_COLOR = HexColor("#0E6E55")
TEXT_COLOR = HexColor("#1A1A1A")
MARGIN = 0.5 * inch
TOP_BOTTOM_MARGIN = 0.4 * inch
USABLE_WIDTH = letter[0] - 2 * MARGIN

NAME_STYLE = ParagraphStyle(
    "Name", fontName="Helvetica-Bold", fontSize=22, leading=28, textColor=ACCENT_COLOR, alignment=TA_CENTER, spaceAfter=8
)
CONTACT_STYLE = ParagraphStyle("Contact", fontName="Helvetica", fontSize=9.5, textColor=TEXT_COLOR, alignment=TA_CENTER)
HEADING_STYLE = ParagraphStyle(
    "Heading", fontName="Helvetica-Bold", fontSize=12, textColor=ACCENT_COLOR, spaceBefore=10, spaceAfter=4
)
BODY_STYLE = ParagraphStyle("Body", fontName="Helvetica", fontSize=10.5, textColor=TEXT_COLOR, leading=14)
ITALIC_STYLE = ParagraphStyle("Italic", fontName="Helvetica-Oblique", fontSize=10.5, textColor=TEXT_COLOR, spaceAfter=2)
BULLET_STYLE = ParagraphStyle(
    "Bullet", fontName="Helvetica", fontSize=10.5, textColor=TEXT_COLOR, leading=14, leftIndent=16, bulletIndent=4, spaceAfter=2
)
SKILL_LABEL_STYLE = ParagraphStyle(
    "SkillLabel", fontName="Helvetica", fontSize=10.5, textColor=TEXT_COLOR, leading=14, spaceAfter=2
)


def _render_text(text: str) -> str:
    return render_markdown_text(text, link_color="#0E6E55")


def _rule() -> Flowable:
    return HRFlowable(width="100%", thickness=1, color=ACCENT_COLOR, spaceBefore=2, spaceAfter=6)


def _heading_with_dates_table(left_text: str, right_text: str) -> Table:
    left = Paragraph(f"<b>{saxutils.escape(left_text)}</b>", BODY_STYLE)
    right_style = ParagraphStyle("Right", parent=BODY_STYLE, alignment=2)
    right = Paragraph(saxutils.escape(right_text), right_style)
    table = Table([[left, right]], colWidths=[USABLE_WIDTH * 0.7, USABLE_WIDTH * 0.3])
    table.hAlign = "LEFT"
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    return table


def build_pdf(resume: ResumeData, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(out_path),
        pagesize=letter,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=TOP_BOTTOM_MARGIN,
        bottomMargin=TOP_BOTTOM_MARGIN,
        title=resume.name,
    )

    story: list[Flowable] = []
    story.append(Paragraph(saxutils.escape(resume.name), NAME_STYLE))
    story.append(Paragraph(_render_text(resume.contact_line), CONTACT_STYLE))
    story.append(Spacer(1, 4))
    story.append(_rule())

    story.append(Paragraph("SUMMARY", HEADING_STYLE))
    story.append(_rule())
    story.append(Paragraph(_render_text(resume.summary), BODY_STYLE))

    story.append(Paragraph("SKILLS", HEADING_STYLE))
    story.append(_rule())
    for category, items in resume.skills.items():
        items_text = ", ".join(saxutils.escape(item) for item in items)
        story.append(Paragraph(f"<b>{saxutils.escape(category)}:</b> {items_text}", SKILL_LABEL_STYLE))

    story.append(Paragraph("EXPERIENCE", HEADING_STYLE))
    story.append(_rule())
    for job in resume.experience:
        story.append(_heading_with_dates_table(f"{job.title} — {job.company}", job.dates))
        if job.location:
            story.append(Paragraph(saxutils.escape(job.location), ITALIC_STYLE))
        for bullet in job.bullets:
            # Use reportlab's real bullet mechanism (bulletText) instead of prepending a
            # literal "•" character — that made leftIndent/bulletIndent inert, so wrapped
            # lines had no proper hanging indent and aligned inconsistently.
            story.append(Paragraph(_render_text(bullet), BULLET_STYLE, bulletText="•"))

    story.append(Paragraph("EDUCATION", HEADING_STYLE))
    story.append(_rule())
    for edu in resume.education:
        edu_heading = f"{edu.school} — {edu.degree}" if edu.degree else edu.school
        story.append(_heading_with_dates_table(edu_heading, edu.dates or ""))
        if edu.location:
            story.append(Paragraph(saxutils.escape(edu.location), ITALIC_STYLE))

    doc.build(story)
