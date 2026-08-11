import { apiFetch, checkHealth, fetchResumeFileBase64 } from "./api.js";

const el = (id) => document.getElementById(id);

let lastSavedDir = null;
let lastSavedDirCompany = null;
// The most recently rendered tailored resume PDF, so Auto Fill can attach it on Workday
// without the user needing to separately re-locate the file on disk. Cleared implicitly by
// just being overwritten on the next render — there's no cross-job staleness risk since a new
// render for a different job always replaces it before Auto Fill would ever read it.
let lastGeneratedPdf = null; // { base64, filename }

// Workday hosts every applicant-facing posting on a `myworkdayjobs.com` (or, for some older
// tenants, `myworkday.com`) subdomain — used to scope the auto-attach-resume behavior below to
// Workday only, per explicit instruction: other ATSs' file-upload fields are left for the user
// to handle manually (e.g. they may want to pick a different file there than what's active
// here, or the field simply isn't reliably identifiable enough elsewhere yet).
function isWorkdayHostname(hostname) {
  return /(^|\.)myworkdayjobs\.com$|(^|\.)myworkday\.com$/i.test(hostname || "");
}

// Read synchronously from this panel's own URL (background.js's makeSidePanelPerTab bakes it in
// as ?tabId=<id> at the exact moment it assigns this panel to that specific tab) - NOT derived
// via chrome.tabs.query("the active tab right now"), which an earlier version used. CONFIRMED
// LIVE: that query-based approach raced against the user switching tabs while a panel was still
// initializing, occasionally resolving with the WRONG tab's id, so two panels could both end up
// believing they owned the same tab - a single keyboard shortcut then fired in both at once
// (pressing it once opened 2 ChatGPT tabs instead of 1, only for whichever tab was second in
// that race). Reading it straight from the URL has no such timing dependency at all.
const myTabId = Number(new URLSearchParams(location.search).get("tabId")) || null;

// Always a new tab — reusing one previously (see git history) meant generating a PDF for a
// *different* job silently replaced the tab still showing the last job's PDF, which read as
// data loss/confusion rather than a convenience.
async function openPdfPreview(pdfBase64) {
  const dataUrl = `data:application/pdf;base64,${pdfBase64}`;
  // Opened in the background (active: false), not focused - explicitly requested, so it doesn't
  // interrupt whatever tab the user is actually looking at. The tab is still there, ready to
  // switch to whenever they actually want to look at the PDF.
  await chrome.tabs.create({ url: dataUrl, active: false });
}

// Mirrors the companion-service's own strip_json_fences (app/utils.py) - a model's raw text
// reply is often wrapped in a ```json ... ``` fence even when explicitly asked not to.
function stripJsonFences(text) {
  let t = (text || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\n/, "");
    t = t.replace(/\n```$/, "");
  }
  return t.trim();
}

// Defensive second layer against the exact bug confirmed live: a raw newline (or other
// control character) landing INSIDE a JSON string value, which JSON.parse rejects outright
// ("Bad control character in string literal"). The whitespace BETWEEN tokens (indentation,
// the newlines separating object keys) is completely fine and must be left alone - only
// control characters found while inside a quoted string are the problem. Walks the text
// tracking whether the current position is inside a string (respecting \" escapes) and
// escapes any raw control character found there to its standard JSON escape sequence.
function sanitizeJsonControlChars(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString && !escaped && ch.charCodeAt(0) < 0x20) {
      if (ch === "\n") result += "\\n";
      else if (ch === "\r") result += "\\r";
      else if (ch === "\t") result += "\\t";
      else result += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
      continue;
    }
    result += ch;
    if (escaped) {
      escaped = false;
    } else if (ch === "\\" && inString) {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    }
  }
  return result;
}

// The shared mechanism both resume-generation-via-GPT and Auto-Fill-via-GPT are built on: opens
// a real, visible chatgpt.com tab (NOT background - a background/inactive tab gets throttled by
// Chrome's own power-saving timer throttling, which would make the polling loops inside
// submitChatGptPromptInPage far slower and less reliable than watching a real, focused tab),
// submits the prompt, waits for and extracts the response, then closes the tab regardless of
// success or failure. Returns the raw response text - callers decide how to parse it (a
// resume-JSON prompt vs. an answer-matching prompt might want different handling of malformed
// output).
//
// CONFIRMED: an out-of-band Playwright browser (companion-service, no visible tab at all - same
// idea as the Portal sync) was tried here and does NOT work for chatgpt.com specifically, unlike
// the Portal - reported live, Cloudflare's own bot-detection blocked the page outright ("Just a
// moment..." challenge screen), and separately, Google's own OAuth sign-in refused to complete
// ("Couldn't sign you in - this browser or app may not be secure"). Both are real, deliberate
// anti-automation protections (a different company each), not bugs to route around - this tab-
// based approach works BECAUSE it reuses the user's own real, human-authenticated browser
// session/fingerprint instead of a separate automated one, which is why it has to stay this way.
// TEMPORARY diagnostic trail (onProgress) - reported live: even after the chrome.debugger
// session-limit fix below, a generation still got stuck at "Opening ChatGPT tab and
// generating..." under conditions that don't match that specific theory anymore (as few as one
// other tab running, not specifically the 5th of five). Rather than guess a third fix blind,
// this surfaces exactly which awaited step it's actually stuck on, directly in the status text -
// remove once the real bottleneck is confirmed live and fixed.
async function runChatGptPrompt(prompt, deleteConversation = true, onProgress) {
  const notify = (msg) => {
    try {
      if (onProgress) onProgress(msg);
    } catch {
      // Never let a progress-reporting bug affect the actual generation.
    }
  };
  // Opened in the BACKGROUND (active: false), not focused - explicitly requested, so several of
  // these can run without repeatedly interrupting whatever tab/app the user is actually looking
  // at. The chrome.debugger-based fix below (Page.setWebLifecycleState/
  // Emulation.setFocusEmulationEnabled) is what's meant to keep this reliable despite never being
  // the visible/active tab - not real OS/tab focus, which is exactly what this is now avoiding.
  notify("creating tab...");
  const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
  notify(`tab ${tab.id} created`);
  let debuggerAttached = false;
  try {
    // Confirmed live: a tab that isn't the visible/active one stalls its own generation - it
    // only actually finishes (correctly, in full) once brought back into focus. Chrome throttles
    // a tab's own JS timers/rendering once it's no longer visible - this tab is now created
    // backgrounded on purpose (explicitly requested, so it doesn't keep interrupting whatever
    // the user is actually doing), so it NEEDS the fix below to behave correctly despite that.
    //
    // The actual fix: chrome.debugger (Chrome DevTools Protocol) - the same mechanism
    // background.js's TRUSTED_CLICK handler already relies on for genuinely trusted clicks - can
    // tell Chrome to keep this specific page in its "active" lifecycle state and emulate
    // permanent focus, regardless of what's actually on screen. Real, unavoidable cost: shows
    // Chrome's own "this extension started debugging this browser" banner on this tab for as
    // long as generation is running - detached the moment it finishes (see the `finally` below).
    //
    // CONFIRMED LIVE: chrome.debugger.attach() can BLOCK INDEFINITELY (not error out, not time
    // out on its own) once Chrome's own limit on simultaneous debugger sessions per extension is
    // reached - reported live as "running 5 'Generate JSON' tabs at once, the 5th gets stuck on
    // 'Opening ChatGPT tab...' until all 4 OTHER ones finish and close." A real Chrome-imposed
    // constraint, not a bug in this codebase's own logic - but letting it block the ENTIRE
    // generation (rather than just this one optional protection) was. Raced against a short
    // timeout instead: if a session isn't granted quickly, this generation proceeds without the
    // debugger-based throttling protection (falling back to the tab/window-focus mitigations
    // below), rather than hanging indefinitely.
    notify("attaching debugger...");
    let gaveUpWaitingForDebugger = false;
    const debuggerAttachChain = chrome.debugger
      .attach({ tabId: tab.id }, "1.3")
      .then(async () => {
        if (gaveUpWaitingForDebugger) {
          // Resolved AFTER we already moved on without it - no longer useful for this
          // generation (we're not going back to send the commands below at this point), so
          // release the session immediately rather than leaving it attached - and consuming one
          // of Chrome's limited concurrent-session slots - until this tab eventually closes.
          await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
          return;
        }
        debuggerAttached = true;
        await chrome.debugger
          .sendCommand({ tabId: tab.id }, "Page.setWebLifecycleState", { state: "active" })
          .catch(() => {});
        await chrome.debugger
          .sendCommand({ tabId: tab.id }, "Emulation.setFocusEmulationEnabled", { enabled: true })
          .catch(() => {});
      })
      .catch(() => {});
    const debuggerTimedOut = await Promise.race([
      debuggerAttachChain.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 4000)),
    ]);
    if (debuggerTimedOut) gaveUpWaitingForDebugger = true;
    notify(`debugger step done (timedOut=${debuggerTimedOut}, attached=${debuggerAttached})`);
    // Belt-and-suspenders alongside the debugger-based fix above, cheap and harmless either way -
    // stops Chrome from evicting/discarding this tab under memory pressure while it's not the
    // visible one. Deliberately NOT also focusing its window (an earlier version did) - the tab
    // is now opened in the background on purpose (see above), and forcing window focus would
    // undo exactly that, yanking the user's attention away from whatever they're actually doing
    // just as much as switching to the tab itself would.
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch {
      // Not worth failing the whole call over.
    }
    notify("waiting for tab to finish loading...");
    await new Promise((resolve) => {
      let settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
      function onUpdated(tabId, info) {
        if (tabId === tab.id && info.status === "complete") finish();
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      // Guards a real race: if the tab already reached "complete" before this listener
      // attached (an instant/cached load can finish before chrome.tabs.create even resolves
      // here), that transition already happened and won't fire again - this promise would
      // otherwise hang forever. chrome.tabs.onUpdated listeners aren't scoped to a tab's
      // lifetime either, so a hang here permanently leaks this listener in the side panel's
      // own long-lived context (it stays alive as long as the window's side panel does, not
      // just for this one call) - same for a tab closed early by the user before "complete"
      // ever fires. The timeout below is the general-case backstop for both.
      chrome.tabs.get(tab.id).then((t) => {
        if (t.status === "complete") finish();
      }).catch(() => finish()); // tab already gone - nothing left to wait for
      const timer = setTimeout(finish, 20000);
    });
    notify("tab finished loading");
    // ChatGPT's own app still needs a moment to hydrate after the browser's "complete" status
    // fires (React mounts asynchronously) - submitChatGptPromptInPage's own internal polling
    // handles most of this, but a short head start avoids hammering the page mid-hydration.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Deliberately NOT periodically re-activating/focusing this tab during generation (an
    // earlier version did, via a repeating chrome.tabs.update({active:true})) - confirmed live,
    // that visibly yanked the user BACK to this tab every few seconds even after they'd
    // deliberately switched to another one, which is worse than the problem it was trying to
    // solve. The chrome.debugger-based fix above is the actual mechanism meant to let this run
    // to completion without ever needing to be the visible/active tab at all - if it turns out
    // insufficient on its own, the fix belongs in strengthening that, not in stealing the tab
    // back by force.
    notify("starting executeScript (fill/send/wait/extract)...");
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: submitChatGptPromptInPage,
      args: [prompt, deleteConversation],
    });
    notify("executeScript returned");
    if (!injection || !injection.result) throw new Error("No response came back from the ChatGPT tab.");
    if (!injection.result.ok) throw new Error(injection.result.error || "ChatGPT tab automation failed.");
    return injection.result.text;
  } finally {
    if (debuggerAttached) {
      try {
        await chrome.debugger.detach({ tabId: tab.id });
      } catch {
        // Tab may already be gone - not worth failing over.
      }
    }
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // Tab may have already been closed by the user - not worth failing the whole call over.
    }
  }
}

// Separate, experimental 5th provider option ("gpt-auto-headless") - companion-service's own
// out-of-band Playwright browser (app/chatgpt_automation.py), no visible tab at all. Kept
// distinct from "gpt-auto" above (which reverted to the tab-based approach - the ONLY one
// confirmed working) since this one is blocked by Cloudflare's bot-detection and/or Google's own
// OAuth sign-in protection as of this writing - not reliable enough to be anyone's default, but
// left available in case a way through ever presents itself. Requires a one-time manual login
// into that browser's own profile first (companion-service/login_chatgpt.py) - never attempts
// any login itself.
async function runChatGptPromptHeadless(prompt, deleteConversation = true) {
  const result = await apiFetch("/chatgpt-prompt", {
    method: "POST",
    body: JSON.stringify({ prompt, delete_conversation: deleteConversation }),
  });
  if (!result.ok) throw new Error(result.error || "ChatGPT automation failed.");
  return result.text;
}

async function refreshStatus() {
  const ok = await checkHealth();
  el("status").textContent = ok
    ? "● Backend connected"
    : "○ Backend not running — start it (start.bat) and reopen this panel";
  el("status").className = ok ? "status ok" : "status bad";
  return ok;
}

async function applyTailorMode() {
  try {
    // Per-person, not global (separate endpoint from /settings) - confirmed live, different
    // people using this same install have different preferences (some tailor a resume per job,
    // some always use one uploaded resume as-is), so this can't be one shared flag alongside
    // provider/model settings the way it used to be - same reasoning as resume templates below.
    const [settings, tailorModeChoice] = await Promise.all([apiFetch("/settings"), apiFetch("/tailor-mode")]);
    const tailorMode = tailorModeChoice.tailor_mode !== false;
    el("tailorSection").style.display = tailorMode ? "" : "none";
    el("nonTailorSection").style.display = tailorMode ? "none" : "";
    if (!tailorMode) loadResumesForPicker();

    // "gpt" (fully manual copy/paste) is the only provider needing the separate
    // copyPromptBtn UI - "gpt-auto" still uses the same "Generate JSON" button as
    // claude/ollama, just with different logic behind it (see generateBtn's click handler).
    const isManualGpt = settings.provider === "gpt";
    el("generateBtn").style.display = isManualGpt ? "none" : "";
    el("copyPromptBtn").style.display = isManualGpt ? "" : "none";

    // These three are edited right here, not just displayed — Mode and both providers get
    // changed often enough mid-session (which job, which provider is up) that tabbing over
    // to Settings for them would be annoying. Settings keeps the deeper config (model names,
    // Ollama URL, prompt instructions) plus a "Test connection" button for each provider.
    //
    // Confirmed live: this function re-runs on every window "focus"/document "visibilitychange"
    // event, not just once on initial load - and clicking directly into an unfocused side panel
    // (e.g. the very first click on any control, including one of these) fires exactly such a
    // "focus" event on this SAME click. That triggered an applyTailorMode() re-fetch racing
    // against the click's own save still in flight, re-fetching a not-yet-updated /settings and
    // immediately stomping the control right back - reported live as "the headless checkbox
    // isn't checkable" (it visibly never seemed to register a click at all). Every control this
    // function sets is now skipped while it's the currently focused element (the standard "don't
    // overwrite what the user is actively interacting with" guard) - same class of bug, and same
    // reasoning, as loadResumesForPicker's own preserved-selection fix elsewhere in this file.
    const activeEl = document.activeElement;
    if (activeEl !== el("tailorModeSelect")) el("tailorModeSelect").value = String(tailorMode);
    if (activeEl !== el("providerSelect")) el("providerSelect").value = settings.provider || "claude";
    if (activeEl !== el("answerProviderSelect")) el("answerProviderSelect").value = settings.answer_provider || "ollama";

    // Same reasoning as the three above - only relevant once either provider is actually
    // "gpt-auto", and worth toggling mid-session without a trip to Settings, since that's
    // exactly when you'd want to temporarily uncheck it (a result looked wrong and you need to
    // go back and inspect the real ChatGPT conversation instead of it auto-deleting).
    const usesGptAuto =
      settings.provider === "gpt-auto" ||
      settings.answer_provider === "gpt-auto" ||
      settings.provider === "gpt-auto-headless" ||
      settings.answer_provider === "gpt-auto-headless";
    el("gptAutoOptions").style.display = usesGptAuto ? "" : "none";
    if (activeEl !== el("deleteGptConversationsToggle")) {
      el("deleteGptConversationsToggle").checked = settings.delete_gpt_conversations !== false;
    }
    // Checkbox is phrased as "show the window" (headful), the more intuitive way round for a
    // user to think about it - inverse of the actual portal_headless setting underneath.
    if (activeEl !== el("portalHeadful")) el("portalHeadful").checked = settings.portal_headless === false;

    await syncTemplateSelect();
  } catch {
    // Backend not reachable yet (e.g. not configured) — default to showing tailor mode.
  }
}

// The template catalog (/resume-templates) is the same for everyone, so its options only
// need populating once; which one is active is per-person, re-synced every time
// applyTailorMode() runs (init, focus, visibilitychange, refresh, and after a switch here).
let templateOptionsLoaded = false;

async function syncTemplateSelect() {
  if (!templateOptionsLoaded) {
    const templates = await apiFetch("/resume-templates");
    const select = el("templateSelect");
    select.innerHTML = "";
    templates.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.key;
      opt.textContent = t.name;
      select.appendChild(opt);
    });
    templateOptionsLoaded = true;
  }
  const { template } = await apiFetch("/resume-template");
  el("templateSelect").value = template;
}

function suggestResumeIndex(resumes, jobDescription) {
  if (!jobDescription) return -1;
  const text = jobDescription.toLowerCase();
  let bestIndex = -1;
  let bestScore = 0;
  resumes.forEach((r, i) => {
    const stackWords = r.stack.toLowerCase().split(/\s+/).filter(Boolean);
    const score = stackWords.filter((w) => text.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  });
  return bestIndex;
}

async function loadResumesForPicker() {
  const select = el("resumeSelect");
  const hint = el("resumeSuggestHint");
  try {
    const resumes = await apiFetch("/resumes");
    // Confirmed live: this function re-runs every time the panel regains focus/visibility (see
    // applyTailorMode's own callers - window "focus", document "visibilitychange") - rebuilding
    // the whole <select> from scratch and re-applying the auto-suggested resume EVERY time was
    // silently wiping out a resume the user had manually picked back to the original suggestion,
    // with no visible indication anything had changed - reported live as "I changed the resume,
    // clicked Attach, and the dropdown had reverted to the suggested one" (and, worse, it had
    // very plausibly just attached that wrong reverted file instead of the one actually chosen).
    // Preserves whatever was already selected (by id) across a rebuild, same as any of this
    // codebase's other "don't clobber the user's own in-progress choice on an unrelated
    // refresh" fixes - only actually falls back to computing a fresh suggestion when nothing was
    // selected before, or that resume no longer exists in the reloaded list (e.g. deleted).
    const previouslySelectedId = select.value || null;
    select.innerHTML = "";
    if (!resumes.length) {
      select.innerHTML = '<option value="">(none uploaded — add one in Settings)</option>';
      hint.textContent = "";
      return;
    }
    resumes.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = `${r.stack} — ${r.filename}`;
      // Kept independently retrievable from the display text - the Portal-log feature needs
      // the resume's own raw tech-stack string on its own, not concatenated with the filename.
      opt.dataset.stack = r.stack;
      // Attach uses this when Content-Disposition parsing is flaky (Starlette only sends
      // filename*= for names with spaces — see fetchResumeFileBase64). Prefer the authoritative
      // name from /resumes over whatever the file-download header happens to parse as.
      opt.dataset.filename = r.filename || "";
      select.appendChild(opt);
    });
    if (previouslySelectedId && resumes.some((r) => String(r.id) === previouslySelectedId)) {
      select.value = previouslySelectedId;
      // Clears any stale "Suggested based on..." hint left over from before - once a choice
      // (suggested or manual) is being preserved rather than freshly computed, re-showing an old
      // suggestion note next to it would be misleading if the user had since picked something
      // else entirely.
      hint.textContent = "";
      return;
    }
    const suggestedIndex = suggestResumeIndex(resumes, el("jobDescription").value.trim());
    if (suggestedIndex >= 0) {
      select.selectedIndex = suggestedIndex;
      hint.textContent = `Suggested based on the job description: "${resumes[suggestedIndex].stack}"`;
    } else {
      hint.textContent = "";
    }
  } catch (err) {
    hint.textContent = `Could not load resumes: ${err.message}`;
  }
}

// Injected into the page — must be fully self-contained. Attaches a file to whichever
// file-upload input is actually the real Resume/CV field — a real form can have several file
// inputs beyond just cover-letter/photo/portfolio-style ones: a lot of ATSs (Ashby, LinkedIn-
// style "Easy Apply", etc.) ALSO show a separate "autofill your whole application from your
// resume" convenience widget, which is a fundamentally different target — that one triggers
// the site's own parsing to fill OTHER sections, not the thing that actually gets submitted as
// the resume attachment. Grabbing the first file input blindly risks hitting that widget
// instead of the real, explicitly-labeled "Resume" field. Fetches the resume's bytes in the
// side panel first (that request needs the extension's own permissions/host access, not the
// page's — a page's CSP could otherwise block it), then passes them in as a base64 string
// since raw bytes/Files can't cross the executeScript args boundary either.
function attachResumeFileInPage(base64, filename, mimeType, isWorkday) {
  // Must match field-detector.js's cleanedText: Workable (and others) put decorative
  // <svg><desc><p>SVGs not supported by this browser.</p></desc></svg> icons next to /
  // inside upload chrome. Plain .textContent includes that fallback, so a real Resume
  // field's first label[for] (the drop-zone preview icon) resolves to ONLY that SVG
  // string — confirmed live on apply.workable.com (cavalry-freelancing capture): both
  // Photo and Resume inputs reported "SVGs not supported by this browser.", RESUME_RE
  // never matched, and the two-candidate fallback refused to guess.
  function cleanedText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"], svg, script, style, button').forEach((n) => n.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Pierces open shadow roots on custom elements (e.g. SmartRecruiters' <spl-dropzone>) the
  // same way collectShadowElements does for other field types — a plain document.querySelectorAll
  // never reaches into shadow DOM at all, regardless of open/closed. Closed shadow roots are
  // still genuinely inaccessible; those fall through as "not found", same as before.
  //
  // Confirmed live: ats.rippling.com's own resume input is real markup `type="File"` (capital
  // F) - `input[type="file"]` is a CSS ATTRIBUTE selector, which matches the literal attribute
  // VALUE case-sensitively (unlike the browser's own normalized `.type` IDL property, which
  // ALWAYS reflects as lowercase regardless of source casing) - so that selector silently missed
  // a real, working file input entirely, wrongly reporting "no Resume/CV upload field found."
  // Filtering plain `<input>` elements by the normalized `.type` property instead sidesteps this
  // class of bug entirely, matching what the browser itself actually treats as a file input.
  function collectFileInputs(root) {
    const found = [...root.querySelectorAll("input")].filter((input) => input.type === "file");
    for (const host of root.querySelectorAll("*")) {
      if (host.tagName.includes("-") && host.shadowRoot) found.push(...collectFileInputs(host.shadowRoot));
    }
    return found;
  }

  // A `role="group"` ancestor's own `aria-labelledby` is the authoritative field identity for
  // upload widgets that offer several action buttons (Attach/Dropbox/Google Drive/Enter
  // manually) - confirmed live on Greenhouse, where every one of those buttons/labels just says
  // generic action text ("Attach"), and the REAL name ("Resume/CV") lives only on the outer
  // `<div role="group" aria-labelledby="upload-label-resume">` wrapper, not on anything directly
  // associated with the `<input>` itself. Checked first, since a `label[for]` match here would
  // otherwise win with that generic "Attach" text before ever reaching this.
  function findGroupContextLabel(input) {
    let node = input.parentElement || (input.getRootNode() && input.getRootNode().host);
    for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement || (node.getRootNode && node.getRootNode().host)) {
      if (node.getAttribute && node.getAttribute("role") === "group") {
        const labelledby = node.getAttribute("aria-labelledby");
        if (labelledby) {
          const text = labelledby
            .split(/\s+/)
            .map((id) => cleanedText(document.getElementById(id)))
            .filter(Boolean)
            .join(" ");
          if (text) return text;
        }
      }
    }
    return null;
  }

  // Signals a "parse my resume to autofill the rest of this form" convenience widget, distinct
  // from the actual Resume/CV attachment field — confirmed live on Ashby ("Autofill from
  // resume") and a LinkedIn-style "Easy Apply" flow ("Choose an option to autocomplete your
  // application"). On Workday specifically this same kind of widget IS the real, required
  // target (it's the mandatory first step of that flow), so this check is skipped there.
  const AUTOPARSE_RE = /easy apply|auto-?fill|autocomplete (your|the) (application|profile)|parse (your|the) resume/i;

  // BambooHR Fabric's own FileUpload widget stamps every real <input type="file"> with the
  // literal aria-label "file-input" — widget chrome, not the field's question. Same category
  // as a combobox's generic "Select" aria-label (see isGenericSelectPlaceholder in
  // field-detector.js): trusting it makes EVERY BambooHR upload on the page resolve to the
  // identical string "file-input", so the Resume regex never matches and the single-candidate
  // fallback also refuses to guess when a second upload (portfolio/etc.) is present.
  // Confirmed live on inibuilds.bamboohr.com/careers/35 (Resume* + a portfolio archive upload).
  function isGenericFileAriaLabel(text) {
    return /^(file[- ]?input|upload|choose file|browse|no file (chosen|selected))$/i.test((text || "").trim());
  }

  // Rippling (and similar drop-zone UIs) wrap the real <input type="File"> in a <label> whose
  // OWN visible text is only the drop-zone instruction ("Drop or select (.doc / .docx / .pdf)"),
  // while the real field title ("Résumé" / "Cover letter") lives outside that <label> and is
  // referenced via the label's aria-labelledby. Confirmed live on
  // ats.rippling.com/.../apply (aalyria-careers capture): both Resume and Cover letter resolved
  // to the identical chrome string, RESUME_RE never matched, and the single-candidate fallback
  // refused to guess between the two.
  function isGenericFileDropChrome(text) {
    const t = (text || "").trim();
    if (!t) return true;
    // Workable SVG <desc> fallback can be the entire "label" when icons aren't stripped.
    if (/svgs? not supported/i.test(t)) return true;
    // join.com Chakra FileUpload trigger/dropzone copy — confirmed live on
    // join.com/.../apply/cv (chonova capture): both Resume inputs resolved to "Upload file" /
    // "Click to browse, or drag & drop…" so RESUME_RE never matched and the two-candidate
    // fallback refused to guess.
    if (/^upload file$/i.test(t)) return true;
    if (/^click to browse\b/i.test(t)) return true;
    if (/^the file size limit\b/i.test(t)) return true;
    return /^(drop or select\b|drop files?( here)?|choose files?|browse|select files?|no file (chosen|selected)|total \d+ files? selected|or drag and drop( here)?)/i.test(
      t
    );
  }

  function resolveFileInputLabel(input) {
    // Workable stamps the real upload purpose on the input itself (`data-ui="resume"` /
    // `data-ui="avatar"`). Checked early — same idea as Rippling's data-testid — so a
    // mis-resolved SVG/"Choose file" label[for] can't hide a clearly identified Resume.
    const dataUi = (input.getAttribute("data-ui") || "").trim();
    if (/^resume$/i.test(dataUi)) return "Resume";
    if (/^(avatar|photo|picture|headshot)$/i.test(dataUi)) return "Photo";

    // join.com: `[data-testid="ResumeField"]` wraps the real CV Chakra FileUpload (the visible
    // trigger only says "Upload file"). Prefer this over chrome text.
    if (input.closest && input.closest('[data-testid="ResumeField"]')) return "Resume";
    // Sibling dropzone under the same "Upload your CV" step (outside ResumeField) — still CV.
    let joinNode = input.parentElement;
    for (let d = 0; d < 8 && joinNode; d++, joinNode = joinNode.parentElement) {
      if (joinNode.querySelector && joinNode.querySelector('[data-testid="ResumeField"]')) {
        const heading = cleanedText(joinNode);
        if (/\b(upload your cv|upload your resume|resume|curriculum vitae|\bcv\b)\b/i.test(heading.slice(0, 200))) {
          return "Resume";
        }
        break;
      }
    }
    // Prefer the host's data-test / nearby section title for SmartRecruiters dropzones
    // (label="" on the custom element; real name is "Resume" in spl-typography-title).
    const dropHost =
      (input.getRootNode && input.getRootNode().host) ||
      (input.closest && input.closest("spl-dropzone"));
    if (dropHost) {
      const testId = (dropHost.getAttribute("data-test") || "").trim();
      if (/^resume-upload$/i.test(testId)) return "Resume";
      if (/apply-with-resume/i.test(testId)) return "Apply with resume";
      const section = dropHost.closest && dropHost.closest(".form-section, oc-resume-upload");
      const sectionTitle = section && cleanedText(section.querySelector('[data-test="section-title"], spl-typography-title'));
      if (sectionTitle && sectionTitle.length < 80 && !isGenericFileDropChrome(sectionTitle)) return sectionTitle;
    }

    const groupLabel = findGroupContextLabel(input);
    if (groupLabel) return groupLabel;
    if (input.id) {
      // Workable's dropzone has MULTIPLE label[for=id]: an SVG-only preview icon first,
      // then the visible "Choose file" button. querySelector returns the first (SVG), which
      // used to win with garbage text before aria-labelledby ("Resume") was ever consulted.
      for (const labelEl of document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`)) {
        const text = cleanedText(labelEl);
        if (text && !isGenericFileDropChrome(text) && !isGenericFileAriaLabel(text)) {
          return text;
        }
      }
    }
    const parentLabel = input.closest("label");
    if (parentLabel) {
      // Prefer the wrapping <label>'s aria-labelledby over its textContent — see
      // isGenericFileDropChrome. Rippling's label points at both a "Total 0 file selected"
      // status node and the real title node ("Résumé"); joining them still matches RESUME_RE.
      const labelledby = parentLabel.getAttribute("aria-labelledby");
      if (labelledby) {
        const text = labelledby
          .split(/\s+/)
          .map((id) => cleanedText(document.getElementById(id)))
          .filter(Boolean)
          .join(" ");
        if (text && !isGenericFileDropChrome(text)) return text;
      }
      // data-testid="resume" / "cover_letter" on Rippling's wrapping <label> (and
      // data-testid="input-resume" on the <input> itself) is an authoritative field identity
      // when the visible title isn't reachable any other way.
      const labelTestId = (parentLabel.getAttribute("data-testid") || "").trim();
      if (/^resume$/i.test(labelTestId)) return "Resume";
      if (/^cover[_-]?letter$/i.test(labelTestId)) return "Cover letter";
      const parentText = cleanedText(parentLabel);
      if (parentText && !isGenericFileDropChrome(parentText) && !isGenericFileAriaLabel(parentText)) {
        return parentText;
      }
    }
    const inputTestId = (input.getAttribute("data-testid") || "").trim();
    if (/^input-resume$/i.test(inputTestId) || /^resume$/i.test(inputTestId)) return "Resume";
    if (/^input-cover[_-]?letter$/i.test(inputTestId) || /^cover[_-]?letter$/i.test(inputTestId)) {
      return "Cover letter";
    }
    const labelledby = input.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => cleanedText(document.getElementById(id)))
        .filter(Boolean)
        .join(" ");
      if (text && !isGenericFileDropChrome(text)) return text;
    }
    const ariaLabel = input.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim() && !isGenericFileAriaLabel(ariaLabel) && !isGenericFileDropChrome(ariaLabel)) {
      return ariaLabel.trim();
    }

    // BambooHR Fabric FileUpload: the real field name is a sibling BodyText <p> ("Resume*")
    // immediately before `[data-fabric-component="FileUpload"]`, not a <label for> and not on
    // the input itself. Checked before the generic <label>-only ancestor climb below so that
    // climb's multi-file-input bail-out (two uploads share a common ancestor on this form)
    // can't skip the one signal that actually distinguishes Resume from portfolio.
    const fileUpload = input.closest && input.closest('[data-fabric-component="FileUpload"]');
    if (fileUpload) {
      const prev = fileUpload.previousElementSibling;
      const prevText = cleanedText(prev);
      if (prevText && prevText.length < 200 && !isGenericFileAriaLabel(prevText) && !isGenericFileDropChrome(prevText)) {
        return prevText;
      }
      // Hidden companion field BambooHR posts alongside the widget (`name="resumeFileId"`).
      // Useful when BodyText is missing on a future markup variant; "resumeFileId" still
      // matches RESUME_RE via the "resume" substring.
      const host = fileUpload.parentElement;
      if (host) {
        for (const hidden of host.querySelectorAll('input[type="hidden"][name]')) {
          const n = (hidden.getAttribute("name") || "").trim();
          if (n && /resume|r[ée]sum[ée]|\bcv\b/i.test(n)) return n;
        }
      }
    }

    // Ancestor proximity search, same idea as the main field's label resolver: walk up a few
    // levels looking for the nearest <label>, bailing out early if that ancestor holds more
    // than one file input at all — too ambiguous to trust which one it's actually labeling.
    // getRootNode() so this still works from inside a shadow root, where a plain parentElement
    // walk would otherwise stop dead at the shadow boundary.
    let node = input.parentElement || (input.getRootNode() && input.getRootNode().host);
    for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement || (node.getRootNode && node.getRootNode().host)) {
      // Same normalized `.type === "file"` check as collectFileInputs — a CSS
      // `input[type="file"]` attribute selector misses Rippling's real `type="File"`.
      if (node.querySelectorAll && [...node.querySelectorAll("input")].filter((el) => el.type === "file").length > 1) break;
      const label = node.querySelector && node.querySelector("label");
      if (label && cleanedText(label) && !isGenericFileDropChrome(cleanedText(label))) {
        return cleanedText(label);
      }
      // Rippling: the visible title is a sibling span (id="field-8-label") of the drop-zone
      // column, not inside the <label>. Once we've climbed to the field row, prefer a short
      // preceding title span over drop-zone chrome.
      if (node.getAttribute && node.getAttribute("data-testid") === "field") {
        const title = node.querySelector('[id$="-label"], [class*="label"]');
        const titleText = cleanedText(title);
        if (titleText && titleText.length < 80 && !isGenericFileDropChrome(titleText)) return titleText;
      }
    }
    return input.getAttribute("name") || "";
  }

  function isAutoParseWidget(input) {
    if (isWorkday) return false;
    // SmartRecruiters Easy Apply "parse resume to autofill" dropzone — distinct from the real
    // Resume section (`data-test="resume-upload"`). Confirmed live on jobs.smartrecruiters.com
    // oneclick-ui: both are <spl-dropzone>; only the latter is the CV attachment target.
    if (
      input.closest &&
      (input.closest('oc-apply-with-resume, spl-dropzone[data-test="apply-with-resume-container"]') ||
        (input.getRootNode &&
          input.getRootNode().host &&
          input.getRootNode().host.closest &&
          input.getRootNode().host.closest('oc-apply-with-resume, spl-dropzone[data-test="apply-with-resume-container"]')))
    ) {
      return true;
    }
    let node = input.parentElement || (input.getRootNode() && input.getRootNode().host);
    for (let depth = 0; depth < 4 && node; depth++, node = node.parentElement || (node.getRootNode && node.getRootNode().host)) {
      // Same guard as resolveFileInputLabel's ancestor climb: once an ancestor holds more than
      // one file input, a heading found there could belong to either one — stop rather than
      // risk attributing a DIFFERENT field's "autofill" heading to this one (confirmed via a
      // synthetic test: without this, a real "Resume" field sharing a common body-level
      // ancestor with a separate "Autofill from resume" widget got wrongly flagged too, since
      // querySelector searches the whole subtree, not just what's actually near this field).
      // Normalized `.type` — see collectFileInputs / Rippling `type="File"`.
      if (node.querySelectorAll && [...node.querySelectorAll("input")].filter((el) => el.type === "file").length > 1) break;
      const heading = node.querySelector && node.querySelector("h1, h2, h3, h4, p");
      if (heading && AUTOPARSE_RE.test(cleanedText(heading))) return true;
    }
    return false;
  }

  const RESUME_RE = /\b(resume|r[ée]sum[ée]|\bcv\b|curriculum vitae)\b/i;
  const EXCLUDE_RE =
    /cover letter|cover ltr|photo|picture|headshot|portfolio|writing sample|transcript|additional (file|document|attachment)|other (file|document|attachment)|references?\b/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Same normalized-property reasoning as collectFileInputs' own fix above - checks the real
  // `.type` IDL property, not a case-sensitive `[type="file"]` attribute-value match.
  function hasFileInput(el) {
    return [...el.querySelectorAll("input")].some((input) => input.type === "file");
  }

  // Confirmed live: SAP SuccessFactors' own "attachmentComponentInput" widget (a custom, styled
  // upload UI - real markup: `<div class="RCMFormField ... attachmentField">` containing a
  // `.rcmFormFieldLabel` like "Resume:" and an `.attachActions` "Add attachments" trigger with
  // its own `.addAttachments` icon) renders NO <input type="file"> anywhere in the DOM at all
  // until that trigger is clicked - collectFileInputs finds nothing on a first pass over such a
  // page, wrongly reporting "no Resume/CV upload field found" even though one is genuinely
  // there, just not revealed yet. Finds any such widget whose OWN visible label matches
  // Resume/CV (the same RESUME_RE/EXCLUDE_RE distinction already used below for real <input>
  // labels), clicks its trigger, and gives the page a moment to reveal the real file input -
  // same before/after-visibility-snapshot idea already used elsewhere in this codebase for
  // revealing hidden widgets (e.g. Portal's Company autocomplete, react-select menus).
  async function revealSuccessFactorsAttachmentInputs() {
    for (const field of document.querySelectorAll(".RCMFormField.attachmentField")) {
      if (hasFileInput(field)) continue; // already revealed
      const labelText = cleanedText(field.querySelector(".rcmFormFieldLabel"));
      if (!labelText || EXCLUDE_RE.test(labelText) || !RESUME_RE.test(labelText)) continue;
      // Confirmed live: the real onclick handler lives on `.attachActions` itself (and its own
      // `.addAttachments` icon child) - NOT on the outer `.attachmentBtn` wrapper div, which has
      // no handler of its own at all. Clicking that outer wrapper wouldn't fire anything, since a
      // click dispatched at an element never reaches handlers on its DESCENDANTS, only itself and
      // its ancestors.
      const trigger = field.querySelector(".attachActions, .addAttachments");
      if (!trigger) continue;
      trigger.click();
      for (let attempt = 0; attempt < 15 && !hasFileInput(field); attempt++) {
        await sleep(200);
      }
    }
  }

  // Confirmed live: HiBob's own Angular-based upload widget (custom element
  // `<careers-ui-upload-document-control>`, with a preceding `.label` div holding the field's
  // real name, e.g. "Resume", and a plain `<button type="button">Add file</button>` trigger)
  // ALSO renders no `<input type="file">` anywhere in the page at all until that button is
  // clicked - the same "nothing to find on a first pass" shape as SuccessFactors above, just a
  // different framework/markup entirely. Polls GLOBALLY (not just within the widget's own
  // subtree) for whatever NEW file input appears after clicking, since it isn't confirmed
  // whether Angular inserts it back inside this same custom element or elsewhere in the DOM.
  async function revealHibobAttachmentInputs() {
    for (const widget of document.querySelectorAll("careers-ui-upload-document-control")) {
      if (hasFileInput(widget)) continue; // already revealed
      const labelText = cleanedText(widget.querySelector(".label"));
      if (!labelText || EXCLUDE_RE.test(labelText) || !RESUME_RE.test(labelText)) continue;
      const trigger = widget.querySelector("button");
      if (!trigger) continue;
      const beforeCount = collectFileInputs(document).length;
      trigger.click();
      for (let attempt = 0; attempt < 15 && collectFileInputs(document).length === beforeCount; attempt++) {
        await sleep(200);
      }
    }
  }

  // BambooHR Fabric FileUpload label lives on a sibling BodyText <p> ("Resume*"), not on the
  // <input>. Reads that sibling (or the last short BodyText among earlier siblings in the
  // same Flex parent) — shared by reveal + find below.
  function bambooFileUploadLabel(upload) {
    const prev = upload.previousElementSibling;
    const prevText = cleanedText(prev);
    if (prevText && prevText.length < 200) return prevText;
    const parent = upload.parentElement;
    if (!parent) return "";
    let last = "";
    for (const child of parent.children) {
      if (child === upload) break;
      const t = cleanedText(child);
      if (t && t.length < 200) last = t;
    }
    return last;
  }

  // Confirmed live on inibuilds.bamboohr.com: empty Resume widgets already contain a
  // tabindex=-1 <input type="file">, but some BambooHR captures (and possibly some live
  // states) show only the Choose File button until interaction. Same reveal shape as
  // SuccessFactors/HiBob — click the Resume-labeled widget's button and wait for an input.
  // Skips widgets that already show a FileUploadList (file already attached; no input left).
  async function revealBambooHrAttachmentInputs() {
    for (const upload of document.querySelectorAll('[data-fabric-component="FileUpload"]')) {
      if (hasFileInput(upload)) continue;
      if (upload.querySelector('[data-fabric-component="FileUploadList"]')) continue;
      const labelText = bambooFileUploadLabel(upload);
      if (!labelText || EXCLUDE_RE.test(labelText) || !RESUME_RE.test(labelText)) continue;
      const trigger = upload.querySelector("button");
      if (!trigger) continue;
      const beforeCount = collectFileInputs(document).length;
      trigger.click();
      for (let attempt = 0; attempt < 15 && collectFileInputs(document).length === beforeCount; attempt++) {
        await sleep(200);
      }
    }
  }

  // Prefer locating BambooHR's Resume FileUpload by its BodyText label, then taking the
  // <input type="file"> inside that widget. Does not depend on resolveFileInputLabel winning
  // past aria-label="file-input" — that path still runs as a fallback for other ATSs.
  function findBambooResumeFileInput() {
    for (const upload of document.querySelectorAll('[data-fabric-component="FileUpload"]')) {
      const labelText = bambooFileUploadLabel(upload);
      if (!labelText || EXCLUDE_RE.test(labelText) || !RESUME_RE.test(labelText)) continue;
      const input = [...upload.querySelectorAll("input")].find((el) => el.type === "file");
      if (input) return input;
    }
    return null;
  }

  // SmartRecruiters oneclick: real CV field is <spl-dropzone data-test="resume-upload">
  // (shadow file input). The Easy Apply parse widget is a different dropzone and must not win.
  function findSmartRecruitersResumeFileInput() {
    const hosts = [
      ...document.querySelectorAll('spl-dropzone[data-test="resume-upload"]'),
      ...document.querySelectorAll("oc-resume-upload spl-dropzone"),
    ];
    for (const host of hosts) {
      if (host.closest && host.closest("oc-apply-with-resume")) continue;
      if (/apply-with-resume/i.test(host.getAttribute("data-test") || "")) continue;
      const roots = [host, host.shadowRoot].filter(Boolean);
      for (const root of roots) {
        const input = [...root.querySelectorAll("input")].find((el) => el.type === "file");
        if (input) return input;
      }
      // Nested open shadows inside the dropzone
      for (const nested of host.querySelectorAll("*")) {
        if (!nested.shadowRoot) continue;
        const input = [...nested.shadowRoot.querySelectorAll("input")].find((el) => el.type === "file");
        if (input) return input;
      }
    }
    return null;
  }

  // join.com apply/cv step: Chakra FileUpload under `[data-testid="ResumeField"]` (card
  // trigger) plus a sibling dropzone — both say only "Upload file", so the generic label
  // path + two-candidate ambiguity check used to report "No Resume/CV upload field found."
  // Confirmed live on join.com/companies/chonova/.../apply/cv.
  function findJoinResumeFileInput() {
    const field = document.querySelector('[data-testid="ResumeField"]');
    if (field) {
      const input = [...field.querySelectorAll("input")].find((el) => el.type === "file");
      if (input) return input;
    }
    for (const el of document.querySelectorAll("h1, h2, h3, h4, p, span, div, legend, label")) {
      const t = cleanedText(el);
      if (!t || t.length > 40) continue;
      if (!/^(upload your (cv|resume|curriculum vitae)|your (cv|resume))$/i.test(t)) continue;
      let node = el.parentElement;
      for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
        const inputs = [...node.querySelectorAll("input")].filter((i) => i.type === "file");
        if (inputs.length) return inputs[0];
      }
    }
    return null;
  }

  return (async () => {
    await revealSuccessFactorsAttachmentInputs();
    await revealHibobAttachmentInputs();
    await revealBambooHrAttachmentInputs();

    const candidates = collectFileInputs(document);
    let target =
      findBambooResumeFileInput() || findSmartRecruitersResumeFileInput() || findJoinResumeFileInput();
    if (!target) {
      target = candidates.find((input) => {
        const label = resolveFileInputLabel(input);
        return !EXCLUDE_RE.test(label) && !isAutoParseWidget(input) && RESUME_RE.test(label);
      });
    }
    if (!target) {
      // No explicitly resume-labeled field — fall back to whatever's left once cover-letter/
      // photo/etc.-labeled fields and (off-Workday) auto-parse widgets are ruled out, but only if
      // that leaves exactly one candidate; more than one is too ambiguous to guess between.
      const eligible = candidates.filter((input) => !EXCLUDE_RE.test(resolveFileInputLabel(input)) && !isAutoParseWidget(input));
      if (eligible.length === 1) target = eligible[0];
    }
    if (!target) {
      const labels = candidates.map((input) => resolveFileInputLabel(input) || "(unlabeled)");
      const bambooUploads = [...document.querySelectorAll('[data-fabric-component="FileUpload"]')].map((u) => bambooFileUploadLabel(u) || "(no label)");
      const detail = [
        candidates.length ? `file inputs: ${labels.join("; ")}` : "no <input type=file> in DOM",
        bambooUploads.length ? `BambooHR FileUpload widgets: ${bambooUploads.join("; ")}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      return {
        attached: false,
        reason: `No Resume/CV upload field found on this page/frame.${detail ? ` (${detail})` : ""}`,
      };
    }

    const byteChars = atob(base64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const file = new File([bytes], filename, { type: mimeType });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    target.files = dataTransfer.files;
    // `composed: true` is required whenever `target` can be inside a shadow root (confirmed live:
    // SmartRecruiters' <spl-dropzone> resume widget) - `bubbles` alone only controls propagation
    // WITHIN a tree, not whether an event can cross a shadow boundary at all. A drop-zone-style
    // component very plausibly manages its own "file attached" state at the HOST element level
    // (outside the shadow root), not on the raw internal <input> itself - without `composed`,
    // this event is silently trapped inside the shadow tree and such a listener would never fire,
    // even though `target.files` was genuinely set correctly and everything else worked. Harmless
    // for a plain, non-shadow input (composed only matters once a shadow boundary exists at all).
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    // join.com Chakra/zag FileUpload sometimes also listens on the dropzone root; a synthetic
    // drop with the same DataTransfer helps the UI show the attached file name when change
    // alone doesn't refresh the card (harmless if no dropzone).
    const dropzone =
      (target.closest && target.closest('[data-part="root"]') &&
        target.closest('[data-part="root"]').querySelector('[data-part="dropzone"], [aria-label="dropzone"]')) ||
      (target.parentElement && target.parentElement.querySelector('[data-part="dropzone"]'));
    if (dropzone) {
      try {
        dropzone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
      } catch {
        /* DragEvent/dataTransfer not constructible in some embeds — change path already ran */
      }
    }
    const upload = target.closest && target.closest('[data-fabric-component="FileUpload"]');
    return {
      attached: true,
      label:
        resolveFileInputLabel(target) ||
        (upload ? bambooFileUploadLabel(upload) : "") ||
        (target.closest && target.closest('[data-testid="ResumeField"]') ? "Resume" : "") ||
        "",
    };
  })();
}

// Injected into the page — must be fully self-contained (no closures over outer scope).
function extractPageInfo() {
  // This gets injected into EVERY frame on the page (allFrames: true, in scrapeCurrentTab
  // below) so cross-origin job-board iframes (Greenhouse-embedded-in-a-careers-page, etc.)
  // still get scraped correctly. But that also means it runs inside third-party WIDGET iframes
  // that have nothing to do with the job posting at all — confirmed live: an hCaptcha challenge
  // iframe's own frame got scraped too, and its content happened to score as "the longest job
  // description-shaped text" of any frame on the page, so its own raw JavaScript source (not
  // rendered/visible content — presumably something in how that specific enclave page is built
  // made it show up in this frame's own text either way) won the cross-frame "longest wins"
  // comparison and got used as the extracted job description. Bailing out immediately for
  // known widget-provider hosts is a precise, low-risk fix — unlike a "does this look like
  // code" content heuristic, it can't misfire on a real job posting that happens to include a
  // code snippet in its description.
  const WIDGET_HOST_RE = /(^|\.)hcaptcha\.com$|recaptcha|(^|\.)gstatic\.com$|captcha-assets\.|captcha-base\.|(^|\.)platform\.twitter\.com$/i;
  // Google's own reCAPTCHA v2 checkbox iframe is served from
  // `www.google.com/recaptcha/api2/anchor` - confirmed live on a join.com posting, its raw
  // `recaptcha.anchor.Main.init(...)` payload sailed straight through the check above (a
  // hostname of "www.google.com" has nothing recaptcha-specific about it at all - "recaptcha"
  // only ever shows up in the PATH) and won the cross-frame comparison as "the longest job
  // description-shaped text", same failure mode as the hCaptcha case, just missed by that regex.
  // Checked as a separate, narrowly-scoped condition rather than folding pathname into
  // WIDGET_HOST_RE's own test string - that regex's hcaptcha/gstatic alternatives are anchored
  // with `$` (end-of-string), which only correctly means "ends with this domain" when tested
  // against the hostname alone; concatenating the pathname on would silently break that anchor
  // for every hostname-based alternative (confirmed by testing it - hcaptcha.com stopped
  // matching entirely once a path was appended after it).
  const isGoogleRecaptchaFrame = /(^|\.)google\.com$/i.test(location.hostname) && /\/recaptcha\//i.test(location.pathname);
  if (WIDGET_HOST_RE.test(location.hostname) || isGoogleRecaptchaFrame) {
    return { jobDescription: "", company: "", jobUrl: location.href };
  }

  // Set by extractJobDescription() below when a schema.org JobPosting's own structured
  // location fields are found - see formatStructuredLocation for why that beats guessing from
  // the free-text description alone.
  let structuredLocation = "";

  function linkDensity(el) {
    const text = el.innerText || el.textContent || "";
    const total = text.length || 1;
    const linkText = [...el.querySelectorAll("a")].reduce((sum, a) => sum + (a.textContent || "").length, 0);
    return linkText / total;
  }

  function cleanedText(el) {
    const clone = el.cloneNode(true);
    clone
      .querySelectorAll('nav, footer, header, script, style, form, button, svg, [role="navigation"]')
      .forEach((n) => n.remove());
    return (clone.textContent || "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function pickBest(elements, minLength) {
    let best = null;
    let bestScore = 0;
    for (const el of elements) {
      const len = (el.innerText || "").trim().length;
      if (len < minLength) continue;
      const score = len * (1 - Math.min(linkDensity(el), 0.9));
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function htmlToText(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    return (div.textContent || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function jobPostingFromJsonLd() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : data["@graph"] || [data];
        for (const item of items) {
          if (item && item["@type"] === "JobPosting" && item.description) return item;
        }
      } catch {
        // malformed JSON-LD on the page — ignore and fall through to DOM-based strategies
      }
    }
    return null;
  }

  function elementNearHeading() {
    // Many sites without JobPosting schema still clearly label the section
    // (e.g. "Job description", "About the role") right before the real content.
    const headingRe = /job description|about (the|this) role|responsibilities|what you.?ll do/i;
    for (const h of document.querySelectorAll("h1, h2, h3, h4, strong, b")) {
      const text = (h.textContent || "").trim();
      if (!headingRe.test(text) || text.length > 60) continue;
      // Velents/crm.velents.com confirmed live: "About the role" sits inside one wrapper
      // `<p>` that already contains the whole JD. Walking only to the next sibling returns
      // the first paragraph; climb ancestors and prefer the richest posting-shaped container.
      let ancestor = h.parentElement;
      for (let depth = 0; depth < 6 && ancestor; depth++) {
        const ancestorText = (ancestor.innerText || "").trim();
        const hasPostingSections =
          /\b(responsibilit|requirement|qualification|about (the|this|our) (role|stack)|nice to have|what we look for)\b/i.test(
            ancestorText
          );
        if (ancestorText.length > 800 && hasPostingSections) return ancestor;
        ancestor = ancestor.parentElement;
      }
      for (const start of [h, h.parentElement]) {
        let node = start && start.nextElementSibling;
        while (node) {
          if ((node.innerText || "").trim().length > 200) return node;
          node = node.nextElementSibling;
        }
      }
    }
    return null;
  }

  // schema.org JobPosting's own jobLocation/jobLocationType/applicantLocationRequirements are
  // a far more reliable location source than guessing from the free-text description - confirmed
  // live on an Ashby posting ("Senior Backend Engineer (.NET)" at Ideals): the description's only
  // "remote"-shaped text was a generic company-culture perk ("Remote-first flexibility to shape
  // your ideal workday"), which the regex-based extractLocation() below correctly reads as
  // "Remote" - but says nothing about the posting's real, consequential restriction that
  // applicants must actually be based in Ukraine (jobLocationType: "TELECOMMUTE",
  // applicantLocationRequirements: {name: "Ukraine"}), which was sitting right there in the same
  // JSON-LD block the whole time. jobLocation.address is checked first (a real city/region/
  // country when the role isn't purely remote-anywhere); applicantLocationRequirements is the
  // fallback specifically for remote roles that restrict WHERE a remote applicant must be based,
  // which often has no jobLocation.address at all.
  function formatStructuredLocation(posting) {
    if (!posting) return "";
    const isRemote = posting.jobLocationType === "TELECOMMUTE";
    const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    const places = [];
    for (const loc of asList(posting.jobLocation)) {
      const addr = loc && loc.address;
      if (!addr) continue;
      const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
      if (parts.length) places.push(parts.join(", "));
    }
    if (!places.length) {
      for (const req of asList(posting.applicantLocationRequirements)) {
        if (req && req.name) places.push(req.name);
      }
    }
    const place = places.join(" / ");
    if (isRemote && place) return `Remote (${place})`;
    if (isRemote) return "Remote";
    return place;
  }

  // Rejects SPA bootstrap / config blobs that can otherwise win as "the longest text on the
  // page". Confirmed live on BambooHR careers pages (evergreenfinance.bamboohr.com/careers/136):
  // before React hydrates `#poRoot`, the page has no visible job-description text at all —
  // `document.body.innerText` is the empty string — and the old final fallback then used
  // `document.body.textContent` (because `"" || textContent` picks textContent), which includes
  // the `<script id="poData" type="application/json">` bootstrap payload. The side panel's
  // Job Description field filled with `{"payroll":{"payrollServicesHost":null},"site":...}`
  // instead of the posting. A real job description essentially never starts like a JSON object.
  function looksLikeJsonBlob(text) {
    const t = (text || "").trim();
    if (!t) return false;
    if (/^[\[{]/.test(t) && /["'][a-zA-Z0-9_]+["']\s*:/.test(t.slice(0, 400))) return true;
    if (/payrollServicesHost|"canSee"\s*:\s*\{|"gracePeriodData"/.test(t.slice(0, 800))) return true;
    return false;
  }

  // SmartRecruiters oneclick apply pages have almost no real JD — `main` is the form
  // ("First name", "Easy Apply", consent, …). Confirmed live on jobs.smartrecruiters.com
  // oneclick-ui: longest-landmark extraction filled Job Description with that form chrome
  // instead of a posting. Reject those so we fall through to quieter sources / empty.
  function looksLikeApplicationFormChrome(text) {
    const t = (text || "").toLowerCase();
    let hits = 0;
    for (const phrase of [
      "first name",
      "last name",
      "easy apply",
      "confirm your email",
      "choose an option to autocomplete",
      "message to the hiring",
      "i declare that you have read",
    ]) {
      if (t.includes(phrase)) hits++;
    }
    return hits >= 2;
  }

  // Careers marketing / listing shells (Precisely, etc.) wrap the real Greenhouse/Lever
  // posting in an iframe. Their own body.innerText is long nav + "Want to join our team?"
  // chrome that otherwise wins the cross-frame "longest JD" contest over the embed's real
  // `.job__description`. Confirmed live on precisely.com/.../job/?gh_jid=4717903005.
  function looksLikeCareersListingChrome(text) {
    const t = (text || "").toLowerCase();
    let hits = 0;
    for (const phrase of [
      "skip to main",
      "want to join our team",
      "see job openings",
      "check out our current job openings",
      "cookie policy",
      "privacy preference",
      "manage consent",
    ]) {
      if (t.includes(phrase)) hits++;
    }
    if (hits >= 2) return true;
    // Short meta / shell blurbs with one of those phrases and no real posting sections.
    if (
      hits >= 1 &&
      t.length < 2500 &&
      !/\b(responsibilities|requirements|qualifications|about the (role|job)|what you.?ll do|job description)\b/i.test(t)
    ) {
      return true;
    }
    return false;
  }

  function acceptDescription(text) {
    const t = (text || "").trim();
    if (t.length < 80) return "";
    if (looksLikeJsonBlob(t)) return "";
    if (looksLikeApplicationFormChrome(t)) return "";
    if (looksLikeCareersListingChrome(t)) return "";
    return t.slice(0, 8000);
  }

  // True when this document is only a host for a cross-origin job-board iframe (the JD and
  // title live in that frame, not here). Used to skip wrapper-page landmark/body scraping.
  function pageHostsAtsJobEmbed() {
    if (document.getElementById("grnhse_iframe") || document.getElementById("grnhse_app")) return true;
    for (const iframe of document.querySelectorAll("iframe[src]")) {
      const src = iframe.getAttribute("src") || "";
      if (/greenhouse\.io\/(embed|jobs)|jobs\.lever\.co|\/embed\/job/i.test(src)) return true;
    }
    return false;
  }

  // SmartRecruiters oneclick-ui bakes job/company into window.__OC_CONTEXT__ (no JobPosting
  // JSON-LD on the apply form). Confirmed live: title/company/location available there while
  // the visible <title> is "Easy apply - {title} - {company}".
  function smartRecruitersOcContext() {
    try {
      if (window.__OC_CONTEXT__ && typeof window.__OC_CONTEXT__ === "object") return window.__OC_CONTEXT__;
    } catch {
      /* cross-origin / blocked */
    }
    return null;
  }

  // UKG Pro Recruiting (rec.pro.ukg.net, *.ukg.net) embeds the full opportunity as JSON inside
  // `new US.Opportunity.CandidateOpportunityDetail({...})` — confirmed live on Archer postings:
  // the visible `.opportunity-description` holds the real HTML JD, but generic `main` scraping
  // also pulls apply chrome, sidebar locations, and skills/behavior sections into one blob.
  function isUkgRecruitingPage() {
    return /(^|\.)ukg\.net$/i.test(location.hostname || "");
  }

  function ukgOpportunityFromPage() {
    if (!isUkgRecruitingPage()) return null;
    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent || "";
      if (!/CandidateOpportunityDetail/.test(text)) continue;
      const match = text.match(/CandidateOpportunityDetail\s*\(\s*(\{[\s\S]*?\})\s*\)/);
      if (!match) continue;
      try {
        return JSON.parse(match[1]);
      } catch {
        /* malformed bootstrap JSON — try next script */
      }
    }
    return null;
  }

  function ukgJobBoardNameFromPage() {
    if (!isUkgRecruitingPage()) return "";
    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent || "";
      const match = text.match(/"jobBoardName"\s*:\s*"([^"]+)"/);
      if (match && match[1].trim()) return match[1].trim();
    }
    const logo = document.querySelector(
      '[data-automation="navbar-large-logo"], [data-automation="navbar-small-logo"]'
    );
    const alt = logo && logo.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
    return "";
  }

  function formatUkgLocation(opportunity) {
    if (!opportunity || !opportunity.Locations || !opportunity.Locations.length) return "";
    const names = [];
    for (const loc of opportunity.Locations) {
      if (loc && loc.LocalizedName) {
        names.push(String(loc.LocalizedName).trim());
        continue;
      }
      const addr = loc && loc.Address;
      if (!addr) continue;
      const parts = [
        addr.City || (addr.State && addr.State.Name),
        addr.Country && addr.Country.Name,
      ].filter(Boolean);
      if (parts.length) names.push(parts.join(", "));
    }
    return [...new Set(names.filter(Boolean))].join(" / ");
  }

  // og:/twitter:description often carry a usable (sometimes truncated) plain-text JD summary
  // in the pre-hydration HTML shell — confirmed on BambooHR, where those meta tags are present
  // in the initial document long before `.BambooRichText` / JobPosting JSON-LD are injected.
  // Skip obvious truncations ("...") — confirmed live on careers.abtosoftware.com where the full
  // posting lives in `.single-vacancy__content` but og:description is only the first sentence.
  function looksLikeTruncatedMetaDescription(text) {
    const t = (text || "").trim();
    if (!t) return false;
    return /(?:\.{3}|…)\s*$/.test(t) && t.length < 400;
  }

  // SPA shells often ship homepage marketing in og:description while the visible page already
  // has a real posting — confirmed live on crm.velents.com/preview/position/... where meta
  // was "Experience a new standard of efficiency with our AI tools..." but the body had the
  // full "About the role / Responsibilities / Required qualifications" block.
  function looksLikeGenericSiteMetaDescription(text) {
    const t = (text || "").trim();
    if (!t) return false;
    const body = (document.body && document.body.innerText) || "";
    const bodyLooksLikePosting = /\b(about (the|this) role|responsibilit|required qualification|nice to have|we are looking for)\b/i.test(
      body
    );
    const metaLooksLikePosting = /\b(we are looking|responsibilit|requirement|qualification|years of experience|about the role)\b/i.test(
      t
    );
    return bodyLooksLikePosting && !metaLooksLikePosting;
  }

  function metaJobDescription() {
    for (const sel of ['meta[property="og:description"]', 'meta[name="twitter:description"]', 'meta[property="twitter:description"]']) {
      const el = document.querySelector(sel);
      const content = el && el.content && el.content.trim();
      const accepted = acceptDescription(content || "");
      if (accepted && !looksLikeTruncatedMetaDescription(accepted) && !looksLikeGenericSiteMetaDescription(accepted)) {
        return accepted;
      }
    }
    return "";
  }

  function extractJobDescription() {
    // 1. schema.org JobPosting structured data — clean, authoritative when present.
    const posting = jobPostingFromJsonLd();
    if (posting) {
      structuredLocation = formatStructuredLocation(posting);
      // join.com's own JobPosting description is confirmed live to be DOUBLE HTML-encoded -
      // the raw JSON string literally contains "&lt;h2 id=&quot;...&quot;&gt;Your mission&lt;/h2&gt;"
      // (real entities, not real tags). Setting innerHTML once (htmlToText's own job) decodes
      // that ONE layer of entities, producing a plain-text string that merely LOOKS like HTML
      // markup ("<h2 id=\"...\">Your mission</h2>") - it was never actually parsed as tags, so
      // it shows up as literal, visible "<h2>"/"<p>"/"<strong>" text in the extracted
      // description instead of being stripped. Running htmlToText a second time on that result
      // parses THOSE now-literal "<" characters as real tags this time, correctly stripping them
      // down to clean text. Harmless no-op for an already-correctly-single-encoded description
      // (e.g. Ashby's real HTML) - plain text with no leftover "<"/"&" characters left after the
      // first pass just passes through the second pass completely unchanged.
      const fromLd = acceptDescription(htmlToText(htmlToText(posting.description)));
      if (fromLd) return fromLd;
    }

    // SmartRecruiters oneclick apply form: no JobPosting / no JD body, but __OC_CONTEXT__.job
    // still has title + workplace location — capture that for facts even when description is empty.
    if (!structuredLocation) {
      const oc = smartRecruitersOcContext();
      if (oc && oc.job && oc.job.location) structuredLocation = String(oc.job.location).trim();
    }

    // UKG Pro Recruiting: authoritative Description HTML lives in CandidateOpportunityDetail JSON.
    const ukg = ukgOpportunityFromPage();
    if (ukg) {
      if (!structuredLocation) structuredLocation = formatUkgLocation(ukg);
      if (ukg.Description) {
        const fromUkg = acceptDescription(htmlToText(htmlToText(ukg.Description)));
        if (fromUkg) return fromUkg;
      }
    }

    // 2. ATS-specific description containers — checked BEFORE generic `main`/`article`/
    // `#content`, because those broader landmarks often wrap chrome (nav, "Privacy Policy",
    // "Job Openings", department subtitle) around the real posting. Confirmed on BambooHR:
    // `main` scored longer than `.BambooRichText` and would otherwise win with a
    // "Privacy PolicyJob Openings..." prefix glued onto the real description. Purpose-built
    // class names are more trustworthy than "longest landmark wins".
    let best = pickBest(
      document.querySelectorAll(
        ".BambooRichText, .job-description, .jobDescription, .job__description, .posting-description, .opening-description, .opportunity-description, [data-automation='job-description'], .single-vacancy__content, .single-vacancy__info, .vacancy-content, .entry-content, .post-content"
      ),
      200
    );
    if (best) {
      const text = acceptDescription(cleanedText(best));
      if (text) return text;
    }

    // Wrapper careers pages embed Greenhouse/Lever in an iframe — JSON-LD / ATS containers
    // above already missed (they're in the child frame). Scraping this shell's main/#content/
    // body next would return 8k of marketing chrome and beat the real iframe JD on length.
    // Confirmed live: precisely.com international-jobs job page with #grnhse_iframe.
    if (pageHostsAtsJobEmbed()) return "";

    // 3. Broader semantic landmarks (still more trustworthy than heading-proximity below).
    best = pickBest(document.querySelectorAll('main, article, [role="main"], #content, .description'), 200);
    if (best) {
      const text = acceptDescription(cleanedText(best));
      if (text) return text;
    }

    // 4. A heading like "Job description" / "About the role" right before the content —
    // fallback for pages with no semantic container at all, just a bolded label.
    const nearHeading = elementNearHeading();
    if (nearHeading) {
      const text = acceptDescription(cleanedText(nearHeading));
      if (text) return text;
    }

    // 5. Meta description — usable on SPA shells before the real DOM body hydrates (BambooHR).
    const fromMeta = metaJobDescription();
    if (fromMeta) return fromMeta;

    // 6. Fall back to scanning generic block elements for the largest low-link-density block.
    // Never use document.body.textContent — it includes <script> contents (see looksLikeJsonBlob).
    // Also treat empty innerText as missing (don't let `""` falsy-fall-through to textContent).
    best = pickBest(document.querySelectorAll("div, section, article"), 300);
    if (best) {
      const text = acceptDescription(cleanedText(best));
      if (text) return text;
    }
    return acceptDescription(document.body.innerText || "");
  }

  function extractCompany() {
    // 1. schema.org JobPosting structured data (most reliable when present — this is
    // what Google for Jobs requires, so many ATS platforms already include it).
    // Workday is the deliberate exception below: its hiringOrganization.name is often a
    // legal-entity string with an internal site code ("US00 Agilent Technologies Inc"),
    // not the brand name the rest of the page (and the user) uses.
    const posting = jobPostingFromJsonLd();
    const orgName = posting && posting.hiringOrganization && posting.hiringOrganization.name;
    const onWorkday = /(^|\.)myworkdayjobs\.com$|(^|\.)myworkday\.com$/i.test(location.hostname || "");
    if (orgName && !onWorkday) return String(orgName).trim();
    // UKG Pro Recruiting: company is the job-board brand ("Archer Job Board"), not the tenant
    // subdomain (gusea1p01.rec.pro.ukg.net → "Gusea1p01"). Confirmed live on Archer postings.
    if (isUkgRecruitingPage()) {
      let board = ukgJobBoardNameFromPage();
      if (board) {
        board = board.replace(/\s+job\s*board\s*$/i, "").trim();
        if (board) return board;
      }
    }
    // SmartRecruiters oneclick apply: company lives in __OC_CONTEXT__ (branding / company.name).
    const oc = smartRecruitersOcContext();
    if (oc) {
      const fromOc =
        (oc.company && (oc.company.name || oc.company.companyIdentifier)) ||
        (oc.branding && oc.branding.name) ||
        "";
      if (fromOc && String(fromOc).trim()) return String(fromOc).trim();
    }
    // Workday job pages put the real brand in the right-rail "About {Company}" heading
    // (confirmed live on agilent.wd5.myworkdayjobs.com → "About Agilent") and in the
    // tenant subdomain (agilent.wd5.myworkdayjobs.com). Prefer those over JSON-LD's
    // "US00 Agilent Technologies Inc"-style legal name. Apply-flow pages without the
    // About rail still get the subdomain.
    if (onWorkday) {
      for (const h of document.querySelectorAll("h1, h2, h3, h4")) {
        const t = (h.innerText || h.textContent || "").replace(/\s+/g, " ").trim();
        const about = t.match(/^about\s+(.+)$/i);
        if (!about) continue;
        const name = about[1].trim();
        if (
          name.length >= 2 &&
          name.length <= 80 &&
          !/^(us|the\s+(role|job|company|team|opportunity)|this\s+role)\b/i.test(name)
        ) {
          return name;
        }
      }
      const parts = location.hostname.replace(/^www\./i, "").split(".");
      const tenant = parts[0];
      if (tenant && !/^(wd\d+|www|jobs|career|careers)$/i.test(tenant)) {
        return tenant
          .split("-")
          .filter(Boolean)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
      }
      // Last Workday fallback: strip a leading "US00 "/"GB01 " site code from JSON-LD.
      if (orgName) {
        const cleaned = String(orgName).trim().replace(/^[A-Z]{2}\d{2}\s+/, "");
        if (cleaned) return cleaned;
      }
    }
    // 2. Some multi-tenant ATS platforms serve every customer from ONE shared domain with the
    // real company name only in the URL path (not a per-company subdomain) - their own
    // og:site_name is just the ATS VENDOR'S generic product branding, not the hiring company.
    // Confirmed live: ats.rippling.com/nutrient/jobs/... has
    // `<meta property="og:site_name" content="Rippling Recruiting">` (Rippling's own product
    // name), while the real company ("Nutrient") only appears in the URL path and buried in the
    // og:description text ("Your Role at Nutrient..."). Checked before the generic og:site_name
    // strategy below, and scoped to this one known shared-domain host specifically - a real
    // company's own careers site correctly using og:site_name for itself must not be
    // second-guessed this way.
    if (/^ats\.rippling\.com$/i.test(location.hostname)) {
      const slug = location.pathname.split("/").filter(Boolean)[0];
      if (slug) return slug.charAt(0).toUpperCase() + slug.slice(1);
    }
    // 3. og:site_name meta tag.
    const ogSite = document.querySelector('meta[property="og:site_name"]');
    if (ogSite && ogSite.content && ogSite.content.trim()) return ogSite.content.trim();
    // 4. Common class/attribute patterns used by various job boards/ATS.
    const selectors = [
      "[itemprop='hiringOrganization']",
      ".company-name",
      ".employer-name",
      ".posting-company",
      ".company",
    ];
    for (const sel of selectors) {
      const found = document.querySelector(sel);
      const text = found && found.innerText && found.innerText.trim();
      if (text && text.length < 100) return text;
    }
    // 5. Page title patterns like "Job Title at Company" or "Company - Job Title".
    const title = document.title || "";
    let m = title.match(/\bat\s+([A-Z][\w& .]{1,40})$/);
    if (m) return m[1].trim();
    m = title.match(/^([A-Z][\w& .]{1,40})\s*[-|]/);
    if (m) return m[1].trim();
    // 6. Last resort: derive from the page's own domain — only meaningful when the
    // company hosts the posting themselves, not on a third-party ATS's own domain
    // (which would otherwise just give back "Greenhouse", "Lever", etc).
    const fullHost = location.hostname.replace(/^www\./, "");
    if (!/greenhouse\.io|lever\.co|myworkdayjobs\.com|smartrecruiters\.com|workable\.com|bamboohr\.com|ukg\.net/i.test(fullHost)) {
      const label = fullHost.split(".")[0];
      if (label && label.length > 2) return label.charAt(0).toUpperCase() + label.slice(1);
    }
    return "";
  }

  function extractUrl() {
    // Use the page's actual URL as-is. Preferring <link rel="canonical"> used to
    // "clean" tracking params but also cut real path/query pieces (e.g. /apply,
    // board tokens) that the user still needs — reported live: extracted job URLs
    // came back shorter than what was in the address bar. Just copy location.href.
    return location.href;
  }

  // Same reliability ordering as extractCompany() - structured data first, then progressively
  // noisier sources. Checked against every real "Save Sample" capture collected so far
  // (~120 files) - confirmed live, several real failure classes needed dedicated handling:
  // - A heading OR <title> that's just generic apply-flow chrome, not the job title at all
  //   ("Apply", "Application Submitted", "Careers", "Career Center" - Rippling, PinpointHQ, a
  //   BreezyHR post-submit confirmation page, ADP, Hibob all hit this).
  // - Boilerplate as a PREFIX, not just the far more commonly-handled suffix - "Apply -
  //   Software Engineer, Retrieval" (Rippling <title>), "New Application | Senior Java Engineer
  //   (Core) | Hazelcast Careers" (PinpointHQ <title>), "Applying for Software Engineer -
  //   Identity & Access Mgmt" (ADP's own <h2> - it has no <h1> at all).
  // - og:title is frequently CLEANER than the visible <title> tag specifically once you're on
  //   an application-FORM sub-page rather than the original posting - confirmed live, Rippling's
  //   own <title> carries the "Apply -" prefix above but its og:title is the clean "Software
  //   Engineer, Retrieval | Capacity" (real title, unprefixed, just needs the trailing "|
  //   Capacity" company name stripped the same way a suffix-boilerplate <title> would).
  // - A few ATS platforms render the title in a specific known class, no heading tag at all -
  //   confirmed live on Hibob's own "apply" sub-page (no h1-h3, no og:title either, but a real
  //   `class="job-ad-title"` div holds the actual text).
  // "Job openings"/"open positions" (PeopleForce: a generic <h1> sitting above the real title,
  // which lives in a separate <h2>) added alongside the apply-flow-chrome phrases above.
  const GENERIC_TITLE_RE =
    /^(apply( now)?|application( submitted)?|new application|careers?|career center|job application|job openings?|open positions?|open roles?|international openings?|current openings?|.+\bopenings?)$/i;

  // SmartRecruiters (and similar) inject an IE11-sunset overlay whose <h1> is often the first
  // heading in document order — confirmed live on jobs.smartrecruiters.com/QADInc/... and
  // Mirantis: "Sorry, Internet Explorer 11 is no longer supported by SmartRecruiters". Never
  // treat that (or any browser-sunset banner) as a job title, wherever it appears.
  function isUnsupportedBrowserTitle(text) {
    return /internet explorer|no longer supported|browser.+(not|no longer)\s+supported/i.test(text || "");
  }

  // Strips a leading "Apply -"/"Apply |"/"Applying for "/"New Application |"/"Application -"/
  // "Candidate Profile -" boilerplate segment - safe to apply uniformly to headings AND
  // <title>/og:title, since it only ever matches one of these specific known apply-flow
  // phrases, never arbitrary title text. "Candidate Profile" confirmed live on an iCIMS
  // <title> ("Candidate Profile - Software Engineer (Jenkins & .NET)").
  function stripLeadingApplyBoilerplate(text) {
    return (text || "").replace(
      /^(easy\s*apply|apply(ing for)?|apply\s*now|new\s*application|job\s*application|application|candidate\s*profile)\s*[-|:]?\s*/i,
      ""
    );
  }

  // Strips a trailing "- Company"/"| Company"/"at Company"/"| Site Name" boilerplate segment -
  // ONLY safe for <title>/og:title (which commonly chain "Job Title | Company | Site" this way),
  // NOT for headings - a real <h1>/<h2> job title very often legitimately contains its own "-"
  // or "|" as part of the actual title itself (confirmed live: "Senior Software Engineer -
  // Tetragon", "Sidestream (Remote): Senior Typescript Developer (f/m/d)" - blindly applying
  // this to headings would wrongly truncate titles like that instead of leaving them alone).
  // Character class must include "," - confirmed live, Rippling's own og:title "Software
  // Engineer (ReactJS, TypeScript) |  " (a real, if malformed, empty-company templating bug on
  // their own end) failed to match AT ALL without it, since the comma inside the parenthesised
  // tech list sits before the real "|" separator - the whole regex came back null and silently
  // fell through to the untouched original text, dangling trailing pipe included.
  function stripTrailingBoilerplate(text) {
    const m = (text || "").match(/^([\w][\w& .,()/+#-]{1,100}?)\s*(?:[-|]|\bat\b)/i);
    return m ? m[1].trim() : (text || "").trim();
  }

  // Checks genericity on the RAW heading text first - confirmed live, a BreezyHR post-submit
  // page's own "Application Submitted" <h1> must be excluded as a WHOLE phrase; stripping its
  // leading "Application" boilerplate first (as done below for a real prefixed title) would
  // leave just "Submitted", which no longer matches GENERIC_TITLE_RE at all and would wrongly
  // be trusted as the real job title.
  function pickHeadingTitle(selector) {
    for (const heading of document.querySelectorAll(selector)) {
      const raw = (heading.innerText || heading.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw || GENERIC_TITLE_RE.test(raw) || isUnsupportedBrowserTitle(raw)) continue;
      // A form QUESTION, not a job title - confirmed live, a join.com posting with no <h1> at
      // all has exactly one <h2> on the whole page ("What is your expected yearly compensation
      // in EUR?" - an application-form question, not any kind of title), which then won by
      // default even though the page's own <title>/og:title were both already a perfectly
      // clean, correct job title. A real job title essentially never ends with "?".
      if (/\?\s*$/.test(raw)) continue;
      const text = stripLeadingApplyBoilerplate(raw).trim();
      if (text && text.length > 2 && text.length < 150 && !GENERIC_TITLE_RE.test(text)) return text;
    }
    return "";
  }

  function extractJobTitle() {
    const posting = jobPostingFromJsonLd();
    if (posting && posting.title) return String(posting.title).trim();

    // SmartRecruiters oneclick: visible topbar title + __OC_CONTEXT__.job.title. The page also
    // has a visually-hidden <h1> whose innerText is empty (clip/sr-only), so heading search
    // misses it and <title> used to collapse to "Easy apply" via stripTrailingBoilerplate.
    // Confirmed live on jobs.smartrecruiters.com/.../oneclick-ui (O-I Financial Reporting Analyst).
    const topbar = document.querySelector('[data-test="topbar-job-title"]');
    const topbarText = topbar && (topbar.textContent || "").replace(/\s+/g, " ").trim();
    if (topbarText && topbarText.length > 2 && topbarText.length < 150 && !GENERIC_TITLE_RE.test(topbarText) && !isUnsupportedBrowserTitle(topbarText)) {
      return topbarText;
    }
    const oc = smartRecruitersOcContext();
    if (oc && oc.job && oc.job.title) {
      const t = String(oc.job.title).trim();
      if (t && !GENERIC_TITLE_RE.test(t) && !isUnsupportedBrowserTitle(t)) return t;
    }

    // UKG Pro Recruiting: Title in CandidateOpportunityDetail JSON + data-automation marker.
    const ukg = ukgOpportunityFromPage();
    if (ukg && ukg.Title) {
      const t = String(ukg.Title).trim();
      if (t && !GENERIC_TITLE_RE.test(t) && !isUnsupportedBrowserTitle(t)) return t;
    }
    const ukgTitleEl = document.querySelector('[data-automation="opportunity-title"]');
    const ukgTitleText =
      ukgTitleEl && (ukgTitleEl.innerText || ukgTitleEl.textContent || "").replace(/\s+/g, " ").trim();
    if (
      ukgTitleText &&
      ukgTitleText.length > 2 &&
      ukgTitleText.length < 150 &&
      !GENERIC_TITLE_RE.test(ukgTitleText) &&
      !isUnsupportedBrowserTitle(ukgTitleText)
    ) {
      return ukgTitleText;
    }

    // Prefer dedicated job-title markers BEFORE any generic <h1> scan — SmartRecruiters job
    // ads use `<h1 class="job-title" itemprop="title">…</h1>` inside a JobPosting microdata
    // block, while an unrelated IE11-warning <h1> sits earlier in the document. Walk every
    // match (not just the first) so a hidden/empty `.job-title` duplicate can't block a later
    // good one — confirmed live on QADInc SmartRecruiters (3 `.job-title` nodes, all the real
    // "Sr. Site Reliability Engineer - SRE"). Greenhouse embed uses `.job__title` > `h1`
    // (BEM double-underscore) — the wrapper also contains location, so prefer the inner h1.
    for (const sel of [".job-title", ".job__title h1", ".job__title", "[itemprop='title']", ".job-ad-title"]) {
      for (const found of document.querySelectorAll(sel)) {
        let text = (found.innerText || found.textContent || "").replace(/\s+/g, " ").trim();
        // `.job__title` wrapper: "Data Analyst … Location" — keep the heading line only.
        if (found.matches && found.matches(".job__title") && !found.matches("h1")) {
          const inner = found.querySelector("h1");
          if (inner) text = (inner.innerText || inner.textContent || "").replace(/\s+/g, " ").trim();
        }
        if (
          text &&
          text.length > 2 &&
          text.length < 150 &&
          !GENERIC_TITLE_RE.test(text) &&
          !isUnsupportedBrowserTitle(text)
        ) {
          return text;
        }
      }
    }

    // Careers pages that only host a Greenhouse/Lever iframe often have a listing-shell <h1>
    // ("International Openings") and og:title about "See job openings" — never use those;
    // the real title is in the embed frame (confirmed live: precisely.com + grnhse_iframe).
    if (pageHostsAtsJobEmbed()) return "";

    // Every real <h1> is checked (and rejected if generic/empty) BEFORE any <h2> is even
    // considered - confirmed live, a SuccessFactors page's own noscript "JavaScript is turned
    // off in your web browser..." warning happens to be an <h2> sitting BEFORE the real
    // job-title <h1> in raw document order; querySelectorAll("h1, h2") returns elements in that
    // same document order, not grouped by tag, so it would otherwise win the race purely by
    // occurring first in the markup despite an <h1> - a strictly more reliable signal - existing
    // right there on the same page. A clean, non-generic <h1> (Scopic: "Remote Senior Angular
    // Developer") wins outright regardless of anything below - confirmed live, that page's own
    // og:title/<title> both order it "Company - Job Title - Remote Job" (company FIRST), which
    // would otherwise wrongly win as just "Scopic" if checked ahead of a perfectly good <h1>.
    const hadH1 = document.querySelector("h1") !== null;
    const h1Title = pickHeadingTitle("h1");
    if (h1Title) return h1Title;

    // og:title is frequently CLEANER than the visible <title> tag specifically once you're on
    // an application-FORM sub-page rather than the original posting - confirmed live, Rippling's
    // own <title> carries an "Apply -" prefix (see stripLeadingApplyBoilerplate) but its
    // og:title is the clean "Software Engineer, Retrieval | Capacity" (real title, unprefixed,
    // just needs the trailing "| Capacity" company name stripped the same way a
    // suffix-boilerplate <title> would). Requires at least one space (i.e. more than one word) -
    // confirmed live, a Skeeled posting's own og:title is just "SLG" (its employer's own brand
    // abbreviation, nothing else at all) while its <title> tag carries the real, full "Data
    // Scientist / ML Engineer - SLG" - a bare single-word og:title is far more likely to be a
    // company/brand fragment than a genuine, complete job title.
    function tryMetaTitles() {
      const ogTitleEl = document.querySelector('meta[property="og:title"]');
      const ogTitle = ogTitleEl && ogTitleEl.content && stripTrailingBoilerplate(stripLeadingApplyBoilerplate(ogTitleEl.content));
      if (ogTitle && ogTitle.length > 2 && /\s/.test(ogTitle) && !GENERIC_TITLE_RE.test(ogTitle) && !isUnsupportedBrowserTitle(ogTitle)) return ogTitle;
      const titleText = stripTrailingBoilerplate(stripLeadingApplyBoilerplate(document.title || ""));
      if (titleText && !GENERIC_TITLE_RE.test(titleText) && !isUnsupportedBrowserTitle(titleText)) return titleText;
      return "";
    }

    // Ordering between <h2> and og:title/<title> depends on whether a (rejected-for-being-
    // generic) <h1> existed at all: a PRESENT-but-generic <h1> ("Job openings" - PeopleForce)
    // signals this page structures its real content via headings, so its own <h2> ("Senior AWS
    // Engineer") is more trustworthy than parsing an ambiguously-ordered <title>/og:title string
    // (PeopleForce's own is "SkyHighGrowth Inc. - Senior AWS Engineer" - company FIRST, same
    // wrong-order trap as Scopic above, just with no clean <h1> around to short-circuit past it
    // this time). With NO <h1> at all (join.com: an apply-flow stepper's own "Confirm your
    // CV"/"Upload your CV" <h2>, or a bare compensation-question <h2> with nothing else on the
    // page), <title>/og:title are the more reliable source and a generic-content <h2> is only a
    // last resort.
    if (hadH1) {
      const h2Title = pickHeadingTitle("h2");
      if (h2Title) return h2Title;
      const metaTitle = tryMetaTitles();
      if (metaTitle) return metaTitle;
    } else {
      const metaTitle = tryMetaTitles();
      if (metaTitle) return metaTitle;
      const h2Title = pickHeadingTitle("h2");
      if (h2Title) return h2Title;
    }
    return (document.title || "").trim().slice(0, 150);
  }

  const jobDescription = extractJobDescription(); // must run first - sets structuredLocation as a side effect
  return {
    jobDescription,
    company: extractCompany(),
    jobTitle: extractJobTitle(),
    jobUrl: extractUrl(),
    structuredLocation,
  };
}

// Injected into a chatgpt.com tab — must be fully self-contained. Types the given prompt into
// ChatGPT's own message composer, submits it, waits for the response to finish streaming, and
// returns the response text. Uses resilient, generic selectors (role/data-testid/placeholder-
// based) rather than exact class names, since ChatGPT's own classes are auto-generated hashes
// that change often — same reasoning as every ATS-specific fixture in this codebase.
function submitChatGptPromptInPage(prompt, deleteConversation) {
  function nativeSet(element, value) {
    const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ChatGPT's composer is a contenteditable div (id="prompt-textarea" as of this writing), not
  // a plain <textarea> - a value-setter based nativeSet doesn't apply to it, since contenteditable
  // elements track their content via the DOM tree itself. Each line becomes its own <p>, matching
  // what a real paste/keystroke sequence produces, then an InputEvent tells React to notice.
  function setComposerText(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      nativeSet(el, text);
      return;
    }
    el.textContent = "";
    for (const line of text.split("\n")) {
      const p = document.createElement("p");
      p.textContent = line || "​"; // zero-width space - keeps a genuinely blank line from collapsing
      el.appendChild(p);
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
  }

  function findComposer() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('form [contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector("form textarea")
    );
  }

  function findSendButton() {
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send" i]') ||
      document.querySelector('form button[type="submit"]')
    );
  }

  function isGenerating() {
    return Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i]'));
  }

  // Fallback ALONGSIDE the plain sleep()-based poll below, not a replacement for it - reported
  // live: generation appears to silently stall whenever the ChatGPT tab isn't the visible one
  // on screen (covered by another app/window), only ever completing once the user looks at it
  // again. Two different things could cause that identical symptom: (a) Chrome throttling this
  // function's OWN setTimeout-based polling while the tab is hidden, so it simply checks far
  // less often, or (b) ChatGPT's own page pausing whatever renders the stop button's removal
  // while hidden, so there's genuinely nothing new to see no matter how often anything checks.
  // Only (a) is fixable from here - a MutationObserver reacts to a REAL DOM mutation the
  // instant it happens rather than on a throttled timer schedule, so if the bottleneck really
  // is this function's own polling cadence, racing this alongside the untouched original loop
  // lets whichever one notices first win, with no change in behavior if it turns out (b) is the
  // actual cause (the original loop's own timeout still applies exactly as before either way).
  function waitForStopButtonGoneViaMutation(timeoutMs) {
    return new Promise((resolve) => {
      if (!isGenerating()) return resolve();
      const observer = new MutationObserver(() => {
        if (!isGenerating()) {
          observer.disconnect();
          clearTimeout(timer);
          resolve();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, timeoutMs);
    });
  }

  // The schema contract explicitly tells the model NOT to wrap its JSON reply in a markdown
  // code fence (a real requirement for Claude/Ollama, which return this text straight through
  // an API with no rendering step in between) - but ChatGPT's own browser UI still renders
  // whatever it gets AS markdown whenever it ISN'T inside a fenced code block. That means a
  // genuine "**bold**" or "[text](url)" the model wrote INSIDE a JSON string value (meant to
  // survive as literal characters for our own PDF/DOCX renderer to interpret later) gets
  // visually converted into a real <strong>/<a> element by ChatGPT itself - and reading
  // .textContent/.innerText off THAT already-rendered HTML gets back just the plain words, with
  // the markdown syntax already stripped by the browser's own rendering, not by anything in
  // this codebase. Confirmed live: a generated resume's bullets sometimes kept their **bold**
  // markers (whenever the model happened to wrap the reply in a code fence anyway, despite
  // being told not to) and sometimes silently lost them (whenever it didn't) - the exact
  // inconsistency this reconstructs around instead of depending on.
  //
  // Walks the assistant message's actual rendered DOM and "un-renders" it back into the
  // equivalent markdown text before reading anything - <strong>/<b> becomes **text** again,
  // <a href> becomes [text](url) again - so the extracted text is correct whether or not the
  // model used a code fence. A genuine <pre><code> block (when the model DOES fence it) is
  // still read via its own raw .textContent, unprocessed - the exact fix for the earlier
  // "long line's visual soft-wrap becomes a literal embedded newline" bug, preserved here
  // rather than replaced by it.
  function reconstructMarkdown(node) {
    if (node.nodeType === 3) return node.textContent; // TEXT_NODE
    if (node.nodeType !== 1) return ""; // not an ELEMENT_NODE
    const tag = node.tagName;
    if (tag === "BR") return "\n";
    if (tag === "CODE" || tag === "PRE") return node.textContent;
    const inner = Array.from(node.childNodes).map(reconstructMarkdown).join("");
    if (tag === "STRONG" || tag === "B") return `**${inner}**`;
    if (tag === "EM" || tag === "I") return `_${inner}_`;
    if (tag === "A" && node.getAttribute("href")) return `[${inner}](${node.getAttribute("href")})`;
    if (tag === "P" || tag === "DIV" || tag === "LI") return `${inner}\n`;
    return inner;
  }

  // Two consecutive equal reads means "nothing changed between them" - which is just as true
  // for "genuinely finished" as it is for "frozen mid-stream because the tab lost focus/got
  // throttled." Actually parsing as JSON is a real, independent completeness signal a merely-
  // unchanged read can't provide - every reply this function is ever used for (resume JSON,
  // batched-answer JSON) is expected to parse, so a still-truncated reply will reliably fail
  // this even while "stable."
  function looksLikeCompleteJson(text) {
    let candidate = text.trim();
    if (candidate.startsWith("```")) {
      candidate = candidate.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "").trim();
    }
    try {
      JSON.parse(candidate);
      return true;
    } catch {
      return false;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  return (async () => {
    let composer = null;
    for (let attempt = 0; attempt < 50 && !composer; attempt++) {
      composer = findComposer();
      if (!composer) await sleep(200);
    }
    if (!composer) {
      return { ok: false, error: "Could not find ChatGPT's message box - the page layout may have changed, or you're not logged in." };
    }

    setComposerText(composer, prompt);
    await sleep(300); // give React a moment to enable the send button after the composer's content changes

    let sendBtn = null;
    for (let attempt = 0; attempt < 25 && !sendBtn; attempt++) {
      const candidate = findSendButton();
      sendBtn = candidate && !candidate.disabled ? candidate : null;
      if (!sendBtn) await sleep(200);
    }
    if (!sendBtn) return { ok: false, error: "Could not find (or enable) ChatGPT's send button." };
    sendBtn.click();

    // Wait for generation to actually start before waiting for it to finish - guards against
    // reading a stale, pre-submission DOM as if it were already "done." Reported live: "ChatGPT's
    // response was empty" sometimes happens even though ChatGPT visibly answered - root cause
    // wasn't the delete-conversation cleanup (that only ever runs AFTER text is successfully
    // extracted below, and the tab only closes after this whole function has already returned -
    // neither can interrupt extraction). The real cause: a longer "thinking" pause before the
    // visible answer starts streaming can outlast this wait, meaning isGenerating() never once
    // sees the stop button appear - the second loop's condition is then already false, so it
    // exits after zero iterations, and the code below reads the assistant message container
    // while it's still genuinely empty, before any real content has streamed in. Widened from
    // 25*200ms (5s) to 75*200ms (15s) to cover a real thinking pause, not just a network hiccup.
    for (let attempt = 0; attempt < 75 && !isGenerating(); attempt++) await sleep(200);
    // Original poll loop left completely untouched, still the sole thing this depends on if the
    // race below never helps (e.g. a page that never mutates while hidden) - the
    // MutationObserver-based wait is raced ALONGSIDE it purely as a chance to finish sooner,
    // never a replacement for it.
    await Promise.race([
      (async () => {
        for (let attempt = 0; attempt < 300 && isGenerating(); attempt++) await sleep(500);
      })(),
      waitForStopButtonGoneViaMutation(150000),
    ]);
    if (isGenerating()) return { ok: false, error: "Timed out waiting for ChatGPT's response to finish." };

    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!assistantMessages.length) return { ok: false, error: "No response found from ChatGPT." };
    const last = assistantMessages[assistantMessages.length - 1];
    // Retries before giving up: even once isGenerating() correctly reports "finished," the DOM
    // can plausibly take one more tick to reflect the final rendered content (React commits
    // asynchronously) - a single immediate read landing in that gap would report an empty
    // response even though real content is a few hundred ms from appearing.
    let text = "";
    for (let attempt = 0; attempt < 10 && !text; attempt++) {
      text = reconstructMarkdown(last).trim();
      if (!text) await sleep(300);
    }
    if (!text) return { ok: false, error: "ChatGPT's response was empty." };

    // Reported live TWICE: a JSON reply came back truncated mid-property, not empty - the
    // empty-retry loop above only guards the "nothing rendered yet" gap, but isGenerating()
    // going false (stop button removed) can itself land a beat BEFORE a long reply's LAST chunk
    // actually commits to the DOM - or, reported the second time, land well BEFORE that if the
    // tab lost real OS focus and got throttled (see runChatGptPrompt's own window-focus fix).
    // Two consecutive equal reads alone can't tell "genuinely finished" apart from "frozen
    // mid-stream, so of course it hasn't changed" - both look identical. Requires BOTH stability
    // AND that the settled text actually parses as JSON (every reply this function handles is
    // always expected to) before trusting it; if it's stable but not valid JSON, keeps
    // re-reading with longer pauses (giving a previously-throttled tab real time to catch up
    // now that runChatGptPrompt has re-focused its window) before finally giving up.
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(attempt < 10 ? 300 : 600);
      const reread = reconstructMarkdown(last).trim();
      const changed = reread !== text;
      text = reread;
      if (!changed && looksLikeCompleteJson(text)) break;
    }

    // Best-effort cleanup: this tab exists purely to generate one JSON blob, not to leave a
    // real conversation sitting in the user's ChatGPT history - so delete it via the same
    // "..." menu -> Delete -> confirm click-path a real user would use, same click-simulation
    // approach as everything else here (no backend-api calls, no session token handling).
    // Never lets a failure here affect the actual result - deleting is cleanup, not the point.
    // Skippable (Settings > "Delete the ChatGPT conversation after generating") - once deleted,
    // the actual prompt/response is gone with no way to go back and inspect it, which matters
    // when a result looks wrong and needs debugging.
    let deleted = false;
    if (deleteConversation) {
      try {
        deleted = await tryDeleteConversation();
      } catch {
        deleted = false;
      }
    }
    return { ok: true, text, deleted };
  })();

  // Confirmed live (real chatgpt.com DOM, 2026-07-27): the currently-open conversation's own
  // top-bar "..." button is `button[data-testid="conversation-options-button"]` - tied
  // directly to whatever conversation is open right now via its own id
  // ("conversation-options-<uuid>"), not to sidebar position/ordering the way
  // `history-item-N-options` is (pinned chats, search state, etc. could all shift which sidebar
  // row is "newest") - a strictly more reliable target for "the chat this tab just created and
  // is currently showing." Kept `history-item-0-options` as a fallback in case the top-bar
  // button itself is ever missing (e.g. a narrower viewport hides it). The menu-item/dialog
  // selectors below are still best guesses - real text/data-testid unconfirmed since the menu
  // itself wasn't open in what was captured live.
  async function tryDeleteConversation() {
    function findOptionsButton() {
      return (
        document.querySelector('button[data-testid="conversation-options-button"]') ||
        document.querySelector('[data-testid="history-item-0-options"]') ||
        document.querySelector('nav [data-testid$="-options"]') ||
        document.querySelector('nav button[aria-label*="options" i]') ||
        document.querySelector('nav button[aria-label*="more" i]')
      );
    }

    function findMenuItemByText(label) {
      for (const item of document.querySelectorAll('[role="menuitem"], [data-testid*="delete" i]')) {
        const text = (item.textContent || "").trim().toLowerCase();
        if (text === label || (item.getAttribute("data-testid") || "").toLowerCase().includes(label)) return item;
      }
      return null;
    }

    function findDialogConfirmButton() {
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
      if (!dialog) return null;
      for (const btn of dialog.querySelectorAll("button")) {
        const text = (btn.textContent || "").trim();
        if (/^delete$/i.test(text) || /delete/i.test(btn.getAttribute("data-testid") || "")) return btn;
      }
      return null;
    }

    const optionsBtn = findOptionsButton();
    if (!optionsBtn) return false;
    optionsBtn.click();

    let deleteItem = null;
    for (let attempt = 0; attempt < 10 && !deleteItem; attempt++) {
      deleteItem = findMenuItemByText("delete");
      if (!deleteItem) await sleep(150);
    }
    if (!deleteItem) return false;
    deleteItem.click();

    let confirmBtn = null;
    for (let attempt = 0; attempt < 10 && !confirmBtn; attempt++) {
      confirmBtn = findDialogConfirmButton();
      if (!confirmBtn) await sleep(150);
    }
    if (!confirmBtn) return false;
    confirmBtn.click();
    await sleep(300);
    return true;
  }
}

// Injected into the page — must be fully self-contained (no closures over outer scope).
// Detection, matching, and known-answer filling all happen in this single execution because
// DOM element references can't be returned across separate chrome.scripting.executeScript
// calls — only serializable data survives that boundary. Fields with no profile/QA-bank
// match that are safe to auto-generate (free text, not consequential — see isConsequential)
// get stamped with a `data-af-idx` attribute and returned as `unmatched` with
// `canGenerate: true`; the side panel calls /generate-answer for those (a network call the
// page's own CSP might block, so it has to happen in the panel, not here), then runs
// fillGeneratedAnswersInPage as a second pass to fill them back in by that same idx.
async function runAutofillInPage(profile, qaBank) {
  // Label resolution, visibility checks, honeypot/combobox detection, and group/native/shadow
  // field collection (cleanedText, normalizeLabel, resolveOwnLabel, labelForElement, isVisible,
  // isHoneypot, looksLikeComboboxPick, collectFormFields, ...) all come from field-detector.js,
  // injected into this page before this function runs (see the autofillBtn handler) - the SAME
  // code runLearnInPage uses, so a field this function finds is a field Learn finds too, with
  // the same label. Only the autofill-specific matching/generation-eligibility/fill mechanics
  // below are still local to this function.

  function normalizeForMatch(text) {
    return (text || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  }

  function wordOverlapScore(a, b) {
    const wordsA = new Set(normalizeForMatch(a).split(" ").filter((w) => w.length > 2));
    const wordsB = new Set(normalizeForMatch(b).split(" ").filter((w) => w.length > 2));
    if (!wordsA.size || !wordsB.size) return 0;
    let overlap = 0;
    for (const w of wordsA) if (wordsB.has(w)) overlap++;
    return overlap / Math.min(wordsA.size, wordsB.size);
  }

  // Radix/shadcn Select keeps a real <select aria-hidden> beside the visible combobox button
  // (confirmed live: apply.bruntworkcareers.co RAM picker) — read options without opening.
  function findRadixHiddenSelectOptions(element) {
    const scope =
      (element.closest && element.closest(".py-2, .mb-6, .mb-8, .mb-10")) || element.parentElement;
    if (!scope) return [];
    const sel =
      scope.querySelector &&
      scope.querySelector('select[aria-hidden="true"], select[tabindex="-1"]');
    if (!sel) return [];
    return [...sel.options]
      .map((o) => cleanedText(o).trim())
      .filter((t) => t && !isGenericSelectPlaceholder(t));
  }

  // Generation (a real Ollama call) is reserved for fields the form actually blocks submission
  // on without an answer - optional free-text questions get skipped instead of generated, since
  // an AI guess costs real GPU time for a field the applicant could've just left blank anyway.
  // `element.required`/`aria-required` is the reliable signal when present; when it's absent
  // (many ATS custom fields carry neither), the raw, pre-normalizeLabel label text is checked
  // for the same required-marker glyphs normalizeLabel already strips for display ("*", "✱",
  // "(required)") - deliberately NOT checked the other way (treating an unmarked field as
  // required by default), since a false "not required" just means one fewer generation call,
  // while a false "required" spends GPU time on a field the applicant didn't need filled.
  function isRequiredField(element, host) {
    if (element.required) return true;
    if (element.getAttribute && element.getAttribute("aria-required") === "true") return true;
    if (host && host !== element && host.getAttribute && host.getAttribute("aria-required") === "true") return true;
    // Workday "Select One" buttons encode required in aria-label ("Gender Select One Required")
    // rather than aria-required / a visible * alone. Confirmed live on agilent.wd5.
    const ariaLabel = ((element.getAttribute && element.getAttribute("aria-label")) || "").trim();
    if (/\brequired\b/i.test(ariaLabel)) return true;
    // The visual required-asterisk is very commonly wrapped in a decorative aria-hidden span (so
    // a screen reader doesn't read a bare "*" aloud) - confirmed live on BambooHR's "Fabric"
    // design system, EVERY required field's own <label for="..."> carries
    // <span aria-hidden="true">*</span>, and cleanedText() (used internally by resolveOwnLabel's
    // own label[for=id] lookup, a few lines below) already strips anything aria-hidden before
    // this function ever sees the text - the "*"-in-raw-text check below never caught it, so
    // EVERY BambooHR question silently read as "not required" and got skipped ahead of
    // generation entirely, regardless of how genuinely free-text/generatable it otherwise was
    // ("Detail your DevOps experience with...", "How much notice would you need...", etc. all
    // reported as needing manual input instead of ever reaching GPT). Reads the associated
    // <label>'s RAW (un-stripped) textContent directly here, bypassing cleanedText, specifically
    // to still see markers that are legitimately hidden from assistive tech but very much still
    // real, visible required indicators for a sighted applicant filling the form.
    if (element.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (labelEl && /[*•✱]/.test(labelEl.textContent || "")) return true;
    }
    // Zoho Recruit career-site screening forms: required is ONLY marked via
    // `<span class="crc-form-mandatory" aria-hidden="true">*</span>` on a sibling
    // `<label class="crm-from-label" id="crc-label-{name}">` (no `for=`, no native
    // `required`/`aria-required` on the textarea) and/or a `mandatoryField` class on the
    // Lyte wrapper. Confirmed live on easyslotbooking.zohorecruit.in (20260804T084156Z):
    // five mandatory free-text screening questions were detected as unmatched but
    // `canGenerate` stayed false, so gpt-auto never opened a ChatGPT tab.
    const row =
      (element.closest && element.closest(".crc-form-row")) ||
      (host && host.closest && host.closest(".crc-form-row"));
    if (row) {
      if (row.querySelector(".crc-form-mandatory, .mandatoryField")) return true;
      const rowLabel = row.querySelector("label.crm-from-label, label");
      if (rowLabel && /[*•✱]/.test(rowLabel.textContent || "")) return true;
    }
    if (element.closest && element.closest(".mandatoryField")) return true;
    if (host && host.closest && host.closest(".mandatoryField")) return true;
    const zohoName = element.name || (host && host.id) || "";
    if (zohoName) {
      const zohoLabel = document.getElementById(`crc-label-${zohoName}`);
      if (zohoLabel && (/[*•✱]/.test(zohoLabel.textContent || "") || zohoLabel.querySelector(".crc-form-mandatory"))) {
        return true;
      }
    }
    // All Jobs Pro (alljobspro.com) and similar Bootstrap forms: required is shown via
    // `.form-group.has-error`, `.card.border-danger`, and/or `.alert.alert-danger` validation
    // messages — no native `required`, no asterisk. Confirmed live on neals-yard apply
    // (20260806): Q1–Q3, UK work entitlement, source dropdown, and terms consent all stayed
    // "needs input" because `canGenerate`/`isRequiredField` never fired, so gpt-auto never
    // opened a ChatGPT tab.
    const validationAlertRe = /please\s+(answer|read|choose|select|agree)/i;
    const validationScope =
      (element.closest && element.closest(".form-group.has-error, .card.border-danger")) ||
      (host && host.closest && host.closest(".form-group.has-error, .card.border-danger"));
    if (validationScope) {
      const alert = validationScope.querySelector(".alert-danger, .alert.alert-danger");
      if (alert && validationAlertRe.test(alert.textContent || "")) return true;
      if (validationScope.classList.contains("border-danger")) return true;
    }
    const formGroup = element.closest && element.closest(".form-group");
    if (formGroup) {
      const alert = formGroup.querySelector(".alert-danger, .alert.alert-danger");
      if (alert && validationAlertRe.test(alert.textContent || "")) return true;
    }
    // shadcn/ui + React Hook Form (apply.bruntworkcareers.co and similar): no native
    // `required`/`*` — validation uses `aria-invalid="true"` and a sibling
    // `<p class="text-destructive">… is required</p>` / "Please select an option".
    if (element.id && element.getAttribute && element.getAttribute("aria-invalid") === "true") {
      const labelEl = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (!labelEl || !/\(\s*optional\s*\)/i.test(labelEl.textContent || "")) {
        const describedBy = (element.getAttribute("aria-describedby") || "").split(/\s+/);
        for (const msgId of describedBy) {
          const msgEl = msgId && document.getElementById(msgId);
          if (
            msgEl &&
            (msgEl.classList.contains("text-destructive") ||
              (msgEl.className && /text-destructive/.test(msgEl.className))) &&
            (msgEl.textContent || "").trim()
          ) {
            return true;
          }
        }
        const wrap =
          (element.closest && element.closest(".py-2, .mb-6, .mb-8, .mb-10")) || element.parentElement;
        const err =
          wrap &&
          wrap.querySelector('[id$="-form-item-message"], [class*="text-destructive"], .text-destructive');
        if (err && (err.textContent || "").trim()) return true;
      }
    }
    const raw = `${resolveOwnLabel(element, host)} ${findGroupContextLabel(host || element) || ""}`;
    if (/\(\s*required\s*\)/i.test(raw) || /[*•✱]/.test(raw)) return true;
    // PeopleForce career application: required is `class="required"` on the <label>, but the
    // label's `for` points at the question text, NOT the real input id (`field_store_data_*`),
    // so the label[for=id] asterisk check above never fires. Confirmed live on fotc.peopleforce.io:
    // every custom screening question stayed canGenerate:false, so gpt-auto never opened.
    let pfNode = element.parentElement;
    for (let depth = 0; depth < 8 && pfNode; depth++, pfNode = pfNode.parentElement) {
      const pfLabel = pfNode.querySelector(":scope > label.required, label.required");
      if (!pfLabel || !pfNode.contains(element) || pfLabel.contains(element)) continue;
      const controls = pfNode.querySelectorAll(
        'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]), textarea, select'
      );
      if ([...controls].includes(element)) return true;
      break;
    }
    return false;
  }

  // ---- consequential fields: never guess these, only fill from a structured/QA-bank match ----
  // Confirmed live: "Are you a taxpayer in Poland?", "...B2B contract?", and "...able to travel
  // for work?" were all missing from this list entirely and got sent to generation, which
  // returned generic "why I'm a good fit" filler instead of an actual answer to any of them —
  // exactly the class of question this list exists to protect (contract type, tax residency,
  // and travel/relocation willingness are all real, consequential commitments, same as
  // salary/visa/availability already covered below).
  // "Desired Pay" (BambooHR) confirmed missing too — same salary-adjacent category as the
  // "salary"/"compensation" wording already covered, just phrased differently.
  // "Remuneration" (GR8_TECH's own Greenhouse form: "Enter your remuneration expectations")
  // confirmed missing too — a real synonym for salary that let this go all the way to
  // generation instead of being blocked ahead of it, exactly the outcome this list exists to
  // prevent (an AI-invented figure almost got submitted as a real compensation expectation).
  const CONSEQUENTIAL_RE =
    /salary|compensation|remuneration|day\s*rate|hourly\s*rate|rate\s*per|weekly\s*capacity|hours?\s*per\s*week|availability|notice\s*period|start\s*date|visa|sponsor|work\s*permit|authori[sz]e|\bcitizen|security\s*clearance|right\s*to\s*work|tax\s*(payer|resident)|b2b|contract\s*type|\btravel\b|relocat|onboard|desired\s*pay|expected\s*pay|pay\s*rate|pay\s*expect/i;
  function isConsequential(label) {
    return CONSEQUENTIAL_RE.test(label);
  }

  // Legal-consent questions ("I agree to the Privacy Policy") are a stricter case than an
  // ordinary consequential field: reusing a QA-bank answer is fine for "are you authorized to
  // work in Poland" (a stable fact regardless of company), but wrong for "I agree to Company
  // A's privacy policy" being reused against Company B's different policy document — each
  // consent is supposed to be a fresh, deliberate action, not a reusable stored answer. Blocks
  // every fill source (QA-bank included), not just generation.
  // "Do you agree to share your CV (without personal data) with our clients..." - a real,
  // per-company data-sharing consent question - only matched "i agree" before, missing this
  // equally common second-person phrasing of the exact same kind of consent decision.
  const CONSENT_RE = /\b(i|you) agree\b|\bconsent\b|privacy polic|terms (and|&)? ?conditions|terms of service|share your (cv|resume|data|information)/i;
  function isConsentField(label) {
    return CONSENT_RE.test(label);
  }

  // ---- MATCH: structured profile fields ----
  // Picks the most recent job out of profile.experience for "current company"/"headline"
  // lookups below — prefers an entry with no end date or an explicit "Present"/"Current" end
  // date (a genuinely still-ongoing role) over just assuming index 0 is newest, since that
  // ordering isn't guaranteed by the schema itself.
  function currentExperience(p) {
    const exp = p.experience || [];
    return exp.find((e) => !e.end_date || /present|current/i.test(e.end_date)) || exp[0] || null;
  }

  // Workday splits phone into a separate "Country Phone Code" picker plus a plain "Phone
  // Number" field that wants ONLY the local digits — confirmed live, filling that second field
  // with the profile's full "+48694542078" duplicates the "+48" the other field already
  // carries. Reads the calling code straight off whatever Workday's own country-code field is
  // already showing ("1 item selected, Poland (+48)") rather than guessing how many leading
  // digits of the stored number are the country code, since that's genuinely ambiguous from the
  // digit string alone (some calling codes are 1 digit, some 2, some 3).
  function findCountryCallingCode() {
    for (const el of document.querySelectorAll(
      '[data-automation-id="promptAriaInstruction"], [data-automation-id="selectedItem"], [data-automation-id="promptOption"]'
    )) {
      const m = cleanedText(el).match(/\+\d{1,4}/);
      if (m) return m[0];
    }
    // Zoho Recruit <crux-phone-component>: selected dial code is shown as "(+40)" on
    // `.flag-drop-code` (and often also in its aria-label "Mobile : Romania (+40)").
    for (const el of document.querySelectorAll(
      '[lt-prop-user-value="dial_code"] .flag-drop-code, crux-phone-component .flag-drop-code'
    )) {
      const fromText = cleanedText(el).match(/\+\d{1,4}/);
      if (fromText) return fromText[0];
      const fromAria = ((el.getAttribute && el.getAttribute("aria-label")) || "").match(/\+\d{1,4}/);
      if (fromAria) return fromAria[0];
    }
    return null;
  }
  function hasSeparateCountryCodeField() {
    if (
      [...document.querySelectorAll("label")].some((l) =>
        /country.{0,15}code|dial(ing)?\s*code|calling\s*code/i.test(cleanedText(l))
      )
    ) {
      return true;
    }
    // Zoho Recruit: dial-code picker is a <lyte-dropdown lt-prop-user-value="dial_code">
    // sibling of the number input — no <label> text that matches the Workday-style patterns
    // above. Confirmed live on manningglobal.zohorecruit.eu (Mobile field).
    if (document.querySelector('[lt-prop-user-value="dial_code"], crux-phone-component')) return true;
    return false;
  }

  const STRUCTURED_PATTERNS = [
    { re: /^(retype\s+)?e-?mail(\s*address)?\s*$/i, get: (p) => p.contact.email },
    // Negative lookahead excludes "Country Phone Code"/"Phone Device Type"/"Phone Extension" -
    // confirmed live, the plain `phone|mobile|telephone` match swallowed "Country Phone Code"
    // too and typed the full phone number into what's actually a country-code picker.
    {
      re: /^(?!.*\b(code|type|extension|device)\b).*\b(phone|mobile|telephone)\b/i,
      get: (p, element) => {
        const phone = p.contact.phone || "";
        if (!phone) return phone;
        // Zoho Recruit's <crux-phone-component> splits dial-code + local number; setPhoneValue
        // drives both from the full "+CC..." string against the widget's own country list.
        // Passing the already-stripped local digits would leave a wrong pre-selected dial
        // code (e.g. Romania +40 on a Polish +48 profile) untouched. Confirmed live on
        // manningglobal.zohorecruit.eu.
        if (document.querySelector("crux-phone-component, [lt-prop-user-value='dial_code']")) return phone;
        if (element && element.closest && element.closest('[data-component="pf-phone-number"]')) return phone;
        // intl-tel-input (`.iti`, e.g. Greenhouse's own "Phone" field) auto-derives its own
        // embedded country flag by parsing the FULL "+CC…" string itself via setPhoneValue's
        // iti.setNumber() call — stripping the code away here first would leave it with no way
        // to detect the country at all, defaulting to whatever it initializes with instead of
        // the real one. Only Workday-style plain inputs (no auto-parsing of their own) actually
        // want the pre-stripped local digits handed to them directly.
        if (element && element.closest && element.closest(".iti, [class*='PhoneInput']")) return phone;
        if (!hasSeparateCountryCodeField()) return phone;
        const code = findCountryCallingCode();
        return code && phone.startsWith(code) ? phone.slice(code.length).trim() : phone;
      },
    },
    { re: /linkedin/i, get: (p) => p.contact.linkedin },
    { re: /website|portfolio/i, get: (p) => p.contact.website },
    {
      re: /^links?\b/i,
      get: (p) => [p.contact.linkedin, p.contact.website].filter(Boolean).join(", ") || null,
    },
    // Split out from a single combined "city|location|address" -> location pattern after a
    // real form asked for "Address" and "City" as two separate fields, both of which got
    // filled with the same value ("Warsaw") since both matched the one combined pattern.
    // Order matters here: more specific patterns are checked first, since a broader one
    // (e.g. "location") would otherwise swallow a field a later, narrower pattern should
    // have matched instead.
    { re: /postal\s*code|zip\s*code|\bzip\b/i, get: (p) => p.contact.postal_code },
    { re: /^street\b|address\s*line|^address\b/i, get: (p) => p.contact.street_address },
    // Broadened beyond a bare leading "City" after a real Greenhouse form's "Enter your current
    // location city" fell through unmatched - "city" is the LAST word, not the first, in that
    // phrasing, so the anchored-to-start pattern never matched it even though it's asking for
    // exactly the same profile fact.
    { re: /^city\b|\bcity\s*$/i, get: (p) => p.contact.city },
    // ContactInfo.state was originally left out of structured matching entirely - some "State"
    // questions carry form-specific conditions a profile value can't know about (e.g. "select
    // N/A unless you live in the US or Australia"). Reported live: BambooHR's plain "Province"
    // field (a real text input, no dropdown/cascading logic at all) was left unmatched as a
    // direct result, meaning it either needed manual input or risked an UNGROUNDED AI guess via
    // generation - a worse outcome than just using the real profile value for the common case.
    // Requires the WHOLE (normalized) label to be just "State"/"Province" and nothing else - an
    // earlier version anchored only to the start (`^(state|province)\b`), which a synthetic test
    // caught matching "State (select N/A unless you live in the US or Australia)" too, since
    // that label genuinely starts with "State" - exactly the conditional-wording risk this was
    // supposed to avoid. Requiring the ENTIRE label correctly excludes any trailing qualifier
    // text, falling through to the old safe behavior (QA bank / manual) for those.
    { re: /^(state|province)\s*$/i, get: (p) => p.contact.state },
    // Excludes "Country Phone Code" - confirmed live, that field starts with "Country" too and,
    // once excluded from the phone pattern above, would otherwise fall through and get filled
    // with "Poland" (the residence country) instead of being left for the dial-code picker.
    { re: /^country\b(?!.*\b(phone|code|dial)\b)/i, get: (p) => p.contact.country },
    { re: /country of residence|current country of residence/i, get: (p) => p.contact.country },
    // Broadened beyond a bare leading "Location" after a Recruitee form's "Where are you
    // currently located? (City, country)" fell through to generation and got answered with the
    // candidate's own tech stack instead (a small local model, given a job description that
    // heavily repeats React/TypeScript/etc., producing a wrong, off-topic non-sequitur for a
    // plain personal-info question) - the same "broaden structured coverage so generation is
    // never even reached" fix as the Workday alias above, not a smarter/costlier check on
    // whatever the model happens to generate.
    { re: /^location\b|current(ly)?\s+located|where.*(you|currently).*(located|based)/i, get: (p) => p.contact.location },
    // "Given Name(s)"/"Family Name" are Workday's own terms for first/last name - confirmed
    // live, without these aliases neither pattern matched, so the field fell through to Ollama
    // generation, which returned "Polish" (the candidate's nationality, from the QA bank) for
    // "Family Name" instead of the actual surname - a small local model has no way to reliably
    // resolve a vaguely-worded label a plain profile lookup answers correctly and for free.
    { re: /^first\s*name|^given\s*name|\bname\s*-\s*first\b|^first$/i, get: (p) => (p.contact.name || "").split(" ")[0] || "" },
    { re: /^preferred(\s+first)?\s*name/i, get: (p) => (p.contact.name || "").split(" ")[0] || "" },
    { re: /^last\s*name|^family\s*name|^surname\b|\bname\s*-\s*last\b|^last$/i, get: (p) => (p.contact.name || "").split(" ").slice(1).join(" ") },
    // Excludes referral/nomination-context questions - confirmed live, a real Greenhouse form's
    // "Enter the full name of our employee who suggested this job opportunity" (explicitly
    // described as "Only if the job opportunity was suggested to you by one of our employees")
    // was wrongly filled with the APPLICANT'S OWN name via this pattern, since "full name"
    // appears in the sentence regardless of whose name is actually being asked for - a real,
    // actively wrong answer (implying self-referral / corrupting the referrer field), not just
    // a missed field.
    { re: /^(?!.*\b(referr\w*|recommend\w*|suggest\w*|nominat\w*)\b).*\bfull\s*name\b|^name$/i, get: (p) => p.contact.name },
    { re: /^typed\s*signature\b/i, get: (p) => p.contact.name },
    // "Current company" / "Headline" are plain lookups into the most recent experience entry,
    // not something to hand to Ollama — confirmed live, generation answered these with a full
    // sentence ("I am currently working at X where...") when the form wanted just "X", since a
    // free-text prompt has no way to know a field wants one word instead of a paragraph. Direct
    // profile lookup is also instant and free, unlike a generation call.
    {
      re: /current\s*(company|employer)|^employer$/i,
      get: (p) => (currentExperience(p) || {}).company || null,
    },
    {
      re: /headline|current\s*(job\s*)?title|current\s*position/i,
      get: (p) => {
        const e = currentExperience(p);
        return e ? `${e.title} at ${e.company}` : null;
      },
    },
  ];

  // Returns whether `label` matches a structured category at all (email/phone/name/...) as
  // well as the profile's value for it. A label matching the category but with no profile
  // value (e.g. no phone on file) must never fall through to generation — a missing factual
  // detail should be asked for, not invented, same as a missing resume fact.
  function isPhoneDialCodePicker(element) {
    return Boolean(element && element.closest && element.closest(".phone-input__country"));
  }

  function matchStructuredField(label, element) {
    for (const { re, get } of STRUCTURED_PATTERNS) {
      if (re.test(label)) {
        // Greenhouse phone widget: bare "Country" is the dial-code picker, not residence.
        if (/^country\b/i.test(label) && isPhoneDialCodePicker(element)) continue;
        const value = get(profile, element);
        return { isStructuredCategory: true, value: value || null };
      }
    }
    // PeopleForce pf-phone-number: visible tel id uses brackets (`career_application_form[phone_numbers][]`)
    // so label[for=id] never links — resolveOwnLabel usually recovers "Phone numbers", but when it
    // doesn't (Vue mount timing), still treat any input inside the widget as the profile phone.
    if (element && element.closest && element.closest('[data-component="pf-phone-number"]')) {
      const phone = (profile.contact && profile.contact.phone) || "";
      if (phone) return { isStructuredCategory: true, value: phone };
    }
    return { isStructuredCategory: false, value: null };
  }

  // A handful of application-boilerplate questions recur on nearly every ATS but with the
  // company's own name filled into an otherwise-identical template — "Have you ever been
  // employed by New Relic?" vs. a generic stored answer for "Have you ever worked at this
  // company before?" share almost no literal words (employed≠worked, New Relic≠company), so
  // plain word-overlap can never bridge them. Matched by category via regex instead, same
  // idea as STRUCTURED_PATTERNS but for QA-bank lookups.
  const CATEGORY_PATTERNS = [
    // Excludes "worked with" specifically - confirmed live, "Which cloud platforms have you
    // worked with?" (a technology-experience checklist, nothing to do with prior employment)
    // was matching this boilerplate "have you ever worked here before" category purely on
    // unanchored substring overlap ("have you...worked" is present in both), which then let
    // category-match short-circuit past word-overlap scoring entirely and pull in an unrelated
    // saved "No" answer from a genuine worked-here-before question. Real boilerplate phrasing
    // ("worked here", "worked at this company", "been employed by X") never says "worked with" -
    // that phrasing specifically signals collaborating with a tool/technology/person, not being
    // employed by an entity.
    { key: "worked_here_before", re: /have you.{0,40}(worked(?!\s+with\b)|been employed)\b/i },
    { key: "currently_employed_here", re: /(are you )?currently (working|employed)\b/i },
    // "Eligible to work" confirmed live as a real wording variant (Globalization Partners'
    // Greenhouse form: "Are you currently eligible to work in the country where this role is
    // posted without visa sponsorship?") that "authorized to work" alone didn't catch, meaning
    // a saved answer for the same underlying question never got reused via category match.
    { key: "authorized_to_work", re: /authori[sz]ed to work|legally authorised to work/i },
    { key: "eligible_to_work", re: /^eligible to work$/i },
    { key: "requires_sponsorship", re: /(require|need|will).{0,25}(sponsorship|visa)/i },
    {
      key: "salary_expectations",
      re: /\bsalary\b|\bcompensation\b|\b(?:pay|rate)\b.{0,20}\bexpect|\bmonthly\s*rate\b|\bdesired\s+net\b/i,
    },
    { key: "related_to_employee", re: /related to anyone|relative.{0,20}(at|with|of)\b/i },
    {
      key: "notice_period",
      re: /\bnotice period\b|when can you start|earliest (start|availability)|\bavailable from\b|\bavailable to start\b/i,
    },
    { key: "b2b_contract", re: /\bb2b\b.*\b(model|contract)\b|\bcontract\s*type\b/i },
    { key: "nationality", re: /\bnationality\b/i },
    {
      key: "english_proficiency",
      re: /\benglish\b.*\b(level|proficiency|fluency|language)\b|\bfluency in english\b/i,
    },
    {
      key: "polish_proficiency",
      re: /\bpolish\b.*\b(level|proficiency|fluency|language)\b|\bproficiency in polish\b/i,
    },
    { key: "relocation", re: /\brelocat|currently based|based in\b/i },
    { key: "gender", re: /\bgender\b/i },
    { key: "hispanic_latino", re: /\bhispanic\b|\blatino\b/i },
    { key: "veteran_status", re: /\bveteran\b/i },
    { key: "disability_status", re: /\bdisabilit/i },
    { key: "race_ethnicity", re: /\brace\b|\bethnicity\b/i },
  ];
  function detectCategory(text) {
    for (const { key, re } of CATEGORY_PATTERNS) {
      if (re.test(text)) return key;
    }
    return null;
  }

  function isPlausibleQaComboboxAnswer(label, answer) {
    const a = String(answer || "").trim();
    if (!a) return false;
    const cat = detectCategory(label);
    if (cat === "authorized_to_work" || cat === "requires_sponsorship") {
      if (/^\+\d{1,4}$/.test(a) || /^\d+$/.test(a)) return false;
    }
    if (cat === "nationality" && /^none$/i.test(a)) return false;
    if (cat === "disability_status" && /^\d+$/.test(a)) return false;
    return true;
  }

  // "what"/"your" recur across nearly every boilerplate application question ("What is your
  // ___?"), so two genuinely unrelated questions phrased that way can share only these two
  // words and still clear the overlap bar below purely from sentence-template overlap, not
  // actual meaning - confirmed live, "What is your current location?" and "What is your salary
  // expectation...?" both got silently filled with a saved "What is your preferred messenger?
  // Please provide your ID/name" answer this way. Excluded explicitly since neither is filtered
  // by length alone (both 4 chars).
  const MATCH_QA_STOPWORDS = new Set(["what", "your"]);
  function matchQaBank(label, element) {
    const normLabel = normalizeForMatch(label);
    if (normLabel === "country" && element && element.closest && element.closest(".phone-input__country")) {
      return null;
    }
    const labelWords = new Set(normLabel.split(" ").filter((w) => w.length > 2 && !MATCH_QA_STOPWORDS.has(w)));
    const labelCategory = detectCategory(label);
    let best = null;
    let bestScore = 0;
    for (const entry of qaBank) {
      const normQuestion = normalizeForMatch(entry.question);
      // Exact match (after normalizing) always wins outright — this is what makes a
      // legitimately short label like "Country" matchable against a QA-bank entry also
      // titled "Country", without opening the door to it matching any longer question that
      // merely happens to mention the word "country" once (see the general path below).
      if (normLabel && normLabel === normQuestion) return entry;
      // Same recurring boilerplate category, even though the literal wording differs
      // (a different company name filled into the same underlying question).
      if (labelCategory && detectCategory(entry.question) === labelCategory) return entry;
      const qWords = new Set(normQuestion.split(" ").filter((w) => w.length > 2 && !MATCH_QA_STOPWORDS.has(w)));
      if (!labelWords.size || !qWords.size) continue;
      let overlap = 0;
      for (const w of labelWords) if (qWords.has(w)) overlap++;
      const score = overlap / Math.min(labelWords.size, qWords.size);
      // A ratio/count bar alone isn't enough: two DIFFERENT specific instances of the same
      // boilerplate template ("What's your proficiency level in X?", "...seniority level
      // associated with X?") share every significant word except X and still clear a high
      // ratio, since X is the only thing that ever differs - confirmed live, a saved "English
      // proficiency: Advanced" answer would otherwise get reused for a separate "Polish
      // proficiency" question on the same form (overlap=2, score=0.67), and a saved "Java and
      // Spring Boot" seniority answer for a separate "AWS" seniority question (overlap=5,
      // score=0.83) - both would misrepresent real skills/language claims to an employer.
      // Requiring the combined vocabulary to differ by at most one word closes that gap.
      const unionSize = new Set([...labelWords, ...qWords]).size;
      // Require at least 2 shared significant words — a single shared word is too easy to
      // hit by coincidence (e.g. "country" alone matching an unrelated visa question).
      if (overlap >= 2 && score >= 0.5 && unionSize - overlap <= 1 && score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return best;
  }

  // ---- FILL ----
  function nativeSet(element, value) {
    // React (and similar) tracks input values through its own property setter; a plain
    // `element.value = x` write is invisible to it and gets silently reverted on the next
    // render. Calling the native setter directly, then dispatching input/change, is the
    // standard workaround for filling React-controlled fields (common across modern ATSs).
    const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    const str = value == null ? "" : String(value);
    // Focus first so a subsequent blur is a real focus→blur pair. Ashby application forms
    // (jobs.ashbyhq.com) keep the committed answer in React state and only persist it to their
    // backend via a 500ms-debounced GraphQL mutation that flushes immediately on blur —
    // confirmed live on emergence/.../application (20260804T085520Z): Auto Fill left Name /
    // Email / salary looking filled in the DOM, but Submit reported "Missing entry for
    // required field" until the user clicked each field once (focus) and submitted again
    // (blur). Without this focus/blur, the mutation never ran and server-side validation
    // still saw empty values.
    try {
      element.focus();
    } catch {
      /* not focusable */
    }
    if (setter) setter.call(element, str);
    else element.value = str;
    // InputEvent (not a plain Event) — closer to what a real keystroke/paste produces; Ashby's
    // text wrapper reads e.target.value off the change handler React wires from onChange.
    if (typeof InputEvent === "function") {
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: str })
      );
    } else {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    // Some widgets sync their own internal model off keyboard events specifically, not input/
    // change - confirmed live, a Zoho Recruit phone field's own component binds its handlers via
    // keypress="..."/keyup="..."/paste="..." attributes and nothing else, so the value set above
    // (even via the native setter, with input/change already dispatched) was invisible to it and
    // got silently reverted to empty on its next re-render - Auto Fill reported the field filled
    // while the real page showed it blank. A generic keyup (bubbles, harmless to anything that
    // doesn't specifically listen for it) covers this without needing to know the exact
    // framework or which key it expects.
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
    try {
      element.blur();
    } catch {
      /* ignore */
    }
  }

  // Same reasoning as nativeSet above, just for `checked` instead of `value` - React (and
  // similar) tracks a controlled checkbox/radio's checked state through its own overridden
  // property setter too, not just its own value setter. A plain `element.checked = x` write
  // goes through THAT SAME overridden setter, silently updating React's own internal tracked
  // state to already match - so the change/input events dispatched right after get compared
  // against a tracked value that ALREADY agrees, and React sees no real change to react to.
  // Confirmed live: a required consent checkbox on Atolls' own application form visually
  // ticked correctly (a real, genuine DOM-level checked state change did happen) but the
  // site's own validation (`aria-invalid`, a visible "Please accept the terms to proceed."
  // error) never cleared - exactly the "looks filled, framework never noticed" symptom
  // nativeSet already exists to prevent for text fields, just never applied to checked before.
  function nativeSetChecked(element, checked) {
    const want = Boolean(checked);
    // Workday (and native checkboxes generally) treat a synthetic click as a TOGGLE. Confirmed
    // live on intapp.wd1.myworkdayjobs.com: "I currently work here" was already correctly
    // checked for a Present role; setting checked=true then firing click flipped it OFF and
    // cleared/broke the paired To date. If aria-checked/checked already matches, do nothing.
    const aria = element.getAttribute("aria-checked");
    const isOn = aria === "true" ? true : aria === "false" ? false : Boolean(element.checked);
    if (isOn === want) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked") &&
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked").set;
    if (setter) setter.call(element, want);
    else element.checked = want;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    // Some widgets listen for a real click specifically, not input/change (the same category
    // of gap nativeSet's own trailing keyup covers for text fields) - a full mousedown/mouseup/
    // click sequence is the closest synthetic equivalent to a real user click, cheap insurance
    // even where it isn't strictly needed.
    for (const type of ["mousedown", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  }

  // intl-tel-input replaces the plain phone <input> with a widget that tracks its own
  // country selector separately from the input's raw text. Setting .value directly (even
  // via nativeSet) bypasses the library's own number-parsing entirely, leaving the flag on
  // its default country while the raw "+48..." text sits in the field unparsed — its own
  // setNumber() API is what actually syncs both. Falls back to a plain fill if this isn't
  // an intl-tel-input field (or the library's global isn't reachable on this page).
  // Async: the DOM fallback must wait for the country list to open before clicking a row —
  // opening via `.iti__selected-flag` then immediately clicking raced the dropdown (reported
  // live after that toggle selector was widened for Workable).
  async function setPhoneValue(element, value) {
    // React tracks controlled inputs via a `_valueTracker` that caches the last value IT saw -
    // intl-tel-input's setNumber() writes `.value` through its OWN internal DOM assignment, with
    // no idea a React component might also be watching this same input, so it never touches that
    // tracker. If the tracker's cached value already equals whatever setNumber() just wrote (or
    // simply never gets told a change happened), React's synthetic event system can decide "this
    // input event doesn't represent an actual change" and skip invoking the component's own
    // onChange - meaning React's OWN internal state for this field never updates to match what's
    // now visibly on screen. The DOM looks right until ANY unrelated later re-render (opening a
    // completely different select/combobox elsewhere on the page is enough to trigger one) causes
    // React to re-render this input from its own (still-stale, pre-fill) state, silently reverting
    // the visible value - confirmed live: reported as "I open a totally unrelated dropdown further
    // down the form, and the phone number field suddenly changes back." Resetting the tracker to
    // the PRE-change value right before setNumber() runs (same trick nativeSet already uses for
    // plain text inputs) makes React see a genuine transition and update its own state to match,
    // so a later re-render has nothing stale left to revert to.
    const resetTracker = () => {
      const tracker = element._valueTracker;
      if (tracker) {
        try {
          tracker.setValue(element.value);
        } catch {
          /* ignore */
        }
      }
    };
    try {
      const globals = window.intlTelInputGlobals;
      if (globals && typeof globals.getInstance === "function") {
        const iti = globals.getInstance(element);
        if (iti && typeof iti.setNumber === "function") {
          resetTracker();
          iti.setNumber(value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      if (window.jQuery) {
        const plugin = window.jQuery(element).data && window.jQuery(element).data("plugin_intlTelInput");
        if (plugin && typeof plugin.setNumber === "function") {
          resetTracker();
          plugin.setNumber(value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      // Neither JS API was reachable — common in bundled SPA builds (confirmed live on a
      // Workable form) that import the library as a private module and never attach it to
      // `window` or jQuery at all. Fall back to driving the widget's own DOM directly: its
      // country-list <li> items carry the dial code as a data attribute regardless of
      // whether the dropdown is currently open, so the right country can be selected with
      // simulated clicks — the same interaction path a real user would take — without any
      // JS hook into the page's internals.
      const wrapper = element.closest(".iti");
      const digitsMatch = String(value).match(/^\+(\d+)/);
      if (wrapper && digitsMatch) {
        // Calling codes are 1-3 digits with no way to know the boundary from the digits
        // alone (e.g. "+48573503853" could a priori split as "4"+"8573503853" or
        // "48"+"573503853" or "485"+"73503853") — resolve the ambiguity against the page's
        // own list of real dial codes instead of guessing, trying the longest prefix first.
        const digits = digitsMatch[1];
        let countryItem = null;
        let dialCodeLen = 0;
        for (let len = Math.min(3, digits.length); len >= 1; len--) {
          const item = wrapper.querySelector(`li[data-dial-code="${digits.slice(0, len)}"]`);
          if (item) {
            countryItem = item;
            dialCodeLen = len;
            break;
          }
        }
        // No matching dial code found in this widget's own list at all — the guess would
        // just corrupt the number, so leave it alone and fall through to a plain fill of
        // the untouched original value below rather than a wrongly-split one.
        if (countryItem) {
          const list = wrapper.querySelector(".iti__country-list");
          const listAlreadyOpen =
            list &&
            !list.classList.contains("iti__hide") &&
            list.getAttribute("aria-expanded") !== "false" &&
            list.getBoundingClientRect().height > 0;
          if (!listAlreadyOpen) {
            const toggle = wrapper.querySelector(
              ".iti__selected-flag, .iti__selected-country, [class*='selected-country'], [class*='selected-flag']"
            );
            if (toggle) {
              toggle.click();
              for (let attempt = 0; attempt < 25; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 40));
                const open =
                  list &&
                  !list.classList.contains("iti__hide") &&
                  list.getBoundingClientRect().height > 0;
                const rowVisible =
                  countryItem.getBoundingClientRect().width > 0 &&
                  countryItem.getBoundingClientRect().height > 0;
                if (open || rowVisible) break;
              }
              // Settle after the list paints — phone country needs this longer than generic selects.
              await new Promise((resolve) => setTimeout(resolve, 180));
            }
          }
          countryItem.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const localNumber = String(value).slice(1 + dialCodeLen).trim();
          nativeSet(element, localNumber);
          return true;
        }
      }
    } catch {
      // Fall through to a plain value-set below rather than leaving the field untouched.
    }
    return false;
  }

  function setSelectValue(select, value) {
    let desired = String(value).trim();
    const options = [...select.options];
    const optionTexts = options.map((o) => cleanedText(o)).filter((t) => t && !isGenericSelectPlaceholder(t));
    // QA bank often stores plain "Fluent"/"Advanced" while Personio/Ashby use CEFR labels
    // ("C1 - Advanced", "B2 - Upper Intermediate", …) — map common synonyms before matching.
    if (
      optionTexts.some((t) => /\bA1\b/i.test(t) || /\bC1\b/i.test(t)) &&
      /fluent|native|proficient|advanced|c1|c2|mastery/i.test(desired.toLowerCase())
    ) {
      const cefr =
        optionTexts.find((t) => /\bC2\b/i.test(t) && /mastery|proficient/i.test(t)) ||
        optionTexts.find((t) => /\bC1\b/i.test(t)) ||
        optionTexts.find((t) => /advanced/i.test(t)) ||
        optionTexts.find((t) => /upper intermediate/i.test(t));
      if (cefr) desired = cefr;
    } else if (
      optionTexts.some((t) => /\bB1\b/i.test(t)) &&
      /\bintermediate\b/i.test(desired.toLowerCase()) &&
      !/upper/i.test(desired.toLowerCase())
    ) {
      const b = optionTexts.find((t) => /\bB1\b/i.test(t) || /intermediate/i.test(t));
      if (b) desired = b;
    } else if (
      optionTexts.some((t) => /\bA1\b/i.test(t)) &&
      /\b(beginner|elementary|basic)\b/i.test(desired.toLowerCase())
    ) {
      const a = optionTexts.find((t) => /\bA1\b/i.test(t) || /beginner/i.test(t));
      if (a) desired = a;
    }
    const target = desired.toLowerCase();
    let matches = options.filter((o) => cleanedText(o).toLowerCase() === target);
    if (!matches.length) {
      matches = options.filter(
        (o) => cleanedText(o).toLowerCase().includes(target) || target.includes(cleanedText(o).toLowerCase())
      );
    }
    if (!matches.length) return false;
    if (select.multiple) {
      options.forEach((o) => {
        o.selected = matches.includes(o);
      });
    } else {
      select.value = matches[0].value;
    }
    // select2 (and similar) listen for the underlying <select>'s native change event to
    // resync their fake UI — no extra library-specific call needed beyond this.
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function clickGroupOption(options, desiredText) {
    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(desiredText);
    let best = options.find((o) => norm(o.optionLabel) === target);
    if (!best && /^(yes|true|y)$/i.test(target)) best = options.find((o) => /^yes$/i.test(norm(o.optionLabel)));
    if (!best && /^(no|false|n)$/i.test(target)) best = options.find((o) => /^no$/i.test(norm(o.optionLabel)));
    if (!best) {
      let bestScore = 0;
      for (const o of options) {
        const score = wordOverlapScore(o.optionLabel, desiredText);
        if (score > bestScore) {
          bestScore = score;
          best = o;
        }
      }
      if (bestScore < 0.5) best = null;
    }
    if (!best) return false;
    const el = best.element;
    if (el.tagName === "BUTTON") {
      el.click();
    } else if (el.tagName === "A") {
      el.click();
    } else if (el.tagName === "SPL-RADIO" || (el.getAttribute && el.getAttribute("role") === "radio" && el.tagName.includes("-"))) {
      el.click();
    } else {
      // Comeet (and similar) zero-size styled radios: Angular binds via the visible
      // label/option-title click, not a programmatic `.checked` write. Prefer the label.
      const label =
        (el.id &&
          (() => {
            try {
              return document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            } catch {
              return null;
            }
          })()) ||
        (el.closest && el.closest("li") && el.closest("li").querySelector("label.checkboxLabel, label"));
      if (label) {
        label.click();
      } else {
        // Confirmed live: setting `.checked = true` and THEN calling the real `.click()`
        // afterward used to unconditionally flip it right back to unchecked - a genuine
        // `.click()` on a checkbox always TOGGLES its current state, regardless of how that
        // state got there. nativeSetChecked is the one and only place `checked` gets set now,
        // so there's no second toggle left to undo it (see its own comment for why it's needed
        // at all, over a plain assignment).
        nativeSetChecked(el, true);
      }
    }
    return true;
  }

  // react-select-style comboboxes don't expose a real <select> — picking an option means
  // opening the dropdown and clicking the rendered option, same as a real user would. Its
  // menu/option elements share the same classNamePrefix already visible on the closed
  // control (e.g. "select__control", "select__value-container") — react-select always
  // derives every sub-element's class from that one prefix, so once we've seen it on the
  // control, "{prefix}__menu"/"{prefix}__option" is a reliable target, not a guess about
  // custom site markup. Falls back to a generic `[role="listbox"]`/`[role="option"]` search
  // if no prefixed classes are found (covers non-react-select comboboxes built differently).
  // react-select's control opens its menu on `mousedown`, not `click` — a well-known quirk
  // (it's why testing tools for react-select all document the same workaround). A
  // programmatic `.click()` only ever fires a "click" event, which react-select's own
  // handlers never see, so the menu silently never opens — confirmed live: it looked like
  // filling silently failed on a real page even with a correct QA-bank match, and this was
  // why. Firing the full mousedown/mouseup/click sequence a real click naturally produces
  // fixes it, and is harmless for anything that listens for plain "click" instead.
  //
  // Also fires the matching PointerEvent pair (a real click dispatches pointerdown/pointerup
  // ahead of the mouse events, in that order) - confirmed live on TWO structurally unrelated
  // widget frameworks (a react-select combobox on Greenhouse, and Zoho Recruit's own
  // proprietary "Lyte" dropdown component) that the exact same symptom occurs: the menu opens,
  // typing filters it, aria-activedescendant correctly tracks the right option (the widget's
  // own lightweight hover/focus-highlight, which DOES respond to the mouse events already being
  // sent) - but the actual pick is never committed. Since this spans two unrelated frameworks
  // rather than one library's specific quirk, the likely gap is that the handler which commits
  // a selection (as opposed to just highlighting it) is bound to PointerEvent, which this
  // function never sent before now. Unverified without a live click test - if this doesn't fix
  // it, the next thing to check is whether the widget's handler specifically checks
  // event.isTrusted (unfakeable from a content script; no synthetic event could satisfy it).
  function simulateClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    // PointerEvent's own `isPrimary` defaults to false unless explicitly set - a real mouse
    // click always produces isPrimary:true, and a component library built pointer-event-first
    // (confirmed live: BambooHR's "Fabric" design-system Select button - a manual click opens
    // it normally, but this same dispatch sequence silently did nothing) can reasonably gate
    // its own open/activate logic on exactly that check, silently ignoring a pointerdown that
    // reports isPrimary:false as a secondary/synthetic touch point rather than a real click.
    // pointerId/pointerType filled in the same way a genuine mouse-originated pointer event
    // would have them, not left at PointerEventInit's own defaults (pointerId 0, pointerType "").
    const pointerOpts = { ...opts, pointerId: 1, pointerType: "mouse", isPrimary: true };
    if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // Last-resort fallback for a widget whose own JS specifically checks event.isTrusted before
  // reacting (confirmed live: BambooHR's "Fabric" Select component - a real manual click opens
  // its dropdown, but no synthetic dispatchEvent sequence ever does, on this one widget
  // specifically, despite the same simulateClick working correctly on every other site tested).
  // isTrusted can never be set to true by any script, by deliberate browser design - the only
  // way around it is dispatching input at the browser-internals level via the Chrome DevTools
  // Protocol (background.js's TRUSTED_CLICK handler, using chrome.debugger), which Chrome treats
  // as genuinely trusted. Shows a real, unavoidable "this extension started debugging this
  // browser" banner for the brief moment it's attached - only used as an explicit fallback when
  // simulateClick's own (invisible, no-banner) attempt produced no visible effect, never as the
  // default path. Returns false (not throwing) on any failure, so callers can just fall through
  // to reporting the field as unmatched exactly as if this fallback didn't exist.
  function trustedClick(el) {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
          resolve(false);
          return;
        }
        const rect = el.getBoundingClientRect();
        let x = rect.left + rect.width / 2;
        let y = rect.top + rect.height / 2;
        let win = el && el.ownerDocument && el.ownerDocument.defaultView;
        while (win && win !== win.top) {
          const frameEl = win.frameElement;
          if (!frameEl) break;
          const fr = frameEl.getBoundingClientRect();
          x += fr.left;
          y += fr.top;
          win = win.parent;
        }
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          resolve(ok);
        };
        setTimeout(() => finish(false), 600);
        chrome.runtime.sendMessage({ type: "TRUSTED_CLICK", x, y }, (response) => {
          finish(Boolean(response && response.ok));
        });
      } catch {
        resolve(false);
      }
    });
  }

  // Finds whatever rendered as the option list after opening a combobox, trying
  // increasingly generic strategies so a site that follows neither react-select's own
  // naming convention nor standard ARIA roles still has a chance of working: (1) this
  // control's own classNamePrefix convention, most targeted since it's specific to this
  // exact widget; (2) standard `role="listbox"`/`role="option"` ARIA, followed by any
  // `role="option"` at all; (3) fully generic — whatever short, visible, newly-appeared
  // element showed up after the click, regardless of how this particular site built its
  // dropdown. `before` is a snapshot of every element present prior to opening, so tier 3
  // reacts to what actually changed on the page rather than assuming any convention.
  // A page with several react-select instances sharing the same classNamePrefix (very
  // common — Country, State, "Country of residence" and more all use the same "select__"
  // convention on the New Relic form) can have an EARLIER field's menu/options still
  // technically present in the DOM (closed visually, e.g. via CSS or a pending removal
  // animation, but not actually detached) at the moment a LATER field's dropdown gets
  // opened. An unscoped `document.querySelector` for "the first menu/option on the page"
  // has no way to tell that apart from the one just opened for THIS field — confirmed live:
  // an already-correctly-filled phone country code silently changed to a different one while
  // a *different* combobox was being filled later in the same run. Filtering every candidate
  // by `!before.has(...)` (present before this click, so definitely not the fresh one) at
  // the *option* level, not just the outermost container, closes that gap for all three
  // tiers instead of only the generic fallback.
  // Light-DOM querySelectorAll cannot see open shadow trees. SmartRecruiters' City widget
  // (`<spl-autocomplete>`) renders suggestions as `<spl-select-option>` / `.c-spl-dropdown-item`
  // inside nested open shadow roots — confirmed from oneclick-ui vendor.js + live capture
  // jobs-smartrecruiters-com-20260804T081827Z (typed "bucharest", suggestions open): outerHTML
  // only shows an empty `<spl-autocomplete>…</spl-autocomplete>` with no "Bucharest" text at all.
  // Without piercing shadow, findComboboxOptions returned nothing useful / wrong light-DOM leaves
  // and the location pick never stuck.
  function querySelectorAllDeep(selector, root) {
    const out = [];
    const visit = (node) => {
      if (!node || !node.querySelectorAll) return;
      out.push(...node.querySelectorAll(selector));
      for (const el of node.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root || document);
    return out;
  }

  function collectVisibleDeep(root) {
    const visible = new Set();
    const visit = (node) => {
      if (!node || !node.querySelectorAll) return;
      for (const el of node.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) visible.add(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root || document);
    return visible;
  }

  function isDisabledComboboxOption(el) {
    if (!el) return true;
    if (el.disabled || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled")) return true;
    if (el.classList && (el.classList.contains("c-spl-dropdown-item--disabled") || el.classList.contains("c-spl-load-more"))) {
      return true;
    }
    const id = `${el.getAttribute("value") || ""} ${el.getAttribute("data-sr-id") || ""} ${el.id || ""}`;
    if (/#spl-no-match|no-match-option|no_match/i.test(id)) return true;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (/^no matches?( found)?$/i.test(text)) return true;
    return false;
  }

  // SmartRecruiters wires @click on the inner `.c-spl-dropdown-item` (shadow), not on the
  // Prefer the interactive option row over an inner text leaf (span/div). Clicking only the
  // leaf often highlights but never commits the pick — menu opens then closes with no value
  // (reported live as an open/close loop on job-board selects). Also pierces SmartRecruiters
  // `<spl-select-option>` shadow for the real `.c-spl-dropdown-item` hit target.
  function resolveOptionClickTarget(el) {
    if (!el) return el;
    const optionish =
      (el.closest &&
        el.closest(
          '[role="option"], [role="treeitem"], [role="menuitem"], [class*="__option"], .c-spl-dropdown-item, spl-dropdown-item, a.notBranded, .dropdown-menu li > a, li[id*="react-select"]'
        )) ||
      el;
    if (optionish.matches && optionish.matches(".c-spl-dropdown-item, spl-dropdown-item, [role='option']")) {
      return optionish;
    }
    if (optionish.shadowRoot) {
      const inner = optionish.shadowRoot.querySelector(".c-spl-dropdown-item, spl-dropdown-item, [role='option']");
      if (inner) return inner;
    }
    const host = optionish.closest && optionish.closest("spl-select-option, spl-dropdown-item");
    if (host && host.shadowRoot) {
      const inner = host.shadowRoot.querySelector(".c-spl-dropdown-item, [role='option']");
      if (inner) return inner;
    }
    return optionish;
  }

  // Commit a combobox suggestion: pointer sequence + native click (some ATS only listen to
  // one of them). If the control stays aria-expanded, fall back to a trusted CDP click.
  // Post-pick settles stay short so the next field starts quickly after a successful fill.
  async function commitComboboxOption(match, controlEl) {
    const clickEl = resolveOptionClickTarget(match);
    if (!clickEl) return false;
    const desiredText = (match.textContent || "").trim();
    const comboEl = () =>
      (controlEl && controlEl.closest && controlEl.closest('[role="combobox"]')) || controlEl;
    try {
      if (clickEl.scrollIntoView) clickEl.scrollIntoView({ block: "nearest" });
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    simulateClick(clickEl);
    try {
      clickEl.click();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (comboboxValueCommitted(comboEl(), desiredText)) return true;
    // Synthetic option clicks often no-op on Greenhouse remix react-select — trusted pick on the
    // option row (not only when the control still reads expanded; the menu may close without
    // committing).
    if (await trustedClick(clickEl)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (comboboxValueCommitted(comboEl(), desiredText)) return true;
    if (controlEl && controlEl.closest && controlEl.closest(".select-shell")) {
      try {
        clickEl.focus && clickEl.focus();
        for (const type of ["keydown", "keyup"]) {
          clickEl.dispatchEvent(
            new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch {
        /* ignore */
      }
    }
    return comboboxValueCommitted(comboEl(), desiredText);
  }

  // SAP SuccessFactors RCM paginated picklists (`rcmpaginatedselectinput` inside
  // `.sfCascadingPicklist`) — confirmed live on career4.successfactors.com: every screening
  // question is a type-to-filter combobox backed by a hidden `tor__f*` input, not a native
  // <select>. Generic fillReactSelectByClick missed options (no react-select menu) and clicking
  // `fd-input-group--control` was the wrong open target.
  function isSuccessFactorsPicklist(element) {
    return Boolean(
      element &&
        element.classList &&
        (element.classList.contains("rcmpaginatedselectinput") ||
          (element.closest && element.closest(".sfCascadingPicklist, .paginatedPicklistContainer")))
    );
  }

  function successFactorsPicklistOpenTarget(element) {
    const container =
      (element.closest && element.closest(".paginatedPicklistContainer, .sfCascadingPicklist")) || element;
    const button = container.querySelector && container.querySelector(".rcmpaginatedselectbutton");
    return button || element;
  }

  function successFactorsHiddenInput(element) {
    const host = element.closest && element.closest("[id^='picklist_']");
    return host && host.querySelector('input[type="hidden"][id^="tor__"]');
  }

  function successFactorsPicklistAlreadySet(element, desiredText) {
    const title = (element.getAttribute && element.getAttribute("title")) || "";
    const placeholder = (element.getAttribute && element.getAttribute("placeholder")) || "";
    if (!title || /^no\s+selection$/i.test(title.trim()) || title === placeholder) return false;
    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(desiredText);
    const current = norm(title);
    if (!target || !current) return false;
    if (current === target || current.startsWith(target + ":") || current.includes(target)) {
      const hidden = successFactorsHiddenInput(element);
      return !hidden || Boolean(String(hidden.value || "").trim());
    }
    return false;
  }

  function findSuccessFactorsPicklistOptions(element, before) {
    const isVisibleLocal = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const usableText = (text) => {
      const t = (text || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 120) return false;
      if (/^no\s+selection$/i.test(t)) return false;
      if (/one or more results available/i.test(t)) return false;
      if (/press up or down arrow/i.test(t)) return false;
      return !isGenericSelectPlaceholder(t);
    };
    const usable = (el) => {
      if (!el || el === element) return false;
      if (el.tagName === "INPUT" || el.tagName === "BUTTON") return false;
      if (el.classList && el.classList.contains("rcmpaginatedselectinput")) return false;
      if (!isVisibleLocal(el)) return false;
      if (isDisabledComboboxOption(el)) return false;
      return usableText(el.textContent);
    };

    const owns = element.getAttribute && element.getAttribute("aria-owns");
    if (owns) {
      const list = document.getElementById(owns);
      if (list) {
        const opts = [...list.querySelectorAll('[role="option"], tr, li, div, span, a')].filter(
          (el) => usable(el) && (!before || !before.has(el))
        );
        if (opts.length) {
          return opts.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
        }
      }
    }

    const listOpts = [...document.querySelectorAll('[id$="_listSelect"] tr, [id$="_listSelect"] li, [id$="_listSelect"] [role="option"]')].filter(
      (el) => usable(el) && (!before || !before.has(el))
    );
    if (listOpts.length) return listOpts;

    return [];
  }

  // Greenhouse (and other react-select builds): each combobox input points at its own menu via
  // aria-controls (e.g. "react-select-candidate-location-listbox"). Without scoping to that
  // menu, findComboboxOptions can grab the intl-tel-input country list or another field's open
  // menu on the same page — confirmed live on job-boards.greenhouse.io/vonage: Location (City)
  // flashed open/closed with no pick because options were read from the wrong listbox.
  function reactSelectMenuForElement(element) {
    const controlsId = element && element.getAttribute && element.getAttribute("aria-controls");
    if (!controlsId) return null;
    const listbox = document.getElementById(controlsId);
    if (!listbox) return null;
    return listbox.closest('[class*="__menu"]') || listbox;
  }

  function menuBelongsToElement(menu, element) {
    if (!element || !menu) return true;
    const own = reactSelectMenuForElement(element);
    if (!own) return true;
    return menu === own || own.contains(menu) || menu.contains(own);
  }

  function isPhoneCountryListbox(listbox) {
    if (!listbox) return false;
    if (listbox.id && /^iti-/i.test(listbox.id)) return true;
    if (listbox.classList && listbox.classList.contains("iti__country-list")) return true;
    return Boolean(listbox.closest && listbox.closest(".iti, .iti--container"));
  }

  function reactSelectDisplayValue(element) {
    if (isSuccessFactorsPicklist(element)) {
      const title = (element.getAttribute && element.getAttribute("title")) || "";
      const placeholder = (element.getAttribute && element.getAttribute("placeholder")) || "";
      if (title && title !== placeholder && !/^no\s+selection$/i.test(title.trim())) {
        return title.trim();
      }
      return "";
    }
    const control = element && element.closest && element.closest('[class*="__control"]');
    if (!control) return "";
    const single = control.querySelector('[class*="__single-value"]');
    return single && cleanedText(single) ? cleanedText(single) : "";
  }

  function comboboxValueCommitted(element, desiredText) {
    if (isSuccessFactorsPicklist(element) && successFactorsPicklistAlreadySet(element, desiredText)) {
      return true;
    }
    if (isReactSelectAlreadySet(element, desiredText)) return true;
    const display = reactSelectDisplayValue(element);
    if (!display || isGenericSelectPlaceholder(display)) return false;
    if (!desiredText) return true;
    const target = (desiredText || "").toLowerCase().trim();
    const cur = display.toLowerCase();
    if (cur === target || cur.startsWith(target + ",") || cur.startsWith(target + " ")) return true;
    return cur.includes(target) || target.includes(cur);
  }

  // Greenhouse remix react-select keeps options + onChange on React fibers — readable without
  // opening menus (executeScript-injected funcs cannot rely on module-level helpers; must live
  // inside runAutofillInPage / fillGeneratedAnswersInPage).
  function greenhouseReactFiberKey(el) {
    return Object.keys(el || {}).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  }

  function findGreenhouseReactSelect(element) {
    const roots = [element];
    const shell = element.closest && element.closest(".select-shell");
    const control = element.closest && element.closest('[class*="__control"]');
    if (shell) roots.push(shell);
    if (control) roots.push(control);
    for (const root of roots) {
      const key = greenhouseReactFiberKey(root);
      if (!key) continue;
      let fiber = root[key];
      while (fiber) {
        const p = fiber.memoizedProps || fiber.pendingProps || {};
        if (typeof p.onChange === "function" && (Array.isArray(p.options) || p.classNamePrefix === "select")) {
          return { onChange: p.onChange, options: p.options || [] };
        }
        if (p.selectProps && typeof p.selectProps.onChange === "function") {
          return { onChange: p.selectProps.onChange, options: p.selectProps.options || [] };
        }
        fiber = fiber.return;
      }
    }
    return null;
  }

  function pickGreenhouseReactOption(rs, desiredText) {
    const want = String(desiredText || "").trim();
    const wantLow = want.toLowerCase();
    const opts = rs.options || [];
    return (
      opts.find((o) => String(o.label || "").trim().toLowerCase() === wantLow) ||
      opts.find((o) => String(o.value ?? "").toString().toLowerCase() === wantLow) ||
      opts.find((o) => {
        const lab = String(o.label || "").trim().toLowerCase();
        return lab && (lab.includes(wantLow) || wantLow.includes(lab));
      }) ||
      null
    );
  }

  function fillGreenhouseViaReactFiber(element, desiredText) {
    if (!element.closest || !element.closest(".select-shell")) return false;
    const rs = findGreenhouseReactSelect(element);
    if (!rs) return false;
    const picked = pickGreenhouseReactOption(rs, desiredText);
    if (!picked) return false;
    try {
      rs.onChange(picked, { action: "select-option", option: picked });
      return comboboxValueCommitted(element, desiredText);
    } catch {
      return false;
    }
  }

  function discoverGreenhouseOptionsFromFiber(element) {
    const rs = findGreenhouseReactSelect(element);
    if (!rs || !rs.options || !rs.options.length) return [];
    const seen = new Set();
    const out = [];
    for (const o of rs.options) {
      const t = String(o.label || o.value || "").trim();
      if (!t || isGenericSelectPlaceholder(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  function isReactSelectAlreadySet(element, desiredText) {
    if (isSuccessFactorsPicklist(element) && successFactorsPicklistAlreadySet(element, desiredText)) {
      return true;
    }
    const current = reactSelectDisplayValue(element);
    if (!current || isGenericSelectPlaceholder(current)) return false;
    // Greenhouse's phone dial-code picker (see isPhoneDialCodePicker) always commits as a bare
    // "+NN" display (flag + calling code) no matter whether it was picked by typing the code OR
    // the country name - comparing that against a country-name target ("poland") can never find
    // any textual overlap, so every genuinely successful pick on this widget kept reading back
    // as "not committed" here, forcing tryGreenhouseRemixSelect through all 4 fallback tiers
    // every single run even though tier 2's very first click already landed correctly. Confirmed
    // live via console logs showing a real click committed on poll #0 yet still reported failed.
    // Checking the SHAPE alone ("does this look like some +NN code") isn't enough by itself -
    // confirmed live, Greenhouse's own app can reset this field to a DIFFERENT but still
    // validly-shaped code (e.g. "+374" for Armenia) at some point during a run. Without the
    // stricter check, this would wrongly report "already correct" the moment ANYTHING later
    // calls fillReactSelectByClick on this element again (a re-fill attempt, or the final
    // reverify pass), short-circuiting before ever attempting to click the real target and
    // silently leaving the wrong value in place. Any GENUINELY correct calling code must be a
    // literal PREFIX of the profile's own full phone number, so checking that directly verifies
    // the actual value, not just its shape.
    if (isPhoneDialCodePicker(element)) {
      const digits = String((profile && profile.contact && profile.contact.phone) || "").replace(/[^\d+]/g, "");
      const code = current.trim();
      if (/^\+\d{1,4}$/.test(code)) return digits.startsWith(code);
    }
    const target = (desiredText || "").toLowerCase().trim();
    const cur = current.toLowerCase();
    if (!target) return false;
    if (cur === target || cur.startsWith(target + ",") || cur.startsWith(target + " ")) return true;
    if (cur.includes(target) || target.includes(cur)) return true;
    const countryHint = ((profile && profile.contact && profile.contact.country) || "").toLowerCase().trim();
    if (countryHint && cur.includes(target) && cur.includes(countryHint)) return true;
    return false;
  }

  function comboboxOpenTarget(element) {
    if (isSuccessFactorsPicklist(element)) return successFactorsPicklistOpenTarget(element);
    const control = element.closest && element.closest('[class*="__control"]');
    if (control && element.closest(".select-shell, .select__container")) {
      const toggle = control.querySelector(
        'button[aria-label*="Toggle" i], button[aria-label*="flyout" i], .select__indicators button'
      );
      if (toggle) return toggle;
    }
    return control || element;
  }

  function findComboboxOptions(prefix, before, element = null) {
    const isVisibleLocal = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isFreshAndVisible = (el) => !before.has(el) && isVisibleLocal(el) && !isDisabledComboboxOption(el);

    if (element && isSuccessFactorsPicklist(element)) {
      const sfOpts = findSuccessFactorsPicklistOptions(element, before);
      if (sfOpts.length) return sfOpts;
    }

    const ownMenu = element && reactSelectMenuForElement(element);
    if (ownMenu) {
      const scoped = [...ownMenu.querySelectorAll('[class*="__option"], [role="option"]')].filter(isFreshAndVisible);
      if (scoped.length) return scoped;
      // Async react-select menus (Greenhouse Location/City): listbox exists but options load
      // after typing — keep polling instead of falling through to another field's listbox.
      if (element.getAttribute("aria-expanded") === "true") return [];
    }

    // Prefer SmartRecruiters autocomplete rows before generic leaf heuristics.
    const srRaw = querySelectorAllDeep(
      "spl-select-option, spl-dropdown-item, .c-spl-dropdown-item, .c-spl-autocomplete-default-option"
    ).filter(isFreshAndVisible);
    if (srRaw.length) {
      const hosts = [];
      const seen = new Set();
      for (const o of srRaw) {
        const clickable = resolveOptionClickTarget(o);
        if (seen.has(clickable) || isDisabledComboboxOption(clickable)) continue;
        if (!isVisibleLocal(clickable) && !isVisibleLocal(o)) continue;
        seen.add(clickable);
        hosts.push(clickable);
      }
      if (hosts.length) return hosts;
    }

    if (prefix) {
      for (const menu of querySelectorAllDeep(`[class*="${prefix}__menu"]`)) {
        if (!menuBelongsToElement(menu, element)) continue;
        const opts = [...menu.querySelectorAll(`[class*="${prefix}__option"]`)].filter(isFreshAndVisible);
        if (opts.length) return opts;
      }
    }
    // Some ARIA comboboxes use the "tree" popup pattern (`aria-haspopup="tree"`, a legitimate
    // APG variant) instead of the more common "listbox" one — options are `role="treeitem"`
    // inside a `role="tree"` container, not `role="option"` inside `role="listbox"`. Confirmed
    // live on an Angular CDK-based ATS "Country" field built exactly this way. `role="menu"`/
    // `role="menuitem"` covers a Homerun-style ATS "select all that apply" dropdown that
    // repurposes the ARIA menu pattern for a pick-list instead of navigation.
    for (const listbox of querySelectorAllDeep('[role="listbox"], [role="tree"], [role="menu"]')) {
      if (isPhoneCountryListbox(listbox)) continue;
      const opts = [...listbox.querySelectorAll('[role="option"], [role="treeitem"], [role="menuitem"]')].filter(isFreshAndVisible);
      if (opts.length) return opts;
    }
    // Comeet / Bootstrap `dropdown-menu`: options are `<li><a><div class="option-title">…`.
    // No ARIA listbox roles. Prefer the clickable `<a>` (ng-click sets the answer).
    const bootstrapItems = [];
    for (const menu of document.querySelectorAll(".dropdown-menu, [uib-dropdown-menu], ul.dropdown-menu")) {
      for (const a of menu.querySelectorAll("li a, a.notBranded")) {
        if (!isFreshAndVisible(a) || isDisabledComboboxOption(a)) continue;
        const text = (a.textContent || "").trim();
        if (!text || text.length > 80) continue;
        bootstrapItems.push(a);
      }
    }
    if (bootstrapItems.length) return bootstrapItems;
    const anyOptionRole = querySelectorAllDeep('[role="option"], [role="treeitem"], [role="menuitem"]').filter(isFreshAndVisible);
    if (anyOptionRole.length) return anyOptionRole;
    return querySelectorAllDeep("li, div, span, button").filter((el) => {
      if (before.has(el)) return false; // only elements that appeared after the click
      if (el.closest && el.closest(".iti, .iti--container")) return false;
      if (el.children.length > 2) return false; // leaf-ish only, not a whole container
      const text = (el.textContent || "").trim();
      if (!text || text.length > 80) return false; // an option is short text, not a paragraph
      return isVisibleLocal(el) && !isDisabledComboboxOption(el);
    });
  }

  // Long option lists (a full country picker, especially) are often virtualized — only the
  // items currently scrolled into view actually exist in the DOM at all, so a target far down
  // an alphabetical list (e.g. "Poland") is genuinely absent right after opening, no matter how
  // thorough the option search is. Confirmed live: an Angular CDK-based ATS renders its
  // "Country" options inside a `cdk-virtual-scroll-viewport` and only ~20 (Afghanistan..Austria)
  // exist in the DOM at the initial scroll position. That same panel renders its own fresh
  // "Search" input once opened (distinct from the field's closed-state control, which never
  // appears in `before`) — typing into it, the same narrowing a real user would do, is what
  // actually renders the matching option into the DOM. react-select's own control input isn't
  // "fresh" (it existed before the click) and gets excluded via `excludeEl`, so this is a no-op
  // for comboboxes that don't have a separate filter box.
  function findFreshFilterInput(before, excludeEl) {
    const candidates = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')];
    return (
      candidates.find((el) => {
        if (el === excludeEl || before.has(el)) return false;
        // A react-select build can render its own hidden native-validation proxy input right
        // alongside the real one - confirmed live on Greenhouse's "remix" flavor:
        // `<input required="" tabindex="-1" aria-hidden="true" class="...requiredInput"
        // value="">`, no `type` attribute at all, so it matches this same candidate selector.
        // Without excluding it, this proxy can get mistaken for the field's own fresh filter
        // box - the desired text gets typed into an invisible, non-functional decoy instead of
        // the field the user actually sees, leaving the REAL input (and the option search that
        // depends on it) never actually triggered, silently, with no error and no visible typed
        // text anywhere on the page. `rect.width <= 1 || rect.height <= 1` (not just `> 0`)
        // catches the same near-zero-but-technically-nonzero decoy sizing already handled
        // elsewhere (field-detector.js's isVisible has the identical guard, for the same reason).
        if (el.getAttribute("aria-hidden") === "true" || (el.closest && el.closest('[aria-hidden="true"]'))) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      }) || null
    );
  }

  async function fillReactSelectByClick(element, desiredText) {
    // Diagnostic only (temporary, not a fix): the previous fix (closing this widget down after
    // its own commit) did NOT stop the phone/country picker from being changed by a LATER field's
    // own retry - meaning either (a) some GLOBAL keyboard-routing mechanism is still delivering a
    // later field's own ArrowDown presses to this widget despite it being closed, or (b) the
    // LATER field's own fillReactSelectByClick call is somehow being handed THIS widget's element
    // directly (a stale/colliding data-af-idx stamp resolving to the wrong DOM node, same shape
    // as the earlier findElementByLabel bug) rather than its own intended element. Logging the
    // actual element identity (id + whether it's inside .phone-input__country) every call tells
    // these two apart directly instead of guessing again.
    if (element && element.closest && element.closest(".phone-input__country")) {
      console.warn(
        `[Auto Fill][phone-watch] fillReactSelectByClick called on the COUNTRY PICKER itself with desiredText="${desiredText}" (element id="${element.id || ""}")`
      );
    }
    if (isSuccessFactorsPicklist(element) && successFactorsPicklistAlreadySet(element, desiredText)) {
      return true;
    }
    if (isReactSelectAlreadySet(element, desiredText)) return true;
    if (element.closest && element.closest(".select-shell") && fillGreenhouseViaReactFiber(element, desiredText)) {
      return true;
    }
    const sfPick = isSuccessFactorsPicklist(element);
    const controlEl = comboboxOpenTarget(element);
    const prefixMatch = !sfPick && controlEl && controlEl.className.match(/(\S+)__control\b/);
    const prefix = prefixMatch ? prefixMatch[1] : null;
    function findGreenhouseMenuOptions(el) {
      if (!el || !el.closest) return [];
      const isVisibleLocal = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const collect = (root) => {
        if (!root) return [];
        return [...root.querySelectorAll(
          '.select__option, [class*="__option"], [role="option"], [id*="-option-"]'
        )].filter((node) => isVisibleLocal(node) && !isDisabledComboboxOption(node));
      };
      const shell = el.closest(".select-shell");
      if (shell) {
        const inShell = collect(shell);
        if (inShell.length) return inShell;
      }
      const ownMenu = reactSelectMenuForElement(el);
      if (ownMenu) {
        const scoped = collect(ownMenu);
        if (scoped.length) return scoped;
      }
      const controlsId = el.getAttribute && el.getAttribute("aria-controls");
      if (controlsId) {
        const listbox = document.getElementById(controlsId);
        if (listbox) {
          const scoped = collect(listbox);
          if (scoped.length) return scoped;
        }
      }
      // Live Greenhouse remix react-select portals menus to document.body — offline HTML
      // fixtures inject menus inside .select-shell, so jsdom tests miss this gap.
      if (el.getAttribute && el.getAttribute("aria-expanded") === "true") {
        const comboId = el.id || "";
        if (comboId) {
          try {
            const idOpts = [...document.querySelectorAll(`[id^="react-select-${CSS.escape(comboId)}-option-"]`)].filter(
              (node) => isVisibleLocal(node) && !isDisabledComboboxOption(node)
            );
            if (idOpts.length) return idOpts;
          } catch {
            /* ignore */
          }
        }
        const portaled = [];
        for (const menu of document.querySelectorAll(
          '[class*="__menu"], [class*="-menu"], [class*="menu-list"], .select__menu'
        )) {
          const rect = menu.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          portaled.push(...collect(menu));
        }
        if (portaled.length) return portaled;
        const live = [...document.querySelectorAll(
          '.select__option, [class*="__option"], [role="option"], [id*="-option-"]'
        )].filter((node) => isVisibleLocal(node) && !isDisabledComboboxOption(node));
        if (live.length) return live;
      }
      return [];
    }
    function comboboxExpanded(el, control) {
      const combo = el && el.getAttribute && el.getAttribute("role") === "combobox" ? el : null;
      const fromCombo = combo && combo.getAttribute("aria-expanded") === "true";
      const fromControl = control && control.getAttribute && control.getAttribute("aria-expanded") === "true";
      return Boolean(fromCombo || fromControl);
    }
    async function tryGreenhouseRemixSelect(element, desiredText, control, isUnusableOptionText) {
      // Diagnostic-only step/attempt logging - explicitly requested, to see WHY this takes
      // several fallback tiers instead of committing on the first one. Tagged per call with the
      // desired text so parallel/sequential attempts (e.g. dial-code retry then country-name
      // retry) can be told apart in the console.
      const tag = `[Auto Fill][combobox-retry "${desiredText}"]`;
      if (!element.closest || !element.closest(".select-shell")) return false;
      const fiberOk = fillGreenhouseViaReactFiber(element, desiredText);
      console.info(`${tag} tier 1 (React fiber direct) -> ${fiberOk ? "COMMITTED" : "no match/failed"}`);
      if (fiberOk) return true;
      const norm = (s) => (s || "").toLowerCase().trim();
      const target = norm(desiredText);
      if (!target) return false;
      const greenhouseToggle = () => {
        const shell = element.closest(".select-shell");
        return (
          (shell &&
            shell.querySelector('button[aria-label*="Toggle" i], button[aria-label*="flyout" i]')) ||
          control ||
          element
        );
      };
      const dispatchKey = (key) => {
        const init = { key, code: key, bubbles: true, cancelable: true };
        element.dispatchEvent(new KeyboardEvent("keydown", init));
        element.dispatchEvent(new KeyboardEvent("keyup", init));
      };
      const liveOptions = () =>
        findGreenhouseMenuOptions(element).filter((o) => !isUnusableOptionText(o.textContent));
      const matchOption = (options) => {
        if (!options.length) return null;
        return (
          options.find((o) => norm(o.textContent) === target) ||
          options.find((o) => norm(o.textContent).startsWith(target + ",") || norm(o.textContent).startsWith(target + " ")) ||
          options.find((o) => norm(o.textContent).startsWith(target)) ||
          options.find((o) => norm(o.textContent).includes(target) || target.includes(norm(o.textContent))) ||
          (/^(yes|no)$/i.test(target) && options.find((o) => norm(o.textContent) === target)) ||
          (/^(yes|agree|accept|i agree)$/i.test(target) &&
            options.find(
              (o) => /agree|accept|consent/i.test(norm(o.textContent)) && !/do not|don't|decline|not agree/i.test(norm(o.textContent))
            )) ||
          null
        );
      };
      const ensureOpen = async () => {
        if (comboboxExpanded(element, control)) return true;
        const toggle = greenhouseToggle();
        element.focus();
        // Live GH remix react-select ignores synthetic opens — trusted-click the flyout toggle first.
        if (await trustedClick(toggle)) {
          await new Promise((resolve) => setTimeout(resolve, 280));
          if (comboboxExpanded(element, control)) return true;
        }
        simulateClick(toggle);
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (comboboxExpanded(element, control)) return true;
        dispatchKey("ArrowDown");
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (comboboxExpanded(element, control)) return true;
        if (!comboboxExpanded(element, control) && (await trustedClick(toggle))) {
          await new Promise((resolve) => setTimeout(resolve, 220));
        }
        return comboboxExpanded(element, control);
      };
      const opened = await ensureOpen();
      console.info(`${tag} tier 2 open (click/keyboard toggle) -> ${opened ? "opened" : "FAILED to open"}`);
      if (!opened) return false;
      let pollMatchedAt = null;
      for (let poll = 0; poll < 10; poll++) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        const match = matchOption(liveOptions());
        if (!match) continue;
        pollMatchedAt = poll;
        if (await commitComboboxOption(match, control || element)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (comboboxValueCommitted(element, desiredText)) {
            console.info(`${tag} tier 2 click-poll -> COMMITTED (found match on poll #${poll})`);
            return true;
          }
        }
      }
      console.info(
        `${tag} tier 2 click-poll -> no committed match after 10 polls (~0.6s)${pollMatchedAt !== null ? ` (matched text on poll #${pollMatchedAt} but commit/verify failed)` : ""}`
      );
      element.focus();
      await ensureOpen();
      const seen = new Set();
      let keyboardSteps = 0;
      for (let step = 0; step < 8; step++) {
        keyboardSteps = step + 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const activeId = element.getAttribute("aria-activedescendant");
        const activeNode = activeId && element.ownerDocument.getElementById(activeId);
        const text = activeNode ? norm(activeNode.textContent) : "";
        if (text) {
          if (seen.has(text) && step > seen.size + 2) break;
          seen.add(text);
          if (text === target || text.includes(target) || target.includes(text)) {
            dispatchKey("Enter");
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (comboboxValueCommitted(element, desiredText)) {
              console.info(`${tag} tier 3 keyboard-nav -> COMMITTED (matched "${text}" after ${keyboardSteps} ArrowDown step(s))`);
              return true;
            }
          }
        }
        if (!comboboxExpanded(element, control)) break;
        // Diagnostic only (temporary, not a fix): dispatchKey fires KeyboardEvents directly ON
        // `element` via dispatchEvent(), but that's not the same thing as REAL browser focus -
        // if Greenhouse's own app routes keyboard nav based on document.activeElement (a common
        // pattern for widget libraries that add their own document-level listener rather than
        // relying purely on React's per-component event target routing) rather than the event's
        // dispatch target, these ArrowDown presses could land on WHATEVER actually holds real
        // focus regardless of which element we dispatched them on - a live candidate for how the
        // phone/country picker keeps changing during a completely different field's own retry,
        // given #94 already ruled out fillReactSelectByClick being called on the wrong element
        // directly. Logging only on mismatch to avoid noise when focus is exactly where expected.
        if (document.activeElement !== element) {
          const ae = document.activeElement;
          console.warn(
            `${tag} tier 3 step ${keyboardSteps}: document.activeElement is NOT this element before ArrowDown (actual: ${ae ? `${ae.tagName}#${ae.id || ""}.${ae.className || ""}` : "null"})`
          );
        }
        dispatchKey("ArrowDown");
      }
      console.info(
        `${tag} tier 3 keyboard-nav -> no committed match after ${keyboardSteps} step(s), saw: [${[...seen].join(", ")}]`
      );
      // Type-to-filter + pick (confirmed live GH remix: sponsorship Yes/No, experience levels).
      element.focus();
      await ensureOpen();
      nativeSet(element, String(desiredText).trim());
      await new Promise((resolve) => setTimeout(resolve, 400));
      const typedMatch = matchOption(liveOptions());
      if (typedMatch && (await commitComboboxOption(typedMatch, control || element))) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (comboboxValueCommitted(element, desiredText)) {
          console.info(`${tag} tier 4 type-to-filter -> COMMITTED (typed "${desiredText}", matched "${typedMatch.textContent.trim()}")`);
          return true;
        }
      }
      // No real option anywhere in THIS field's own list ever matched desiredText - blindly
      // pressing Enter anyway (the previous behavior) left the widget holding non-matching
      // typed text, with nothing committed, still open/focused in some undefined state.
      // Confirmed live: this is exactly what let a LATER, unrelated field's own keyboard/focus
      // activity leak into and corrupt a DIFFERENT widget's already-correct value afterward
      // (reported live as the phone/country picker silently changing minutes after a completely
      // unrelated question's own combobox retried and failed the exact same way - e.g. a
      // "60000 EUR" answer mistakenly aimed at a Yes/No field). Closing cleanly here - Escape,
      // clear the typed text, blur - instead of leaving things ambiguous removes that whole
      // class of risk, regardless of WHY the mismatch happened in the first place. Not
      // preventing the mismatched answer itself (a genuinely wrong answer should still leave
      // this ONE field for the user, not silently corrupt some OTHER, unrelated field too).
      const escapeInit = { key: "Escape", code: "Escape", bubbles: true, cancelable: true };
      element.dispatchEvent(new KeyboardEvent("keydown", escapeInit));
      element.dispatchEvent(new KeyboardEvent("keyup", escapeInit));
      nativeSet(element, "");
      element.blur();
      await new Promise((resolve) => setTimeout(resolve, 100));
      console.info(`${tag} tier 4 type-to-filter -> FAILED - no matching option anywhere, closed cleanly instead of leaving it ambiguous`);
      return false;
    }
    // "Fresh" means "was not VISIBLE before this click", not "was not PRESENT in the DOM before
    // this click" - those aren't the same thing, and conflating them was confirmed live to break
    // a Homerun-style ATS "select all that apply" dropdown: its option buttons are already
    // sitting in the DOM at page load, just CSS-hidden (a plain `hidden` class hiding the whole
    // menu, no lazy mount-on-open at all), so a presence-based snapshot already contains them
    // before the click - every one then reads as "not fresh" and gets excluded by
    // findComboboxOptions, leaving zero options found even though the menu genuinely opened.
    // Snapshotting visibility instead of mere presence still correctly excludes anything that
    // really was already open/visible (the original problem this snapshot was built to solve -
    // an earlier field's stale, already-open menu), while no longer wrongly excluding options
    // that were present-but-invisible and only just became visible. Pierces open shadow roots
    // so SmartRecruiters suggestion rows aren't treated as "always fresh" noise either.
    const before = collectVisibleDeep(document);
    // Classify before open so each step can use a different budget:
    //   location  → long after-type wait (debounce/geocode)
    //   country   → medium open + after-open settle (phone dial / nationality lists)
    //   other     → short open/type; click as soon as options are stable
    const labelIds = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const labelFromIds = labelIds
      .map((id) => {
        const node = document.getElementById(id);
        return node ? (node.textContent || "").replace(/\s+/g, " ").trim() : "";
      })
      .filter(Boolean)
      .join(" ");
    const fieldHint = [
      labelFromIds,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("name"),
      element.id,
      controlEl && controlEl.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ");
    const isLocationAutocomplete = Boolean(
      (element.closest &&
        element.closest(
          'spl-autocomplete, oc-location-autocomplete, oc-location-autocomplete-wrapper, [data-test="location-autocomplete"]'
        )) ||
        /location|city|where (are|do) you|place of residence|current (city|location)/i.test(fieldHint)
    );
    const isCountryOrPhonePicker = Boolean(
      (element.closest && element.closest(".iti, crux-phone-component, [class*='phone-input'], [class*='PhoneInput']")) ||
        /^(country|nationality)\b|\b(dial|calling|phone)\s*code\b|\bcountry\s*code\b/i.test(fieldHint)
    );
    const isGreenhouseSelect = Boolean(element.closest && element.closest(".select-shell"));
    // Original working ~0.5s profile for combobox pacing.
    const hasAriaListbox = Boolean(element.getAttribute && element.getAttribute("aria-controls"));
    const pace = sfPick
      ? { open: 200, preType: 100, typeHead: 400, poll: 120, stable: 3, maxPolls: 50, trustedRetry: 25 }
      : isLocationAutocomplete
      ? {
          open: 120,
          preType: 80,
          typeHead: hasAriaListbox ? 600 : 450,
          poll: hasAriaListbox ? 150 : 120,
          stable: 3,
          maxPolls: hasAriaListbox ? 60 : 50,
          trustedRetry: hasAriaListbox ? 30 : 25,
        }
      : isCountryOrPhonePicker
        ? { open: 150, preType: 80, typeHead: 280, poll: 100, stable: 2, maxPolls: 40, trustedRetry: 15 }
        : isGreenhouseSelect && !hasAriaListbox
          ? { open: 200, preType: 100, typeHead: 350, poll: 120, stable: 2, maxPolls: 55, trustedRetry: 30 }
        : hasAriaListbox
          ? { open: 120, preType: 80, typeHead: 300, poll: 100, stable: 2, maxPolls: 45, trustedRetry: 20 }
          : { open: 120, preType: 80, typeHead: 200, poll: 80, stable: 2, maxPolls: 40, trustedRetry: 15 };

    const isUnusableOptionText = (text) => {
      const t = (text || "").trim();
      if (!t) return true;
      return /^(loading(\.{0,3}|…)?|searching(\.{0,3}|…)?|no options?( found)?|no matches?( found)?|type to search|start typing)/i.test(t);
    };

    const isGreenhouseSearchable =
      isLocationAutocomplete ||
      isCountryOrPhonePicker ||
      /current country|country of residence|current residence|\bresidence\b|\bstate\b|location\s*\(city\)/i.test(fieldHint);
    if (isGreenhouseSelect) {
      if (await tryGreenhouseRemixSelect(element, desiredText, controlEl, isUnusableOptionText)) {
        return true;
      }
      if (!isGreenhouseSearchable) {
        element.blur();
        return false;
      }
    }

    simulateClick(controlEl || element);
    element.focus();
    // Open → wait (short for static lists; a bit longer for country/location menus).
    await new Promise((resolve) => setTimeout(resolve, pace.open));
    if (
      isGreenhouseSelect &&
      !findComboboxOptions(prefix, before, element).length &&
      !findGreenhouseMenuOptions(element).length
    ) {
      // Only trusted-open when still closed — a second click on an already-open GH control
      // toggles the menu shut (confirmed live: GPT second pass looked like open/close with no pick).
      if (!comboboxExpanded(element, controlEl)) {
        await trustedClick(controlEl || element);
      }
      await new Promise((resolve) => setTimeout(resolve, pace.poll * 3));
    }

    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(desiredText);
    const textOf = (o) => norm((o.textContent || "").trim());
    const isGreenhouseStatic =
      isGreenhouseSelect && !isLocationAutocomplete && !isCountryOrPhonePicker && !hasAriaListbox;
    const readOpenOptions = () => {
      const fromFresh = findComboboxOptions(prefix, before, element).filter(
        (o) => !isUnusableOptionText(o.textContent)
      );
      if (fromFresh.length) return fromFresh;
      return findGreenhouseMenuOptions(element).filter((o) => !isUnusableOptionText(o.textContent));
    };
    const matchOpenOption = (options) => {
      if (!options.length) return null;
      return (
        options.find((o) => textOf(o) === target) ||
        options.find((o) => textOf(o).startsWith(target + ",") || textOf(o).startsWith(target + " ")) ||
        options.find((o) => textOf(o).startsWith(target)) ||
        options.find((o) => textOf(o).includes(target) || target.includes(textOf(o))) ||
        (/^(yes|agree|accept|i agree)$/i.test(target) &&
          options.find((o) => /agree|accept|consent/i.test(textOf(o)) && !/do not|don't|decline|not agree/i.test(textOf(o)))) ||
        null
      );
    };
    const tryDirectOptionPick = async (maxAttempts) => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, pace.poll));
        const match = matchOpenOption(readOpenOptions());
        if (!match) continue;
        if (await commitComboboxOption(match, controlEl || element)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return comboboxValueCommitted(element, desiredText);
        }
      }
      return false;
    };
    // Static Greenhouse remix react-select (EEO Yes/No, privacy "I agree", etc.): click the
    // option directly — typing into the filter opens then reverts with no pick on the GPT path.
    if (/^(yes|no)$/i.test(String(desiredText).trim()) || isGreenhouseStatic) {
      if (await tryDirectOptionPick(isGreenhouseStatic ? pace.maxPolls : 15)) return true;
      if (isGreenhouseStatic) {
        element.blur();
        return false;
      }
    }

    // A "select all that apply" combobox (aria-multiselectable="true" - confirmed live on a
    // Homerun-style ATS dropdown-trigger widget backing a real, hidden checkbox group) needs
    // EVERY matching option clicked, not just the first. Its options are a fixed, already-
    // rendered list rather than a filtered autocomplete, so typing the whole joined answer into
    // a filter box (the single-select path below) would be meaningless - there usually isn't one
    // - so this skips straight to finding and clicking each match in turn instead. Options are
    // re-queried fresh on every iteration rather than reusing one snapshot, since some widgets
    // re-render an option after picking it (e.g. to add a checkmark), which would make a stale
    // element reference from an earlier query go silently inert on the next click.
    if (element.getAttribute("aria-multiselectable") === "true") {
      const targets = String(desiredText)
        .split(/[,;]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!targets.length) {
        element.blur();
        return false;
      }
      let options = [];
      // Same widened budget as the single-select path below (10 -> 30 attempts) for
      // consistency - a fixed "select all that apply" list usually renders fast, but there's no
      // strong reason to give it a shorter window than everything else, and polling still stops
      // the moment options actually appear either way.
      for (let attempt = 0; attempt < 30 && !options.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        options = findComboboxOptions(null, before, element);
      }
      if (!options.length) {
        element.blur();
        return false;
      }
      let allMatched = true;
      for (const target of targets) {
        const current = findComboboxOptions(null, before, element);
        let match = current.find((o) => (o.textContent || "").toLowerCase().trim() === target);
        if (!match) {
          match = current.find(
            (o) => (o.textContent || "").toLowerCase().trim().includes(target) || target.includes((o.textContent || "").toLowerCase().trim())
          );
        }
        if (!match) {
          allMatched = false;
          continue;
        }
        await commitComboboxOption(match, controlEl || element);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      element.blur();
      return allMatched;
    }

    // Open settle → type (preType is tiny; the long wait is after typing for location only).
    await new Promise((resolve) => setTimeout(resolve, pace.preType));
    const filterInput = findFreshFilterInput(before, element);
    const typedInto = filterInput || (element.tagName === "INPUT" || element.tagName === "TEXTAREA" ? element : null);
    // No separate filter box appeared — some comboboxes are a type-to-search autocomplete
    // where the same visible control you clicked IS the search box (e.g. Ashby's "Location"
    // field, a Google-Places-style widget: nothing renders until you type). Only reached when
    // findFreshFilterInput found nothing, so this never double-types alongside a real
    // separate filter input.
    if (typedInto) nativeSet(typedInto, desiredText);

    // A rejected match (no options, or nothing close enough) used to leave the typed search
    // text sitting in the box with the menu stuck open on "No options" — confirmed live, this
    // left a required react-select combobox looking filled but with no real selection made,
    // failing native form validation on submit even though the caller correctly treated the
    // field as "not filled" and moved on to ask a human or try something else.
    const revertTypedFilter = () => {
      if (typedInto) nativeSet(typedInto, "");
      element.blur();
    };

    // Type → wait: location needs debounce/geocode head-start; country medium; others short.
    const typeHeadStartMs = typedInto ? pace.typeHead : Math.min(40, pace.typeHead);
    const pollMs = pace.poll;
    const stableNeeded = pace.stable;
    const readUsableOptions = () => {
      const fromFresh = findComboboxOptions(prefix, before, element).filter(
        (o) => !isUnusableOptionText(o.textContent)
      );
      if (fromFresh.length) return fromFresh;
      if (isGreenhouseSelect) {
        return findGreenhouseMenuOptions(element).filter((o) => !isUnusableOptionText(o.textContent));
      }
      return fromFresh;
    };
    const menuStillLoading = () => {
      const el = document.querySelector(
        '[class*="__loadingIndicator"], [class*="__loading-indicator"], [class*="loading-indicator"]'
      );
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const waitForStableOptions = async (maxAttempts) => {
      if (typeHeadStartMs) {
        await new Promise((resolve) => setTimeout(resolve, typeHeadStartMs));
      }
      let options = [];
      let lastSig = "";
      let stableReads = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (menuStillLoading()) {
          lastSig = "";
          stableReads = 0;
          options = [];
          continue;
        }
        const found = readUsableOptions();
        if (!found.length) {
          lastSig = "";
          stableReads = 0;
          options = [];
          continue;
        }
        const sig = found.map((o) => (o.textContent || "").trim()).join("\0");
        if (sig === lastSig) {
          stableReads += 1;
          options = found;
          if (stableReads >= stableNeeded) return options;
        } else {
          lastSig = sig;
          stableReads = 1;
          options = found;
        }
      }
      return options;
    };

    let options = await waitForStableOptions(pace.maxPolls);
    // No options ever appeared - the menu itself may never have opened at all. Confirmed live
    // on BambooHR's Country field: simulateClick's own synthetic events never open it (the
    // widget's own JS appears to check event.isTrusted, which no script can ever satisfy), even
    // though a real manual click does. Only reached when the normal, invisible path already
    // failed - trustedClick's visible debugging banner is the cost of this fallback, not the
    // default behavior.
    if (!options.length) {
      if (!comboboxExpanded(element, controlEl) && (await trustedClick(controlEl || element))) {
        if (typedInto) nativeSet(typedInto, desiredText);
        options = await waitForStableOptions(pace.trustedRetry);
      } else if (comboboxExpanded(element, controlEl)) {
        options = await waitForStableOptions(Math.min(20, pace.trustedRetry));
      }
    }
    if (!options.length) {
      revertTypedFilter();
      return false;
    }

    const countryHint = norm((profile && profile.contact && profile.contact.country) || "");
    // Prefer exact, then "Warsaw, …" / "Warsaw …", then includes — and when several cities
    // share a name, bias toward the profile country (e.g. Warsaw, Poland vs Warsaw, IL).
    let match = options.find((o) => textOf(o) === target);
    if (!match) {
      const starts = options.filter((o) => {
        const t = textOf(o);
        return t.startsWith(target + ",") || t.startsWith(target + " ");
      });
      if (starts.length && countryHint) {
        match = starts.find((o) => textOf(o).includes(countryHint)) || null;
      }
      if (!match && starts.length) match = starts[0];
    }
    if (!match) {
      const includes = options.filter((o) => textOf(o).includes(target) || target.includes(textOf(o)));
      if (includes.length && countryHint) {
        match = includes.find((o) => textOf(o).includes(countryHint)) || null;
      }
      if (!match && includes.length) match = includes[0];
    }
    if (!match && /^(yes|agree|accept|i agree)$/i.test(target)) {
      match = options.find((o) => {
        const t = textOf(o);
        return /agree|accept|consent/i.test(t) && !/do not|don't|decline|not agree/i.test(t);
      });
    }
    // SmartRecruiters (and similar) city autocomplete: after typing, the right UX is to pick
    // the first suggestion when nothing matched more specifically — confirmed live on
    // jobs.smartrecruiters.com oneclick-ui: options appeared but no click was committed.
    if (
      !match &&
      options.length &&
      element.closest &&
      element.closest(
        'spl-autocomplete, oc-location-autocomplete, oc-location-autocomplete-wrapper, [data-test="location-autocomplete"]'
      )
    ) {
      match = options[0];
    }
    if (!match) {
      revertTypedFilter();
      return false;
    }
    await commitComboboxOption(match, controlEl || element);
    return comboboxValueCommitted(element, desiredText);
  }

  // discoverComboboxOptions opens the widget the same way fillReactSelectByClick does, reads
  // whatever options render, then closes it back down WITHOUT selecting anything (discovery-only;
  // the real pick happens through fillReactSelectByClick afterward). Best-effort throughout.
  async function discoverComboboxOptions(element) {
    if (element.closest && element.closest(".select-shell")) {
      const fiberOpts = discoverGreenhouseOptionsFromFiber(element);
      if (fiberOpts.length) return fiberOpts;
    }
    const before = collectVisibleDeep(document);
    const sfPick = isSuccessFactorsPicklist(element);
    const controlEl = comboboxOpenTarget(element);
    const prefixMatch = !sfPick && controlEl && controlEl.className.match(/(\S+)__control\b/);
    const prefix = prefixMatch ? prefixMatch[1] : null;
    const asyncList = Boolean(element.getAttribute && element.getAttribute("aria-controls"));
    const isGH = Boolean(element.closest && element.closest(".select-shell"));
    try {
      // A single trustedClick + simulateClick attempt, with no retry if the flyout genuinely
      // never opened, turned out far less reliable than tryGreenhouseRemixSelect's own
      // multi-step ensureOpen() elsewhere in this file - confirmed live: 4 of 5 required
      // combobox fields on the very same page came back with 0 options discovered here,
      // including one ("Are you comfortable with the salary range?") whose real Yes/No options
      // were separately confirmed to exist and be reachable via ensureOpen's own retry chain in
      // the exact same run. Mirrors that same open-retry sequence here instead of a single shot,
      // so option discovery is exactly as reliable as the fill itself already is.
      const isOpen = () =>
        (element.getAttribute && element.getAttribute("aria-expanded") === "true") ||
        (controlEl && controlEl.getAttribute && controlEl.getAttribute("aria-expanded") === "true");
      if (isGH) {
        await trustedClick(controlEl || element);
        await new Promise((resolve) => setTimeout(resolve, 180));
        if (!isOpen()) {
          simulateClick(controlEl || element);
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (!isOpen()) {
          const init = { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true };
          element.dispatchEvent(new KeyboardEvent("keydown", init));
          element.dispatchEvent(new KeyboardEvent("keyup", init));
          await new Promise((resolve) => setTimeout(resolve, 90));
        }
        if (!isOpen()) {
          await trustedClick(controlEl || element);
          await new Promise((resolve) => setTimeout(resolve, 160));
        }
      } else {
        simulateClick(controlEl || element);
        await new Promise((resolve) => setTimeout(resolve, sfPick ? 200 : asyncList ? 150 : 100));
      }
      let options = [];
      const maxAttempts = sfPick ? 25 : asyncList ? 20 : 15;
      for (let attempt = 0; attempt < maxAttempts && !options.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, sfPick ? 100 : asyncList ? 120 : 80));
        options = findComboboxOptions(prefix, before, element);
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      const seen = new Set();
      const labels = [];
      for (const o of options) {
        const text = (o.textContent || "").trim();
        if (!text || text.length > 80 || isGenericSelectPlaceholder(text) || seen.has(text)) continue;
        seen.add(text);
        labels.push(text);
      }
      return labels;
    } finally {
      // Escape closes Evergreen/Workable application *dialogs* — never send Escape inside one.
      // Do NOT re-click the control to "close" the menu: that toggles and causes an open/close
      // loop when the menu was already closed or the pick never stuck.
      const inDialog =
        element.closest && element.closest('[role="dialog"], [data-evergreen-dialog], [aria-modal="true"]');
      if (!inDialog) {
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      }
      try {
        element.blur();
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Zoho Recruit <crux-phone-component> — same *shape* of problem as setPhoneValue's
  // intl-tel-input `.iti` DOM fallback above (split dial-code picker + local-number input),
  // just Zoho's Lyte markup instead of iti__* classes. Deliberately mirrors that pattern
  // rather than inventing a second dropdown architecture:
  //   1. Resolve dial-code length against the widget's OWN country list (longest prefix
  //      first) — never guess from digits alone.
  //   2. If nothing in that list matches, return false and leave the value untouched
  //      (same "refuse to corrupt" rule as the .iti path).
  //   3. Open the dial-code control and click the matching option via simulateClick —
  //      NOT a raw `.click()` and NOT a second full fillReactSelectByClick open/search
  //      cycle. simulateClick's PointerEvent sequence is what Claude already confirmed
  //      Lyte needs to *commit* a pick (highlight alone responds to mouse events; commit
  //      needs pointerdown/up). A second fillReactSelectByClick would re-open menus and
  //      risk the cross-field contamination finding (filling one combobox silently
  //      changing another).
  //   4. nativeSet the remaining local digits into the number input (Zoho already needs
  //      keyup — see nativeSet).
  // The dial-code <lyte-dropdown> is intentionally excluded from detectFields (see
  // field-detector.js); this runs as a side effect of filling the Mobile number input,
  // same as iti country selection runs as a side effect of filling the phone <input>.
  async function fillZohoCruxPhone(element, value) {
    const zohoPhone = element.closest && element.closest("crux-phone-component");
    if (!zohoPhone) return false;
    const phone = String(value || "").trim();
    if (!phone) return false;

    const digitsMatch = phone.match(/^\+(\d+)/);
    // No international prefix — not a split we can drive; let setPhoneValue / nativeSet handle it.
    if (!digitsMatch) return false;

    const digits = digitsMatch[1];
    const dropdown = zohoPhone.querySelector('[lt-prop-user-value="dial_code"]');
    const combobox =
      (dropdown && dropdown.querySelector('[role="combobox"][aria-controls]')) ||
      zohoPhone.querySelector('[role="combobox"][aria-controls]');
    if (!combobox) return false;

    // Lyte teleports the country <lyte-drop-item> list out of the component into a separate
    // listbox, linked from the combobox via aria-controls="Lyte_Drop_Body_N". Querying inside
    // crux-phone-component alone finds zero options (the in-component body is just a template).
    const listboxId = combobox.getAttribute("aria-controls");
    const listbox = listboxId ? document.getElementById(listboxId) : null;
    if (!listbox) return false;
    const items = [...listbox.querySelectorAll("lyte-drop-item")];

    let countryItem = null;
    let dialCodeLen = 0;
    for (let len = Math.min(3, digits.length); len >= 1; len--) {
      const code = `+${digits.slice(0, len)}`;
      const match = items.find((item) => {
        const cc = item.querySelector(".zrc-cc");
        return cc && cleanedText(cc) === code;
      });
      if (match) {
        countryItem = match;
        dialCodeLen = len;
        break;
      }
    }
    if (!countryItem) return false;

    // Visibility snapshot before open — same contract fillReactSelectByClick uses, so a
    // freshly-revealed Lyte search box can be found without grabbing an unrelated input.
    const before = new Set(
      [...document.querySelectorAll("*")].filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
    );
    simulateClick(combobox);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Country rows often start as lyteSearchHidden (zero-size). Prefer clicking the known
    // item once it's visible; if the 240-country list keeps it hidden, type its country
    // name into Lyte's fresh filter box (Claude's virtualized-list pattern) so the row
    // actually renders, then click that same known item — never a fuzzy re-search that
    // could land on a different option.
    let visible = countryItem.getBoundingClientRect().width > 0 && countryItem.getBoundingClientRect().height > 0;
    if (!visible) {
      for (let attempt = 0; attempt < 10 && !visible; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const rect = countryItem.getBoundingClientRect();
        visible = rect.width > 0 && rect.height > 0;
      }
    }
    // Same last-resort as fillReactSelectByClick: if the menu never opened under synthetic
    // events (isTrusted gates), try a CDP trusted click before giving up.
    if (!visible && (await trustedClick(combobox))) {
      for (let attempt = 0; attempt < 10 && !visible; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const rect = countryItem.getBoundingClientRect();
        visible = rect.width > 0 && rect.height > 0;
      }
    }
    if (!visible) {
      const countryName = cleanedText(countryItem.querySelector(".lang-cn-name"));
      const filterInput = findFreshFilterInput(before, combobox);
      if (filterInput && countryName) {
        nativeSet(filterInput, countryName);
        for (let attempt = 0; attempt < 20 && !visible; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const rect = countryItem.getBoundingClientRect();
          visible = rect.width > 0 && rect.height > 0;
        }
      }
    }
    // If the option never became clickable, do NOT write a stripped local number — same
    // refuse-to-corrupt rule as the .iti path when the country click couldn't be completed.
    if (!visible) {
      // Same as discoverComboboxOptions: Escape dismisses Workable's apply dialog.
      const inDialog =
        combobox.closest && combobox.closest('[role="dialog"], [data-evergreen-dialog], [aria-modal="true"]');
      if (!inDialog) {
        combobox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      } else {
        try {
          combobox.blur();
        } catch {
          /* ignore */
        }
      }
      return false;
    }

    simulateClick(countryItem);
    await new Promise((resolve) => setTimeout(resolve, 100));
    nativeSet(element, phone.slice(1 + dialCodeLen).trim());
    return true;
  }

  // PeopleForce <pf-phone-number> — dial-code picker (globe button + dialog) beside a visible
  // tel input, plus a hidden sync input. Confirmed live on adroiti.peopleforce.io: plain
  // nativeSet on the visible input left the widget empty because Vue never received the country
  // pick; setPhoneValue's iti path doesn't apply here.
  async function fillPeopleForcePhone(element, value) {
    const mount = element.closest && element.closest('[data-component="pf-phone-number"]');
    if (!mount) return false;
    const phone = String(value || "").trim();
    if (!phone) return false;

    const visibleInput =
      mount.querySelector('input[type="tel"]:not([hidden])') ||
      [...mount.querySelectorAll('input[type="tel"]')].find((el) => !el.hasAttribute("hidden"));
    if (!visibleInput) return false;

    const digitsMatch = phone.match(/^\+(\d+)/);
    if (!digitsMatch) {
      nativeSet(visibleInput, phone);
      return Boolean(String(visibleInput.value || "").trim());
    }

    const digits = digitsMatch[1];
    let dialCodeLen = 0;
    let dialCode = "";
    for (let len = Math.min(4, digits.length); len >= 1; len--) {
      dialCode = `+${digits.slice(0, len)}`;
      dialCodeLen = len;
      break;
    }
    const countryName = (profile.contact && profile.contact.country) || "";

    const countryBtn =
      mount.querySelector('button[aria-haspopup="dialog"]') ||
      mount.querySelector('button[id^="reka-popover-trigger"]') ||
      mount.querySelector("button");
    if (countryBtn) {
      simulateClick(countryBtn);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const scopes = [
        document.querySelector('[role="dialog"][data-state="open"]'),
        document.querySelector('[role="dialog"]'),
        document.querySelector('[data-reka-popover-content]'),
        document.body,
      ].filter(Boolean);
      let picked = false;
      const matchesDial = (t) => {
        for (let len = Math.min(4, digits.length); len >= 1; len--) {
          const code = `+${digits.slice(0, len)}`;
          if (t.includes(code) || new RegExp(`${code.replace("+", "\\+")}\\b`).test(t)) {
            dialCodeLen = len;
            dialCode = code;
            return true;
          }
        }
        return false;
      };
      for (const scope of scopes) {
        const option = [...scope.querySelectorAll("button, li, [role='option'], div, span, a")].find((el) => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!t || t.length > 80) return false;
          if (matchesDial(t)) return true;
          return countryName.length > 2 && t.toLowerCase().includes(countryName.toLowerCase());
        });
        if (option) {
          simulateClick(option);
          picked = true;
          await new Promise((resolve) => setTimeout(resolve, 150));
          break;
        }
        const search = scope.querySelector('input[type="search"], input[type="text"]');
        if (!picked && search && countryName) {
          nativeSet(search, countryName);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const afterSearch = [...scope.querySelectorAll("button, li, [role='option'], div, span, a")].find((el) => {
            const t = (el.textContent || "").toLowerCase();
            return t.includes(countryName.toLowerCase()) || t.includes(dialCode);
          });
          if (afterSearch) {
            simulateClick(afterSearch);
            picked = true;
            await new Promise((resolve) => setTimeout(resolve, 150));
            break;
          }
        }
      }
      if (!picked) {
        const esc = { key: "Escape", code: "Escape", bubbles: true, cancelable: true };
        document.dispatchEvent(new KeyboardEvent("keydown", esc));
        document.dispatchEvent(new KeyboardEvent("keyup", esc));
      }
    }

    const local = phone.slice(1 + dialCodeLen).trim();
    nativeSet(visibleInput, local || phone.replace(/^\+\d+/, "").trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const hidden = mount.querySelector('input[type="tel"][hidden], input#career_application_form_phone_numbers');
    if (hidden && hidden !== visibleInput) {
      nativeSet(hidden, phone);
    }
    return Boolean(String(visibleInput.value || "").trim());
  }

  async function fillSingle(element, value) {
    const tag = element.tagName.toLowerCase();
    if (tag === "select") return setSelectValue(element, value);
    if (element.type === "checkbox" || element.type === "radio") {
      nativeSetChecked(element, Boolean(value));
      return true;
    }
    // Zoho Recruit Mobile/phone widget — must run before the generic setPhoneValue/
    // combobox paths so the dial-code picker and local-number input stay in sync.
    if (await fillPeopleForcePhone(element, value)) return true;
    if (await fillZohoCruxPhone(element, value)) return true;
    // Not gated on element.type === "tel" — many ATS implementations of intl-tel-input
    // render the visible input as type="text", not "tel" (confirmed live: a real Workable
    // form had it as "text", so the type-gated check never even attempted this). Checking
    // for a registered iti instance is harmless on any element — it's a no-op lookup that
    // returns nothing if that exact node was never initialized with the plugin.
    if (await setPhoneValue(element, value)) return true;
    if (
      isSuccessFactorsPicklist(element) &&
      successFactorsPicklistAlreadySet(element, value)
    ) {
      return true;
    }
    if (looksLikeComboboxPick(element)) return await fillReactSelectByClick(element, value);
    nativeSet(element, value);
    return true;
  }

  // Profile dates look like "Mar 2024" / "October 2022" / "2024-03" / "03/2024".
  // Returns { month: 1-12|null, year: "YYYY" } or null for Present/unparseable.
  function parseExperienceDate(raw) {
    const s = String(raw || "").trim();
    if (!s || /^(present|current|now)$/i.test(s)) return null;
    const months = {
      jan: 1,
      january: 1,
      feb: 2,
      february: 2,
      mar: 3,
      march: 3,
      apr: 4,
      april: 4,
      may: 5,
      jun: 6,
      june: 6,
      jul: 7,
      july: 7,
      aug: 8,
      august: 8,
      sep: 9,
      sept: 9,
      september: 9,
      oct: 10,
      october: 10,
      nov: 11,
      november: 11,
      dec: 12,
      december: 12,
    };
    let m = s.match(
      /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*[,\-]?\s*(\d{4})$/i
    );
    if (m) {
      const key = m[1].toLowerCase().replace(/\.$/, "");
      const month = months[key] || months[key.slice(0, 3)];
      return month ? { month, year: m[2] } : null;
    }
    m = s.match(/^(\d{1,2})\s*[\/\-]\s*(\d{4})$/);
    if (m) return { month: Math.min(12, Math.max(1, parseInt(m[1], 10))), year: m[2] };
    m = s.match(/^(\d{4})\s*[\/\-]\s*(\d{1,2})$/);
    if (m) return { month: Math.min(12, Math.max(1, parseInt(m[2], 10))), year: m[1] };
    m = s.match(/^(\d{4})$/);
    if (m) return { month: null, year: m[1] };
    return null;
  }

  function workExperienceIndexFromLabel(label) {
    const m = String(label || "").match(/work\s*experience\s*(\d+)/i);
    return m ? parseInt(m[1], 10) - 1 : null;
  }

  // Workday Work Experience panels: update company + From/To month/year from
  // profile.experience[N], and leave Role Description bullets alone. Confirmed live on
  // intapp.wd1.myworkdayjobs.com — QA-bank matching reused one learned "Roblox"/"Engineer"/
  // bullet blob for every slot, and date spinbuttons weren't even detected before.
  async function fillWorkdayExperienceFromProfile(filledOut, touched) {
    const exp = profile.experience || [];
    if (!exp.length) return;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Workday MM/YYYY spinbuttons ignore a plain .value write (React-controlled; help text
    // even says to use arrow keys). Confirmed live on intapp capture 20260803T170217Z: Auto
    // Fill reported dates filled but the widget kept the old month/year. Focus + replace via
    // InputEvent, then blur/Tab so the paired display div and form model commit.
    async function setWorkdaySpinbutton(input, rawValue) {
      if (!input) return false;
      const desired = String(rawValue);
      const now = (input.getAttribute("aria-valuenow") || input.value || "").replace(/^0+(?=\d)/, "");
      if (now === desired) return true;
      input.focus();
      await sleep(40);
      try {
        input.select();
      } catch {
        /* some spinbuttons reject select() */
      }
      const setter =
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value") &&
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      if (setter) setter.call(input, "");
      else input.value = "";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      let built = "";
      for (const ch of desired) {
        built += ch;
        if (setter) setter.call(input, built);
        else input.value = built;
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true, cancelable: true }));
      }
      input.setAttribute("aria-valuenow", desired);
      input.setAttribute("aria-valuetext", desired);
      const wrap =
        (input.closest &&
          (input.closest('[id*="dateSectionMonth"]') || input.closest('[id*="dateSectionYear"]'))) ||
        input.parentElement;
      const display =
        wrap &&
        wrap.querySelector(
          '[data-automation-id="dateSectionMonth-display"], [data-automation-id="dateSectionYear-display"]'
        );
      if (display) {
        const isMonth = (input.getAttribute("data-automation-id") || "").includes("Month");
        display.textContent = isMonth && desired.length === 1 ? `0${desired}` : desired;
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      input.blur();
      await sleep(60);
      return true;
    }

    async function setDateField(fieldRoot, dateStr, labelPrefix) {
      const parsed = parseExperienceDate(dateStr);
      if (!fieldRoot || !parsed) return;
      const monthInput = fieldRoot.querySelector('[data-automation-id="dateSectionMonth-input"]');
      const yearInput = fieldRoot.querySelector('[data-automation-id="dateSectionYear-input"]');
      if (monthInput && parsed.month != null) {
        await setWorkdaySpinbutton(monthInput, parsed.month);
        touched.add(monthInput);
        filledOut.push({ label: `${labelPrefix} Month`, value: String(parsed.month), source: "profile" });
      }
      if (yearInput && parsed.year) {
        await setWorkdaySpinbutton(yearInput, parsed.year);
        touched.add(yearInput);
        filledOut.push({ label: `${labelPrefix} Year`, value: String(parsed.year), source: "profile" });
      }
    }

    function checkboxIsOn(el) {
      const aria = el.getAttribute("aria-checked");
      if (aria === "true") return true;
      if (aria === "false") return false;
      return Boolean(el.checked);
    }

    for (let i = 0; i < exp.length; i++) {
      const heading = document.getElementById(`Work-Experience-${i + 1}-panel`);
      if (!heading) continue;
      const panel = heading.closest('[role="group"]') || heading.parentElement;
      if (!panel) continue;
      const entry = exp[i];
      const prefix = `Work Experience ${i + 1}`;
      const isPresent = !entry.end_date || /present|current/i.test(String(entry.end_date));

      const titleInput = panel.querySelector(
        '[data-automation-id="formField-jobTitle"] input, input[id*="jobTitle"], input[name="jobTitle"]'
      );
      if (titleInput && entry.title) {
        await fillSingle(titleInput, entry.title);
        touched.add(titleInput);
        filledOut.push({ label: `${prefix} - Job Title`, value: entry.title, source: "profile" });
      }

      const companyInput = panel.querySelector(
        '[data-automation-id="formField-companyName"] input, input[id*="companyName"], input[name="companyName"]'
      );
      if (companyInput && entry.company) {
        await fillSingle(companyInput, entry.company);
        touched.add(companyInput);
        filledOut.push({ label: `${prefix} - Company`, value: entry.company, source: "profile" });
      }

      // Checkbox BEFORE dates: Workday shows/hides the To field from this. Only change when
      // the desired state differs — never click an already-correct Present checkbox.
      const currentCb = panel.querySelector(
        '[data-automation-id="formField-currentlyWorkHere"] input[type="checkbox"], input[id*="currentlyWorkHere"]'
      );
      if (currentCb) {
        if (checkboxIsOn(currentCb) !== isPresent) {
          await fillSingle(currentCb, isPresent);
          await sleep(150);
        }
        touched.add(currentCb);
        filledOut.push({
          label: `${prefix} - I currently work here`,
          value: isPresent ? "Yes" : "No",
          source: "profile",
        });
      }

      const startRoot = panel.querySelector('[data-automation-id="formField-startDate"]');
      await setDateField(startRoot, entry.start_date, `${prefix} - From`);
      if (!isPresent) {
        const endRoot = panel.querySelector('[data-automation-id="formField-endDate"]');
        await setDateField(endRoot, entry.end_date, `${prefix} - To`);
      }
    }
  }

  // BambooHR's "Fabric" design system swaps the State/Province field between a fab-Select
  // dropdown (button + hidden native <select>) and a plain MUI text <input> depending on the
  // Country field's current value - confirmed live, choosing "Poland" for Country removes the
  // "State" dropdown's button+hidden-select nodes outright and inserts a brand-new "Province"
  // text input in their place. Since singles is collected ONCE up front, filling Country earlier
  // in this same loop leaves the previously-collected State entry pointing at now-detached
  // nodes - fillSingle silently does nothing to them, and the real, live Province input never
  // gets touched at all. Neither ownLabel ("State" vs "Province") nor id (regenerated each
  // render) survive the swap, but the underlying form control's name attribute (e.g.
  // "state.value") does - used as the stable key to re-find the live replacement. closest()/
  // querySelector() both still work on an already-detached subtree, so this reads correctly
  // even off the stale element itself.
  function nearestNamedControlKey(element) {
    if (element.name) return element.name;
    const scope = element.closest(".MuiFormControl-root") || element.parentElement;
    const named = scope && scope.querySelector("[name]");
    return named ? named.name : null;
  }

  // ---- RUN ----
  const filled = [];
  const unmatched = [];
  let nextIdx = 0;
  const stampIdx = (el, label) => {
    const idx = nextIdx++;
    el.setAttribute("data-af-idx", String(idx));
    if (label) el.setAttribute("data-af-label", label);
    return idx;
  };

  const { groups, singles, loneCheckboxes } = collectFormFields();
  // Captured up front, while every single is still live and attached - nearestNamedControlKey
  // walks up via closest()/parentElement, which stops working the moment a field's own
  // ancestor's innerHTML gets reassigned out from under it (a removed node's parentElement goes
  // null, same as BambooHR's real Country->State/Province swap does). Computing this later, once
  // an element has already gone stale, would silently return null and defeat the relocation this
  // is for in the first place.
  const singleKeys = new Map(singles.map(({ element }) => [element, nearestNamedControlKey(element)]));

  // Workday Work Experience: company + dates from profile BEFORE the generic QA path can
  // overwrite every slot with one learned Roblox/bullet answer. Touched nodes are skipped
  // below so QA/generation don't fight this pass.
  const workExpTouched = new Set();
  await fillWorkdayExperienceFromProfile(filled, workExpTouched);

  for (const group of groups) {
    // Privacy/terms consent: auto-agree when a Yes/Agree-style option exists.
    if (isConsentField(group.label)) {
      const consentPick =
        clickGroupOption(group.options, "I agree") ||
        clickGroupOption(group.options, "Agree") ||
        clickGroupOption(group.options, "Yes") ||
        clickGroupOption(group.options, "Accept");
      if (consentPick) {
        filled.push({ label: group.label, value: "yes", source: "consent" });
        continue;
      }
    }
    const qaMatch = matchQaBank(group.label);
    if (qaMatch) {
      // Drop "Select One" / "Choose an option" chrome before inspecting options.
      const optionLabelsPreview = group.options
        .map((o) => o.optionLabel)
        .filter((t) => t && !isGenericSelectPlaceholder(t));
      const isYesNoGroup = optionLabelsPreview.some((t) => /^(yes|no)$/i.test(String(t).trim()));
      const answerIsYesNo = /^(yes|no|true|false|y|n)$/i.test(String(qaMatch.answer || "").trim());
      // A saved Yes/No answer must not be reused against a multi-option skill checklist
      // (Zoho "What all Design Patterns…", "Did you worked on this technologies?") — confirmed
      // live: QA bank "No" matched Design Patterns and blocked GPT select-pick entirely.
      if (!(answerIsYesNo && !isYesNoGroup)) {
        if (group.kind === "checkbox-group" && /[,;]/.test(qaMatch.answer)) {
          let any = false;
          for (const part of qaMatch.answer.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
            if (clickGroupOption(group.options, part)) any = true;
          }
          if (any) {
            filled.push({ label: group.label, value: qaMatch.answer, source: "learned" });
            continue;
          }
        } else if (clickGroupOption(group.options, qaMatch.answer)) {
          filled.push({ label: group.label, value: qaMatch.answer, source: "learned" });
          continue;
        }
      }
    }
    // Drop "Select One" / "Choose an option" chrome — never real answers, and never GPT options.
    const optionLabels = group.options
      .map((o) => o.optionLabel)
      .filter((t) => t && !isGenericSelectPlaceholder(t));
    if (optionLabels.length === 1 && clickGroupOption(group.options, optionLabels[0])) {
      filled.push({ label: group.label, value: optionLabels[0], source: "only-option" });
      continue;
    }
    // Stamp the first option element so a later AI pick can click the matching sibling(s).
    if (optionLabels.length > 1 && group.options[0] && group.options[0].element) {
      const idx = stampIdx(group.options[0].element, group.label);
      unmatched.push({
        idx,
        label: group.label,
        type: group.kind,
        canGenerate: false,
        options: optionLabels,
        // checkbox-group = select-all-that-apply; radio/button = single pick.
        multi: group.kind === "checkbox-group",
      });
      continue;
    }
    unmatched.push({ label: group.label, type: group.kind, canGenerate: false });
  }

  for (let { element, host } of singles) {
    if (!element.isConnected) {
      const key = singleKeys.get(element);
      const relocated = key && collectFormFields().singles.find((s) => nearestNamedControlKey(s.element) === key);
      if (relocated) ({ element, host } = relocated);
      else continue; // gone with nothing live to replace it - nothing left to fill
    }
    if (workExpTouched.has(element)) continue;
    const label = labelForElement(element, host);
    // Structured matching needs the field's OWN label, not the group-prefixed display label
    // above - confirmed live, a Workday "Address" section wraps City/Neighborhood/Municipality/
    // etc. in role="group" aria-labelledby="Address-section", so labelForElement prepends
    // "Address - " to every field in it ("Address - City"), and the anchored `^address\b`
    // street-address pattern then wins over the more specific `^city\b` pattern purely because
    // of pattern order, filling City/Neighborhood/Municipality/... with the street address
    // instead of their own real values.
    const ownLabel = normalizeLabel(resolveOwnLabel(element, host));
    const weIdx = workExperienceIndexFromLabel(label);
    if (weIdx !== null) {
      // Explicit request: Auto Fill must NOT touch Work Experience Role Description / bullets
      // (leave whatever Workday or the applicant already put there). Location is left alone;
      // Job Title + Company + dates come from profile.experience[N] (see
      // fillWorkdayExperienceFromProfile above).
      if (/role\s*description|description|responsibilit|duties|achievements|bullet/i.test(ownLabel)) {
        continue;
      }
      if (/^location\b/i.test(ownLabel)) {
        continue;
      }
      // Job Title / Company / From-To month-year that somehow weren't caught by the Workday
      // panel walk — still prefer indexed profile experience over a one-size-fits-all QA answer.
      const entry = (profile.experience || [])[weIdx];
      if (entry && /^(job\s*title|title)\b/i.test(ownLabel) && entry.title) {
        if (await fillSingle(element, entry.title)) {
          filled.push({ label, value: entry.title, source: "profile" });
          continue;
        }
      }
      if (entry && /^company\b/i.test(ownLabel) && entry.company) {
        if (await fillSingle(element, entry.company)) {
          filled.push({ label, value: entry.company, source: "profile" });
          continue;
        }
      }
      if (entry && /\b(from|to)\b/i.test(ownLabel) && /\b(month|year)\b/i.test(ownLabel)) {
        const isFrom = /\bfrom\b/i.test(ownLabel);
        const dateStr = isFrom ? entry.start_date : entry.end_date;
        if (!isFrom && (!dateStr || /present|current/i.test(String(dateStr || "")))) continue;
        const parsed = parseExperienceDate(dateStr);
        if (parsed) {
          const value = /\bmonth\b/i.test(ownLabel) ? parsed.month : parsed.year;
          if (value != null && (await fillSingle(element, String(value)))) {
            filled.push({ label, value: String(value), source: "profile" });
            continue;
          }
        }
      }
    }
    let structured = matchStructuredField(ownLabel, element);
    if (structured.value == null && label !== ownLabel) structured = matchStructuredField(label, element);
    let structuredValue = structured.value;
    // SmartRecruiters location autocomplete is labeled "City" but wants a full place pick —
    // prefer contact.location ("Warsaw, Poland") over bare city when available.
    if (
      structuredValue &&
      /^city\b/i.test(ownLabel) &&
      element.closest &&
      element.closest(
        'spl-autocomplete, oc-location-autocomplete, oc-location-autocomplete-wrapper, [data-test="location-autocomplete"]'
      )
    ) {
      structuredValue = (profile.contact && (profile.contact.location || profile.contact.city)) || structuredValue;
    }
    if (structuredValue && (await fillSingle(element, structuredValue))) {
      filled.push({ label, value: String(structuredValue), source: "profile" });
      // Diagnostic only (temporary, not a fix): reported live that an intl-tel-input-wrapped
      // phone number field ends up WRONG after being correctly filled right here - something
      // else changes it afterward, exact mechanism not yet confirmed (candidate: Greenhouse's
      // own app syncing this field against the SEPARATE .phone-input__country react-select
      // filled elsewhere in this same loop). Polls and logs any value change with a timestamp so
      // a repro's console output pinpoints exactly when/what changes it, instead of guessing at
      // undocumented app internals blind - remove once the real mechanism is confirmed and fixed.
      if (element.closest && element.closest(".iti, [class*='PhoneInput']")) {
        let lastSeen = element.value;
        let watchTicks = 0;
        console.info(`[Auto Fill][phone-watch] filled "${lastSeen}" - watching for later changes`);
        // 8s (20 ticks) turned out far too short - a real multi-field form's remaining comboboxes
        // (each burning several seconds of their own fillReactSelectByClick fallback tiers) can
        // easily run past that before the field the user actually saw it change on is even
        // reached, so the watcher had already stopped before the real change happened. 2 minutes
        // comfortably covers a full Auto Fill run instead of guessing at a duration.
        const watchId = setInterval(() => {
          watchTicks++;
          if (element.value !== lastSeen) {
            console.warn(`[Auto Fill][phone-watch] value changed from "${lastSeen}" to "${element.value}" (~${watchTicks * 400}ms after fill)`);
            lastSeen = element.value;
          }
          if (watchTicks >= 300) clearInterval(watchId);
        }, 400);
      }
      continue;
    }
    if (isPhoneDialCodePicker(element) && profile.contact && profile.contact.phone) {
      // Real calling codes are 1-3 digits with no way to tell the boundary from the digit
      // string alone (see setPhoneValue's own comment on the same ambiguity) - `/^(\+\d+)/` used
      // to match the ENTIRE leading digit run, not just the code, so this always tried to match
      // e.g. "+48694542078" (the whole phone number) against the picker's options first. That
      // can never match anything real, so it silently burned all 4 fillReactSelectByClick tiers
      // (~4-5s) on a guaranteed failure every single run before ever reaching the country-name
      // attempt below - confirmed live via the new tier logging, and reported as "why does this
      // need 3 retries, just find the option and close - what's difficult?". Since
      // profile.contact.country is unambiguous, there's no need to guess a calling code from the
      // phone digits at all - just use the country name directly as the only fill attempt.
      // Confirmed live via the SAME capture that this widget always DISPLAYS its committed value
      // as just "+48" (flag + calling code, never the country name) even when picked BY country
      // name - a real click on the matching option landed correctly (poll #0, first try) but
      // still read back as "not committed" because comboboxValueCommitted's plain text compare
      // checked the display against "Poland" and found no overlap with "+48" at all. Checking
      // for a bare "+<digits>" display as an ALTERNATE success signal (in addition to the normal
      // text compare, in case some other site's version of this widget does show the name)
      // fixes the verification without needing to know the exact expected code.
      // A bare shape check ("does this look like SOME +NN dial code") isn't enough on its own -
      // the wrong value Greenhouse's own app can reset this field TO is ALSO shaped like a real
      // dial code (confirmed live: "+374" for Armenia), so shape alone can't tell "correct" apart
      // from "wrong but still valid-looking". Since any GENUINELY correct calling code must be a
      // literal PREFIX of the profile's own full phone number, checking that directly sidesteps
      // the "which exact length is the real code" ambiguity noted above entirely - exact-value
      // verification, not just shape verification.
      const phoneDigitsForCheck = String(profile.contact.phone || "").replace(/[^\d+]/g, "");
      const isCorrectDialCode = (v) => {
        const code = String(v || "").trim();
        return /^\+\d{1,4}$/.test(code) && phoneDigitsForCheck.startsWith(code);
      };
      // Confirmed live via the country-picker watcher above: its display kept changing long
      // after this field's own fill was done and the loop had moved on to LATER, unrelated
      // fields - "+48" -> "+376" (Andorra) -> "+374" (Armenia), both early entries in an
      // alphabetically-sorted country list, at timings that lined up exactly with a LATER
      // combobox's own keyboard-navigation fallback (tier 3, repeated ArrowDown key presses)
      // dispatched for THAT OTHER field. This picker's own dropdown/"active" state was never
      // explicitly closed after a successful commit (discoverComboboxOptions already closes
      // down the SAME way elsewhere in this file, for the same reason) - it stays open/active in
      // whatever sense Greenhouse's remix react-select tracks that, and later, completely
      // unrelated ArrowDown presses meant for a different field's own retry logic get silently
      // absorbed by it instead, walking it one option at a time through the country list and
      // changing the committed value out from under a field that had already finished.
      const closeComboboxDown = async () => {
        try {
          const init = { key: "Escape", code: "Escape", bubbles: true, cancelable: true };
          element.dispatchEvent(new KeyboardEvent("keydown", init));
          element.dispatchEvent(new KeyboardEvent("keyup", init));
          element.blur();
        } catch {
          /* ignore */
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      };
      // Diagnostic only (temporary, not a fix): the earlier phone-watch instrumentation only
      // ever watched the NUMBER input's own `.value` - it never watched THIS element's own
      // displayed value at all, so a report of the *country/dial-code* picker itself changing
      // later (distinct from the number digits, which the number-field watcher already confirmed
      // stays put) had no logging covering it whatsoever. Polls reactSelectDisplayValue the same
      // way the number-field watcher polls .value, for the same 2-minute window.
      const watchCountryDisplay = () => {
        let lastSeen = reactSelectDisplayValue(element);
        let watchTicks = 0;
        console.info(`[Auto Fill][phone-watch] country picker showing "${lastSeen}" - watching for later changes`);
        const watchId = setInterval(() => {
          watchTicks++;
          const now = reactSelectDisplayValue(element);
          if (now !== lastSeen) {
            console.warn(`[Auto Fill][phone-watch] country picker changed from "${lastSeen}" to "${now}" (~${watchTicks * 400}ms after fill)`);
            lastSeen = now;
          }
          if (watchTicks >= 300) clearInterval(watchId);
        }, 400);
      };
      // Diagnostic only (temporary, not a fix): the previous version of this tried to catch
      // mutations by monkey-patching Node.prototype's own mutation methods - which came back
      // completely silent despite the value still changing, and for a fundamental reason, not
      // because nothing happened: chrome.scripting.executeScript runs this whole script in an
      // ISOLATED WORLD, a separate JS realm from the page's own scripts, with its OWN separate
      // copy of built-ins like Node.prototype. Patching "my" copy has zero effect on React's own
      // calls to insertBefore/removeChild/etc., which go through the PAGE's own, completely
      // different copy of the same-named method - the trap could never have fired regardless of
      // what was actually happening. MutationObserver is a real browser API that watches the
      // ACTUAL SHARED DOM tree directly, not a JS-realm-scoped function override, so it isn't
      // subject to the same isolation gap and will fire regardless of which world caused the
      // change. Trade-off: its callback fires asynchronously, so it can't capture the ORIGINAL
      // synchronous call stack the way a same-realm patch could have - but it WILL reliably
      // fire and report real mutation records (what changed, old value, added/removed nodes),
      // which the previous version never had a chance of doing at all.
      const traceCountryPickerMutations = () => {
        const shell = element.closest && element.closest(".select-shell, .select__container");
        if (!shell) return;
        const describe = (n) =>
          !n ? "null" : n.nodeType === 3 ? `text:"${n.data}"` : `<${n.tagName}${n.className ? ` class="${n.className}"` : ""}>`;
        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            console.warn("[Auto Fill][phone-watch] MUTATION observed inside country picker subtree:", {
              type: m.type,
              target: describe(m.target),
              addedNodes: [...m.addedNodes].map(describe),
              removedNodes: [...m.removedNodes].map(describe),
              attributeName: m.attributeName,
              oldValue: m.oldValue,
            });
          }
        });
        observer.observe(shell, {
          childList: true,
          subtree: true,
          characterData: true,
          characterDataOldValue: true,
          attributes: true,
          attributeOldValue: true,
        });
        setTimeout(() => observer.disconnect(), 90000);
      };
      const shown = reactSelectDisplayValue(element);
      if (isCorrectDialCode(shown)) {
        filled.push({ label, value: shown, source: "profile" });
        console.info(`[Auto Fill][phone-watch] country picker already showed "${shown}"`);
        await closeComboboxDown();
        watchCountryDisplay();
        traceCountryPickerMutations();
        continue;
      }
      if (profile.contact.country) {
        // Deliberately ignoring fillReactSelectByClick's own return value here (was `committed
        // || isCorrectDialCode(nowShown)`) - it can ALSO be fooled by the exact same shape-only
        // bug just fixed above, via its own internal isReactSelectAlreadySet short-circuit at the
        // very top: if the widget already shows ANY dial-shaped value (even the wrong one, e.g.
        // "+374") when this call starts, that check returns true immediately without attempting
        // anything, `committed` comes back true anyway, and this whole block would have trusted
        // that false "already correct" via the `||` regardless of what isCorrectDialCode(nowShown)
        // itself correctly says. Relying solely on the exact-value check below closes that gap.
        await fillReactSelectByClick(element, profile.contact.country);
        const nowShown = reactSelectDisplayValue(element);
        if (isCorrectDialCode(nowShown)) {
          filled.push({ label, value: nowShown || profile.contact.country, source: "profile" });
          console.info(
            `[Auto Fill][phone-watch] country picker committed via country name "${profile.contact.country}" (now showing "${nowShown}")`
          );
          await closeComboboxDown();
          watchCountryDisplay();
          traceCountryPickerMutations();
          continue;
        }
      }
      console.warn("[Auto Fill][phone-watch] country picker FAILED to commit any value");
    }
    if (looksLikeComboboxPick(element) && isConsentField(label)) {
      const consentPicks = ["I agree", "Yes", "Agree", "Accept"];
      const qaEarly = matchQaBank(label, element);
      if (qaEarly && qaEarly.answer) consentPicks.unshift(qaEarly.answer);
      let consentDone = false;
      for (const pick of [...new Set(consentPicks.map(String))]) {
        if (await fillReactSelectByClick(element, pick)) {
          filled.push({ label, value: pick, source: "consent" });
          consentDone = true;
          break;
        }
      }
      if (consentDone) continue;
    }
    const qaMatch = matchQaBank(label, element);
    let qaComboboxFailed = false;
    const qaAnswerUsable = qaMatch && isPlausibleQaComboboxAnswer(label, qaMatch.answer);
    if (
      qaAnswerUsable &&
      looksLikeComboboxPick(element) &&
      !/^(yes|no)$/i.test(String(resolveOwnLabel(element, host) || ""))
    ) {
      if (fillGreenhouseViaReactFiber(element, qaMatch.answer)) {
        filled.push({ label, value: qaMatch.answer, source: "learned" });
        continue;
      }
      if (await fillReactSelectByClick(element, qaMatch.answer)) {
        filled.push({ label, value: qaMatch.answer, source: "learned" });
        continue;
      }
      qaComboboxFailed = true;
    }
    if (qaAnswerUsable && !qaComboboxFailed && (await fillSingle(element, qaMatch.answer))) {
      filled.push({ label, value: qaMatch.answer, source: "learned" });
      continue;
    }
    const tag = element.tagName.toLowerCase();

    // Privacy/terms consent on a native <select> (All Jobs Pro: multi_consent) — auto-pick
    // "I agree" / "Yes" when present, same as checkbox/radio consent groups above.
    if (tag === "select" && isConsentField(label)) {
      const consentLabels = [...element.options]
        .map((o) => cleanedText(o).trim())
        .filter(Boolean);
      const consentPick =
        consentLabels.find((t) => /^i agree$/i.test(t)) ||
        consentLabels.find((t) => /^agree$/i.test(t)) ||
        consentLabels.find((t) => /^yes$/i.test(t)) ||
        consentLabels.find((t) => /^accept$/i.test(t));
      if (consentPick && (await fillSingle(element, consentPick))) {
        filled.push({ label, value: consentPick, source: "consent" });
        continue;
      }
    }

    // Required native <select>: one real option → pick it; several → stamp for AI option-pick.
    if (tag === "select" && isRequiredField(element, host)) {
      const optionLabels = [...element.options]
        .map((o) => cleanedText(o).trim())
        .filter((t) => t && !/^\?/.test(t) && !isGenericSelectPlaceholder(t));
      if (optionLabels.length === 1 && (await fillSingle(element, optionLabels[0]))) {
        filled.push({ label, value: optionLabels[0], source: "only-option" });
        continue;
      }
      if (optionLabels.length > 1) {
        const idx = stampIdx(element, label);
        unmatched.push({
          idx,
          label,
          type: element.type || tag,
          canGenerate: false,
          options: optionLabels,
        });
        continue;
      }
    }

    // Same idea, extended to custom (non-native) comboboxes - explicitly requested, since a
    // react-select-style `[role="combobox"]`/`button[aria-haspopup]` etc. widget has no
    // `.options` list to read the way a real <select> does. discoverComboboxOptions opens it,
    // reads whatever renders, and closes it back down before this continues (a genuine pick -
    // either the single-option auto-fill below, or the AI-picked answer from a later batch via
    // fillGeneratedAnswersInPage's existing `looksLikeComboboxPick` branch - happens through
    // fillReactSelectByClick's own independent open/close cycle, not this discovery pass).
    // Also run when a QA-bank combobox fill failed — confirmed live on Greenhouse EEO dropdowns
    // (Gender, Hispanic/Latino): QA had the right answer but react-select never committed, and
    // skipping discovery left select-pick/GPT without real option labels.
    if (
      looksLikeComboboxPick(element) &&
      !isPhoneDialCodePicker(element) &&
      (!qaMatch || qaComboboxFailed) &&
      (isRequiredField(element, host) || qaComboboxFailed)
    ) {
      let optionLabels = findRadixHiddenSelectOptions(element);
      if (!optionLabels.length) {
        optionLabels = await discoverComboboxOptions(element);
      }
      // Diagnostic only (temporary, not a fix): reported live that several required combobox
      // questions on the same page (multiple similarly-shaped "level of experience with X?"
      // dropdowns) end up in "need your input" without ever becoming a GPT/select-pick
      // candidate at all - meaning optionLabels came back empty here for them specifically, so
      // they fall through to the generic catch-all with no options attached, further down.
      // Logging every attempt (not just failures) so a repro's console shows exactly which
      // fields succeeded vs failed discovery, in what order, instead of guessing why some
      // structurally-identical fields on the same page work and others don't.
      console.info(`[Auto Fill][combobox-discovery] "${label}" -> ${optionLabels.length} option(s) found`);
      if (optionLabels.length === 1 && (await fillSingle(element, optionLabels[0]))) {
        filled.push({ label, value: optionLabels[0], source: "only-option" });
        continue;
      }
      if (optionLabels.length > 1) {
        const idx = stampIdx(element, label);
        unmatched.push({
          idx,
          label,
          type: element.type || tag,
          canGenerate: false,
          options: optionLabels,
        });
        continue;
      }
    }

    // Privacy/terms on a react-select-style combobox (confirmed live: New Relic Greenhouse
    // Applicant Privacy Policy is a required dropdown, not a checkbox).
    if (looksLikeComboboxPick(element) && isConsentField(label)) {
      let consentDone = false;
      for (const pick of ["I agree", "Yes", "Agree", "Accept"]) {
        if (await fillReactSelectByClick(element, pick)) {
          filled.push({ label, value: pick, source: "consent" });
          consentDone = true;
          break;
        }
      }
      if (consentDone) continue;
    }

    // "range" included alongside the plain text-like types - confirmed live, a Teamtailor
    // rangeslider.js widget's real (visually near-invisible) `<input type="range">` backs an
    // ordinary free-text-answerable numeric question ("How many years of experience do you have
    // with full-stack development?"), not a discrete, un-generatable option picker like a
    // select/combobox - excluding it here left a genuinely required, generatable question stuck
    // asking for manual input even after isVisible() started detecting it correctly.
    const isFreeText = tag === "textarea" || (tag === "input" && /^(text|email|tel|url|search|range)?$/i.test(element.type || ""));
    const isCoverLetter = /\bcover(ing)?\s*letter\b/i.test(label) || /\bcover(ing)?\s*letter\b/i.test(ownLabel);
    const fieldRequired = isRequiredField(element, host) || isCoverLetter;
    const gptBatchEligible =
      isFreeText &&
      !isConsentField(label) &&
      !structured.isStructuredCategory &&
      !looksLikeComboboxPick(element) &&
      fieldRequired;
    const canGenerate = gptBatchEligible && !isConsequential(label);
    // Stamped for every unmatched field (including selects above) — the side panel tries an
    // AI-based QA-bank match first, then free-text generation / select option-picking.
    const idx = stampIdx(element, label);
    // Greenhouse's phone dial-code picker (bare "Country" label, see isPhoneDialCodePicker)
    // falls through to here when its own dedicated profile-driven fill attempts above all fail
    // to commit — it must never be handed a QA-bank-"learned" or AI-picked value instead, since
    // its only correct value is derived from profile.contact.phone/country directly. Without
    // this flag, a QA-bank entry that once got wrongly saved for this exact bare "Country" label
    // (from before this exclusion existed) gets silently reapplied on every future run via the
    // gpt-auto local QA-match pass below, regardless of any fix to how it originally got saved -
    // confirmed live: a genuinely non-generatable, option-less unmatched entry still ended up
    // filled with an unrelated, wrong country each run.
    unmatched.push({
      idx,
      label,
      type: element.type || tag,
      canGenerate,
      gptBatchEligible,
      skipQaMatch: isPhoneDialCodePicker(element),
    });
  }

  // SAP SuccessFactors: State/Province stays disabled until Country/Region commits — re-scan
  // after the main singles pass so the cascading picklist is live before we give up on it.
  for (const { element, host } of collectFormFields().singles) {
    if (!element.isConnected || !isSuccessFactorsPicklist(element) || element.disabled) continue;
    const label = labelForElement(element, host);
    const ownLabel = normalizeLabel(resolveOwnLabel(element, host));
    if (!/^(state|province)\b/i.test(ownLabel) && !/^state\/province$/i.test(label)) continue;
    if (filled.some((f) => f.label === label)) continue;
    const structured = matchStructuredField(ownLabel, element);
    if (!structured.value) continue;
    if (await fillSingle(element, structured.value)) {
      filled.push({ label, value: String(structured.value), source: "profile" });
    }
  }

  // Ungrouped single checkboxes (no shared `name`, so not caught above) — e.g. a lone
  // "Subscribe to updates" checkbox. Privacy/terms consents are auto-checked; others match
  // yes/no against the QA bank only.
  for (const { element } of loneCheckboxes) {
    // tabindex="-1" marks a checkbox as non-focusable — in practice this means it's a
    // decorative native-form/ARIA proxy sitting alongside a custom-rendered control (e.g.
    // Ashby's button-driven Yes/No pairs, see collectButtonGroups) rather than something a
    // real user tabs to and toggles directly. Filling it here would be a false positive:
    // `.checked` flips and gets reported as filled, but the actual app (which reacts to the
    // real button's click handler, not this checkbox's native change event) never sees it —
    // confirmed live, this exact pattern silently left "Are you currently based in Poland?"
    // unanswered on the real page while Auto Fill's own report claimed success.
    if (element.getAttribute("tabindex") === "-1") continue;
    if (workExpTouched.has(element)) continue;
    const label = labelForElement(element, element);
    if (isConsentField(label)) {
      await fillSingle(element, true);
      filled.push({ label, value: "yes", source: "consent" });
      continue;
    }
    const qaMatch = matchQaBank(label);
    if (qaMatch) {
      await fillSingle(element, /^(yes|true|y)$/i.test(qaMatch.answer.trim()));
      filled.push({ label, value: qaMatch.answer, source: "learned" });
    } else {
      unmatched.push({ label, type: element.type, canGenerate: false });
    }
  }

  // Ashby saves each text answer with a 500ms-debounced GraphQL mutation (flushed on blur).
  // nativeSet already focus/blurs, but the mutation still needs a beat to finish before Submit
  // reads server-side values — confirmed live: immediate Submit after Auto Fill still showed
  // "Missing entry" for Name/Email/salary even when the DOM looked filled.
  if (/(^|\.)ashbyhq\.com$/i.test(location.hostname || "")) {
    await new Promise((resolve) => setTimeout(resolve, 650));
  }

  return { filled, unmatched };
}
async function fillGeneratedAnswersInPage(answers) {
  function nativeSet(element, value) {
    const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    const str = value == null ? "" : String(value);
    // Kept in sync with runAutofillInPage.nativeSet — Ashby (and similar) only persist on blur.
    try {
      element.focus();
    } catch {
      /* not focusable */
    }
    const prev = element.value;
    const tracker = element._valueTracker;
    if (tracker) {
      try {
        tracker.setValue(prev);
      } catch {
        /* ignore */
      }
    }
    if (setter) setter.call(element, str);
    else element.value = str;
    if (typeof InputEvent === "function") {
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: str })
      );
    } else {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    // Some widgets sync their own internal model off keyboard events specifically, not input/
    // change - confirmed live, a Zoho Recruit phone field's own component binds its handlers via
    // keypress="..."/keyup="..."/paste="..." attributes and nothing else, so the value set above
    // (even via the native setter, with input/change already dispatched) was invisible to it and
    // got silently reverted to empty on its next re-render - Auto Fill reported the field filled
    // while the real page showed it blank. A generic keyup (bubbles, harmless to anything that
    // doesn't specifically listen for it) covers this without needing to know the exact
    // framework or which key it expects.
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
    try {
      element.blur();
    } catch {
      /* ignore */
    }
  }

  // Same reasoning as nativeSet above, just for `checked` - React (and similar) tracks a
  // controlled checkbox/radio's checked state through its own overridden property setter too, a
  // plain `element.checked = x` write goes through that same override and gets silently ignored
  // on the next dispatched event. Confirmed live: a required consent checkbox visually ticked
  // correctly but the site's own validation never cleared - the same "looks filled, framework
  // never noticed" symptom nativeSet already exists to prevent for text fields.
  function nativeSetChecked(element, checked) {
    // Kept in sync with runAutofillInPage — skip when already in the desired state so a
    // synthetic click doesn't toggle a correct checkbox off (Workday "I currently work here").
    const want = Boolean(checked);
    const aria = element.getAttribute("aria-checked");
    const isOn = aria === "true" ? true : aria === "false" ? false : Boolean(element.checked);
    if (isOn === want) return;
    const setter =
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked") &&
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked").set;
    if (setter) setter.call(element, want);
    else element.checked = want;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    for (const type of ["mousedown", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  }

  function setSelectValue(select, value) {
    let desired = String(value).trim();
    const options = [...select.options];
    const optionTexts = options.map((o) => (o.textContent || "").trim()).filter((t) => t && !/please select/i.test(t));
    if (
      optionTexts.some((t) => /\bA1\b/i.test(t) || /\bC1\b/i.test(t)) &&
      /fluent|native|proficient|advanced|c1|c2|mastery/i.test(desired.toLowerCase())
    ) {
      const cefr =
        optionTexts.find((t) => /\bC2\b/i.test(t) && /mastery|proficient/i.test(t)) ||
        optionTexts.find((t) => /\bC1\b/i.test(t)) ||
        optionTexts.find((t) => /advanced/i.test(t)) ||
        optionTexts.find((t) => /upper intermediate/i.test(t));
      if (cefr) desired = cefr;
    } else if (
      optionTexts.some((t) => /\bB1\b/i.test(t)) &&
      /\bintermediate\b/i.test(desired.toLowerCase()) &&
      !/upper/i.test(desired.toLowerCase())
    ) {
      const b = optionTexts.find((t) => /\bB1\b/i.test(t) || /intermediate/i.test(t));
      if (b) desired = b;
    } else if (
      optionTexts.some((t) => /\bA1\b/i.test(t)) &&
      /\b(beginner|elementary|basic)\b/i.test(desired.toLowerCase())
    ) {
      const a = optionTexts.find((t) => /\bA1\b/i.test(t) || /beginner/i.test(t));
      if (a) desired = a;
    }
    const target = desired.toLowerCase();
    let matches = options.filter((o) => (o.textContent || "").trim().toLowerCase() === target);
    if (!matches.length) {
      matches = options.filter(
        (o) =>
          (o.textContent || "").trim().toLowerCase().includes(target) ||
          target.includes((o.textContent || "").trim().toLowerCase())
      );
    }
    if (!matches.length) return false;
    if (select.multiple) options.forEach((o) => { o.selected = matches.includes(o); });
    else select.value = matches[0].value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function looksLikeComboboxPick(element) {
    if (
      element.classList.contains("iti__selected-flag") ||
      element.classList.contains("iti__selected-country") ||
      (element.closest && element.closest(".iti__flag-container"))
    ) {
      return false;
    }
    return (
      element.getAttribute("role") === "combobox" ||
      element.getAttribute("aria-autocomplete") === "list" ||
      element.hasAttribute("aria-expanded") ||
      // Workday's own multiselect/autocomplete widget (confirmed live: "How Did You Hear About
      // Us?", "Country Phone Code") — the visible input carries none of the three checks above,
      // just `data-uxi-widget-type="selectinput"` inside a `data-automation-id=
      // "multiSelectContainer"` wrapper. Typing straight into it with nativeSet fills the search
      // box's own text but never registers a real pick in Workday's internal state, so the
      // click-and-select-from-the-rendered-list path is needed here too, same as any other
      // custom combobox.
      Boolean(element.closest('[data-automation-id="multiSelectContainer"], [data-uxi-widget-type="multiselect"]')) ||
      // SmartRecruiters City autocomplete — kept in sync with field-detector.js.
      Boolean(
        element.closest(
          'spl-autocomplete, oc-location-autocomplete, oc-location-autocomplete-wrapper, [data-test="location-autocomplete"]'
        )
      ) ||
      // Workday's plain "Select One" single-pick dropdown - a `<button aria-haspopup="listbox">`
      // with no role="combobox" of its own. Needs the same click-and-select-from-the-rendered-
      // listbox handling as any other custom combobox, not a native-set (which wouldn't even
      // apply to a <button> in the first place).
      (element.tagName === "BUTTON" && element.getAttribute("aria-haspopup") === "listbox") ||
      // Comeet Bootstrap dropdown toggle — kept in sync with field-detector.js.
      (element.tagName === "A" &&
        (element.getAttribute("aria-haspopup") === "true" ||
          element.getAttribute("aria-haspopup") === "listbox" ||
          element.hasAttribute("dropdown-toggle") ||
          element.classList.contains("dropdown-toggle")))
    );
  }

  // See the other copy of this function (in runAutofillInPage, above) for why PointerEvent is
  // now also fired alongside the mouse event sequence.
  function simulateClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    // PointerEvent's own `isPrimary` defaults to false unless explicitly set - a real mouse
    // click always produces isPrimary:true, and a component library built pointer-event-first
    // (confirmed live: BambooHR's "Fabric" design-system Select button - a manual click opens
    // it normally, but this same dispatch sequence silently did nothing) can reasonably gate
    // its own open/activate logic on exactly that check, silently ignoring a pointerdown that
    // reports isPrimary:false as a secondary/synthetic touch point rather than a real click.
    // pointerId/pointerType filled in the same way a genuine mouse-originated pointer event
    // would have them, not left at PointerEventInit's own defaults (pointerId 0, pointerType "").
    const pointerOpts = { ...opts, pointerId: 1, pointerType: "mouse", isPrimary: true };
    if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // Last-resort fallback for a widget whose own JS specifically checks event.isTrusted before
  // reacting (confirmed live: BambooHR's "Fabric" Select component - a real manual click opens
  // its dropdown, but no synthetic dispatchEvent sequence ever does, on this one widget
  // specifically, despite the same simulateClick working correctly on every other site tested).
  // isTrusted can never be set to true by any script, by deliberate browser design - the only
  // way around it is dispatching input at the browser-internals level via the Chrome DevTools
  // Protocol (background.js's TRUSTED_CLICK handler, using chrome.debugger), which Chrome treats
  // as genuinely trusted. Shows a real, unavoidable "this extension started debugging this
  // browser" banner for the brief moment it's attached - only used as an explicit fallback when
  // simulateClick's own (invisible, no-banner) attempt produced no visible effect, never as the
  // default path. Returns false (not throwing) on any failure, so callers can just fall through
  // to reporting the field as unmatched exactly as if this fallback didn't exist.
  function trustedClick(el) {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
          resolve(false);
          return;
        }
        const rect = el.getBoundingClientRect();
        let x = rect.left + rect.width / 2;
        let y = rect.top + rect.height / 2;
        let win = el && el.ownerDocument && el.ownerDocument.defaultView;
        while (win && win !== win.top) {
          const frameEl = win.frameElement;
          if (!frameEl) break;
          const fr = frameEl.getBoundingClientRect();
          x += fr.left;
          y += fr.top;
          win = win.parent;
        }
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          resolve(ok);
        };
        setTimeout(() => finish(false), 600);
        chrome.runtime.sendMessage({ type: "TRUSTED_CLICK", x, y }, (response) => {
          finish(Boolean(response && response.ok));
        });
      } catch {
        resolve(false);
      }
    });
  }

  // Kept in sync with runAutofillInPage — must pierce open shadow roots for SmartRecruiters
  // `<spl-autocomplete>` suggestion rows (see matching comment there).
  function querySelectorAllDeep(selector, root) {
    const out = [];
    const visit = (node) => {
      if (!node || !node.querySelectorAll) return;
      out.push(...node.querySelectorAll(selector));
      for (const el of node.querySelectorAll("*")) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root || document);
    return out;
  }

  function collectVisibleDeep(root) {
    const visible = new Set();
    const visit = (node) => {
      if (!node || !node.querySelectorAll) return;
      for (const el of node.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) visible.add(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root || document);
    return visible;
  }

  function isDisabledComboboxOption(el) {
    if (!el) return true;
    if (el.disabled || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled")) return true;
    if (el.classList && (el.classList.contains("c-spl-dropdown-item--disabled") || el.classList.contains("c-spl-load-more"))) {
      return true;
    }
    const id = `${el.getAttribute("value") || ""} ${el.getAttribute("data-sr-id") || ""} ${el.id || ""}`;
    if (/#spl-no-match|no-match-option|no_match/i.test(id)) return true;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (/^no matches?( found)?$/i.test(text)) return true;
    return false;
  }

  function resolveOptionClickTarget(el) {
    if (!el) return el;
    const optionish =
      (el.closest &&
        el.closest(
          '[role="option"], [role="treeitem"], [role="menuitem"], [class*="__option"], .c-spl-dropdown-item, spl-dropdown-item, a.notBranded, .dropdown-menu li > a, li[id*="react-select"]'
        )) ||
      el;
    if (optionish.matches && optionish.matches(".c-spl-dropdown-item, spl-dropdown-item, [role='option']")) {
      return optionish;
    }
    if (optionish.shadowRoot) {
      const inner = optionish.shadowRoot.querySelector(".c-spl-dropdown-item, spl-dropdown-item, [role='option']");
      if (inner) return inner;
    }
    const host = optionish.closest && optionish.closest("spl-select-option, spl-dropdown-item");
    if (host && host.shadowRoot) {
      const inner = host.shadowRoot.querySelector(".c-spl-dropdown-item, [role='option']");
      if (inner) return inner;
    }
    return optionish;
  }

  async function commitComboboxOption(match, controlEl) {
    const clickEl = resolveOptionClickTarget(match);
    if (!clickEl) return false;
    const desiredText = (match.textContent || "").trim();
    const comboEl = () =>
      (controlEl && controlEl.closest && controlEl.closest('[role="combobox"]')) || controlEl;
    try {
      if (clickEl.scrollIntoView) clickEl.scrollIntoView({ block: "nearest" });
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    simulateClick(clickEl);
    try {
      clickEl.click();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (comboboxValueCommitted(comboEl(), desiredText)) return true;
    if (await trustedClick(clickEl)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (comboboxValueCommitted(comboEl(), desiredText)) return true;
    if (controlEl && controlEl.closest && controlEl.closest(".select-shell")) {
      try {
        clickEl.focus && clickEl.focus();
        for (const type of ["keydown", "keyup"]) {
          clickEl.dispatchEvent(
            new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch {
        /* ignore */
      }
    }
    return comboboxValueCommitted(comboEl(), desiredText);
  }

  // SAP SuccessFactors RCM paginated picklists (`rcmpaginatedselectinput` inside
  // `.sfCascadingPicklist`) — confirmed live on career4.successfactors.com: every screening
  // question is a type-to-filter combobox backed by a hidden `tor__f*` input, not a native
  // <select>. Generic fillReactSelectByClick missed options (no react-select menu) and clicking
  // `fd-input-group--control` was the wrong open target.
  function isSuccessFactorsPicklist(element) {
    return Boolean(
      element &&
        element.classList &&
        (element.classList.contains("rcmpaginatedselectinput") ||
          (element.closest && element.closest(".sfCascadingPicklist, .paginatedPicklistContainer")))
    );
  }

  function successFactorsPicklistOpenTarget(element) {
    const container =
      (element.closest && element.closest(".paginatedPicklistContainer, .sfCascadingPicklist")) || element;
    const button = container.querySelector && container.querySelector(".rcmpaginatedselectbutton");
    return button || element;
  }

  function successFactorsHiddenInput(element) {
    const host = element.closest && element.closest("[id^='picklist_']");
    return host && host.querySelector('input[type="hidden"][id^="tor__"]');
  }

  function successFactorsPicklistAlreadySet(element, desiredText) {
    const title = (element.getAttribute && element.getAttribute("title")) || "";
    const placeholder = (element.getAttribute && element.getAttribute("placeholder")) || "";
    if (!title || /^no\s+selection$/i.test(title.trim()) || title === placeholder) return false;
    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(desiredText);
    const current = norm(title);
    if (!target || !current) return false;
    if (current === target || current.startsWith(target + ":") || current.includes(target)) {
      const hidden = successFactorsHiddenInput(element);
      return !hidden || Boolean(String(hidden.value || "").trim());
    }
    return false;
  }

  function findSuccessFactorsPicklistOptions(element, before) {
    const isVisibleLocal = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const usableText = (text) => {
      const t = (text || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 120) return false;
      if (/^no\s+selection$/i.test(t)) return false;
      if (/one or more results available/i.test(t)) return false;
      if (/press up or down arrow/i.test(t)) return false;
      return !isGenericSelectPlaceholder(t);
    };
    const usable = (el) => {
      if (!el || el === element) return false;
      if (el.tagName === "INPUT" || el.tagName === "BUTTON") return false;
      if (el.classList && el.classList.contains("rcmpaginatedselectinput")) return false;
      if (!isVisibleLocal(el)) return false;
      if (isDisabledComboboxOption(el)) return false;
      return usableText(el.textContent);
    };

    const owns = element.getAttribute && element.getAttribute("aria-owns");
    if (owns) {
      const list = document.getElementById(owns);
      if (list) {
        const opts = [...list.querySelectorAll('[role="option"], tr, li, div, span, a')].filter(
          (el) => usable(el) && (!before || !before.has(el))
        );
        if (opts.length) {
          return opts.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
        }
      }
    }

    const listOpts = [...document.querySelectorAll('[id$="_listSelect"] tr, [id$="_listSelect"] li, [id$="_listSelect"] [role="option"]')].filter(
      (el) => usable(el) && (!before || !before.has(el))
    );
    if (listOpts.length) return listOpts;

    return [];
  }

  // Kept in sync with runAutofillInPage — Greenhouse react-select aria-controls scoping.
  function reactSelectMenuForElement(element) {
    const controlsId = element && element.getAttribute && element.getAttribute("aria-controls");
    if (!controlsId) return null;
    const listbox = document.getElementById(controlsId);
    if (!listbox) return null;
    return listbox.closest('[class*="__menu"]') || listbox;
  }

  function menuBelongsToElement(menu, element) {
    if (!element || !menu) return true;
    const own = reactSelectMenuForElement(element);
    if (!own) return true;
    return menu === own || own.contains(menu) || menu.contains(own);
  }

  function isPhoneCountryListbox(listbox) {
    if (!listbox) return false;
    if (listbox.id && /^iti-/i.test(listbox.id)) return true;
    if (listbox.classList && listbox.classList.contains("iti__country-list")) return true;
    return Boolean(listbox.closest && listbox.closest(".iti, .iti--container"));
  }

  function reactSelectDisplayValue(element) {
    if (isSuccessFactorsPicklist(element)) {
      const title = (element.getAttribute && element.getAttribute("title")) || "";
      const placeholder = (element.getAttribute && element.getAttribute("placeholder")) || "";
      if (title && title !== placeholder && !/^no\s+selection$/i.test(title.trim())) {
        return title.trim();
      }
      return "";
    }
    const control = element && element.closest && element.closest('[class*="__control"]');
    if (!control) return "";
    const single = control.querySelector('[class*="__single-value"]');
    return single && cleanedText(single) ? cleanedText(single) : "";
  }

  function isReactSelectAlreadySet(element, desiredText) {
    if (isSuccessFactorsPicklist(element) && successFactorsPicklistAlreadySet(element, desiredText)) {
      return true;
    }
    const current = reactSelectDisplayValue(element);
    if (!current || isGenericSelectPlaceholder(current)) return false;
    // Greenhouse's phone dial-code picker (see isPhoneDialCodePicker) always commits as a bare
    // "+NN" display (flag + calling code) no matter whether it was picked by typing the code OR
    // the country name - comparing that against a country-name target ("poland") can never find
    // any textual overlap, so every genuinely successful pick on this widget kept reading back
    // as "not committed" here, forcing tryGreenhouseRemixSelect through all 4 fallback tiers
    // every single run even though tier 2's very first click already landed correctly. Confirmed
    // live via console logs showing a real click committed on poll #0 yet still reported failed.
    if (isPhoneDialCodePicker(element) && /^\+\d{1,4}$/.test(current.trim())) return true;
    const target = (desiredText || "").toLowerCase().trim();
    const cur = current.toLowerCase();
    if (!target) return false;
    if (cur === target || cur.startsWith(target + ",") || cur.startsWith(target + " ")) return true;
    return cur.includes(target) || target.includes(cur);
  }

  function greenhouseReactFiberKey(el) {
    return Object.keys(el || {}).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  }

  function findGreenhouseReactSelect(element) {
    const roots = [element];
    const shell = element.closest && element.closest(".select-shell");
    const control = element.closest && element.closest('[class*="__control"]');
    if (shell) roots.push(shell);
    if (control) roots.push(control);
    for (const root of roots) {
      const key = greenhouseReactFiberKey(root);
      if (!key) continue;
      let fiber = root[key];
      while (fiber) {
        const p = fiber.memoizedProps || fiber.pendingProps || {};
        if (typeof p.onChange === "function" && (Array.isArray(p.options) || p.classNamePrefix === "select")) {
          return { onChange: p.onChange, options: p.options || [] };
        }
        if (p.selectProps && typeof p.selectProps.onChange === "function") {
          return { onChange: p.selectProps.onChange, options: p.selectProps.options || [] };
        }
        fiber = fiber.return;
      }
    }
    return null;
  }

  function pickGreenhouseReactOption(rs, desiredText) {
    const want = String(desiredText || "").trim();
    const wantLow = want.toLowerCase();
    const opts = rs.options || [];
    return (
      opts.find((o) => String(o.label || "").trim().toLowerCase() === wantLow) ||
      opts.find((o) => String(o.value ?? "").toString().toLowerCase() === wantLow) ||
      opts.find((o) => {
        const lab = String(o.label || "").trim().toLowerCase();
        return lab && (lab.includes(wantLow) || wantLow.includes(lab));
      }) ||
      null
    );
  }

  function fillGreenhouseViaReactFiber(element, desiredText) {
    if (!element.closest || !element.closest(".select-shell")) return false;
    const rs = findGreenhouseReactSelect(element);
    if (!rs) return false;
    const picked = pickGreenhouseReactOption(rs, desiredText);
    if (!picked) return false;
    try {
      rs.onChange(picked, { action: "select-option", option: picked });
      return comboboxValueCommitted(element, desiredText);
    } catch {
      return false;
    }
  }

  function discoverGreenhouseOptionsFromFiber(element) {
    const rs = findGreenhouseReactSelect(element);
    if (!rs || !rs.options || !rs.options.length) return [];
    const seen = new Set();
    const out = [];
    for (const o of rs.options) {
      const t = String(o.label || o.value || "").trim();
      if (!t || isGenericSelectPlaceholder(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  function comboboxValueCommitted(element, desiredText) {
    if (isSuccessFactorsPicklist(element) && successFactorsPicklistAlreadySet(element, desiredText)) {
      return true;
    }
    if (isReactSelectAlreadySet(element, desiredText)) return true;
    const display = reactSelectDisplayValue(element);
    if (!display || isGenericSelectPlaceholder(display)) return false;
    if (!desiredText) return true;
    const target = (desiredText || "").toLowerCase().trim();
    const cur = display.toLowerCase();
    if (cur === target || cur.startsWith(target + ",") || cur.startsWith(target + " ")) return true;
    return cur.includes(target) || target.includes(cur);
  }

  function comboboxOpenTarget(element) {
    if (isSuccessFactorsPicklist(element)) return successFactorsPicklistOpenTarget(element);
    const control = element.closest && element.closest('[class*="__control"]');
    if (control && element.closest(".select-shell, .select__container")) {
      const toggle = control.querySelector(
        'button[aria-label*="Toggle" i], button[aria-label*="flyout" i], .select__indicators button'
      );
      if (toggle) return toggle;
    }
    return control || element;
  }

  function findComboboxOptions(prefix, before, element = null) {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isFreshAndVisible = (el) => !before.has(el) && isVisible(el) && !isDisabledComboboxOption(el);

    if (element && isSuccessFactorsPicklist(element)) {
      const sfOpts = findSuccessFactorsPicklistOptions(element, before);
      if (sfOpts.length) return sfOpts;
    }

    const ownMenu = element && reactSelectMenuForElement(element);
    if (ownMenu) {
      const scoped = [...ownMenu.querySelectorAll('[class*="__option"], [role="option"]')].filter(isFreshAndVisible);
      if (scoped.length) return scoped;
      if (element.getAttribute("aria-expanded") === "true") return [];
    }

    const srRaw = querySelectorAllDeep(
      "spl-select-option, spl-dropdown-item, .c-spl-dropdown-item, .c-spl-autocomplete-default-option"
    ).filter(isFreshAndVisible);
    if (srRaw.length) {
      const hosts = [];
      const seen = new Set();
      for (const o of srRaw) {
        const clickable = resolveOptionClickTarget(o);
        if (seen.has(clickable) || isDisabledComboboxOption(clickable)) continue;
        if (!isVisible(clickable) && !isVisible(o)) continue;
        seen.add(clickable);
        hosts.push(clickable);
      }
      if (hosts.length) return hosts;
    }

    // Kept in sync with runAutofillInPage's own findComboboxOptions — this copy previously
    // lacked the same-page-multiple-comboboxes freshness check entirely (unscoped
    // document.querySelector, no `before` filtering on tiers 1-2), a real gap since this is
    // the function that actually fills AI-matched/generated answers, not dead code.
    if (prefix) {
      for (const menu of querySelectorAllDeep(`[class*="${prefix}__menu"]`)) {
        if (!menuBelongsToElement(menu, element)) continue;
        const opts = [...menu.querySelectorAll(`[class*="${prefix}__option"]`)].filter(isFreshAndVisible);
        if (opts.length) return opts;
      }
    }
    for (const listbox of querySelectorAllDeep('[role="listbox"], [role="tree"], [role="menu"]')) {
      if (isPhoneCountryListbox(listbox)) continue;
      const opts = [...listbox.querySelectorAll('[role="option"], [role="treeitem"], [role="menuitem"]')].filter(isFreshAndVisible);
      if (opts.length) return opts;
    }
    // Comeet / Bootstrap `dropdown-menu`: options are `<li><a><div class="option-title">…`.
    // No ARIA listbox roles. Prefer the clickable `<a>` (ng-click sets the answer).
    const bootstrapItems = [];
    for (const menu of document.querySelectorAll(".dropdown-menu, [uib-dropdown-menu], ul.dropdown-menu")) {
      for (const a of menu.querySelectorAll("li a, a.notBranded")) {
        if (!isFreshAndVisible(a) || isDisabledComboboxOption(a)) continue;
        const text = (a.textContent || "").trim();
        if (!text || text.length > 80) continue;
        bootstrapItems.push(a);
      }
    }
    if (bootstrapItems.length) return bootstrapItems;
    const anyOptionRole = querySelectorAllDeep('[role="option"], [role="treeitem"], [role="menuitem"]').filter(isFreshAndVisible);
    if (anyOptionRole.length) return anyOptionRole;
    return querySelectorAllDeep("li, div, span, button").filter((el) => {
      if (before.has(el)) return false;
      if (el.closest && el.closest(".iti, .iti--container")) return false;
      if (el.children.length > 2) return false;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 80) return false;
      return isVisible(el) && !isDisabledComboboxOption(el);
    });
  }

  function findFreshFilterInput(before, excludeEl) {
    const candidates = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')];
    return (
      candidates.find((el) => {
        if (el === excludeEl || before.has(el)) return false;
        // A react-select build can render its own hidden native-validation proxy input right
        // alongside the real one - confirmed live on Greenhouse's "remix" flavor:
        // `<input required="" tabindex="-1" aria-hidden="true" class="...requiredInput"
        // value="">`, no `type` attribute at all, so it matches this same candidate selector.
        // Without excluding it, this proxy can get mistaken for the field's own fresh filter
        // box - the desired text gets typed into an invisible, non-functional decoy instead of
        // the field the user actually sees, leaving the REAL input (and the option search that
        // depends on it) never actually triggered, silently, with no error and no visible typed
        // text anywhere on the page. `rect.width <= 1 || rect.height <= 1` (not just `> 0`)
        // catches the same near-zero-but-technically-nonzero decoy sizing already handled
        // elsewhere (field-detector.js's isVisible has the identical guard, for the same reason).
        if (el.getAttribute("aria-hidden") === "true" || (el.closest && el.closest('[aria-hidden="true"]'))) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      }) || null
    );
  }

  async function fillReactSelectByClick(element, desiredText) {
    // Diagnostic only (temporary, not a fix): the previous fix (closing this widget down after
    // its own commit) did NOT stop the phone/country picker from being changed by a LATER field's
    // own retry - meaning either (a) some GLOBAL keyboard-routing mechanism is still delivering a
    // later field's own ArrowDown presses to this widget despite it being closed, or (b) the
    // LATER field's own fillReactSelectByClick call is somehow being handed THIS widget's element
    // directly (a stale/colliding data-af-idx stamp resolving to the wrong DOM node, same shape
    // as the earlier findElementByLabel bug) rather than its own intended element. Logging the
    // actual element identity (id + whether it's inside .phone-input__country) every call tells
    // these two apart directly instead of guessing again.
    if (element && element.closest && element.closest(".phone-input__country")) {
      console.warn(
        `[Auto Fill][phone-watch] fillReactSelectByClick called on the COUNTRY PICKER itself with desiredText="${desiredText}" (element id="${element.id || ""}")`
      );
    }
    if (isSuccessFactorsPicklist(element) && successFactorsPicklistAlreadySet(element, desiredText)) {
      return true;
    }
    if (isReactSelectAlreadySet(element, desiredText)) return true;
    if (element.closest && element.closest(".select-shell") && fillGreenhouseViaReactFiber(element, desiredText)) {
      return true;
    }
    const sfPick = isSuccessFactorsPicklist(element);
    const controlEl = comboboxOpenTarget(element);
    const prefixMatch = !sfPick && controlEl && controlEl.className.match(/(\S+)__control\b/);
    const prefix = prefixMatch ? prefixMatch[1] : null;
    function findGreenhouseMenuOptions(el) {
      if (!el || !el.closest) return [];
      const isVisibleLocal = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const collect = (root) => {
        if (!root) return [];
        return [...root.querySelectorAll(
          '.select__option, [class*="__option"], [role="option"], [id*="-option-"]'
        )].filter((node) => isVisibleLocal(node) && !isDisabledComboboxOption(node));
      };
      const shell = el.closest(".select-shell");
      if (shell) {
        const inShell = collect(shell);
        if (inShell.length) return inShell;
      }
      const ownMenu = reactSelectMenuForElement(el);
      if (ownMenu) {
        const scoped = collect(ownMenu);
        if (scoped.length) return scoped;
      }
      const controlsId = el.getAttribute && el.getAttribute("aria-controls");
      if (controlsId) {
        const listbox = document.getElementById(controlsId);
        if (listbox) {
          const scoped = collect(listbox);
          if (scoped.length) return scoped;
        }
      }
      // Live Greenhouse remix react-select portals menus to document.body — offline HTML
      // fixtures inject menus inside .select-shell, so jsdom tests miss this gap.
      if (el.getAttribute && el.getAttribute("aria-expanded") === "true") {
        const comboId = el.id || "";
        if (comboId) {
          try {
            const idOpts = [...document.querySelectorAll(`[id^="react-select-${CSS.escape(comboId)}-option-"]`)].filter(
              (node) => isVisibleLocal(node) && !isDisabledComboboxOption(node)
            );
            if (idOpts.length) return idOpts;
          } catch {
            /* ignore */
          }
        }
        const portaled = [];
        for (const menu of document.querySelectorAll(
          '[class*="__menu"], [class*="-menu"], [class*="menu-list"], .select__menu'
        )) {
          const rect = menu.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          portaled.push(...collect(menu));
        }
        if (portaled.length) return portaled;
        const live = [...document.querySelectorAll(
          '.select__option, [class*="__option"], [role="option"], [id*="-option-"]'
        )].filter((node) => isVisibleLocal(node) && !isDisabledComboboxOption(node));
        if (live.length) return live;
      }
      return [];
    }
    function comboboxExpanded(el, control) {
      const combo = el && el.getAttribute && el.getAttribute("role") === "combobox" ? el : null;
      const fromCombo = combo && combo.getAttribute("aria-expanded") === "true";
      const fromControl = control && control.getAttribute && control.getAttribute("aria-expanded") === "true";
      return Boolean(fromCombo || fromControl);
    }
    async function tryGreenhouseRemixSelect(element, desiredText, control, isUnusableOptionText) {
      // Diagnostic-only step/attempt logging - explicitly requested, to see WHY this takes
      // several fallback tiers instead of committing on the first one. Tagged per call with the
      // desired text so parallel/sequential attempts (e.g. dial-code retry then country-name
      // retry) can be told apart in the console.
      const tag = `[Auto Fill][combobox-retry "${desiredText}"]`;
      if (!element.closest || !element.closest(".select-shell")) return false;
      const fiberOk = fillGreenhouseViaReactFiber(element, desiredText);
      console.info(`${tag} tier 1 (React fiber direct) -> ${fiberOk ? "COMMITTED" : "no match/failed"}`);
      if (fiberOk) return true;
      const norm = (s) => (s || "").toLowerCase().trim();
      const target = norm(desiredText);
      if (!target) return false;
      const greenhouseToggle = () => {
        const shell = element.closest(".select-shell");
        return (
          (shell &&
            shell.querySelector('button[aria-label*="Toggle" i], button[aria-label*="flyout" i]')) ||
          control ||
          element
        );
      };
      const dispatchKey = (key) => {
        const init = { key, code: key, bubbles: true, cancelable: true };
        element.dispatchEvent(new KeyboardEvent("keydown", init));
        element.dispatchEvent(new KeyboardEvent("keyup", init));
      };
      const liveOptions = () =>
        findGreenhouseMenuOptions(element).filter((o) => !isUnusableOptionText(o.textContent));
      const matchOption = (options) => {
        if (!options.length) return null;
        return (
          options.find((o) => norm(o.textContent) === target) ||
          options.find((o) => norm(o.textContent).startsWith(target + ",") || norm(o.textContent).startsWith(target + " ")) ||
          options.find((o) => norm(o.textContent).startsWith(target)) ||
          options.find((o) => norm(o.textContent).includes(target) || target.includes(norm(o.textContent))) ||
          (/^(yes|no)$/i.test(target) && options.find((o) => norm(o.textContent) === target)) ||
          (/^(yes|agree|accept|i agree)$/i.test(target) &&
            options.find(
              (o) => /agree|accept|consent/i.test(norm(o.textContent)) && !/do not|don't|decline|not agree/i.test(norm(o.textContent))
            )) ||
          null
        );
      };
      const ensureOpen = async () => {
        if (comboboxExpanded(element, control)) return true;
        const toggle = greenhouseToggle();
        element.focus();
        // Live GH remix react-select ignores synthetic opens — trusted-click the flyout toggle first.
        if (await trustedClick(toggle)) {
          await new Promise((resolve) => setTimeout(resolve, 280));
          if (comboboxExpanded(element, control)) return true;
        }
        simulateClick(toggle);
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (comboboxExpanded(element, control)) return true;
        dispatchKey("ArrowDown");
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (comboboxExpanded(element, control)) return true;
        if (!comboboxExpanded(element, control) && (await trustedClick(toggle))) {
          await new Promise((resolve) => setTimeout(resolve, 220));
        }
        return comboboxExpanded(element, control);
      };
      const opened = await ensureOpen();
      console.info(`${tag} tier 2 open (click/keyboard toggle) -> ${opened ? "opened" : "FAILED to open"}`);
      if (!opened) return false;
      let pollMatchedAt = null;
      for (let poll = 0; poll < 10; poll++) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        const match = matchOption(liveOptions());
        if (!match) continue;
        pollMatchedAt = poll;
        if (await commitComboboxOption(match, control || element)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (comboboxValueCommitted(element, desiredText)) {
            console.info(`${tag} tier 2 click-poll -> COMMITTED (found match on poll #${poll})`);
            return true;
          }
        }
      }
      console.info(
        `${tag} tier 2 click-poll -> no committed match after 10 polls (~0.6s)${pollMatchedAt !== null ? ` (matched text on poll #${pollMatchedAt} but commit/verify failed)` : ""}`
      );
      element.focus();
      await ensureOpen();
      const seen = new Set();
      let keyboardSteps = 0;
      for (let step = 0; step < 8; step++) {
        keyboardSteps = step + 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const activeId = element.getAttribute("aria-activedescendant");
        const activeNode = activeId && element.ownerDocument.getElementById(activeId);
        const text = activeNode ? norm(activeNode.textContent) : "";
        if (text) {
          if (seen.has(text) && step > seen.size + 2) break;
          seen.add(text);
          if (text === target || text.includes(target) || target.includes(text)) {
            dispatchKey("Enter");
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (comboboxValueCommitted(element, desiredText)) {
              console.info(`${tag} tier 3 keyboard-nav -> COMMITTED (matched "${text}" after ${keyboardSteps} ArrowDown step(s))`);
              return true;
            }
          }
        }
        if (!comboboxExpanded(element, control)) break;
        // Diagnostic only (temporary, not a fix): dispatchKey fires KeyboardEvents directly ON
        // `element` via dispatchEvent(), but that's not the same thing as REAL browser focus -
        // if Greenhouse's own app routes keyboard nav based on document.activeElement (a common
        // pattern for widget libraries that add their own document-level listener rather than
        // relying purely on React's per-component event target routing) rather than the event's
        // dispatch target, these ArrowDown presses could land on WHATEVER actually holds real
        // focus regardless of which element we dispatched them on - a live candidate for how the
        // phone/country picker keeps changing during a completely different field's own retry,
        // given #94 already ruled out fillReactSelectByClick being called on the wrong element
        // directly. Logging only on mismatch to avoid noise when focus is exactly where expected.
        if (document.activeElement !== element) {
          const ae = document.activeElement;
          console.warn(
            `${tag} tier 3 step ${keyboardSteps}: document.activeElement is NOT this element before ArrowDown (actual: ${ae ? `${ae.tagName}#${ae.id || ""}.${ae.className || ""}` : "null"})`
          );
        }
        dispatchKey("ArrowDown");
      }
      console.info(
        `${tag} tier 3 keyboard-nav -> no committed match after ${keyboardSteps} step(s), saw: [${[...seen].join(", ")}]`
      );
      // Type-to-filter + pick (confirmed live GH remix: sponsorship Yes/No, experience levels).
      element.focus();
      await ensureOpen();
      nativeSet(element, String(desiredText).trim());
      await new Promise((resolve) => setTimeout(resolve, 400));
      const typedMatch = matchOption(liveOptions());
      if (typedMatch && (await commitComboboxOption(typedMatch, control || element))) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (comboboxValueCommitted(element, desiredText)) {
          console.info(`${tag} tier 4 type-to-filter -> COMMITTED (typed "${desiredText}", matched "${typedMatch.textContent.trim()}")`);
          return true;
        }
      }
      // No real option anywhere in THIS field's own list ever matched desiredText - blindly
      // pressing Enter anyway (the previous behavior) left the widget holding non-matching
      // typed text, with nothing committed, still open/focused in some undefined state.
      // Confirmed live: this is exactly what let a LATER, unrelated field's own keyboard/focus
      // activity leak into and corrupt a DIFFERENT widget's already-correct value afterward
      // (reported live as the phone/country picker silently changing minutes after a completely
      // unrelated question's own combobox retried and failed the exact same way - e.g. a
      // "60000 EUR" answer mistakenly aimed at a Yes/No field). Closing cleanly here - Escape,
      // clear the typed text, blur - instead of leaving things ambiguous removes that whole
      // class of risk, regardless of WHY the mismatch happened in the first place. Not
      // preventing the mismatched answer itself (a genuinely wrong answer should still leave
      // this ONE field for the user, not silently corrupt some OTHER, unrelated field too).
      const escapeInit = { key: "Escape", code: "Escape", bubbles: true, cancelable: true };
      element.dispatchEvent(new KeyboardEvent("keydown", escapeInit));
      element.dispatchEvent(new KeyboardEvent("keyup", escapeInit));
      nativeSet(element, "");
      element.blur();
      await new Promise((resolve) => setTimeout(resolve, 100));
      console.info(`${tag} tier 4 type-to-filter -> FAILED - no matching option anywhere, closed cleanly instead of leaving it ambiguous`);
      return false;
    }
    // "Fresh" means "was not VISIBLE before this click", not "was not PRESENT in the DOM before
    // this click" - those aren't the same thing, and conflating them was confirmed live to break
    // a Homerun-style ATS "select all that apply" dropdown: its option buttons are already
    // sitting in the DOM at page load, just CSS-hidden (a plain `hidden` class hiding the whole
    // menu, no lazy mount-on-open at all), so a presence-based snapshot already contains them
    // before the click - every one then reads as "not fresh" and gets excluded by
    // findComboboxOptions, leaving zero options found even though the menu genuinely opened.
    // Snapshotting visibility instead of mere presence still correctly excludes anything that
    // really was already open/visible (the original problem this snapshot was built to solve -
    // an earlier field's stale, already-open menu), while no longer wrongly excluding options
    // that were present-but-invisible and only just became visible. Pierces open shadow roots
    // so SmartRecruiters suggestion rows aren't treated as "always fresh" noise either.
    const before = collectVisibleDeep(document);
    // Classify before open so each step can use a different budget (kept in sync with
    // runAutofillInPage): location long after-type; country medium; other short.
    const labelIds = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const labelFromIds = labelIds
      .map((id) => {
        const node = document.getElementById(id);
        return node ? (node.textContent || "").replace(/\s+/g, " ").trim() : "";
      })
      .filter(Boolean)
      .join(" ");
    const fieldHint = [
      labelFromIds,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("name"),
      element.id,
      controlEl && controlEl.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ");
    const isLocationAutocomplete = Boolean(
      (element.closest &&
        element.closest(
          'spl-autocomplete, oc-location-autocomplete, oc-location-autocomplete-wrapper, [data-test="location-autocomplete"]'
        )) ||
        /location|city|where (are|do) you|place of residence|current (city|location)/i.test(fieldHint)
    );
    const isCountryOrPhonePicker = Boolean(
      (element.closest && element.closest(".iti, crux-phone-component, [class*='phone-input'], [class*='PhoneInput']")) ||
        /^(country|nationality)\b|\b(dial|calling|phone)\s*code\b|\bcountry\s*code\b/i.test(fieldHint)
    );
    const isGreenhouseSelect = Boolean(element.closest && element.closest(".select-shell"));
    // Original working ~0.5s profile (kept in sync with runAutofillInPage).
    const hasAriaListbox = Boolean(element.getAttribute && element.getAttribute("aria-controls"));
    const pace = sfPick
      ? { open: 200, preType: 100, typeHead: 400, poll: 120, stable: 3, maxPolls: 50, trustedRetry: 25 }
      : isLocationAutocomplete
      ? {
          open: 120,
          preType: 80,
          typeHead: hasAriaListbox ? 600 : 450,
          poll: hasAriaListbox ? 150 : 120,
          stable: 3,
          maxPolls: hasAriaListbox ? 60 : 50,
          trustedRetry: hasAriaListbox ? 30 : 25,
        }
      : isCountryOrPhonePicker
        ? { open: 150, preType: 80, typeHead: 280, poll: 100, stable: 2, maxPolls: 40, trustedRetry: 15 }
        : isGreenhouseSelect && !hasAriaListbox
          ? { open: 200, preType: 100, typeHead: 350, poll: 120, stable: 2, maxPolls: 55, trustedRetry: 30 }
        : hasAriaListbox
          ? { open: 120, preType: 80, typeHead: 300, poll: 100, stable: 2, maxPolls: 45, trustedRetry: 20 }
          : { open: 120, preType: 80, typeHead: 200, poll: 80, stable: 2, maxPolls: 40, trustedRetry: 15 };

    const isUnusableOptionText = (text) => {
      const t = (text || "").trim();
      if (!t) return true;
      return /^(loading(\.{0,3}|…)?|searching(\.{0,3}|…)?|no options?( found)?|no matches?( found)?|type to search|start typing)/i.test(t);
    };

    const isGreenhouseSearchable =
      isLocationAutocomplete ||
      isCountryOrPhonePicker ||
      /current country|country of residence|current residence|\bresidence\b|\bstate\b|location\s*\(city\)/i.test(fieldHint);
    if (isGreenhouseSelect) {
      if (await tryGreenhouseRemixSelect(element, desiredText, controlEl, isUnusableOptionText)) {
        return true;
      }
      if (!isGreenhouseSearchable) {
        element.blur();
        return false;
      }
    }

    simulateClick(controlEl || element);
    element.focus();
    await new Promise((resolve) => setTimeout(resolve, pace.open));
    if (
      isGreenhouseSelect &&
      !findComboboxOptions(prefix, before, element).length &&
      !findGreenhouseMenuOptions(element).length
    ) {
      if (!comboboxExpanded(element, controlEl)) {
        await trustedClick(controlEl || element);
      }
      await new Promise((resolve) => setTimeout(resolve, pace.poll * 3));
    }

    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(desiredText);
    const textOf = (o) => norm((o.textContent || "").trim());
    const isGreenhouseStatic =
      isGreenhouseSelect && !isLocationAutocomplete && !isCountryOrPhonePicker && !hasAriaListbox;
    const readOpenOptions = () => {
      const fromFresh = findComboboxOptions(prefix, before, element).filter(
        (o) => !isUnusableOptionText(o.textContent)
      );
      if (fromFresh.length) return fromFresh;
      return findGreenhouseMenuOptions(element).filter((o) => !isUnusableOptionText(o.textContent));
    };
    const matchOpenOption = (options) => {
      if (!options.length) return null;
      return (
        options.find((o) => textOf(o) === target) ||
        options.find((o) => textOf(o).startsWith(target + ",") || textOf(o).startsWith(target + " ")) ||
        options.find((o) => textOf(o).startsWith(target)) ||
        options.find((o) => textOf(o).includes(target) || target.includes(textOf(o))) ||
        (/^(yes|agree|accept|i agree)$/i.test(target) &&
          options.find((o) => /agree|accept|consent/i.test(textOf(o)) && !/do not|don't|decline|not agree/i.test(textOf(o)))) ||
        null
      );
    };
    const tryDirectOptionPick = async (maxAttempts) => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, pace.poll));
        const match = matchOpenOption(readOpenOptions());
        if (!match) continue;
        if (await commitComboboxOption(match, controlEl || element)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return comboboxValueCommitted(element, desiredText);
        }
      }
      return false;
    };
    if (/^(yes|no)$/i.test(String(desiredText).trim()) || isGreenhouseStatic) {
      if (await tryDirectOptionPick(isGreenhouseStatic ? pace.maxPolls : 15)) return true;
      if (isGreenhouseStatic) {
        element.blur();
        return false;
      }
    }

    // A "select all that apply" combobox (aria-multiselectable="true" - confirmed live on a
    // Homerun-style ATS dropdown-trigger widget backing a real, hidden checkbox group) needs
    // EVERY matching option clicked, not just the first. Its options are a fixed, already-
    // rendered list rather than a filtered autocomplete, so typing the whole joined answer into
    // a filter box (the single-select path below) would be meaningless - there usually isn't one
    // - so this skips straight to finding and clicking each match in turn instead. Options are
    // re-queried fresh on every iteration rather than reusing one snapshot, since some widgets
    // re-render an option after picking it (e.g. to add a checkmark), which would make a stale
    // element reference from an earlier query go silently inert on the next click.
    if (element.getAttribute("aria-multiselectable") === "true") {
      const targets = String(desiredText)
        .split(/[,;]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!targets.length) {
        element.blur();
        return false;
      }
      let options = [];
      // Same widened budget as the single-select path below (10 -> 30 attempts) for
      // consistency - a fixed "select all that apply" list usually renders fast, but there's no
      // strong reason to give it a shorter window than everything else, and polling still stops
      // the moment options actually appear either way.
      for (let attempt = 0; attempt < 30 && !options.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        options = findComboboxOptions(null, before, element);
      }
      if (!options.length) {
        element.blur();
        return false;
      }
      let allMatched = true;
      for (const target of targets) {
        const current = findComboboxOptions(null, before, element);
        let match = current.find((o) => (o.textContent || "").toLowerCase().trim() === target);
        if (!match) {
          match = current.find(
            (o) => (o.textContent || "").toLowerCase().trim().includes(target) || target.includes((o.textContent || "").toLowerCase().trim())
          );
        }
        if (!match) {
          allMatched = false;
          continue;
        }
        await commitComboboxOption(match, controlEl || element);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      element.blur();
      return allMatched;
    }

    await new Promise((resolve) => setTimeout(resolve, pace.preType));
    const filterInput = findFreshFilterInput(before, element);
    // Type-to-search autocomplete where the clicked control itself is the search box (e.g.
    // Ashby's "Location" field) — nothing renders until you type. Kept in sync with
    // runAutofillInPage's own fillReactSelectByClick.
    const typedInto = filterInput || (element.tagName === "INPUT" || element.tagName === "TEXTAREA" ? element : null);
    if (typedInto) nativeSet(typedInto, desiredText);

    // Kept in sync with runAutofillInPage - a rejected match must not leave the typed search
    // text and an open "No options" menu behind (see the matching comment there). Also the
    // async location stabilize/pick logic below.
    const revertTypedFilter = () => {
      if (typedInto) nativeSet(typedInto, "");
      element.blur();
    };

    // Kept in sync with runAutofillInPage pace profiles.
    const typeHeadStartMs = typedInto ? pace.typeHead : Math.min(40, pace.typeHead);
    const pollMs = pace.poll;
    const stableNeeded = pace.stable;
    const readUsableOptions = () => {
      const fromFresh = findComboboxOptions(prefix, before, element).filter(
        (o) => !isUnusableOptionText(o.textContent)
      );
      if (fromFresh.length) return fromFresh;
      if (isGreenhouseSelect) {
        return findGreenhouseMenuOptions(element).filter((o) => !isUnusableOptionText(o.textContent));
      }
      return fromFresh;
    };
    const menuStillLoading = () => {
      const el = document.querySelector(
        '[class*="__loadingIndicator"], [class*="__loading-indicator"], [class*="loading-indicator"]'
      );
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const waitForStableOptions = async (maxAttempts) => {
      if (typeHeadStartMs) {
        await new Promise((resolve) => setTimeout(resolve, typeHeadStartMs));
      }
      let options = [];
      let lastSig = "";
      let stableReads = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (menuStillLoading()) {
          lastSig = "";
          stableReads = 0;
          options = [];
          continue;
        }
        const found = readUsableOptions();
        if (!found.length) {
          lastSig = "";
          stableReads = 0;
          options = [];
          continue;
        }
        const sig = found.map((o) => (o.textContent || "").trim()).join("\0");
        if (sig === lastSig) {
          stableReads += 1;
          options = found;
          if (stableReads >= stableNeeded) return options;
        } else {
          lastSig = sig;
          stableReads = 1;
          options = found;
        }
      }
      return options;
    };

    let options = await waitForStableOptions(pace.maxPolls);
    if (!options.length) {
      if (!comboboxExpanded(element, controlEl) && (await trustedClick(controlEl || element))) {
        if (typedInto) nativeSet(typedInto, desiredText);
        options = await waitForStableOptions(pace.trustedRetry);
      } else if (comboboxExpanded(element, controlEl)) {
        options = await waitForStableOptions(Math.min(20, pace.trustedRetry));
      }
    }
    if (!options.length) {
      revertTypedFilter();
      return false;
    }

    // Learn/AI fill path has no profile in scope — matching still prefers "City, …" form.
    let match = options.find((o) => textOf(o) === target);
    if (!match) {
      const starts = options.filter((o) => {
        const t = textOf(o);
        return t.startsWith(target + ",") || t.startsWith(target + " ");
      });
      if (starts.length) match = starts[0];
    }
    if (!match) {
      match = options.find((o) => textOf(o).includes(target) || target.includes(textOf(o))) || null;
    }
    if (!match && /^(yes|agree|accept|i agree)$/i.test(target)) {
      match = options.find((o) => {
        const t = textOf(o);
        return /agree|accept|consent/i.test(t) && !/do not|don't|decline|not agree/i.test(t);
      });
    }
    // Kept in sync with runAutofillInPage — SmartRecruiters location autocomplete: click first
    // suggestion when nothing matched more specifically.
    if (
      !match &&
      options.length &&
      element.closest &&
      element.closest(
        'spl-autocomplete, oc-location-autocomplete, oc-location-autocomplete-wrapper, [data-test="location-autocomplete"]'
      )
    ) {
      match = options[0];
    }
    if (!match) {
      revertTypedFilter();
      return false;
    }
    await commitComboboxOption(match, controlEl || element);
    return comboboxValueCommitted(element, desiredText);
  }

  let count = 0;
  // Prefer stamped nodes from the first Auto Fill pass. If the apply drawer remounted
  // (Workable Evergreen dialog closes + reopens), those data-af-idx attributes are gone —
  // re-find by question label when field-detector globals are still on the page.
  // Greenhouse's phone widget has its own dial-code sub-picker labeled bare "Country" (see
  // matchStructuredField's same-named guard elsewhere) - a genuinely DIFFERENT "Country"
  // question (residence, nationality...) on the same form shares that exact label text.
  // Missing this guard here (this copy has no idea phone-dial-code pickers even exist) let a
  // GPT-generated residence-country answer whose ORIGINAL stamped element had gone stale (e.g.
  // after a React re-render elsewhere on the page) fall back to this label-text lookup, match
  // the bare "Country" label, and land on the phone widget instead - confirmed live: an already-
  // correctly-set dial code (e.g. Poland) got silently overwritten with a different, GPT-guessed
  // country well after the rest of the batch had already filled, non-deterministically per run
  // since the residence-country answer itself varies run to run.
  function isPhoneDialCodePicker(element) {
    return Boolean(element && element.closest && element.closest(".phone-input__country"));
  }

  function findElementByLabel(label) {
    if (!label || typeof collectFormFields !== "function" || typeof labelForElement !== "function") return null;
    const norm = (t) =>
      (t || "")
        .toLowerCase()
        .replace(/\s+\d+\/\d+$/, "")
        .replace(/\s+/g, " ")
        .trim();
    const want = norm(label);
    if (!want) return null;
    const asksAboutPhoneCode = /\b(dial|calling|phone)\s*code\b|\bcountry\s*code\b/i.test(label);
    const rejectPhoneDialCode = (el) => el && !asksAboutPhoneCode && isPhoneDialCodePicker(el);
    const labelMatches = (text) => {
      const got = norm(text);
      if (!got) return false;
      if (got === want) return true;
      return got.replace(/\*+$/, "").trim() === want || want.replace(/\*+$/, "").trim() === got.replace(/\*+$/, "").trim();
    };
    const greenhouseComboboxIn = (scope) => {
      if (!scope || !scope.querySelector) return null;
      return (
        scope.querySelector('[role="combobox"]') ||
        scope.querySelector("input.select__input") ||
        scope.querySelector(".select__input")
      );
    };
    // Prefer a prior stamp's label attribute — survives DOM remounts better than re-detection.
    const stamped = [...document.querySelectorAll("[data-af-label]")].find((el) => norm(el.getAttribute("data-af-label")) === want);
    if (stamped && !rejectPhoneDialCode(stamped)) return stamped;
    // Greenhouse remix react-select: label[for] → id on wrapper, combobox is a nested input.
    try {
      for (const lab of document.querySelectorAll("label[for]")) {
        if (!labelMatches(lab.textContent)) continue;
        const forId = lab.getAttribute("for");
        if (!forId) continue;
        const byId = document.getElementById(forId);
        if (!byId || rejectPhoneDialCode(byId)) continue;
        if (looksLikeComboboxPick(byId)) return byId;
        const fromWrapper = greenhouseComboboxIn(byId.closest(".field-wrapper") || byId.parentElement);
        if (fromWrapper && !rejectPhoneDialCode(fromWrapper)) return fromWrapper;
        return byId;
      }
      for (const wrapper of document.querySelectorAll(".field-wrapper")) {
        const lab = wrapper.querySelector("label");
        if (!lab || !labelMatches(lab.textContent)) continue;
        const combo = greenhouseComboboxIn(wrapper);
        if (combo && !rejectPhoneDialCode(combo)) return combo;
      }
    } catch {
      /* ignore */
    }
    try {
      const { groups, singles, loneCheckboxes } = collectFormFields();
      for (const g of groups) {
        if (norm(g.label) === want && g.options && g.options[0]) return g.options[0].element;
      }
      for (const { element, host } of [...singles, ...loneCheckboxes]) {
        if (norm(labelForElement(element, host || element)) === want && !rejectPhoneDialCode(element)) return element;
      }
      // Last resort: prefix match when labels differ only by trailing counter noise.
      for (const g of groups) {
        const gl = norm(g.label);
        if ((gl.startsWith(want) || want.startsWith(gl)) && g.options && g.options[0]) return g.options[0].element;
      }
      for (const { element, host } of [...singles, ...loneCheckboxes]) {
        const got = norm(labelForElement(element, host || element));
        if (got && (got.startsWith(want) || want.startsWith(got)) && !rejectPhoneDialCode(element)) return element;
      }
    } catch {
      return null;
    }
    return null;
  }

  function resolveFillTarget(element) {
    if (!element) return null;
    if (looksLikeComboboxPick(element)) return element;
    const shell = element.closest && element.closest(".select-shell, .select__container");
    if (shell) {
      const combo =
        shell.querySelector('[role="combobox"]') ||
        shell.querySelector("input.select__input") ||
        shell.querySelector(".select__input");
      if (combo) return combo;
    }
    if (element.getAttribute && element.getAttribute("aria-hidden") === "true") {
      const wrapper = element.closest && element.closest(".field-wrapper");
      const combo = wrapper && wrapper.querySelector('[role="combobox"], input.select__input');
      if (combo) return combo;
    }
    return element;
  }

  function textInputCommitted(element, value) {
    const want = String(value == null ? "" : value).trim();
    if (!want) return false;
    if (element.isContentEditable) {
      return String(element.textContent || "").trim() === want;
    }
    return String(element.value || "").trim() === want;
  }

  for (const { idx, value, label } of answers) {
    let el = document.querySelector(`[data-af-idx="${idx}"]`);
    if (!el && label) {
      el = findElementByLabel(label);
      if (el) {
        el.setAttribute("data-af-idx", String(idx));
        el.setAttribute("data-af-label", label);
      }
    }
    if (!el) continue;
    // Confirmed live: an exception thrown anywhere in ONE field's fill logic below (a
    // Greenhouse combobox interaction, in particular - see fillReactSelectByClick's own
    // React-Fiber/trusted-click/keyboard-nav fallbacks) used to propagate uncaught out of this
    // whole loop, aborting it immediately and losing credit for every field already
    // successfully filled earlier in the SAME batch, not just the one that failed - since
    // `count` is only ever returned at the very end, after the loop fully completes. Reported
    // live as "GPT generated all answers, but nothing got filled" right after a select box
    // visibly opened and closed - exactly this shape. Catching per-item means one bad field
    // can no longer sacrifice the rest of the batch's results.
    try {
      el = resolveFillTarget(el) || el;
      const tag = el.tagName.toLowerCase();
      let ok = true;
    if (tag === "select") {
      ok = setSelectValue(el, value);
    } else if (
      el.type === "radio" ||
      (el.type === "checkbox" && el.name) ||
      (el.getAttribute && el.getAttribute("role") === "radio" && (el.name || el.getAttribute("name")))
    ) {
      // Grouped radios/checkboxes: the stamped node is one option; pick the sibling(s) whose
      // label matches the AI/QA answer. Checkbox groups may be multi-select — answer can be
      // "GRPC, RabbitMQ" (Zoho screening). Confirmed live: previously only the first fuzzy
      // peer was checked, so "select all that apply" never got more than one tick.
      const groupName = el.name || el.getAttribute("name");
      const inputType = el.type === "checkbox" ? "checkbox" : "radio";
      const peers = groupName
        ? [
            ...document.querySelectorAll(`input[type="${inputType}"][name="${CSS.escape(groupName)}"]`),
            ...(inputType === "radio"
              ? [...document.querySelectorAll(`spl-radio[name="${CSS.escape(groupName)}"]`)]
              : []),
          ]
        : [el];
      const labelOf = (p) => {
        if (p.tagName === "SPL-RADIO") {
          const lab = (p.getAttribute("label") || "").trim();
          if (lab) return lab;
        }
        // Prefer Zoho lyte-checkbox lt-prop-label / aria-labelledby raw text (aria-hidden
        // option labels), same as collectRadioCheckboxGroups — labelForElement alone often
        // climbs to the question title for every peer.
        const lyte = p.closest && p.closest("lyte-checkbox");
        if (lyte) {
          const prop = (lyte.getAttribute("lt-prop-label") || "").trim();
          if (prop) return prop;
        }
        // Comeet: `.option-title` holds Yes / I consent / …
        const optTitle =
          (p.closest && p.closest("li") && p.closest("li").querySelector(".option-title")) ||
          (p.parentElement && p.parentElement.querySelector(".option-title"));
        if (optTitle) {
          const t = (optTitle.textContent || "").replace(/\s+/g, " ").trim();
          if (t) return t;
        }
        const labelledby = p.getAttribute && p.getAttribute("aria-labelledby");
        if (labelledby) {
          const raw = labelledby
            .split(/\s+/)
            .map((id) => {
              const node = document.getElementById(id);
              return node ? (node.textContent || "").trim() : "";
            })
            .filter(Boolean)
            .join(" ");
          if (raw) return raw;
        }
        return (typeof labelForElement === "function" ? labelForElement(p, p) : "") || "";
      };
      const parts = String(value)
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const targets = parts.length ? parts : [String(value).trim()];
      let any = false;
      for (const targetRaw of targets) {
        const target = targetRaw.toLowerCase();
        let peer =
          peers.find((p) => labelOf(p).toLowerCase() === target) ||
          peers.find((p) => {
            const lab = labelOf(p).toLowerCase();
            return lab.includes(target) || target.includes(lab);
          });
        if (!peer && /^(yes|true|y)$/i.test(targetRaw)) {
          peer = peers.find((p) => /yes/i.test(labelOf(p))) || el;
        } else if (!peer && /^(no|false|n)$/i.test(targetRaw)) {
          peer = peers.find((p) => /^no$/i.test(labelOf(p).trim())) || null;
        }
        if (peer) {
          const peerLabel =
            peer.tagName === "SPL-RADIO"
              ? null
              : (peer.id &&
                  (() => {
                    try {
                      return document.querySelector(`label[for="${CSS.escape(peer.id)}"]`);
                    } catch {
                      return null;
                    }
                  })()) ||
                (peer.closest && peer.closest("li") && peer.closest("li").querySelector("label.checkboxLabel, label"));
          if (peer.tagName === "SPL-RADIO") peer.click();
          else if (peerLabel) peerLabel.click();
          else nativeSetChecked(peer, true);
          any = true;
        }
      }
      if (!any) ok = false;
    } else if (el.type === "checkbox") {
      nativeSetChecked(el, /^(yes|true|y)$/i.test(String(value).trim()));
    } else if (tag === "button") {
      const container = el.closest('fieldset, [role="group"], [role="radiogroup"]') || el.parentElement;
      const buttons = container ? [...container.querySelectorAll("button")] : [el];
      const target = String(value).trim().toLowerCase();
      const match =
        buttons.find((b) => (b.textContent || "").trim().toLowerCase() === target) ||
        buttons.find((b) => {
          const t = (b.textContent || "").trim().toLowerCase();
          return t.includes(target) || target.includes(t);
        });
      if (match) match.click();
      else ok = false;
    } else if (looksLikeComboboxPick(el)) {
      ok = await fillReactSelectByClick(el, value);
      if (/greenhouse\.io$/i.test(location.hostname || "") || (el.closest && el.closest(".select-shell"))) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        ok = comboboxValueCommitted(el, value);
      }
    } else {
      nativeSet(el, value);
      ok = textInputCommitted(el, value);
    }
      if (ok) count++;
      if (looksLikeComboboxPick(el)) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    } catch (err) {
      // This one field failed - move on to the next rather than losing the whole batch (see
      // the comment above the try block for why). Logged (not swallowed silently) so a repro
      // shows the actual thrown error in DevTools instead of just "opens and closes" with no
      // trace of why - the Greenhouse combobox fallback chain is elaborate enough that guessing
      // which step failed from the symptom alone hasn't been reliable.
      console.error(`[Auto Fill] failed to fill field ${idx} ("${label}"):`, err);
    }
  }
  document.querySelectorAll("[data-af-idx]").forEach((el) => el.removeAttribute("data-af-idx"));
  document.querySelectorAll("[data-af-label]").forEach((el) => el.removeAttribute("data-af-label"));
  // Same Ashby post-fill settle as runAutofillInPage — generated answers also need the
  // blur-triggered GraphQL save to finish before Submit.
  if (/(^|\.)ashbyhq\.com$/i.test(location.hostname || "")) {
    await new Promise((resolve) => setTimeout(resolve, 650));
  }
  // Greenhouse remix react-select sometimes needs a beat after programmatic picks before the
  // single-value label reflects in the DOM (confirmed live: GPT second pass reported fills
  // while the visible dropdown still showed "Select...").
  if (/greenhouse\.io$/i.test(location.hostname || "") || document.querySelector(".select-shell.remix-css-b62m3t-container, .select-shell")) {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { count };
}

// Confirmed live via a MutationObserver trace (after directly ruling out three other theories
// with live diagnostics first - a wrong DOM element target, stuck/wrong browser focus, and a
// fetchProfile-retry-timing correlation): Greenhouse's own React app independently re-renders
// its phone dial-code picker (bare "Country" label, see isPhoneDialCodePicker elsewhere in this
// file) via its OWN deferred scheduler at some point DURING a run, resetting an already-correct
// value to something unrelated. The mutation's own call stack showed genuine React-DOM commit
// internals (scheduler.production.min.js's postMessage-based yielding), not anything this
// extension's own click/keyboard/focus handling directly causes. Every commit to this field
// also triggers Greenhouse's own fetchProfile() call, which 401s for an anonymous applicant -
// the leading theory is that call's own delayed error-handling resets this field as a side
// effect, entirely inside Greenhouse's own app code, which can't be prevented from outside it.
// Rather than try to prevent something outside this extension's control, this outlasts it
// instead - runs once, after every other field on the page has already been processed (see its
// own call site in the autofillBtn handler), waits for any such delayed reset to have already
// happened, then re-verifies and re-fills this ONE field as the very last step of the whole
// run, so nothing later can still knock it over. Uses fillGreenhouseViaReactFiber's own direct-
// react-fiber technique (a short, self-contained duplicate of just the helpers it needs, not the
// full multi-tier DOM-click fallback chain) since the widget is definitely already mounted by
// this point, live-verified as reliable for exactly this kind of re-fill.
// Check-only (no re-fill attempt of its own) - a standalone duplicate of fillGreenhouseViaReactFiber
// tried to re-fill this field directly, but "tier 1 (React fiber direct)" has never once
// succeeded ANYWHERE in this whole file's own live logs, across dozens of fields, on this exact
// page - only real clicks (tier 2, inside fillReactSelectByClick's own tryGreenhouseRemixSelect)
// have ever actually committed a value. A standalone re-implementation using only the fiber
// approach was never going to be reliable - confirmed live: it correctly detected "+374" as
// wrong, attempted the fiber-only re-fill, and the value never changed at all. Rather than
// duplicate tryGreenhouseRemixSelect's own much larger, already-proven click/keyboard/type-to-
// filter fallback chain a second time in a second place, this function ONLY checks and reports -
// see its call site in the autofillBtn handler, which re-runs runAutofillInPage itself (the same,
// already-proven code that filled this field correctly earlier in the run) when this reports
// wasWrong, instead of re-implementing a weaker copy of it here.
async function checkPhoneCountryPickerInPage(profile) {
  if (!profile || !profile.contact || !profile.contact.country) return { checked: false };
  const picker = document.querySelector(".phone-input__country [role='combobox']");
  if (!picker) return { checked: false };
  function reactSelectDisplayValue(element) {
    const control = element && element.closest && element.closest('[class*="__control"]');
    if (!control) return "";
    const single = control.querySelector('[class*="__single-value"]');
    return single && single.textContent ? single.textContent.replace(/\s+/g, " ").trim() : "";
  }
  // Any GENUINELY correct calling code must be a literal PREFIX of the profile's own full phone
  // number (e.g. "+48" is a prefix of "+48694542078"; "+374" is not) - checking that directly
  // verifies the actual value instead of just its shape (a bare "does this look like SOME +NN
  // code" check can't tell a wrong-but-valid-looking code like "+374" apart from a correct one).
  const phoneDigits = String((profile.contact && profile.contact.phone) || "").replace(/[^\d+]/g, "");
  const isCorrectDialCode = (v) => {
    const code = String(v || "").trim();
    return /^\+\d{1,4}$/.test(code) && phoneDigits.startsWith(code);
  };
  // Waits for any delayed reset to have already happened before checking, rather than checking
  // too early and missing one that's still pending. Was 3000ms - shortened now that #106 fixed
  // the actual root cause (unreliable option discovery causing repeated failed retries, which is
  // what created the delayed-reset window in the first place); this wait is now just a cheap
  // safety margin, not load-bearing the way it was before that fix.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const value = reactSelectDisplayValue(picker);
  console.info(`[Auto Fill][phone-watch] final re-check: country picker shows "${value}"`);
  return { checked: true, wasWrong: !isCorrectDialCode(value), value };
}

// Injected into the page — same self-containment constraint as above (aside from relying on
// field-detector.js, loaded first — see the saveSampleBtn handler). Read-only: runs the same
// DETECT+MATCH logic Auto Fill and Learn use (via the shared collectFormFields()/
// labelForElement()/resolveOwnLabel(), not a separately-drifting copy of them) but never
// mutates the page, so it's safe to run on a page you haven't decided to fill yet.
// This used to carry its own duplicated copy of every detection helper, which had quietly
// fallen behind: missing honeypot filtering, the Workday "Select One"/multiSelectContainer
// combobox detection, button-groups (Ashby-style Yes/No pairs never showed up in a captured
// sample at all), shadow-DOM fields, and several label-resolution fixes (fieldset/legend
// priority, aria-labelledby, the Lever ancestor-sibling climb) - meaning a captured sample no
// longer reliably reflected what a real Auto Fill run would actually see. Migrated to the
// shared module for the same reason Auto Fill and Learn already were: one drifting copy fewer.
function captureSampleInPage(profile, qaBank) {
  function normalizeForMatch(text) {
    return (text || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  }

  function wordOverlapScore(a, b) {
    const wordsA = new Set(normalizeForMatch(a).split(" ").filter((w) => w.length > 2));
    const wordsB = new Set(normalizeForMatch(b).split(" ").filter((w) => w.length > 2));
    if (!wordsA.size || !wordsB.size) return 0;
    let overlap = 0;
    for (const w of wordsA) if (wordsB.has(w)) overlap++;
    return overlap / Math.min(wordsA.size, wordsB.size);
  }

  // Picks the most recent job out of profile.experience for "current company"/"headline"
  // lookups below — prefers an entry with no end date or an explicit "Present"/"Current" end
  // date (a genuinely still-ongoing role) over just assuming index 0 is newest, since that
  // ordering isn't guaranteed by the schema itself.
  function currentExperience(p) {
    const exp = p.experience || [];
    return exp.find((e) => !e.end_date || /present|current/i.test(e.end_date)) || exp[0] || null;
  }

  const STRUCTURED_PATTERNS = [
    { re: /^(retype\s+)?e-?mail(\s*address)?\s*$/i, get: (p) => p.contact.email },
    // Kept in sync with runAutofillInPage's negative-lookahead version - excludes "Country
    // Phone Code"/"Phone Device Type"/"Phone Extension" from matching as the phone number itself.
    { re: /^(?!.*\b(code|type|extension|device)\b).*\b(phone|mobile|telephone)\b/i, get: (p) => p.contact.phone },
    { re: /linkedin/i, get: (p) => p.contact.linkedin },
    { re: /website|portfolio/i, get: (p) => p.contact.website },
    {
      re: /^links?\b/i,
      get: (p) => [p.contact.linkedin, p.contact.website].filter(Boolean).join(", ") || null,
    },
    // Split out from a single combined "city|location|address" -> location pattern after a
    // real form asked for "Address" and "City" as two separate fields, both of which got
    // filled with the same value ("Warsaw") since both matched the one combined pattern.
    // Order matters here: more specific patterns are checked first, since a broader one
    // (e.g. "location") would otherwise swallow a field a later, narrower pattern should
    // have matched instead.
    { re: /postal\s*code|zip\s*code|\bzip\b/i, get: (p) => p.contact.postal_code },
    { re: /^street\b|address\s*line|^address\b/i, get: (p) => p.contact.street_address },
    // Broadened beyond a bare leading "City" after a real Greenhouse form's "Enter your current
    // location city" fell through unmatched - "city" is the LAST word, not the first, in that
    // phrasing, so the anchored-to-start pattern never matched it even though it's asking for
    // exactly the same profile fact.
    { re: /^city\b|\bcity\s*$/i, get: (p) => p.contact.city },
    // ContactInfo.state was originally left out of structured matching entirely - some "State"
    // questions carry form-specific conditions a profile value can't know about (e.g. "select
    // N/A unless you live in the US or Australia"). Reported live: BambooHR's plain "Province"
    // field (a real text input, no dropdown/cascading logic at all) was left unmatched as a
    // direct result, meaning it either needed manual input or risked an UNGROUNDED AI guess via
    // generation - a worse outcome than just using the real profile value for the common case.
    // Requires the WHOLE (normalized) label to be just "State"/"Province" and nothing else - an
    // earlier version anchored only to the start (`^(state|province)\b`), which a synthetic test
    // caught matching "State (select N/A unless you live in the US or Australia)" too, since
    // that label genuinely starts with "State" - exactly the conditional-wording risk this was
    // supposed to avoid. Requiring the ENTIRE label correctly excludes any trailing qualifier
    // text, falling through to the old safe behavior (QA bank / manual) for those.
    { re: /^(state|province)\s*$/i, get: (p) => p.contact.state },
    // Excludes "Country Phone Code" - confirmed live, that field starts with "Country" too and,
    // once excluded from the phone pattern above, would otherwise fall through and get filled
    // with "Poland" (the residence country) instead of being left for the dial-code picker.
    { re: /^country\b(?!.*\b(phone|code|dial)\b)/i, get: (p) => p.contact.country },
    { re: /country of residence|current country of residence/i, get: (p) => p.contact.country },
    // Broadened beyond a bare leading "Location" after a Recruitee form's "Where are you
    // currently located? (City, country)" fell through to generation and got answered with the
    // candidate's own tech stack instead (a small local model, given a job description that
    // heavily repeats React/TypeScript/etc., producing a wrong, off-topic non-sequitur for a
    // plain personal-info question) - the same "broaden structured coverage so generation is
    // never even reached" fix as the Workday alias above, not a smarter/costlier check on
    // whatever the model happens to generate.
    { re: /^location\b|current(ly)?\s+located|where.*(you|currently).*(located|based)/i, get: (p) => p.contact.location },
    // "Given Name(s)"/"Family Name" are Workday's own terms for first/last name - confirmed
    // live, without these aliases neither pattern matched, so the field fell through to Ollama
    // generation, which returned "Polish" (the candidate's nationality, from the QA bank) for
    // "Family Name" instead of the actual surname - a small local model has no way to reliably
    // resolve a vaguely-worded label a plain profile lookup answers correctly and for free.
    { re: /^first\s*name|^given\s*name|\bname\s*-\s*first\b|^first$/i, get: (p) => (p.contact.name || "").split(" ")[0] || "" },
    { re: /^preferred(\s+first)?\s*name/i, get: (p) => (p.contact.name || "").split(" ")[0] || "" },
    { re: /^last\s*name|^family\s*name|^surname\b|\bname\s*-\s*last\b|^last$/i, get: (p) => (p.contact.name || "").split(" ").slice(1).join(" ") },
    // Excludes referral/nomination-context questions - confirmed live, a real Greenhouse form's
    // "Enter the full name of our employee who suggested this job opportunity" (explicitly
    // described as "Only if the job opportunity was suggested to you by one of our employees")
    // was wrongly filled with the APPLICANT'S OWN name via this pattern, since "full name"
    // appears in the sentence regardless of whose name is actually being asked for - a real,
    // actively wrong answer (implying self-referral / corrupting the referrer field), not just
    // a missed field.
    { re: /^(?!.*\b(referr\w*|recommend\w*|suggest\w*|nominat\w*)\b).*\bfull\s*name\b|^name$/i, get: (p) => p.contact.name },
    { re: /^typed\s*signature\b/i, get: (p) => p.contact.name },
    // "Current company" / "Headline" are plain lookups into the most recent experience entry,
    // not something to hand to Ollama — confirmed live, generation answered these with a full
    // sentence ("I am currently working at X where...") when the form wanted just "X", since a
    // free-text prompt has no way to know a field wants one word instead of a paragraph. Direct
    // profile lookup is also instant and free, unlike a generation call.
    {
      re: /current\s*(company|employer)|^employer$/i,
      get: (p) => (currentExperience(p) || {}).company || null,
    },
    {
      re: /headline|current\s*(job\s*)?title|current\s*position/i,
      get: (p) => {
        const e = currentExperience(p);
        return e ? `${e.title} at ${e.company}` : null;
      },
    },
  ];

  function matchStructuredField(label) {
    for (const { re, get } of STRUCTURED_PATTERNS) {
      if (re.test(label)) {
        const value = get(profile);
        if (value) return value;
      }
    }
    return null;
  }

  // A handful of application-boilerplate questions recur on nearly every ATS but with the
  // company's own name filled into an otherwise-identical template — "Have you ever been
  // employed by New Relic?" vs. a generic stored answer for "Have you ever worked at this
  // company before?" share almost no literal words (employed≠worked, New Relic≠company), so
  // plain word-overlap can never bridge them. Matched by category via regex instead, same
  // idea as STRUCTURED_PATTERNS but for QA-bank lookups.
  const CATEGORY_PATTERNS = [
    // Excludes "worked with" specifically - confirmed live, "Which cloud platforms have you
    // worked with?" (a technology-experience checklist, nothing to do with prior employment)
    // was matching this boilerplate "have you ever worked here before" category purely on
    // unanchored substring overlap ("have you...worked" is present in both), which then let
    // category-match short-circuit past word-overlap scoring entirely and pull in an unrelated
    // saved "No" answer from a genuine worked-here-before question. Real boilerplate phrasing
    // ("worked here", "worked at this company", "been employed by X") never says "worked with" -
    // that phrasing specifically signals collaborating with a tool/technology/person, not being
    // employed by an entity.
    { key: "worked_here_before", re: /have you.{0,40}(worked(?!\s+with\b)|been employed)\b/i },
    { key: "currently_employed_here", re: /(are you )?currently (working|employed)\b/i },
    // "Eligible to work" confirmed live as a real wording variant (Globalization Partners'
    // Greenhouse form: "Are you currently eligible to work in the country where this role is
    // posted without visa sponsorship?") that "authorized to work" alone didn't catch, meaning
    // a saved answer for the same underlying question never got reused via category match.
    { key: "authorized_to_work", re: /authori[sz]ed to work|legally authorised to work/i },
    { key: "eligible_to_work", re: /^eligible to work$/i },
    { key: "requires_sponsorship", re: /(require|need|will).{0,25}(sponsorship|visa)/i },
    {
      key: "salary_expectations",
      re: /\bsalary\b|\bcompensation\b|\b(?:pay|rate)\b.{0,20}\bexpect|\bmonthly\s*rate\b|\bdesired\s+net\b/i,
    },
    { key: "related_to_employee", re: /related to anyone|relative.{0,20}(at|with|of)\b/i },
    {
      key: "notice_period",
      re: /\bnotice period\b|when can you start|earliest (start|availability)|\bavailable from\b|\bavailable to start\b/i,
    },
    { key: "b2b_contract", re: /\bb2b\b.*\b(model|contract)\b|\bcontract\s*type\b/i },
    { key: "nationality", re: /\bnationality\b/i },
    {
      key: "english_proficiency",
      re: /\benglish\b.*\b(level|proficiency|fluency|language)\b|\bfluency in english\b/i,
    },
    {
      key: "polish_proficiency",
      re: /\bpolish\b.*\b(level|proficiency|fluency|language)\b|\bproficiency in polish\b/i,
    },
    { key: "relocation", re: /\brelocat|currently based|based in\b/i },
    { key: "gender", re: /\bgender\b/i },
    { key: "hispanic_latino", re: /\bhispanic\b|\blatino\b/i },
    { key: "veteran_status", re: /\bveteran\b/i },
    { key: "disability_status", re: /\bdisabilit/i },
    { key: "race_ethnicity", re: /\brace\b|\bethnicity\b/i },
  ];
  function detectCategory(text) {
    for (const { key, re } of CATEGORY_PATTERNS) {
      if (re.test(text)) return key;
    }
    return null;
  }

  function isPlausibleQaComboboxAnswer(label, answer) {
    const a = String(answer || "").trim();
    if (!a) return false;
    const cat = detectCategory(label);
    if (cat === "authorized_to_work" || cat === "requires_sponsorship") {
      if (/^\+\d{1,4}$/.test(a) || /^\d+$/.test(a)) return false;
    }
    if (cat === "nationality" && /^none$/i.test(a)) return false;
    if (cat === "disability_status" && /^\d+$/.test(a)) return false;
    return true;
  }

  // "what"/"your" recur across nearly every boilerplate application question ("What is your
  // ___?"), so two genuinely unrelated questions phrased that way can share only these two
  // words and still clear the overlap bar below purely from sentence-template overlap, not
  // actual meaning - confirmed live, "What is your current location?" and "What is your salary
  // expectation...?" both got silently filled with a saved "What is your preferred messenger?
  // Please provide your ID/name" answer this way. Excluded explicitly since neither is filtered
  // by length alone (both 4 chars).
  const MATCH_QA_STOPWORDS = new Set(["what", "your"]);
  function matchQaBank(label, element) {
    const normLabel = normalizeForMatch(label);
    if (normLabel === "country" && element && element.closest && element.closest(".phone-input__country")) {
      return null;
    }
    const labelWords = new Set(normLabel.split(" ").filter((w) => w.length > 2 && !MATCH_QA_STOPWORDS.has(w)));
    const labelCategory = detectCategory(label);
    let best = null;
    let bestScore = 0;
    for (const entry of qaBank) {
      const normQuestion = normalizeForMatch(entry.question);
      // Exact match (after normalizing) always wins outright — this is what makes a
      // legitimately short label like "Country" matchable against a QA-bank entry also
      // titled "Country", without opening the door to it matching any longer question that
      // merely happens to mention the word "country" once (see the general path below).
      if (normLabel && normLabel === normQuestion) return entry;
      // Same recurring boilerplate category, even though the literal wording differs
      // (a different company name filled into the same underlying question).
      if (labelCategory && detectCategory(entry.question) === labelCategory) return entry;
      const qWords = new Set(normQuestion.split(" ").filter((w) => w.length > 2 && !MATCH_QA_STOPWORDS.has(w)));
      if (!labelWords.size || !qWords.size) continue;
      let overlap = 0;
      for (const w of labelWords) if (qWords.has(w)) overlap++;
      const score = overlap / Math.min(labelWords.size, qWords.size);
      // A ratio/count bar alone isn't enough: two DIFFERENT specific instances of the same
      // boilerplate template ("What's your proficiency level in X?", "...seniority level
      // associated with X?") share every significant word except X and still clear a high
      // ratio, since X is the only thing that ever differs - confirmed live, a saved "English
      // proficiency: Advanced" answer would otherwise get reused for a separate "Polish
      // proficiency" question on the same form (overlap=2, score=0.67), and a saved "Java and
      // Spring Boot" seniority answer for a separate "AWS" seniority question (overlap=5,
      // score=0.83) - both would misrepresent real skills/language claims to an employer.
      // Requiring the combined vocabulary to differ by at most one word closes that gap.
      const unionSize = new Set([...labelWords, ...qWords]).size;
      // Require at least 2 shared significant words — a single shared word is too easy to
      // hit by coincidence (e.g. "country" alone matching an unrelated visa question).
      if (overlap >= 2 && score >= 0.5 && unionSize - overlap <= 1 && score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return best;
  }

  // Kept in sync with runAutofillInPage's CONSENT_RE — a legal-consent question ("I agree to
  // the Privacy Policy") should never report as auto-fillable from a QA-bank answer, since
  // real autofill won't apply one here either (each consent is a fresh per-document action).
  // "Do you agree to share your CV (without personal data) with our clients..." - a real,
  // per-company data-sharing consent question - only matched "i agree" before, missing this
  // equally common second-person phrasing of the exact same kind of consent decision.
  const CONSENT_RE = /\b(i|you) agree\b|\bconsent\b|privacy polic|terms (and|&)? ?conditions|terms of service|share your (cv|resume|data|information)/i;
  function isConsentField(label) {
    return CONSENT_RE.test(label);
  }

  const fields = [];

  const { groups, singles, loneCheckboxes } = collectFormFields();

  for (const group of groups) {
    const qaMatch = !isConsentField(group.label) && matchQaBank(group.label);
    fields.push({
      label: `${group.label} (options: ${group.options.map((o) => o.optionLabel).join(", ")})`,
      type: group.kind,
      source: qaMatch ? "learned" : "unmatched",
      value: qaMatch ? qaMatch.answer : null,
    });
  }

  for (const { element, host } of singles) {
    const label = labelForElement(element, host);
    // Kept in sync with runAutofillInPage - structured matching needs the field's own label,
    // not the group-prefixed one (see the matching comment there for the Workday repro).
    const ownLabel = normalizeLabel(resolveOwnLabel(element, host));
    const structuredValue = matchStructuredField(ownLabel);
    if (structuredValue) {
      fields.push({ label, type: element.type || element.tagName.toLowerCase(), source: "profile", value: String(structuredValue) });
      continue;
    }
    const qaMatch = !isConsentField(label) && matchQaBank(label);
    if (qaMatch) {
      fields.push({ label, type: element.type || element.tagName.toLowerCase(), source: "learned", value: qaMatch.answer });
      continue;
    }
    fields.push({ label, type: element.type || element.tagName.toLowerCase(), source: "unmatched", value: null });
  }

  // Ungrouped single checkboxes (no shared `name`) — mirrors runAutofillInPage's own lone-
  // checkbox handling, previously missing here entirely (a Save Sample capture just silently
  // dropped these instead of reporting them as unmatched like every other field type).
  for (const { element, host } of loneCheckboxes) {
    const label = labelForElement(element, host);
    const qaMatch = !isConsentField(label) && matchQaBank(label);
    fields.push({
      label,
      type: element.type,
      source: qaMatch ? "learned" : "unmatched",
      value: qaMatch ? qaMatch.answer : null,
    });
  }

  // Pierces open shadow roots so Save Sample includes SmartRecruiters suggestion rows (and
  // other design-system widgets) that live only inside `<spl-*>` hosts — plain outerHTML
  // cannot see them (confirmed: jobs-smartrecruiters-com-20260804T081827Z with Bucharest
  // suggestions open still serialized an empty `<spl-autocomplete>`).
  function serializeWithOpenShadow(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || "";
    }
    if (node.nodeType === Node.COMMENT_NODE) {
      return `<!--${node.data || ""}-->`;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") {
      return node.outerHTML || "";
    }
    let attrs = "";
    for (const a of node.attributes || []) {
      attrs += ` ${a.name}="${String(a.value).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
    }
    if (node instanceof HTMLTemplateElement) {
      return `<template${attrs}>${serializeWithOpenShadow(node.content)}</template>`;
    }
    let inner = "";
    if (node.shadowRoot) {
      inner += `<template shadowrootmode="open">`;
      for (const child of node.shadowRoot.childNodes) inner += serializeWithOpenShadow(child);
      inner += `</template>`;
    }
    for (const child of node.childNodes) inner += serializeWithOpenShadow(child);
    const voidish = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag);
    if (voidish && !node.shadowRoot && !node.childNodes.length) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  return { url: location.href, html: serializeWithOpenShadow(document.documentElement), fields };
}

// Injected into the page — same self-containment constraint as above. Keep the DETECT
// logic (normalizeLabel/resolveOwnLabel/group detection/isVisible) in sync with
// runAutofillInPage's if you change either.
function runLearnInPage() {
  // Label resolution, visibility checks, honeypot/combobox detection, and group/native/shadow
  // field collection all come from field-detector.js, injected into this page before this
  // function runs (see the learnBtn handler) - the exact same collectFormFields() Auto Fill
  // uses, so a field Auto Fill finds/fills is a field Learn can also see and capture, with the
  // same label. Only the read-the-current-value logic below is still local to this function.

  // A react-select-style combobox's own <input> is just its search/filter box — after a real
  // selection, its .value goes back to empty; the actually-chosen text lives in a separate
  // sibling display element (e.g. "select__single-value") instead. Reading element.value
  // directly (as every other field type correctly does) silently learns nothing for these —
  // confirmed live: manually picking "N/A"/answering the consent question, then clicking
  // Learn, saved no Q&A entry for any of them, because there was never really a ".value" to
  // read in the first place.
  function getComboboxValue(element) {
    const controlEl = element.closest('[class*="__control"]') || element.parentElement;
    const prefixMatch = controlEl && controlEl.className && controlEl.className.match(/(\S+)__control\b/);
    const prefix = prefixMatch ? prefixMatch[1] : null;
    const scope = controlEl || element.parentElement || document;
    if (prefix) {
      const single = scope.querySelector(`[class*="${prefix}__single-value"]`);
      if (single && cleanedText(single)) return cleanedText(single);
      const multi = [...scope.querySelectorAll(`[class*="${prefix}__multi-value"]`)]
        .map((el) => cleanedText(el))
        .filter(Boolean);
      if (multi.length) return multi.join(", ");
    }
    // Some custom comboboxes (e.g. a bare <div role="combobox">, confirmed live on an Angular
    // CDK-based ATS's "Country" field with no real underlying <input> or "__control" wrapper
    // at all) have no separate display element — the trigger's own text IS the currently
    // selected value, updated in place once a choice is made. Checked before the broader
    // sibling search below, which walks the whole parent subtree and could otherwise match
    // unrelated page content when there's no real "__control" ancestor to scope it to.
    if (!prefix && element.tagName !== "INPUT" && element.tagName !== "SELECT") {
      const ownText = cleanedText(element);
      if (ownText && !/^select(\.\.\.)?$|^choose\b/i.test(ownText)) return ownText;
    }
    // Generic fallback: any other leaf text sibling in the control that isn't the input
    // itself and isn't just the placeholder ("Select...").
    if (controlEl) {
      const candidate = [...controlEl.querySelectorAll("div, span")].find((el) => {
        if (el === element || el.contains(element) || el.children.length > 0) return false;
        const text = cleanedText(el);
        return text && text.toLowerCase() !== "select...";
      });
      if (candidate) return cleanedText(candidate);
    }
    return element.value || "";
  }

  const learned = [];
  const { groups, singles, loneCheckboxes } = collectFormFields();

  // Radio/checkbox/button groups: one Q/A pair for the whole group ("English level: B2"), not
  // one mis-scoped pair per option ("B2: Yes"). For a checkbox-group (multi-select) every
  // checked option is joined; for a radio-group/button-group there's at most one.
  for (const group of groups) {
    let chosen;
    if (group.kind === "button-group") {
      // Ashby-style button pairs — best-effort: relies on the site marking the chosen button
      // (aria-pressed, or a common "selected/active" class), since a plain click leaves no
      // other DOM trace of which one was picked.
      const selected = group.options.find(
        ({ element }) => element.getAttribute("aria-pressed") === "true" || /\b(selected|active|is-selected|is-active)\b/.test(element.className)
      );
      chosen = selected ? [selected.optionLabel] : [];
    } else {
      chosen = group.options
        .filter(
          ({ element }) =>
            element.checked ||
            element.getAttribute?.("checked") === "true" ||
            element.getAttribute?.("aria-checked") === "true"
        )
        .map(({ optionLabel }) => optionLabel);
    }
    if (chosen.length) learned.push({ question: group.label, answer: chosen.join(", ") });
  }

  for (const { element, host } of singles) {
    const isCombobox = looksLikeComboboxPick(element);
    // A react-select-style combobox's own search <input> is frequently near-zero-width once
    // closed with a value already picked and nothing being actively typed - many
    // implementations auto-size it to the currently-typed text via a CSS grid/data-value sizing
    // trick, so with no text it collapses toward 0px even though the actual selected value is
    // genuinely visible via a separate sibling display element ("select__single-value").
    // Checking the surrounding control container's own box instead of the input's own,
    // possibly-collapsed one - confirmed live: manually picking "None"/"Advanced" from two
    // language-proficiency dropdowns, then running Learn, silently captured neither, because
    // isVisible(element) on the bare <input> reported false right after the pick.
    const visibilityTarget = isCombobox ? element.closest('[class*="__control"]') || element : element;
    if (!isVisible(visibilityTarget)) continue;
    let value;
    if (element.tagName === "SELECT") {
      // A <select> nobody has touched yet still reports its first/placeholder <option> as
      // "selected" (that's just how the native element works) - confirmed live across three
      // different fixtures ("Please select", "Select an option...", "Select Years of
      // Experience"), all learned as if they were real chosen answers. Nearly every such
      // placeholder option has an empty value="" (that's specifically why forms use it - so
      // native required-field validation fails until something real is picked), so excluding
      // empty-value options is a reliable "was anything actually chosen" signal.
      const selected = [...element.selectedOptions].filter((o) => o.value !== "").map((o) => cleanedText(o)).filter(Boolean);
      if (!selected.length) continue;
      value = selected.join(", ");
    } else if (isCombobox) {
      value = getComboboxValue(element);
    } else {
      value = element.value;
    }
    const label = labelForElement(element, host);
    if (label && value && String(value).trim()) {
      learned.push({ question: label, answer: String(value).trim() });
    }
  }

  for (const { element } of loneCheckboxes) {
    if (!isVisible(element) || !element.checked) continue;
    const label = labelForElement(element, element);
    const value = element.value && element.value !== "on" ? element.value : "Yes";
    if (label) learned.push({ question: label, answer: value });
  }

  return learned;
}

// "what"/"your" recur across nearly every boilerplate application question ("What is your
// ___?"), inflating overlap between genuinely distinct questions - confirmed live, this exact
// gap merged "What is your Ukrainian proficiency level?" and "...English proficiency level?"
// into a single saved QA-bank entry (score 0.8, min word count 5, all from "what"+"your"+
// "proficiency"+"level"), with the second answer silently overwriting the first under the
// wrong question's title. Same fix already applied to matchQaBank/isPlausibleQaMatch.
const WORD_OVERLAP_STOPWORDS = new Set(["what", "your"]);
function wordOverlapScoreSimple(a, b) {
  const norm = (t) => (t || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const wordsA = new Set(norm(a).split(" ").filter((w) => w.length > 2 && !WORD_OVERLAP_STOPWORDS.has(w)));
  const wordsB = new Set(norm(b).split(" ").filter((w) => w.length > 2 && !WORD_OVERLAP_STOPWORDS.has(w)));
  if (!wordsA.size || !wordsB.size) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.min(wordsA.size, wordsB.size);
}

// Same category-boilerplate patterns as runAutofillInPage's own detectCategory — duplicated
// here since this runs in the side panel's own module scope, not the injected page script, so
// it can't share that closure directly. Kept in sync manually if either changes.
const MATCH_CATEGORY_PATTERNS = [
  {
    key: "worked_here_before",
    re: /have you.{0,40}(worked(?!\s+with\b)|been employed)\b/i,
  },
  { key: "currently_employed_here", re: /(are you )?currently (working|employed)\b/i },
  // Kept in sync with runAutofillInPage's own CATEGORY_PATTERNS - "eligible to work" confirmed
  // live as a real wording variant (Globalization Partners' Greenhouse form) alongside
  // "authorized to work".
  { key: "authorized_to_work", re: /authori[sz]ed to work|legally authorised to work/i },
  { key: "eligible_to_work", re: /^eligible to work$/i },
  { key: "requires_sponsorship", re: /(require|need|will).{0,25}(sponsorship|visa)/i },
  {
    key: "salary_expectations",
    re: /\bsalary\b|\bcompensation\b|\b(?:pay|rate)\b.{0,20}\bexpect|\bmonthly\s*rate\b|\bdesired\s+net\b/i,
  },
  { key: "related_to_employee", re: /related to anyone|relative.{0,20}(at|with|of)\b/i },
  {
    key: "notice_period",
    re: /\bnotice period\b|when can you start|earliest (start|availability)|\bavailable from\b|\bavailable to start\b/i,
  },
  { key: "b2b_contract", re: /\bb2b\b.*\b(model|contract)\b|\bcontract\s*type\b/i },
  { key: "nationality", re: /\bnationality\b/i },
  {
    key: "english_proficiency",
    re: /\benglish\b.*\b(level|proficiency|fluency|language)\b|\bfluency in english\b/i,
  },
  {
    key: "polish_proficiency",
    re: /\bpolish\b.*\b(level|proficiency|fluency|language)\b|\bproficiency in polish\b/i,
  },
  { key: "relocation", re: /\brelocat|currently based|based in\b/i },
  { key: "gender", re: /\bgender\b/i },
  { key: "hispanic_latino", re: /\bhispanic\b|\blatino\b/i },
  { key: "veteran_status", re: /\bveteran\b/i },
  { key: "disability_status", re: /\bdisabilit/i },
  { key: "race_ethnicity", re: /\brace\b|\bethnicity\b/i },
];
function detectMatchCategory(text) {
  for (const { key, re } of MATCH_CATEGORY_PATTERNS) {
    if (re.test(text)) return key;
  }
  return null;
}

// Same matcher as runAutofillInPage's matchQaBank — duplicated here because that function lives
// inside the injected page script closure. Used for gpt-auto's second-pass QA match before GPT.
const MATCH_QA_BANK_STOPWORDS = new Set(["what", "your"]);
function matchQaBankEntry(label, qaBank) {
  const norm = (t) => (t || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const normLabel = norm(label);
  const labelWords = new Set(normLabel.split(" ").filter((w) => w.length > 2 && !MATCH_QA_BANK_STOPWORDS.has(w)));
  const labelCategory = detectMatchCategory(label);
  let best = null;
  let bestScore = 0;
  for (const entry of qaBank || []) {
    const normQuestion = norm(entry.question);
    if (normLabel && normLabel === normQuestion) return entry;
    if (labelCategory && detectMatchCategory(entry.question) === labelCategory) return entry;
    const qWords = new Set(normQuestion.split(" ").filter((w) => w.length > 2 && !MATCH_QA_BANK_STOPWORDS.has(w)));
    if (!labelWords.size || !qWords.size) continue;
    let overlap = 0;
    for (const w of labelWords) if (qWords.has(w)) overlap++;
    const score = overlap / Math.min(labelWords.size, qWords.size);
    const unionSize = new Set([...labelWords, ...qWords]).size;
    if (overlap >= 2 && score >= 0.5 && unionSize - overlap <= 1 && score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

// Sanity-checks an AI-suggested QA-bank match before trusting it — confirmed live, a small
// local model reproducibly matched semantically unrelated questions to the wrong saved answer
// (e.g. "What is your notice period?" -> a saved "Are you a veteran?" answer; "current location
// and right to work status" -> a saved "No"), a failure mode "matched: true" alone gives no way
// to catch, since the server only used to return the answer text, not what it was matched
// against. A category match (the same curated, known-safe boilerplate categories used
// elsewhere) is trusted regardless of literal wording overlap, since bridging exactly that gap
// — different company names, "employed" vs "worked" — is the whole reason AI matching exists.
// Anything else needs at least 2 shared significant words and a real overlap ratio, the same
// threshold the plain-text QA-bank match tier already uses.
// "what"/"your" recur across totally unrelated application-boilerplate questions, since nearly
// every one of these is phrased "What is your ___?" - length alone doesn't filter them out (both
// 4 chars), so two genuinely unrelated "What is your X?" / "What is your Y?" questions can share
// only these two words and still clear the >=2-words/>=0.5-ratio bar below purely from sentence-
// template overlap, not actual meaning. Confirmed live: "What is your current location?" scored
// a false-positive match (overlap=2, score=0.5, right at the threshold) against a saved "What is
// your preferred messenger? Please provide your ID/name" answer this way, and the same gap put
// "salary expectation"/"Ukrainian proficiency"/"English proficiency" on the same form close to
// (though not quite over) the same bar too. Kept to just these two, confirmed-necessary words -
// a broader stopword list (tried "about"/"this"/"please"/...) started rejecting genuine
// paraphrase matches instead (e.g. "how did you hear about us" vs "...about this position").
const QA_MATCH_STOPWORDS = new Set(["what", "your"]);

function isPlausibleQaMatch(newQuestion, matchedQuestion) {
  if (!matchedQuestion) return false;
  const newCategory = detectMatchCategory(newQuestion);
  if (newCategory && newCategory === detectMatchCategory(matchedQuestion)) return true;
  const norm = (t) => (t || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  // Length > 3 here, not > 2 like the codebase's other word-overlap helpers — short filler
  // words ("are", "you") sitting at exactly the length-3 boundary coincidentally overlapped
  // between two completely unrelated questions in testing ("which areas ARE YOU strongest in"
  // vs "are you a veteran" shared only "are"/"you", yet cleared the >=2/>=0.5 bar). This
  // function's whole job is telling a genuinely-related pairing apart from a coincidental one,
  // so it needs a stricter content-word filter than the "does this look roughly similar"
  // threshold used elsewhere.
  const wordsA = new Set(norm(newQuestion).split(" ").filter((w) => w.length > 3 && !QA_MATCH_STOPWORDS.has(w)));
  const wordsB = new Set(norm(matchedQuestion).split(" ").filter((w) => w.length > 3 && !QA_MATCH_STOPWORDS.has(w)));
  if (!wordsA.size || !wordsB.size) return false;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  const score = overlap / Math.min(wordsA.size, wordsB.size);
  // A ratio/count bar alone isn't enough: two DIFFERENT specific instances of the same
  // boilerplate template ("What's your proficiency level in X?") share every significant word
  // except X and still clear a high ratio, since X is the only thing that ever differs -
  // confirmed live, a saved "English proficiency: Advanced" answer would otherwise get reused
  // for a separate "Polish proficiency" question on the same form (overlap=2, score=0.67),
  // misrepresenting a real language claim to an employer. Requiring the combined vocabulary to
  // differ by at most one word closes that gap - kept in sync with matchQaBank's own version.
  const unionSize = new Set([...wordsA, ...wordsB]).size;
  return overlap >= 2 && score >= 0.5 && unionSize - overlap <= 1;
}

// A shared-ratio bar alone isn't enough to call two questions "the same" - two DIFFERENT
// specific instances of the same boilerplate template ("What is your X proficiency level?") can
// share every significant word except X and still clear a high ratio, since X is the only thing
// that ever differs. Confirmed live: "What is your Ukrainian proficiency level?" and "...English
// proficiency level?" scored 0.8 (3 significant words each, only the language name differs) and
// got silently merged into one entry, with the English answer overwriting the Ukrainian one
// under the Ukrainian question's title - the exact kind of bug this function exists to avoid,
// just triggered by two genuinely different questions instead of one reworded. Requiring the
// combined vocabulary to differ by at most one word closes that gap without losing the ability
// to recognize a bare "Location" and a fuller "What is your current location?" as the same
// question (only "current" differs there).
function isNearDuplicateQuestion(a, b) {
  if (wordOverlapScoreSimple(a, b) < 0.6) return false;
  const norm = (t) => (t || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const wordsA = new Set(norm(a).split(" ").filter((w) => w.length > 2 && !WORD_OVERLAP_STOPWORDS.has(w)));
  const wordsB = new Set(norm(b).split(" ").filter((w) => w.length > 2 && !WORD_OVERLAP_STOPWORDS.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return union.size - overlap <= 1;
}

function mergeQaEntries(existing, newPairs) {
  const merged = [...existing];
  for (const pair of newPairs) {
    const matchIndex = merged.findIndex((e) => isNearDuplicateQuestion(e.question, pair.question));
    if (matchIndex === -1) {
      merged.push(pair);
    } else if (merged[matchIndex].answer !== pair.answer) {
      // Update in place instead of silently skipping — confirmed live: a user who corrects a
      // wrong/outdated saved answer on the page and clicks Learn again expects the fix to
      // actually take. The old behavior treated "similar-worded question already exists" as a
      // reason to discard the new answer entirely, which meant a stale or wrong saved answer
      // could never actually be corrected via Learn — only worked around by editing the Q&A
      // tab directly.
      merged[matchIndex] = { ...merged[matchIndex], answer: pair.answer };
    }
  }
  return merged;
}

async function scrapeCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  el("jobUrl").value = tab.url || "";
  try {
    // allFrames because many career pages embed the actual posting via a cross-origin
    // <iframe> (Greenhouse, Lever, etc.) — the top frame is often just an empty wrapper.
    const injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractPageInfo,
    });
    const valid = injections.filter((i) => i.result);
    if (!valid.length) {
      el("generateResult").textContent = "Extract failed: no result came back from the page.";
      return;
    }
    // Prefer the top frame for company/URL (it reflects the page you're actually on),
    // but use whichever frame found the most substantial job description text —
    // that's usually the embedded iframe, not the wrapper page.
    const topFrame = valid.find((i) => i.frameId === 0) || valid[0];
    const bestContent = valid.reduce((a, b) => (b.result.jobDescription.length > a.result.jobDescription.length ? b : a));

    el("jobDescription").value = bestContent.result.jobDescription || "";
    // Keep the browser tab URL set above — do not replace with a frame/canonical
    // extract that can shorten or rewrite what the user is actually on.
    el("jobUrl").value = tab.url || "";
    if (topFrame.result.company || bestContent.result.company) {
      el("company").value = topFrame.result.company || bestContent.result.company;
    }
    if (el("jobTitle")) {
      // Prefer the title from the same frame as the winning JD (usually the ATS iframe), not
      // the careers-shell top frame ("International Openings" on Precisely). Still skip
      // browser-sunset banners (SmartRecruiters IE11 overlay).
      const badTitle = (t) =>
        !t ||
        /internet explorer|no longer supported|browser.+(not|no longer)\s+supported/i.test(t) ||
        /^(apply( now)?|application( submitted)?|new application|careers?|career center|job application|job openings?|open positions?|open roles?|international openings?|current openings?|.+\bopenings?)$/i.test(
          t
        );
      const titleCandidates = [
        bestContent.result.jobTitle,
        topFrame.result.jobTitle,
        ...valid.map((i) => i.result && i.result.jobTitle),
      ];
      const pickedTitle = titleCandidates.find((t) => !badTitle(t)) || "";
      if (pickedTitle) el("jobTitle").value = pickedTitle;
    }
    el("generateResult").textContent = "";
    // Not awaited - the job description is already populated and useful on its own; the facts
    // fill in a moment later rather than delaying "Extract from page" on a second network call.
    loadJobFacts(bestContent.result.jobDescription || "", bestContent.result.structuredLocation || "");
  } catch (err) {
    // Some pages (chrome://, the Web Store, etc.) block script injection entirely.
    el("generateResult").textContent = `Extract failed: ${err.message}`;
  }
}

// Common tech/tool keywords scanned literally against the job description text - covers
// engineering roles (languages, frameworks, infra) and design/product roles (Figma, Blender,
// shadcn/ui, ...) since this extension applies to both. Deliberately a plain keyword list, not
// an exhaustive taxonomy - the point is a fast, deterministic "what's literally named in this
// posting" read, not a judgment call about what's actually required.
// A few otherwise-obvious entries are deliberately narrowed or dropped because they collide
// with common English words - confirmed live against a real posting: bare "Express" matched
// "designers express intent directly in code" (the verb, not Express.js). Same risk applies to
// bare "Go" (the verb "go"), "Spring" (the season), "REST" (rest as in repose - extremely
// common), "Agile" (nimble/flexible, not necessarily the methodology), and "Sketch" (a rough
// drawing, not necessarily the app) - each either requires a more specific multi-word form
// (Express.js, Spring Boot/Framework, REST API) or is dropped outright (bare Go/Agile/Sketch)
// rather than risk a misleading match, since a keyword scan has no way to judge context the way
// an LLM could.
const TECH_SKILL_KEYWORDS = [
  "JavaScript", "TypeScript", "Python", "Java", "C\\+\\+", "C#", "Golang", "Rust", "Ruby", "PHP",
  "Swift", "Kotlin", "Scala", "SQL", "HTML", "CSS", "Bash",
  "React", "Vue", "Angular", "Svelte", "Next\\.js", "Redux", "shadcn/ui", "Tailwind",
  "Node\\.js", "Express\\.js", "Django", "Flask", "FastAPI", "Spring (?:Boot|Framework)", "Rails",
  "ASP\\.NET(?:\\s+Core)?", "\\.NET", "Entity Framework",
  "AWS", "GCP", "Azure", "Docker", "Podman", "Kubernetes", "OpenShift", "Terraform", "ArgoCD",
  "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka", "GraphQL",
  // Was "REST(?:ful)? API" (singular only) - confirmed live, a real posting's "Design, develop,
  // and maintain REST APIs" never matched at all, since the trailing \b word boundary fails
  // right before a plural "s" (both "I" and "s" are word characters, no boundary between them).
  // "s?" covers the plural without needing a second, near-duplicate keyword entry.
  "REST(?:ful)? APIs?",
  "Figma", "Blender", "Rhino", "SketchUp", "Cinema ?4D", "Spline",
  "Adobe (?:XD|Photoshop|Illustrator)",
  "Claude", "ChatGPT", "OpenAI", "TensorFlow", "PyTorch", "LLM",
  // Jenkins/SonarQube/OpenSearch/Dynatrace all confirmed live, missing from a real posting's
  // "Nice to Have" tech list ("Experience building or maintaining CI/CD pipelines using
  // Jenkins", "...SonarQube Jira Confluence OpenSearch Dynatrace NexusIQ...").
  "Git", "CI/CD", "Jenkins", "SonarQube", "OpenSearch", "Dynatrace", "Scrum",
];

const LANGUAGE_NAMES = [
  "English", "German", "French", "Spanish", "Italian", "Portuguese", "Dutch", "Polish", "Russian",
  "Ukrainian", "Mandarin", "Chinese", "Japanese", "Korean", "Arabic", "Swedish", "Norwegian",
  "Danish", "Finnish", "Czech", "Turkish", "Hindi",
];

// Plain-text, keyword/regex-based reads of the job description - no LLM call at all. This used
// to go through /extract-job-facts (Claude or Ollama, whichever settings.answer_provider picked)
// - removed in favor of a deterministic script: no dependency on a local Ollama model being
// installed/running, no per-scrape network round trip, and no risk of an LLM paraphrasing or
// inferring a fact that isn't literally in the text. Each field stays "" (rendered as "Not
// mentioned" by the caller) when nothing matches, same contract the AI version had.
function extractJobFactsFromText(jobDescription) {
  const text = jobDescription || "";

  function extractLocation() {
    const labeled = text.match(/\bLocation\s*:\s*([^\n]{1,80})/i);
    if (labeled) return labeled[1].trim();
    // Falls back to whichever remote/hybrid/on-site keyword appears first - the most commonly
    // literally-stated location fact in a posting that never names an actual city. Returns just
    // the keyword itself, not a surrounding text window - confirmed live, grabbing "up to N
    // trailing chars" produced a garbled mid-word cut ("remote first work enviroment and a
    // great team that s") when the nearest sentence boundary was further away than the window,
    // and there's no reliable way to always land on a clean phrase boundary instead.
    if (/\b(fully\s+remote|remote[- ]first|remote)\b/i.test(text)) return "Remote";
    if (/\bhybrid\b/i.test(text)) return "Hybrid";
    if (/\bon-?site\b/i.test(text)) return "On-site";
    return "";
  }

  function extractSalary() {
    // A currency symbol/code next to a number range is the strongest, least-ambiguous signal -
    // covers "$80,000-$120,000", "€50k - €70k", "40-60 PLN/h", "GBP 45,000 per annum".
    const re =
      /(?:USD|EUR|GBP|PLN|CHF|CAD|AUD|\$|€|£)\s?\d[\d,.]*\s?[kK]?\s?(?:-|–|to)\s?(?:USD|EUR|GBP|PLN|CHF|CAD|AUD|\$|€|£)?\s?\d[\d,.]*\s?[kK]?(?:\s?(?:\/|per)\s?(?:year|yr|annum|month|mo|hour|hr|h)\.?)?/i;
    const m = text.match(re);
    return m ? m[0].trim() : "";
  }

  function extractSeniority() {
    // Checked in a fixed most-to-least-senior priority order rather than "whichever word
    // appears first in the text" - a posting that only mentions seniority once, in passing
    // ("mentorship from senior engineers"), shouldn't outrank an actual "Junior Developer"
    // title elsewhere. Still a plain keyword scan with no title-vs-body distinction, so it's
    // an approximation - the goal is a deterministic best-effort read, not a judgment call.
    const levels = [
      [/\bprincipal\b/i, "Principal"],
      [/\bstaff\b/i, "Staff"],
      [/\blead\b/i, "Lead"],
      [/\bsenior\b|\bsr\.?\s/i, "Senior"],
      [/\bmid-?level\b/i, "Mid-level"],
      [/\bjunior\b|\bjr\.?\s/i, "Junior"],
      [/\bintern(?:ship)?\b/i, "Intern"],
      [/\bentry-?level\b/i, "Entry-level"],
    ];
    for (const [re, label] of levels) {
      if (re.test(text)) return label;
    }
    return "";
  }

  function extractTechSkills() {
    const seen = new Set();
    const found = [];
    for (const kw of TECH_SKILL_KEYWORDS) {
      const m = text.match(new RegExp(`\\b${kw}\\b`, "i"));
      if (!m) continue;
      const key = m[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(m[0]);
    }
    return found.slice(0, 15).join(", ");
  }

  function extractLanguages() {
    const found = [];
    for (const lang of LANGUAGE_NAMES) {
      const m = text.match(new RegExp(`\\b${lang}\\b(?:[^.\\n]{0,40}?\\b(?:fluent|native|proficien\\w*|required|level|C1|C2|B1|B2)\\b)?`, "i"));
      if (m) found.push(m[0].trim());
    }
    return found.join("; ");
  }

  return {
    location: extractLocation(),
    salary_range: extractSalary(),
    tech_skills: extractTechSkills(),
    language_requirements: extractLanguages(),
    seniority_level: extractSeniority(),
  };
}

// Read-only facts pulled from the job description text itself - never an apply-or-not verdict
// (see the removed /check-eligibility feature, which kept getting that judgment call wrong).
// Each field is either what the posting literally states or "Not mentioned"; the person reads
// them and decides for themselves.
function loadJobFacts(jobDescription, structuredLocation) {
  const container = el("jobFacts");
  container.replaceChildren();
  if (!jobDescription) return;
  const facts = extractJobFactsFromText(jobDescription);
  // A schema.org JobPosting's own jobLocation/applicantLocationRequirements (see
  // formatStructuredLocation in extractPageInfo) is authoritative when present - confirmed
  // live, the free-text guess below read a real posting as plain "Remote" from an unrelated
  // company-culture sentence, missing that it's actually restricted to applicants based in one
  // specific country. Only overrides when structured data was actually found; otherwise falls
  // back to the same regex-based guess as before.
  if (structuredLocation) facts.location = structuredLocation;
  container.replaceChildren(
    ...[
      ["Location", facts.location],
      ["Salary", facts.salary_range],
      ["Seniority", facts.seniority_level],
      ["Tech skills", facts.tech_skills],
      ["Languages", facts.language_requirements],
    ].map(([label, value]) => {
      const row = document.createElement("div");
      row.className = "job-fact-row";
      const labelEl = document.createElement("span");
      labelEl.className = "job-fact-label";
      labelEl.textContent = `${label}: `;
      row.appendChild(labelEl);
      row.appendChild(document.createTextNode(value || "Not mentioned"));
      return row;
    })
  );
}

function updateRenderButtonState() {
  el("renderBtn").disabled = el("resumeJson").value.trim().length === 0;
}

function validateResumeShape(resume) {
  // Only a basic sanity check here — the backend accepts several resume JSON
  // shapes (see app/resume_normalize.py) and reports real shape problems itself.
  if (!resume || typeof resume !== "object" || Array.isArray(resume)) return ["a JSON object"];
  if (!Array.isArray(resume.experience)) return ["experience (array)"];
  return [];
}

el("scrapeBtn").addEventListener("click", scrapeCurrentTab);

el("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
el("refreshBtn").addEventListener("click", () => {
  refreshStatus();
  applyTailorMode();
});
el("resumeJson").addEventListener("input", updateRenderButtonState);

el("generateBtn").addEventListener("click", async () => {
  const genResultEl = el("generateResult");
  const body = {
    company: el("company").value.trim(),
    job_url: el("jobUrl").value.trim() || null,
    job_description: el("jobDescription").value.trim(),
  };
  if (!body.company || !body.job_description) {
    genResultEl.textContent = "Fill in company and job description first.";
    return;
  }
  el("generateBtn").disabled = true;
  try {
    const providerValue = el("providerSelect").value;
    if (providerValue === "gpt-auto" || providerValue === "gpt-auto-headless") {
      // Same prompt-building the manual "Copy prompt for GPT" flow uses - the only difference
      // from here is WHO submits it (a real ChatGPT tab, automatically, instead of you pasting
      // it in yourself) and how the reply gets back into this page. "gpt-auto-headless" uses
      // companion-service's own out-of-band Playwright browser instead of a visible tab -
      // experimental, see runChatGptPromptHeadless's own comment for why it's kept separate.
      const isHeadless = providerValue === "gpt-auto-headless";
      genResultEl.textContent = "Building prompt...";
      const promptData = await apiFetch("/prompt-preview", { method: "POST", body: JSON.stringify(body) });
      lastSavedDir = promptData.saved_dir;
      lastSavedDirCompany = body.company;

      genResultEl.textContent = isHeadless
        ? "Generating via the headless ChatGPT browser (this can take a little while)..."
        : "Opening ChatGPT tab and generating (this can take a little while)...";
      const combined = `${promptData.system_prompt}\n\n${promptData.user_message}`;
      const { delete_gpt_conversations: deleteConversation = true } = await apiFetch("/settings");
      const baseStatus = genResultEl.textContent;
      const rawResponse = isHeadless
        ? await runChatGptPromptHeadless(combined, deleteConversation)
        : await runChatGptPrompt(combined, deleteConversation, (step) => {
            genResultEl.textContent = `${baseStatus}\n[${new Date().toLocaleTimeString()}] ${step}`;
          });

      let parsed;
      try {
        parsed = JSON.parse(sanitizeJsonControlChars(stripJsonFences(rawResponse)));
      } catch (err) {
        throw new Error(`ChatGPT's reply wasn't valid JSON (${err.message}). Raw reply: ${rawResponse.slice(0, 300)}`);
      }
      const missing = validateResumeShape(parsed);
      if (missing.length) {
        throw new Error(`ChatGPT's reply doesn't match the expected resume shape. Missing/wrong: ${missing.join(", ")}`);
      }

      el("resumeJson").value = JSON.stringify(parsed, null, 2);
      updateRenderButtonState();
      genResultEl.textContent = `Generated via ChatGPT for ${parsed.name || body.company}. Review/edit the JSON below, then Generate PDF.`;
    } else {
      genResultEl.textContent = "Generating (calls Claude, takes a few seconds)...";
      const data = await apiFetch("/generate", { method: "POST", body: JSON.stringify(body) });
      el("resumeJson").value = JSON.stringify(data.resume, null, 2);
      lastSavedDir = data.saved_dir;
      lastSavedDirCompany = body.company;
      updateRenderButtonState();
      genResultEl.textContent = `Generated for ${data.resume.name} (~$${(data.total_cost_usd ?? 0).toFixed(4)}). Review/edit the JSON below, then Generate PDF.`;
    }
  } catch (err) {
    genResultEl.textContent = `Generation failed: ${err.message}`;
  } finally {
    el("generateBtn").disabled = false;
  }
});

el("copyPromptBtn").addEventListener("click", async () => {
  const genResultEl = el("generateResult");
  const body = {
    company: el("company").value.trim(),
    job_url: el("jobUrl").value.trim() || null,
    job_description: el("jobDescription").value.trim(),
  };
  if (!body.company || !body.job_description) {
    genResultEl.textContent = "Fill in company and job description first.";
    return;
  }
  genResultEl.textContent = "Building prompt...";
  el("copyPromptBtn").disabled = true;
  try {
    const data = await apiFetch("/prompt-preview", { method: "POST", body: JSON.stringify(body) });
    const combined = `${data.system_prompt}\n\n${data.user_message}`;
    await navigator.clipboard.writeText(combined);
    // Same JD.txt/link.txt/Prompt(used).txt paper trail "Generate JSON" leaves, saved as soon
    // as the prompt is actually used (not just built) - confirmed live, this manual flow
    // previously saved nothing until "Generate PDF", and even then only resume_data.json +
    // the docx/pdf. Tracking saved_dir here too means a later render for this company reuses
    // the same folder instead of creating a second one.
    lastSavedDir = data.saved_dir;
    lastSavedDirCompany = body.company;
    genResultEl.textContent =
      "Prompt copied to clipboard. Paste it into ChatGPT, then paste its JSON reply into the box below.";
  } catch (err) {
    genResultEl.textContent = `Could not build prompt: ${err.message}`;
  } finally {
    el("copyPromptBtn").disabled = false;
  }
});

el("renderBtn").addEventListener("click", async () => {
  const resultEl = el("result");
  let resume;
  try {
    resume = JSON.parse(el("resumeJson").value);
  } catch (err) {
    resultEl.textContent = `That's not valid JSON: ${err.message}`;
    return;
  }
  const missing = validateResumeShape(resume);
  if (missing.length) {
    resultEl.innerHTML = `This JSON doesn't match the expected resume shape. Missing/wrong: <br><code>${missing.join("<br>")}</code>`;
    return;
  }
  const company = el("company").value.trim();
  if (!company) {
    resultEl.textContent = "Fill in company first.";
    return;
  }
  resultEl.textContent = "Rendering PDF...";
  el("renderBtn").disabled = true;
  const reuseDir = company === lastSavedDirCompany ? lastSavedDir : null;
  try {
    const data = await apiFetch("/render", {
      method: "POST",
      body: JSON.stringify({ resume, company, saved_dir: reuseDir }),
    });
    lastSavedDir = data.saved_dir;
    lastSavedDirCompany = company;
    // docx_path and pdf_path are the same folder, just a different filename extension -
    // showing both in full was redundant noise; the folder alone is what's actually useful.
    resultEl.innerHTML = `Saved to:<br><code>${data.saved_dir}</code>`;
    if (data.pdf_base64) {
      const filename = (data.pdf_path || "").split(/[\\/]/).pop() || "resume.pdf";
      lastGeneratedPdf = { base64: data.pdf_base64, filename };
      await openPdfPreview(data.pdf_base64);
    }
  } catch (err) {
    resultEl.textContent = `Render failed: ${err.message}`;
  } finally {
    updateRenderButtonState();
  }
});

function getTailoredResumeIfAny() {
  // Only attach tailored resume JSON when the side panel actually has one (Generate JSON /
  // paste). Used as extra grounded context for Auto Fill answer/select prompts in tailor mode.
  const raw = el("resumeJson") && el("resumeJson").value.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function coerceSelectAnswer(answer, options) {
  if (!answer || !options || !options.length) return null;
  const target = String(answer).trim();
  const exact = options.find((o) => o === target);
  if (exact) return exact;
  const lower = target.toLowerCase();
  const ci = options.find((o) => o.toLowerCase() === lower);
  if (ci) return ci;
  return options.find((o) => o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase())) || null;
}

// Checkbox multi-selects may return "GRPC, RabbitMQ" — resolve each segment to a real option.
function coerceSelectAnswers(answer, options, multi) {
  if (!multi) {
    const one = coerceSelectAnswer(answer, options);
    return one ? [one] : [];
  }
  const parts = String(answer || "")
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const picked = [];
  const seen = new Set();
  for (const part of parts.length ? parts : [String(answer || "").trim()]) {
    const one = coerceSelectAnswer(part, options);
    if (!one) continue;
    const key = one.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(one);
  }
  return picked;
}

el("autofillBtn").addEventListener("click", async () => {
  const resultEl = el("autofillResult");
  resultEl.textContent = "Detecting fields...";
  el("autofillBtn").disabled = true;
  try {
    const [profile, qaBank, settings] = await Promise.all([apiFetch("/profile"), apiFetch("/qa"), apiFetch("/settings")]);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // field-detector.js defines the shared DETECT logic (label resolution, visibility,
    // group/combobox collection) as page globals - runAutofillInPage and runLearnInPage both
    // call the same collectFormFields() from it rather than each carrying an independently-
    // drifting copy, so injected first here on every frame.
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["field-detector.js"] });
    const injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: runAutofillInPage,
      args: [profile, qaBank],
    });
    const valid = injections.filter((i) => i.result);
    let filledCount = valid.reduce((sum, i) => sum + i.result.filled.length, 0);
    const allUnmatched = valid.flatMap((i) => (i.result.unmatched || []).map((u) => ({ ...u, frameId: i.frameId })));

    // Every non-consent unmatched field got stamped with an idx (see runAutofillInPage),
    // whether or not it's eligible for generation — a select/combobox can never safely be
    // generated into, but can still be correctly filled from a real saved answer if the AI
    // match below finds one.
    const idxEligible = allUnmatched.filter((u) => u.idx !== undefined);

    const finalFills = []; // { frameId, idx, value, kind: "matched" | "generated" }
    const matchErrors = [];
    const gptAutoProvider =
      settings.answer_provider === "gpt-auto" || settings.answer_provider === "gpt-auto-headless";
    let generationCandidates = idxEligible.filter(
      (u) => u.canGenerate || (gptAutoProvider && u.gptBatchEligible)
    );
    // GPT/select-pick prompts must never include placeholder chrome like "Select One", and a
    // dropdown with only that left after filtering isn't a real pick. Optional selects are
    // already excluded upstream (only required comboboxes/selects get `options` stamped).
    // Confirmed live on agilent.wd5: a mis-grouped EEO block sent options: ["Select One", ...]
    // into the GPT prompt.
    const isSelectPlaceholderOption = (text) =>
      /^-*\s*(please\s+)?(select|choose)(\s+(one|an\s+option))?\s*\.{0,3}-*$/i.test(String(text || "").trim());
    const realSelectOptions = (options) => {
      if (!Array.isArray(options)) return [];
      const seen = new Set();
      const out = [];
      for (const o of options) {
        const t = String(o || "").trim();
        if (!t || isSelectPlaceholderOption(t)) continue;
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
      return out;
    };
    let selectPickCandidates = idxEligible
      .filter((u) => Array.isArray(u.options))
      .map((u) => ({ ...u, options: realSelectOptions(u.options) }))
      .filter((u) => u.options.length > 1);
    const tailoredResume = getTailoredResumeIfAny();

    // gpt-auto skips server /match-answers — run the same local category/word-overlap matcher
    // again on stamped fields (catches combobox timing failures and wording variants the first
    // in-page pass missed after a failed fillReactSelectByClick).
    if (
      idxEligible.length &&
      qaBank.length &&
      (settings.answer_provider === "gpt-auto" || settings.answer_provider === "gpt-auto-headless")
    ) {
      const localMatched = new Set();
      for (const item of idxEligible) {
        // skipQaMatch marks fields (currently just Greenhouse's phone dial-code picker) whose
        // only correct value comes directly from the profile, never from a saved/learned QA-bank
        // answer - a stale bad entry saved for this exact label before this flag existed would
        // otherwise keep getting silently reapplied here forever, regardless of any other fix.
        if (item.skipQaMatch) continue;
        const entry = matchQaBankEntry(item.label, qaBank);
        if (entry && isPlausibleQaMatch(item.label, entry.question)) {
          finalFills.push({
            frameId: item.frameId,
            idx: item.idx,
            value: entry.answer,
            kind: "matched",
            label: item.label,
          });
          localMatched.add(item);
        }
      }
      generationCandidates = generationCandidates.filter((item) => !localMatched.has(item));
      selectPickCandidates = selectPickCandidates.filter((item) => !localMatched.has(item));
    }

    // gpt-auto has no automatic AI-semantic QA-bank match (no server-side model call for it
    // yet) - the free, non-AI exact/category matching in runAutofillInPage already ran above
    // regardless of provider, so this just skips the EXTRA semantic-similarity layer for it.
    if (
      idxEligible.length &&
      qaBank.length &&
      settings.answer_provider !== "gpt" &&
      settings.answer_provider !== "gpt-auto" &&
      settings.answer_provider !== "gpt-auto-headless"
    ) {
      resultEl.textContent = `Checking saved answers for a semantic match (${idxEligible.length} question(s))...`;
      try {
        // skipQaMatch-flagged fields (Greenhouse's phone dial-code picker) must never get a
        // server-side "semantic match" answer either - if anything, this AI-semantic layer is
        // an even looser matcher than the local word-overlap one skipped for gpt-auto above, so
        // the same stale-bad-QA-bank-entry risk applies at least as much here.
        const matchable = idxEligible.filter((u) => !u.skipQaMatch);
        const data = matchable.length
          ? await apiFetch("/match-answers", {
              method: "POST",
              body: JSON.stringify({ questions: matchable.map((u) => u.label) }),
            })
          : { results: [] };
        const matchedIdxSet = new Set();
        matchable.forEach((item, i) => {
          const result = data.results[i];
          if (result && result.matched && isPlausibleQaMatch(item.label, result.matched_question)) {
            finalFills.push({ frameId: item.frameId, idx: item.idx, value: result.answer, kind: "matched", label: item.label });
            matchedIdxSet.add(item);
          }
        });
        // Anything the AI step resolved no longer needs generation / select-picking.
        generationCandidates = generationCandidates.filter((item) => !matchedIdxSet.has(item));
        selectPickCandidates = selectPickCandidates.filter((item) => !matchedIdxSet.has(item));
      } catch (err) {
        matchErrors.push(err.message);
        // Degrade gracefully — a failed match check shouldn't block generation for whatever
        // was already eligible for it.
      }
    }

    const generationErrors = [];
    const gptManualNote =
      settings.answer_provider === "gpt" && (generationCandidates.length || selectPickCandidates.length)
        ? ` "gpt" (manual) answer provider — use "Copy prompt for GPT" per question for: ${[
            ...generationCandidates,
            ...selectPickCandidates,
          ]
            .map((g) => g.label)
            .join(", ")}.`
        : "";

    // Free-text generation + required multi-option select picks, via the same answer_provider.
    const aiCandidates = [
      ...generationCandidates.map((c) => ({ ...c, kind: "text" })),
      ...selectPickCandidates.map((c) => ({ ...c, kind: "select", multi: Boolean(c.multi) })),
    ];

    if (aiCandidates.length && (settings.answer_provider === "gpt-auto" || settings.answer_provider === "gpt-auto-headless")) {
      const isHeadless = settings.answer_provider === "gpt-auto-headless";
      const jobDescription = el("jobDescription").value.trim();
      const company = el("company").value.trim();
      resultEl.textContent = `Building a batched prompt for ${aiCandidates.length} question(s)...`;
      try {
        const promptData = await apiFetch("/prompt-preview-answers", {
          method: "POST",
          body: JSON.stringify({
            questions: aiCandidates.map((c) => c.label),
            job_description: jobDescription,
            company,
            options_per_question: aiCandidates.map((c) => (c.kind === "select" ? c.options : null)),
            multi_per_question: aiCandidates.map((c) => (c.kind === "select" ? Boolean(c.multi) : false)),
            resume: tailoredResume,
          }),
        });
        resultEl.textContent = isHeadless
          ? "Generating answers via the headless ChatGPT browser (this can take a little while)..."
          : "Opening ChatGPT tab and generating answers (this can take a little while)...";
        const combined = `${promptData.system_prompt}\n\n${promptData.user_message}`;
        const baseStatus = resultEl.textContent;
        const rawResponse = isHeadless
          ? await runChatGptPromptHeadless(combined, settings.delete_gpt_conversations !== false)
          : await runChatGptPrompt(combined, settings.delete_gpt_conversations !== false, (step) => {
              resultEl.textContent = `${baseStatus}\n[${new Date().toLocaleTimeString()}] ${step}`;
            });

        let answers;
        try {
          const parsed = JSON.parse(sanitizeJsonControlChars(stripJsonFences(rawResponse)));
          answers = parsed.answers;
          if (!Array.isArray(answers)) throw new Error('Expected an "answers" array');
        } catch (err) {
          throw new Error(`ChatGPT's reply wasn't in the expected shape (${err.message}). Raw reply: ${rawResponse.slice(0, 300)}`);
        }
        // Matched back to aiCandidates by ChatGPT's OWN declared question_number now, not by
        // array position - previously answers[i] was matched to aiCandidates[i] purely by
        // position (the prompt asked for "one entry per question, in the same order", but
        // nothing here ever verified ChatGPT actually honored that). If its reply was ever even
        // ONE entry short, extra, or reordered, EVERY answer after that point would silently
        // shift onto the WRONG question - reported live as one skill-level answer landing on a
        // completely different question, and several questions after it in the same batch
        // ending up totally unfilled. Having each answer self-identify which question it
        // belongs to means one missing/misplaced answer only affects that ONE question - it
        // can't cascade and corrupt every answer after it the way positional mapping could.
        // Falls back to this entry's own array position when question_number is missing/invalid,
        // rather than rejecting it outright - confirmed live, the companion-service is a separate
        // process that doesn't auto-reload, so it can still be serving an OLDER prompt that never
        // asked ChatGPT for question_number at all, in which case EVERY answer would be missing
        // it through no fault of ChatGPT's own. Falling back to position for just that one entry
        // keeps the old (still correct, as long as counts genuinely match) behavior working
        // exactly as before whenever question_number isn't there to rely on, while still using it
        // to guard against misalignment whenever it IS present.
        const byQuestionNumber = new Map();
        answers.forEach((ans, i) => {
          const n = Number(ans && ans.question_number);
          const key = Number.isInteger(n) && n >= 1 && n <= aiCandidates.length ? n : i + 1;
          if (!byQuestionNumber.has(key)) byQuestionNumber.set(key, ans);
        });
        aiCandidates.forEach((item, i) => {
          const ans = byQuestionNumber.get(i + 1);
          if (!ans || ans.answerable === false || !ans.answer) return;
          let value = ans.answer;
          if (item.kind === "select") {
            const picked = coerceSelectAnswers(value, item.options, Boolean(item.multi));
            if (!picked.length) return;
            value = picked.join(", ");
          }
          finalFills.push({ frameId: item.frameId, idx: item.idx, value, kind: "generated", label: item.label });
        });
      } catch (err) {
        generationErrors.push(`GPT (auto): ${err.message}`);
      }
    } else if (aiCandidates.length && settings.answer_provider !== "gpt") {
      const jobDescription = el("jobDescription").value.trim();
      const company = el("company").value.trim();
      for (let i = 0; i < aiCandidates.length; i++) {
        const item = aiCandidates[i];
        resultEl.textContent =
          item.kind === "select"
            ? `Picking dropdown option ${i + 1}/${aiCandidates.length}: "${item.label}"...`
            : `Generating answer ${i + 1}/${aiCandidates.length}: "${item.label}"...`;
        try {
          const data = await apiFetch("/generate-answer", {
            method: "POST",
            body: JSON.stringify({
              question: item.label,
              job_description: jobDescription,
              company,
              options: item.kind === "select" ? item.options : null,
              resume: tailoredResume,
            }),
          });
          if (data.answerable !== false && data.answer) {
            let value = data.answer;
            if (item.kind === "select") {
              const picked = coerceSelectAnswers(value, item.options, Boolean(item.multi));
              if (!picked.length) continue;
              value = picked.join(", ");
            }
            finalFills.push({ frameId: item.frameId, idx: item.idx, value, kind: "generated", label: item.label });
          }
        } catch (err) {
          generationErrors.push(`${item.label}: ${err.message}`);
        }
      }
    }

    let matchedCount = 0;
    let generatedCount = 0;
    const byFrame = new Map();
    if (finalFills.length) {
      resultEl.textContent = "Filling in answers...";
      // Re-inject field-detector so label rematch works if the apply drawer remounted
      // (Workable) and wiped data-af-idx stamps while ChatGPT was generating.
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["field-detector.js"] });
      for (const f of finalFills) {
        if (!byFrame.has(f.frameId)) byFrame.set(f.frameId, []);
        byFrame.get(f.frameId).push({ idx: f.idx, value: f.value, label: f.label || "" });
      }
      for (const [frameId, answers] of byFrame) {
        const fillResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [frameId] },
          func: fillGeneratedAnswersInPage,
          args: [answers],
        });
        filledCount += fillResults.reduce((sum, r) => sum + (r.result ? r.result.count : 0), 0);
      }
      matchedCount = finalFills.filter((f) => f.kind === "matched").length;
      generatedCount = finalFills.filter((f) => f.kind === "generated").length;
    }

    // Any idx-eligible field whose frame got no matches/generations at all (match-answers found
    // nothing, generation errored for every candidate, or the "gpt" manual provider skipped
    // generation entirely) never appears in finalFills, so the byFrame loop above never runs for
    // that frame and its data-af-idx stamps are left behind in the live DOM. Confirmed live on a
    // BambooHR form: a stray data-af-idx="0" survived on an unrelated field after such a run.
    // Beyond DOM clutter, a stale stamp risks colliding with a fresh idx from the next Autofill
    // run (idx numbering restarts at 0 each run), so every idx-eligible frame gets swept here
    // even when it had nothing to fill.
    const sweptFrameIds = new Set(byFrame.keys());
    const strayFrameIds = new Set(idxEligible.map((item) => item.frameId).filter((id) => !sweptFrameIds.has(id)));
    for (const frameId of strayFrameIds) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [frameId] },
        func: fillGeneratedAnswersInPage,
        args: [[]],
      });
    }

    // Final defensive re-check (see checkPhoneCountryPickerInPage's own comment for the full
    // trace) - Greenhouse's own app has been confirmed, live, to independently reset its phone
    // dial-code picker at some point DURING a run via its own deferred React scheduler, unrelated
    // to anything this extension directly does. Runs once, across all frames, only after every
    // other field on the page has already been processed - "outlasts" whatever mid-run reset
    // Greenhouse's own app does, rather than trying to prevent something outside this extension's
    // control. Best-effort: must never block or fail the rest of Auto Fill's own reporting.
    let phoneCountryRefixed = false;
    try {
      const checkResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: checkPhoneCountryPickerInPage,
        args: [profile],
      });
      if (checkResults.some((r) => r.result && r.result.wasWrong)) {
        // Re-runs runAutofillInPage itself rather than a separate, weaker re-implementation -
        // it's the same code that already commits this field correctly via real clicks earlier
        // in the run (a standalone fiber-only re-fill attempt was tried and confirmed live NOT
        // to work - see checkPhoneCountryPickerInPage's own comment). Most other fields' own
        // fillSingle/isReactSelectAlreadySet checks short-circuit quickly when already correct,
        // so this mainly just re-does the one thing that's actually still wrong.
        // Re-injected defensively first, same as before fillGeneratedAnswersInPage above -
        // runAutofillInPage depends on field-detector.js's own globals (collectFormFields etc.),
        // which could be gone if anything remounted the page's own DOM since the first run.
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["field-detector.js"] });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: runAutofillInPage,
          args: [profile, qaBank],
        });
        const recheckResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: checkPhoneCountryPickerInPage,
          args: [profile],
        });
        phoneCountryRefixed = recheckResults.some((r) => r.result && r.result.checked && !r.result.wasWrong);
      }
    } catch {
      /* best-effort - a failure here shouldn't affect anything else Auto Fill already did */
    }

    const filledKeys = new Set(finalFills.map((f) => `${f.frameId}:${f.idx}`));
    const shouldReportNeedsHuman = (u) => {
      const lab = (u.label || "").trim();
      if (u.type === "password") return false;
      if (/^(choose password|retype password|middle name|notification|hear more about career opportunities|powered by peopleforce)$/i.test(lab)) {
        return false;
      }
      return true;
    };
    const needsHuman = allUnmatched
      .filter((u) => u.idx === undefined || !filledKeys.has(`${u.frameId}:${u.idx}`))
      .filter(shouldReportNeedsHuman);

    const generatedNote = [matchedCount && `${matchedCount} matched`, generatedCount && `${generatedCount} generated`]
      .filter(Boolean)
      .join(", ");
    resultEl.textContent = `Filled ${filledCount} field(s)${generatedNote ? ` (${generatedNote})` : ""}.${
      needsHuman.length
        ? ` ${needsHuman.length} need your input: ${needsHuman.map((u) => u.label || "(no label)").join(", ")}.`
        : ""
    }${matchErrors.length ? ` Saved-answer check failed: ${matchErrors.join("; ")}.` : ""}${
      generationErrors.length ? ` ${generationErrors.length} generation failure(s): ${generationErrors.join("; ")}.` : ""
    }${phoneCountryRefixed ? " Corrected the phone country code, which the site's own app reset mid-run." : ""}${gptManualNote}`;
  } catch (err) {
    resultEl.textContent = `Auto Fill failed: ${err.message}`;
  } finally {
    el("autofillBtn").disabled = false;
  }
});

// A separate, explicit step from Auto Fill — attaching a file to the page is more consequential
// than filling text (it's what actually gets submitted), so it only runs when clicked, never as
// a side effect of Auto Fill. Works on any site now (not just Workday) — the targeting logic in
// attachResumeFileInPage itself is what tells the real "Resume" field apart from a site's own
// "autofill your whole application from your resume" convenience widget, which only Workday
// actually wants targeted (it's the mandatory first step of that specific flow there).
el("attachResumeBtn").addEventListener("click", async () => {
  const resultEl = el("attachResumeResult");
  el("attachResumeBtn").disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const nonTailorVisible = el("nonTailorSection").style.display !== "none";
    let resumeSource = null;
    if (nonTailorVisible) {
      const resumeId = el("resumeSelect").value;
      if (resumeId) resumeSource = await fetchResumeFileBase64(resumeId);
      if (!resumeSource) {
        resultEl.textContent = "Pick a resume in the dropdown above first.";
        return;
      }
      // Prefer the filename from the /resumes list (option dataset) over Content-Disposition —
      // names with spaces only come back as filename*= and used to parse as the bare fallback
      // "resume" (shown on some ATS upload widgets as ".resume"). Confirmed for Stefan Iacob
      // stack resumes ("Stefan Iacob.pdf"); profiles whose files had no spaces were unaffected.
      const selectedOpt = el("resumeSelect").selectedOptions && el("resumeSelect").selectedOptions[0];
      const listFilename = selectedOpt && selectedOpt.dataset && selectedOpt.dataset.filename;
      if (listFilename) resumeSource.filename = listFilename;
    } else if (lastGeneratedPdf) {
      resumeSource = { base64: lastGeneratedPdf.base64, filename: lastGeneratedPdf.filename, mimeType: "application/pdf" };
    } else {
      resultEl.textContent = "Click Generate PDF first.";
      return;
    }
    resultEl.textContent = "Attaching...";
    const attachResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: attachResumeFileInPage,
      args: [resumeSource.base64, resumeSource.filename, resumeSource.mimeType, isWorkdayHostname(new URL(tab.url).hostname)],
    });
    const attached = attachResults.some((i) => i.result && i.result.attached);
    if (attached) {
      const hit = attachResults.find((i) => i.result && i.result.attached);
      const labelNote = hit.result.label ? ` → ${hit.result.label}` : "";
      resultEl.textContent = `Resume file attached (${resumeSource.filename})${labelNote}.`;
    } else {
      const reason =
        attachResults.map((i) => i.result && i.result.reason).filter(Boolean)[0] ||
        "No Resume/CV upload field found on this page.";
      resultEl.textContent = reason;
    }
  } catch (err) {
    resultEl.textContent = `Attach failed: ${err.message}`;
  } finally {
    el("attachResumeBtn").disabled = false;
  }
});

el("learnBtn").addEventListener("click", async () => {
  const resultEl = el("autofillResult");
  resultEl.textContent = "Learning...";
  el("learnBtn").disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Same shared field-detector.js Auto Fill uses (see its handler above) - Learn calls the
    // identical collectFormFields(), so it can't find a different set of fields than Auto Fill
    // did, or resolve a label differently, on the same page.
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["field-detector.js"] });
    const injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: runLearnInPage,
    });
    const learnedPairs = injections.filter((i) => i.result).flatMap((i) => i.result);
    if (!learnedPairs.length) {
      resultEl.textContent = "Nothing to learn — no filled-in fields found on this page.";
      return;
    }
    const existing = await apiFetch("/qa");
    const merged = mergeQaEntries(existing, learnedPairs);
    await apiFetch("/qa", { method: "PUT", body: JSON.stringify(merged) });
    resultEl.textContent = `Learned ${merged.length - existing.length} new answer(s) (${merged.length} total saved).`;
  } catch (err) {
    resultEl.textContent = `Learn failed: ${err.message}`;
  } finally {
    el("learnBtn").disabled = false;
  }
});

el("saveSampleBtn").addEventListener("click", async () => {
  const resultEl = el("saveSampleResult");
  resultEl.textContent = "Capturing...";
  el("saveSampleBtn").disabled = true;
  try {
    const [profile, qaBank] = await Promise.all([apiFetch("/profile"), apiFetch("/qa")]);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Same shared field-detector.js Auto Fill/Learn use (see their handlers) - a captured
    // sample previously ran its own separately-drifting copy of detection, so it could report
    // fields/labels that no longer matched what a real Auto Fill run would actually see.
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["field-detector.js"] });
    const injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: captureSampleInPage,
      args: [profile, qaBank],
    });
    const valid = injections.filter((i) => i.result);
    if (!valid.length) {
      resultEl.textContent = "Nothing captured — this page may block script injection.";
      return;
    }
    const body = {
      page_url: tab.url || "",
      frames: valid.map((i) => ({
        frame_id: i.frameId,
        url: i.result.url,
        html: i.result.html,
        fields: i.result.fields,
      })),
    };
    const data = await apiFetch("/save-sample", { method: "POST", body: JSON.stringify(body) });
    resultEl.textContent = `Saved ${data.saved.length} file(s): ${data.saved.join(", ")}`;
  } catch (err) {
    resultEl.textContent = `Save Sample failed: ${err.message}`;
  } finally {
    el("saveSampleBtn").disabled = false;
  }
});

// Shared by Mode + both provider selects below: PUT /settings replaces the whole object, so
// each fetches the current one first and only changes its own field - otherwise switching one
// (e.g. the answer provider) would silently reset everything else (prompt instructions,
// apply-root folder, model names, the OTHER provider, ...) back to whatever this fetch saw.
async function patchSetting(key, value, label) {
  const statusEl = el("providerStatus");
  statusEl.textContent = "Saving...";
  try {
    const settings = await apiFetch("/settings");
    settings[key] = value;
    await apiFetch("/settings", { method: "PUT", body: JSON.stringify(settings) });
    await applyTailorMode();
    statusEl.textContent = `${label}: ${value}.`;
  } catch (err) {
    statusEl.textContent = `Could not save: ${err.message}`;
  }
}

// Separate endpoint from /settings (per-person, not global - see applyTailorMode's own
// comment), so this can't go through patchSetting like the three selects below.
el("tailorModeSelect").addEventListener("change", async () => {
  const statusEl = el("providerStatus");
  const tailorMode = el("tailorModeSelect").value === "true";
  statusEl.textContent = "Saving...";
  try {
    await apiFetch("/tailor-mode", { method: "PUT", body: JSON.stringify({ tailor_mode: tailorMode }) });
    await applyTailorMode();
    statusEl.textContent = `Mode: ${tailorMode}.`;
  } catch (err) {
    statusEl.textContent = `Could not save: ${err.message}`;
  }
});
el("providerSelect").addEventListener("change", () =>
  patchSetting("provider", el("providerSelect").value, "Resume provider")
);
el("answerProviderSelect").addEventListener("change", () =>
  patchSetting("answer_provider", el("answerProviderSelect").value, "Answer provider")
);
el("deleteGptConversationsToggle").addEventListener("change", () =>
  patchSetting("delete_gpt_conversations", el("deleteGptConversationsToggle").checked, "Delete ChatGPT conversation")
);
// Inverted (checkbox means "show the window") - patchSetting itself just stores the raw value,
// so the actual portal_headless field being saved is the opposite of what's checked.
el("portalHeadful").addEventListener("change", () => patchSetting("portal_headless", !el("portalHeadful").checked, "Portal sync headless"));

// Separate endpoint from /settings (resume templates are per-person, not global - see
// resume_templates.py), so this can't go through patchSetting like the three selects above.
el("templateSelect").addEventListener("change", async () => {
  const statusEl = el("providerStatus");
  const template = el("templateSelect").value;
  statusEl.textContent = "Saving...";
  try {
    await apiFetch("/resume-template", { method: "PUT", body: JSON.stringify({ template }) });
    statusEl.textContent = `Resume template: ${el("templateSelect").selectedOptions[0].textContent}.`;
  } catch (err) {
    statusEl.textContent = `Could not save: ${err.message}`;
  }
});

// Sticky across the whole side panel session (and browser restarts) rather than per-job -
// confirmed live, applications are worked through in batches from one source at a time
// (a list of LinkedIn links, then a separate list of Indeed links, ...), so re-picking the
// platform for every single job would be pure friction; you flip it once when you switch
// batches instead. chrome.storage.local (not the backend /settings) since this is a
// per-browser session preference, not a per-person profile fact.
async function loadStickyPlatform() {
  const { portalPlatform } = await chrome.storage.local.get(["portalPlatform"]);
  if (portalPlatform) el("platformSelect").value = portalPlatform;
}
el("platformSelect").addEventListener("change", () => {
  chrome.storage.local.set({ portalPlatform: el("platformSelect").value });
});
loadStickyPlatform();

// Explicitly requested: picking a platform in one already-open tab's panel should update every
// OTHER already-open tab's own panel too, not just apply to tabs opened later - working through
// a batch of jobs from the same source often means several tabs are already open at once.
// chrome.storage.local itself is already shared browser-wide, but each panel only ever read it
// ONCE at its own load time - this reacts live to a change made in a DIFFERENT tab's panel.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.portalPlatform) {
    el("platformSelect").value = changes.portalPlatform.newValue;
  }
});

// Pushes one application's record into the local per-person/per-day log a separate
// end-of-day pass reads back to push into the Portal (see PortalLogEntry/compute_person_day_dir
// on the companion-service side) - a manual, explicit action rather than firing automatically
// off Generate JSON/Auto Fill, since not every generation is a real application you want
// tracked (tailoring experiments, re-runs, etc.).
function buildPortalLogEntryFromPanel() {
  // Read directly off the DOM rather than re-fetching /tailor-mode - applyTailorMode() already
  // keeps tailorSection/nonTailorSection's visibility in sync with the real per-person value,
  // so whichever one is actually showing IS the current tailor mode.
  const tailor = el("tailorSection").style.display !== "none";
  let resumeStack;
  let description;
  if (tailor) {
    // Resume dropdown always picks "Full" for a tailored bid regardless of the job's own
    // tech stack, since the resume itself was generated fresh for this specific posting
    // rather than picked from a fixed set of pre-made stack-labeled resumes. Description is
    // the literal word "Tailor" (NOT the stack name) - confirmed live against real existing
    // Portal rows: the specific stack already shows separately via the Resume column's own
    // "[Full]"/"[Java]" bracket, so Description just marks the bid TYPE (tailored or not),
    // same convention already used by real, pre-existing entries in the Portal.
    resumeStack = "Full";
    description = "Tailor";
  } else {
    const selectedOption = el("resumeSelect").selectedOptions[0];
    resumeStack = (selectedOption && selectedOption.dataset.stack) || "";
    description = resumeStack ? `${resumeStack} - not tailor` : "not tailor";
  }
  return {
    platform: el("platformSelect").value,
    company: el("company").value.trim(),
    job_title: el("jobTitle").value.trim(),
    url: el("jobUrl").value.trim(),
    tailor,
    resume_stack: resumeStack,
    description,
  };
}

// One button, one action: writes today's local log entry AND pushes it into the real Portal
// in a single click - merged from two separate buttons/steps now that the Portal push itself
// (companion-service's /portal-sync, a real out-of-band headless Chromium browser via
// Playwright) is confirmed working live. The actual Portal automation now runs entirely
// server-side - no chrome.tabs/chrome.scripting involved at all, so this never hijacks or
// even opens any tab the user can see.
el("portalLogBtn").addEventListener("click", async () => {
  const resultEl = el("portalLogResult");
  resultEl.textContent = "Saving...";
  el("portalLogBtn").disabled = true;
  try {
    const profile = await apiFetch("/profile");
    const entry = buildPortalLogEntryFromPanel();
    if (!entry.company || !entry.job_title || !entry.url) {
      resultEl.textContent = "Fill in Company, Job Title, and Job URL first.";
      return;
    }

    const logResult = await apiFetch("/portal-log", { method: "POST", body: JSON.stringify(entry) });
    resultEl.textContent = `Saved to today's Portal log for ${profile.contact.name || "this profile"} - syncing to the Portal...`;

    try {
      const outcome = await apiFetch("/portal-sync", { method: "POST", body: JSON.stringify(entry) });
      if (outcome && outcome.ok) {
        await apiFetch("/portal-log/mark-synced", { method: "POST", body: JSON.stringify({ indices: [logResult.index] }) });
        resultEl.textContent = outcome.alreadyExists
          ? `Already in the Portal (same profile + today's date) - saved locally, not adding a duplicate: ${entry.company} - ${entry.job_title}.`
          : `Saved and synced to the Portal: ${entry.company} - ${entry.job_title}.`;
      } else {
        resultEl.textContent = `Saved locally, but the Portal push failed: ${(outcome && outcome.error) || "unknown error"}.`;
      }
    } catch (syncErr) {
      resultEl.textContent = `Saved locally, but the Portal push failed: ${syncErr.message}`;
    }
  } catch (err) {
    resultEl.textContent = `Could not save: ${err.message}`;
  } finally {
    el("portalLogBtn").disabled = false;
  }
});

refreshStatus();
applyTailorMode();
scrapeCurrentTab();

// The side panel stays open/docked across tab switches, so it never unloads when
// you go edit Settings in another tab — pick up changes when the window (or this
// panel) regains focus instead of requiring an explicit refresh every time.
window.addEventListener("focus", () => {
  refreshStatus();
  applyTailorMode();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshStatus();
    applyTailorMode();
  }
});

// Global keyboard shortcuts (manifest.json's "commands", relayed by background.js's
// chrome.commands.onCommand listener) - every open side panel instance receives this same
// broadcast, so `message.tabId !== myTabId` filters out every tab EXCEPT the one this specific
// panel belongs to, rather than every open panel acting on the shortcut at once.
const SHORTCUT_BUTTON_IDS = {
  "extract-from-page": "scrapeBtn",
  "generate-pdf": "renderBtn",
  "auto-fill": "autofillBtn",
  "learn-page": "learnBtn",
  "save-sample": "saveSampleBtn",
  "attach-resume": "attachResumeBtn",
  "portal-sync": "portalLogBtn",
  "open-settings": "settingsBtn",
  "refresh-panel": "refreshBtn",
};
// TEMPORARY diagnostic logging - see background.js's own note on the same investigation.
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "SHORTCUT") return;
  console.log("[shortcut-debug] panel received message:", message, "myTabId:", myTabId);
  if (message.tabId !== myTabId) {
    console.log("[shortcut-debug] ignored - not this panel's tab");
    return;
  }
  // "Generate JSON" and "Copy prompt for GPT" share one shortcut - only one of the two is ever
  // visible at a time (see applyTailorMode's isManualGpt toggle), so this fires whichever one
  // currently is, rather than needing a separate shortcut for each.
  const targetId =
    message.command === "generate-json"
      ? el("copyPromptBtn").style.display !== "none"
        ? "copyPromptBtn"
        : "generateBtn"
      : SHORTCUT_BUTTON_IDS[message.command];
  const btn = targetId && el(targetId);
  console.log("[shortcut-debug] target button:", targetId, "found:", !!btn, "disabled:", btn && btn.disabled, "hidden:", btn && btn.style.display === "none");
  if (btn && !btn.disabled && btn.style.display !== "none") btn.click();
});
