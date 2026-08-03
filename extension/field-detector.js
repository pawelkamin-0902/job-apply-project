// Loaded once into the target page (via chrome.scripting.executeScript's `files:` option)
// BEFORE either runAutofillInPage or runLearnInPage runs there - every function here becomes a
// global (window.foo) in that page, so both entry points can call the SAME collectFormFields()
// instead of each carrying its own independently-drifting copy of label resolution, visibility
// checks, and group/combobox detection.
//
// This is the single source of truth for "what fields exist on this page and what are their
// labels" - Auto Fill and Learn each still decide what to DO with that list on their own (fill
// vs. read-the-current-value), since that part genuinely differs between them, but neither one
// can find a field the other doesn't anymore, or resolve its label differently, because they're
// not running separate detection code at all now.
//
// Still must be self-contained in the sense that it has no build step / imports - it's plain
// script loaded via a <script> tag (or chrome.scripting.executeScript's files:), so it can only
// rely on browser globals (document, window), same as any other injected script.

// ---- shared label/text helpers ----
// Decorative icons (an inline <svg><desc><p>SVGs not supported...</p></desc></svg> fallback,
// aria-hidden font-icon spans, etc.) contribute their fallback text to a label's plain
// .textContent, silently corrupting the resolved label (seen on Workable: an address-icon SVG
// turned "Address" into "AddressSVGs not supported by this browser."). Strip anything marked
// aria-hidden or living inside an <svg> before reading text.
function cleanedText(el) {
  if (!el) return "";
  const clone = el.cloneNode(true);
  // A <button> nested inside a label/legend/heading (a "Clear"/"Edit"/"Remove" action sitting
  // right inside a section's own <h3>, confirmed live on a Zoho Recruit form:
  // <h3>Primary Information<button>Clear</button></h3>) is UI chrome, not part of the actual
  // label text - without stripping it, the heading-ancestor search below reads the label as the
  // garbled "Primary Information Clear".
  clone.querySelectorAll('[aria-hidden="true"], svg, script, style, button').forEach((n) => n.remove());
  return (clone.textContent || "").trim();
}

function normalizeLabel(raw) {
  // Required/optional marker noise shows up in a different shape on every ATS (leading "*",
  // trailing "* (required)", a colon right before a trailing "*", etc.) — strip it here once
  // instead of trying to special-case every site's pattern.
  let text = (raw || "").replace(/ /g, " ").trim();
  text = text.replace(/\(\s*(required|optional)\s*\)\s*$/i, "").trim();
  // Screen-reader-only "Required" text right after the asterisk (Teamtailor: <sup>*</sup>
  // <span class="sr-only">Required</span> concatenates to "...*Required" via textContent). The
  // asterisk itself is often marked aria-hidden and already stripped by cleanedText by the time
  // this runs (Teamtailor: "First name" + hidden "*" + sr-only "Required" -> "First
  // nameRequired" with no "*" left at all) — so the asterisk here is optional, not required, to
  // still catch that case as well as sites where it stays as visible text.
  text = text.replace(/\*?\s*(required|optional)\s*$/i, "").trim();
  // "✱" (U+2731, a heavy asterisk-like star) is Lever's own required-marker glyph - confirmed
  // live: every Lever label ("Full name✱", "Email✱", ...) kept its trailing "✱" uncleaned,
  // since only the plain "*"/"•" characters were covered here before.
  text = text.replace(/[:\s]*[*•✱][:\s]*$/, "").trim();
  text = text.replace(/^[*•✱]\s*/, "").trim();
  return text.replace(/\s+/g, " ").trim();
}

// Climbs from `host` looking for a <label> that belongs specifically to it, stopping once an
// ancestor contains more than one form control (past that point a label found there would
// belong to the whole group, not this one field). This is the fallback for sites where every
// <label for=""> is present but never actually resolves.
//
// Deliberately does NOT count custom comboboxes ([role="combobox"]) as controls here, even
// though that under-counts a row like Zoho Recruit's "Salutation" combobox sitting beside the
// real "First Name" text input (both end up reading First Name's own real, but positional-only,
// <label> - confirmed live). Counting the combobox stops the climb one level too early for BOTH
// fields at once, since neither has an id/for link to that label either - the combobox's wrong
// label gets fixed, but the actual text input loses its only path to its own correct label and
// falls back to its raw `name` attribute instead. A blank/garbled "First Name" is a bigger
// problem than a wrong "Salutation", so this stays narrow until a fix exists that doesn't cost
// the more consequential field its label.
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

