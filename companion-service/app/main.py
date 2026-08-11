from __future__ import annotations

import base64
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from app.claude_cli import ClaudeCodeCliError, check_claude_cli, run_claude_code_print, usage_from_cli_payload
from app.ollama_cli import OllamaCliError, check_ollama, run_ollama_chat
from app.prompt import (
    build_answer_system_prompt,
    build_answer_user_message,
    build_batch_answer_system_prompt,
    build_batch_answer_user_message,
    build_match_answer_system_prompt,
    build_match_answer_user_message,
    build_select_pick_system_prompt,
    build_select_pick_user_message,
    build_system_prompt,
    build_user_message,
)
from app import resume_templates
from app.chatgpt_automation import submit_chatgpt_prompt
from app.portal_automation import sync_portal_entry
from app.resume_normalize import normalize_resume
from app.schemas import (
    AnswerRequest,
    AnswerResponse,
    BatchAnswerPromptRequest,
    BatchAnswerPromptResponse,
    ChatGptPromptRequest,
    ChatGptPromptResponse,
    CreatePersonRequest,
    GenerateRequest,
    GenerateResponse,
    MarkPortalLogSyncedRequest,
    MarkPortalLogSyncedResponse,
    MatchAnswersRequest,
    MatchAnswersResponse,
    MatchedAnswer,
    PortalLogEntry,
    PortalLogListEntry,
    PortalLogListResponse,
    PortalLogResponse,
    Profile,
    PromptInstructions,
    PromptPreview,
    ProviderTestRequest,
    ProviderTestResult,
    QAEntry,
    RenderRequest,
    RenderResponse,
    ResumeData,
    ResumeEntry,
    ResumeTemplateChoice,
    ResumeTemplateOption,
    SaveSampleRequest,
    SaveSampleResponse,
    Settings,
    TailorModeChoice,
)
from app.security import get_active_person, verify_token
from app import store
from app.utils import compute_person_day_dir, compute_save_dir, strip_json_fences

