from __future__ import annotations

import json

DEFAULT_INSTRUCTIONS = """You are an ATS (Applicant Tracking System) optimization expert and professional \
resume-tailoring assistant. You are given a candidate's full work history and a target job description. \
Produce a resume tailored to that specific job, optimized to score well against ATS keyword matching \
WITHOUT ever fabricating employers, titles, dates, degrees, or metrics.

Non-negotiable ground rules:
- Never invent employers, job titles, employment dates, degrees, schools, or metrics (numbers, percentages, \
dollar amounts, user counts, latency, throughput, etc.). Only include a metric if it already appears in \
the candidate's source data for that role.
- Copy each job's `location` from the profile (e.g. Warsaw (Remote), Luxembourg (Onsite)). Do not leave it \
empty or fold it into the company name.
- Do not invent technologies the candidate clearly never used. Prefer the candidate's real stack; when the \
profile is thin, you may align wording to the JD's tech/domain only where honest.
- Experience bullets MUST always be an empty array `[]`. Do NOT write bullet strings. Do NOT copy profile \
bullet text into the reply. Leaving bullets empty keeps the ChatGPT composer prompt small and avoids \
truncated/paste failures.

ATS optimization techniques:
- Reorder and regroup skills into categories that mirror the JD's emphasis; include JD-priority skills the \
candidate can honestly claim. Use the JD's exact skill terminology when the underlying work fits.
- Select and prioritize experience most relevant to this job; de-emphasize less relevant items rather than \
deleting real roles.
- Write a summary that matches the depth of the candidate's own summary — if theirs is long and detailed, \
use roughly 4-6 sentences; if brief, stay brief. Open with the candidate's real title/experience level and \
the most JD-relevant skills they can claim. Put the entire summary in ONE paragraph with spaces between \
sentences — do not insert newline characters between sentences.

Bold formatting:
- Use Markdown **text** only inside the summary string — never inside skills arrays, and never in bullets \
(bullets stay empty).
- Bold meaningful phrases (systems, platforms, JD tech combinations, domain impact), not isolated generic \
words like **built** or **data**.

If the JD emphasizes a skill the candidate cannot honestly claim, omit it and surface the closest \
genuinely-held skills instead."""

_SCHEMA_CONTRACT = """CRITICAL OUTPUT — MACHINE PARSE ONLY:
- Your entire reply MUST be exactly one JSON object. Nothing else.
- The first character of your reply MUST be `{`. The last character MUST be `}`.
- Do NOT wrap the JSON in markdown code fences (no ```).
- Do NOT write any title, heading, prose, apology, note, or explanation before or after the JSON.
- Do NOT offer follow-ups, next steps, refinements, or suggestions of any kind — including lines like \
"Refine the tailored resume", "Refine the X application", "Add quantified impact", "Create a cover letter", \
"Create a one-page version", or any bullet list of optional improvements.
- Do NOT ask clarifying questions. Do NOT invite another turn. Output ends at the closing brace.
- Every experience entry MUST have `"bullets": []` (empty array). Do not write bullet text strings. \
Filled bullets bloat the reply and break automated paste into ChatGPT's text field.

The JSON object must match exactly this shape:

{
  "name": "string",
  "contact_line": "string: phone | email | location | linkedin (etc.), each separated by ' | '. Write \
phone as plain text (no markdown link, no tel:). Write email and any links (LinkedIn, GitHub, portfolio, ...) \
as markdown links: [visible text](url), using mailto:/https:// as appropriate. For web links, the visible \
text must be the actual URL or handle itself (e.g. linkedin.com/in/janedoe), never a generic label like \
'LinkedIn' or 'Portfolio'.",
  "summary": "string: one paragraph, sentences separated by spaces only (no newline characters)",
  "skills": {"category name": ["skill", "..."]},
  "experience": [
    {"title": "string", "company": "string", "location": "string: copy the profile job workplace line (e.g. Warsaw (Remote)); never empty if the profile has it", "dates": "string", "bullets": []}
  ],
  "education": [
    {"school": "string", "degree": "string", "location": "string or null", "dates": "string or null"}
  ]
}"""


