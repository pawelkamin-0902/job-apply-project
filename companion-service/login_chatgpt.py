"""Run this ONCE (venv\\Scripts\\python login_chatgpt.py) to log into chatgpt.com manually in a
real, visible browser window. The session is saved to app/chatgpt_automation.py's own persistent
profile directory - every automated "Generate via ChatGPT" run after this reuses that same saved
login, with no further login step (scripted or otherwise) ever attempted automatically, since
chatgpt.com actively detects and blocks automated logins.

NOTE: confirmed live - Cloudflare's bot-detection and/or Google's own OAuth sign-in protection may
still block this even for a manual, human-driven login inside this automated browser profile, if
either one flags the browser itself (not just scripted actions) as automated. If the login screen
itself won't load or Google refuses to sign you in even when you're doing it by hand, that's this
same protection, not a bug - see chatgpt_automation.py's own top-of-file note."""

import asyncio

from app.chatgpt_automation import BROWSER_PROFILE_DIR
from playwright.async_api import async_playwright


async def main() -> None:
    BROWSER_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(str(BROWSER_PROFILE_DIR), headless=False)
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto("https://chatgpt.com/")
        input("Log into ChatGPT in the window that just opened, then press Enter here once you're logged in... ")
        await context.close()
        print("Session saved - future automated runs will reuse this login.")


if __name__ == "__main__":
    asyncio.run(main())
