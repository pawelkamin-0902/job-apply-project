from __future__ import annotations

import re
import xml.sax.saxutils as saxutils

_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def render_markdown_text(text: str, link_color: str) -> str:
    """Escape XML-significant characters (reportlab Paragraphs parse their input as
    markup, so a literal "&" or "<" in real content would otherwise break rendering),
    then convert the LLM's markdown-style **bold** spans and [text](url) links into
    reportlab's <b> and <a href="..."> tags. Shared by every PDF template so a fix here
    (or a new markdown construct) doesn't need to be duplicated per template."""
    escaped = saxutils.escape(text)
    escaped = _LINK_RE.sub(rf'<a href="\2" color="{link_color}">\1</a>', escaped)
    return _BOLD_RE.sub(r"<b>\1</b>", escaped)