// Composite/grouped fields (Personio: "First" only makes sense combined with its role="group"
// ancestor's own "Name" label) — returns the group's own label, or null.
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

// Climbs from `host` looking specifically for a heading tag (h1-h6) among each ancestor level's
// own previous siblings - see the call site in resolveOwnLabel for why this needs to run, and
// run deeper than the generic short-text sibling climb further down this file.
//
// Can't gate this the same way findLabelInAncestors gates on "more than one control found -
// stop": a join.com date-picker's month AND year comboboxes legitimately share ONE overarching
// heading ("When are you available to start working with us?") several levels up, and that
// shared ancestor level necessarily contains both controls at once - stopping there would defeat
// the fix entirely (confirmed live: it did, in an earlier version of this function).
//
// Instead, gate on the heading's own container being a landmark region: Zoho Recruit wraps a
// whole multi-field SECTION (First/Last name, email, phone, skills, ...) in one
// `role="region" aria-label="Primary Information"` div holding both that section's own <h3> and
// every field inside it - confirmed live, without this check every field lacking a closer label
// climbed straight past its own per-field wrapper into that shared section heading (further
// garbled by the section's own "Clear" button text living inside the same <h3> - see cleanedText
// above). A real per-question heading (the join.com case) never sits inside a landmark region
// shared with unrelated OTHER questions, so this only excludes genuine whole-section titles.
function findHeadingInAncestors(host) {
  let node = host;
  for (let depth = 0; depth < 15 && node; depth++, node = node.parentElement) {
    // Same guard as findLabelInAncestors: an ancestor holding more than one form control is a
    // shared section, not this one field's own container, so a heading found there titles the
    // whole section rather than this specific question - confirmed live, Lever wraps a whole
    // card of 4-5 distinct custom questions under one shared "Additional questions for remote
    // positions in Poland" <h4>, and without this check every question in that card resolved
    // to that same shared heading instead of its own real text.
    const controls = node.querySelectorAll('input:not([type="hidden"]), select, textarea, [label]');
    if (controls.length > 1) break;
    let prev = node.previousElementSibling;
    for (let i = 0; i < 3 && prev; i++, prev = prev.previousElementSibling) {
      if (/^H[1-6]$/.test(prev.tagName)) {
        const container = node.parentElement;
        if (container && container.getAttribute && container.getAttribute("role") === "region") return null;
        const text = cleanedText(prev);
        if (text) return text;
      }
    }
  }
  return null;
}

// Matches a combobox's OWN not-yet-selected placeholder text, not a real question - "Select",
// "Select...", "Choose an option", "-Select-", etc. Deliberately does NOT match an INFORMATIVE
// aria-label that happens to start the same way (BambooHR's Country button carries aria-label
// "Country United States" - the currently selected value, genuinely useful) since this requires
// the WHOLE trimmed string to be just the generic verb/phrase and nothing else.
function isGenericSelectPlaceholder(text) {
  return /^-*\s*(please\s+)?(select|choose)(\s+(one|an\s+option))?\s*\.{0,3}-*$/i.test((text || "").trim());
}

// Lever's own generic text-input placeholder - "Type your response", identical on EVERY custom
// text-type question on the site, never the real question text itself (that lives in a sibling
// <div class="application-label"> - see resolveOwnLabel's own ancestor-climb). Same reasoning as
// isGenericSelectPlaceholder just above: a defense-in-depth filter, in case that ancestor-climb
// ever fails to find a match for some other Lever question shape - without this, the raw
// placeholder fallback below would still accept this meaningless boilerplate as a label.
function isGenericTextPlaceholder(text) {
  return /^type\s+your\s+(response|answer)\.{0,3}$/i.test((text || "").trim());
}