# Lives alongside the manually-curated fixtures in extension/test-forms/ rather than the
# ~/.job-apply-project app-data dir, so real captures build up in the same place (and get
# synced/shared the same way) as the hand-pasted ATS samples used to design detection logic.
CAPTURED_SAMPLES_DIR = Path(__file__).resolve().parents[2] / "extension" / "test-forms" / "captured"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Without this, an unexpected bug returns a bare empty-body 500 - the extension's
    error message ends up as just "500 " with nothing to go on. This guarantees every
    failure, expected or not, comes back with an actual message to show the user."""
    return JSONResponse(status_code=500, content={"detail": f"Unexpected server error: {exc}"})


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/people", response_model=list[str], dependencies=[Depends(verify_token)])
async def list_people() -> list[str]:
    return store.list_people()


@app.post("/people", response_model=str, dependencies=[Depends(verify_token)])
async def create_person(body: CreatePersonRequest) -> str:
    return store.create_person(body.name)


@app.delete("/people/{name}", dependencies=[Depends(verify_token)])
async def delete_person(name: str) -> dict:
    store.delete_person(name)
    return {"deleted": name}


@app.get("/profile", response_model=Profile, dependencies=[Depends(verify_token)])
async def get_profile(active_person: str = Depends(get_active_person)) -> Profile:
    return store.get_profile(active_person)


@app.put("/profile", response_model=Profile, dependencies=[Depends(verify_token)])
async def put_profile(profile: Profile, active_person: str = Depends(get_active_person)) -> Profile:
    store.save_profile(profile, active_person)
    return profile


@app.get("/settings", response_model=Settings, dependencies=[Depends(verify_token)])
async def get_settings() -> Settings:
    return store.get_settings()


@app.put("/settings", response_model=Settings, dependencies=[Depends(verify_token)])
async def put_settings(settings: Settings) -> Settings:
    store.save_settings(settings)
    return settings


@app.get("/qa", response_model=list[QAEntry], dependencies=[Depends(verify_token)])
async def get_qa(active_person: str = Depends(get_active_person)) -> list[QAEntry]:
    return store.get_qa(active_person)


@app.put("/qa", response_model=list[QAEntry], dependencies=[Depends(verify_token)])
async def put_qa(entries: list[QAEntry], active_person: str = Depends(get_active_person)) -> list[QAEntry]:
    store.save_qa(entries, active_person)
    return entries


@app.get("/prompt-instructions", response_model=PromptInstructions, dependencies=[Depends(verify_token)])
async def get_prompt_instructions(active_person: str = Depends(get_active_person)) -> PromptInstructions:
    return PromptInstructions(instructions=store.get_prompt_instructions(active_person))


@app.put("/prompt-instructions", response_model=PromptInstructions, dependencies=[Depends(verify_token)])
async def put_prompt_instructions(
    body: PromptInstructions, active_person: str = Depends(get_active_person)
) -> PromptInstructions:
    store.save_prompt_instructions(body.instructions, active_person)
    return body


@app.get("/resume-templates", response_model=list[ResumeTemplateOption], dependencies=[Depends(verify_token)])
async def list_resume_templates() -> list[ResumeTemplateOption]:
    """The full catalog of available resume templates (name/description) - same for every
    person. Which one each person currently has picked is /resume-template, below."""
    return [
        ResumeTemplateOption(key=t.key, name=t.name, description=t.description)
        for t in resume_templates.list_templates()
    ]


@app.get("/resume-template", response_model=ResumeTemplateChoice, dependencies=[Depends(verify_token)])
async def get_active_resume_template(active_person: str = Depends(get_active_person)) -> ResumeTemplateChoice:
    return ResumeTemplateChoice(template=store.get_resume_template(active_person))


@app.put("/resume-template", response_model=ResumeTemplateChoice, dependencies=[Depends(verify_token)])
async def put_active_resume_template(
    body: ResumeTemplateChoice, active_person: str = Depends(get_active_person)
) -> ResumeTemplateChoice:
    store.save_resume_template(body.template, active_person)
    return body


# Per-person, not global - see TailorModeChoice's own comment for why.
@app.get("/tailor-mode", response_model=TailorModeChoice, dependencies=[Depends(verify_token)])
async def get_active_tailor_mode(active_person: str = Depends(get_active_person)) -> TailorModeChoice:
    return TailorModeChoice(tailor_mode=store.get_tailor_mode(active_person))


@app.put("/tailor-mode", response_model=TailorModeChoice, dependencies=[Depends(verify_token)])
async def put_active_tailor_mode(
    body: TailorModeChoice, active_person: str = Depends(get_active_person)
) -> TailorModeChoice:
    store.save_tailor_mode(body.tailor_mode, active_person)
    return body


@app.get("/resumes", response_model=list[ResumeEntry], dependencies=[Depends(verify_token)])
async def list_resumes(active_person: str = Depends(get_active_person)) -> list[ResumeEntry]:
    return store.get_resumes(active_person)


@app.post("/resumes", response_model=ResumeEntry, dependencies=[Depends(verify_token)])
async def upload_resume(
    file: UploadFile = File(...), stack: str = Form(...), active_person: str = Depends(get_active_person)
) -> ResumeEntry:
    resume_id = uuid.uuid4().hex
    entry = ResumeEntry(
        id=resume_id,
        filename=file.filename or "resume",
        stack=stack.strip(),
        uploaded_at=datetime.now(timezone.utc).isoformat(),
    )
    dest = store.resume_file_path(entry.id, entry.filename, active_person)
    dest.write_bytes(await file.read())

    entries = store.get_resumes(active_person)
    entries.append(entry)
    store.save_resumes(entries, active_person)
    return entry


@app.get("/resumes/{resume_id}/file", dependencies=[Depends(verify_token)])
async def get_resume_file(resume_id: str, active_person: str = Depends(get_active_person)) -> FileResponse:
    entries = store.get_resumes(active_person)
    entry = next((e for e in entries if e.id == resume_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="No resume with that id")
    path = store.resume_file_path(entry.id, entry.filename, active_person)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Resume file missing on disk")
    return FileResponse(path, filename=entry.filename)


@app.delete("/resumes/{resume_id}", dependencies=[Depends(verify_token)])
async def delete_resume(resume_id: str, active_person: str = Depends(get_active_person)) -> dict:
    entries = store.get_resumes(active_person)
    entry = next((e for e in entries if e.id == resume_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="No resume with that id")
    path = store.resume_file_path(entry.id, entry.filename, active_person)
    path.unlink(missing_ok=True)
    store.save_resumes([e for e in entries if e.id != resume_id], active_person)
    return {"deleted": resume_id}


@app.post("/prompt-preview", response_model=PromptPreview, dependencies=[Depends(verify_token)])
async def prompt_preview(body: GenerateRequest, active_person: str = Depends(get_active_person)) -> PromptPreview:
    """Build the system prompt + user message without calling any model — for the
    "gpt" (manual) provider, where you copy this into ChatGPT yourself. Saves the same
    JD/link/prompt paper trail /generate leaves for the automatic providers - confirmed live,
    the manual flow previously saved nothing at all until "Generate PDF" was clicked, and even
    then only resume_data.json + the docx/pdf, missing the JD/link/prompt record the automatic
    path gets. `saved_dir` is returned so a later /render for the same company reuses this
    exact folder instead of creating a second one."""
    profile = store.get_profile(active_person)
    settings = store.get_settings()
    system_prompt = build_system_prompt(store.get_prompt_instructions(active_person))
    user_message = build_user_message(profile.model_dump(), body.job_description)

    save_dir = compute_save_dir(settings.apply_root_dir, active_person, body.company)
    save_dir.mkdir(parents=True, exist_ok=True)
    (save_dir / "JD.txt").write_text(body.job_description, encoding="utf-8")
    (save_dir / "link.txt").write_text(body.job_url or "", encoding="utf-8")
    (save_dir / "Prompt(used).txt").write_text(
        f"--- SYSTEM PROMPT ---\n{system_prompt}\n\n--- USER MESSAGE ---\n{user_message}\n", encoding="utf-8"
    )

    return PromptPreview(system_prompt=system_prompt, user_message=user_message, saved_dir=str(save_dir))


@app.post("/answer-prompt-preview", response_model=PromptPreview, dependencies=[Depends(verify_token)])
async def answer_prompt_preview(body: AnswerRequest, active_person: str = Depends(get_active_person)) -> PromptPreview:
    """Same idea as /prompt-preview, but for a single application-form question —
    for the "gpt" (manual) provider."""
    profile = store.get_profile(active_person)
    if body.options:
        return PromptPreview(
            system_prompt=build_select_pick_system_prompt(),
            user_message=build_select_pick_user_message(
                profile.model_dump(),
                body.question,
                body.options,
                body.job_description,
                body.company,
                body.resume,
            ),
        )
    return PromptPreview(
        system_prompt=build_answer_system_prompt(),
        user_message=build_answer_user_message(
            profile.model_dump(), body.question, body.job_description, body.company, body.resume
        ),
    )


def _coerce_select_answer(answer: str | None, options: list[str]) -> str | None:
    """Map a model reply onto one real option label. Exact match first, then case-insensitive /
    substring, otherwise None so the field stays unmatched rather than getting a wrong invent."""
    if not answer or not options:
        return None
    target = answer.strip()
    for opt in options:
        if opt == target:
            return opt
    lower = target.lower()
    for opt in options:
        if opt.lower() == lower:
            return opt
    for opt in options:
        ol = opt.lower()
        if lower in ol or ol in lower:
            return opt
    return None


@app.post("/generate-answer", response_model=AnswerResponse, dependencies=[Depends(verify_token)])
async def generate_answer(body: AnswerRequest, active_person: str = Depends(get_active_person)) -> AnswerResponse:
    """Generate an answer to one application-form question (e.g. "why do you want to
    work here", "do you require sponsorship"), using `settings.answer_provider` — a
    deliberately separate setting from the resume-generation `settings.provider`, since this
    is a lower-stakes task. When `body.options` is set, this is a dropdown pick: the model
    must choose one of those exact option labels."""
    profile = store.get_profile(active_person)
    settings = store.get_settings()

    if settings.answer_provider == "gpt":
        raise HTTPException(
            status_code=400,
            detail='Answer provider is set to "gpt" (manual) — there\'s no automatic call for that. '
            "Use \"Copy prompt for GPT\" for this question, paste it into ChatGPT, then paste its reply back.",
        )
    if settings.answer_provider in ("gpt-auto", "gpt-auto-headless"):
        raise HTTPException(
            status_code=400,
            detail=f'Answer provider is set to "{settings.answer_provider}" — that\'s handled entirely in the extension '
            "(driving a real ChatGPT tab directly, batching every question into one prompt), not via "
            "this per-question endpoint.",
        )

    if body.options:
        system_prompt = build_select_pick_system_prompt()
        user_message = build_select_pick_user_message(
            profile.model_dump(),
            body.question,
            body.options,
            body.job_description,
            body.company,
            body.resume,
        )
    else:
        system_prompt = build_answer_system_prompt()
        user_message = build_answer_user_message(
            profile.model_dump(), body.question, body.job_description, body.company, body.resume
        )

    if settings.answer_provider == "ollama":
        try:
            payload = await run_ollama_chat(
                user_message,
                system_prompt=system_prompt,
                model=settings.ollama_model,
                format_schema={
                    "type": "object",
                    "properties": {
                        "answerable": {"type": "boolean"},
                        "answer": {"type": ["string", "null"]},
                    },
                    "required": ["answerable", "answer"],
                },
                timeout_seconds=settings.timeout_seconds,
                base_url=settings.ollama_base_url,
            )
        except OllamaCliError as exc:
            raise HTTPException(status_code=502, detail=f"Answer generation failed: {exc}") from exc
    else:
        try:
            payload = await run_claude_code_print(
                user_message,
                cwd=Path.home(),
                timeout_seconds=settings.timeout_seconds,
                append_system_prompt=system_prompt,
                model=settings.claude_model,
            )
        except ClaudeCodeCliError as exc:
            raise HTTPException(status_code=502, detail=f"Answer generation failed: {exc}") from exc

    result_text = payload.get("result")
    if not isinstance(result_text, str):
        raise HTTPException(status_code=502, detail="Answer generation failed: no result text returned")

    try:
        answer_dict = json.loads(strip_json_fences(result_text))
        answerable = bool(answer_dict.get("answerable", True))
        raw_answer = answer_dict.get("answer")
        answer = str(raw_answer) if answerable and raw_answer is not None else None
        if answerable and answer is None:
            answerable = False
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Answer generation failed: malformed response ({exc}). Raw response: {result_text[:500]!r}",
        ) from exc

    if body.options and answerable and answer is not None:
        coerced = _coerce_select_answer(answer, body.options)
        if coerced is None:
            answerable = False
            answer = None
        else:
            answer = coerced

    return AnswerResponse(
        answerable=answerable,
        answer=answer,
        session_id=payload.get("session_id"),
        total_cost_usd=payload.get("total_cost_usd"),
        usage=usage_from_cli_payload(payload),
    )


@app.post("/match-answers", response_model=MatchAnswersResponse, dependencies=[Depends(verify_token)])
async def match_answers(body: MatchAnswersRequest, active_person: str = Depends(get_active_person)) -> MatchAnswersResponse:
    """Semantic retrieval only, never generation: asks `settings.answer_provider` whether each
    given live question means the same thing as any entry already in this person's QA bank,
    even if worded very differently (a different company name filled into the same underlying
    boilerplate question) — something the plain word-overlap/regex-category matching in
    sidepanel.js can't reliably bridge on its own. The model only ever selects an index into
    the real, human-provided QA bank (or reports no match) — it can never inject new text into
    an `answer`, so this can't fabricate an answer the way free-form generation could. Batches
    every unmatched question from a page into one call rather than one call per field, since
    they all need to be checked against the same QA bank anyway."""
    qa_bank = store.get_qa(active_person)
    if not qa_bank or not body.questions:
        return MatchAnswersResponse(results=[MatchedAnswer(question=q, matched=False) for q in body.questions])

    settings = store.get_settings()
    if settings.answer_provider in ("gpt", "gpt-auto", "gpt-auto-headless"):
        raise HTTPException(
            status_code=400,
            detail=f'Answer provider is set to "{settings.answer_provider}" — there\'s no automatic AI-based QA-bank '
            "matching for this provider; the extension's own exact/category matching still applies without it.",
        )

    system_prompt = build_match_answer_system_prompt()
    user_message = build_match_answer_user_message(body.questions, [entry.model_dump() for entry in qa_bank])
    schema = {
        "type": "object",
        "properties": {"matches": {"type": "array", "items": {"type": ["integer", "null"]}}},
        "required": ["matches"],
    }

    if settings.answer_provider == "ollama":
        try:
            payload = await run_ollama_chat(
                user_message,
                system_prompt=system_prompt,
                model=settings.ollama_model,
                format_schema=schema,
                timeout_seconds=settings.timeout_seconds,
                base_url=settings.ollama_base_url,
            )
        except OllamaCliError as exc:
            raise HTTPException(status_code=502, detail=f"Answer matching failed: {exc}") from exc
    else:
        try:
            payload = await run_claude_code_print(
                user_message,
                cwd=Path.home(),
                timeout_seconds=settings.timeout_seconds,
                append_system_prompt=system_prompt,
                model=settings.claude_model,
            )
        except ClaudeCodeCliError as exc:
            raise HTTPException(status_code=502, detail=f"Answer matching failed: {exc}") from exc

    result_text = payload.get("result")
    if not isinstance(result_text, str):
        raise HTTPException(status_code=502, detail="Answer matching failed: no result text returned")

    try:
        parsed = json.loads(strip_json_fences(result_text))
        raw_matches = parsed["matches"]
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Answer matching failed: malformed response ({exc}). Raw response: {result_text[:500]!r}",
        ) from exc

    results = []
    for i, question in enumerate(body.questions):
        idx = raw_matches[i] if i < len(raw_matches) else None
        if isinstance(idx, int) and not isinstance(idx, bool) and 0 <= idx < len(qa_bank):
            results.append(
                MatchedAnswer(
                    question=question,
                    matched=True,
                    answer=qa_bank[idx].answer,
                    matched_question=qa_bank[idx].question,
                )
            )
        else:
            results.append(MatchedAnswer(question=question, matched=False))
    return MatchAnswersResponse(results=results)


@app.post("/prompt-preview-answers", response_model=BatchAnswerPromptResponse, dependencies=[Depends(verify_token)])
async def prompt_preview_answers(
    body: BatchAnswerPromptRequest, active_person: str = Depends(get_active_person)
) -> BatchAnswerPromptResponse:
    """Builds the batched (all-questions-at-once) answer prompt for the "gpt-auto" Auto Fill
    path — mirrors /prompt-preview's role for resume generation: the extension fetches the
    prompt text here, then drives a real ChatGPT tab itself instead of this endpoint calling a
    model automatically. Never called for claude/ollama, which use the one-question-at-a-time
    /generate-answer instead.

    Deliberately does NOT include the candidate profile - only the saved Q&A bank, job
    description, and the questions themselves. The Q&A bank is the actual source of truth for
    Auto Fill answers (this endpoint's whole point is reusing an already-approved saved answer
    verbatim); the full profile/work-history JSON was pure bloat for that job, on top of being
    unnecessary personal data to hand to an external chat session for every batch."""
    qa_bank = store.get_qa(active_person)
    profile = store.get_profile(active_person)
    return BatchAnswerPromptResponse(
        system_prompt=build_batch_answer_system_prompt(),
        user_message=build_batch_answer_user_message(
            body.questions,
            body.job_description,
            body.company,
            [entry.model_dump() for entry in qa_bank],
            resume=body.resume,
            options_per_question=body.options_per_question,
            multi_per_question=body.multi_per_question,
            profile=profile.model_dump(),
        ),
    )


@app.post("/provider-test", response_model=ProviderTestResult, dependencies=[Depends(verify_token)])
async def provider_test(body: ProviderTestRequest) -> ProviderTestResult:
    """Tests the provider/fields currently in the settings form — the caller sends
    the live values, so this works whether or not they've clicked Save yet."""
    if body.provider == "claude":
        ok, detail = check_claude_cli()
    elif body.provider == "ollama":
        ok, detail = await check_ollama(body.ollama_base_url, body.ollama_model)
    elif body.provider == "gpt-auto":
        ok, detail = True, 'No connection to test here — this drives a real ChatGPT tab directly ("Generate JSON" or Auto Fill, whichever uses it) rather than calling an API, so you just need to be logged into ChatGPT in this browser.'
    else:
        ok, detail = True, 'Manual mode — no connection needed. Use "Copy prompt for GPT" in the panel.'
    return ProviderTestResult(ok=ok, detail=detail)


@app.post("/generate", response_model=GenerateResponse, dependencies=[Depends(verify_token)])
async def generate(body: GenerateRequest, active_person: str = Depends(get_active_person)) -> GenerateResponse:
    profile = store.get_profile(active_person)
    settings = store.get_settings()

    if settings.provider == "gpt":
        raise HTTPException(
            status_code=400,
            detail='Provider is set to "gpt" (manual) — there\'s no automatic call for that. '
            "Use \"Copy prompt for GPT\" in the panel, paste it into ChatGPT, then paste its JSON reply "
            "into the Resume JSON box.",
        )
    if settings.provider == "gpt-auto":
        # This should never actually be reached — the extension drives a real ChatGPT tab
        # itself for this provider (see sidepanel.js's generateBtn handler) and never calls
        # /generate at all. Guarded here anyway so a stale client or a bug that DOES call this
        # endpoint fails with a clear explanation instead of silently falling through to the
        # Claude CLI branch below and generating with the wrong provider.
        raise HTTPException(
            status_code=400,
            detail='Provider is set to "gpt-auto" — that\'s handled entirely in the extension '
            "(driving a real ChatGPT tab directly), not via this endpoint.",
        )

    system_prompt = build_system_prompt(store.get_prompt_instructions(active_person))
    user_message = build_user_message(profile.model_dump(), body.job_description)

    if settings.provider == "ollama":
        try:
            payload = await run_ollama_chat(
                user_message,
                system_prompt=system_prompt,
                model=settings.ollama_model,
                format_schema=ResumeData.model_json_schema(),
                timeout_seconds=settings.timeout_seconds,
                base_url=settings.ollama_base_url,
            )
        except OllamaCliError as exc:
            raise HTTPException(status_code=502, detail=f"Generation failed: {exc}") from exc
    else:
        try:
            payload = await run_claude_code_print(
                user_message,
                cwd=Path.home(),
                timeout_seconds=settings.timeout_seconds,
                append_system_prompt=system_prompt,
                model=settings.claude_model,
            )
        except ClaudeCodeCliError as exc:
            raise HTTPException(status_code=502, detail=f"Generation failed: {exc}") from exc

    result_text = payload.get("result")
    if not isinstance(result_text, str):
        raise HTTPException(status_code=502, detail="Generation failed: no result text returned")

    try:
        resume_dict = json.loads(strip_json_fences(result_text))
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Generation failed: malformed resume JSON ({exc}). Raw response: {result_text[:1000]!r}",
        ) from exc

    try:
        resume = ResumeData.model_validate(resume_dict)
    except Exception:
        try:
            resume = normalize_resume(resume_dict, profile)
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Generation failed: malformed resume JSON ({exc}). Raw response: {result_text[:1000]!r}",
            ) from exc

    save_dir = compute_save_dir(settings.apply_root_dir, active_person, body.company)
    save_dir.mkdir(parents=True, exist_ok=True)

    # write_text() defaults to the platform's preferred encoding, which on Windows is
    # usually a codepage like cp1252, not UTF-8 — it can't represent characters like "→"
    # (used in the prompt instructions' own examples), raising UnicodeEncodeError on
    # anything but pure-ASCII content. Encoding must be explicit, not left to the OS default.
    (save_dir / "JD.txt").write_text(body.job_description, encoding="utf-8")
    (save_dir / "link.txt").write_text(body.job_url or "", encoding="utf-8")
    (save_dir / "Prompt(used).txt").write_text(
        f"--- SYSTEM PROMPT ---\n{system_prompt}\n\n--- USER MESSAGE ---\n{user_message}\n", encoding="utf-8"
    )
    (save_dir / "resume_data.json").write_text(json.dumps(resume.model_dump(), indent=2), encoding="utf-8")

    return GenerateResponse(
        resume=resume,
        session_id=payload.get("session_id"),
        total_cost_usd=payload.get("total_cost_usd"),
        usage=usage_from_cli_payload(payload),
        saved_dir=str(save_dir),
    )


