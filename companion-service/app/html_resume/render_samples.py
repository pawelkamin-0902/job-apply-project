#!/usr/bin/env python3
"""Render Modern + Elegant HTML samples and PDFs (HTML→Chromium) from sample_resume.json.

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

from app.html_resume import build_pdf, write_html  # noqa: E402
from app.schemas import ResumeData  # noqa: E402

SAMPLES = Path(__file__).resolve().parent / "samples"


def main() -> None:
    data = json.loads((SAMPLES / "sample_resume.json").read_text(encoding="utf-8"))
    resume = ResumeData.model_validate(data)

    modern_html = write_html(resume, SAMPLES / "modern.html", "modern")
    elegant_html = write_html(resume, SAMPLES / "elegant.html", "elegant")
    build_pdf(resume, SAMPLES / "modern.pdf", "modern")
    build_pdf(resume, SAMPLES / "elegant.pdf", "elegant")

    print("Wrote:")
    for p in (modern_html, elegant_html, SAMPLES / "modern.pdf", SAMPLES / "elegant.pdf"):
        print(f"  {p}")


if __name__ == "__main__":
    main()
