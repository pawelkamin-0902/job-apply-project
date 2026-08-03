import json
import secrets
from pathlib import Path

APP_DIR = Path.home() / ".job-apply-project"
DATA_DIR = APP_DIR / "data"
SECRET_FILE = APP_DIR / "secret.token"

PORT = 3939
CLAUDE_CLI_PATH = "claude"
DEFAULT_TIMEOUT_SECONDS = 120
DEFAULT_APPLY_ROOT = str(Path.home() / "apply")
DEFAULT_PERSON = "me"

# Legacy flat-file locations from before multi-person support — only read now, to
# migrate an existing single-person install's data into people/<name>/ on first access.
LEGACY_PROFILE_FILE = DATA_DIR / "profile.json"
LEGACY_QA_FILE = DATA_DIR / "qa.json"
LEGACY_RESUMES_DIR = DATA_DIR / "resumes"
LEGACY_RESUMES_INDEX_FILE = DATA_DIR / "resumes.json"

SETTINGS_FILE = DATA_DIR / "settings.json"
PEOPLE_DIR = DATA_DIR / "people"


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PEOPLE_DIR.mkdir(parents=True, exist_ok=True)


def safe_person_name(person: str) -> str:
    safe = "".join(c for c in person if c.isalnum() or c in " -_").strip()
    return safe or DEFAULT_PERSON


def person_dir(person: str) -> Path:
    return PEOPLE_DIR / safe_person_name(person)


def profile_file(person: str) -> Path:
    return person_dir(person) / "profile.json"


def qa_file(person: str) -> Path:
    return person_dir(person) / "qa.json"


def prompt_file(person: str) -> Path:
    return person_dir(person) / "prompt.json"


def template_file(person: str) -> Path:
    return person_dir(person) / "template.json"


def tailor_mode_file(person: str) -> Path:
    return person_dir(person) / "tailor_mode.json"


def resumes_dir(person: str) -> Path:
    return person_dir(person) / "resumes"


def resumes_index_file(person: str) -> Path:
    return person_dir(person) / "resumes.json"


def ensure_person_dirs(person: str) -> None:
    ensure_dirs()
    resumes_dir(person).mkdir(parents=True, exist_ok=True)


def get_or_create_secret_token() -> str:
    ensure_dirs()
    if SECRET_FILE.exists():
        return SECRET_FILE.read_text(encoding="utf-8").strip()
    token = secrets.token_hex(32)
    SECRET_FILE.write_text(token, encoding="utf-8")
    return token


def read_json(path: Path) -> dict | list | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict | list) -> None:
    # Explicit encoding matters here — write_text()/read_text() default to the platform's
    # preferred encoding, which on Windows is usually a codepage like cp1252, not UTF-8. Any
    # accented name, non-English QA answer, or "→"-style character in saved profile/settings/
    # QA data would raise UnicodeEncodeError under that default (seen live: a UnicodeEncodeError
    # from a similar unencoded write elsewhere crashed /generate on Windows).
    ensure_dirs()
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
