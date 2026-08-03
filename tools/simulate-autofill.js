#!/usr/bin/env node
// Standalone CLI: paste/pipe a form's raw HTML, see exactly what Auto Fill would detect/fill/
// generate and what Learn would capture, against your REAL companion service (real profile,
// real QA bank, real Ollama/Claude calls for /match-answers and /generate-answer) - no browser,
// no extension involved at all.
//
// Usage:
//   node simulate-autofill.js path/to/form.html
//   pbpaste | node simulate-autofill.js -          (or just pipe with no filename)
//
// Env vars (all optional):
//   AUTOFILL_BASE_URL   default http://127.0.0.1:3939
//   AUTOFILL_TOKEN      default: read from ~/.job-apply-project/secret.token
//   AUTOFILL_COMPANY, AUTOFILL_JOB_DESCRIPTION  used only for /generate-answer calls
//
// The detection functions below (runAutofillInPage, fillGeneratedAnswersInPage, runLearnInPage,
// isPlausibleQaMatch and friends) are copied verbatim from extension/sidepanel.js - this is
// intentionally a read-only mirror, not a reimplementation. If a detection bug gets fixed there,
// re-copy the relevant function(s) here to keep this tool accurate.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { JSDOM } = require("jsdom");

const BASE_URL = process.env.AUTOFILL_BASE_URL || "http://127.0.0.1:3939";
const TOKEN_FILE = path.join(os.homedir(), ".job-apply-project", "secret.token");

function readToken() {
  if (process.env.AUTOFILL_TOKEN) return process.env.AUTOFILL_TOKEN;
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    throw new Error(
      `Could not read the API token from ${TOKEN_FILE} - either start the companion service once ` +
        `(it creates this file), or set AUTOFILL_TOKEN yourself.`
    );
  }
}

async function apiFetch(urlPath, options = {}) {
  const token = readToken();
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Api-Token": token, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${urlPath}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

function readHtmlInput() {
  const arg = process.argv[2];
  if (arg && arg !== "-") {
    return fs.readFileSync(arg, "utf8");
  }
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    throw new Error("Usage: node simulate-autofill.js <file.html>   (or pipe HTML via stdin)");
  }
}

