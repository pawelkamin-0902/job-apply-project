#!/usr/bin/env python3
"""Render every catalog HTML template (+ PDF) from sample_resume.json.

Usage (from companion-service/):
  ./venv/bin/python -m app.html_resume.render_samples
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.html_resume import build_pdf, list_html_templates, write_html  # noqa: E402
from app.schemas import ResumeData  # noqa: E402

SAMPLES = Path(__file__).resolve().parent / "samples"


def main() -> None:
    data = json.loads((SAMPLES / "sample_resume.json").read_text(encoding="utf-8"))
    resume = ResumeData.model_validate(data)
    templates = list_html_templates()
    if not templates:
        raise SystemExit("No HTML templates in catalog.json")

    written: list[Path] = []
    for t in templates:
        html_path = write_html(resume, SAMPLES / f"{t.key}.html", t.key)
        pdf_path = SAMPLES / f"{t.key}.pdf"
        build_pdf(resume, pdf_path, t.key)
        written.extend((html_path, pdf_path))

    print("Wrote:")
    for p in written:
        print(f"  {p}")


if __name__ == "__main__":
    main()
