from __future__ import annotations

from pathlib import Path

from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError, async_playwright

# A real, persistent Chromium profile - separate from the Portal's own
# (portal_automation.BROWSER_PROFILE_DIR), since they're unrelated logins. Unlike the Portal
# (a plain internal username/password form, safe to fill in automatically), chatgpt.com actively
# detects and blocks automated/scripted logins - so there is deliberately no login step here at
# all. The FIRST time this profile is used, a real human logs in manually, once, headed
# (see login_chatgpt.py) - every run after that reuses the same persisted session cookies.
#
# CONFIRMED LIVE: signing in via Google can still be blocked by Google's own OAuth anti-
# automation protection ("Couldn't sign you in - this browser or app may not be secure"), and
# Cloudflare's own bot-detection can show a "Just a moment..." challenge screen instead of the
# real page - both real, deliberate anti-automation protections (a different company each), not
# bugs to route around. Once past those, though, generation itself has been confirmed working
# live - kept as a distinct, separate provider option (NOT the default "gpt-auto", which is the
# chrome.tabs-based approach in sidepanel.js) since getting past login is still not reliable
# enough to be anyone's default, not because generation itself doesn't work once logged in.
BROWSER_PROFILE_DIR = Path(__file__).resolve().parents[1] / ".chatgpt-browser-profile"

# TEMPORARY: headed, not headless - so the very first automated runs can be watched directly to
# confirm they work (same reasoning as portal_automation.HEADLESS). Switch to True once confirmed.
HEADLESS = False

NOT_LOGGED_IN_ERROR = (
    "Could not find ChatGPT's message box - either you're not logged in yet (run "
    "login_chatgpt.py once to log in manually - this automation never attempts to log in "
    "itself, since chatgpt.com blocks scripted logins) or the page layout has changed."
)


async def submit_chatgpt_prompt(prompt: str, delete_conversation: bool = True) -> dict:
    """Submits one prompt to chatgpt.com via a real, persistent, out-of-band browser (its own
    login session, established once manually - see login_chatgpt.py) and returns the response
    text. Ports the same flow the previous chrome.scripting-injected submitChatGptPromptInPage
    drove in the user's own visible tab: type into the composer, send, wait for the response to
    finish streaming, un-render its markdown formatting, and (unless disabled) delete the
    conversation afterward so it doesn't pile up in the user's real chat history."""
    BROWSER_PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(str(BROWSER_PROFILE_DIR), headless=HEADLESS)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            return await _submit(page, prompt, delete_conversation)
        finally:
            await context.close()


COMPOSER_SELECTORS = [
    "#prompt-textarea",
    'form [contenteditable="true"]',
    '[contenteditable="true"]',
    "form textarea",
]
SEND_BUTTON_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'form button[type="submit"]',
]
STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop" i]'

# Un-renders the assistant's already-rendered HTML reply back into the equivalent markdown text
# (<strong> -> **text**, <a href> -> [text](url), a real fenced <pre><code> block read via its
# own raw textContent, unprocessed) - ChatGPT's OWN browser UI renders markdown visually even
# though the schema explicitly asks the model not to wrap replies in a code fence, so reading
# .textContent directly would silently lose markers like ** that a generated resume's bullets
# need to survive as literal characters for this codebase's own PDF/DOCX renderer to interpret
# later. Kept as one page.evaluate() call (not reimplemented in Python) since it's a pure,
# already-tested DOM read with no click/typing involved.
RECONSTRUCT_MARKDOWN_JS = """
(node) => {
  function reconstruct(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return "";
    const tag = node.tagName;
    if (tag === "BR") return "\\n";
    if (tag === "CODE" || tag === "PRE") return node.textContent;
    const inner = Array.from(node.childNodes).map(reconstruct).join("");
    if (tag === "STRONG" || tag === "B") return `**${inner}**`;
    if (tag === "EM" || tag === "I") return `_${inner}_`;
    if (tag === "A" && node.getAttribute("href")) return `[${inner}](${node.getAttribute("href")})`;
    if (tag === "P" || tag === "DIV" || tag === "LI") return `${inner}\\n`;
    return inner;
  }
  return reconstruct(node).trim();
}
"""


async def _find_now(page: Page, selectors: list[str]):
    """Checks each selector once, immediately - no internal waiting/polling of its own."""
    for selector in selectors:
        locator = page.locator(selector).first
        if await locator.count() > 0:
            return locator
    return None


