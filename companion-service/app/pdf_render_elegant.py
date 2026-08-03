from __future__ import annotations

import re
import xml.sax.saxutils as saxutils
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Flowable, HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.pdf_text import render_markdown_text
from app.schemas import ResumeData

# Real embedded icon glyphs (Font Awesome Free, SIL OFL 1.1 - see app/fonts/FONT_AWESOME_LICENSE.txt),
# matching the shared LaTeX template's \faPhone/\faEnvelope/\faMapMarker/\faLinkedin exactly. PDF
# embeds the font directly in the file, so these render correctly on any machine regardless of
# what's installed locally - unlike DOCX, which can only reference a font by name (see docx_render_elegant.py).
_FONTS_DIR = Path(__file__).resolve().parent / "fonts"
pdfmetrics.registerFont(TTFont("FASolid", str(_FONTS_DIR / "fa-solid-900.ttf")))
pdfmetrics.registerFont(TTFont("FABrands", str(_FONTS_DIR / "fa-brands-400.ttf")))

_ICON_PHONE = ""
_ICON_ENVELOPE = ""
_ICON_LOCATION = ""
_ICON_LINKEDIN = ""  # "linkedin-in" - the plain square "in" mark, not the FA "linkedin" glyph
_ICON_LINK = ""  # generic chain-link icon, fallback for website/portfolio links

_CONTACT_ITEM_RE = re.compile(r"^\[([^\]]+)\]\(([^)]+)\)$")

# Matches the shared LaTeX template's \definecolor lines exactly (accentTitle/accentText
# reuse the same green as the "classic" PDF template; accentLine is new to this template).
ACCENT_GREEN = HexColor("#0E6E55")
ACCENT_GOLD = HexColor("#A16F0B")
TEXT_COLOR = HexColor("#1A1A1A")
MARGIN = 0.5 * inch
TOP_BOTTOM_MARGIN = 0.4 * inch
USABLE_WIDTH = letter[0] - 2 * MARGIN

# reportlab has no built-in Cormorant Garamond/Charter (the LaTeX source's fonts) - embedding
# them would mean sourcing and bundling font files with their own licensing to track, for a
# purely cosmetic difference. Times-Roman is a PDF base-14 font (always available, zero setup)
# that lands in the same "elegant serif resume" territory without that dependency.
NAME_STYLE = ParagraphStyle(
    "Name", fontName="Times-Roman", fontSize=26, leading=30, textColor=ACCENT_GREEN, alignment=TA_CENTER, spaceAfter=6
)
CONTACT_STYLE = ParagraphStyle("Contact", fontName="Times-Roman", fontSize=9, textColor=TEXT_COLOR, alignment=TA_CENTER)
HEADING_STYLE = ParagraphStyle(
    "Heading", fontName="Times-Bold", fontSize=12.5, textColor=ACCENT_GREEN, spaceBefore=10, spaceAfter=3
)
BODY_STYLE = ParagraphStyle("Body", fontName="Times-Roman", fontSize=10.5, textColor=TEXT_COLOR, leading=14)
ITALIC_STYLE = ParagraphStyle("Italic", fontName="Times-Italic", fontSize=10.5, textColor=TEXT_COLOR, spaceAfter=4)
BULLET_STYLE = ParagraphStyle(
    "Bullet",
    fontName="Times-Roman",
    fontSize=10.5,
    textColor=TEXT_COLOR,
    leading=14,
    leftIndent=16,
    bulletIndent=2,
    spaceAfter=2,
)
SKILL_LABEL_STYLE = ParagraphStyle("SkillLabel", fontName="Times-Roman", fontSize=10.5, textColor=TEXT_COLOR, leading=14, spaceAfter=3)
HEADING_RIGHT_STYLE = ParagraphStyle("HeadingRight", fontName="Times-Bold", fontSize=10.5, textColor=TEXT_COLOR, alignment=TA_RIGHT)
HEADING_LEFT_STYLE = ParagraphStyle("HeadingLeft", fontName="Times-Bold", fontSize=10.5, textColor=TEXT_COLOR)


def _render_text(text: str) -> str:
    return render_markdown_text(text, link_color="#0E6E55")


