from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from app import docx_render, docx_render_elegant, pdf_render, pdf_render_elegant
from app.schemas import ResumeData

BuildFn = Callable[[ResumeData, Path], None]


@dataclass(frozen=True)
class ResumeTemplateInfo:
    key: str
    name: str
    description: str
    build_pdf: BuildFn
    build_docx: BuildFn


# Single source of truth for what templates exist: main.py's /render dispatches through
# this registry, and /resume-templates exposes name/description straight from here too, so
# adding a new template is "write build_pdf/build_docx, add one entry here" - nothing else
# has to change to make it selectable and previewable.
TEMPLATES: dict[str, ResumeTemplateInfo] = {
    "modern": ResumeTemplateInfo(
        key="modern",
        name="Modern",
        description="Clean sans-serif with a single green accent color, round bullets, one-line job headings.",
        build_pdf=pdf_render.build_pdf,
        build_docx=docx_render.build_docx,
    ),
    "elegant": ResumeTemplateInfo(
        key="elegant",
        name="Elegant Serif",
        description="Serif font with green + gold two-tone accents, en-dash bullets, two-line job headings.",
        build_pdf=pdf_render_elegant.build_pdf,
        build_docx=docx_render_elegant.build_docx,
    ),
}

DEFAULT_TEMPLATE_KEY = "modern"


def get_template(key: str) -> ResumeTemplateInfo:
    return TEMPLATES.get(key, TEMPLATES[DEFAULT_TEMPLATE_KEY])


def list_templates() -> list[ResumeTemplateInfo]:
    return list(TEMPLATES.values())