async def _find_first(page: Page, selectors: list[str], timeout_ms: int):
    for _ in range(max(1, timeout_ms // 200)):
        found = await _find_now(page, selectors)
        if found is not None:
            return found
        await page.wait_for_timeout(200)
    return None


async def _submit(page: Page, prompt: str, delete_conversation: bool) -> dict:
    await page.goto("https://chatgpt.com/")
    await page.wait_for_load_state("networkidle")

    composer = await _find_first(page, COMPOSER_SELECTORS, timeout_ms=10000)
    if composer is None:
        return {"ok": False, "error": NOT_LOGGED_IN_ERROR}

    # A real, trusted click + insert_text (equivalent to a real paste) - React handles the
    # resulting line breaks the same way it would for a genuine user paste, no manual per-line
    # <p> construction needed the way the old chrome.scripting version required (a synthetic
    # DOM InputEvent there wasn't a real trusted input event the way this is).
    await composer.click()
    await page.keyboard.insert_text(prompt)
    await page.wait_for_timeout(300)

    send_btn = None
    for _ in range(25):
        candidate = await _find_now(page, SEND_BUTTON_SELECTORS)
        if candidate is not None and not await candidate.is_disabled():
            send_btn = candidate
            break
        await page.wait_for_timeout(200)
    if send_btn is None:
        return {"ok": False, "error": "Could not find (or enable) ChatGPT's send button."}
    await send_btn.click()

    # Wait for generation to actually start before waiting for it to finish - guards against
    # reading a stale, pre-submission DOM as already "done" (a longer "thinking" pause before
    # the visible answer starts streaming could otherwise be mistaken for "nothing to wait for").
    try:
        await page.locator(STOP_BUTTON_SELECTOR).first.wait_for(state="visible", timeout=15000)
    except PlaywrightTimeoutError:
        pass
    # Playwright's own wait_for is backed by real browser DOM-change events, not a manual polling
    # loop - no throttling concern here the way the old chrome.scripting version had for a
    # backgrounded/inactive tab (this browser is never anyone's foreground/background tab at all).
    try:
        await page.locator(STOP_BUTTON_SELECTOR).first.wait_for(state="detached", timeout=150000)
    except PlaywrightTimeoutError:
        return {"ok": False, "error": "Timed out waiting for ChatGPT's response to finish."}

    assistant_messages = page.locator('[data-message-author-role="assistant"]')
    count = await assistant_messages.count()
    if count == 0:
        return {"ok": False, "error": "No response found from ChatGPT."}
    last = assistant_messages.nth(count - 1)

    # Retries before giving up: even once the stop button is gone, the DOM can plausibly take
    # one more tick to reflect the final rendered content (React commits asynchronously).
    text = ""
    for _ in range(10):
        text = await last.evaluate(RECONSTRUCT_MARKDOWN_JS)
        if text:
            break
        await page.wait_for_timeout(300)
    if not text:
        return {"ok": False, "error": "ChatGPT's response was empty."}

    # Confirms the text has actually settled (a long reply's last chunk can commit to the DOM a
    # beat after the stop button disappears) by re-reading and requiring two consecutive reads
    # to agree before trusting it, same principle as the empty-retry loop above.
    for _ in range(10):
        await page.wait_for_timeout(300)
        reread = await last.evaluate(RECONSTRUCT_MARKDOWN_JS)
        if reread == text:
            break
        text = reread

    deleted = False
    if delete_conversation:
        try:
            deleted = await _try_delete_conversation(page)
        except Exception:  # noqa: BLE001 - cleanup only, never affects the actual result
            deleted = False

    return {"ok": True, "text": text, "deleted": deleted}


OPTIONS_BUTTON_SELECTORS = [
    'button[data-testid="conversation-options-button"]',
    '[data-testid="history-item-0-options"]',
    'nav [data-testid$="-options"]',
    'nav button[aria-label*="options" i]',
    'nav button[aria-label*="more" i]',
]


async def _try_delete_conversation(page: Page) -> bool:
    """Best-effort cleanup: this browser exists purely to generate one JSON blob, not to leave a
    real conversation in the user's ChatGPT history - deletes it via the same "..." menu ->
    Delete -> confirm click-path a real user would use. Never lets a failure here affect the
    actual result."""
    options_btn = await _find_now(page, OPTIONS_BUTTON_SELECTORS)
    if options_btn is None:
        return False
    await options_btn.click()

    delete_item = page.locator('[role="menuitem"]', has_text="Delete").or_(page.locator('[data-testid*="delete" i]'))
    try:
        await delete_item.first.wait_for(state="visible", timeout=1500)
    except PlaywrightTimeoutError:
        return False
    await delete_item.first.click()

    dialog = page.locator('[role="dialog"], [role="alertdialog"]')
    try:
        await dialog.first.wait_for(state="visible", timeout=1500)
    except PlaywrightTimeoutError:
        return False
    confirm_btn = dialog.first.get_by_role("button", name="Delete", exact=False)
    if await confirm_btn.count() == 0:
        return False
    await confirm_btn.first.click()
    await page.wait_for_timeout(300)
    return True
