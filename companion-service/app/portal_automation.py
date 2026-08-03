from __future__ import annotations

import re
from datetime import date
from pathlib import Path
from urllib.parse import quote

from playwright.async_api import Locator, Page, TimeoutError as PlaywrightTimeoutError, async_playwright

from app.schemas import PortalLogEntry

# A real, persistent Chromium profile (cookies/local storage survive across separate server
# runs, same as a real user's own browser profile does) - out-of-band from the user's own
# Chrome, so this never hijacks or steals focus from a tab the user is actually looking at
# (the previous chrome.tabs-based approach's whole reason for switching to this). Lives next
# to the service, not under `apply_root_dir` - it's local browser state tied to this one
# machine, not portable data worth syncing anywhere.
BROWSER_PROFILE_DIR = Path(__file__).resolve().parents[1] / ".portal-browser-profile"


async def sync_portal_entry(
    entry: PortalLogEntry, profile_name: str, portal_host: str, username: str, password: str, headless: bool = True
) -> dict:
    """Pushes one job entry into the Portal via its own persistent out-of-band browser - never
    touches any tab the user has open in their own browser. Mirrors the same flow the previous
    chrome.scripting-injected functions drove by hand: fill the Add-Job form (including the
    Company autocomplete's real ajax-suggest widget, or the "Add new" modal for a brand-new
    company), and if the URL turns out to already exist, fall back to finding that existing
    job and adding/dedup-checking an Offer row on it instead.

    `headless` comes from Settings.portal_headless (see main.py's /portal-sync) - explicitly
    requested, so a sync failure can be watched directly (a real, visible Playwright window)
    instead of guessing blind, the same way this was manually toggled during development."""
    portal_base_url = f"{portal_host.rstrip('/')}/mgr"
    BROWSER_PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(str(BROWSER_PROFILE_DIR), headless=headless)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            outcome = await _fill_add_job(page, portal_base_url, entry, profile_name, username, password)
            if outcome.get("duplicate"):
                outcome = await _handle_existing_job(page, portal_base_url, entry, profile_name)
            return outcome
        finally:
            await context.close()


async def _ensure_logged_in(page: Page, target_url: str, username: str, password: str) -> None:
    """Confirmed against the real login markup: a plain #username/#password pair + a
    #submitLogin1 button - a no-op if that button isn't present (already logged in). Login
    always lands on a fixed dashboard page regardless of where the browser was trying to go,
    so the caller's actual intended URL has to be re-navigated to afterward explicitly."""
    login_btn = page.locator("#submitLogin1")
    if await login_btn.count() == 0:
        return
    await page.fill("#username", username or "")
    await page.fill("#password", password or "")
    await login_btn.click()
    await page.wait_for_load_state("networkidle")
    await page.goto(target_url)
    await page.wait_for_load_state("networkidle")


async def _select_option_by_fuzzy_name(select: Locator, name: str) -> None:
    """Picks the option whose text best overlaps `name` - Portal Profile options are
    sometimes just a bare first name ("Pawel") while the profile's own full name is "Pawel
    Kaminski", so an exact match can't be relied on; whichever direction contains the other
    wins, preferring the longest match if more than one qualifies."""
    target = (name or "").strip().lower()
    if not target:
        return
    options = await select.evaluate("el => [...el.options].map(o => ({value: o.value, text: (o.textContent || '').trim()}))")
    best = None
    for option in options:
        if not option["value"]:
            continue
        text = option["text"].strip().lower()
        if not text:
            continue
        if text == target or target in text or text in target:
            if best is None or len(text) > len(best["text"].strip()):
                best = option
    if best:
        await select.select_option(value=best["value"])


