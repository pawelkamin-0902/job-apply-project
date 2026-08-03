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

  return (async () => {
    await revealSuccessFactorsAttachmentInputs();
    await revealHibobAttachmentInputs();
    await revealBambooHrAttachmentInputs();

    const candidates = collectFileInputs(document);
    let target = findBambooResumeFileInput();
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
    const upload = target.closest && target.closest('[data-fabric-component="FileUpload"]');
    return {
      attached: true,
      label: resolveFileInputLabel(target) || (upload ? bambooFileUploadLabel(upload) : "") || "",
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
  const WIDGET_HOST_RE = /(^|\.)hcaptcha\.com$|recaptcha|(^|\.)gstatic\.com$|captcha-assets\.|captcha-base\./i;
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

  function acceptDescription(text) {
    const t = (text || "").trim();
    if (t.length < 80) return "";
    if (looksLikeJsonBlob(t)) return "";
    return t.slice(0, 8000);
  }

  // og:/twitter:description often carry a usable (sometimes truncated) plain-text JD summary
  // in the pre-hydration HTML shell — confirmed on BambooHR, where those meta tags are present
  // in the initial document long before `.BambooRichText` / JobPosting JSON-LD are injected.
  function metaJobDescription() {
    for (const sel of ['meta[property="og:description"]', 'meta[name="twitter:description"]', 'meta[property="twitter:description"]']) {
      const el = document.querySelector(sel);
      const content = el && el.content && el.content.trim();
      const accepted = acceptDescription(content || "");
      if (accepted) return accepted;
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

    // 2. ATS-specific description containers — checked BEFORE generic `main`/`article`/
    // `#content`, because those broader landmarks often wrap chrome (nav, "Privacy Policy",
    // "Job Openings", department subtitle) around the real posting. Confirmed on BambooHR:
    // `main` scored longer than `.BambooRichText` and would otherwise win with a
    // "Privacy PolicyJob Openings..." prefix glued onto the real description. Purpose-built
    // class names are more trustworthy than "longest landmark wins".
    let best = pickBest(
      document.querySelectorAll(
        ".BambooRichText, .job-description, .jobDescription, .job__description, .posting-description, .opening-description"
      ),
      200
    );
    if (best) {
      const text = acceptDescription(cleanedText(best));
      if (text) return text;
    }

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
    const posting = jobPostingFromJsonLd();
    const orgName = posting && posting.hiringOrganization && posting.hiringOrganization.name;
    if (orgName) return String(orgName).trim();
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
    if (!/greenhouse\.io|lever\.co|myworkdayjobs\.com|smartrecruiters\.com|workable\.com|bamboohr\.com/i.test(fullHost)) {
      const label = fullHost.split(".")[0];
      if (label && label.length > 2) return label.charAt(0).toUpperCase() + label.slice(1);
    }
    return "";
  }

  function extractUrl() {
    // Canonical link avoids session/tracking query params that the raw tab URL may have.
    const canonical = document.querySelector('link[rel="canonical"]');
    return (canonical && canonical.href) || location.href;
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
    /^(apply( now)?|application( submitted)?|new application|careers?|career center|job application|job openings?|open positions?)$/i;

  // Strips a leading "Apply -"/"Apply |"/"Applying for "/"New Application |"/"Application -"/
  // "Candidate Profile -" boilerplate segment - safe to apply uniformly to headings AND
  // <title>/og:title, since it only ever matches one of these specific known apply-flow
  // phrases, never arbitrary title text. "Candidate Profile" confirmed live on an iCIMS
  // <title> ("Candidate Profile - Software Engineer (Jenkins & .NET)").
  function stripLeadingApplyBoilerplate(text) {
    return (text || "").replace(
      /^(apply(ing for)?|apply\s*now|new\s*application|job\s*application|application|candidate\s*profile)\s*[-|:]?\s*/i,
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
      const raw = (heading.innerText || "").trim();
      if (!raw || GENERIC_TITLE_RE.test(raw)) continue;
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

    for (const sel of [".job-ad-title"]) {
      const found = document.querySelector(sel);
      const text = found && found.innerText && found.innerText.trim();
      if (text && text.length > 2 && text.length < 150 && !GENERIC_TITLE_RE.test(text)) return text;
    }

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
      if (ogTitle && ogTitle.length > 2 && /\s/.test(ogTitle) && !GENERIC_TITLE_RE.test(ogTitle)) return ogTitle;
      const titleText = stripTrailingBoilerplate(stripLeadingApplyBoilerplate(document.title || ""));
      if (titleText && !GENERIC_TITLE_RE.test(titleText)) return titleText;
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
    const raw = `${resolveOwnLabel(element, host)} ${findGroupContextLabel(host || element) || ""}`;
    return /\(\s*required\s*\)/i.test(raw) || /[*•✱]/.test(raw);
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
    { re: /e-?mail/i, get: (p) => p.contact.email },
    // Negative lookahead excludes "Country Phone Code"/"Phone Device Type"/"Phone Extension" -
    // confirmed live, the plain `phone|mobile|telephone` match swallowed "Country Phone Code"
    // too and typed the full phone number into what's actually a country-code picker.
    {
      re: /^(?!.*\b(code|type|extension|device)\b).*\b(phone|mobile|telephone)\b/i,
      get: (p) => {
        const phone = p.contact.phone || "";
        if (!phone) return phone;
        // Zoho Recruit's <crux-phone-component> splits dial-code + local number; setPhoneValue
        // drives both from the full "+CC..." string against the widget's own country list.
        // Passing the already-stripped local digits would leave a wrong pre-selected dial
        // code (e.g. Romania +40 on a Polish +48 profile) untouched. Confirmed live on
        // manningglobal.zohorecruit.eu.
        if (document.querySelector("crux-phone-component, [lt-prop-user-value='dial_code']")) return phone;
        if (!hasSeparateCountryCodeField()) return phone;
        const code = findCountryCallingCode();
        return code && phone.startsWith(code) ? phone.slice(code.length).trim() : phone;
      },
    },
    { re: /linkedin/i, get: (p) => p.contact.linkedin },
    { re: /website|portfolio/i, get: (p) => p.contact.website },
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
    { re: /^first\s*name|^given\s*name/i, get: (p) => (p.contact.name || "").split(" ")[0] || "" },
    { re: /^last\s*name|^family\s*name|^surname\b/i, get: (p) => (p.contact.name || "").split(" ").slice(1).join(" ") },
    // Excludes referral/nomination-context questions - confirmed live, a real Greenhouse form's
    // "Enter the full name of our employee who suggested this job opportunity" (explicitly
    // described as "Only if the job opportunity was suggested to you by one of our employees")
    // was wrongly filled with the APPLICANT'S OWN name via this pattern, since "full name"
    // appears in the sentence regardless of whose name is actually being asked for - a real,
    // actively wrong answer (implying self-referral / corrupting the referrer field), not just
    // a missed field.
    { re: /^(?!.*\b(referr\w*|recommend\w*|suggest\w*|nominat\w*)\b).*\bfull\s*name\b|^name$/i, get: (p) => p.contact.name },
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
  function matchStructuredField(label) {
    for (const { re, get } of STRUCTURED_PATTERNS) {
      if (re.test(label)) {
        const value = get(profile);
        return { isStructuredCategory: true, value: value || null };
      }
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
    { key: "worked_here_before", re: /have you (ever )?(worked(?!\s+with\b)|been employed)\b/i },
    { key: "currently_employed_here", re: /(are you )?currently (working|employed)\b/i },
    // "Eligible to work" confirmed live as a real wording variant (Globalization Partners'
    // Greenhouse form: "Are you currently eligible to work in the country where this role is
    // posted without visa sponsorship?") that "authorized to work" alone didn't catch, meaning
    // a saved answer for the same underlying question never got reused via category match.
    { key: "authorized_to_work", re: /authori[sz]ed to work|eligible to work/i },
    { key: "requires_sponsorship", re: /(require|need|will).{0,25}(sponsorship|visa)/i },
  ];
  function detectCategory(text) {
    for (const { key, re } of CATEGORY_PATTERNS) {
      if (re.test(text)) return key;
    }
    return null;
  }

  // "what"/"your" recur across nearly every boilerplate application question ("What is your
  // ___?"), so two genuinely unrelated questions phrased that way can share only these two
  // words and still clear the overlap bar below purely from sentence-template overlap, not
  // actual meaning - confirmed live, "What is your current location?" and "What is your salary
  // expectation...?" both got silently filled with a saved "What is your preferred messenger?
  // Please provide your ID/name" answer this way. Excluded explicitly since neither is filtered
  // by length alone (both 4 chars).
  const MATCH_QA_STOPWORDS = new Set(["what", "your"]);
  function matchQaBank(label) {
    const normLabel = normalizeForMatch(label);
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
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
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
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked") &&
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked").set;
    if (setter) setter.call(element, checked);
    else element.checked = checked;
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
  function setPhoneValue(element, value) {
    try {
      const globals = window.intlTelInputGlobals;
      if (globals && typeof globals.getInstance === "function") {
        const iti = globals.getInstance(element);
        if (iti && typeof iti.setNumber === "function") {
          iti.setNumber(value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      if (window.jQuery) {
        const plugin = window.jQuery(element).data && window.jQuery(element).data("plugin_intlTelInput");
        if (plugin && typeof plugin.setNumber === "function") {
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
          const toggle = wrapper.querySelector(".iti__selected-country, [class*='selected-country']");
          if (toggle) toggle.click();
          countryItem.click();
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
    const target = String(value).trim().toLowerCase();
    const options = [...select.options];
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
    } else {
      // Confirmed live: setting `.checked = true` and THEN calling the real `.click()`
      // afterward used to unconditionally flip it right back to unchecked - a genuine
      // `.click()` on a checkbox always TOGGLES its current state, regardless of how that
      // state got there. nativeSetChecked is the one and only place `checked` gets set now,
      // so there's no second toggle left to undo it (see its own comment for why it's needed
      // at all, over a plain assignment).
      nativeSetChecked(el, true);
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
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        chrome.runtime.sendMessage({ type: "TRUSTED_CLICK", x, y }, (response) => {
          resolve(Boolean(response && response.ok));
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
  function findComboboxOptions(prefix, before) {
    const isVisibleLocal = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isFreshAndVisible = (el) => !before.has(el) && isVisibleLocal(el);

    if (prefix) {
      for (const menu of document.querySelectorAll(`[class*="${prefix}__menu"]`)) {
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
    for (const listbox of document.querySelectorAll('[role="listbox"], [role="tree"], [role="menu"]')) {
      const opts = [...listbox.querySelectorAll('[role="option"], [role="treeitem"], [role="menuitem"]')].filter(isFreshAndVisible);
      if (opts.length) return opts;
    }
    const anyOptionRole = [...document.querySelectorAll('[role="option"], [role="treeitem"], [role="menuitem"]')].filter(isFreshAndVisible);
    if (anyOptionRole.length) return anyOptionRole;
    return [...document.querySelectorAll("li, div, span, button")].filter((el) => {
      if (before.has(el)) return false; // only elements that appeared after the click
      if (el.children.length > 2) return false; // leaf-ish only, not a whole container
      const text = (el.textContent || "").trim();
      if (!text || text.length > 80) return false; // an option is short text, not a paragraph
      return isVisibleLocal(el);
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
    const controlEl = element.closest('[class*="__control"]');
    const prefixMatch = controlEl && controlEl.className.match(/(\S+)__control\b/);
    const prefix = prefixMatch ? prefixMatch[1] : null;
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
    // that were present-but-invisible and only just became visible.
    const before = new Set(
      [...document.querySelectorAll("*")].filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
    );
    simulateClick(controlEl || element);
    element.focus();

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
        await new Promise((resolve) => setTimeout(resolve, 100));
        options = findComboboxOptions(null, before);
      }
      if (!options.length) {
        element.blur();
        return false;
      }
      let allMatched = true;
      for (const target of targets) {
        const current = findComboboxOptions(null, before);
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
        simulateClick(match);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      element.blur();
      return allMatched;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
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

    // Async/debounced city autocomplete (Greenhouse "Location (City)" on
    // job-boards.greenhouse.io confirmed live): dumping the whole search string via
    // nativeSet then clicking the first option the moment ANY menu row appeared raced the
    // widget's own debounce + geocode — mid-rerender clicks didn't stick, or picked a
    // stale/wrong "Warsaw" before the real list settled. After typing, give the debounce a
    // head start, ignore loading/"No options" chrome, and require the usable option list to
    // stay unchanged across consecutive polls before committing a click. Static client-side
    // lists still resolve in ~200ms once options appear (two stable reads).
    const isUnusableOptionText = (text) => {
      const t = (text || "").trim();
      if (!t) return true;
      return /^(loading(\.{0,3}|…)?|searching(\.{0,3}|…)?|no options?( found)?|type to search|start typing)/i.test(t);
    };
    const readUsableOptions = () =>
      findComboboxOptions(prefix, before).filter((o) => !isUnusableOptionText(o.textContent));
    const menuStillLoading = () => {
      const el = document.querySelector(
        '[class*="__loadingIndicator"], [class*="__loading-indicator"], [class*="loading-indicator"]'
      );
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const waitForStableOptions = async (maxAttempts) => {
      if (typedInto) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      let options = [];
      let lastSig = "";
      let stableReads = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
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
          if (stableReads >= 2) return options;
        } else {
          lastSig = sig;
          stableReads = 1;
          options = found;
        }
      }
      return options;
    };

    let options = await waitForStableOptions(40);
    // No options ever appeared - the menu itself may never have opened at all. Confirmed live
    // on BambooHR's Country field: simulateClick's own synthetic events never open it (the
    // widget's own JS appears to check event.isTrusted, which no script can ever satisfy), even
    // though a real manual click does. Only reached when the normal, invisible path already
    // failed - trustedClick's visible debugging banner is the cost of this fallback, not the
    // default behavior.
    if (!options.length) {
      if (await trustedClick(controlEl || element)) {
        if (typedInto) nativeSet(typedInto, desiredText);
        options = await waitForStableOptions(15);
      }
    }
    if (!options.length) {
      revertTypedFilter();
      return false;
    }

    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(desiredText);
    const countryHint = norm((profile && profile.contact && profile.contact.country) || "");
    const textOf = (o) => norm(o.textContent);
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
    if (!match) {
      revertTypedFilter();
      return false;
    }
    simulateClick(match);
    // Brief settle so react-select can commit the selection before the next field runs.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return true;
  }

  // Custom (non-native) comboboxes have no `.options` list to read the way a real <select>
  // does - discovering what's actually pickable means opening the widget the same way
  // fillReactSelectByClick does, reading whatever options render, then closing it back down
  // WITHOUT selecting anything (this is a discovery-only pass - the real pick, whether the
  // auto-filled "only one option" case or the AI-picked answer from a later batch, happens
  // through the normal fill path afterward, which opens/closes the widget itself
  // independently). Best-effort throughout: a widget that doesn't cleanly close on Escape/blur
  // just gets left as whatever it naturally settles into - never worth crashing the whole
  // detection pass over.
  async function discoverComboboxOptions(element) {
    const before = new Set(
      [...document.querySelectorAll("*")].filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
    );
    const controlEl = element.closest('[class*="__control"]');
    const prefixMatch = controlEl && controlEl.className.match(/(\S+)__control\b/);
    const prefix = prefixMatch ? prefixMatch[1] : null;
    try {
      simulateClick(controlEl || element);
      let options = [];
      for (let attempt = 0; attempt < 15 && !options.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        options = findComboboxOptions(prefix, before);
      }
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
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      element.blur();
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
      combobox.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      return false;
    }

    simulateClick(countryItem);
    await new Promise((resolve) => setTimeout(resolve, 100));
    nativeSet(element, phone.slice(1 + dialCodeLen).trim());
    return true;
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
    if (await fillZohoCruxPhone(element, value)) return true;
    // Not gated on element.type === "tel" — many ATS implementations of intl-tel-input
    // render the visible input as type="text", not "tel" (confirmed live: a real Workable
    // form had it as "text", so the type-gated check never even attempted this). Checking
    // for a registered iti instance is harmless on any element — it's a no-op lookup that
    // returns nothing if that exact node was never initialized with the plugin.
    if (setPhoneValue(element, value)) return true;
    if (looksLikeComboboxPick(element)) return await fillReactSelectByClick(element, value);
    nativeSet(element, value);
    return true;
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
  const stampIdx = (el) => {
    const idx = nextIdx++;
    el.setAttribute("data-af-idx", String(idx));
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
    if (qaMatch && clickGroupOption(group.options, qaMatch.answer)) {
      filled.push({ label: group.label, value: qaMatch.answer, source: "learned" });
      continue;
    }
    const optionLabels = group.options.map((o) => o.optionLabel).filter(Boolean);
    if (optionLabels.length === 1 && clickGroupOption(group.options, optionLabels[0])) {
      filled.push({ label: group.label, value: optionLabels[0], source: "only-option" });
      continue;
    }
    // Stamp the first option element so a later AI pick can click the matching sibling.
    if (optionLabels.length > 1 && group.options[0] && group.options[0].element) {
      const idx = stampIdx(group.options[0].element);
      unmatched.push({
        idx,
        label: group.label,
        type: group.kind,
        canGenerate: false,
        options: optionLabels,
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
    const label = labelForElement(element, host);
    // Structured matching needs the field's OWN label, not the group-prefixed display label
    // above - confirmed live, a Workday "Address" section wraps City/Neighborhood/Municipality/
    // etc. in role="group" aria-labelledby="Address-section", so labelForElement prepends
    // "Address - " to every field in it ("Address - City"), and the anchored `^address\b`
    // street-address pattern then wins over the more specific `^city\b` pattern purely because
    // of pattern order, filling City/Neighborhood/Municipality/... with the street address
    // instead of their own real values.
    const ownLabel = normalizeLabel(resolveOwnLabel(element, host));
    const structured = matchStructuredField(ownLabel);
    if (structured.value && (await fillSingle(element, structured.value))) {
      filled.push({ label, value: String(structured.value), source: "profile" });
      continue;
    }
    const qaMatch = matchQaBank(label);
    if (qaMatch && (await fillSingle(element, qaMatch.answer))) {
      filled.push({ label, value: qaMatch.answer, source: "learned" });
      continue;
    }
    const tag = element.tagName.toLowerCase();

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
        const idx = stampIdx(element);
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
    if (looksLikeComboboxPick(element) && isRequiredField(element, host)) {
      const optionLabels = await discoverComboboxOptions(element);
      if (optionLabels.length === 1 && (await fillSingle(element, optionLabels[0]))) {
        filled.push({ label, value: optionLabels[0], source: "only-option" });
        continue;
      }
      if (optionLabels.length > 1) {
        const idx = stampIdx(element);
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

    // "range" included alongside the plain text-like types - confirmed live, a Teamtailor
    // rangeslider.js widget's real (visually near-invisible) `<input type="range">` backs an
    // ordinary free-text-answerable numeric question ("How many years of experience do you have
    // with full-stack development?"), not a discrete, un-generatable option picker like a
    // select/combobox - excluding it here left a genuinely required, generatable question stuck
    // asking for manual input even after isVisible() started detecting it correctly.
    const isFreeText = tag === "textarea" || (tag === "input" && /^(text|email|tel|url|search|range)?$/i.test(element.type || ""));
    const canGenerate =
      isFreeText &&
      !isConsequential(label) &&
      !structured.isStructuredCategory &&
      !looksLikeComboboxPick(element) &&
      isRequiredField(element, host);
    // Stamped for every unmatched field (including selects above) — the side panel tries an
    // AI-based QA-bank match first, then free-text generation / select option-picking.
    const idx = stampIdx(element);
    unmatched.push({ idx, label, type: element.type || tag, canGenerate });
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

  return { filled, unmatched };
}
async function fillGeneratedAnswersInPage(answers) {
  function nativeSet(element, value) {
    const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
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
  }

  // Same reasoning as nativeSet above, just for `checked` - React (and similar) tracks a
  // controlled checkbox/radio's checked state through its own overridden property setter too, a
  // plain `element.checked = x` write goes through that same override and gets silently ignored
  // on the next dispatched event. Confirmed live: a required consent checkbox visually ticked
  // correctly but the site's own validation never cleared - the same "looks filled, framework
  // never noticed" symptom nativeSet already exists to prevent for text fields.
  function nativeSetChecked(element, checked) {
    const setter =
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked") &&
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked").set;
    if (setter) setter.call(element, checked);
    else element.checked = checked;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    for (const type of ["mousedown", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  }

  function setSelectValue(select, value) {
    const target = String(value).trim().toLowerCase();
    const options = [...select.options];
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
      // Workday's plain "Select One" single-pick dropdown - a `<button aria-haspopup="listbox">`
      // with no role="combobox" of its own. Needs the same click-and-select-from-the-rendered-
      // listbox handling as any other custom combobox, not a native-set (which wouldn't even
      // apply to a <button> in the first place).
      (element.tagName === "BUTTON" && element.getAttribute("aria-haspopup") === "listbox")
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
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        chrome.runtime.sendMessage({ type: "TRUSTED_CLICK", x, y }, (response) => {
          resolve(Boolean(response && response.ok));
        });
      } catch {
        resolve(false);
      }
    });
  }

  function findComboboxOptions(prefix, before) {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isFreshAndVisible = (el) => !before.has(el) && isVisible(el);

    // Kept in sync with runAutofillInPage's own findComboboxOptions — this copy previously
    // lacked the same-page-multiple-comboboxes freshness check entirely (unscoped
    // document.querySelector, no `before` filtering on tiers 1-2), a real gap since this is
    // the function that actually fills AI-matched/generated answers, not dead code.
    if (prefix) {
      for (const menu of document.querySelectorAll(`[class*="${prefix}__menu"]`)) {
        const opts = [...menu.querySelectorAll(`[class*="${prefix}__option"]`)].filter(isFreshAndVisible);
        if (opts.length) return opts;
      }
    }
    for (const listbox of document.querySelectorAll('[role="listbox"], [role="tree"]')) {
      const opts = [...listbox.querySelectorAll('[role="option"], [role="treeitem"]')].filter(isFreshAndVisible);
      if (opts.length) return opts;
    }
    const anyOptionRole = [...document.querySelectorAll('[role="option"], [role="treeitem"]')].filter(isFreshAndVisible);
    if (anyOptionRole.length) return anyOptionRole;
    return [...document.querySelectorAll("li, div, span, button")].filter((el) => {
      if (before.has(el)) return false;
      if (el.children.length > 2) return false;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 80) return false;
      return isVisible(el);
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
    const controlEl = element.closest('[class*="__control"]');
    const prefixMatch = controlEl && controlEl.className.match(/(\S+)__control\b/);
    const prefix = prefixMatch ? prefixMatch[1] : null;
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
    // that were present-but-invisible and only just became visible.
    const before = new Set(
      [...document.querySelectorAll("*")].filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
    );
    simulateClick(controlEl || element);
    element.focus();

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
        await new Promise((resolve) => setTimeout(resolve, 100));
        options = findComboboxOptions(null, before);
      }
      if (!options.length) {
        element.blur();
        return false;
      }
      let allMatched = true;
      for (const target of targets) {
        const current = findComboboxOptions(null, before);
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
        simulateClick(match);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      element.blur();
      return allMatched;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
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

    // Kept in sync with runAutofillInPage's fillReactSelectByClick: async/debounced city
    // autocomplete (Greenhouse Location (City)) must not click the first option the moment
    // any row appears — wait for a stable usable list first.
    const isUnusableOptionText = (text) => {
      const t = (text || "").trim();
      if (!t) return true;
      return /^(loading(\.{0,3}|…)?|searching(\.{0,3}|…)?|no options?( found)?|type to search|start typing)/i.test(t);
    };
    const readUsableOptions = () =>
      findComboboxOptions(prefix, before).filter((o) => !isUnusableOptionText(o.textContent));
    const menuStillLoading = () => {
      const el = document.querySelector(
        '[class*="__loadingIndicator"], [class*="__loading-indicator"], [class*="loading-indicator"]'
      );
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const waitForStableOptions = async (maxAttempts) => {
      if (typedInto) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      let options = [];
      let lastSig = "";
      let stableReads = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
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
          if (stableReads >= 2) return options;
        } else {
          lastSig = sig;
          stableReads = 1;
          options = found;
        }
      }
      return options;
    };

    let options = await waitForStableOptions(40);
    if (!options.length) {
      if (await trustedClick(controlEl || element)) {
        if (typedInto) nativeSet(typedInto, desiredText);
        options = await waitForStableOptions(15);
      }
    }
    if (!options.length) {
      revertTypedFilter();
      return false;
    }

    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(desiredText);
    // Learn/AI fill path has no profile in scope — matching still prefers "City, …" form.
    const textOf = (o) => norm(o.textContent);
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
    if (!match) {
      revertTypedFilter();
      return false;
    }
    simulateClick(match);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return true;
  }

  let count = 0;
  for (const { idx, value } of answers) {
    const el = document.querySelector(`[data-af-idx="${idx}"]`);
    if (!el) continue;
    const tag = el.tagName.toLowerCase();
    let ok = true;
    if (tag === "select") {
      ok = setSelectValue(el, value);
    } else if (el.type === "radio" || (el.type === "checkbox" && el.name)) {
      // Grouped radios/checkboxes: the stamped node is one option; pick the sibling whose
      // label matches the AI/QA answer (not just yes/true on the stamped node itself).
      const peers = el.name
        ? [...document.querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(el.name)}"]`)]
        : [el];
      const target = String(value).trim().toLowerCase();
      let peer =
        peers.find((p) => (labelForElement(p, p) || "").toLowerCase() === target) ||
        peers.find((p) => {
          const lab = (labelForElement(p, p) || "").toLowerCase();
          return lab.includes(target) || target.includes(lab);
        });
      // Resolution logic (which peer ends up chosen) is unchanged from before - only HOW it
      // gets checked changed (see nativeSetChecked's own comment for why). Confirmed live: this
      // used to set `.checked = true` directly and THEN call the real `.click()` afterward -
      // since a genuine `.click()` on a checkbox always TOGGLES its current state (regardless
      // of how that state got there), that unconditionally flipped an already-just-checked box
      // right back to unchecked. nativeSetChecked below is the one and only place `checked`
      // actually gets set now, so there's no second toggle left to undo it.
      if (!peer && /^(yes|true|y)$/i.test(String(value).trim())) {
        peer = peers.find((p) => /yes/i.test(labelForElement(p, p) || "")) || el;
      } else if (!peer && /^(no|false|n)$/i.test(String(value).trim())) {
        peer = peers.find((p) => /^no$/i.test((labelForElement(p, p) || "").trim())) || null;
      } else if (!peer) {
        ok = false;
      }
      if (ok && peer) {
        nativeSetChecked(peer, true);
      }
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
    } else {
      nativeSet(el, value);
    }
    if (ok) count++;
  }
  document.querySelectorAll("[data-af-idx]").forEach((el) => el.removeAttribute("data-af-idx"));
  return { count };
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
    { re: /e-?mail/i, get: (p) => p.contact.email },
    // Kept in sync with runAutofillInPage's negative-lookahead version - excludes "Country
    // Phone Code"/"Phone Device Type"/"Phone Extension" from matching as the phone number itself.
    { re: /^(?!.*\b(code|type|extension|device)\b).*\b(phone|mobile|telephone)\b/i, get: (p) => p.contact.phone },
    { re: /linkedin/i, get: (p) => p.contact.linkedin },
    { re: /website|portfolio/i, get: (p) => p.contact.website },
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
    { re: /^first\s*name|^given\s*name/i, get: (p) => (p.contact.name || "").split(" ")[0] || "" },
    { re: /^last\s*name|^family\s*name|^surname\b/i, get: (p) => (p.contact.name || "").split(" ").slice(1).join(" ") },
    // Excludes referral/nomination-context questions - confirmed live, a real Greenhouse form's
    // "Enter the full name of our employee who suggested this job opportunity" (explicitly
    // described as "Only if the job opportunity was suggested to you by one of our employees")
    // was wrongly filled with the APPLICANT'S OWN name via this pattern, since "full name"
    // appears in the sentence regardless of whose name is actually being asked for - a real,
    // actively wrong answer (implying self-referral / corrupting the referrer field), not just
    // a missed field.
    { re: /^(?!.*\b(referr\w*|recommend\w*|suggest\w*|nominat\w*)\b).*\bfull\s*name\b|^name$/i, get: (p) => p.contact.name },
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
    { key: "worked_here_before", re: /have you (ever )?(worked(?!\s+with\b)|been employed)\b/i },
    { key: "currently_employed_here", re: /(are you )?currently (working|employed)\b/i },
    // "Eligible to work" confirmed live as a real wording variant (Globalization Partners'
    // Greenhouse form: "Are you currently eligible to work in the country where this role is
    // posted without visa sponsorship?") that "authorized to work" alone didn't catch, meaning
    // a saved answer for the same underlying question never got reused via category match.
    { key: "authorized_to_work", re: /authori[sz]ed to work|eligible to work/i },
    { key: "requires_sponsorship", re: /(require|need|will).{0,25}(sponsorship|visa)/i },
  ];
  function detectCategory(text) {
    for (const { key, re } of CATEGORY_PATTERNS) {
      if (re.test(text)) return key;
    }
    return null;
  }

  // "what"/"your" recur across nearly every boilerplate application question ("What is your
  // ___?"), so two genuinely unrelated questions phrased that way can share only these two
  // words and still clear the overlap bar below purely from sentence-template overlap, not
  // actual meaning - confirmed live, "What is your current location?" and "What is your salary
  // expectation...?" both got silently filled with a saved "What is your preferred messenger?
  // Please provide your ID/name" answer this way. Excluded explicitly since neither is filtered
  // by length alone (both 4 chars).
  const MATCH_QA_STOPWORDS = new Set(["what", "your"]);
  function matchQaBank(label) {
    const normLabel = normalizeForMatch(label);
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

  return { url: location.href, html: document.documentElement.outerHTML, fields };
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
      chosen = group.options.filter(({ element }) => element.checked).map(({ optionLabel }) => optionLabel);
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
  { key: "worked_here_before", re: /have you (ever )?(worked|been employed)\b/i },
  { key: "currently_employed_here", re: /(are you )?currently (working|employed)\b/i },
  // Kept in sync with runAutofillInPage's own CATEGORY_PATTERNS - "eligible to work" confirmed
  // live as a real wording variant (Globalization Partners' Greenhouse form) alongside
  // "authorized to work".
  { key: "authorized_to_work", re: /authori[sz]ed to work|eligible to work/i },
  { key: "requires_sponsorship", re: /(require|need|will).{0,25}(sponsorship|visa)/i },
];
function detectMatchCategory(text) {
  for (const { key, re } of MATCH_CATEGORY_PATTERNS) {
    if (re.test(text)) return key;
  }
  return null;
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
    el("jobUrl").value = topFrame.result.jobUrl || tab.url || "";
    if (topFrame.result.company || bestContent.result.company) {
      el("company").value = topFrame.result.company || bestContent.result.company;
    }
    if (el("jobTitle") && (topFrame.result.jobTitle || bestContent.result.jobTitle)) {
      el("jobTitle").value = topFrame.result.jobTitle || bestContent.result.jobTitle;
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
    let generationCandidates = idxEligible.filter((u) => u.canGenerate);
    let selectPickCandidates = idxEligible.filter((u) => Array.isArray(u.options) && u.options.length > 1);
    const tailoredResume = getTailoredResumeIfAny();

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
        const data = await apiFetch("/match-answers", {
          method: "POST",
          body: JSON.stringify({ questions: idxEligible.map((u) => u.label) }),
        });
        const matchedIdxSet = new Set();
        idxEligible.forEach((item, i) => {
          const result = data.results[i];
          if (result && result.matched && isPlausibleQaMatch(item.label, result.matched_question)) {
            finalFills.push({ frameId: item.frameId, idx: item.idx, value: result.answer, kind: "matched" });
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
      ...selectPickCandidates.map((c) => ({ ...c, kind: "select" })),
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

        aiCandidates.forEach((item, i) => {
          const ans = answers[i];
          if (!ans || ans.answerable === false || !ans.answer) return;
          let value = ans.answer;
          if (item.kind === "select") {
            value = coerceSelectAnswer(value, item.options);
            if (!value) return;
          }
          finalFills.push({ frameId: item.frameId, idx: item.idx, value, kind: "generated" });
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
            finalFills.push({ frameId: item.frameId, idx: item.idx, value: data.answer, kind: "generated" });
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
      for (const f of finalFills) {
        if (!byFrame.has(f.frameId)) byFrame.set(f.frameId, []);
        byFrame.get(f.frameId).push({ idx: f.idx, value: f.value });
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

    const filledKeys = new Set(finalFills.map((f) => `${f.frameId}:${f.idx}`));
    const needsHuman = allUnmatched.filter((u) => u.idx === undefined || !filledKeys.has(`${u.frameId}:${u.idx}`));

    const generatedNote = [matchedCount && `${matchedCount} matched`, generatedCount && `${generatedCount} generated`]
      .filter(Boolean)
      .join(", ");
    resultEl.textContent = `Filled ${filledCount} field(s)${generatedNote ? ` (${generatedNote})` : ""}.${
      needsHuman.length
        ? ` ${needsHuman.length} need your input: ${needsHuman.map((u) => u.label || "(no label)").join(", ")}.`
        : ""
    }${matchErrors.length ? ` Saved-answer check failed: ${matchErrors.join("; ")}.` : ""}${
      generationErrors.length ? ` ${generationErrors.length} generation failure(s): ${generationErrors.join("; ")}.` : ""
    }${gptManualNote}`;
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
