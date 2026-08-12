from __future__ import annotations

import re
import shutil
from pathlib import Path

from app.config import (
    DEFAULT_APPLY_ROOT,
    DEFAULT_PERSON,
    LEGACY_PROFILE_FILE,
    LEGACY_QA_FILE,
    LEGACY_RESUMES_DIR,
    LEGACY_RESUMES_INDEX_FILE,
    PEOPLE_DIR,
    SETTINGS_FILE,
    ensure_person_dirs,
    person_dir,
    profile_file,
    prompt_file,
    qa_file,
    read_json,
    resumes_dir,
    resumes_index_file,
    safe_person_name,
    tailor_mode_file,
    template_file,
    write_json,
)
from app.prompt import DEFAULT_INSTRUCTIONS
from app.resume_templates import DEFAULT_TEMPLATE_KEY
from app.schemas import Profile, QAEntry, ResumeEntry, Settings


def _migrate_legacy_person_data(person: str) -> None:
    """One-time migration: before multi-person support, profile/qa/resumes lived in
    flat files directly under data/. Moves (not copies) that legacy data into this
    person's own files — moving means the legacy files stop existing afterward, so a
    later call for a *different*, genuinely-new person won't also inherit them."""
    ensure_person_dirs(person)

    dest_profile = profile_file(person)
    if LEGACY_PROFILE_FILE.exists() and not dest_profile.exists():
        shutil.move(str(LEGACY_PROFILE_FILE), str(dest_profile))

    dest_qa = qa_file(person)
    if LEGACY_QA_FILE.exists() and not dest_qa.exists():
        shutil.move(str(LEGACY_QA_FILE), str(dest_qa))

    dest_resumes_index = resumes_index_file(person)
    if LEGACY_RESUMES_INDEX_FILE.exists() and not dest_resumes_index.exists():
        shutil.move(str(LEGACY_RESUMES_INDEX_FILE), str(dest_resumes_index))
        if LEGACY_RESUMES_DIR.exists():
            dest_resumes = resumes_dir(person)
            # ensure_person_dirs() above already created dest_resumes as an empty dir —
            # shutil.move would nest the legacy dir inside it rather than replacing it
            # unless that empty placeholder is removed first.
            if dest_resumes.exists() and not any(dest_resumes.iterdir()):
                dest_resumes.rmdir()
            if not dest_resumes.exists():
                shutil.move(str(LEGACY_RESUMES_DIR), str(dest_resumes))


def _migrate_legacy_prompt(person: str) -> None:
    """One-time migration: prompt_instructions used to be a single value shared by every
    person in settings.json. Copying it (not moving — settings.json keeps the key around
    harmlessly, pydantic just ignores it now) into this person's own file, once, preserves
    whatever was already customized there instead of silently resetting it to the hardcoded
    default the moment prompts became per-person. Only the person who was the previous
    single "active" one inherits it; anyone else starts from the default."""
    dest = prompt_file(person)
    if dest.exists():
        return
    raw_settings = read_json(SETTINGS_FILE)
    legacy_text = raw_settings.get("prompt_instructions") if isinstance(raw_settings, dict) else None
    if legacy_text and person == get_settings().person:
        ensure_person_dirs(person)
        write_json(dest, {"instructions": legacy_text})


def get_prompt_instructions(person: str | None = None) -> str:
    person = person or get_settings().person
    _migrate_legacy_person_data(person)
    _migrate_legacy_prompt(person)
    data = read_json(prompt_file(person))
    return data["instructions"] if data and data.get("instructions") else DEFAULT_INSTRUCTIONS


def save_prompt_instructions(instructions: str, person: str | None = None) -> None:
    person = person or get_settings().person
    ensure_person_dirs(person)
    write_json(prompt_file(person), {"instructions": instructions})


def get_resume_template(person: str | None = None) -> str:
    person = person or get_settings().person
    data = read_json(template_file(person))
    return data["template"] if data and data.get("template") else DEFAULT_TEMPLATE_KEY


