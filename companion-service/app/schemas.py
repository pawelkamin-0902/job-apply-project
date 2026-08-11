from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class ContactInfo(BaseModel):
    name: str = ""
    email: str = ""
    phone: str | None = None
    location: str | None = None  # combined display string for the resume ("Warsaw, Poland (Remote)")
    linkedin: str | None = None
    website: str | None = None
    # Separate from `location` above: some application forms ask for street address, city,
    # postal code, and country as distinct fields rather than one combined location string —
    # confirmed live, a form filled "Address" with the same value as "City" because both were
    # matched to the same `location` field, which is wrong once a form actually separates them.
    street_address: str | None = None
    city: str | None = None
    postal_code: str | None = None
    country: str | None = None
    # Not wired into automatic structured-matching in sidepanel.js on purpose — unlike the
    # fields above, "State" questions sometimes carry form-specific conditions a profile value
    # can't know about (e.g. "select N/A unless you live in the US or Australia"). Left for the
    # QA bank to handle per-form instead, since Learn captures the actually-correct answer for
    # that specific form's wording rather than a single blind value reused everywhere.
    state: str | None = None


class ExperienceEntry(BaseModel):
    title: str
    company: str
    location: str | None = None
    start_date: str
    end_date: str
    bullets: list[str] = []


class EducationEntry(BaseModel):
    school: str
    degree: str
    location: str | None = None
    start_date: str | None = None
    end_date: str | None = None


class Profile(BaseModel):
    contact: ContactInfo = ContactInfo()
    summary: str = ""
    experience: list[ExperienceEntry] = []
    education: list[EducationEntry] = []
    skills: list[str] = []


class QAEntry(BaseModel):
    question: str
    answer: str


class PromptInstructions(BaseModel):
    instructions: str


class ResumeTemplateChoice(BaseModel):
    template: str


# Per-person, not global (see store.get_tailor_mode/save_tailor_mode) - different people using
# this same install have different preferences (tailor a resume per job vs. always use one
# uploaded resume as-is), so this can't be one shared flag in Settings the way it used to be.
class TailorModeChoice(BaseModel):
    tailor_mode: bool


class ResumeTemplateOption(BaseModel):
    key: str
    name: str
    description: str


class Settings(BaseModel):
    apply_root_dir: str
    person: str
    claude_model: str | None = None
    timeout_seconds: float = 120.0
    # "claude"/"ollama" call a model automatically from /generate. "gpt" is manual —
    # there's no OpenAI API integration; the extension copies the prompt for you to
    # paste into ChatGPT yourself, then paste its JSON reply back in. "gpt-auto" is also
    # not a real API integration (still no API key involved) — the extension drives a real,
    # visible chatgpt.com tab itself (types the prompt, submits it, reads the reply, closes
    # the tab), so /generate is never actually called for it either; it's handled entirely
    # client-side, same as "gpt".
    # Defaults to "claude" — resume tailoring is the highest-stakes generation task (a
    # fabricated employer/role/date is the worst-case failure), and Claude is the only
    # provider that's held up to the truth-grounding requirements in testing so far; a small
    # local Ollama model has fabricated an entire fake job history here before, twice.
    provider: Literal["claude", "ollama", "gpt", "gpt-auto", "gpt-auto-headless"] = "claude"
    # Separate provider for per-question Auto Fill answer generation (/generate-answer) —
    # deliberately independent of `provider` above. This task is lower-stakes by design:
    # consequential fields (salary/visa/sponsorship/...), anything matching a structured
    # profile category, and anything needing a discrete pick (selects, groups, comboboxes)
    # are already excluded from generation entirely in sidepanel.js regardless of provider,
    # so what's left is short free-text answers ("why do you want to work here") where a
    # fast, free, local model is a reasonable default and Claude is overkill.
    answer_provider: Literal["claude", "ollama", "gpt", "gpt-auto", "gpt-auto-headless"] = "ollama"
    ollama_model: str = "qwen2.5:3b-instruct"
    ollama_base_url: str = "http://localhost:11434"
    # "gpt-auto" deletes the ChatGPT conversation it just created once it has the answer, so
    # automated resume/answer generation doesn't pile up in the user's real chat history (see
    # tryDeleteConversation in sidepanel.js). That's the right default, but it also means the
    # actual prompt/response is gone the moment something looks wrong with the result - there's
    # no way to go back and inspect what was actually sent/received. Unchecking this keeps the
    # conversation around (the user cleans it up manually) specifically for that debugging case.
    delete_gpt_conversations: bool = True
    # Just the host/IP of the company-internal bid-tracking Portal (an AppGini-generated app
    # with no API and no CSV import - the "Sync to Portal" feature drives its own web UI
    # directly, same as the GPT-tab automation drives chatgpt.com) - e.g. "http://172.20.1.135",
    # NOT including the "/mgr/..." app path, which every page URL adds on its own. Left blank
    # by default since this is a private, deployment-specific address, not something with a
    # sensible universal default.
    portal_base_url: str = ""
    # Used by app/portal_automation.py's own out-of-band Playwright browser - it has no session
    # of its own on first run, so it logs in itself using these the first time, then reuses that
    # same persisted session (portal_automation.BROWSER_PROFILE_DIR) on every run after.
    portal_username: str = ""
    portal_password: str = ""
    # Explicitly requested: sync failures are hard to diagnose with a fully invisible browser -
    # unchecking this lets the user watch the real Playwright window drive the Portal directly to
    # see what's actually going wrong, the same way portal_automation.HEADLESS was manually
    # flipped during development. True (headless) is the normal, unattended default.
    portal_headless: bool = True


