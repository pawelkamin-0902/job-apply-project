"""HTML resume templates → one shared PDF pipeline.

Add a new style by dropping ``{key}.html`` here and an entry in ``catalog.json``.
No per-template Python Platypus/DOCX builder is required for PDF output.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

from app.schemas import ResumeData

_DIR = Path(__file__).resolve().parent
_CATALOG_PATH = _DIR / "catalog.json"
_CONTACT_ITEM_RE = re.compile(r"^\[([^\]]+)\]\(([^)]+)\)$")
_MD_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")

DEFAULT_TEMPLATE_KEY = "modern"


@dataclass(frozen=True)
class HtmlTemplateInfo:
    key: str
    name: str
    description: str
    contact: str  # "plain" | "icons"
    link_labels: str  # "short" (Elegant: "LinkedIn") | "url" (Modern: full profile URL)
    accent: str  # CSS color for markdown links in summary/bullets
    html_path: Path


def _load_catalog() -> dict[str, dict]:
    if not _CATALOG_PATH.exists():
        return {}
    return json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))


def list_html_templates() -> list[HtmlTemplateInfo]:
    """Every ``*.html`` in this package dir (not samples/) that is listed in catalog.json,
    or any html whose stem has a catalog entry. Catalog is the selectable set; the html
    file must exist."""
    catalog = _load_catalog()
    out: list[HtmlTemplateInfo] = []
    for key, meta in catalog.items():
        path = _DIR / f"{key}.html"
        if not path.is_file():
            continue
        accent = str(meta.get("accent") or "#0E6E55").strip() or "#0E6E55"
        out.append(
            HtmlTemplateInfo(
                key=key,
                name=str(meta.get("name") or key.replace("_", " ").title()),
                description=str(meta.get("description") or ""),
                contact="icons" if meta.get("contact") == "icons" else "plain",
                link_labels="short" if meta.get("link_labels") == "short" else "url",
                accent=accent,
                html_path=path,
            )
        )
    return out


def get_html_template(key: str) -> HtmlTemplateInfo:
    templates = {t.key: t for t in list_html_templates()}
    if key in templates:
        return templates[key]
    if DEFAULT_TEMPLATE_KEY in templates:
        return templates[DEFAULT_TEMPLATE_KEY]
    if templates:
        return next(iter(templates.values()))
    raise FileNotFoundError(f"No HTML resume templates found under {_DIR}")


def _md_to_html(text: str, *, link_color: str = "#0E6E55") -> str:
    if not text:
        return ""
    out = html.escape(text)
    out = _MD_BOLD_RE.sub(r"<strong>\1</strong>", out)
    out = _MD_LINK_RE.sub(
        lambda m: f'<a href="{html.escape(m.group(2), quote=True)}" style="color:{link_color}">{m.group(1)}</a>',
        out,
    )
    out = out.replace("\n", "<br>\n")
    return out


def _display_url(url: str) -> str:
    """Full link text for Modern: keep the path visible, drop the scheme only."""
    text = (url or "").strip()
    if text.lower().startswith("https://"):
        return text[8:]
    if text.lower().startswith("http://"):
        return text[7:]
    return text


def _link_label(label: str, url: str, *, link_labels: str = "url") -> str:
    """Visible text for a contact link.

    - Elegant (``link_labels="short"``): LinkedIn URLs show as "LinkedIn".
    - Modern (``link_labels="url"``): show the full profile URL (scheme stripped).
    """
    if "linkedin.com" in (url or "").lower():
        if link_labels == "short":
            return "LinkedIn"
        return _display_url(url) or label
    if link_labels == "url" and label.strip().lower() in {"linkedin", "portfolio", "github", "website"}:
        return _display_url(url) or label
    return label


def _contact_plain(contact_line: str, *, link_labels: str = "url") -> str:
    parts: list[str] = []
    for raw in contact_line.split("|"):
        item = raw.strip()
        if not item:
            continue
        m = _CONTACT_ITEM_RE.match(item)
        if m:
            label, url = m.group(1), m.group(2)
            parts.append(
                f'<a href="{html.escape(url, quote=True)}">'
                f"{html.escape(_link_label(label, url, link_labels=link_labels))}</a>"
            )
        else:
            parts.append(html.escape(item))
    return " | ".join(parts)


def _svg_icon(path_d: str, view_box: str = "0 0 512 512") -> str:
    return (
        f'<svg class="icon" viewBox="{view_box}" aria-hidden="true">'
        f'<path fill="currentColor" d="{path_d}"/></svg>'
    )


def _contact_icons(contact_line: str, *, link_labels: str = "short") -> str:
    icons = {
        "phone": _svg_icon(
            "M164.9 24.6c-7.7-18.6-28-28.5-47.4-23.2l-88 24C12.1 30.2 0 46 0 64C0 311.4 "
            "200.6 512 448 512c18 0 33.8-12.1 38.6-29.5l24-88c5.3-19.4-4.6-39.7-23.2-47.4l-96-40"
            "c-16.3-6.8-35.2-2.1-46.3 11.6L304.7 368C234.3 334.7 177.3 277.7 144 207.3l41.9-55.9"
            "c13.7-11.1 18.4-30 11.6-46.3l-40-96z"
        ),
        "envelope": _svg_icon(
            "M48 64C21.5 64 0 85.5 0 112c0 15.1 7.1 29.3 19.2 40.1L236.8 313.6c11.4 8.5 27 8.5 "
            "38.4 0L492.8 152.1c12.1-10.8 19.2-25 19.2-40.1c0-26.5-21.5-48-48-48H48zM0 176V384c0 "
            "35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V176L294.4 339.2c-22.8 17.1-54 17.1-76.8 "
            "0L0 176z"
        ),
        "location": _svg_icon(
            "M215.7 499.2C267 435 384 279.4 384 192C384 86 298 0 192 0S0 86 0 192c0 87.4 117 "
            "243 168.3 307.2c12.3 15.3 35.1 15.3 47.4 0zM192 128a64 64 0 1 1 0 128 64 64 0 1 1 "
            "0-128z",
            "0 0 384 512",
        ),
        "linkedin": _svg_icon(
            "M100.3 448H7.4V148.9h92.9zM53.8 108.1C24.1 108.1 0 83.5 0 53.8a53.8 53.8 0 0 1 "
            "107.6 0c0 29.7-24.1 54.3-53.8 54.3zM447.9 448h-92.7V302.4c0-34.7-.7-79.2-48.3-79.2"
            "-48.3 0-55.7 37.7-55.7 76.7V448h-92.8V148.9h89.1v40.8h1.3c12.4-23.5 42.7-48.3 "
            "87.9-48.3 94 0 111.3 61.9 111.3 142.3V448z",
            "0 0 448 512",
        ),
        "link": _svg_icon(
            "M579.8 267.7c56.5-56.5 56.5-148 0-204.5c-50-50-128.8-56.5-186.3-15.4l-1.6 1.1c-14.4 "
            "10.3-17.7 30.3-7.4 44.6s30.3 17.7 44.6 7.4l1.6-1.1c32.1-22.9 76-19.3 103.8 8.6c31.5 "
            "31.5 31.5 82.5 0 114L422.3 334.8c-31.5 31.5-82.5 31.5-114 0c-27.9-27.9-31.5-71.8-8.6"
            "-103.8l1.1-1.6c10.3-14.4 6.9-34.4-7.4-44.6s-34.4-6.9-44.6 7.4l-1.1 1.6C189.4 238.9 "
            "196 317.8 246 367.8c56.5 56.5 148 56.5 204.5 0L579.8 267.7z",
            "0 0 640 512",
        ),
    }
    parts: list[str] = []
    for raw in contact_line.split("|"):
        item = raw.strip()
        if not item:
            continue
        m = _CONTACT_ITEM_RE.match(item)
        if m:
            label, url = m.group(1), m.group(2)
            low = url.lower()
            if low.startswith("tel:"):
                icon = icons["phone"]
            elif low.startswith("mailto:"):
                icon = icons["envelope"]
            elif "linkedin.com" in low:
                icon = icons["linkedin"]
            else:
                icon = icons["link"]
            parts.append(
                f'{icon}<a href="{html.escape(url, quote=True)}">'
                f"{html.escape(_link_label(label, url, link_labels=link_labels))}</a>"
            )
        else:
            parts.append(f'{icons["location"]}{html.escape(item)}')
    return '<span class="sep">|</span>'.join(parts)


def _env(*, link_color: str = "#0E6E55") -> Environment:
    env = Environment(
        loader=FileSystemLoader(str(_DIR)),
        autoescape=select_autoescape(["html", "xml"]),
    )
    env.filters["md"] = lambda s: Markup(_md_to_html(str(s or ""), link_color=link_color))
    return env


def build_html(resume: ResumeData, template_key: str = DEFAULT_TEMPLATE_KEY) -> str:
    info = get_html_template(template_key)
    tpl = _env(link_color=info.accent).get_template(info.html_path.name)
    if info.contact == "icons":
        contact_html = _contact_icons(resume.contact_line, link_labels=info.link_labels)
    else:
        contact_html = _contact_plain(resume.contact_line, link_labels=info.link_labels)
    return tpl.render(
        name=resume.name,
        contact_line_html=Markup(contact_html),
        summary_html=Markup(_md_to_html(resume.summary, link_color=info.accent)),
        skills=resume.skills,
        experience=resume.experience,
        education=resume.education,
    )


def write_html(resume: ResumeData, out_path: Path, template_key: str = DEFAULT_TEMPLATE_KEY) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(build_html(resume, template_key), encoding="utf-8")
    return out_path


def build_pdf(resume: ResumeData, out_path: Path, template_key: str = DEFAULT_TEMPLATE_KEY) -> None:
    """One shared path for every template: Jinja HTML → Chromium print-to-PDF.

    Playwright's Sync API cannot run on a thread that already has an asyncio event loop
    (FastAPI handlers). When called from async context, we offload to a worker thread.
    CLI / scripts with no running loop use Sync API directly on the calling thread.
    """
    import asyncio
    import concurrent.futures

    from playwright.sync_api import sync_playwright

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    html_doc = build_html(resume, template_key)

    def _render() -> None:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            try:
                page = browser.new_page()
                page.set_content(html_doc, wait_until="load")
                # Margins come from the template's @page rule; chrome margins stay 0 so we
                # don't double-pad. preferCSSPageSize honors `size: letter` in @page.
                page.pdf(
                    path=str(out_path),
                    print_background=True,
                    prefer_css_page_size=True,
                    margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
                )
            finally:
                browser.close()

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        _render()
        return

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(_render).result()