@app.post("/save-sample", response_model=SaveSampleResponse, dependencies=[Depends(verify_token)])
async def save_sample(body: SaveSampleRequest) -> SaveSampleResponse:
    """Save the current page's HTML plus what Auto Fill's detector matched/would generate
    for each field, for later analysis — the same idea as the hand-pasted ATS fixtures in
    extension/test-forms/, but captured directly from real usage instead of copy-paste."""
    CAPTURED_SAMPLES_DIR.mkdir(parents=True, exist_ok=True)

    host = urlparse(body.page_url).hostname or "unknown"
    slug = re.sub(r"[^a-z0-9]+", "-", host.lower()).strip("-") or "unknown"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    saved: list[str] = []
    merged_console: list[str] = []
    for frame in body.frames:
        suffix = f"-frame{frame.frame_id}" if frame.frame_id else ""
        base_name = f"{slug}-{timestamp}{suffix}"

        html_path = CAPTURED_SAMPLES_DIR / f"{base_name}.html"
        html_path.write_text(frame.html, encoding="utf-8")

        meta_path = CAPTURED_SAMPLES_DIR / f"{base_name}.json"
        meta = {
            "page_url": body.page_url,
            "frame_url": frame.url,
            "frame_id": frame.frame_id,
            "captured_at": timestamp,
            "fields": [field.model_dump() for field in frame.fields],
        }
        if frame.console_log and frame.console_log.strip():
            meta["has_console_log"] = True
            merged_console.append(
                f"=== frame {frame.frame_id} {frame.url} ===\n{frame.console_log.strip()}"
            )
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        saved.append(html_path.name)

    if merged_console:
        log_path = CAPTURED_SAMPLES_DIR / f"{slug}-{timestamp}.console.log"
        log_path.write_text("\n\n".join(merged_console) + "\n", encoding="utf-8")
        saved.append(log_path.name)

    return SaveSampleResponse(ok=True, saved=saved)