class GenerateRequest(BaseModel):
    company: str
    job_description: str
    job_url: str | None = None


class ResumeExperienceEntry(BaseModel):
    title: str
    company: str
    location: str | None = None
    dates: str
    bullets: list[str]


class ResumeEducationEntry(BaseModel):
    school: str
    degree: str
    location: str | None = None
    dates: str | None = None


class ResumeData(BaseModel):
    name: str
    contact_line: str
    summary: str
    skills: dict[str, list[str]]
    experience: list[ResumeExperienceEntry]
    education: list[ResumeEducationEntry]


class GenerateResponse(BaseModel):
    resume: ResumeData
    session_id: str | None = None
    total_cost_usd: float | None = None
    usage: dict[str, int] | None = None
    saved_dir: str


class RenderRequest(BaseModel):
    resume: dict
    company: str
    saved_dir: str | None = None


class RenderResponse(BaseModel):
    docx_path: str
    pdf_path: str
    saved_dir: str
    pdf_base64: str | None = None


class PromptPreview(BaseModel):
    system_prompt: str
    user_message: str
    # Only set by /prompt-preview (resume generation) - /answer-prompt-preview has no
    # per-company folder concept, so it leaves this unset rather than saving anything.
    saved_dir: str | None = None


class ProviderTestResult(BaseModel):
    ok: bool
    detail: str


class ProviderTestRequest(BaseModel):
    """Tests whatever's currently in the settings form, not necessarily what's
    saved yet — lets you check a provider before committing to it."""

    provider: Literal["claude", "ollama", "gpt", "gpt-auto", "gpt-auto-headless"]
    claude_model: str | None = None
    ollama_model: str = "qwen2.5:3b-instruct"
    ollama_base_url: str = "http://localhost:11434"


class AnswerRequest(BaseModel):
    question: str
    job_description: str = ""
    company: str = ""
    # When set, this is a dropdown/select pick: the model must choose one of these exact option
    # labels (never free-text outside the list). Used by Auto Fill for required <select>s.
    options: list[str] | None = None
    # Optional tailored resume JSON from the side panel (tailor mode). When present, answer
    # prompts use it as extra grounded context alongside the saved profile.
    resume: dict | None = None


