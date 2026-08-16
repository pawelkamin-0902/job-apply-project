from __future__ import annotations

import re

from app.schemas import ContactInfo, EducationEntry, Profile, ResumeData, ResumeEducationEntry, ResumeExperienceEntry

_TITLE_SPLIT_RE = re.compile(r"\s*\|\s*")
_COMPANY_LOCATION_SPLIT_RE = re.compile(r"\s[–—-]\s")


def normalize_resume(raw: dict, profile: Profile) -> ResumeData:
    """Accept either the canonical ResumeData shape or common variants
    (combined 'title | company - location | dates' strings, 'details' instead
    of 'bullets', missing name/contact_line/education) and coerce to ResumeData,
    filling gaps from the stored profile where possible."""
    if not isinstance(raw, dict):
        raise ValueError("resume JSON must be an object")

    return ResumeData(
        name=raw.get("name") or profile.contact.name or "",
        contact_line=_repair_contact_line(raw.get("contact_line"), profile.contact),
        summary=_normalize_summary(raw.get("summary", "")),
        skills=_normalize_skills(raw.get("skills", {})),
        experience=[_normalize_experience(e) for e in raw.get("experience", [])],
        education=_normalize_education(raw.get("education"), profile.education),
    )


def _normalize_summary(summary: object) -> str:
    """Summary is one flowing paragraph — collapse any newlines the model may insert
    between sentences so PDF/DOCX/HTML don't render each sentence on its own line."""
    if not isinstance(summary, str):
        return ""
    text = _EMBEDDED_NEWLINE_RE.sub(" ", summary).strip()
    return _WHITESPACE_RUN_RE.sub(" ", text)


def _build_contact_line(contact: ContactInfo) -> str:
    parts = [contact.phone, contact.email, contact.location, contact.linkedin, contact.website]
    parts = [p for p in parts if p and not _is_telegram_segment(p)]
    return " | ".join(_linkify_contact_segment(p) for p in parts)


_EMBEDDED_NEWLINE_RE = re.compile(r"\s*[\r\n]+\s*")
_WHITESPACE_RUN_RE = re.compile(r" {2,}")
_ALREADY_LINKED_RE = re.compile(r"^\[([^\]]+)\]\(([^)]+)\)$")
_EMAIL_SEGMENT_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_PHONE_SEGMENT_RE = re.compile(r"^\+?[\d\s().-]{7,}$")
# Resumes commonly write links without a scheme or "www." at all ("linkedin.com/in/x",
# "github.com/pawel") - requiring one (as an earlier version of this pattern did) missed
# exactly that shape, confirmed live with a plain "github.com/pawel" segment never getting
# linkified at all. Matches an optional scheme/www prefix, then any domain-shaped
# "word.tld" followed by an optional "/path", spanning the whole segment (no spaces).
_URL_SEGMENT_RE = re.compile(r"^(https?://|www\.)?[\w.-]+\.[a-zA-Z]{2,}(/\S*)?$")
_TELEGRAM_HINT_RE = re.compile(r"(?:^|://|www\.)?(?:t\.me/|telegram\.(?:me|org)/?|telegram)", re.I)


def _is_telegram_segment(segment: str) -> bool:
    """True for Telegram handles/URLs — resumes should not surface messaging-app links."""
    segment = (segment or "").strip()
    if not segment:
        return False
    already = _ALREADY_LINKED_RE.match(segment)
    if already:
        label, url = already.group(1), already.group(2)
        return bool(_TELEGRAM_HINT_RE.search(label) or _TELEGRAM_HINT_RE.search(url))
    return bool(_TELEGRAM_HINT_RE.search(segment))


def _linkify_contact_segment(segment: str) -> str:
    """Converts a plain phone/email/URL segment into the "[visible text](url)" markdown-link
    format the elegant PDF/DOCX templates' per-item icon logic depends on to tell a phone
    number apart from an email/LinkedIn/other link (see pdf_render_elegant.py's
    _icon_for_url) — confirmed live, a real generated contact_line used plain text for every
    segment despite prompt.py's schema instructing markdown links explicitly, so every single
    item fell through to the same fallback (location) icon instead of its own. Leaves a
    segment that's already correctly linked, or one that doesn't look like a phone/email/URL
    at all (assumed to be the location, which is meant to stay plain text), untouched.
    LinkedIn URLs always use the visible label "LinkedIn" (href keeps the real profile URL)."""
    segment = segment.strip()
    if not segment:
        return segment
    already = _ALREADY_LINKED_RE.match(segment)
    if already:
        label, url = already.group(1), already.group(2)
        if "linkedin.com" in url.lower() and label.lower() != "linkedin":
            return f"[LinkedIn]({url})"
        return segment
    if _EMAIL_SEGMENT_RE.match(segment):
        return f"[{segment}](mailto:{segment})"
    if _PHONE_SEGMENT_RE.match(segment) and any(ch.isdigit() for ch in segment):
        return f"[{segment}](tel:{segment})"
    if _URL_SEGMENT_RE.match(segment):
        href = segment if segment.lower().startswith("http") else f"https://{segment}"
        label = "LinkedIn" if "linkedin.com" in href.lower() else segment
        return f"[{label}]({href})"
    return segment


