from __future__ import annotations

import re
from datetime import date
from pathlib import Path


def compute_save_dir(apply_root_dir: str, person: str, company: str) -> Path:
    return (
        Path(apply_root_dir)
        / sanitize_path_segment(person)
        / date.today().strftime("%Y%m%d")
        / sanitize_path_segment(company)
    )


# One shared file per person per day (not nested into a per-company subfolder like
# compute_save_dir above) - the Portal-log feature reads back a WHOLE day's worth of
# applications at once for the end-of-day batch push, so every entry needs to land in the
# same place rather than scattered across per-company folders.
def compute_person_day_dir(apply_root_dir: str, person: str) -> Path:
    return Path(apply_root_dir) / sanitize_path_segment(person) / date.today().strftime("%Y%m%d")


def sanitize_path_segment(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]', "_", value).strip()
    return cleaned or "unknown"


def strip_json_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n", "", text)
        text = re.sub(r"\n```$", "", text)
    return text.strip()