class AnswerResponse(BaseModel):
    # answerable=False means the profile genuinely doesn't contain enough to answer this
    # question (e.g. a specific province/state or a desired-pay figure never provided) — the
    # model is instructed to say so via this flag rather than writing a "sorry, I don't have
    # enough information" sentence as if it were the answer, which would otherwise get written
    # straight into the real form field. answer is None in that case; the extension leaves the
    # field for the applicant instead of filling it with either one.
    answerable: bool = True
    answer: str | None = None
    session_id: str | None = None
    total_cost_usd: float | None = None
    usage: dict[str, int] | None = None


class BatchAnswerPromptRequest(BaseModel):
    questions: list[str]
    job_description: str = ""
    company: str = ""
    # Parallel to questions: when an entry is a non-empty list, that question is a select/dropdown
    # pick and the model must choose one of those option labels. null/omitted = free-text answer.
    options_per_question: list[list[str] | None] | None = None
    # Parallel to questions/options: True = checkbox multi-select ("select all that apply");
    # answer may be several OPTIONS joined by ", ". Confirmed needed for Zoho Recruit
    # screening checkboxes (technologies / design patterns).
    multi_per_question: list[bool] | None = None
    resume: dict | None = None


class BatchAnswerPromptResponse(BaseModel):
    system_prompt: str
    user_message: str


class MatchAnswersRequest(BaseModel):
    questions: list[str]


class MatchedAnswer(BaseModel):
    question: str
    matched: bool
    answer: str | None = None
    # The QA-bank entry's own original question text, when matched — lets the extension run its
    # own plausibility check (word-overlap/category match) on the pairing before trusting it.
    # Added after a small local model reproducibly matched unrelated questions (e.g. "What is
    # your notice period?" -> a saved "Are you a veteran?" answer) with no way for the client to
    # independently sanity-check the pairing, since only the answer text came back before.
    matched_question: str | None = None


class MatchAnswersResponse(BaseModel):
    results: list[MatchedAnswer]


class ResumeEntry(BaseModel):
    id: str
    filename: str
    stack: str
    uploaded_at: str


class CreatePersonRequest(BaseModel):
    name: str


class SampleFieldCapture(BaseModel):
    label: str
    type: str
    source: Literal["profile", "learned", "unmatched"]
    value: str | None = None


class SampleFrameCapture(BaseModel):
    frame_id: int
    url: str
    html: str
    fields: list[SampleFieldCapture]


class SaveSampleRequest(BaseModel):
    page_url: str
    frames: list[SampleFrameCapture]


class SaveSampleResponse(BaseModel):
    ok: bool
    saved: list[str]


# Logged locally (one JSON line per application, in a shared per-person/per-day file - see
# compute_person_day_dir) so a separate end-of-day browser-automation pass can read a whole
# day's applications back and push them into a company-internal Portal that has no API and no
# CSV import - only its own web UI, browser-automatable like any ATS. `resume_stack` is the
# free-text tech-stack string already associated with the resume actually used ("Full" for a
# tailored bid, or the fixed non-tailor resume's own saved `stack` field otherwise) - matched
# against the Portal's own per-profile Resume dropdown options at push time, not here, since
# that list only exists live on the Portal page itself.
class PortalLogEntry(BaseModel):
    platform: str
    company: str
    job_title: str
    url: str
    tailor: bool
    resume_stack: str
    description: str


class PortalLogResponse(BaseModel):
    ok: bool
    path: str
    index: int


# `index` is this entry's position within today's file - the only stable handle the sync
# automation has for later marking it synced, since the file itself has no other id per line.
class PortalLogListEntry(PortalLogEntry):
    index: int
    timestamp: str
    synced: bool


class PortalLogListResponse(BaseModel):
    entries: list[PortalLogListEntry]


class MarkPortalLogSyncedRequest(BaseModel):
    indices: list[int]


class MarkPortalLogSyncedResponse(BaseModel):
    ok: bool
    marked: int


class ChatGptPromptRequest(BaseModel):
    prompt: str
    delete_conversation: bool = True


class ChatGptPromptResponse(BaseModel):
    ok: bool
    text: str = ""
    deleted: bool = False
    error: str = ""