def save_resume_template(template: str, person: str | None = None) -> None:
    person = person or get_settings().person
    ensure_person_dirs(person)
    write_json(template_file(person), {"template": template})


# Per-person, not global - confirmed live, different people using this same install have
# different preferences (some tailor a resume per job, some always use one uploaded resume as-
# is), so this can't be one shared flag in Settings the way it used to be.
def get_tailor_mode(person: str | None = None) -> bool:
    person = person or get_settings().person
    data = read_json(tailor_mode_file(person))
    return data["tailor_mode"] if data and "tailor_mode" in data else True


def save_tailor_mode(tailor_mode: bool, person: str | None = None) -> None:
    person = person or get_settings().person
    ensure_person_dirs(person)
    write_json(tailor_mode_file(person), {"tailor_mode": tailor_mode})


def get_profile(person: str | None = None) -> Profile:
    person = person or get_settings().person
    _migrate_legacy_person_data(person)
    data = read_json(profile_file(person))
    return Profile.model_validate(data) if data else Profile()


def save_profile(profile: Profile, person: str | None = None) -> None:
    person = person or get_settings().person
    ensure_person_dirs(person)
    write_json(profile_file(person), profile.model_dump())


def get_settings() -> Settings:
    data = read_json(SETTINGS_FILE)
    if data:
        return Settings.model_validate(data)
    return Settings(apply_root_dir=DEFAULT_APPLY_ROOT, person=DEFAULT_PERSON)


def save_settings(settings: Settings) -> None:
    write_json(SETTINGS_FILE, settings.model_dump())


# Recurring application-boilerplate questions that show up on nearly every ATS, worded
# differently company to company but asking the same thing — real, stable answers/preferences
# that belong in every person's QA bank by default rather than left blank until someone opens
# Settings and adds them by hand. Never generated by AI; these are exactly the same defaults
# the Q&A tab's "+ Add common defaults" button offers manually, just seeded automatically the
# first time a profile's QA bank is read, so a fresh profile isn't a strictly worse starting
# point than one where someone remembered to click through Settings first.
# Intentionally omitted: salary / compensation and notice / available-from.
# Those answers are form-specific (currency, monthly vs yearly, days vs date) and must be
# generated per field — never seeded or reused from a canned Q&A bank entry.
DEFAULT_QA_ENTRIES: list[dict[str, str]] = [
    {"question": "Have you ever worked at this company before?", "answer": "No"},
    {"question": "Are you currently working at this company?", "answer": "No"},
    {"question": "Are you eligible to work in this country?", "answer": "Yes"},
    {"question": "Will you now or in the future require sponsorship for this role?", "answer": "No"},
    {"question": "What is your nationality?", "answer": "Polish"},
    {"question": "What is your race or ethnicity?", "answer": "White"},
    {"question": "What is your sexual orientation?", "answer": "Straight / heterosexual"},
    {"question": "Do you identify as transgender?", "answer": "No"},
    {"question": "Do you have a disability?", "answer": "No disability"},
    {"question": "Are you a veteran?", "answer": "Not a veteran"},
    {"question": "What is your gender?", "answer": "Male"},
    {"question": "Are you Hispanic or Latino?", "answer": "No"},
    {"question": "Veteran status", "answer": "I am not a protected veteran"},
    {
        "question": "Disability status",
        "answer": "No, I do not have a disability and have not had one in the past",
    },
    {"question": "Fluency in English", "answer": "Fluent"},
    {"question": "What is your English level?", "answer": "Fluent"},
    {"question": "English Language Skill Level", "answer": "Fluent"},
    {"question": "Locations", "answer": "Europe"},
]

# Drop salary/notice entries on read/write so old seeded answers cannot keep poisoning fills.
_FORM_SPECIFIC_COMP_QA_RE = re.compile(
    r"\bsalary\b|\bcompensation\b|\bremuneration\b|"
    r"\b(?:pay|rate)\b.{0,20}\bexpect|\bdesired\s+(?:net|pay)\b|\bexpected\s+(?:pay|salary)\b|"
    r"\bmonthly\s*rate\b|\bnotice\s*period\b|when can you start|"
    r"earliest (?:start|availability)|\bavailable from\b|\bavailable to start\b",
    re.I,
)