@app.post("/portal-log", response_model=PortalLogResponse, dependencies=[Depends(verify_token)])
async def portal_log(
    body: PortalLogEntry, active_person: str = Depends(get_active_person)
) -> PortalLogResponse:
    """Appends one JSON line to a shared per-person/per-day file - a separate, later
    end-of-day browser-automation pass reads a whole day's applications back and pushes them
    into a company-internal Portal that has no API and no CSV import, only its own web UI."""
    settings = store.get_settings()
    day_dir = compute_person_day_dir(settings.apply_root_dir, active_person)
    day_dir.mkdir(parents=True, exist_ok=True)
    log_path = day_dir / "portal_log.jsonl"

    # This new line's index is just how many lines already exist - the same absolute-position
    # convention list_portal_log/mark_portal_log_synced both use, so the caller can immediately
    # act on the entry it just created (e.g. "Sync to Portal" marking it synced right after a
    # successful live push) without a separate GET round trip first.
    existing_line_count = len(log_path.read_text(encoding="utf-8").splitlines()) if log_path.exists() else 0

    entry = {"timestamp": datetime.now(timezone.utc).isoformat(), "synced": False, **body.model_dump()}
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")

    return PortalLogResponse(ok=True, path=str(log_path), index=existing_line_count)


@app.get("/portal-log", response_model=PortalLogListResponse, dependencies=[Depends(verify_token)])
async def list_portal_log(active_person: str = Depends(get_active_person)) -> PortalLogListResponse:
    """Today's logged applications for the active person, each tagged with its own line
    `index` - the only stable handle the sync automation has for marking a specific entry
    synced later, since a JSONL file has no other per-line id."""
    settings = store.get_settings()
    log_path = compute_person_day_dir(settings.apply_root_dir, active_person) / "portal_log.jsonl"
    if not log_path.exists():
        return PortalLogListResponse(entries=[])

    entries = []
    for index, line in enumerate(log_path.read_text(encoding="utf-8").splitlines()):
        if not line.strip():
            continue
        entries.append(PortalLogListEntry(index=index, **json.loads(line)))
    return PortalLogListResponse(entries=entries)