async def _select_resume_by_stack(select: Locator, stack: str) -> None:
    """Picks the option whose text best matches any comma/slash-separated keyword in `stack`
    (e.g. "PHP, Laravel, MySQL" against real dropdown options like "PHP"/"Full"/"Node") -
    falls back to the LAST real option (never the blank "Please select") if nothing matches,
    per explicit instruction, rather than leaving the field unset."""
    options = await select.evaluate(
        "el => [...el.options].filter(o => o.value).map(o => ({value: o.value, text: (o.textContent || '').trim()}))"
    )
    if not options:
        return
    keywords = [k.strip().lower() for k in re.split(r"[,/]|\band\b", stack or "", flags=re.IGNORECASE) if k.strip()]
    best = None
    for option in options:
        text = option["text"].strip().lower()
        if any(k and (k in text or text in k) for k in keywords):
            best = option
            break
    chosen = best or options[-1]
    await select.select_option(value=chosen["value"])


async def _fill_offer_row(page: Page, profile_name: str, resume_stack: str, description: str) -> None:
    """Shared by both the "new job" (Add-Job page, one real Offer row already present by
    default) and "existing job" (a row revealed by clicking Inline Add) paths - fills the
    Profile/Resume/Description fields, polling for the AJAX-populated Resume dropdown to
    actually have real options before trying to choose one."""
    profile_select = page.locator('select[name^="value_profile_no_"]').first
    await profile_select.wait_for(state="visible", timeout=3000)
    await _select_option_by_fuzzy_name(profile_select, profile_name)

    resume_select = page.locator('select[name^="value_resume_no_"]').first
    for _ in range(20):
        if await resume_select.locator("option").count() > 1:
            break
        await page.wait_for_timeout(200)
    if await resume_select.locator("option").count() > 1:
        await _select_resume_by_stack(resume_select, resume_stack)

    offer_msg = page.locator('textarea[name^="value_offer_msg_"]').first
    if await offer_msg.count() > 0:
        await offer_msg.fill(description or "")


MODAL_OPEN_SELECTOR = '.modal.in, .modal-backdrop, [role="dialog"].in'