def is_form_specific_comp_question(question: str) -> bool:
    return bool(_FORM_SPECIFIC_COMP_QA_RE.search(question or ""))


def _strip_form_specific_comp_qa(entries: list[QAEntry]) -> list[QAEntry]:
    return [e for e in entries if not is_form_specific_comp_question(e.question)]


def _merge_missing_default_qa(existing: list[QAEntry]) -> list[QAEntry]:
    """Append any new DEFAULT_QA_ENTRIES the user doesn't already have (by exact question text)."""
    have = {e.question.strip().lower() for e in existing}
    merged = list(existing)
    added = False
    for item in DEFAULT_QA_ENTRIES:
        q = item["question"].strip().lower()
        if q not in have:
            merged.append(QAEntry.model_validate(item))
            have.add(q)
            added = True
    return merged if added else existing


def get_qa(person: str | None = None) -> list[QAEntry]:
    person = person or get_settings().person
    _migrate_legacy_person_data(person)
    path = qa_file(person)
    if not path.exists():
        # Fresh profile (new or pre-existing-but-never-saved) — seed with the defaults above
        # and persist them immediately, so this only ever happens once; editing or deleting
        # any of them afterward is honored normally like any other saved QA entry.
        seeded = [QAEntry.model_validate(item) for item in DEFAULT_QA_ENTRIES]
        save_qa(seeded, person)
        return seeded
    data = read_json(path)
    if not data:
        # File exists but is empty (e.g. created before seeding logic, or cleared accidentally) —
        # treat like a fresh profile so category defaults (work auth, sponsorship, EEO, etc.)
        # are available for Auto Fill without requiring a manual Settings visit first.
        seeded = [QAEntry.model_validate(item) for item in DEFAULT_QA_ENTRIES]
        save_qa(seeded, person)
        return seeded
    entries = _strip_form_specific_comp_qa([QAEntry.model_validate(item) for item in data])
    if len(entries) != len(data):
        # Persist the purge so stale salary/notice seeds cannot keep matching forever.
        save_qa(entries, person)
    merged = _merge_missing_default_qa(entries)
    if merged is not entries:
        save_qa(merged, person)
    return merged


def save_qa(entries: list[QAEntry], person: str | None = None) -> None:
    person = person or get_settings().person
    ensure_person_dirs(person)
    entries = _strip_form_specific_comp_qa(list(entries))
    write_json(qa_file(person), [entry.model_dump() for entry in entries])


def get_resumes(person: str | None = None) -> list[ResumeEntry]:
    person = person or get_settings().person
    _migrate_legacy_person_data(person)
    data = read_json(resumes_index_file(person))
    return [ResumeEntry.model_validate(item) for item in data] if data else []


def save_resumes(entries: list[ResumeEntry], person: str | None = None) -> None:
    person = person or get_settings().person
    ensure_person_dirs(person)
    write_json(resumes_index_file(person), [entry.model_dump() for entry in entries])


def resume_file_path(resume_id: str, filename: str, person: str | None = None) -> Path:
    person = person or get_settings().person
    ensure_person_dirs(person)
    return resumes_dir(person) / f"{resume_id}{Path(filename).suffix}"


def list_people() -> list[str]:
    ensure_person_dirs(get_settings().person)  # make sure at least the active one exists/migrated
    names = [p.name for p in PEOPLE_DIR.iterdir() if p.is_dir()] if PEOPLE_DIR.exists() else []
    return sorted(names)


def create_person(name: str) -> str:
    safe = safe_person_name(name)
    ensure_person_dirs(safe)
    return safe


def delete_person(name: str) -> None:
    shutil.rmtree(person_dir(name), ignore_errors=True)