def build_system_prompt(instructions: str) -> str:
    return f"{instructions}\n\n{_SCHEMA_CONTRACT}"


def _profile_for_resume_prompt(profile: dict) -> dict:
    """Drop experience bullet text from the prompt payload.

    Pasting long bullet lists into ChatGPT's composer text field truncates the prompt and
    yields empty/weak resumes. Titles/companies/dates/location stay; bullets stay [].
    """
    out = dict(profile or {})
    exp_in = out.get("experience")
    if not isinstance(exp_in, list):
        return out
    cleaned = []
    for entry in exp_in:
        if not isinstance(entry, dict):
            cleaned.append(entry)
            continue
        row = dict(entry)
        row["bullets"] = []
        cleaned.append(row)
    out["experience"] = cleaned
    return out


def build_user_message(profile: dict, job_description: str) -> str:
    return (
        "CANDIDATE PROFILE (JSON):\n"
        f"{json.dumps(_profile_for_resume_prompt(profile), indent=2)}\n\n"
        "JOB DESCRIPTION:\n"
        f"{job_description}\n\n"
        "Generate the tailored resume JSON now.\n"
        "Reminder: every experience entry must use \"bullets\": [] — do not write bullet strings. "
        "Reply with the JSON object only — first char `{`, last char `}`, no follow-up "
        "suggestions or other text after the closing brace."
    )


_ANSWER_SCHEMA_CONTRACT = """Respond with ONLY a single JSON object and nothing else \
(no markdown code fences, no commentary before or after): \
{"answerable": true or false, "answer": "string" or null} \
When answerable is true, answer MUST be plain text only — no markdown (**bold**, *italic*, \
`code`, [links](url), headings, or bullet markers). Application form fields need plain values."""


def build_answer_system_prompt() -> str:
    return (
        "You are helping a job candidate answer a specific application-form question, using their real "
        "profile/work history and the target job description as context.\n\n"
        "Non-negotiable rule: only use facts, reasons, and experience already present in the candidate's "
        "provided profile. Never invent motivations, experience, or facts that aren't grounded in what's "
        "provided — this applies to soft questions (\"why do you want to work here\") just as much as "
        "factual ones.\n\n"
        "Plain text only in answer strings: never use markdown formatting of any kind (**bold**, italics, "
        "backticks, [text](url) links, headings, or list markers). The answer is pasted into a form field "
        "as-is.\n\n"
        "Exception — salary / compensation / expected pay and notice period / available from / start date: "
        "ALWAYS answer these (answerable true). Match the question's format exactly — currency named in "
        "the field (USD, EUR, INR, …), and the period it implies (yearly/annual/CTC, monthly, hourly, "
        "daily). If the period is unclear on free text, state it explicitly "
        '(e.g. "6000 EUR per month"). For notice/availability: a calendar date if they ask a date, a '
        "number of days if they ask days, a short phrase only for open free-text. Never paste a long "
        "canned multi-period essay. Prefer any figure already in the Q&A/profile; otherwise choose a "
        "concise professional figure consistent with the job level and location.\n\n"
        "If the profile doesn't contain enough to genuinely answer other concrete fact questions "
        "(e.g. a specific province/state simply not present in the profile), set answerable to false "
        "and answer to null — do NOT write a sentence explaining that you don't have enough information. "
        "That explanation is not a valid answer to put in a form field; a real applicant would leave the "
        "field blank and handle it themselves. Setting answerable to false is what triggers exactly that "
        "safe fallback in the actual application.\n\n"
        "Match the answer's length to what the question actually asks. A question asking for a single fact "
        "(a job title, a company name, years of experience as a number) gets a short, direct phrase back - "
        "e.g. \"Senior Software Engineer at Acme Corp\", not \"I am currently working at Acme Corp where I "
        "serve as...\". Only a genuinely open-ended question (\"why do you want to work here\", \"tell us "
        "about yourself\") gets a few sentences, still in first person and still matching a real "
        "application-form response, not a cover letter.\n\n"
        "Answer exactly the question asked, using only the parts of the profile that are actually relevant "
        "to it - don't pull in unrelated profile details just because they're available.\n\n"
        "Prior employment / relatives at THIS employer (any company name): answer No unless the profile "
        "or Q&A clearly says otherwise. \"Have you worked with X\" about a technology/tool/skill "
        "(e.g. AI, React): answer from resume/skills — never treat it like \"worked at this company\". "
        "Lived-in-US/Canada-style residency screens: No when the profile only shows Poland/EU residence.\n\n"
        f"{_ANSWER_SCHEMA_CONTRACT}"
    )