@app.post(
    "/portal-log/mark-synced", response_model=MarkPortalLogSyncedResponse, dependencies=[Depends(verify_token)]
)
async def mark_portal_log_synced(
    body: MarkPortalLogSyncedRequest, active_person: str = Depends(get_active_person)
) -> MarkPortalLogSyncedResponse:
    """Rewrites today's log file with the given line indices flagged synced:true - so a
    re-run of the sync doesn't try to push the same application into the Portal twice."""
    settings = store.get_settings()
    log_path = compute_person_day_dir(settings.apply_root_dir, active_person) / "portal_log.jsonl"
    if not log_path.exists():
        return MarkPortalLogSyncedResponse(ok=True, marked=0)

    indices = set(body.indices)
    lines = log_path.read_text(encoding="utf-8").splitlines()
    marked = 0
    # Blank lines are kept in place (not dropped) - list_portal_log's own `index` is each
    # line's absolute position in the file, so removing a line here would shift every
    # following index out of sync with what the caller (which read the file before this ran)
    # is still expecting to mark.
    rewritten = []
    for index, line in enumerate(lines):
        if not line.strip():
            rewritten.append(line)
            continue
        entry = json.loads(line)
        if index in indices and not entry.get("synced"):
            entry["synced"] = True
            marked += 1
        rewritten.append(json.dumps(entry))
    log_path.write_text("\n".join(rewritten) + "\n", encoding="utf-8")

    return MarkPortalLogSyncedResponse(ok=True, marked=marked)