// `host` is the element to resolve DOM-proximity/attribute-based labels from — usually the same
// as `element`, except for shadow-DOM custom elements (SmartRecruiters' <spl-input>) where
// `element` is the real control inside an open shadow root but `host` is the outer custom
// element carrying the actual `label` attribute and sitting in the light-DOM tree.
function resolveOwnLabel(element, host) {
  host = host || element;
  if (host.hasAttribute && host.hasAttribute("label")) {
    const v = host.getAttribute("label").trim();
    if (v) return v;
  }
  // Zoho Recruit's Crux/Lyte field widgets declare the real question on the custom element
  // itself as `cx-prop-label` (e.g. <crux-phone-component cx-prop-label="Mobile">, 
  // <crux-picklist-component cx-prop-label="Salutation">). Confirmed live on
  // manningglobal.zohorecruit.eu: without reading this, the Mobile number <input>'s sibling
  // climb hit the dial-code picker's visible "(+40)" + "Loading" chrome first and resolved
  // the field as "(+40) Loading" (unmatched), and the Salutation combobox wrongly inherited
  // the neighbouring "First Name" <label>. Same category as the host `label` attribute check
  // above — a component-authored label beats proximity guesses. Checked before id/for and
  // sibling climbs so those weaker signals can't win first.
  const cxHost =
    (element.closest && element.closest("[cx-prop-label]")) ||
    (host !== element && host.closest && host.closest("[cx-prop-label]")) ||
    (host.hasAttribute && host.hasAttribute("cx-prop-label") ? host : null);
  if (cxHost) {
    const v = (cxHost.getAttribute("cx-prop-label") || "").trim();
    if (v) return v;
  }
  if (element.id) {
    const labelEl = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (labelEl && cleanedText(labelEl)) return cleanedText(labelEl);
  }
  const parentLabel = element.closest ? element.closest("label") : null;
  if (parentLabel && cleanedText(parentLabel)) return cleanedText(parentLabel);
  // <fieldset><legend> is the standard, authoritative way to associate a label with a group of
  // controls - checked before aria-label/aria-labelledby since Workday's own custom "Select
  // One" button carries a generic, useless aria-label ("Select One Required" - just its own
  // placeholder/state, not the actual question) while the real question sits in the <legend>
  // one level up. Confirmed live: without this check ahead of aria-label, every CrowdStrike
  // Workday questionnaire question resolved to the literal string "Select One" instead of the
  // real question text.
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
  // A combobox's OWN aria-label is sometimes just its current, still-unselected placeholder
  // state ("Select", "Select...", "Choose an option") rather than the actual question -
  // confirmed live: Rippling's custom Select widget renders `aria-label="Select"` on every
  // single custom question with no fieldset/legend and no id/for/aria-labelledby link to its
  // real question text at all (a plain, unassociated sibling <p> several ancestor levels up is
  // the ONLY place the real text lives). Trusting it made SEVEN different questions - including
  // "...unrestricted right to work...", "...require sponsorship...", and "...salary
  // expectations..." - all resolve to the literal identical string "Select", which then let one
  // unrelated stored QA-bank answer ("Fluent", from a language-proficiency question) get matched
  // onto every one of them at once. Skipping a generic placeholder value here just falls through
  // to the proximity/heading/sibling-text checks below instead, same as if no aria-label had
  // been set at all.
  if (
    element.getAttribute &&
    element.getAttribute("aria-label") &&
    !isGenericSelectPlaceholder(element.getAttribute("aria-label"))
  )
    return element.getAttribute("aria-label").trim();
  if (
    host !== element &&
    host.getAttribute &&
    host.getAttribute("aria-label") &&
    !isGenericSelectPlaceholder(host.getAttribute("aria-label"))
  )
    return host.getAttribute("aria-label").trim();
  // A real <label> found in a shallow ancestor (findLabelInAncestors bails out if that ancestor
  // holds more than one control, so it's a fairly reliable signal) beats a generic placeholder
  // hint — confirmed live: an Ashby "Location" combobox had no id/label[for] pair at all (the
  // visible input carries no id), so this used to fall through to its placeholder, "Start
  // typing...", instead of the real "Location" label one level up in the DOM — meaning a saved
  // profile location never matched it, silently, even though the correct label was right there
  // in the markup.
  const proximityLabel = findLabelInAncestors(host);
  if (proximityLabel) return proximityLabel;
  // A <h1>-<h6> is an unambiguous "this is the actual question" signal, unlike a plain sibling
  // div or a generic placeholder - confirmed live on join.com's Chakra-based screening-question
  // flow, where every question renders as <div><h2>{real question}</h2><div>{control(s), several
  // levels deep}</div></div>. Two different fields there each lost their real question to a
  // closer, weaker signal: a number input's generic i18n placeholder ("Please provide a number",
  // same boilerplate string for every integer question on the site) beat the h2 only because
  // placeholder was checked first; a custom date-picker's own month/year comboboxes each read
  // their currently-selected VALUE display div ("July", "2026") as their label, since that div is
  // a much shallower sibling-of-an-ancestor than the real h2 (which sits ~12 levels up, inside
  // the date-picker's own open-calendar-popup wrapper markup - deeper than the plain short-text
  // sibling climb below ever reaches). A heading match is checked ahead of both for exactly this
  // reason, and searches deeper than that plain-text climb since matching on tag name (not just
  // "any short text") keeps the false-positive risk low even at that depth.
  const headingLabel = findHeadingInAncestors(host);
  if (headingLabel) return headingLabel;
  // Some form frameworks skip both a real <label> and any ARIA labelling entirely — Lever's own
  // custom-question fields, confirmed live, put the question text in a plain sibling
  // <div class="application-label"> of an ANCESTOR of the field (a "label div and
  // field-wrapper div both children of one shared question container" shape), not a direct
  // sibling of the field itself. Without this, resolution fell all the way through to the
  // field's raw `name` attribute instead ("cards[38843bea-...][field0]") — meaningless to a
  // human, and worse, meaningless to the consequential-field safety check and the answer-
  // generation prompt too, since neither ever saw the real question ("What would be your
  // monthly gross salary expectations in PLN?"). Climbs several ancestor levels, checking each
  // one's own previous siblings, stopping as soon as usable text is found - gated the same way
  // findLabelInAncestors/findHeadingInAncestors are (stop once an ancestor holds more than one
  // real control) so this doesn't run past its own field's wrapper into a shared section's text.
  // Widened from 4 to 10 levels - confirmed live, Rippling's own custom Select wraps its
  // combobox 6 levels deep inside per-widget framework divs (select-controller, a bare
  // wrapper, customQuestions..., etc.) before reaching the field wrapper whose previous
  // sibling is the real floating <p> question text; depth 4 never climbed far enough to reach
  // it, so every one of these fields fell through all the way to a meaningless raw `name`.
  //
  // CONFIRMED LIVE this must run BEFORE the placeholder fallback below, not after (an earlier
  // version had it after) - Lever's own custom-question <input>s all carry the exact same
  // generic placeholder, "Type your response" (analogous to a combobox's own generic "Select"
  // placeholder, just never filtered the same way), so the placeholder check used to return
  // that meaningless boilerplate immediately, before this Lever-specific climb - the one
  // actually meant to solve this exact case - ever got a chance to run at all. Reported live: a
  // real Lever application had two real questions ("When are you available to start working?",
  // "Please share a link to your portfolio or previous work.") both resolve to the literal
  // string "Type your response" instead.
  let node = host;
  for (let depth = 0; depth < 10 && node; depth++, node = node.parentElement) {
    const controls = node.querySelectorAll('input:not([type="hidden"]), select, textarea, [label]');
    if (controls.length > 1) break;
    let prev = node.previousElementSibling;
    for (let i = 0; i < 3 && prev; i++, prev = prev.previousElementSibling) {
      const text = cleanedText(prev);
      if (!text || text.length >= 200) continue;
      // Skip phone dial-code / flag-picker chrome that sits as a previous sibling of the
      // real number input inside Zoho's <crux-phone-component> (and similar split phone
      // widgets). Confirmed live: cleanedText of that sibling is "(+40) Loading" — a
      // calling-code display plus a transient "Loading" status, not a question label. The
      // cx-prop-label check above usually wins first; this is the safety net when that
      // attribute is missing.
      if (/^\(\+\d{1,4}\)/.test(text)) continue;
      if (/^(\+\d{1,4}|\(\+\d{1,4}\))\s*(loading)?$/i.test(text)) continue;
      return text;
    }
  }
  const placeholder = element.getAttribute && element.getAttribute("placeholder");
  if (placeholder && placeholder.trim() && !isGenericTextPlaceholder(placeholder)) return placeholder.trim();
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

// ---- visibility ----
function isVisible(element) {
  // select2 hides the real <select> (aria-hidden, near-zero size) and shows a fake widget in
  // its place — it's still the real, fillable control, unlike a genuine decoy.
  if (element.tagName === "SELECT" && element.classList.contains("select2-hidden-accessible")) return true;
  // select2's own search box and intl-tel-input's country search box are internal UI for a
  // field that's already detected elsewhere (the real <select>, or the phone <input>) — not
  // separate fields the applicant needs to fill themselves.
  if (element.classList.contains("select2-search__field") || element.classList.contains("iti__search-input")) return false;
  // Zoho Recruit's own Lyte-framework dropdown search/filter box (e.g. a "Current Location"
  // combobox's own type-to-filter input, id="searchsingle_..._Current_Location") is the same
  // category of internal-search-box UI as the two above - not itself a question, just a filter
  // for the combobox it's nested inside. The `lyteSearchInput` class lives on the wrapping
  // `<lyte-input>`, not the plain `<input>` itself (which carries no distinguishing class of its
  // own), so this needs `.closest()`, not `.classList.contains()` - confirmed live: without it,
  // the bare input surfaced as its own separate blank-label "unmatched" field.
  if (element.closest && element.closest(".lyteSearchInput")) return false;
  // select2's whole rendered widget (the fake dropdown/search box replacing the real, hidden
  // <select> above) is presentational chrome for a field detected separately - not just its
  // search box specifically. Confirmed live: its own `role="combobox"` span matched detection
  // as a second, duplicate field sharing the real select's label (sometimes with a garbled
  // label made of the real select's own concatenated option text, picked up via label
  // resolution's sibling-climbing fallback).
  if (element.closest && element.closest(".select2-container")) return false;
  // Zoho Recruit's own phone-number widget (<crux-phone-component>) renders its country/dial-
  // code picker as a separate `<lyte-dropdown lt-prop-user-value="dial_code">` sibling of the
  // real number input, inside a plain `<div role="combobox">` with no label of its own anywhere
  // nearby - confirmed live, it surfaced as its own blank-label "unmatched" field. Same category
  // as select2/intl-tel-input's search boxes above: decorative UI for a field whose real,
  // labeled value belongs to a DIFFERENT part of the same logical phone field (the component's
  // own `cx-prop-label`), not a separate question the applicant answers.
  if (element.closest && element.closest('[lt-prop-user-value="dial_code"]')) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  // Checks the whole ancestor chain, not just the element itself - confirmed live, a jobvite
  // "paste your resume as text" box had `aria-hidden="true"` on a wrapping <div>, not on the
  // <textarea>/buttons inside it, so those leaked through as fillable (and the "Cancel"/"Save"
  // buttons inside it got mis-detected as a fake 2-option answer group). A real interactive
  // control simply never belongs inside an aria-hidden ancestor in a well-built page - genuine
  // fields aren't hidden this way, only decoys/inactive-state UI are.
  if (element.closest && element.closest('[aria-hidden="true"]')) return false;
  // rangeslider.js-style widgets (and similar) hide the REAL native `<input type="range">`
  // behind a fully custom-rendered slider visual, keeping the native input around at
  // near-zero width/opacity purely so its own value stays the actual form-submission source of
  // truth - the same "real control, fake decorative visual on top of it" shape as select2's
  // hidden SELECT above, not an a11y decoy (which is virtually always a plain text input, never
  // a range slider). Confirmed live on a Teamtailor "How many years of experience..." question:
  // `<input type="range" style="width:1px; height:100%; opacity:0; ...">`, its value mirrored
  // by a separate, fully custom `.rangeslider` div elsewhere in the DOM - the rect-size check
  // below would otherwise treat it exactly like a Workable a11y decoy and silently drop the
  // entire field, with no unmatched entry left even to ask the applicant about it.
  if (element.tagName === "INPUT" && element.type === "range") return true;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false; // visually-hidden a11y decoys (Workable)
  if (element.offsetParent === null && style.position !== "fixed" && style.position !== "sticky") return false;
  return true;
}

// Honeypot/decoy fields: confirmed live on a BambooHR "Fabric" form — a text input named
// "nickname_hpcsaf", labeled "Please leave this field blank", tabindex="-1", sitting inside an
// aria-hidden ancestor (not itself aria-hidden, so isVisible() above doesn't catch it) but
// otherwise normal-sized and unhidden by CSS, so it passes every other visibility check too. It
// carried all five standard password-manager "don't touch this" attributes at once
// (data-lpignore, data-1p-ignore, data-bwignore, data-dashlane-ignore, data-protonpass-ignore) —
// the same signal 1Password/Bitwarden/Dashlane/LastPass/ProtonPass already honor to avoid
// exactly this trap.
function isHoneypot(element) {
  return (
    element.hasAttribute("data-lpignore") ||
    element.hasAttribute("data-1p-ignore") ||
    element.hasAttribute("data-bwignore") ||
    element.hasAttribute("data-dashlane-ignore") ||
    element.hasAttribute("data-protonpass-ignore")
  );
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

// ---- DETECT ----
function collectNativeElements() {
  return [
    ...document.querySelectorAll(
      // `[role="combobox"]` covers fully custom comboboxes with no real underlying
      // <input>/<select> at all (confirmed live: an Angular CDK-based ATS renders its
      // "Country" field as a bare, non-form <div role="combobox">, backed only by an Angular
      // FormControl with no native form element anywhere) — without this, such a field is
      // invisible to detection entirely (never even reaches `unmatched`, let alone gets
      // filled), not just hard to fill once found.
      // `button[aria-haspopup="listbox"]` covers Workday's own "Select One" single-pick
      // dropdown (confirmed live: a CrowdStrike questionnaire's Yes/No custom questions are
      // each a plain `<button aria-haspopup="listbox">Select One</button>` with no
      // role="combobox" anywhere) - it's the only visible, clickable part of that field.
      // `button[aria-haspopup="true"]` covers BambooHR's own "Fabric" design-system Select
      // component (confirmed live: a "Country" field is a plain
      // `<button aria-haspopup="true" aria-expanded="false" aria-label="Country Poland">`, with
      // the real underlying `<select>` deliberately hidden - aria-hidden, near-zero size - and
      // no role="combobox" anywhere on the button either) - without this, the whole field was
      // invisible to detection entirely, not just hard to fill, which was reported live as
      // "country selection is not correct" when what was actually happening is the field was
      // never being found or filled at all (and city/province, real text inputs that this
      // BambooHR form updates based on the selected country, ended up wrong as a direct
      // consequence of country silently never being set first).
      // `[role="button"][aria-haspopup="true"]` covers HiBob's own Angular CDK Overlay-based
      // "Country" combobox trigger (confirmed live: a plain
      // `<div role="button" aria-haspopup="true" aria-expanded="false" aria-labelledby="label-
      // /candidate/country">`, no `role="combobox"` anywhere, and NOT a real `<button>` tag -
      // reported live as "country selection is not working," which was actually this field never
      // being detected in the first place, same class of bug as the BambooHR case below (this
      // one just uses a styled <div>, not an actual <button>, so the existing
      // `button[aria-haspopup="true"]` selector's tag restriction excluded it entirely). Kept
      // paired with the SAME `aria-haspopup="true"` qualifier already trusted for the <button>
      // case above, rather than matching any `[role="button"]` alone, for the exact same
      // false-positive reasons documented below for `aria-multiselectable`/`aria-expanded`.
      // `[aria-multiselectable="true"]` covers a disclosure-style multi-select trigger
      // (confirmed live on a Homerun-style ATS "select all that apply" question): the real
      // checkbox group exists in the DOM but sits inside a `display:none` wrapper (a decoy for a
      // custom dropdown UI, same as any other framework that hides its real inputs behind a
      // fancier widget), and the trigger button itself carries `role="button"`, not
      // `role="combobox"` and no `aria-haspopup` - without this, the whole question was invisible
      // to detection entirely, not just hard to fill (worse than unmatched: a required question
      // silently missing from the report, with no warning before the real page's own validation
      // rejected the blank submission). Deliberately narrow: an earlier version of this used the
      // much broader `button[aria-expanded]` instead, which also matches plain disclosure widgets
      // that have nothing to do with answering a question - confirmed live, it pulled in phone
      // country-code picker buttons (already correctly handled elsewhere via setPhoneValue),
      // generic icon buttons, and "import your resume" banners as bogus extra fields, several of
      // which then got nonsense values learned/reported. `button[aria-haspopup="true"/"listbox"]`
      // and `aria-multiselectable="true"` are specific enough that neither false-positives on
      // any of those.
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select, [role="combobox"], button[aria-haspopup="listbox"], button[aria-haspopup="true"], [role="button"][aria-haspopup="true"], [aria-multiselectable="true"]'
    ),
  ]
    .filter(isVisible)
    .filter((el) => !isHoneypot(el))
    .filter((el) => {
      // That same button renders a plain hidden native <input type="text"> right beside it as
      // an accessibility/focus proxy - the same logical field as the button, not a second one,
      // so it's excluded here rather than reported as a separate (mislabeled) field.
      const prev = el.previousElementSibling;
      return !(el.tagName === "INPUT" && prev && prev.tagName === "BUTTON" && prev.getAttribute("aria-haspopup") === "listbox");
    })
    // Workday's own global nav bar - the language switcher and the settings/accessibility gear
    // icon in the top utility bar - are BOTH plain `<button aria-haspopup="listbox">`, the exact
    // same shape as a real "Select One" form dropdown, and both carry
    // `data-automation-id="utilityMenuButton"`. Confirmed across 9 different Workday tenants
    // (Cisco, JLL, Kainos, Live Nation, RBS, Spectris, Zoom, plus the original bdx-wd1 report):
    // every single one surfaced these two as blank-label "unmatched" noise, since they're site
    // chrome with no real question text anywhere nearby - not a field the applicant ever needs
    // to fill. Same "exclude by ATS-specific automation id" approach already used for phone
    // country-code pickers and file-upload action buttons elsewhere in this function.
    .filter((el) => el.getAttribute("data-automation-id") !== "utilityMenuButton")
    // A custom element that hosts its OWN open shadow root (e.g. a SmartRecruiters `<spl-*>`
    // location/combobox widget whose real, interactive input lives inside that shadow root -
    // collectShadowElements below already finds it separately) must not ALSO be collected here
    // just because the outer host itself happens to carry role="combobox"/aria-haspopup - that
    // reflects the HOST's own open/closed display state, not a second, independently fillable
    // field. Reported live on SmartRecruiters: a location field got filled correctly once, then
    // Auto Fill immediately tried "the same field again" (a fresh search, "no data found", the
    // widget then visually collapsing) - the host combobox and its own shadow-internal input
    // were both ending up as separate `singles` entries for what's really one physical widget,
    // so it got processed twice. Excluding shadow-hosting elements here means the shadow-
    // internal input (the genuine fillable target) is the only entry collected for it.
    .filter((el) => !el.shadowRoot);
}

// SmartRecruiters-style custom elements (<spl-input label="...">) with an open shadow root
// wrapping a real input/select/textarea. Closed shadow roots are genuinely inaccessible from a
// content script — those fields just fall through as unmatched.
function collectShadowElements() {
  // querySelector (singular) here was a real bug: a single custom element whose shadow root
  // renders MULTIPLE fields (e.g. a schema-driven form component rendering five separate
  // questions from one JSON "definition" attribute — seen live on a SmartRecruiters screening-
  // questions form) would only ever surface the first one, silently dropping the rest.
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

// Groups radio/checkbox inputs sharing a `name` into one question with N options, using the
// nearest <fieldset>+<legend> or role="group" ancestor for the group's own label — covers both
// single-select radio groups and multi-select checkbox groups (Teamtailor).
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
          // Some ATSs (Ashby) skip <legend> entirely and put the question in a plain <label>
          // inside the <fieldset> instead — findable only by elimination: it's the one label
          // whose `for` doesn't point at one of this group's own options.
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
    // A file-upload widget's own "Attach"/"Dropbox"/"Google Drive"/"Enter manually" action
    // buttons sit inside a `role="group"` with a real `<input type="file">` alongside them -
    // confirmed live, a Greenhouse "Resume/CV" upload section got mis-detected as a fake
    // 4-option answer question, risking clickGroupOption auto-clicking "Attach"/"Dropbox"/etc.
    // if some unrelated QA-bank entry ever scored a loose word-overlap match against "Resume/
    // CV" - a real file input anywhere in the same group is a reliable, ATS-agnostic signal
    // these are upload actions, never a real multi-choice answer.
    if (container.querySelector('input[type="file"]')) continue;
    const buttons = [...container.querySelectorAll("button")].filter((b) => {
      const t = (b.textContent || "").trim();
      // Neither button-group pass previously checked visibility at all - confirmed live, a
      // jobvite "paste your resume as text" box hidden via aria-hidden="true" on an ancestor
      // (not caught by isVisible before that check existed either way) had "Cancel"/"Save"
      // action buttons inside it mis-detected as a fake 2-option answer to "Type or paste your
      // Resume here" (the label meant for the actual paste textarea, picked up via ancestor
      // climbing). Real UI action buttons the user never sees can't be a real question.
      return t && t.length <= 20 && !claimed.has(b) && isVisible(b);
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
  // fieldset/role="group"/role="radiogroup" at all (confirmed live — a real "Are you currently
  // based in Poland?" question built exactly this way), so the pass above never finds a
  // container to look inside in the first place. Handles whatever the fieldset/role pass above
  // didn't already claim, keyed off any 2-6 sibling <button>s sharing a parent, with the
  // group's own label found via the nearest ancestor's own <label> (real question labels always
  // sit in a shallow ancestor of their answer buttons on every ATS seen so far, not deep inside
  // an unrelated container).
  const seenParents = new Set();
  for (const btn of document.querySelectorAll("button")) {
    if (claimed.has(btn)) continue;
    const parent = btn.parentElement;
    if (!parent || seenParents.has(parent)) continue;
    seenParents.add(parent);
    // Same file-upload-widget exclusion as the container-based pass above, for a form whose
    // upload section happens to lack a role="group" wrapper.
    if (parent.querySelector('input[type="file"]')) continue;
    const buttons = [...parent.children].filter((b) => {
      if (b.tagName !== "BUTTON" || claimed.has(b)) return false;
      const t = (b.textContent || "").trim();
      return t && t.length <= 20 && isVisible(b);
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

// The single entry point both runAutofillInPage and runLearnInPage call. Returns:
//   groups: [{ kind, label, options: [{element, optionLabel}] }]  - radio/checkbox/button groups
//   singles: [{ element, host }]  - plain text/textarea/select/combobox fields (host !== element
//                                   only for shadow-DOM elements)
//   loneCheckboxes: [{ element, host }]  - a lone checkbox/radio with no shared `name`, so it's
//                                          its own yes/no field rather than part of a group
//   claimed: Set of elements already spoken for by a group (useful if a caller needs it)
function collectFormFields() {
  const { groups: rcGroups, claimed } = collectRadioCheckboxGroups();
  const buttonGroups = collectButtonGroups(claimed);
  const nativeElements = collectNativeElements().filter((el) => !claimed.has(el));
  const shadowElements = collectShadowElements();
  const allSingleTargets = [...nativeElements.map((element) => ({ element, host: element })), ...shadowElements];

  const singles = [];
  const loneCheckboxes = [];
  for (const target of allSingleTargets) {
    if (target.element.type === "radio" || target.element.type === "checkbox") {
      loneCheckboxes.push(target);
    } else {
      singles.push(target);
    }
  }

  return { groups: [...rcGroups, ...buttonGroups], singles, loneCheckboxes, claimed };
}