def _resume_block(resume: dict | None) -> str:
    if not resume:
        return ""
    # Keep experience.bullets as [] in prompts — filled bullets bloat ChatGPT paste (same
    # rule as resume generation). Titles/companies/summary/skills still go through.
    slim = dict(resume)
    exp = slim.get("experience")
    if isinstance(exp, list):
        slim["experience"] = [
            {**entry, "bullets": []} if isinstance(entry, dict) else entry for entry in exp
        ]
    return (
        "TAILORED RESUME (JSON) — prefer this over the raw profile when they differ:\n"
        f"{json.dumps(slim, indent=2)}\n\n"
    )


def _profile_contact_block(profile: dict | None) -> str:
    """Factual contact fields only — grounds gpt-auto batch answers without shipping full JSON."""
    if not profile:
        return ""
    contact = profile.get("contact") or {}
    facts = {
        k: contact.get(k)
        for k in ("name", "email", "phone", "location", "city", "country", "state", "linkedin", "website")
        if contact.get(k)
    }
    if not facts:
        return ""
    return "CANDIDATE CONTACT FACTS (use for location/nationality/contact questions):\n" f"{json.dumps(facts, indent=2)}\n\n"


def build_answer_user_message(
    profile: dict,
    question: str,
    job_description: str,
    company: str,
    resume: dict | None = None,
) -> str:
    return (
        "CANDIDATE PROFILE (JSON):\n"
        f"{json.dumps(profile, indent=2)}\n\n"
        f"{_resume_block(resume)}"
        f"COMPANY: {company or '(not provided)'}\n\n"
        "JOB DESCRIPTION:\n"
        f"{job_description or '(not provided)'}\n\n"
        "APPLICATION QUESTION:\n"
        f"{question}\n\n"
        "Write the answer now."
    )


_SELECT_PICK_SCHEMA_CONTRACT = """Respond with ONLY a single JSON object and nothing else \
(no markdown code fences, no commentary before or after): \
{"answerable": true or false, "answer": "string" or null} \
When answerable is true, answer MUST be copied exactly from the provided OPTIONS list \
(same spelling/punctuation). Never invent an option that is not in the list."""


def build_select_pick_system_prompt() -> str:
    return (
        "You are helping a job candidate pick ONE option from a real application-form dropdown. "
        "You are given the question, the exact OPTIONS the form offers, and the candidate's profile "
        "(and optional tailored resume).\n\n"
        "Non-negotiable rules:\n"
        "- You may ONLY choose a value that appears verbatim in OPTIONS. Never invent, paraphrase, "
        "or translate an option into something that is not in the list.\n"
        "- Prefer facts grounded in the profile/resume (nationality, years of experience, etc.).\n"
        "- Prior employment / relatives at this employer → No unless profile/Q&A says otherwise. "
        "Tech \"worked with …\" questions → pick from resume/skills, not company-employment No.\n"
        "- If none of the options genuinely fit, or you are not confident, set answerable to false "
        "and answer to null rather than guessing.\n\n"
        f"{_SELECT_PICK_SCHEMA_CONTRACT}"
    )


def build_select_pick_user_message(
    profile: dict,
    question: str,
    options: list[str],
    job_description: str,
    company: str,
    resume: dict | None = None,
) -> str:
    numbered = "\n".join(f"- {opt}" for opt in options)
    return (
        "CANDIDATE PROFILE (JSON):\n"
        f"{json.dumps(profile, indent=2)}\n\n"
        f"{_resume_block(resume)}"
        f"COMPANY: {company or '(not provided)'}\n\n"
        "JOB DESCRIPTION:\n"
        f"{job_description or '(not provided)'}\n\n"
        "APPLICATION QUESTION:\n"
        f"{question}\n\n"
        "OPTIONS (pick exactly one of these strings):\n"
        f"{numbered}\n\n"
        "Pick the best option now."
    )


