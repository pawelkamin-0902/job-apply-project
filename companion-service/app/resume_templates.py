from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from app import docx_render, docx_render_elegant
from app.html_resume import DEFAULT_TEMPLATE_KEY, build_pdf as html_build_pdf, list_html_templates
from app.schemas import ResumeData

BuildFn = Callable[[ResumeData, Path], None]


@dataclass(frozen=True)
class ResumeTemplateInfo:
    key: str
    name: str
    description: str
    build_pdf: BuildFn
    build_docx: BuildFn


# DOCX still uses the two legacy builders until/unless we add HTML→DOCX. PDF is always
# the shared HTML→Chromium path — adding a style is `{key}.html` + catalog.json entry.
_DOCX_BUILDERS: dict[str, BuildFn] = {
    "modern": docx_render.build_docx,
    "elegant": docx_render_elegant.build_docx,
}


def _pdf_builder(key: str) -> BuildFn:
    def _build(resume: ResumeData, out_path: Path) -> None:
        html_build_pdf(resume, out_path, template_key=key)

    return _build


def _docx_builder(key: str) -> BuildFn:
    legacy = _DOCX_BUILDERS.get(key) or _DOCX_BUILDERS["modern"]

    def _build(resume: ResumeData, out_path: Path) -> None:
        legacy(resume, out_path)

    return _build


def list_templates() -> list[ResumeTemplateInfo]:
    return [
        ResumeTemplateInfo(
            key=t.key,
            name=t.name,
            description=t.description,
            build_pdf=_pdf_builder(t.key),
            build_docx=_docx_builder(t.key),
        )
        for t in list_html_templates()
    ]


def get_template(key: str) -> ResumeTemplateInfo:
    templates = {t.key: t for t in list_templates()}
    if key in templates:
        return templates[key]
    return templates.get(DEFAULT_TEMPLATE_KEY) or next(iter(templates.values()))