async def _wait_for_no_modal(page: Page, timeout_ms: int = 5000) -> None:
    """Polls for every modal-like element (a real Bootstrap dialog wrapper, `role="dialog"
    class="bs-popup modal in"` confirmed live - not just `.modal-backdrop`) to be genuinely gone,
    rather than tracking one specific element handle that could go stale or simply be watching
    the wrong piece of a multi-part modal entirely. Best-effort: if a modal is somehow still open
    once this budget runs out, callers proceed anyway rather than hanging - whatever tries to
    click through it next will surface its own clear timeout if it's still actually blocked."""
    for _ in range(timeout_ms // 200):
        if await page.locator(MODAL_OPEN_SELECTOR).count() == 0:
            return
        await page.wait_for_timeout(200)


async def _fill_company(page: Page, company: str) -> None:
    """Confirmed live: a real ajax-suggest autocomplete widget. Typing a company name that
    already exists shows a real suggestion popup (`#lookupSuggest_value_jc_no_1`, containing
    `.suggest_link` entries) - clicking the matching one fills the hidden company id. A
    genuinely new company shows no suggestion; tabbing away (a real blur) reveals an "Add
    new" link that opens a separate Bootstrap modal ("Companies, Add new") with its OWN
    Company Name input and Save button, distinct from the main form entirely.

    Unlike the previous chrome.scripting-injected version of this same logic, no
    mousedown/mouseup/click event-dispatch workaround is needed here - Playwright's own
    .click() already fires a real, OS-level trusted click (mousedown+mouseup+click), which is
    exactly what the widget's real handler (bound to mousedown) needs to see."""
    display = page.locator('[name="display_value_jc_no_1"]')
    await display.fill(company)

    suggestion = page.locator("#lookupSuggest_value_jc_no_1 .suggest_link", has_text=re.compile(rf"^{re.escape(company)}$", re.IGNORECASE))
    try:
        await suggestion.first.wait_for(state="visible", timeout=3000)
        await suggestion.first.click()
        await page.wait_for_timeout(300)
        return
    except PlaywrightTimeoutError:
        pass

    # A real Tab keypress (not a synthetic blur() call) - triggers the page's own no-match
    # validation (the "Company" label turning red) exactly as it would for a real user.
    await display.press("Tab")
    await page.wait_for_timeout(300)

    add_new = page.locator('[id^="addnew_value_jc_no_"]')
    if await add_new.count() == 0:
        return
    await add_new.first.click()

    modal_input = page.locator('input[id^="value_company_name_"]')
    try:
        await modal_input.first.wait_for(state="visible", timeout=3000)
    except PlaywrightTimeoutError:
        return
    await modal_input.first.fill(company)

    modal_save = page.locator('.modal-content:has(input[id^="value_company_name_"]) .modal-footer button[id^="saveButton"]')
    if await modal_save.count() == 0:
        return
    await modal_save.first.click()
    # Confirmed live: the real element left blocking the page afterward was a Bootstrap dialog
    # wrapper (`role="dialog" class="bs-popup modal in"`), NOT `.modal-backdrop` alone - waiting
    # on only the backdrop let a still-open modal silently continue past this point, later
    # blocking the main form's OWN Save button ("intercepts pointer events") until Playwright's
    # own 30s retry budget was exhausted, surfacing as a confusing generic timeout instead of
    # the real cause. Polls for every modal-like element to be genuinely gone, not just one
    # specific piece of it - `.first.wait_for(state="detached")` only ever tracked ONE element
    # handle, which could go stale or simply be watching the wrong piece entirely.
    await _wait_for_no_modal(page)
    await page.wait_for_timeout(300)


async def _fill_add_job(page: Page, portal_base_url: str, entry: PortalLogEntry, profile_name: str, username: str, password: str) -> dict:
    add_job_url = f"{portal_base_url}/job_jobs_add.php"
    await page.goto(add_job_url)
    await page.wait_for_load_state("networkidle")
    await _ensure_logged_in(page, add_job_url, username, password)

    site_select = page.locator('[name="value_site_code_1"]')
    if await site_select.count() > 0:
        try:
            await site_select.select_option(label=entry.platform)
        except Exception:
            pass

    company_display = page.locator('[name="display_value_jc_no_1"]')
    if await company_display.count() > 0:
        await _fill_company(page, entry.company)

    url_input = page.locator('[name="value_url_1"]')
    if await url_input.count() > 0:
        await url_input.fill(entry.url)
    title_input = page.locator('[name="value_job_title_1"]')
    if await title_input.count() > 0:
        await title_input.fill(entry.job_title)

    # Unlike the existing-job Offers page (_handle_existing_job below), this "Jobs, Add new"
    # page already has ONE real, editable Offer row present by default - confirmed live, no
    # "Inline Add" click needed/expected here at all.
    await _fill_offer_row(page, profile_name, entry.resume_stack, entry.description)

    save_btn = page.locator("#saveButton1")
    if await save_btn.count() == 0:
        return {"ok": False, "error": "Save button not found on the Add-Job page."}
    # Belt-and-suspenders on top of _fill_company's own _wait_for_no_modal call above - confirmed
    # live, a still-open modal ("Companies, Add new") left over from the Company step blocked
    # this exact click with "intercepts pointer events" until Playwright's own 30s retry budget
    # ran out, surfacing as a confusing generic timeout rather than the real cause. Cheap
    # insurance against ANY stray modal, not just one specifically from the Company step.
    await _wait_for_no_modal(page)
    await save_btn.click()
    # Save may trigger a genuine page navigation - wait it out before checking for the real
    # duplicate-URL error, rather than trusting anything about the page immediately after.
    await page.wait_for_load_state("networkidle")
    await page.wait_for_timeout(1000)

    duplicate_error = page.locator('[id^="DenyDuplicated"]')
    if await duplicate_error.count() > 0:
        text = ((await duplicate_error.first.text_content()) or "").strip()
        if "already exists" in text.lower():
            return {"ok": False, "duplicate": True}
    return {"ok": True}


async def _find_existing_offer_row(page: Page, profile_name: str) -> bool:
    """The Portal itself is the authoritative source of truth for "was this already synced",
    not this codebase's own local per-day log file, which could in principle drift out of
    sync with what actually landed in the Portal. Polls briefly since the grid can populate
    its rows via a delayed/follow-up AJAX call, same as many AppGini grids - settles early
    once the row count stabilizes instead of waiting out the full timeout budget."""
    # Built manually, not via strftime("%-m/%-d/%Y") - the "%-" no-leading-zero flag is a
    # Linux/glibc-only strftime extension and silently fails on Windows, which is where this
    # companion service actually runs (see setup.bat/start.bat).
    today = date.today()
    today_str = f"{today.month}/{today.day}/{today.year}"
    target = (profile_name or "").strip().lower()

    last_count = -1
    for check in range(10):
        rows = await page.locator("tr.bs-gridrow:not(.gridRowAdd)").evaluate_all(
            """rows => rows.map(row => {
                const profileCell = row.querySelector('[data-field="profile_no"] span');
                const dateCell = row.querySelector('[data-field="date_added"] span');
                return {
                    profile: ((profileCell && profileCell.textContent) || '').trim().toLowerCase(),
                    date: ((dateCell && dateCell.textContent) || '').trim(),
                };
            })"""
        )
        for row in rows:
            if row["date"] != today_str:
                continue
            if row["profile"] == target or (target and target in row["profile"]) or (row["profile"] and row["profile"] in target):
                return True
        count = len(rows)
        if check >= 2 and count == last_count:
            return False
        last_count = count
        await page.wait_for_timeout(300)
    return False


async def _handle_existing_job(page: Page, portal_base_url: str, entry: PortalLogEntry, profile_name: str) -> dict:
    """The URL-already-exists fallback path - finds the existing job via search results, then
    either confirms an Offer row already exists for this profile+today (already synced, no
    duplicate added) or adds a new one via Inline Add."""
    search_url = f"{portal_base_url}/job_jobs_list.php?q=(url~contains~{quote(entry.url, safe='')})&f=all"
    await page.goto(search_url)
    await page.wait_for_load_state("networkidle")

    link = page.locator('a[href*="job_offers_list.php?mastertable=job_jobs&masterkey1="]')
    if await link.count() == 0:
        return {"ok": False, "error": "Showed as a duplicate URL, but couldn't find the existing job in search results."}
    href = await link.first.get_attribute("href")
    match = re.search(r"masterkey1=(\d+)", href or "")
    if not match:
        return {"ok": False, "error": "Showed as a duplicate URL, but couldn't find the existing job in search results."}

    offers_url = f"{portal_base_url}/job_offers_list.php?mastertable=job_jobs&masterkey1={match.group(1)}"
    await page.goto(offers_url)
    await page.wait_for_load_state("networkidle")

    if await _find_existing_offer_row(page, profile_name):
        return {"ok": True, "alreadyExists": True}

    inline_add = page.locator('[id^="inlineAdd"]')
    if await inline_add.count() > 0:
        await inline_add.first.click()

    profile_select = page.locator('select[name^="value_profile_no_"]').first
    try:
        await profile_select.wait_for(state="visible", timeout=3000)
    except PlaywrightTimeoutError:
        return {"ok": False, "error": "Inline Add row never appeared."}
    await _select_option_by_fuzzy_name(profile_select, profile_name)

    resume_select = page.locator('select[name^="value_resume_no_"]').first
    for _ in range(20):
        if await resume_select.locator("option").count() > 1:
            break
        await page.wait_for_timeout(200)
    if await resume_select.locator("option").count() > 1:
        await _select_resume_by_stack(resume_select, entry.resume_stack)

    offer_msg = page.locator('textarea[name^="value_offer_msg_"]').first
    if await offer_msg.count() > 0:
        await offer_msg.fill(entry.description or "")

    row_save = page.locator('[id^="saveLink"]')
    save_all = page.locator('[id^="saveall_edited"]')
    if await row_save.count() > 0:
        await row_save.first.click()
    elif await save_all.count() > 0:
        await save_all.first.click()
    else:
        return {"ok": False, "error": "No save control found for the new Offer row."}
    await page.wait_for_timeout(800)
    return {"ok": True}