_BATCH_ANSWER_SCHEMA_CONTRACT = """Respond with ONLY a single JSON object and nothing else \
(no markdown code fences, no commentary before or after): \
{"answers": [{"question_number": <the number from the numbered list above>, "answerable": true or false, \
"answer": "string" or null}, ...]} \
with exactly one entry per question. question_number must match the number each question was given in the \
list below (1, 2, 3, ...) - this is how each answer gets matched back to its own question, so it must be \
correct even if you don't answer them in the same order they were given. \
Each answer string MUST be plain text only — no markdown (**bold**, *italic*, `code`, [links](url), \
headings, or bullet markers). Form fields need plain values."""


# Used by the GPT-tab-automation path for Auto Fill (see runChatGptPrompt/the answer_provider
# "gpt-auto" branch in sidepanel.js) - batches every question into ONE prompt/ONE ChatGPT
# round trip instead of one call per field, since that's what "open a tab, submit, wait for a
# response, close it" can reasonably do without opening (and waiting on) a separate tab per
# question. The one-question-at-a-time build_answer_system_prompt/build_answer_user_message
# above are still what Claude/Ollama use via /generate-answer - this doesn't replace those.
def build_batch_answer_system_prompt() -> str:
    return (
        "Answer exactly what each question asks, using only the parts of the saved Q&A bank actually "
        "relevant to it — don't pull in unrelated saved answers just because they're available.\n\n"
        "All answers should be truable.\n\n"
        "Plain text only in every answer string: never use markdown (**bold**, italics, backticks, "
        "[text](url) links, headings, or list markers). Answers are pasted into application form "
        "fields as-is.\n\n"
        "Exception — salary / compensation / expected pay and notice period / available from / start date: "
        "ALWAYS answer these (answerable true). Match the question's format exactly — currency named in "
        "the field (USD, EUR, INR, …), and the period it implies (yearly/annual/CTC, monthly, hourly, "
        "daily). If the period is unclear on free text, state it explicitly "
        '(e.g. "6000 EUR per month"). Prefer any figure already in the Q&A/profile; otherwise choose a '
        "concise professional figure consistent with the job level and location. Never set answerable "
        "false for salary or notice.\n\n"
        "Salary / compensation / expected pay: match the question's format exactly — use the currency "
        "it names (USD, EUR, INR, etc.), and the period it implies (yearly/annual/CTC, monthly, hourly, "
        "or daily). If the period is unclear, state it explicitly (e.g. \"6000 EUR per month\"). Never "
        "paste a multi-period range essay.\n\n"
        "Notice period / available from / start date: match the asked unit — a calendar date if they "
        "ask a date, a number of days if they ask days, a short phrase only for open free-text. Never "
        "paste a long canned notice-period essay.\n\n"
        "Do not reuse a single canned salary or notice answer across differently worded fields — answer "
        "each one for that field's unit and currency.\n\n"
        "Prior employment / relatives at THIS employer (any company name filled into "
        "\"worked at / employed by / relatives at …\"): answer No unless the saved Q&A or resume "
        "clearly says the candidate did work there or has relatives there.\n\n"
        "\"Have you worked with X\" about a technology, tool, skill, language, or methodology "
        "(AI, React, AWS, Python, etc.): answer from the resume/skills — never reuse a "
        "\"worked at this company → No\" answer for those.\n\n"
        "Lived in the US / Canada / another country for N months: use contact/location history; "
        "if the profile only shows Poland/EU residence and nothing else, answer No.\n\n"
        f"{_BATCH_ANSWER_SCHEMA_CONTRACT}"
    )