async function runAutofillInPage(profile, qaBank) {
  // ---- shared label/text helpers ----
  // Decorative icons (an inline <svg><desc><p>SVGs not supported...</p></desc></svg>
  // fallback, aria-hidden font-icon spans, etc.) contribute their fallback text to a
  // label's plain .textContent, silently corrupting the resolved label (seen on Workable:
  // an address-icon SVG turned "Address" into "AddressSVGs not supported by this browser.").
  // Strip anything marked aria-hidden or living inside an <svg> before reading text.
  function cleanedText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"], svg, script, style').forEach((n) => n.remove());
    return (clone.textContent || "").trim();
  }

  function normalizeLabel(raw) {
    // Required/optional marker noise shows up in a different shape on every ATS (leading
    // "*", trailing "* (required)", a colon right before a trailing "*", etc.) — strip it
    // here once instead of trying to special-case every site's pattern.
    let text = (raw || "").replace(/ /g, " ").trim();
    text = text.replace(/\(\s*(required|optional)\s*\)\s*$/i, "").trim();
    // Screen-reader-only "Required" text right after the asterisk (Teamtailor: <sup>*</sup>
    // <span class="sr-only">Required</span> concatenates to "...*Required" via textContent).
    // The asterisk itself is often marked aria-hidden and already stripped by cleanedText
    // by the time this runs (Teamtailor: "First name" + hidden "*" + sr-only "Required" ->
    // "First nameRequired" with no "*" left at all) — so the asterisk here is optional, not
    // required, to still catch that case as well as sites where it stays as visible text.
    text = text.replace(/\*?\s*(required|optional)\s*$/i, "").trim();
    // "✱" (U+2731, a heavy asterisk-like star) is Lever's own required-marker glyph -
    // confirmed live: every Lever label ("Full name✱", "Email✱", ...) kept its trailing "✱"
    // uncleaned, since only the plain "*"/"•" characters were covered here before.
    text = text.replace(/[:\s]*[*•✱][:\s]*$/, "").trim();
    text = text.replace(/^[*•✱]\s*/, "").trim();
    return text.replace(/\s+/g, " ").trim();
  }

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

  // Climbs from `host` looking for a <label> that belongs specifically to it, stopping once
  // an ancestor contains more than one form control (past that point a label found there
  // would belong to the whole group, not this one field). This is the fallback for sites
  // like careers-page.com where every <label for=""> is present but never actually resolves.
  function findLabelInAncestors(host) {
    let node = host.parentElement;
    for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
      const controls = node.querySelectorAll('input:not([type="hidden"]), select, textarea, [label]');
      if (controls.length > 1) break;
      const label = node.querySelector("label");
      if (label && cleanedText(label)) return cleanedText(label);
    }
    return null;
  }

  // Composite/grouped fields (Personio: "First" only makes sense combined with its
  // role="group" ancestor's own "Name" label) — returns the group's own label, or null.
  function findGroupContextLabel(host) {
    let node = host.parentElement;
    for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
      if (node.getAttribute && node.getAttribute("role") === "group") {
        const labelledby = node.getAttribute("aria-labelledby");
        if (labelledby) {
          const text = labelledby
            .split(/\s+/)
            .map((id) => {
              const el = document.getElementById(id);
              return el ? cleanedText(el) : "";
            })
            .filter(Boolean)
            .join(" ");
          if (text) return text;
        }
        const ariaLabel = node.getAttribute("aria-label");
        if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
      }
    }
    return null;
  }

  // `host` is the element to resolve DOM-proximity/attribute-based labels from — usually the
  // same as `element`, except for shadow-DOM custom elements (SmartRecruiters' <spl-input>)
  // where `element` is the real control inside an open shadow root but `host` is the outer
  // custom element carrying the actual `label` attribute and sitting in the light-DOM tree.
  function resolveOwnLabel(element, host) {
    host = host || element;
    if (host.hasAttribute && host.hasAttribute("label")) {
      const v = host.getAttribute("label").trim();
      if (v) return v;
    }
    if (element.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (labelEl && cleanedText(labelEl)) return cleanedText(labelEl);
    }
    const parentLabel = element.closest ? element.closest("label") : null;
    if (parentLabel && cleanedText(parentLabel)) return cleanedText(parentLabel);
    // <fieldset><legend> is the standard, authoritative way to associate a label with a group
    // of controls - checked before aria-label/aria-labelledby since Workday's own custom
    // "Select One" button carries a generic, useless aria-label ("Select One Required" - just
    // its own placeholder/state, not the actual question) while the real question sits in the
    // <legend> one level up. Confirmed live: without this check ahead of aria-label, every
    // CrowdStrike Workday questionnaire question resolved to the literal string "Select One"
    // instead of the real question text.
    const fieldset = element.closest ? element.closest("fieldset") : null;
    if (fieldset) {
      const legend = fieldset.querySelector("legend");
      if (legend && cleanedText(legend)) return cleanedText(legend);
    }
    const labelledby = element.getAttribute && element.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => {
          const el = document.getElementById(id);
          return el ? cleanedText(el) : "";
        })
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    if (element.getAttribute && element.getAttribute("aria-label")) return element.getAttribute("aria-label").trim();
    if (host !== element && host.getAttribute && host.getAttribute("aria-label")) return host.getAttribute("aria-label").trim();
    // A real <label> found in a shallow ancestor (findLabelInAncestors bails out if that
    // ancestor holds more than one control, so it's a fairly reliable signal) beats a generic
    // placeholder hint — confirmed live: an Ashby "Location" combobox had no id/label[for] pair
    // at all (the visible input carries no id), so this used to fall through to its
    // placeholder, "Start typing...", instead of the real "Location" label one level up in the
    // DOM — meaning a saved profile location never matched it, silently, even though the
    // correct label was right there in the markup.
    const proximityLabel = findLabelInAncestors(host);
    if (proximityLabel) return proximityLabel;
    const placeholder = element.getAttribute && element.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();
    // Some form frameworks skip both a real <label> and any ARIA labelling entirely — Lever's
    // own custom-question fields, confirmed live, put the question text in a plain sibling
    // <div class="application-label"> of an ANCESTOR of the field (a "label div and
    // field-wrapper div both children of one shared question container" shape), not a direct
    // sibling of the field itself. Without this, resolution fell all the way through to the
    // field's raw `name` attribute instead ("cards[38843bea-...][field0]") — meaningless to a
    // human, and worse, meaningless to the consequential-field safety check and the answer-
    // generation prompt too, since neither ever saw the real question ("What would be your
    // monthly gross salary expectations in PLN?"). Climbs a few ancestor levels, checking each
    // one's own previous siblings, stopping as soon as usable text is found.
    let node = host;
    for (let depth = 0; depth < 4 && node; depth++, node = node.parentElement) {
      let prev = node.previousElementSibling;
      for (let i = 0; i < 3 && prev; i++, prev = prev.previousElementSibling) {
        const text = cleanedText(prev);
        if (text && text.length < 200) return text;
      }
    }
    return element.name || (host.getAttribute && host.getAttribute("name")) || "";
  }

  function labelForElement(element, host) {
    const own = normalizeLabel(resolveOwnLabel(element, host));
    const groupLabel = normalizeLabel(findGroupContextLabel(host || element) || "");
    if (groupLabel && groupLabel.toLowerCase() !== own.toLowerCase()) {
      return own ? `${groupLabel} - ${own}` : groupLabel;
    }
    return own;
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
    const raw = `${resolveOwnLabel(element, host)} ${findGroupContextLabel(host || element) || ""}`;
    return /\(\s*required\s*\)/i.test(raw) || /[*•✱]/.test(raw);
  }

  // ---- visibility ----
  function isVisible(element) {
    // select2 hides the real <select> (aria-hidden, near-zero size) and shows a fake widget
    // in its place — it's still the real, fillable control, unlike a genuine decoy.
    if (element.tagName === "SELECT" && element.classList.contains("select2-hidden-accessible")) return true;
    // select2's own search box and intl-tel-input's country search box are internal UI for a
    // field that's already detected elsewhere (the real <select>, or the phone <input>) — not
    // separate fields the applicant needs to fill themselves.
    if (element.classList.contains("select2-search__field") || element.classList.contains("iti__search-input")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false; // visually-hidden a11y decoys (Workable)
    if (element.offsetParent === null && style.position !== "fixed" && style.position !== "sticky") return false;
    return true;
  }

  // Honeypot/decoy fields: confirmed live on a BambooHR "Fabric" form — a text input named
  // "nickname_hpcsaf", labeled "Please leave this field blank", tabindex="-1", sitting inside
  // an aria-hidden ancestor (not itself aria-hidden, so isVisible() above doesn't catch it) but
  // otherwise normal-sized and unhidden by CSS, so it passes every other visibility check too.
  // It carried all five standard password-manager "don't touch this" attributes at once
  // (data-lpignore, data-1p-ignore, data-bwignore, data-dashlane-ignore, data-protonpass-ignore)
  // — the same signal 1Password/Bitwarden/Dashlane/LastPass/ProtonPass already honor to avoid
  // exactly this trap. Auto Fill previously ignored that signal, filled the field, and the site's
  // own bot detection then silently rejected the submission — matching the reported "click
  // submit but it doesn't work" symptom exactly.
  function isHoneypot(element) {
    return (
      element.hasAttribute("data-lpignore") ||
      element.hasAttribute("data-1p-ignore") ||
      element.hasAttribute("data-bwignore") ||
      element.hasAttribute("data-dashlane-ignore") ||
      element.hasAttribute("data-protonpass-ignore")
    );
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
  const CONSEQUENTIAL_RE =
    /salary|compensation|day\s*rate|hourly\s*rate|rate\s*per|weekly\s*capacity|hours?\s*per\s*week|availability|notice\s*period|start\s*date|visa|sponsor|work\s*permit|authori[sz]e|\bcitizen|security\s*clearance|right\s*to\s*work|tax\s*(payer|resident)|b2b|contract\s*type|\btravel\b|relocat|onboard|desired\s*pay|expected\s*pay|pay\s*rate|pay\s*expect/i;
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

  // ---- DETECT ----
  function collectNativeElements() {
    return [
      ...document.querySelectorAll(
        // `[role="combobox"]` covers fully custom comboboxes with no real underlying
        // <input>/<select> at all (confirmed live: an Angular CDK-based ATS renders its
        // "Country" field as a bare, non-form <div role="combobox">, backed only by an
        // Angular FormControl with no native form element anywhere) — without this, such a
        // field is invisible to detection entirely (never even reaches `unmatched`, let
        // alone gets filled), not just hard to fill once found.
        // `button[aria-haspopup="listbox"]` covers Workday's own "Select One" single-pick
        // dropdown (confirmed live: a CrowdStrike questionnaire's Yes/No custom questions are
        // each a plain `<button aria-haspopup="listbox">Select One</button>` with no
        // role="combobox" anywhere) - it's the only visible, clickable part of that field.
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select, [role="combobox"], button[aria-haspopup="listbox"]'
      ),
    ]
      .filter(isVisible)
      .filter((el) => !isHoneypot(el))
      .filter((el) => {
        // That same button renders a plain hidden native <input type="text"> right beside it
        // as an accessibility/focus proxy - the same logical field as the button, not a second
        // one, so it's excluded here rather than reported as a separate (mislabeled) field.
        const prev = el.previousElementSibling;
        return !(el.tagName === "INPUT" && prev && prev.tagName === "BUTTON" && prev.getAttribute("aria-haspopup") === "listbox");
      });
  }

  // SmartRecruiters-style custom elements (<spl-input label="...">) with an open shadow root
  // wrapping a real input/select/textarea. Closed shadow roots are genuinely inaccessible
  // from a content script — those fields just fall through as unmatched.
  function collectShadowElements() {
    // querySelector (singular) here was a real bug: a single custom element whose shadow root
    // renders MULTIPLE fields (e.g. a schema-driven form component rendering five separate
    // questions from one JSON "definition" attribute — seen live on a SmartRecruiters
    // screening-questions form) would only ever surface the first one, silently dropping the
    // rest. querySelectorAll + recursing into nested shadow roots matches the same pattern
    // attachResumeFileInPage's collectFileInputs already uses correctly, just below.
    function collectFrom(root) {
      const found = [];
      for (const host of root.querySelectorAll("*")) {
        if (!host.tagName.includes("-") || !host.shadowRoot) continue;
        for (const inner of host.shadowRoot.querySelectorAll("input, select, textarea")) {
          if (isVisible(inner) && !isHoneypot(inner)) found.push({ element: inner, host });
        }
        found.push(...collectFrom(host.shadowRoot));
      }
      return found;
    }
    return collectFrom(document);
  }

  // Groups radio/checkbox inputs sharing a `name` into one question with N options, using
  // the nearest <fieldset>+<legend> or role="group" ancestor for the group's own label —
  // covers both single-select radio groups and multi-select checkbox groups (Teamtailor).
  function collectRadioCheckboxGroups() {
    const byName = new Map();
    for (const el of document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
      if (!isVisible(el) || !el.name) continue;
      if (!byName.has(el.name)) byName.set(el.name, []);
      byName.get(el.name).push(el);
    }
    const groups = [];
    const claimed = new Set();
    for (const els of byName.values()) {
      if (els.length < 2) continue; // a lone checkbox with its own name is a single field, not a group question
      let groupLabel = null;
      let node = els[0].parentElement;
      for (let depth = 0; depth < 6 && node && !groupLabel; depth++, node = node.parentElement) {
        if (node.tagName === "FIELDSET") {
          const legend = node.querySelector("legend");
          if (legend && cleanedText(legend)) groupLabel = cleanedText(legend);
          if (!groupLabel) {
            // Some ATSs (Ashby) skip <legend> entirely and put the question in a plain
            // <label> inside the <fieldset> instead — findable only by elimination: it's
            // the one label whose `for` doesn't point at one of this group's own options.
            const optionIds = new Set(els.map((o) => o.id).filter(Boolean));
            const candidate = [...node.querySelectorAll("label")].find((l) => {
              const forId = l.getAttribute("for");
              return !forId || !optionIds.has(forId);
            });
            if (candidate && cleanedText(candidate)) groupLabel = cleanedText(candidate);
          }
        } else if (node.getAttribute && node.getAttribute("role") === "group") {
          const labelledby = node.getAttribute("aria-labelledby");
          if (labelledby) {
            const el = document.getElementById(labelledby.split(/\s+/)[0]);
            if (el && cleanedText(el)) groupLabel = cleanedText(el);
          }
        }
      }
      if (!groupLabel) continue; // no real group question found — leave these to be handled individually
      groups.push({
        kind: els[0].type === "checkbox" ? "checkbox-group" : "radio-group",
        label: normalizeLabel(groupLabel),
        options: els.map((el) => ({ element: el, optionLabel: normalizeLabel(resolveOwnLabel(el)) })),
      });
      els.forEach((el) => claimed.add(el));
    }
    return { groups, claimed };
  }

  // Ashby-style Yes/No pairs rendered as plain <button>s instead of real radio inputs.
  function collectButtonGroups(claimed) {
    const groups = [];
    for (const container of document.querySelectorAll('fieldset, [role="group"], [role="radiogroup"]')) {
      if (container.querySelector('input[type="radio"], input[type="checkbox"]')) continue;
      const buttons = [...container.querySelectorAll("button")].filter((b) => {
        const t = (b.textContent || "").trim();
        return t && t.length <= 20 && !claimed.has(b);
      });
      if (buttons.length < 2 || buttons.length > 6) continue;
      let groupLabel = null;
      if (container.tagName === "FIELDSET") {
        const legend = container.querySelector("legend");
        if (legend) groupLabel = cleanedText(legend);
      }
      if (!groupLabel) {
        const labelledby = container.getAttribute("aria-labelledby");
        if (labelledby) {
          const el = document.getElementById(labelledby.split(/\s+/)[0]);
          if (el) groupLabel = cleanedText(el);
        }
      }
      if (!groupLabel) continue;
      groups.push({
        kind: "button-group",
        label: normalizeLabel(groupLabel),
        options: buttons.map((b) => ({ element: b, optionLabel: normalizeLabel(b.textContent) })),
      });
      buttons.forEach((b) => claimed.add(b));
    }
    // Broader fallback: some Ashby forms wrap a Yes/No button pair in a plain <div> with no
    // fieldset/role="group"/role="radiogroup" at all (confirmed live — a real "Are you
    // currently based in Poland?" question built exactly this way), so the pass above never
    // finds a container to look inside in the first place. These often sit next to a real but
    // tabindex="-1" (non-focusable, purely decorative) <input type="checkbox"> that mirrors
    // React's state AFTER a button click rather than driving it — filling that checkbox
    // directly (as the generic single-checkbox path would) silently does nothing on the real
    // page while still reporting success, a false positive worse than an honest "unmatched".
    // Handles whatever the fieldset/role pass above didn't already claim, keyed off any 2-6
    // sibling <button>s sharing a parent, with the group's own label found via the nearest
    // ancestor's own <label> (real question labels always sit in a shallow ancestor of their
    // answer buttons on every ATS seen so far, not deep inside an unrelated container).
    const seenParents = new Set();
    for (const btn of document.querySelectorAll("button")) {
      if (claimed.has(btn)) continue;
      const parent = btn.parentElement;
      if (!parent || seenParents.has(parent)) continue;
      seenParents.add(parent);
      const buttons = [...parent.children].filter((b) => {
        if (b.tagName !== "BUTTON" || claimed.has(b)) return false;
        const t = (b.textContent || "").trim();
        return t && t.length <= 20;
      });
      if (buttons.length < 2 || buttons.length > 6) continue;
      let groupLabel = null;
      let node = parent;
      for (let depth = 0; depth < 6 && node && !groupLabel; depth++, node = node.parentElement) {
        const labelledby = node.getAttribute && node.getAttribute("aria-labelledby");
        if (labelledby) {
          const el = document.getElementById(labelledby.split(/\s+/)[0]);
          if (el && cleanedText(el)) groupLabel = cleanedText(el);
        }
        if (!groupLabel) {
          const label = node.querySelector && node.querySelector("label");
          if (label && cleanedText(label)) groupLabel = cleanedText(label);
        }
      }
      if (!groupLabel) continue;
      groups.push({
        kind: "button-group",
        label: normalizeLabel(groupLabel),
        options: buttons.map((b) => ({ element: b, optionLabel: normalizeLabel(b.textContent) })),
      });
      buttons.forEach((b) => claimed.add(b));
    }
    return groups;
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
    return null;
  }
  function hasSeparateCountryCodeField() {
    return [...document.querySelectorAll("label")].some((l) => /country.{0,15}code|dial(ing)?\s*code|calling\s*code/i.test(cleanedText(l)));
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
        if (!phone || !hasSeparateCountryCodeField()) return phone;
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
    // have matched instead. "State" deliberately has no entry — see ContactInfo.state.
    { re: /postal\s*code|zip\s*code|\bzip\b/i, get: (p) => p.contact.postal_code },
    { re: /^street\b|address\s*line|^address\b/i, get: (p) => p.contact.street_address },
    { re: /^city\b/i, get: (p) => p.contact.city },
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
    { re: /full\s*name|^name$/i, get: (p) => p.contact.name },
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

  // A `role="combobox"`/`aria-autocomplete="list"` input (react-select-style) needs a
  // discrete option picked from a listbox, not free text typed in — generating prose into
  // it wouldn't produce a valid selection even if the text looked reasonable.
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

  // A handful of application-boilerplate questions recur on nearly every ATS but with the
  // company's own name filled into an otherwise-identical template — "Have you ever been
  // employed by New Relic?" vs. a generic stored answer for "Have you ever worked at this
  // company before?" share almost no literal words (employed≠worked, New Relic≠company), so
  // plain word-overlap can never bridge them. Matched by category via regex instead, same
  // idea as STRUCTURED_PATTERNS but for QA-bank lookups.
  const CATEGORY_PATTERNS = [
    { key: "worked_here_before", re: /have you (ever )?(worked|been employed)\b/i },
    { key: "currently_employed_here", re: /(are you )?currently (working|employed)\b/i },
    { key: "authorized_to_work", re: /authori[sz]ed to work/i },
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
      el.checked = true;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.click();
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
  function simulateClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
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
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isFreshAndVisible = (el) => !before.has(el) && isVisible(el);

    if (prefix) {
      for (const menu of document.querySelectorAll(`[class*="${prefix}__menu"]`)) {
        const opts = [...menu.querySelectorAll(`[class*="${prefix}__option"]`)].filter(isFreshAndVisible);
        if (opts.length) return opts;
      }
    }
    // Some ARIA comboboxes use the "tree" popup pattern (`aria-haspopup="tree"`, a legitimate
    // APG variant) instead of the more common "listbox" one — options are `role="treeitem"`
    // inside a `role="tree"` container, not `role="option"` inside `role="listbox"`. Confirmed
    // live on an Angular CDK-based ATS "Country" field built exactly this way.
    for (const listbox of document.querySelectorAll('[role="listbox"], [role="tree"]')) {
      const opts = [...listbox.querySelectorAll('[role="option"], [role="treeitem"]')].filter(isFreshAndVisible);
      if (opts.length) return opts;
    }
    const anyOptionRole = [...document.querySelectorAll('[role="option"], [role="treeitem"]')].filter(isFreshAndVisible);
    if (anyOptionRole.length) return anyOptionRole;
    return [...document.querySelectorAll("li, div, span, button")].filter((el) => {
      if (before.has(el)) return false; // only elements that appeared after the click
      if (el.children.length > 2) return false; // leaf-ish only, not a whole container
      const text = (el.textContent || "").trim();
      if (!text || text.length > 80) return false; // an option is short text, not a paragraph
      return isVisible(el);
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
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }) || null
    );
  }

  async function fillReactSelectByClick(element, desiredText) {
    const controlEl = element.closest('[class*="__control"]');
    const prefixMatch = controlEl && controlEl.className.match(/(\S+)__control\b/);
    const prefix = prefixMatch ? prefixMatch[1] : null;
    const before = new Set(document.querySelectorAll("*"));
    simulateClick(controlEl || element);
    element.focus();

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

    // Kept in sync with extension/sidepanel.js: async location autocomplete must wait for a
    // stable usable option list (not click the first row the moment any menu appears).
    const isUnusableOptionText = (text) => {
      const t = (text || "").trim();
      if (!t) return true;
      return /^(loading(\.{0,3}|…)?|searching(\.{0,3}|…)?|no options?( found)?|type to search|start typing)/i.test(t);
    };
    const readUsableOptions = () =>
      findComboboxOptions(prefix, before).filter((o) => !isUnusableOptionText(o.textContent));
    const waitForStableOptions = async (maxAttempts) => {
      if (typedInto) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      let options = [];
      let lastSig = "";
      let stableReads = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
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

    const options = await waitForStableOptions(40);
    if (!options.length) {
      revertTypedFilter();
      return false;
    }

    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(desiredText);
    const countryHint = norm((profile && profile.contact && profile.contact.country) || "");
    const textOf = (o) => norm(o.textContent);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    return true;
  }

  async function fillSingle(element, value) {
    const tag = element.tagName.toLowerCase();
    if (tag === "select") return setSelectValue(element, value);
    if (element.type === "checkbox" || element.type === "radio") {
      element.checked = Boolean(value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
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

  // ---- RUN ----
  const filled = [];
  const unmatched = [];
  let nextIdx = 0;
  const stampIdx = (el) => {
    const idx = nextIdx++;
    el.setAttribute("data-af-idx", String(idx));
    return idx;
  };

  const { groups: rcGroups, claimed } = collectRadioCheckboxGroups();
  const buttonGroups = collectButtonGroups(claimed);

  for (const group of [...rcGroups, ...buttonGroups]) {
    const qaMatch = !isConsentField(group.label) && matchQaBank(group.label);
    if (qaMatch && clickGroupOption(group.options, qaMatch.answer)) {
      filled.push({ label: group.label, value: qaMatch.answer, source: "learned" });
      continue;
    }
    // Never let an LLM guess a selection for a group — the options are discrete and often
    // consequential by nature (Yes/No, proficiency level, country...). Report it instead.
    unmatched.push({ label: group.label, type: group.kind, canGenerate: false });
  }

  const nativeElements = collectNativeElements().filter((el) => !claimed.has(el));
  const shadowElements = collectShadowElements();
  const singleTargets = [
    ...nativeElements.map((element) => ({ element, host: element })),
    ...shadowElements.map(({ element, host }) => ({ element, host })),
  ];

  for (const { element, host } of singleTargets) {
    if (element.type === "radio" || element.type === "checkbox") continue; // handled below
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
    const qaMatch = !isConsentField(label) && matchQaBank(label);
    if (qaMatch && (await fillSingle(element, qaMatch.answer))) {
      filled.push({ label, value: qaMatch.answer, source: "learned" });
      continue;
    }
    const tag = element.tagName.toLowerCase();
    const isFreeText = tag === "textarea" || (tag === "input" && /^(text|email|tel|url|search)?$/i.test(element.type || ""));
    const canGenerate =
      isFreeText &&
      !isConsequential(label) &&
      !isConsentField(label) &&
      !structured.isStructuredCategory &&
      !looksLikeComboboxPick(element) &&
      isRequiredField(element, host);
    // Stamped for every non-consent field, not just ones eligible for generation — the side
    // panel tries an AI-based QA-bank match (semantic retrieval, never generation — see
    // /match-answers) against ALL of these first, including selects/comboboxes that could
    // never safely be generated into but can still be correctly filled from a real saved
    // answer, before falling back to generation only for the canGenerate subset.
    const idx = isConsentField(label) ? undefined : stampIdx(element);
    unmatched.push({ idx, label, type: element.type || tag, canGenerate });
  }

  // Ungrouped single checkboxes (no shared `name`, so not caught above) — e.g. a lone
  // "Subscribe to updates" checkbox. Matched as yes/no against the QA bank only; never
  // generated, since a bare checkbox's real-world meaning is too context-dependent to guess.
  for (const el of collectNativeElements()) {
    if ((el.type !== "radio" && el.type !== "checkbox") || claimed.has(el)) continue;
    // tabindex="-1" marks a checkbox as non-focusable — in practice this means it's a
    // decorative native-form/ARIA proxy sitting alongside a custom-rendered control (e.g.
    // Ashby's button-driven Yes/No pairs, see collectButtonGroups) rather than something a
    // real user tabs to and toggles directly. Filling it here would be a false positive:
    // `.checked` flips and gets reported as filled, but the actual app (which reacts to the
    // real button's click handler, not this checkbox's native change event) never sees it —
    // confirmed live, this exact pattern silently left "Are you currently based in Poland?"
    // unanswered on the real page while Auto Fill's own report claimed success.
    if (el.getAttribute("tabindex") === "-1") continue;
    const label = labelForElement(el, el);
    const qaMatch = !isConsentField(label) && matchQaBank(label);
    if (qaMatch) {
      await fillSingle(el, /^(yes|true|y)$/i.test(qaMatch.answer.trim()));
      filled.push({ label, value: qaMatch.answer, source: "learned" });
    } else {
      unmatched.push({ label, type: el.type, canGenerate: false });
    }
  }

  return { filled, unmatched };
}

// Injected into the page — second pass. Re-locates elements stamped with data-af-idx by
// runAutofillInPage (element refs can't survive the round trip to the side panel and back,
// where /match-answers and/or /generate-answer were called), fills each with its resolved
// answer, then strips the stamped attribute so it doesn't linger in the page's markup. Fill
// dispatch mirrors runAutofillInPage's fillSingle (select/checkbox/combobox/plain text) since
// an AI-matched answer (see /match-answers) can land on any of those kinds of fields, not just
// the free-text ones generation is restricted to.
async function fillGeneratedAnswersInPage(answers) {
  function nativeSet(element, value) {
    const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
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

  function simulateClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
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
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }) || null
    );
  }

  async function fillReactSelectByClick(element, desiredText) {
    const controlEl = element.closest('[class*="__control"]');
    const prefixMatch = controlEl && controlEl.className.match(/(\S+)__control\b/);
    const prefix = prefixMatch ? prefixMatch[1] : null;
    const before = new Set(document.querySelectorAll("*"));
    simulateClick(controlEl || element);
    element.focus();

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

    const isUnusableOptionText = (text) => {
      const t = (text || "").trim();
      if (!t) return true;
      return /^(loading(\.{0,3}|…)?|searching(\.{0,3}|…)?|no options?( found)?|type to search|start typing)/i.test(t);
    };
    const readUsableOptions = () =>
      findComboboxOptions(prefix, before).filter((o) => !isUnusableOptionText(o.textContent));
    const waitForStableOptions = async (maxAttempts) => {
      if (typedInto) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      let options = [];
      let lastSig = "";
      let stableReads = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
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

    const options = await waitForStableOptions(40);
    if (!options.length) {
      revertTypedFilter();
      return false;
    }

    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(desiredText);
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
    } else if (el.type === "checkbox" || el.type === "radio") {
      el.checked = /^(yes|true|y)$/i.test(String(value).trim());
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
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
function runLearnInPage() {
  function cleanedText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"], svg, script, style').forEach((n) => n.remove());
    return (clone.textContent || "").trim();
  }

  function normalizeLabel(raw) {
    let text = (raw || "").replace(/ /g, " ").trim();
    text = text.replace(/\(\s*(required|optional)\s*\)\s*$/i, "").trim();
    // Screen-reader-only "Required" text right after the asterisk (Teamtailor: <sup>*</sup>
    // <span class="sr-only">Required</span> concatenates to "...*Required" via textContent).
    // The asterisk itself is often marked aria-hidden and already stripped by cleanedText
    // by the time this runs (Teamtailor: "First name" + hidden "*" + sr-only "Required" ->
    // "First nameRequired" with no "*" left at all) — so the asterisk here is optional, not
    // required, to still catch that case as well as sites where it stays as visible text.
    text = text.replace(/\*?\s*(required|optional)\s*$/i, "").trim();
    // "✱" (U+2731, a heavy asterisk-like star) is Lever's own required-marker glyph -
    // confirmed live: every Lever label ("Full name✱", "Email✱", ...) kept its trailing "✱"
    // uncleaned, since only the plain "*"/"•" characters were covered here before.
    text = text.replace(/[:\s]*[*•✱][:\s]*$/, "").trim();
    text = text.replace(/^[*•✱]\s*/, "").trim();
    return text.replace(/\s+/g, " ").trim();
  }

  function findLabelInAncestors(host) {
    let node = host.parentElement;
    for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
      const controls = node.querySelectorAll('input:not([type="hidden"]), select, textarea, [label]');
      if (controls.length > 1) break;
      const label = node.querySelector("label");
      if (label && cleanedText(label)) return cleanedText(label);
    }
    return null;
  }

  function findGroupContextLabel(host) {
    let node = host.parentElement;
    for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
      if (node.getAttribute && node.getAttribute("role") === "group") {
        const labelledby = node.getAttribute("aria-labelledby");
        if (labelledby) {
          const text = labelledby
            .split(/\s+/)
            .map((id) => {
              const el = document.getElementById(id);
              return el ? cleanedText(el) : "";
            })
            .filter(Boolean)
            .join(" ");
          if (text) return text;
        }
      }
    }
    return null;
  }

  function resolveOwnLabel(element, host) {
    host = host || element;
    if (host.hasAttribute && host.hasAttribute("label")) {
      const v = host.getAttribute("label").trim();
      if (v) return v;
    }
    if (element.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (labelEl && cleanedText(labelEl)) return cleanedText(labelEl);
    }
    const parentLabel = element.closest ? element.closest("label") : null;
    if (parentLabel && cleanedText(parentLabel)) return cleanedText(parentLabel);
    // Kept in sync with runAutofillInPage - <fieldset><legend> is the authoritative label for
    // a group of controls, checked before aria-label since Workday's own custom "Select One"
    // button carries a generic, useless aria-label of its own (see the matching comment there
    // for the Workday repro this fixes).
    const fieldset = element.closest ? element.closest("fieldset") : null;
    if (fieldset) {
      const legend = fieldset.querySelector("legend");
      if (legend && cleanedText(legend)) return cleanedText(legend);
    }
    if (element.getAttribute && element.getAttribute("aria-label")) return element.getAttribute("aria-label").trim();
    const placeholder = element.getAttribute && element.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();
    const proximityLabel = findLabelInAncestors(host);
    if (proximityLabel) return proximityLabel;
    let prev = host.previousElementSibling;
    for (let i = 0; i < 3 && prev; i++, prev = prev.previousElementSibling) {
      const text = (prev.textContent || "").trim();
      if (text && text.length < 150) return text;
    }
    return element.name || (host.getAttribute && host.getAttribute("name")) || "";
  }

  function labelForElement(element, host) {
    const own = normalizeLabel(resolveOwnLabel(element, host));
    const groupLabel = normalizeLabel(findGroupContextLabel(host || element) || "");
    if (groupLabel && groupLabel.toLowerCase() !== own.toLowerCase()) {
      return own ? `${groupLabel} - ${own}` : groupLabel;
    }
    return own;
  }

  function isVisible(element) {
    if (element.tagName === "SELECT" && element.classList.contains("select2-hidden-accessible")) return true;
    // select2's own search box and intl-tel-input's country search box are internal UI for a
    // field that's already detected elsewhere (the real <select>, or the phone <input>) — not
    // separate fields the applicant needs to fill themselves.
    if (element.classList.contains("select2-search__field") || element.classList.contains("iti__search-input")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    if (element.offsetParent === null && style.position !== "fixed" && style.position !== "sticky") return false;
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

  // Radio/checkbox groups: one Q/A pair for the whole group ("English level: B2"), not one
  // mis-scoped pair per option ("B2: Yes").
  const byName = new Map();
  for (const el of document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
    if (!isVisible(el) || !el.name) continue;
    if (!byName.has(el.name)) byName.set(el.name, []);
    byName.get(el.name).push(el);
  }
  const claimed = new Set();
  for (const els of byName.values()) {
    if (els.length < 2) continue;
    let groupLabel = null;
    let node = els[0].parentElement;
    for (let depth = 0; depth < 6 && node && !groupLabel; depth++, node = node.parentElement) {
      if (node.tagName === "FIELDSET") {
        const legend = node.querySelector("legend");
        if (legend && cleanedText(legend)) groupLabel = cleanedText(legend);
        if (!groupLabel) {
          const optionIds = new Set(els.map((o) => o.id).filter(Boolean));
          const candidate = [...node.querySelectorAll("label")].find((l) => {
            const forId = l.getAttribute("for");
            return !forId || !optionIds.has(forId);
          });
          if (candidate && cleanedText(candidate)) groupLabel = cleanedText(candidate);
        }
      } else if (node.getAttribute && node.getAttribute("role") === "group") {
        const labelledby = node.getAttribute("aria-labelledby");
        if (labelledby) {
          const el = document.getElementById(labelledby.split(/\s+/)[0]);
          if (el && cleanedText(el)) groupLabel = cleanedText(el);
        }
      }
    }
    if (!groupLabel) continue;
    const chosen = els.filter((el) => el.checked).map((el) => normalizeLabel(resolveOwnLabel(el)));
    if (chosen.length) learned.push({ question: normalizeLabel(groupLabel), answer: chosen.join(", ") });
    els.forEach((el) => claimed.add(el));
  }

  // Ashby-style button-pair groups — best-effort: relies on the site marking the chosen
  // button (aria-pressed, or a common "selected/active" class), since a plain click leaves
  // no other DOM trace of which one was picked.
  for (const container of document.querySelectorAll('fieldset, [role="group"], [role="radiogroup"]')) {
    if (container.querySelector('input[type="radio"], input[type="checkbox"]')) continue;
    const buttons = [...container.querySelectorAll("button")].filter((b) => (b.textContent || "").trim().length <= 20);
    if (buttons.length < 2 || buttons.length > 6) continue;
    const selected = buttons.find(
      (b) => b.getAttribute("aria-pressed") === "true" || /\b(selected|active|is-selected|is-active)\b/.test(b.className)
    );
    if (!selected) continue;
    let groupLabel = null;
    if (container.tagName === "FIELDSET") {
      const legend = container.querySelector("legend");
      if (legend) groupLabel = cleanedText(legend);
    }
    if (!groupLabel) {
      const labelledby = container.getAttribute("aria-labelledby");
      if (labelledby) {
        const el = document.getElementById(labelledby.split(/\s+/)[0]);
        if (el) groupLabel = cleanedText(el);
      }
    }
    if (!groupLabel) continue;
    learned.push({ question: normalizeLabel(groupLabel), answer: normalizeLabel(selected.textContent) });
  }

  const elements = document.querySelectorAll(
    // Kept in sync with runAutofillInPage's collectNativeElements — `[role="combobox"]` picks
    // up fully custom comboboxes with no real underlying <input>/<select> (e.g. a bare
    // <div role="combobox">), so manually-selected answers on those fields can be Learned too.
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select, [role="combobox"]'
  );
  for (const element of elements) {
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
    if (!isVisible(visibilityTarget) || claimed.has(element)) continue;
    let value;
    if (element.type === "checkbox" || element.type === "radio") {
      if (!element.checked) continue;
      value = element.value && element.value !== "on" ? element.value : "Yes";
    } else if (element.tagName === "SELECT") {
      const selected = [...element.selectedOptions].map((o) => cleanedText(o)).filter(Boolean);
      if (!selected.length) continue;
      value = selected.join(", ");
    } else if (isCombobox) {
      value = getComboboxValue(element);
    } else {
      value = element.value;
    }
    const label = labelForElement(element, element);
    if (label && value && String(value).trim()) {
      learned.push({ question: label, answer: String(value).trim() });
    }
  }
  return learned;
}
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
  { key: "authorized_to_work", re: /authori[sz]ed to work/i },
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


// ---- orchestration ----

async function main() {
  const html = readHtmlInput();
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.Event = dom.window.Event;
  global.CSS = dom.window.CSS || { escape: (s) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };

  // jsdom has no real layout engine, so every element defaults to a 0x0 box - isVisible()'s
  // width/height checks would then reject everything by default, unlike a real browser tab.
  // Default to a plausible on-screen size instead; inline style="display:none"/"visibility:
  // hidden" from the pasted HTML still correctly reports as invisible, since jsdom DOES parse
  // and expose those - this only fills the "no CSS at all" gap, it doesn't override anything
  // the pasted markup itself specifies. It CANNOT reproduce a bug that only shows up from the
  // real site's external stylesheet (e.g. a CSS grid auto-sizing an input to ~0px) - if you hit
  // one of those, tell me and I'll check it a different way.
  dom.window.Element.prototype.getBoundingClientRect = function () {
    const style = dom.window.getComputedStyle(this);
    if (style.display === "none" || style.visibility === "hidden") {
      return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
    }
    return { width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 };
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetParent", {
    get() {
      const style = dom.window.getComputedStyle(this);
      return style.display === "none" ? null : this.parentElement;
    },
  });

  console.log(`Fetching profile/QA bank/settings from ${BASE_URL}...`);
  const [profile, qaBank, settings] = await Promise.all([apiFetch("/profile"), apiFetch("/qa"), apiFetch("/settings")]);

  console.log("Running Auto Fill detection...\n");
  const { filled, unmatched } = await runAutofillInPage(profile, qaBank);

  const idxEligible = unmatched.filter((u) => u.idx !== undefined);
  const finalFills = []; // { idx, label, value, kind }
  let generationCandidates = idxEligible.filter((u) => u.canGenerate);

  if (idxEligible.length && qaBank.length && settings.answer_provider !== "gpt") {
    console.log(`Checking saved answers for a semantic match (${idxEligible.length} question(s), via ${settings.answer_provider})...`);
    try {
      const data = await apiFetch("/match-answers", {
        method: "POST",
        body: JSON.stringify({ questions: idxEligible.map((u) => u.label) }),
      });
      const matchedIdxSet = new Set();
      idxEligible.forEach((item, i) => {
        const r = data.results[i];
        if (r && r.matched && isPlausibleQaMatch(item.label, r.matched_question)) {
          finalFills.push({ idx: item.idx, label: item.label, value: r.answer, kind: "matched" });
          matchedIdxSet.add(item);
        }
      });
      generationCandidates = generationCandidates.filter((item) => !matchedIdxSet.has(item));
    } catch (err) {
      console.log(`  (match-answers failed: ${err.message})`);
    }
  }

  const company = process.env.AUTOFILL_COMPANY || "";
  const jobDescription = process.env.AUTOFILL_JOB_DESCRIPTION || "";
  if (generationCandidates.length) {
    if (settings.answer_provider === "gpt") {
      console.log(`Skipping generation - answer_provider is "gpt" (manual): ${generationCandidates.map((g) => g.label).join(", ")}`);
    } else {
      for (let i = 0; i < generationCandidates.length; i++) {
        const item = generationCandidates[i];
        console.log(`Generating answer ${i + 1}/${generationCandidates.length} via ${settings.answer_provider}: "${item.label}"...`);
        try {
          const data = await apiFetch("/generate-answer", {
            method: "POST",
            body: JSON.stringify({ question: item.label, job_description: jobDescription, company }),
          });
          if (data.answerable !== false && data.answer) {
            finalFills.push({ idx: item.idx, label: item.label, value: data.answer, kind: "generated" });
          } else {
            finalFills.push({ idx: item.idx, label: item.label, value: null, kind: "not answerable (left for you)" });
          }
        } catch (err) {
          console.log(`  failed: ${err.message}`);
        }
      }
    }
  }

  // Apply matched/generated answers into the live DOM so Learn (below) sees the same end state
  // a real Auto Fill run would leave behind - not just whatever was in the pasted HTML.
  const toFill = finalFills.filter((f) => f.value != null).map((f) => ({ idx: f.idx, value: f.value }));
  if (toFill.length) await fillGeneratedAnswersInPage(toFill);

  const filledIdxSet = new Set(finalFills.filter((f) => f.value != null).map((f) => f.idx));
  const needsHuman = unmatched.filter((u) => u.idx === undefined || !filledIdxSet.has(u.idx));

  console.log("\n=== Auto Fill ===");
  for (const f of filled) console.log(`  [${f.source}] ${f.label} -> ${JSON.stringify(f.value)}`);
  for (const f of finalFills) console.log(`  [${f.kind}] ${f.label} -> ${JSON.stringify(f.value)}`);
  for (const u of needsHuman) {
    const note = u.canGenerate === false ? " (not eligible for generation - discrete pick, consequential, or consent)" : "";
    console.log(`  [NEEDS HUMAN INPUT] ${u.label || "(no label)"}${note}`);
  }
  if (!filled.length && !finalFills.length && !needsHuman.length) console.log("  (no fields detected)");

  console.log("\nRunning Learn detection (same DOM, after the fills above)...");
  const learnedPairs = runLearnInPage();
  console.log("\n=== Learn would save ===");
  if (!learnedPairs.length) console.log("  (nothing - no filled-in fields found)");
  for (const p of learnedPairs) console.log(`  ${p.question} -> ${JSON.stringify(p.answer)}`);

  // ---- mismatch check: exactly the "is detection the same for Auto Fill and Learn?" question ----
  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const autofillLabels = new Set(
    [...filled.map((f) => f.label), ...finalFills.map((f) => f.label), ...needsHuman.map((u) => u.label)].filter(Boolean).map(norm)
  );
  const learnLabels = new Set(learnedPairs.map((p) => p.question).filter(Boolean).map(norm));
  const onlyAutofill = [...autofillLabels].filter((l) => !learnLabels.has(l));
  const onlyLearn = [...learnLabels].filter((l) => !autofillLabels.has(l));
  console.log("\n=== Detection mismatch (Auto Fill vs Learn) ===");
  if (!onlyAutofill.length && !onlyLearn.length) {
    console.log("  (none - both detected the same fields)");
  } else {
    for (const l of onlyAutofill) console.log(`  Auto Fill only: ${l}`);
    for (const l of onlyLearn) console.log(`  Learn only: ${l}`);
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
