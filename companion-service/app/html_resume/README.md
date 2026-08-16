# HTML resume templates → PDF

**Goal:** PDF is always made from HTML. New styles are new HTML files — not a new
Python Platypus renderer per style.

## Add a template

1. Copy `modern.html` (or `elegant.html`) to `{key}.html` and edit CSS/markup.
2. Add an entry to `catalog.json`:

```json
"compact": {
  "name": "Compact",
  "description": "Tighter spacing, single accent color.",
  "contact": "plain"
}
```

`contact` is `"plain"` (linked text only) or `"icons"` (SVG icons like Elegant).

3. Restart the companion service. It shows up in `/resume-templates` and `/render`
   uses the shared HTML→Chromium PDF path — no new `pdf_render_*.py`.

## Preview

```bash
cd companion-service
./venv/bin/python -m app.html_resume.render_samples
```

Opens under `samples/`: filled `modern.html` / `elegant.html` and matching `*.pdf`.

## What still uses Python builders

- **PDF:** `html_resume.build_pdf` only (Playwright Chromium print).
- **DOCX:** temporary legacy `docx_render.py` / `docx_render_elegant.py` for the two
  existing styles. New HTML-only styles reuse the Modern DOCX builder until HTML→DOCX
  exists. The old `pdf_render.py` / `pdf_render_elegant.py` are unused by `/render`.