def _icon_for_url(url: str) -> str:
    low = url.lower()
    if low.startswith("tel:"):
        return _ICON_PHONE
    if low.startswith("mailto:"):
        return _ICON_ENVELOPE
    if "linkedin.com" in low:
        return _ICON_LINKEDIN
    return _ICON_LINK


def _render_contact_line(contact_line: str) -> str:
    """contact_line is "[text](url) | [text](url) | plain text | ..." (see prompt.py's
    schema contract). Each item gets a real Font Awesome icon in front of it, matching the
    shared LaTeX template's \\faPhone/\\faEnvelope/\\faMapMarker/\\faLinkedin - a link's icon
    is picked from its URL scheme/domain; a plain (non-link) item is assumed to be the
    location and gets the map-marker icon."""
    rendered_items = []
    for raw_item in contact_line.split("|"):
        item = raw_item.strip()
        if not item:
            continue
        match = _CONTACT_ITEM_RE.match(item)
        if match:
            label, url = match.group(1), match.group(2)
            icon = _icon_for_url(url)
            font_name = "FABrands" if icon == _ICON_LINKEDIN else "FASolid"
            link_html = (
                f'<font name="{font_name}">{icon}</font>&#160;'
                f'<a href="{saxutils.escape(url)}" color="#0E6E55">{saxutils.escape(label)}</a>'
            )
        else:
            link_html = f'<font name="FASolid">{_ICON_LOCATION}</font>&#160;{saxutils.escape(item)}'
        rendered_items.append(link_html)
    return " &#160;|&#160; ".join(rendered_items)


def _gold_rule() -> Flowable:
    return HRFlowable(width="100%", thickness=0.75, color=ACCENT_GOLD, spaceBefore=2, spaceAfter=6)


def _heading_with_dates_table(left_text: str, right_text: str) -> Table:
    """Bold "title/school ... dates" row - the first of the two heading lines this
    template uses per job/education entry (the second, italic line carries
    company/location instead, with no date on it - see _italic_subheading)."""
    left = Paragraph(saxutils.escape(left_text), HEADING_LEFT_STYLE)
    right = Paragraph(saxutils.escape(right_text), HEADING_RIGHT_STYLE)
    table = Table([[left, right]], colWidths=[USABLE_WIDTH * 0.7, USABLE_WIDTH * 0.3])
    table.hAlign = "LEFT"
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
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
    story.append(_gold_rule())
    story.append(Paragraph(_render_contact_line(resume.contact_line), CONTACT_STYLE))
    story.append(_gold_rule())

    story.append(Paragraph("Summary", HEADING_STYLE))
    story.append(_gold_rule())
    story.append(Paragraph(_render_text(resume.summary), BODY_STYLE))

    story.append(Paragraph("Technical Skills", HEADING_STYLE))
    story.append(_gold_rule())
    for category, items in resume.skills.items():
        items_text = ", ".join(saxutils.escape(item) for item in items)
        story.append(Paragraph(f"<b>{saxutils.escape(category)}:</b> {items_text}", SKILL_LABEL_STYLE))

    story.append(Paragraph("Experience", HEADING_STYLE))
    story.append(_gold_rule())
    for job in resume.experience:
        story.append(_heading_with_dates_table(job.title, job.dates))
        subheading = f"{job.company}, {job.location}" if job.location else job.company
        story.append(Paragraph(saxutils.escape(subheading), ITALIC_STYLE))
        for bullet in job.bullets:
            # En dash bullets, matching \renewcommand\labelitemi{--} in the shared template -
            # this template's one deliberate visual departure from the round "•" bullets
            # the "classic" template (pdf_render.py) uses.
            story.append(Paragraph(_render_text(bullet), BULLET_STYLE, bulletText="–"))

    story.append(Paragraph("Education", HEADING_STYLE))
    story.append(_gold_rule())
    for edu in resume.education:
        story.append(_heading_with_dates_table(edu.school, edu.dates or ""))
        subheading = f"{edu.degree}, {edu.location}" if edu.location else edu.degree
        if subheading:
            story.append(Paragraph(saxutils.escape(subheading), ITALIC_STYLE))

    doc.build(story)