def _repair_contact_line(raw_contact_line: str | None, contact: ContactInfo) -> str:
    """A generated contact_line goes through here regardless of which provider produced it
    (Claude, Ollama, manual-paste GPT, or the auto-GPT-tab mode) — this is the one place that
    applies to all of them, since every path eventually calls /render.

    Three things confirmed live, all from real generated contact_lines: (1) stray embedded
    newlines mid-string ("+48573503853\\n | ...\\n | Warsaw | ...\\n") — a contact line must
    render as one line, never with an internal break, regardless of why the model inserted
    one. (2) The country silently missing ("Warsaw" instead of "Warsaw, Poland") even though
    the profile's own country was sitting right there, unused — a model correctly combining
    city + country isn't guaranteed even when it usually gets it right, and this is exactly
    the kind of already-known fact that shouldn't depend on generation succeeding, the same
    principle behind every STRUCTURED_PATTERNS entry in the extension itself. (3) Every
    segment left as plain text instead of the markdown-link format the schema explicitly asks
    for, which made every item in the rendered PDF show the same fallback icon (see
    _linkify_contact_segment above) — same "don't just trust the model got the format right"
    principle as the other two."""
    if not raw_contact_line:
        return _build_contact_line(contact)

    cleaned = _EMBEDDED_NEWLINE_RE.sub(" ", raw_contact_line).strip()
    segments = [_WHITESPACE_RUN_RE.sub(" ", s.strip()) for s in cleaned.split("|")]
    segments = [s for s in segments if s and not _is_telegram_segment(s)]

    country = (contact.country or "").strip()
    if country and not any(country.lower() in s.lower() for s in segments):
        city = (contact.city or "").strip()
        city_idx = next((i for i, s in enumerate(segments) if city and city.lower() in s.lower()), None)
        if city_idx is not None:
            segments[city_idx] = f"{segments[city_idx]}, {country}"
        else:
            segments.append(country)

    linked = [_linkify_contact_segment(s) for s in segments]
    return " | ".join(s for s in linked if not _is_telegram_segment(s))


def _normalize_skills(skills: object) -> dict[str, list[str]]:
    if isinstance(skills, dict):
        return {str(category): [str(s) for s in items] for category, items in skills.items()}
    if isinstance(skills, list):
        return {"Skills": [str(s) for s in skills]}
    return {}


def _normalize_experience(entry: object) -> ResumeExperienceEntry:
    if not isinstance(entry, dict):
        raise ValueError(f"experience entry must be an object, got {entry!r}")

    bullets = entry.get("bullets")
    if bullets is None:
        bullets = entry.get("details", [])

    if "company" in entry and "dates" in entry:
        return ResumeExperienceEntry(
            title=entry.get("title", ""),
            company=entry["company"],
            location=entry.get("location"),
            dates=entry["dates"],
            bullets=list(bullets),
        )

    parts = _TITLE_SPLIT_RE.split(entry.get("title", ""))
    title = parts[0].strip() if parts else ""
    company, location, dates = "", None, ""

    if len(parts) > 1:
        company_location = _COMPANY_LOCATION_SPLIT_RE.split(parts[1].strip(), maxsplit=1)
        company = company_location[0].strip()
        if len(company_location) > 1:
            location = company_location[1].strip()
    if len(parts) > 2:
        dates = parts[2].strip()

    return ResumeExperienceEntry(title=title, company=company, location=location, dates=dates, bullets=list(bullets))


def _normalize_education(
    raw_education: object, profile_education: list[EducationEntry]
) -> list[ResumeEducationEntry]:
    if isinstance(raw_education, list) and raw_education:
        return [
            ResumeEducationEntry(
                school=e.get("school") or e.get("university") or e.get("institution") or "",
                degree=e.get("degree") or e.get("degree_name") or "",
                location=e.get("location") or e.get("country") or "",
                dates=e.get("dates") or _join_dates(e.get("start_date"), e.get("end_date")),
            )
            for e in raw_education
        ]

    return [
        ResumeEducationEntry(
            school=e.school,
            degree=e.degree,
            location=e.location,
            dates=_join_dates(e.start_date, e.end_date),
        )
        for e in profile_education
    ]


def _join_dates(start: str | None, end: str | None) -> str | None:
    if not start and not end:
        return None
    return f"{start or ''} - {end or ''}".strip(" -")