@app.post("/portal-sync", dependencies=[Depends(verify_token)])
async def portal_sync(body: PortalLogEntry, active_person: str = Depends(get_active_person)) -> dict:
    """Pushes one entry into the Portal via a real, out-of-band, headless Chromium browser
    (Playwright) - unlike the previous chrome.tabs-based approach, this never touches any tab
    the user has open. The browser profile persists its own login session across runs
    (`portal_automation.BROWSER_PROFILE_DIR`), logging in itself via the credentials below only
    when that session has actually expired."""
    settings = store.get_settings()
    if not settings.portal_base_url:
        raise HTTPException(status_code=400, detail='Set the "Portal IP/host" in Settings (Portal tab) first.')
    profile = store.get_profile(active_person)
    return await sync_portal_entry(
        body,
        profile.contact.name,
        settings.portal_base_url,
        settings.portal_username,
        settings.portal_password,
        headless=settings.portal_headless,
    )


@app.post("/chatgpt-prompt", response_model=ChatGptPromptResponse, dependencies=[Depends(verify_token)])
async def chatgpt_prompt(body: ChatGptPromptRequest) -> ChatGptPromptResponse:
    """Submits one prompt to chatgpt.com via a real, out-of-band, persistent-profile Chromium
    browser (Playwright) - replaces the previous chrome.tabs-based version that opened a
    visible tab in the user's OWN browser. Requires a one-time manual login into that profile
    first (see companion-service/login_chatgpt.py) - this never attempts to log in itself."""
    outcome = await submit_chatgpt_prompt(body.prompt, body.delete_conversation)
    return ChatGptPromptResponse(**outcome)


