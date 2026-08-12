// Side panels are per-WINDOW by default, not per-tab: manifest.json's side_panel.default_path
// gives every tab in a window the SAME single panel document, which stays alive as you switch
// tabs - so extracting a job description in tab 2 overwrites the exact same Company/Job
// URL/Job Description fields tab 1 is looking at, and switching back to tab 1 shows tab 2's
// data, not tab 1's own. Calling setOptions with a specific tabId is what tells Chrome "this
// tab gets its own independent panel instance" - even though every tab loads the identical
// sidepanel.html, each becomes a separate document/JS state once this has been called for it.
async function makeSidePanelPerTab(tabId) {
  try {
    // The GPT-tab-automation mechanism (runChatGptPrompt in sidepanel.js) opens a real, visible
    // chatgpt.com tab per generation, closing it again once it has the answer - a transient
    // automation target, not a real job-application tab, and nothing in it ever opens or uses
    // a side panel. Giving it its own panel assignment (immediately discarded again when the
    // tab closes moments later) is pure unnecessary churn on top of whatever regular tabs the
    // user already has - every single GPT-auto generation was creating and tearing down one of
    // these extra panel-bearing tabs, a new source of reload-adjacent instability introduced
    // specifically by the GPT integration (not present before it), while contributing nothing -
    // a chatgpt.com tab has no reason to ever need its own per-tab panel in the first place.
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || tab.pendingUrl || "";
    if (/^https:\/\/chatgpt\.com\//.test(url)) return;
    // The tabId is baked directly into the panel's own URL (read synchronously via
    // location.search in sidepanel.js) - NOT re-derived later via chrome.tabs.query("the
    // active tab right now"). Confirmed live: that query-based approach raced against the user
    // switching tabs while a panel was still initializing, occasionally resolving with the
    // WRONG tab's id (whichever tab happened to be active at the moment the query finally
    // settled, not necessarily the one this panel was actually being created for) - two panels
    // could end up both believing they owned the same tab, causing a single keyboard shortcut
    // to fire in both of them at once (reported live: pressing a shortcut once opened 2 ChatGPT
    // tabs instead of 1). Since this tabId is known with certainty right here, baking it into
    // the URL at creation time removes the race entirely.
    await chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tabId=${tabId}`, enabled: true });
  } catch {
    // Tab may have closed/navigated to a disallowed URL (chrome://, etc.) between the event
    // firing and this call landing - nothing to do, it just won't get its own panel.
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  if (details.reason === "install") {
    // Onboarding collects connection + this browser's person name first, then hands off
    // to the full Settings page - instead of dropping straight into a blank options page.
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
  // Deliberately NOT sweeping every already-open tab here anymore (a previous version did,
  // querying every tab across every window and calling chrome.sidePanel.setOptions for each -
  // sequential, not concurrent, but still a real per-tab API sweep run at the exact moment the
  // service worker itself restarts). With many tabs/windows open, that's real, unusual load on
  // Chrome's own extension/tab machinery right during a reload - a plausible contributor to
  // reload-triggered instability that's specific to THIS extension's side-panel-per-tab
  // approach, not something a typical extension without this pattern would ever do. Every
  // pre-existing tab still gets its own panel correctly - just lazily, the next time it's
  // activated (onActivated below), rather than eagerly swept on install/update. A tab that's
  // never touched again simply keeps sharing the window's default panel, same as before this
  // whole per-tab mechanism existed - a graceful fallback, not a broken state.
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) makeSidePanelPerTab(tab.id);
});

// Now the ONLY mechanism for tabs that existed before this install/update, not just a
// defensive backstop for what onInstalled/onCreated missed - each one gets its own panel the
// next time it's actually switched to, instead of all of them being swept eagerly at once.
chrome.tabs.onActivated.addListener(({ tabId }) => makeSidePanelPerTab(tabId));

// Last-resort click mechanism for widgets whose own JS specifically checks event.isTrusted
// before reacting - confirmed live on BambooHR's "Fabric" Select component: a real manual click
// opens its dropdown normally, but no combination of synthetic dispatchEvent-constructed events
// (mousedown/up, click, pointerdown/up, correctly set isPrimary/pointerType/etc.) ever does,
// even though those same events work correctly on every other site tested. isTrusted can NEVER
// be set to true by any script, by deliberate browser design - there is no way to fix this from
// within the page's own JS at all, only by dispatching input at the browser-internals level via
// the Chrome DevTools Protocol, which chrome.debugger exposes and Chrome treats as genuinely
// trusted input. Attaches only for the instant it takes to send one press+release, then detaches
// immediately - the visible "this extension started debugging this browser" banner is a real,
// unavoidable cost of this API, kept as brief as possible and used only as an explicit fallback
// (see trustedClick in sidepanel.js) when the normal, invisible synthetic-click path doesn't
// produce any visible effect - not for every click on every page.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "TRUSTED_CLICK") return false;
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined) {
    sendResponse({ ok: false, error: "No tab id on the sender - message didn't come from a real page." });
    return true;
  }
  (async () => {
    // chrome.debugger.attach() can HANG INDEFINITELY rather than reject when it hits Chrome's
    // own concurrent-debugger-session limit (confirmed live: with several tabs' side panels
    // each independently doing their own trustedClick work, attach() calls piled up and just
    // never resolved at all - not an error, a genuine hang - reported as combobox fills taking
    // multiple minutes each with no error surfaced anywhere). Racing it against a timeout turns
    // that into a normal, fast failure (falls back to sidepanel.js's own non-trusted-click
    // paths) instead of a silent multi-minute stall with nothing to show for it.
    let attached = false;
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("chrome.debugger.attach timed out (likely hit Chrome's concurrent debugger-session limit)")), 4000)
      );
      await Promise.race([chrome.debugger.attach({ tabId }, "1.3"), timeout]);
      attached = true;
      try {
        const clickArgs = { x: message.x, y: message.y, button: "left", clickCount: 1 };
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mousePressed", ...clickArgs });
        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseReleased", ...clickArgs });
      } finally {
        await chrome.debugger.detach({ tabId });
      }
      sendResponse({ ok: true });
    } catch (err) {
      // If attach() eventually resolves AFTER the timeout already gave up, it can leave a real,
      // now-orphaned debugger session attached with nothing to ever detach it - best-effort
      // cleanup attempt, not guaranteed (the late attach may not have landed yet at all).
      if (!attached) {
        chrome.debugger.detach({ tabId }).catch(() => {});
      }
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // keeps sendResponse valid across the async work above
});

// Global keyboard shortcuts (manifest.json's "commands") - fire from anywhere, including the
// job page itself, not just while the side panel has focus. This service worker has no direct
// handle on any specific tab's own side panel document, so it can't call a function in it
// directly - relayed instead via chrome.runtime.sendMessage, which every open side panel
// instance receives (side panels for OTHER tabs can be alive in the background at the same
// time - confirmed live, concurrent GPT generations across several tabs kept running after
// switching away from them). Including the CURRENTLY ACTIVE tab's id lets each side panel
// instance's own listener (sidepanel.js) decide for itself whether this shortcut was actually
// meant for it (compares against the tabId baked into its own URL - see makeSidePanelPerTab),
// rather than every open panel instance acting on it at once.
//
// TEMPORARY diagnostic logging - reported live: shortcuts work for a while after a fresh
// restart, then intermittently stop firing at all (clicking the same button with a mouse always
// still works, ruling out the panel/button logic itself) - narrows down to either this listener
// not firing (MV3 service workers go idle and are woken back up per-event; commands SHOULD
// reliably do this but isn't confirmed live) or the message not reaching the panel. Remove once
// the real cause is confirmed and fixed.
chrome.commands.onCommand.addListener(async (command) => {
  console.log("[shortcut-debug] command fired:", command, new Date().toISOString());
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  console.log("[shortcut-debug] active tab:", tab && tab.id);
  if (!tab || tab.id === undefined) return;
  chrome.runtime
    .sendMessage({ type: "SHORTCUT", command, tabId: tab.id })
    .then(() => console.log("[shortcut-debug] sendMessage resolved (a listener received it)"))
    .catch((err) => console.log("[shortcut-debug] sendMessage rejected:", err.message));
});