def build_batch_answer_user_message(
    questions: list[str],
    job_description: str,
    company: str,
    qa_bank: list[dict],
    resume: dict | None = None,
    options_per_question: list[list[str] | None] | None = None,
    multi_per_question: list[bool] | None = None,
    profile: dict | None = None,
) -> str:
    lines = []
    for i, q in enumerate(questions):
        opts = options_per_question[i] if options_per_question and i < len(options_per_question) else None
        multi = bool(multi_per_question[i]) if multi_per_question and i < len(multi_per_question) else False
        if opts:
            opt_text = "; ".join(opts)
            if multi:
                lines.append(
                    f"{i + 1}. {q}\n"
                    f"   OPTIONS (select ALL that apply; join chosen labels with \", \"): {opt_text}"
                )
            else:
                lines.append(f"{i + 1}. {q}\n   OPTIONS (pick exactly one): {opt_text}")
        else:
            lines.append(f"{i + 1}. {q}")
    numbered = "\n".join(lines)
    bank_text = (
        "\n".join(f"{i}. Q: {entry['question']}\n   A: {entry['answer']}" for i, entry in enumerate(qa_bank))
        if qa_bank
        else "(none saved yet)"
    )
    select_note = ""
    if options_per_question and any(options_per_question):
        select_note = (
            "\nFor any question that lists OPTIONS, every chosen label MUST be copied exactly from "
            "that question's OPTIONS list (same spelling). Never invent an option. Never paste a "
            "short Q&A-bank phrase (e.g. \"No disability\") when OPTIONS has a longer official "
            "wording — pick the OPTIONS row that means the same thing. For "
            '"select ALL that apply" questions, put multiple labels in one answer string '
            'separated by ", ".\n'
        )
    return (
        f"SAVED Q&A BANK:\n{bank_text}\n\n"
        f"{_profile_contact_block(profile)}"
        f"{_resume_block(resume)}"
        f"COMPANY: {company or '(not provided)'}\n\n"
        "JOB DESCRIPTION:\n"
        f"{job_description or '(not provided)'}\n\n"
        "APPLICATION QUESTIONS (answer each one, in this exact order):\n"
        f"{numbered}\n"
        f"{select_note}\n"
        "Write the answers now."
    )


_MATCH_SCHEMA_CONTRACT = """Respond with ONLY a single JSON object and nothing else \
(no markdown code fences, no commentary before or after): {"matches": [<int or null>, ...]} \
with exactly one entry per new question, in the same order they were given."""


def build_match_answer_system_prompt() -> str:
    return (
        "You are matching NEW application-form questions against a list of already-answered "
        "questions from this person's saved Q&A bank, to decide whether an existing answer can be "
        "reused for each one.\n\n"
        "Non-negotiable rule: you are never writing a new answer. For each new question, you are "
        "only ever selecting the index of an existing Q&A-bank entry that means the same thing — "
        "even if worded very differently, e.g. a different company name filled into the same "
        "underlying boilerplate question (\"Have you ever been employed by Acme Corp?\" means the "
        "same thing as a saved \"Have you ever worked at this company before?\") — or reporting that "
        "none of them match. A missed match is safe: the person just answers it themselves. A wrong "
        "match is not safe: it puts words in their mouth on a real application. If you are not "
        "genuinely confident a real match exists, report no match rather than guessing.\n\n"
        "Never match salary / compensation / expected pay, or notice period / available from / "
        "start date questions to the Q&A bank — those must be answered fresh for each form. "
        "Always report no match for those.\n\n"
        f"{_MATCH_SCHEMA_CONTRACT}"
    )


def build_match_answer_user_message(questions: list[str], qa_bank: list[dict]) -> str:
    bank_text = "\n".join(f"{i}. Q: {entry['question']}\n   A: {entry['answer']}" for i, entry in enumerate(qa_bank))
    questions_text = "\n".join(f"{i}. {q}" for i, q in enumerate(questions))
    return (
        f"SAVED Q&A BANK:\n{bank_text}\n\n"
        f"NEW QUESTIONS FROM THE FORM:\n{questions_text}\n\n"
        "For each new question above, which saved entry (if any) means the same thing? Respond now."
    )


def build_cover_letter_system_prompt() -> str:
    return (
        "You write job application cover letters as plain text only. "
        "No markdown, no bold, no asterisks, no headings, no JSON. "
        "Output only the letter body (greeting through sign-off)."
    )


def build_cover_letter_user_message(job_description: str, resume: dict) -> str:
    return (
        "This is job description.\n\n"
        f"{job_description.strip()}\n\n"
        "This is resume.\n\n"
        f"{json.dumps(resume, indent=2)}\n\n"
        "Give me cover letter with no bold, plain text."
    )