@app.post("/render", response_model=RenderResponse, dependencies=[Depends(verify_token)])
async def render(body: RenderRequest, active_person: str = Depends(get_active_person)) -> RenderResponse:
    """Render a resume JSON (from /generate, or pasted manually from any other source) to docx + pdf.
    Fully independent of how the JSON was produced."""
    settings = store.get_settings()
    profile = store.get_profile(active_person)

    try:
        resume = normalize_resume(body.resume, profile)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Resume JSON doesn't match the expected shape: {exc}") from exc

    if body.saved_dir:
        save_dir = Path(body.saved_dir)
        save_dir.mkdir(parents=True, exist_ok=True)
    else:
        save_dir = compute_save_dir(settings.apply_root_dir, active_person, body.company)
        save_dir.mkdir(parents=True, exist_ok=True)

    (save_dir / "resume_data.json").write_text(json.dumps(resume.model_dump(), indent=2), encoding="utf-8")

    template = resume_templates.get_template(store.get_resume_template(active_person))

    # docx and pdf are built independently, straight from the same resume data — no
    # office-suite conversion step, so no dependency on LibreOffice/Word/WPS. Each is
    # attempted separately so one failing (e.g. a locked file) doesn't block the other.
    docx_path = save_dir / f"{resume.name or 'resume'}.docx"
    pdf_path = save_dir / f"{resume.name or 'resume'}.pdf"
    errors = []

    try:
        template.build_docx(resume, docx_path)
    except PermissionError as exc:
        docx_path = None
        errors.append(f"docx: could not write {exc.filename} — is it open in WPS Office or another program?")

    try:
        template.build_pdf(resume, pdf_path)
    except PermissionError as exc:
        pdf_path = None
        errors.append(f"pdf: could not write {exc.filename} — is it open in another program?")

    if docx_path is None and pdf_path is None:
        raise HTTPException(status_code=409, detail="; ".join(errors))

    pdf_base64 = base64.b64encode(pdf_path.read_bytes()).decode() if pdf_path else None

    return RenderResponse(
        docx_path=str(docx_path) if docx_path else f"FAILED: {errors[0] if errors else ''}",
        pdf_path=str(pdf_path) if pdf_path else f"FAILED: {errors[-1] if errors else ''}",
        saved_dir=str(save_dir),
        pdf_base64=pdf_base64,
    )
