# ATS form-fixture notes

**All fixtures below are verbatim** — exact byte-for-byte copies of what was pasted in
chat, including the `-PARTIAL` ones (which are verbatim up to the point a chat message
size limit cut the original paste off, marked with a `TRUNCATED HERE` comment — nothing past
that point was received, and nothing before it was edited). An earlier pass at these files
had condensed/rewritten them for brevity; that was wrong for a fixture library meant to
back automated testing later, so they were redone as exact copies.


Real captured HTML from application forms across different ATS platforms, gathered to
design/validate the autofill content script's field-detection logic (`sidepanel.js` —
`runAutofillInPage`/`runLearnInPage`, specifically the `detectFormFields`/`labelForElement`
functions, explicitly marked as a placeholder meant to be swapped for something more
sophisticated).

## Contributor log (Claude ↔ Cursor)

This file is the shared handoff between assistants working on autofill. **When you fix
something, append a new numbered finding under "Confirmed findings"** (continue the sequence)
and tag who did it:

- **`Author: Claude`** — written by Claude (historical entries before this section often
  omit the tag but are Claude's work unless noted otherwise).
- **`Author: Cursor`** — written by Cursor after a code change in this repo.

Each entry should say: symptom (live-reported if possible), root cause, what changed (file +
function names), whether it's confirmed live or "not yet confirmed", and any follow-up for the
other assistant. Cross-reference earlier findings by number (`#86`, `#106`, …) instead of
re-explaining them.

## Fixtures

| File | ATS | Notes |
|---|---|---|
| `smartrecruiters-devexperts.html` | SmartRecruiters | Custom Web Components (`<spl-input>` etc.), label is an *attribute*, not DOM text. Real `<input>` likely inside shadow DOM — unconfirmed, needs DevTools check for `open` vs `closed` root. |
| `ashby-splitmetrics.html` | Ashby | Mostly standard `label[for]`. Yes/No questions are button pairs, not real radio/checkbox. Real `<fieldset>`+radio group present but current code mis-detects it (see below). Custom `react-select`-style combobox for country. |
| `workable-intetics.html` | Workable | Standard `label[for]`, but required-asterisk text is *inside* the same `<label>`, positioned *before* the field name — breaks `^`-anchored regex. Hidden decoy address fields (`city`/`postcode`/`country`) not caught by `offsetParent === null` visibility check. |
| `personio-chargecloud.html` | Personio | Cleanest sample — real `label[for]` + real `<select>`. New pattern: grouped/composite fields (first/last name) where the individual label is only meaningful combined with a `role="group"` ancestor's own `aria-labelledby` label. |
| `jobvite-ziffdavis-PARTIAL.html` | Jobvite (old AngularJS) | **Partial** — cut off by chat message size limit. Standard `label[for]`. Required-asterisk is a `<span>` nested *inside* the label, after the text. |
| `greenhouse-gr8tech-PARTIAL.html` | Greenhouse | **Partial** — cut off by chat message size limit (240-country dial-code list). Confirms `react-select`-style combobox and `intl-tel-input` (`iti__*` classes) are NOT platform-specific — both are widely-used third-party libraries that will recur across many different ATS platforms. |
| `smartcat-iframe-wrapper.html` | Greenhouse (embedded) | The employer's own page (`smartcat.com`) has **no form fields at all** in its own DOM — it's a bare `<iframe src="https://job-boards.greenhouse.io/embed/job_app?...">`. Real fields are in the iframe's own cross-origin document. Confirms the cross-origin-embed pattern the existing code already handles via `allFrames: true` — worth a live test to verify script injection actually reaches into the iframe on a real page. |
| `careers-page-humanit-PARTIAL.html` | careers-page.com | **Partial** — cut off by chat message size limit (mid-way through a huge tech-stack select2 options list). New finding: every `<label>` on this platform has a literal empty `for=""` attribute — label-to-input linkage is *completely broken* via `label[for]` id-matching (the real input has a real `id`, e.g. `field64641`, but the label never references it). Association only works via DOM proximity (nearest ancestor `.form-group`). Also a fourth required-marker shape: trailing `<span>*</span>` preceded by a literal colon in the label's own text ("Full Name: *"), and optional fields have no marker at all — just an empty Vue comment node (`<!---->`) where the asterisk span would be, confirming marker-absence, not empty-string marker, is what "optional" looks like in the DOM. Also introduces `select2` (`<select multiple>` hidden + `.select2-container` UI) as yet another third-party combobox widget — same underlying problem as `react-select`: the visible search input isn't the real form control, and setting the real `<select>`'s value in JS still needs a synthetic `change` event fired for select2's UI to reflect it. |
| `teamtailor-opinov8-PARTIAL.html` | Teamtailor | **Partial** — cut off by chat message size limit (240-country dial-code list again). New finding: the form lives inside a `<turbo-frame>`, not a real `<iframe>` — Turbo/Hotwire fetches `src` and swaps the response into the *same* document, so no cross-origin frame-piercing (`allFrames: true`) is needed here, unlike `smartcat-iframe-wrapper.html`'s true iframe. Also confirms the checkbox-group version of the radio-group bug: "Locations" is a `<fieldset>`+`<legend>` group of two checkboxes (Europe/Ukraine) that current code would detect as two separate fields ("Europe", "Ukraine") instead of one "Locations" multi-select question. Third confirmation of `intl-tel-input` (`iti__*` classes) as a cross-ATS third-party widget. |
| `ashby-nordsecurity-PARTIAL.html` | Ashby (Nord Security posting) | **Partial** — only the form itself was captured, not the surrounding page. New Yes/No shape: button pair with NO `fieldset`/`role="group"`/`role="radiogroup"` wrapper at all (unlike `ashby-splitmetrics.html`'s Ashby form, which does use one) — a real but `tabindex="-1"` (non-focusable, decorative) `<input type="checkbox">` sits alongside, presumably mirroring React state after a button click rather than driving it. Also: a "Location" combobox whose visible `<input>` carries no `id` at all, so its real `<label for="...">` (pointing at a nonexistent id) never linked up via the usual `label[for]` lookup — and it's a type-to-search autocomplete (nothing renders until you type), a third distinct combobox-filling pattern alongside plain-click-to-reveal (react-select) and click-then-type-into-a-separate-box (see the CDK entry above).
| `lever-oxylabs.html` | Lever | **Complete, not partial** — a full page capture via "Save Sample", not a chat paste. Severe real bug (see finding 18): custom-question `<textarea>`s have no `<label>`, no ARIA labelling, and no direct-sibling text either — the question text lives in a `<div class="application-label">` that's a sibling of an ANCESTOR of the field, one level removed. Label resolution fell all the way through to the field's raw `name` attribute (`cards[<uuid>][field0]`), with real consequences: a "monthly gross salary" question's resolved "label" no longer contained the word "salary", so it silently bypassed the consequential-field safety check and got sent to AI generation, which produced a generic non-answer. Also confirmed: Lever's own required-marker glyph is "✱" (U+2731), not the `*`/`•` this codebase already handled — left unstripped in every label.
| `greenhouse-newrelic-PARTIAL.html` | Greenhouse (newer React variant) | **Partial with a real gap** — two separate messages each hit the chat size limit at roughly the same point in the phone widget's country list; a third, complete message covers the custom questions further down, but genuine content between the two (rest of the country list, closing tags) was never received and is marked as a gap, not glossed over. Two new findings: (1) the phone fieldset splits into **two separate required fields** — a custom "Country" calling-code `react-select` (borrows `iti__flag` icon classes but isn't standard intl-tel-input) plus a separate standard-intl-tel-input "Phone" field; the two aren't automatically kept in sync by anything in this codebase. (2) A legal-consent question ("I agree to ... Applicant Privacy Policy") appeared among the custom questions — see finding 10 below. Live-confirmed on this exact page that the "LinkedIn URL or personal website" field gets correctly auto-filled by the existing structured-pattern match, and that every `react-select`-style question (country of residence, State, employment history, work authorization, visa sponsorship) is correctly left unfilled rather than guessed, per finding 6/`looksLikeComboboxPick`. |

## Confirmed findings (apply generally, not per-site)

1. **Required/optional marker noise is universal but never in the same shape twice.**
   Seen so far: leading `*` (SmartRecruiters attribute), trailing `* (required)` (Personio),
   leading `*` inline before name (Workable — breaks `^`-anchored regex), trailing `*` as a
   nested `<span>` (Jobvite, Greenhouse), trailing `<span>*</span>` preceded by a literal colon
   in the label's own text, e.g. "Full Name: *" (careers-page.com). **Fix: normalize resolved
   label text universally** (strip leading/trailing `*`/bullet chars, `(required)`,
   `(optional)`, trailing `:`, collapse whitespace) before running any structured-pattern
   match — don't special-case per site. Also: "optional" isn't always a marker with empty
   content — on careers-page.com it's the total *absence* of the marker element (a comment
   node placeholder where the asterisk `<span>` would be), so "no marker found" must be
   treated as optional, not as a parse failure.

2. **Radio (and checkbox) groups are detected wrong today.** `detectFormFields()` treats each
   individual `<input type="radio">` as its own field and resolves *its own* label (e.g.
   "Beginner"), not the question it's answering (e.g. "English proficiency level"). Needs to
   detect the group (via `<fieldset>`+`<legend>`, or a shared `name` attribute, or a wrapping
   `role="group"`) as one field with N candidate option values. Same bug applies to multi-select
   checkbox groups sharing one `<fieldset>`+`<legend>` (Teamtailor's "Locations" — Europe/Ukraine
   checkboxes) — not just single-select radios.

3. **Grouped/composite fields**: an individual input's own label can be contextless
   ("First") and only meaningful combined with an ancestor `role="group"`'s own
   `aria-labelledby` label ("Name"). Need to walk up to the nearest such group and combine.

4. **Not every "field" is a native form control.**
   - SmartRecruiters: custom elements, label is an attribute, real input likely shadow-DOM'd.
   - Ashby: Yes/No questions are two `<button>`s, not a real radio/checkbox — filling means
     *clicking*, not setting `.value`.
   - `react-select`-style comboboxes (Ashby, Greenhouse): typing text doesn't select a value;
     you likely need to type then pick from an async listbox.
   - `select2` (careers-page.com): same underlying problem as `react-select` — the real
     `<select multiple>` is hidden (`aria-hidden`, `select2-hidden-accessible`) and a fake
     `.select2-container` search box/dropdown is what's visible. Setting `.value` on the real
     `<select>` directly won't update the select2 UI; needs either driving the visible widget
     or setting the select's selected options *and* dispatching a `change` event select2
     listens for.
   - `intl-tel-input` (Greenhouse, and very common elsewhere): a whole widget for one phone
     field, with its own country-code selector separate from the actual number input. Setting
     `.value` directly (even React-safe via the native setter) bypasses the widget's own
     number parsing entirely — confirmed live: the flag stayed on its default country while
     the raw "+48..." text sat unparsed in the field. Fixed in `setPhoneValue()` by calling
     the library's own `setNumber()` API (`window.intlTelInputGlobals.getInstance(el)` for
     modern versions, `$(el).data("plugin_intlTelInput")` for older jQuery-based ones), with
     a plain value-set fallback if neither is reachable. First attempt gated this on
     `element.type === "tel"` — wrong, confirmed live: a real Workable form renders the
     visible intl-tel-input field as `type="text"`, not `"tel"`, so the gate silently
     skipped the fix entirely. `getInstance()` is a harmless no-op lookup on any element
     (returns nothing if that node was never registered with the plugin), so it's now
     attempted unconditionally on every fill instead of gating on the input's own type.
     Confirmed live a second time: that same Workable form exposes *neither*
     `intlTelInputGlobals` nor a jQuery-based instance at all — it's a bundled SPA build
     that imports the library as a private module and never attaches it to `window`. Added
     a third fallback that drives the widget's own DOM directly via simulated clicks (the
     same interaction path a real user takes): its country-list `<li>` items carry the dial
     code as a `data-dial-code` attribute regardless of whether the dropdown is open, so the
     right country can be selected without any JS hook into the page's internals. Splitting
     "+48573503853" into a dial code + local number is ambiguous from the digits alone
     (could a priori be "4"+"8573503853", "48"+"573503853", or "485"+"73503853" — calling
     codes are 1-3 digits with no way to tell the boundary without a reference table) — a
     naive greedy regex grabbed 3 digits ("487") instead of the correct 2 ("48") in initial
     testing, corrupting the number. Fixed by checking the *actual* dial codes present in
     the widget's own list (longest prefix first) rather than guessing; if no prefix matches
     any real entry, leaves the value untouched and reports failure rather than committing a
     wrongly-split, corrupted number — verified both the matching and non-matching cases
     with a synthetic `.iti` DOM fixture before shipping.

5. **Visibility filtering needs more than `offsetParent === null`.** Workable's decoy
   `city`/`postcode`/`country` inputs use `position: absolute; width/height: 1px; overflow:
   hidden` (the standard visually-hidden a11y pattern) — still has an `offsetParent`, so the
   current filter doesn't catch it. Add `aria-hidden="true"` / near-zero-dimension checks.

6. **Some "custom questions" are consequential, not narrative — don't auto-generate them.**
   Salary expectations (Ashby, Personio), sponsorship/B2B yes-no (Ashby), interview rate and
   weekly capacity (Workable) are commitments/personal facts, not "why do you want this job"
   essay fields. These should come from an explicit QA-bank answer or be left for the human,
   never a speculative LLM guess — same principle as not fabricating resume content.

7. **Tag name alone doesn't indicate generative vs. structured.** Workable renders every
   custom question as a `<textarea>` regardless of whether the real answer is one word or a
   paragraph. Keyword-based "generative hint" matching on the label also misses legitimate
   custom questions that don't sound like essay prompts (e.g. Ashby's "How did you hear about
   SplitMetrics?"). Better fallback rule: any required field not matched by a structured
   pattern or the QA bank needs *some* answer, generated or asked-for — not just ones whose
   label contains an obvious keyword.

8. **Not every embedded form is a real iframe — check before assuming frame-piercing is needed.**
   Teamtailor renders its application form inside a `<turbo-frame>` (Hotwire/Turbo), which fetches
   its `src` URL and swaps the response into the *same* top-level document — there's no separate
   frame/document to pierce, so `chrome.scripting.executeScript({allFrames: true})` isn't needed
   for it. Contrast with `smartcat-iframe-wrapper.html`, a genuine cross-origin `<iframe>` where
   `allFrames: true` (or explicit frame targeting) is required to reach the real fields. Detection
   logic should check for an actual `<iframe>`/separate `document` before treating a "frame" as
   cross-boundary — custom elements like `<turbo-frame>` can look similar in markup but aren't.

9. **`label[for]` linkage can be present syntactically but functionally useless.**
   careers-page.com renders every `<label for="">...` with a literal empty `for` attribute —
   the real input has a real `id` (e.g. `field64641`), but nothing in the label ever
   references it. Checking "does a `for` attribute exist" isn't enough; it must actually
   resolve to a matching element `id`, with a DOM-proximity fallback (nearest ancestor
   `.form-group`/similar wrapper) when it doesn't.

## Detection + generation rewrite (findings 1-9 acted on)

`detectFormFields`/`labelForElement` in `sidepanel.js` were rewritten to act on all nine
findings above: universal marker normalization (including a screen-reader-only "Required"
word with no visible asterisk left after stripping decorative `aria-hidden` content —
Teamtailor), `label[for]` validated against a real matching id with a DOM-proximity fallback
(careers-page.com), radio/checkbox GROUP detection via shared `name` + `<fieldset>`/`legend`
*or*, when a site skips `<legend>` entirely (Ashby), by elimination — the one `<label>` inside
the fieldset not tied to one of the group's own option ids — plus the same grouping for
Ashby's button-pair Yes/No fields, composite/grouped label combination (Personio), select2 +
`intl-tel-input` handled (real `<select>`/`<input>` filled directly; their own internal search
boxes excluded from detection as duplicate phantom fields), an open-shadow-root path for
custom elements (SmartRecruiters — untested against a live page; a static HTML snapshot can't
exercise shadow roots attached by the site's own client-side JS), and visibility filtering
that also treats select2's intentionally-hidden real `<select>` as fillable.

`/generate-answer` is now wired into Auto Fill: unmatched fields get a `data-af-idx` stamp and
are returned to the side panel, which calls `/generate-answer` per field and fills the result
back in a second pass. Generation is withheld (reported as "needs your input" instead) for:
consequential fields (salary/sponsorship/visa/availability/etc., by keyword), any field
matching a structured category (email/phone/name/location/...) even if the profile value is
empty — a missing fact should be asked for, not invented, same principle as never fabricating
resume content — and anything that isn't free text (`<select>`, radio/checkbox/button groups,
`role="combobox"`-style comboboxes), since those need a discrete option picked, not prose.

Verified against 7 of the 8 real fixtures using jsdom (see `Profile` schema gap below —
SmartRecruiters' custom elements have no shadow root in a static snapshot, so that path is
unverified outside a live browser).

10. **Legal-consent questions need a stricter rule than ordinary consequential fields — block
    every fill source, not just generation.** Found live on `greenhouse-newrelic-PARTIAL.html`:
    "I agree to the processing of my personal data in accordance with New Relic's Applicant
    Privacy Policy." Reusing a QA-bank answer is fine for something like "are you authorized
    to work in Poland" — a stable fact about the person regardless of which company is asking.
    It's wrong for "I agree to Company A's privacy policy" being silently reapplied against
    Company B's different policy document: each consent is supposed to be a fresh, deliberate
    action per real document, not a cached answer. Added `CONSENT_RE`/`isConsentField()`
    (`/\bi agree\b|\bconsent\b|privacy polic|terms (and|&)? ?conditions|terms of service/i`)
    and gated it in front of every QA-bank-match fill path (groups, single fields, ungrouped
    checkboxes) as well as generation — confirmed with a synthetic test that an ordinary
    "Subscribe to updates" checkbox still fills correctly from a QA-bank entry while an "I
    agree to the Privacy Policy" checkbox does not, even when a QA-bank entry exists that
    would otherwise match it via word overlap.

11. **AI-assisted QA-bank matching, and a fully generic combobox-option finder.** Two
    follow-ups after the New Relic testing session, both addressing "the current matching
    is pattern-based and won't generalize" and "the combobox filler assumes react-select's
    own conventions" as named limitations above.
    - New `POST /match-answers` endpoint: given the live page's still-unmatched questions
      plus the person's full QA bank, asks `settings.answer_provider` which (if any) of the
      saved entries means the same thing as each new question — even if worded very
      differently. This is retrieval, not generation: the model only ever selects an index
      into the real QA bank (schema-enforced `{"matches": [<int|null>, ...]}`) or reports no
      match; it can never inject new text into an answer. Wired into `sidepanel.js`'s Auto
      Fill flow as a new middle pass, between local matching and generation: every
      non-consent unmatched field (not just free-text ones — selects and comboboxes now get
      stamped too) is checked here before anything eligible for generation falls through to
      `/generate-answer`. Batches all of a page's questions into one call rather than one
      per field. Live-tested against the real (small, default) Ollama model: correctly
      matched a sponsorship question and correctly reported no match for an unrelated one
      (no wrong matches observed — the safety property held), but missed two cases a bigger
      model or Claude would likely catch (a "have you worked here" phrasing variant, and a
      "expected compensation" vs. saved "salary expectations" phrasing) — this pass is a
      genuine improvement in the ceiling, not a guarantee, and its actual usefulness now
      depends on which `answer_provider` is configured.
    - `fillReactSelectByClick`'s option-finder is now three tiers instead of one: (1) the
      control's own `classNamePrefix` convention (react-select) as before; (2) standard ARIA
      `role="listbox"`/`role="option"`, or any `role="option"` at all; (3) fully generic —
      a snapshot of every element present before the click, diffed against what's newly
      visible afterward, filtered to short leaf-ish text. Tier 3 means a bespoke dropdown
      using neither react-select's conventions nor ARIA roles still has a real chance of
      working, verified with a synthetic test using plain unclassed `<div>`s for options.

12. **`runLearnInPage` silently learned nothing for react-select comboboxes, for the same
    underlying reason filling them was hard.** Reported live: manually selecting "N/A" for
    State, a country for "Current country of residence", and an answer for the New Relic
    consent question, then clicking Learn — none of the three were saved. Root cause: a
    react-select combobox's own `<input>` is just its search/filter box; after a real
    selection, the input's `.value` goes back to empty, and the actually-chosen text renders
    into a separate sibling display element instead (`select__single-value` in New Relic's
    case — confirmed directly in `greenhouse-newrelic-PARTIAL.html`'s markup: `value=""` on
    the input, `"No"` as the `select__single-value` div's text, right next to it). Learn was
    reading `element.value` for every field type, which is correct for real inputs but always
    empty for these, so the "did you actually fill something in" check silently failed every
    time. Fixed with `getComboboxValue()`, using the same classNamePrefix convention as
    `fillReactSelectByClick` to find the sibling display element instead of the input's own
    (always-empty) value, with a generic "any other leaf text sibling that isn't the
    placeholder" fallback. Verified the old code produces exactly the reported symptom
    (`[]`, nothing learned) against a synthetic mock of the real New Relic markup structure,
    and the fixed code correctly captures all three as real Q&A entries.

13. **Cross-field contamination: filling one combobox could silently change a *different*,
    already-correctly-filled one.** Reported live: after Auto Fill correctly set the phone
    section to Poland (+48), manually selecting "Poland" on the separate "Current country of
    residence" question caused the *phone's* country code to change to Afghanistan (+93) —
    confirmed via a DevTools capture showing both the phone-section react-select control and
    the separate intl-tel-input widget's own selected-country button had switched to
    Afghanistan, the literal first, default-highlighted `<li>` in a fresh, unfiltered country
    list. Root cause: `findComboboxOptions`' first two tiers (`{prefix}__menu`, ARIA
    `listbox`/`option`) used unscoped `document.querySelector`, picking the *first* matching
    element anywhere on the page with no check for whether it was the menu just opened for
    the current field versus a stale, previously-opened one still technically present in the
    DOM (closed visually but not detached — plausible with a close animation, or simply not
    removed). A page with several same-classNamePrefix react-select instances (Country,
    State, Country of residence — all "select__..." on this form) processed across multiple
    fields in one Auto Fill run is exactly the condition where an earlier field's leftover
    menu can get grabbed while filling a *later* one, corrupting an already-correct answer.
    Only tier 3 (the fully generic fallback) had a "did this appear after my click" check;
    fixed by applying that same freshness check to all three tiers, at the individual
    *option* level rather than the outer menu container (so it still works if a persistent
    menu shell re-renders new option nodes on each open). Verified with a two-field test
    (same shared prefix, field A's menu deliberately left in the DOM after selection): the
    old code failed to fill field B at all (matched against field A's stale menu, found no
    matching text there, silently gave up); the fixed code correctly filled both fields from
    their own genuinely-fresh menus regardless of the stale leftover being present.

14. **"Address" and "City" fields both got filled with the same value.** Reported live:
    a "City" field correctly showed "Warsaw", but a separate "Address" field on the same
    form also showed "Warsaw" instead of a street address. Root cause: `STRUCTURED_PATTERNS`
    in `sidepanel.js` had one combined pattern, `{ re: /^(city|location|address)/i, get: (p)
    => p.contact.location }`, so every field whose label started with "city", "location", or
    "address" all resolved to the same single `profile.contact.location` string (a combined
    display string like "Warsaw, Poland (Remote)", meant for the resume header, not a form
    field). The user pointed out street address and city are different things and both need
    to be real, separate profile fields — along with postal code and country, which had the
    same problem in reverse (no field for them at all, so a "Postal code" question would have
    fallen through to AI generation or gone unmatched instead of using a real saved value).
    Fixed by adding `street_address`, `city`, `postal_code`, `country` (and `state`, see
    below) to `ContactInfo` in `companion-service/app/schemas.py`, corresponding inputs to the
    Profile tab's contact grid in `options.html`/`options.js`, and splitting the one combined
    regex into five specifically-ordered, non-overlapping patterns (postal code, street
    address, city, country, location — postal code and street-address patterns checked before
    the plain `city`/`location` ones so e.g. "Address Line 1" doesn't get caught by a looser
    city pattern). **"State" deliberately has no structured pattern** and is not auto-filled
    from the profile at all — New Relic's own "State" question demonstrates why: "If you do
    not live in the United States or Australia, please select 'N/A'" is a form-specific
    condition no single saved profile value can satisfy correctly for every form, so it's
    left to the Q&A tab, where Learn captures the actually-correct answer per form instead.
    Verified with a synthetic test (separate Address/City/Postal Code/Country/State/Location
    fields, real example profile values `ul. Śląska 27` / `Warsaw` / `02-472` / `Poland`):
    each of the five wired fields fills with its own distinct correct value (no repeats), and
    State is correctly left in `unmatched` rather than guessed. Also confirmed live via the
    companion-service's own `/profile` GET/PUT round-trip that all five new fields persist
    correctly.

15. **A whole class of custom comboboxes was invisible to the extension entirely, not just
    hard to fill.** Reported live: an Angular CDK-based ATS's "Country" field (`role="combobox"`
    on a bare `<div>`, no real `<input>`/`<select>` anywhere, backed only by an Angular
    FormControl) stayed on "Select" no matter what — turned out to be three compounding gaps.
    (1) **Detection**: `collectNativeElements()` only ever queried
    `input/textarea/select` — a custom trigger with no native form element at all never
    entered `singleTargets`, so it never even reached `unmatched`, structured-match, or
    QA-bank lookup; it was as if the field didn't exist. Fixed by adding `[role="combobox"]`
    to that query (and the equivalent one in `runLearnInPage`) — any element carrying that
    role is, by the ARIA spec itself, supposed to behave like a fillable field regardless of
    tag name. (2) **Virtualized option list**: even once found and clicked open, this ATS
    renders its country list inside a `cdk-virtual-scroll-viewport` — only the items
    currently scrolled into view exist in the DOM at all (confirmed via a DevTools capture:
    Afghanistan..Austria present, nothing past it), so a target far down the alphabet (e.g.
    "Poland") was never going to be found by any option-search logic, no matter how
    thorough — it simply wasn't there. The panel does render its own fresh "Search" input
    once opened, though (distinct from the field's closed-state control, so identifiable via
    the same `!before.has(el)` freshness check already used for options) — added
    `findFreshFilterInput()`, which types the desired value into that box first (the same
    narrowing a real user would do), before searching for the now-actually-rendered matching
    option. No-op for comboboxes without a separate filter box (react-select's own input
    already existed before the click, so it's correctly excluded as "not fresh"). (3) **ARIA
    variant**: this ATS's options are `role="treeitem"` inside `role="tree"` (the ARIA
    "combobox with a tree popup" pattern — legitimate per the APG, just less common than the
    listbox variant), which the existing ARIA tier only matched as `listbox`/`option`. Added
    `tree`/`treeitem` alongside the existing `listbox`/`option` selectors.
    Also found and fixed in passing: `fillGeneratedAnswersInPage`'s own copy of
    `findComboboxOptions` (the function that actually fills AI-matched/generated answers, not
    a secondary path) had never received the finding-13 stale-menu freshness fix at all —
    unscoped `document.querySelector`, no `before`-filtering on any tier. Backported the same
    fix there. `getComboboxValue()` (used by Learn) also needed a new branch: this widget has
    no separate sibling display element either — the trigger's own text is the value, updated
    in place — checked before the broader (and here, unscoped-past-parentElement, therefore
    risky) sibling search that assumes a `__control` wrapper exists.
    Verified each piece independently: a jsdom test confirms `runAutofillInPage` (with
    `[role="combobox"]` detection, the virtualized tree/treeitem list, and the typeahead
    filter box all combined) correctly fills the field from `profile.contact.country`; a
    second test confirms `runLearnInPage` correctly captures a manually-selected value from
    the same bare-div trigger. Full existing regression suite re-run clean after each change.

16. **Three separate real bugs found on a real Ashby posting (`ashby-nordsecurity-PARTIAL.html`),
    all missed by the existing regression suite because none of its fixtures happened to hit
    these exact shapes.** (1) "Are you currently based in Poland?" is a Yes/No question
    rendered as two `<button>`s in a bare `<div>` with no `fieldset`/`role="group"`/
    `role="radiogroup"` wrapper — `collectButtonGroups`'s existing Ashby support only ever
    looked *inside* one of those container types, so it never found this pair at all. Worse:
    a real (but `tabindex="-1"`, non-focusable) `<input type="checkbox">` sits right next to
    the buttons, and the *separate*, generic "ungrouped single checkbox" pass **did** find
    that checkbox via label-resolution's ancestor fallback, matched it against the QA bank,
    set `.checked = true`, and reported it as filled — a false positive, confirmed by testing
    with a real click listener on the buttons (the only thing Ashby's actual React app would
    react to): the checkbox path never touches them, so the live page's answer never
    actually changes even though Auto Fill claims success. A false "filled" is worse than an
    honest "unmatched" — the user has no reason to double check it. Fixed two ways: added a
    broader `collectButtonGroups` fallback pass for 2-6 sibling `<button>`s sharing a parent
    with no required container type, finding the group's label via the nearest ancestor's own
    `<label>` (same ancestor-search idea used elsewhere, just not gated on fieldset/role) —
    and excluded `tabindex="-1"` checkboxes from the single-checkbox pass entirely, since a
    non-focusable checkbox is, in practice, always a decorative proxy for a custom-rendered
    control rather than something a real user interacts with directly. (2) The "Location"
    field's visible `<input>` has no `id` attribute at all, so its real `<label for="...">`
    (pointing at an id that exists nowhere in the DOM) never linked up via the normal
    `label[for]` lookup — label resolution fell through all the way to the input's own
    `placeholder` ("Start typing..."), which STRUCTURED_PATTERNS' `/^location\b/i` obviously
    never matches, so a saved `profile.contact.location` silently never filled it. Fixed by
    reordering `resolveOwnLabel`'s priority: a real `<label>` found via ancestor search
    (`findLabelInAncestors`, which already refuses to fire if that ancestor holds more than
    one control) now wins over a generic placeholder hint, since an author-written label is a
    much stronger signal of the actual question than boilerplate input hint text. (3) That
    same Location field turned out to be a third distinct combobox-filling pattern, on top of
    "click to reveal a pre-rendered list" (react-select) and "click, then type into a
    *separate* freshly-appeared filter box" (finding 15's CDK country field): a type-to-search
    autocomplete (Google-Places-style) where nothing renders until you type into the *same*
    input you clicked. Fixed by having `fillReactSelectByClick` type the desired text directly
    into `element` itself when no separate fresh filter input was found (and `element` is a
    real `<input>`/`<textarea>`) — mutually exclusive with the finding-15 fix, so a widget
    with a genuinely separate filter box never gets double-typed-into.
    All three verified against the real, verbatim-captured fixture: a jsdom test with real
    click listeners on the Yes/No buttons (to catch the false-positive specifically, not just
    trust `filled`'s own self-report) and a simulated type-then-suggestions-appear listener
    for Location (standing in for Ashby's real geocoding API, which can't be called from a
    test). Full regression suite re-run clean.

17. **Resume-file auto-attach: fixed the targeting logic, then moved it out of Auto Fill
    entirely per explicit instruction.** `attachResumeFileInPage` previously grabbed
    `document.querySelector('input[type="file"]')` — the *first* file-upload field on the
    page/frame, full stop. A real application form can have several (resume, cover letter,
    photo, portfolio, references, other attachments) — blindly taking the first one risks
    attaching the resume to the wrong field with no warning. Fixed by adding a proper label
    resolver scoped to file inputs (`label[for]` → parent `<label>` → `aria-labelledby` →
    `aria-label` → nearest-ancestor `<label>`, the same proximity idea used elsewhere, bailing
    out early if that ancestor holds more than one file input) plus explicit include/exclude
    regexes (`resume|cv|curriculum vitae` vs. `cover letter|photo|portfolio|transcript|...`),
    with a same-single-field fallback for forms that only ever offer one upload slot and don't
    bother labeling it. Also: the feature previously only fired for the *uploaded, as-is*
    resume (non-tailor mode) — never for a freshly *generated/tailored* PDF, even though
    that's the primary mode. Added `lastGeneratedPdf` (base64 + derived filename), tracked
    after a successful `/render`, as the tailor-mode source.
    Separately, this was previously wired to run **automatically** inside the Auto Fill click
    handler (gated to Workday's `myworkdayjobs.com`/`myworkday.com` hostnames, per explicit
    instruction that this shouldn't happen on other ATSs at all). Per a follow-up correction,
    attaching a file is more consequential than filling text — it's literally what gets
    submitted — so it was pulled out into its own explicit "Attach Resume to Form" button
    instead of being a side effect of clicking Auto Fill; the Workday-only restriction was
    kept on the new button rather than dropped, since that constraint was about *where* this
    should ever apply, not just about it being automatic.
    Verified the label-targeting logic with three jsdom scenarios built from scratch (jsdom
    has no real Workday fixture yet — this hasn't been checked against actual Workday markup):
    three file inputs (resume/cover letter/photo) attaches only to the resume one; a single
    unlabeled file input is used as a safe fallback; a single field explicitly labeled "Photo"
    is correctly refused even as the only candidate. (jsdom doesn't implement `DataTransfer` at
    all, and its `HTMLInputElement.files` setter validates against a real `FileList` that
    nothing outside a real browser can construct either — both were stood in with minimal fakes
    for the test, since what's actually being verified is *which* input gets targeted, not the
    browser-native file-attachment mechanics themselves, which were pre-existing and unchanged.)

18. **The most severe bug found this session: fabricated non-answers to real, consequential
    application questions, reported live on a real Oxylabs/Lever posting.** "What would be your
    monthly gross salary expectations in PLN?", "Are you a taxpayer in Poland?", "...B2B
    contract?", "...able to travel for work?", and "What is your level of written and spoken
    English?" were all auto-filled with near-identical generic "I have experience with PHP/
    Symfony... at Oxylabs" filler — not an answer to any of the five actual questions. Root
    cause, confirmed via a real Save Sample capture (`lever-oxylabs.html`/`.json`): Lever's
    custom-question `<textarea>`s have no `<label>` at all, no ARIA labelling, and the question
    text isn't even a direct sibling of the field — it lives in a `<div class="application-
    label">` that's a sibling of an ANCESTOR of the `<textarea>` (both children of one shared
    `<li class="application-question">` wrapper). Every existing label-resolution strategy
    missed this shape entirely, falling all the way through to the absolute last resort:
    the field's raw HTML `name` attribute (`cards[38843bea-033a-4c55-b93c-8a00a773fbdf]
    [field0]`) — meaningless to a human, and critically, ALSO meaningless to (a) the
    consequential-field safety check (`isConsequential` never saw the word "salary", so the
    salary question wasn't recognized as consequential and went to generation despite the
    existing regex already covering "salary") and (b) the `/generate-answer` prompt itself
    (the model was asked to answer a garbled internal identifier, not a real question — a small
    model's plausible fallback in that situation is generic "why I'm a good fit" content, which
    is exactly what came back, for all five, independently). Two-part fix. (1) `resolveOwnLabel`
    gained a new fallback: instead of only checking the field's own previous siblings for
    label-like text (the pre-existing behavior, now the depth-0 case), it climbs a few ancestor
    levels checking each one's own previous siblings, stopping as soon as it finds usable text —
    this is what actually reaches Lever's sibling-of-an-ancestor label div. (2) Separately,
    `CONSEQUENTIAL_RE` was missing "taxpayer/tax resident", "B2B"/"contract type", and "travel"/
    "relocat(e/ion)"/"onboard(ing)" entirely — real, consequential commitments same in kind as
    salary/visa/availability, which were already covered — added regardless of the label-
    resolution fix, since either bug alone would have let these three through. Also fixed in
    passing: Lever's own required-marker glyph, "✱" (U+2731), was never stripped by
    `normalizeLabel` (which only handled `*`/`•`) — every Lever label leaked a trailing "✱"
    ("Full name✱", "Email✱", ...).
    Verified against the real, complete fixture (not a partial/truncated one — a full "Save
    Sample" capture): all 5 previously-broken labels now resolve to their real visible question
    text (not the raw `name` attribute), the 4 genuinely consequential ones are confirmed
    blocked from generation (`canGenerate: false`), the 5th ("English level" — legitimately
    generate-eligible, not consequential in the same fabrication-risk sense) correctly stays
    `canGenerate: true` now that the model would at least receive the real question instead of
    a meaningless identifier, and the "✱" glyph is confirmed stripped from a resolved label.
    Full existing regression suite (8 other real ATS fixtures) re-run clean — spot-checked their
    resolved labels directly to confirm the broader ancestor-climbing search didn't introduce
    any wrong-label regressions elsewhere, not just that the test assertions still passed.

19. **"Attach Resume to Form" needed to tell a genuine Resume field apart from a site's own
    "autofill your whole application from your resume" convenience widget — two fundamentally
    different targets that can both appear as file inputs on the same page.** Reported live on
    a SmartRecruiters posting (a `<spl-dropzone>` custom element under "Resume" — separate from
    an "autofill" step) and a LinkedIn-style "Easy Apply" flow (a convenience upload right next
    to a separately-labeled, required "Resume *" field further down). The feature was also
    previously Workday-only per an earlier instruction, which turned out to be too narrow once
    it became clear the REAL distinction wasn't "which ATS" but "which of the two widgets" — on
    Workday specifically, though, the "autofill" widget genuinely IS the correct, mandatory
    first-step target, not a convenience one to avoid. Fixed by: (1) removing the Workday-only
    restriction so the button attempts on any site; (2) adding an `AUTOPARSE_RE` check
    (`easy apply|autofill|autocomplete (your|the) (application|profile)|parse (your|the) resume`)
    against nearby heading/paragraph text, so a candidate flagged as this kind of widget is
    excluded in favor of an explicitly resume-labeled field — skipped entirely on Workday, where
    that widget IS the target; (3) piercing open shadow roots when collecting candidate file
    inputs (`<spl-dropzone>` and similar custom elements), the same way `collectShadowElements`
    already does for other field types — closed shadow roots remain genuinely inaccessible, no
    change there. One real bug caught while building the heading check: an ancestor climb that
    doesn't stop at a shared container holding multiple file inputs can attribute a heading
    from a completely different, unrelated widget to the field being checked (`querySelector`
    searches the whole subtree, not just what's actually nearby) — fixed with the same
    "stop once an ancestor holds >1 candidate" guard already used elsewhere in this file.
    Verified with synthetic scenarios covering both real-world shapes (Ashby-style "Autofill
    from resume" heading, LinkedIn-style "Easy Apply" heading) confirming the real Resume field
    gets targeted and the convenience widget stays untouched off Workday, plus a Workday
    scenario confirming its own mandatory autofill-step widget IS still correctly targeted
    there. Still unverified against SmartRecruiters' actual shadow-DOM structure specifically
    (open vs. closed) — that question has been open since this project's very first
    SmartRecruiters fixture and still needs a live DevTools check to settle for good.

20. **Fabricated non-answers written into fields the profile genuinely can't answer, reported
    live on a BambooHR posting.** "Province" (~State) and "Desired Pay" both got filled with
    the model's own refusal explanation verbatim — e.g. "I don't have any relevant experience or
    details about working in a specific province... Therefore, I cannot provide information..."
    — submitted as if it were the actual answer. Root cause: `/generate-answer`'s prompt already
    instructed the model to "say so rather than fabricating" when it lacked grounding, but the
    response schema only ever had one field, `answer: string` — there was no way for the model
    to signal "I can't answer this" separately from "here's my answer", so its own refusal
    sentence got treated as fill-worthy content like any other string and written straight into
    the DOM. Also confirmed: "Desired Pay" was missing from the consequential-field list
    entirely (same salary-adjacent category as "salary"/"compensation", just phrased
    differently) — a second, independent reason that field should never have reached generation
    at all. Fixed by adding an explicit `answerable: bool` field to `AnswerResponse` (schema-
    enforced via Ollama's structured-output `format_schema`, and instructed explicitly in the
    Claude-path prompt too) — the model sets `answerable: false` and `answer: null` instead of
    writing an explanation, and the extension simply never adds that field to `finalFills`, so
    it's reported as needing human input like any other unmatched field rather than being
    force-filled with either the refusal text or nothing useful. Also added "desired pay",
    "expected pay", "pay rate" to `CONSEQUENTIAL_RE`. Verified the parsing logic directly for
    all four response shapes (explicit `answerable:false`, explicit `answerable:true` with a
    real answer, legacy single-field `{"answer": "..."}` response for backward compatibility,
    and the edge case of `answerable:true` with a null answer, which is treated as
    `answerable:false` rather than trusted at face value).

21. **`mergeQaEntries` silently discarded a corrected answer instead of updating the existing
    saved one.** Asked live: after manually correcting a field on a page and clicking Learn
    again, does it actually fix the previously-saved answer? Reading the code: no — the
    duplicate check (`wordOverlapScoreSimple(...) >= 0.6`) only ever decided whether to ADD a
    new entry; if a similar-worded question already existed, the new (possibly corrected)
    answer was simply dropped, silently keeping whatever was saved before. Fixed by updating
    the existing entry in place when its answer differs, instead of skipping it — Learn should
    always reflect the most recently-confirmed-correct answer. Verified with three cases: a
    genuinely new question gets added, a corrected answer for a similar-worded question actually
    replaces the stale one, and re-learning an unchanged answer is a no-op.

22. **The AI-based QA-bank matching (`/match-answers`) reproducibly matched semantically
    unrelated questions to the wrong saved answer, using the default (Ollama) `answer_provider`
    — a severe, live-confirmed bug, not a one-off.** Reported live: "Which areas are you
    strongest in?" got filled with a saved "Not a veteran" answer. Reproduced directly: re-ran
    the same batch of questions against the real Ollama model twice — it also matched "What is
    your current location and right to work status?" and "What is your notice period?" to a
    saved answer of literal "No" both times, two DIFFERENT wrong questions independently landing
    on wrong matches in the same run. The exact same batch through Claude instead: both
    correctly left unmatched, and the notice-period question correctly matched its real saved
    answer. This isolates the failure to the small local model's reliability at this specific
    task (index-selection across a list), not a flaw in AI-matching as an approach, and not
    something the model's own "matched: true" flag has any way to self-report — a wrong-but-
    confident match is indistinguishable from a correct one without independent verification.
    Given the user's explicit choice to keep Ollama (free/local) for this rather than switching
    to Claude for this step, fixed with a client-side plausibility check instead: the server now
    also returns `matched_question` (the QA-bank entry's own original question text, not just
    its answer), and the extension checks that pairing with the same category-match-or-word-
    overlap logic already used for the plain-text QA-bank tier before trusting it — a category
    match (the same curated, known-safe boilerplate categories) is trusted regardless of literal
    wording overlap, since bridging exactly that gap is the whole reason AI matching exists;
    anything else needs real, specific word overlap. One thing caught while building this: the
    established `length > 2` "significant word" filter let short filler words ("are", "you") at
    exactly that boundary coincidentally clear the overlap bar between two completely unrelated
    questions — needed `length > 3` specifically for this check to actually discriminate.
    Verified against all three live-reproduced bad pairings (all correctly rejected now) plus
    two legitimate matches that must still pass: a differently-worded boilerplate pair (via the
    category exemption) and a genuine close paraphrase (via real word overlap).

23. **"Extract from page" pulled a third-party widget iframe's own JavaScript source and used
    it as the job description**, reported live on a Recruitee posting (careers.hostaway.com)
    with an embedded hCaptcha challenge. Root cause: `extractPageInfo` gets injected into
    *every* frame on the page (`allFrames: true`, needed so cross-origin job-board iframes like
    an embedded Greenhouse posting still get scraped correctly), including third-party widget
    iframes that have nothing to do with the job posting at all — the hCaptcha enclave iframe's
    own frame got scraped too, and whatever its own internal content happened to be scored as
    "the longest job-description-shaped text" of any frame on the page, winning the cross-frame
    comparison in `scrapeCurrentTab`. Fixed by bailing out immediately (returning an empty
    `jobDescription`) for known widget-provider hostnames (`hcaptcha.com`, `recaptcha`,
    `gstatic.com`, `captcha-assets.`/`captcha-base.` subdomains) at the very top of
    `extractPageInfo`, before any extraction logic runs — a precise, hostname-based check
    rather than a "does this look like code" content heuristic, since the latter risks
    misfiring on a genuine tech job posting that happens to include a real code snippet in its
    description. Verified with two cases: the hCaptcha enclave frame now correctly returns an
    empty jobDescription (so it can never win the cross-frame comparison), and a legitimate
    embedded job-board iframe on a normal hostname still extracts normally — confirming the fix
    targets the actual widget frames without collateral effect on real embedded postings.

24. **A plain personal-info question got answered with the candidate's own tech stack instead
    of their location, reported live on the same Recruitee/Hostaway posting.** "Where are you
    currently located? (City, country)" got filled with "React, Typescript, Next.js" — the
    correct-shaped answer for a completely different question ("What frontend tech stack are
    you most familiar with?") on the same form, not garbled/off-topic content. Investigated
    thoroughly before touching anything: confirmed this happened on a single, first Auto Fill
    click (not a repeat run, ruling out the stale-`data-af-idx`-collision class of bug covered
    by finding 22's frame-sweep fix); confirmed the QA bank was empty at the time (ruling out
    `/match-answers` entirely — it short-circuits to all-unmatched on an empty bank, so this had
    to go through `/generate-answer`); re-verified the idx-to-label pairing is embedded directly
    in each field's own object throughout the whole pipeline, never positional, so it can't get
    scrambled client-side. Ollama wasn't reachable in this environment to reproduce the model's
    exact behavior directly, so the precise mechanism (why a small local model, given a job
    description that heavily repeats "React"/"TypeScript"/etc., would answer a location question
    with a tech-stack list) couldn't be pinned down further. Rather than adding another
    verification layer on top of whatever the model generates (as was done for QA-bank matches
    in finding 22), applied the same, simpler fix already proven for this exact class of bug
    (see the Workday "Family Name" → "Polish" mismatch noted inline above the location pattern):
    broaden structured-field coverage so the question never reaches generation in the first
    place. `STRUCTURED_PATTERNS`'s location entry only matched a bare leading "Location" before;
    broadened to also catch "currently located"/"where are you ... located/based" phrasing, so
    it now fills directly and deterministically from `profile.contact.location`. Verified with
    the exact real field wording: it now fills correctly from the profile, and the two adjacent,
    genuinely-unrelated questions on the same form ("tech stack", "how did you hear about this
    job") are confirmed unaffected by the broadened pattern.

25. **"Save Sample" had quietly fallen behind — a whole separate, undetected regression found
    by request ("check save samples functionality and check what is saving"), not a live bug
    report.** `runAutofillInPage` and `runLearnInPage` were refactored at some point to share one
    module, `field-detector.js` (loaded into the page once via `chrome.scripting.executeScript`'s
    `files:` option, before either runs there), specifically so the two could never again drift
    into disagreeing about what a field's label is — exactly the class of bug this whole session
    kept finding. `captureSampleInPage` (Save Sample) was never migrated to it, and had been
    silently accumulating its own increasingly-stale duplicate of every detection helper. By the
    time this was checked, it was missing: honeypot filtering (a decoy field would show up as a
    normal "unmatched" field in a capture, misleadingly); Workday's "Select One"/
    `multiSelectContainer` combobox detection; button-groups entirely (an Ashby-style Yes/No pair
    never appeared in a captured sample at all, not even as unmatched); the shadow-DOM multi-
    field-per-host fix; and several label-resolution fixes (`fieldset`/`legend` priority,
    `aria-labelledby`, the Lever ancestor-sibling climb). A captured sample no longer reliably
    showed what a real Auto Fill run would actually do — exactly the opposite of what this
    diagnostic feature exists for. Migrated `captureSampleInPage` to call the same
    `collectFormFields()` from `field-detector.js`, removing its entire duplicated copy of
    `cleanedText`/`normalizeLabel`/`resolveOwnLabel`/`labelForElement`/`isVisible`/
    `collectRadioCheckboxGroups`, and added the `saveSampleBtn` handler's missing
    `files: ["field-detector.js"]` injection to match the other two handlers. Also added
    `loneCheckboxes` reporting, previously silently dropped instead of appearing as "unmatched"
    like every other field type. Verified with a synthetic fixture combining a honeypot, an
    Ashby-style button-group, a lone checkbox, and an ordinary structured-matched field: the
    honeypot is now correctly excluded, the button-group is now captured and correctly matched,
    the lone checkbox is now reported, and the ordinary field is unaffected.
    Separately, while fixing this, discovered the wider regression testing debt this drift had
    been hiding: every jsdom test that extracts `runAutofillInPage`/`runLearnInPage` in isolation
    had been silently broken since the `field-detector.js` refactor (a `ReferenceError:
    collectFormFields is not defined` on every real invocation) — and worse, `test-autofill.mjs`
    specifically caught and logged per-fixture errors without ever failing the overall run, so it
    had been reporting a false "exit 0 pass" for all 8 real ATS fixtures every single time it was
    run since that refactor, undetected across several prior findings in this same log. Fixed
    every affected test to prepend `field-detector.js`'s source before the extracted function
    (mirroring the real two-stage injection), and fixed `test-autofill.mjs` to actually fail
    the run if any fixture errors, instead of silently logging and continuing.

26. **A new `findHeadingInAncestors` fix (for join.com's Chakra-based screening questions,
    where each question's real text is an `<h2>` several levels up from its control) silently
    broke Lever's own custom-question labels, which had been fixed earlier in this same log
    (finding 18).** Caught during a routine "check the project again" — the full regression
    suite showed all 4 previously-distinct salary/taxpayer/B2B/travel questions on the real
    Lever fixture collapsing to the exact same wrong label, "Additional questions for remote
    positions in Poland". Root cause: Lever wraps a whole card of 4-5 separate custom questions
    under one shared `<h4 data-qa="card-name">` section title, and `findHeadingInAncestors`
    (checked ahead of the Lever-specific fix, and searching up to 15 ancestor levels deep) had
    no version of the "stop once this ancestor holds more than one form control" guard that
    `findLabelInAncestors` already uses - so it happily climbed straight past each question's
    own individual label and attributed the whole card's shared heading to all of them alike.
    Fixed by adding that exact same guard to `findHeadingInAncestors` too. Verified the real
    Lever fixture's test suite (finding 18) passes again with the fix, and left the guard
    reasoning inline since the join.com case this function exists for was described as each
    question owning its own single-question wrapper - the guard should be a no-op there, not a
    regression risk. Also worth noting for next time: this file gets modified by more than one
    process/session at once, so a routine "check everything still works" sweep found a real,
    live regression that wouldn't have surfaced otherwise until reported live on an actual page.

27. **New feature: automated ChatGPT-tab-driven resume JSON generation, as an alternative to
    the fully-manual "Copy prompt for GPT" flow.** Opens a real, visible chatgpt.com tab (not
    background - Chrome throttles timers in inactive tabs, which would make the polling below
    unreliable), types the same prompt `/prompt-preview` already builds into ChatGPT's own
    composer, clicks its send control, waits for streaming to actually start then finish
    (watching for `[data-testid="stop-button"]` to appear then disappear, not just "a message
    exists" - ChatGPT streams its answer in), extracts the last assistant message, strips any
    ```json fence (mirrors the companion-service's own `strip_json_fences`), and closes the tab
    regardless of success or failure. Wired in as a new `"gpt-auto"` value in the existing
    resume-provider dropdown ("GPT (auto via ChatGPT tab)"), not a separate button — the same
    "Generate JSON" button now branches on the selected provider, exactly like the fourth mode
    the user asked for alongside claude/ollama/gpt-manual. `/generate` and `/provider-test`
    both explicitly know about `gpt-auto` too: the former rejects it with a clear error (it
    should never actually be called for this provider — the whole flow is client-side — so a
    stale client or bug hitting it anyway fails loudly instead of silently generating with the
    wrong provider), the latter reports "no connection to test" instead of trying to check one
    that doesn't exist. First release of a genuinely novel mechanism, offered as a choice
    rather than a silent behavior change.
    Explicitly unverified against the real, live chatgpt.com page - no browser access here to
    inspect its actual current DOM. Built with resilient, generic selectors (`#prompt-textarea`,
    `[data-testid="send-button"]`/`stop-button`, `[data-message-author-role="assistant"]`)
    rather than guessed-at exact class names, same reasoning as every ATS-specific fixture in
    this file, but this is a first-principles guess at ChatGPT's structure, not something
    confirmed live the way the ATS findings above are - expect it to need at least one real
    round of "here's what actually happened" correction before it's reliable.
    The one thing that WAS verified (via a synthetic jsdom harness standing in for the real
    page, not a live test): the actual mechanics work correctly in isolation - typing
    multi-line text into a contenteditable composer produces one paragraph per line and fires
    the input event React needs to notice it; the streaming-state wait correctly blocks until
    the stop button disappears before reading a response; a missing/unrecognizable composer
    (not logged in, or the page structure has changed) fails with a clear, specific error
    instead of hanging indefinitely or throwing unhandled.

28. **First live test of the GPT-tab-automation confirmed the core mechanism actually works end
    to end (tab opened, prompt submitted, real reply read back, tab closed) — but the response
    text failed to JSON.parse: "Bad control character in string literal."** Root cause: reading
    the assistant message via `.innerText` reflects the RENDERED/visual approximation of the
    text, and ChatGPT's syntax-highlighted code block visually soft-wraps long lines (e.g. a
    long `"contact_line"` value) — `.innerText` turns that purely-visual wrap point into an
    actual `"\n"` character, landing a raw, unescaped control character inside a JSON string
    value, which `JSON.parse` correctly rejects (a real newline is only legal in a JSON string
    when escaped as `\n`). Fixed two ways: (1) prefer reading the response from the actual
    `<pre><code>` block's own `.textContent` when one exists (reflects the real underlying
    text, not a rendering approximation) rather than `.innerText`; (2) added
    `sanitizeJsonControlChars` as a defensive second layer regardless of where the corruption
    came from — walks the text tracking whether the current position is inside a quoted string
    (correctly handling `\"` escapes so an escaped quote doesn't wrongly toggle the tracking),
    and escapes any raw control character found there to its proper JSON escape sequence,
    leaving valid inter-token whitespace (the pretty-print indentation/newlines between object
    keys) completely untouched. Verified with the exact reported case (a raw newline inside a
    string value, now correctly escaped and parseable), confirmed valid pretty-printed JSON is
    left byte-for-byte unchanged, confirmed escaped quotes inside a string don't confuse the
    in-string tracking, and confirmed the extraction now correctly prefers a code block's clean
    text over a simulated corrupted `.innerText` value.

29. **A generated resume's `contact_line` silently dropped the country ("Warsaw" instead of
    "Warsaw, Poland"), and separately had stray embedded newlines mid-string — both from a
    real generated JSON.** Fixed in `resume_normalize.py`'s `_repair_contact_line`, called from
    `normalize_resume` — the one place every generation path funnels through before rendering
    (Claude, Ollama, manual-paste GPT, and the new auto-GPT-tab mode all eventually call
    `/render`), so the fix applies universally rather than needing to be duplicated per
    provider. Two repairs: (1) collapses any embedded `\r`/`\n` mid-string to a single space -
    a contact line must render as one line, never with an internal break, regardless of why a
    model inserted one; (2) if the profile has a `country` set and it doesn't already appear
    anywhere in the generated line (case-insensitive), inserts it right after the city if the
    city is found in the line ("Warsaw" → "Warsaw, Poland"), or appends it as a fallback
    segment if the city isn't found there either - a model correctly combining city + country
    isn't guaranteed even when it usually gets it right, and this is exactly the kind of
    already-known profile fact that shouldn't depend on generation succeeding, same principle
    behind every `STRUCTURED_PATTERNS` entry in the extension itself. Verified against the
    exact reported contact_line (fixed correctly), confirmed an already-correct line is left
    alone with no duplicate country inserted, confirmed a profile with no country set doesn't
    crash or insert anything, and confirmed the country still gets appended as a fallback even
    when the city text isn't found in the generated line at all. Also verified live end-to-end
    through the real `/render` endpoint, not just the unit-level normalize function.

30. **Second application of the GPT-tab-automation mechanism: Auto Fill's answer generation,
    as a new `"gpt-auto"` value in the Auto Fill answer-provider dropdown (alongside
    claude/ollama/gpt-manual, same pattern as finding 27's resume-generation integration).**
    Unlike per-question `/generate-answer` (which Claude/Ollama use, one call per field), this
    batches EVERY generation-eligible question from a page into ONE prompt and ONE ChatGPT
    round trip — opening a tab per question would be impractical. New server endpoint
    `/prompt-preview-answers` builds this batched prompt (`build_batch_answer_system_prompt`/
    `build_batch_answer_user_message` in prompt.py — a new, separate prompt pair, not a
    reuse of the one-question versions), numbering every question so the response's `answers`
    array maps back to the original questions by position, same "answerable: false when the
    profile can't genuinely answer it" contract as the single-question version. The existing
    consequential-field / structured-match / non-free-text safety gating is completely
    unaffected — gpt-auto only ever sees the exact same `generationCandidates` subset
    Claude/Ollama would, computed identically regardless of provider.
    One deliberate scope limit for this first version: gpt-auto has no automatic AI-semantic
    QA-bank matching (`/match-answers`) — both that endpoint and `/generate-answer` explicitly
    reject `"gpt-auto"` with a clear error if somehow called (mirroring `/generate`'s existing
    gpt-auto guard), since neither should ever actually be reached for this provider. The free,
    non-AI exact/category QA-bank matching in `runAutofillInPage` still applies regardless of
    provider (it isn't gated on `answer_provider` at all), so this only forgoes the *extra*
    semantic-similarity layer, not QA-bank reuse entirely.
    Verified live: `/prompt-preview-answers` returns a correctly-built, correctly-numbered
    batch prompt with the real profile; `/generate-answer` and `/match-answers` both correctly
    reject `gpt-auto` with a clear 400 (had to temporarily seed a QA-bank entry to actually
    exercise `/match-answers`'s check, since it short-circuits before reaching it when the bank
    is empty) — settings and QA bank both reverted to their prior state afterward. Full JS
    regression suite re-run clean.

31. **The "Elegant Serif" PDF/DOCX template's per-contact-item Font Awesome icons (phone/
    envelope/map-marker/LinkedIn) all rendered as the SAME icon** — reported live via a
    screenshot, every item showing the map-marker glyph. Root cause: `pdf_render_elegant.py`'s
    `_render_contact_line` picks each item's icon by checking whether it's formatted as a
    markdown link (`[text](url)`) and inspecting the URL scheme (`tel:`/`mailto:`/
    `linkedin.com` domain/generic) — a plain, non-link segment is assumed to be the location
    and always gets the map-marker icon as a fallback. `prompt.py`'s own schema instructs the
    model to format phone/email/links exactly this way, but a real generated `contact_line`
    used plain text for every segment regardless (the same "the model doesn't reliably follow
    a formatting instruction" pattern behind finding 29's missing-country bug) — so every
    single item fell through to that one fallback case. Fixed by extending
    `resume_normalize.py`'s existing `_repair_contact_line` (finding 29 — the one place every
    generation path funnels through before rendering) with `_linkify_contact_segment`: detects
    a plain phone number, email address, or URL (with or without a scheme/`www.` prefix — an
    earlier version of the URL pattern required one and missed a plain `"github.com/pawel"`-
    shaped segment entirely) and wraps it in the markdown-link format the icon logic depends
    on, leaving an already-correctly-linked segment or genuine plain text (the location)
    untouched. Verified: the exact reported contact_line now produces four distinct,
    correctly-typed icon codepoints (confirmed the four Font Awesome glyphs are genuinely
    different Unicode characters, not just invisible in a terminal); an already-correct
    contact_line is left byte-for-byte unchanged (no double-wrapping); a scheme-less website
    link gets linkified too; the location segment is correctly never mistaken for a link.
    Verified live end-to-end through the real `/render` endpoint using the "Elegant Serif"
    template specifically (the only one with this icon logic — "Modern" doesn't use icons at
    all), then reverted the template selection and cleaned up the test output afterward.

32. **`gpt-auto` Auto Fill answers (finding 30) never saw the saved QA bank at all** —
    reported live with the exact prompt sent and the exact answer received for a real
    Pennylane SAS application: "Where do you live now?" correctly answered "Warsaw, Poland",
    but "When are you available to start?" came back `answerable: false` even though a saved
    QA-bank entry for "notice period/when can you start" existed. Root cause:
    `build_batch_answer_user_message` only ever built the prompt from the candidate profile —
    it never called `store.get_qa()`, unlike `/match-answers`'s prompt (`build_match_answer_
    user_message`), which does. So `answerable: false` for that question wasn't a bug in the
    safety logic itself — it was the *correct*, safe answer given what the model was actually
    given (no notice-period fact in the raw profile, no QA bank in the prompt at all); the gap
    was in the input, not the "don't fabricate" behavior, which worked exactly as designed.
    Fixed by giving `build_batch_answer_user_message` a `qa_bank: list[dict]` parameter and a
    "SAVED Q&A BANK" section (same numbered `Q:`/`A:` format `build_match_answer_user_message`
    already uses, positioned right after the candidate profile and before the questions), and
    updating `build_batch_answer_system_prompt()` to instruct the model to reuse a saved
    answer verbatim when a bank entry genuinely answers a question — even reworded very
    differently, e.g. a different phrasing of the same underlying question — and to only fall
    back to profile-based generation (with the same `answerable: false` safety net) when
    nothing in either the bank or the profile actually answers it. `/prompt-preview-answers`
    (main.py) now fetches `store.get_qa(active_person)` and passes it through. Verified live:
    seeded a temporary QA-bank entry matching notice-period/availability, confirmed
    `/prompt-preview-answers` now renders a correctly formatted "SAVED Q&A BANK" section
    ahead of the questions, then reverted the QA bank to empty afterward. Full JS regression
    suite re-run clean (no JS changes needed for this fix — it's entirely server-side prompt
    construction).

33. **The GPT-tab-automation mechanism (findings 27/30) now also deletes the conversation it
    just created**, instead of leaving every automated resume/answer-generation prompt sitting
    in the user's real ChatGPT chat history forever. Added `tryDeleteConversation()` inside
    `submitChatGptPromptInPage`, run as a best-effort last step right after extracting the
    response text (before the tab-close in `runChatGptPrompt`'s `finally`) — the same
    click-path a real user would use (options button → "Delete" menu item → "Delete" confirm
    button in the resulting dialog), not a call to ChatGPT's own backend API (no session-token
    handling, consistent with every other piece of this automation being pure DOM-click
    simulation). Deliberately never lets a failure here affect the actual result —
    `submitChatGptPromptInPage` returns a `deleted: true/false` flag alongside the existing
    `ok`/`text`, so a selector mismatch just means the conversation is left behind, not that the
    whole generation fails.
    First version's options-button selector prioritized `history-item-0-options` (a sidebar
    per-item button, assumed to be "the newest entry, always topmost") — the user shared the
    real live sidebar HTML, confirming that data-testid pattern genuinely exists, but also
    surfaced a strictly better target: the top bar's own `button[data-testid=
    "conversation-options-button"]`, tied directly to whichever conversation is actually open
    (its own id embeds that conversation's UUID) rather than to sidebar position/ordering,
    which pinned chats or search state could shift. Switched to prefer that, kept
    `history-item-0-options` as a fallback. The menu-item/confirm-dialog selectors were still
    unconfirmed guesses at that point (broadened to match on `data-testid*="delete"` as well as
    exact "Delete" text, for resilience against wording/markup changes) — verified with a
    synthetic jsdom scenario matching the assumed options→menu→dialog shape, but not the real
    DOM. **Confirmed live afterward: the user tested it and the conversation was correctly
    removed** — the guessed menu-item/dialog selectors turned out to work as-is, no further
    correction needed. Full JS regression suite re-run clean after each change.

34. **Full detection sweep across all 298 real captured samples (47 ATS platforms)**, in
    response to "as I copied so many templates, we need to support all detecting correctly."
    Built a jsdom harness (`sweep-captured.mjs`, scratch-only) that runs the real
    `field-detector.js` + `runAutofillInPage` (real profile, `store.py`'s `DEFAULT_QA_ENTRIES`
    as the QA bank) against every `captured/*.html` file, flagging: thrown errors, a field
    count of 0 where that file's own `.json` sidecar previously recorded a nonzero count (a
    same-page regression signal, since the sidecar records what Auto Fill itself detected at
    capture time), and labels that are empty or look like a raw fallback (bare digits, etc).
    Three real bugs found and fixed in `field-detector.js`:
    - **Workday's own global-nav utility buttons** (the language switcher and the settings/
      accessibility gear icon in the top bar) are both plain
      `<button aria-haspopup="listbox" data-automation-id="utilityMenuButton">` — the exact
      same shape `collectNativeElements` looks for to catch Workday's real "Select One" form
      dropdowns. Confirmed across 9 different Workday tenants (Cisco, JLL, Kainos, Live Nation,
      RBS, Spectris, Zoom, plus the original bdx-wd1 report) — every one surfaced these two as
      blank-label "unmatched" noise. Fixed by excluding
      `[data-automation-id="utilityMenuButton"]` from `collectNativeElements`, same
      "exclude by ATS-specific automation id" approach already used for phone country-code
      pickers and file-upload action buttons.
    - **Zoho Recruit's `<crux-phone-component>` dial-code picker** (a
      `<lyte-dropdown lt-prop-user-value="dial_code">` sibling of the real phone-number input,
      rendered as a bare `<div role="combobox">` with no label of its own) surfaced as a
      separate blank-label field. The component's real label lives on its own `cx-prop-label`
      attribute ("WhatsApp Number...") — the dial-code picker is decorative UI for that SAME
      field, not a separate question. Fixed by excluding
      `[lt-prop-user-value="dial_code"]` descendants in `isVisible`, alongside the existing
      select2/intl-tel-input search-box exclusions (same category: internal widget UI for a
      field detected elsewhere).
    - **Zoho Recruit's own dropdown search/filter box** (Lyte framework's
      `class="lyteSearchInput"` wrapper around a type-to-filter `<input>`, e.g. inside a
      "Current Location" combobox) surfaced the same way, for the same underlying reason —
      excluded via `.closest(".lyteSearchInput")` in `isVisible`.
    Total detected fields across the sweep went from 881 (59 anomalies, most files not even
    completing due to a `MouseEvent` reference error that turned out to be the SWEEP HARNESS's
    own gap, not a product bug - `simulateClick`'s real `new MouseEvent(...)` calls are always
    valid in an actual browser tab) to 1596 (11 anomalies) after fixing the harness gap and the
    three real bugs above. Full JS regression suite (23 files) re-run clean after each change.
    The remaining 11 anomalies were individually investigated and are **not bugs**:
    - 7 SmartRecruiters captures show 0 fields today despite a nonzero sidecar count. Root
      cause: SmartRecruiters' `oneclick-ui` screening-questions form
      (`<sr-screening-questions-form definition="...">`) renders its entire set of real
      `<input>`/`<select>` elements from a JSON `definition` attribute into shadow DOM at
      runtime. `Element.outerHTML` never serializes open-shadow-root content, by web platform
      design — so Save Sample's captured HTML never contained those elements in the first
      place, regardless of any fix here. Confirmed by grepping the fixture: 0 real
      `<input>`/`<select>`/`<textarea>` tags and 0 `spl-input` tags anywhere in the file. An
      inherent limitation of the HTML-snapshot capture format for this one ATS, not fixable in
      `field-detector.js`.
    - 1 Workday capture (zoom, `.../jobTasks/completed/application`) shows sidecar-had-1,
      today-0. The sidecar's one recorded field was itself a stale blank-label `type: "submit"`
      false positive on an already-submitted confirmation page with no real form left to fill —
      today's 0 is more correct, not a regression.
    - `careers-bookingkit-com`/`goodgamestudios-teamtailor-com` show a bare digit ("66"/"8") as
      a label for the same shared "click to edit number" widget (`name="range-custom_number"`,
      `data-action="...#editNumber"`). Confirmed this widget's real, editable `<input>` is
      wrapped in a Tailwind `hidden` class, but the CSS defining `.hidden{display:none}` is
      loaded from an external Teamtailor-CDN stylesheet the sweep harness's jsdom can't fetch
      (no resourceLoader/network access) — a real browser tab correctly applies that CSS and
      `isVisible`'s existing `style.display === "none"` check would already exclude it. A test-
      harness limitation, not a product bug.
    - `join-com` shows "2026" (the currently-selected value) as the label for a date-picker's
      Year combobox, instead of the real shared question ("When are you available to start
      working with us?"). Root cause: `findHeadingInAncestors`'s "stop if >1 control" guard
      (added in finding 26 to fix Lever's shared multi-question card) breaks the climb at
      depth 5 here, but the real shared `<h2>` for this composite month/year field is only
      reachable via `previousElementSibling` at depth 11 — confirmed by walking the actual
      ancestor chain. Lever's card needs to stop early (4-5 *distinct* questions sharing one
      heading); join.com's date-picker needs to keep climbing (2 sub-parts of *one* question).
      A raw control-count threshold can't distinguish these safely - **left unfixed rather than
      risk blindly re-breaking finding 26's Lever fix**; needs a better distinguishing signal
      (e.g. whether the "shared" controls already each resolve a distinct label some other way)
      before attempting a fix.

35. **New setting: "Delete the ChatGPT conversation after generating"** (`Settings.
    delete_gpt_conversations: bool`, default `true`) — reported live: after finding 33 started
    auto-deleting each gpt-auto conversation, there was no way left to go back and inspect the
    actual prompt/response ChatGPT produced when a result looked wrong (e.g. investigating why a
    generated resume's experience bullets had lost their `**bold**` emphasis - confirmed by
    reading the code that the contact-line fix (finding 29) and the bold-rendering pipeline
    (`pdf_text.py`'s `_BOLD_RE` → reportlab `<b>`) are both untouched and unrelated to bullets at
    all, so the actual cause needed the real ChatGPT conversation to diagnose, which no longer
    existed). Added the setting (`schemas.py`), a checkbox in Settings > Generation
    (`options.html`/`options.js`, shown whenever either provider is `gpt-auto`, following the
    exact same show/hide-by-provider pattern as the existing `gptHint` div), and threaded it
    through: `runChatGptPrompt(prompt, deleteConversation = true)` now passes the flag into the
    injected `submitChatGptPromptInPage(prompt, deleteConversation)`, which skips calling
    `tryDeleteConversation()` entirely when it's false - both call sites (resume generation,
    batch Auto Fill answers) read the setting and pass it through. Verified via `/settings`
    returning the new field with the correct default, and two new jsdom scenarios in
    `test-chatgpt-tab.mjs`: `deleteConversation:false` never even clicks the options button
    (confirms the skip is a genuine no-op, not just a swallowed failure), while
    `deleteConversation:true` still deletes exactly as before. Full 23-file regression suite
    re-run clean (this change doesn't touch detection at all, so the 298-fixture sweep wasn't
    re-run for it).

36. **Fixed a real listener-leak risk in `runChatGptPrompt`** (the GPT-tab-automation
    orchestrator, findings 27/30/33), found while investigating a reported whole-Chrome crash
    on extension reload that got increasingly frequent after the GPT-auto integration was
    added. Root cause: waiting for the newly-opened chatgpt.com tab to finish loading
    registered a `chrome.tabs.onUpdated` listener that only ever got removed when a "complete"
    status update fired for that exact tab afterward - with no timeout and no check for whether
    the tab had ALREADY reached "complete" before the listener even attached (a real race: an
    instant/cached load can finish loading before `chrome.tabs.create`'s own await resolves
    here). Either that race, or the tab being closed early by the user before "complete" ever
    fires, would hang the whole call forever AND permanently leak that listener -
    `chrome.tabs.onUpdated` listeners aren't scoped to a tab's lifetime, so each occurrence
    accumulates in the side panel's own long-lived context (alive as long as the window's side
    panel document is, not just for one call) rather than being garbage-collected with the tab.
    Fixed by adding a `chrome.tabs.get()` check for the already-complete race, plus a 20-second
    timeout backstop for the general case - both funnel through one `finish()` that's
    idempotent and always removes the listener exactly once. Verified with a new
    `test-runchatgptprompt.mjs` (mocks `chrome.tabs`/`chrome.scripting`, not real Chrome APIs):
    confirms the listener is actually removed (not just that the promise resolves) in all three
    paths - normal completion, the already-complete race resolving quickly via `tabs.get()`
    rather than waiting the full 20s, and the never-completes case falling through to the
    timeout backstop. **Important caveat, told to the user directly**: this doesn't fully match
    the reported symptom - they confirmed no leftover chatgpt.com tabs were ever observed
    sitting open, which a hang here would also produce, so this fix closes a real, independently
    worthwhile bug but is NOT confirmed to be the actual cause of the browser crash. The user
    also independently confirmed reloading a completely unrelated extension crashes all Chrome
    profiles identically, which still points at a Chrome/environment-level issue rather than
    anything in this codebase - not yet root-caused; next step is the user checking
    `chrome://crashes`'s uploaded report detail and `chrome://gpu`. **Follow-up**: the crash
    turned out to be intermittent (reported as gone, then recurring, unrelated to any specific
    change tried, including disabling hardware acceleration) - not reliably reproducible, so
    further active investigation was dropped in favor of the user just monitoring frequency
    over time. Genuinely unresolved, most likely environmental (GPU driver/Windows-level), not
    a bug in this codebase.

37. **Moved "Delete ChatGPT conversation after generating" (finding 35) from Settings into the
    side panel**, next to the provider dropdowns - same reasoning as Mode/both providers already
    living there: it's the kind of thing worth toggling mid-session (right when a result looks
    wrong and you need to go back and inspect the real ChatGPT conversation), not a rarely-
    touched config value worth a trip to Settings for. New `#gptAutoOptions` checkbox in
    `sidepanel.html`, shown/hidden in `applyTailorMode()` whenever either provider is
    `gpt-auto` (mirroring how `tailorModeSelect`/`providerSelect`/`answerProviderSelect` are
    synced there), saved immediately via the existing `patchSetting()` helper on change - same
    pattern as the other three. Settings' own checkbox was removed and replaced with a plain
    hint (`#gptAutoHint`, matching the existing `#gptHint` pattern for the manual "gpt"
    provider) pointing at the side panel; `buildSettingsPayload()` now carries
    `delete_gpt_conversations` forward from `loadedSettings` instead of reading a control that
    no longer exists there, same as `tailor_mode`/`provider`/`answer_provider` already do. Full
    24-file regression suite re-run clean.

38. **Removed the candidate profile entirely from the batched Auto Fill answer prompt (finding
    32)** — explicit user instruction: with a large, curated Q&A bank now in place (250+ saved
    entries), the full profile/work-history JSON was pure bloat for this job and unnecessary
    personal data to hand to an external ChatGPT session on every batch. `build_batch_answer_
    user_message` (`prompt.py`) dropped its `profile` parameter entirely - the prompt now only
    contains the SAVED Q&A BANK, company, job description, and the numbered questions.
    `build_batch_answer_system_prompt()` rewritten to match: no longer describes "profile-based
    generation" as a fallback (there's no profile to fall back to anymore) - now purely
    Q&A-bank-reuse-or-`answerable:false`, with the non-negotiable "only use facts already
    present in the saved Q&A bank" rule replacing the old profile+bank wording. `/prompt-
    preview-answers` (main.py) no longer calls `store.get_profile()` at all. Verified live: the
    built user_message now starts directly with "SAVED Q&A BANK:", no "CANDIDATE PROFILE"
    section anywhere. Full 24-file JS regression suite re-run clean (this is a server-side-only
    change - no JS touched). Resume generation itself (`/generate`, `/prompt-preview`,
    `build_user_message`) is unaffected - it still needs and sends the full profile, since
    that's a fundamentally different job (writing tailored bullets from real work history, not
    reusing a saved short answer).

39. **Removed `background.js`'s `onInstalled` per-tab sidePanel sweep entirely**, following the
    user's correction that reloading THIS extension crashes all Chrome profiles, but reloading a
    different, unrelated extension does NOT (an earlier answer had suggested otherwise - this
    was the corrected, more carefully-tested observation). That reframes the whole
    investigation: something specific to what THIS extension does differently from a typical
    extension is the actual lead, not a general Chrome/environment bug. The one genuinely
    unusual thing `background.js` does that most extensions never do at all: on every
    install/update, `chrome.tabs.query({})` across every window, then `chrome.sidePanel.
    setOptions` for every single result - a real per-tab Chrome-API sweep, run at the exact
    moment the service worker itself is restarting (already made sequential rather than
    concurrent per an earlier fix, but still a sweep across however many tabs are open, possibly
    dozens across multiple windows per earlier context about this user's usage). Removed it
    entirely - pre-existing tabs now get their own per-tab side panel lazily, the first time
    they're actually activated (`chrome.tabs.onActivated`, previously just a defensive backstop,
    now the sole mechanism for this case), instead of all being swept eagerly on every reload.
    New tabs still get it immediately via `chrome.tabs.onCreated`, unaffected. Graceful
    degradation if a tab is never activated again: it just keeps sharing the window's default
    panel, same behavior as before this whole per-tab mechanism was built. Full 24-file JS
    regression suite re-run clean. **Not confirmed to fix the crash** - it's the single most
    plausible remaining code-level lead (the one Chrome-API operation unique to this extension's
    reload path that a typical extension's reload never touches at all), but this needs the
    user to actually test reloading after this change to know whether it helped.

40. **Root-caused and fixed the actual GPT-generated bold/link markdown loss** (findings 27/29/
    31/33 were all working around symptoms of this same underlying issue, without knowing it):
    the schema contract explicitly tells the model NOT to wrap its JSON reply in a markdown code
    fence (a real requirement for Claude/Ollama, whose responses come straight through an API
    with no rendering step) - but ChatGPT's own browser UI still renders whatever it gets AS
    markdown whenever it ISN'T inside a fenced code block. A genuine `**bold**` or
    `[text](url)` the model wrote INSIDE a JSON string value (meant to stay literal for our own
    PDF/DOCX renderer to interpret afterward) gets visually converted into a real `<strong>`/
    `<a>` element by ChatGPT itself, and reading `.textContent`/`.innerText` off that
    already-rendered HTML returns just the plain words - the markdown syntax was stripped by the
    browser's OWN rendering, not by anything in this codebase. This explains the exact
    inconsistency reported live: bullets sometimes kept their `**bold**` markers (whenever the
    model happened to wrap the reply in a code fence anyway, despite being told not to) and
    sometimes silently lost them (whenever it didn't) - confirmed by generating the exact same
    resume JSON through the real `/render` endpoint and inspecting actual per-character PDF/DOCX
    font usage (`Helvetica-Bold`/`bold=True` exactly where `**text**` was in the JSON) - proving
    the renderer was never the problem, only the extraction from ChatGPT's rendered DOM.
    Fixed by replacing the `codeBlock.textContent`/`.innerText` extraction in
    `submitChatGptPromptInPage` with a new `reconstructMarkdown(node)` that walks the assistant
    message's actual rendered DOM and "un-renders" it back into markdown before reading
    anything: `<strong>`/`<b>` → `**text**`, `<em>`/`<i>` → `_text_`, `<a href>` → `[text](url)`,
    `<code>`/`<pre>` still read via their own raw `.textContent` unprocessed (preserving finding
    27's original "long line's visual soft-wrap becomes a literal embedded newline" fix exactly,
    rather than replacing it - a genuine code-fenced response still hits that same safe path).
    Considered clicking ChatGPT's own "Copy" button and reading the clipboard instead (the user
    found its real selector, `button[data-testid="copy-turn-action-button"]`) - decided against
    it: clipboard read/write triggered by a script-dispatched (non-trusted) click has real
    uncertainty around Chrome's user-activation gating and would need a new `clipboardRead`
    permission with possible prompts, whereas DOM reconstruction is synchronous, deterministic,
    and fully testable without any of that risk. Verified with a new jsdom scenario simulating
    exactly the no-code-fence case (plain `<p>` with inline `<strong>`/`<a>`, no `<pre><code>`
    anywhere) - confirms the extracted text correctly contains `**distributed databases**` and
    `[+48573503853](tel:+48573503853)`, and that `JSON.parse` on the result recovers the
    original bold/link markers exactly. Full 24-file regression suite re-run clean, including
    the original code-fence scenario (finding 27) unaffected.

41. **Fixed "ChatGPT's response was empty" (reported live, intermittent)** in
    `submitChatGptPromptInPage`. First ruled out the user's own hypothesis (deleting the
    conversation too quickly) by re-reading the actual code order: `tryDeleteConversation()`
    only ever runs AFTER text has already been successfully extracted, and the tab only closes
    after this whole function has already returned its result - neither can interrupt
    extraction, so that wasn't structurally possible as the cause. Found two real causes
    instead, both timing races around the same two-phase "wait for generation to start, then
    wait for it to finish" check:
    - The "wait for generation to start" loop only waited 5 seconds (25×200ms) for ChatGPT's
      stop button to appear. A longer "thinking" pause before the visible answer starts
      streaming can outlast that - `isGenerating()` never once reports true, so the second
      "wait for finish" loop's condition is already false and it exits after zero iterations,
      concluding generation is "already done" when it never even started. Widened to 15 seconds
      (75×200ms).
    - Even once correctly detected as finished, the assistant message container can exist in
      the DOM (found by `querySelectorAll`) before React has actually committed its final
      content - a single immediate read landing in that gap reports "empty" even though real
      content is milliseconds from appearing. Added a retry loop (up to 10 attempts, 300ms
      apart) before giving up, instead of failing on the first read.
    Verified with two new jsdom scenarios: one where the stop button never appears at all
    (confirms the widened/exhausted wait still succeeds instead of reading prematurely), one
    where the message container is appended empty and only populated a beat later (confirms the
    retry loop picks up the real content instead of reporting empty on the first check) - the
    test harness's shared `run()` helper was extended with `skipStopButton`/`contentDelayMs`
    options to simulate both races directly rather than relying on wall-clock timing, since the
    whole file's `setTimeout` is capped to keep it fast. Full 24-file regression suite re-run
    clean.

42. **`makeSidePanelPerTab` now skips the GPT-tab-automation's own chatgpt.com tab entirely** -
    a more targeted continuation of findings 39/41's crash investigation, after the user pushed
    back that removing the eager `onInstalled` sweep (finding 39) didn't stop the crash, and
    correctly pointed out the timing lines up with the GPT integration specifically, not the
    per-tab-side-panel feature itself (which predates GPT automation by a long way and hadn't
    caused reload crashes before it). That reframed the lead correctly: `runChatGptPrompt`
    opens a real, visible chatgpt.com tab per generation and closes it again once it has the
    answer - `chrome.tabs.onCreated` (and then `onActivated`, since it opens `active: true`)
    both fire for that tab like any other, assigning it its own side-panel via
    `makeSidePanelPerTab`, even though nothing in a chatgpt.com automation tab ever opens or
    uses a side panel at all. Every single GPT-auto generation was creating and tearing down
    one of these extra panel-bearing tabs on top of whatever regular tabs the user already had -
    new churn introduced specifically by the GPT integration, contributing nothing functional.
    Fixed by checking the tab's `url`/`pendingUrl` (the latter covers `onCreated` firing before
    navigation has actually committed, which `chrome.tabs.create({url: "https://chatgpt.com/"})`
    sets immediately) inside `makeSidePanelPerTab` itself - centralizing the check so it applies
    uniformly regardless of which listener (`onCreated`, `onActivated`) triggered it, rather
    than duplicating the check in each. Regular job-application tabs are completely unaffected -
    verified with a new `test-makesidepaneltab.mjs` (mocks `chrome.tabs.get`/`chrome.sidePanel.
    setOptions`, four scenarios: a regular tab still gets its panel, a chatgpt.com tab with
    `url` already set is skipped, one caught via `pendingUrl` pre-navigation is also skipped,
    and a tab that's already gone by the time `chrome.tabs.get()` lands still fails silently
    rather than throwing, same as the original try/catch already handled). Full 25-file
    regression suite re-run clean. **Not confirmed to fix the crash** - same honest caveat as
    finding 39: this is the most targeted, well-reasoned remaining lead given the corrected
    timing evidence, but needs the user to actually test reloading (ideally after several
    GPT-auto generations, to reproduce the exact churn pattern this targets) to know for sure.

43. **New diagnostic flag: "Give each tab its own side panel"** (Settings > Connection,
    `chrome.storage.local.perTabSidePanels`, default `true` = current/original behavior) - after
    findings 39/42 (two targeted mitigations around the per-tab-side-panel mechanism) both
    failed to stop the reload crash, the user explicitly asked to make the WHOLE mechanism
    toggleable rather than removing it outright, so it can be tested reversibly instead of
    losing the feature for good if it turns out unrelated. `makeSidePanelPerTab` (background.js)
    now checks this flag first and returns immediately if it's explicitly `false`, skipping
    per-tab assignment entirely - every tab then falls back to manifest.json's shared
    `side_panel.default_path` (one panel for the whole window, Chrome's own default), same as
    before this whole per-tab mechanism was ever built. Checkbox added right next to the
    existing connection fields in `options.html`/`options.js`, saved via the same
    `chrome.storage.local` mechanism `baseUrl`/`token` already use (not routed through the
    Python companion-service at all - purely a browser-side behavioral toggle). Verified with
    two new jsdom scenarios in `test-makesidepaneltab.mjs`: `perTabSidePanels: false` skips
    assignment even for an ordinary job-application tab (not just the chatgpt.com case from
    finding 42), and an UNSET flag (fresh install, never toggled) still defaults to the current
    per-tab-enabled behavior - only an explicit `false` disables it. Full 25-file regression
    suite re-run clean. Known limitation, documented in the Settings hint text: toggling this
    doesn't retroactively un-assign panels already given to tabs earlier in the session (no
    "undo" call exists) - it only affects tabs created/activated after saving, so a clean test
    needs either fresh tabs or a full Chrome restart after toggling it off.
    **Result: the user tested with the flag off (per-tab side panels completely disabled) and
    the reload crash still happened.** This conclusively rules out the per-tab-side-panel
    mechanism as the cause - the single most architecturally unusual thing this extension does,
    directly disproven via a controlled, reversible test. Combined with findings 39/42 (two
    lighter mitigations around the same mechanism, both also ineffective) and the crash's
    already-established intermittency (same action succeeding and failing at different times
    even for this exact extension), removed the flag entirely per the user's request rather than
    leave dead diagnostic code around - `makeSidePanelPerTab` reverted back to unconditional
    (no storage check), checkbox removed from `options.html`/`options.js`, the two flag-specific
    test scenarios removed from `test-makesidepaneltab.mjs`. Full 25-file regression suite
    re-run clean after removal. **The crash remains unresolved** - with the one clear
    architectural difference now eliminated as a cause, the two remaining honest paths are: (a)
    a rigorous repeated-trials comparison (reload this extension 5+ times vs. a different
    extension 5+ times, same session, to get an actual frequency comparison rather than a single
    anecdotal one) to check whether the earlier "only this extension" observation holds up
    statistically given how probabilistic this has turned out to be, or (b) accept it as a
    Chrome/Windows/GPU-driver-level issue outside this codebase's reach and use the fully-quit-
    and-relaunch-Chrome workaround instead of the in-place reload button.

44. **A cluster of real, live-reported JD-extraction and Auto Fill bugs, each confirmed against
    real live pages** (fetched directly rather than guessed at):
    - **join.com / Teamtailor showing literal `<p>`/`<h2>`/`<span>` text in the extracted job
      description**: both platforms' JobPosting JSON-LD `description` field is DOUBLE
      HTML-encoded - confirmed by fetching two real join.com postings and one real Teamtailor
      posting directly: the raw JSON string literally contains `&lt;h2 id=&quot;...&quot;&gt;`
      (real entities, not real tags). A single `htmlToText()` pass only decodes one layer,
      producing plain text that merely LOOKS like markup ("<h2 id=\"...\">...") since it was
      never actually parsed as tags. Fixed by running `htmlToText()` twice
      (`extractJobDescription`'s JSON-LD branch) - harmless no-op for an already-correctly-
      single-encoded description (e.g. Ashby's), since clean plain text with no leftover
      "<"/"&" characters just passes through the second pass unchanged.
    - **Ashby location/tech-skills wrong**: the free-text location guess correctly read "Remote"
      from a generic company-culture sentence ("Remote-first flexibility..."), but missed that
      the posting is actually restricted to one specific country (Ukraine) - that fact was
      sitting in the SAME JSON-LD block's `jobLocationType`/`applicantLocationRequirements`
      fields the whole time, just never read. Added `formatStructuredLocation()` - prefers
      `jobLocation.address`/`applicantLocationRequirements` over the free-text regex guess when
      JSON-LD is present, threaded through as a new `structuredLocation` field from
      `extractPageInfo` → `scrapeCurrentTab` → `loadJobFacts` (overriding `facts.location` only
      when structured data was actually found). Tech skills were missing ASP.NET Core, Entity
      Framework, and ArgoCD - all explicitly listed in this exact posting's own "Tech stack:"
      line but absent from `TECH_SKILL_KEYWORDS` - added.
    - **Rippling showing "Rippling Recruiting" as the company name**: confirmed live on
      `ats.rippling.com/nutrient/jobs/...` - that's the ATS vendor's own generic
      `og:site_name` branding, not the hiring company ("Nutrient", confirmed via the URL path
      and buried in `og:description`). `extractCompany()` now derives the company from the URL
      path's first segment specifically for `ats.rippling.com` (checked before the generic
      og:site_name strategy), leaving every other site's own legitimate og:site_name usage
      untouched.
    - **SmartRecruiters "attach resume" not detecting the field**: the shadow-DOM-piercing
      detection code already existed (built specifically for SmartRecruiters'
      `<spl-dropzone>`) and correctly finds/sets `.files` on the real internal file input - but
      the dispatched "input"/"change" events were missing `composed: true`, so they could never
      escape the shadow root to reach a listener on the HOST element, which is exactly where a
      drop-zone-style component plausibly manages its own "file attached" state. Added
      `composed: true` to both dispatched events.
    - **SmartRecruiters (and generally) location/combobox selection not working, "wait too
      shortly"**: `fillReactSelectByClick`'s option-polling budget was 10 attempts × 100ms = 1
      second max. A purely client-side-filtered dropdown (a static country list) resolves near-
      instantly, but a location/city autocomplete commonly debounces and does a real network
      geocoding lookup that can easily exceed 1 second. Widened to 30 attempts × 100ms = 3
      seconds max, in all four occurrences (both the single-select and "select all that apply"
      branches, in both the Auto Fill and Learn copies of this function) - still a poll, not a
      fixed wait, so a field that resolves quickly is completely unaffected.
    Verified: 5 new jsdom scenarios in `test-structured-location.mjs` (structured location +
    double-decode + tech skills), 2 new scenarios in `test-widget-iframe-extract.mjs` (Rippling
    company derivation + a normal site's og:site_name left untouched), 1 new scenario in
    `test-attach-resume.mjs` (a real open-shadow-root `<spl-dropzone>`-shaped widget, confirming
    both the file attaches AND the composed event reaches a listener on the host element), and a
    new dedicated `test-combobox-slow-search.mjs` (a ~1.8s debounced menu appearance - well past
    the old 1s budget, resolves correctly within the new 3s one). Full 27-file regression suite
    re-run clean after each change; all four fetched-live real pages (join.com x2, Teamtailor,
    Rippling) were used as direct evidence, not assumptions.

45. **BambooHR's "Country" field was completely invisible to detection** - reported live as
    "country selection is not correct," with the follow-up detail that City/Province (real text
    inputs elsewhere on the same form) depend on Country being set first, so an unfilled Country
    was producing wrong downstream values too. Confirmed via a real captured BambooHR
    application page: the field is a plain
    `<button aria-haspopup="true" aria-expanded="false" aria-label="Country Poland">` (BambooHR's
    own "Fabric" design-system Select component), with the real underlying `<select>`
    deliberately hidden (`aria-hidden`, near-zero size) and no `role="combobox"` anywhere on the
    button. `collectNativeElements()`'s selector only ever matched
    `button[aria-haspopup="listbox"]` (Workday's exact pattern) - BambooHR uses the generic
    `aria-haspopup="true"` instead, so this button was invisible to detection entirely, never
    even reaching "unmatched." Added `button[aria-haspopup="true"]` to the selector alongside
    the existing `"listbox"` value - `looksLikeComboboxPick()` already handles it correctly from
    there (its `aria-expanded` check already covers this shape). Verified with a new
    `test-bamboohr-country-select.mjs`, confirming the button is now detected (previously would
    have been absent from the result entirely). Full 28-file regression suite re-run clean.

46. **SmartRecruiters location field was getting processed twice** - reported live: after
    correctly filling a location field ("Warsaw, Masovian, Poland" selected successfully, thanks
    to finding 44's widened combobox-search polling), Auto Fill immediately tried the same field
    again - a fresh search, "no data found," the field visually collapsing. Confirmed the user's
    own diagnosis (they correctly attributed it to Auto Fill retrying, not the page's own
    behavior) by finding a real structural gap: `collectNativeElements()` had no exclusion for a
    custom-element HOST that carries `role="combobox"`/`aria-haspopup` on itself while its real,
    interactive input lives inside its own open shadow root (SmartRecruiters' `spl-*` widget
    pattern, same family as the phone dial-code and dropdown-search-box cases already fixed) -
    both the host (matched via the native selector) and its real internal input (matched via
    `collectShadowElements`) were ending up as two separate `singles` entries for one physical
    widget, so it got filled once via the host, then again via the internal input reached
    separately. Fixed by excluding any element with its own `.shadowRoot` from
    `collectNativeElements` - its real content is already collected separately, so the host
    itself contributes nothing but a duplicate. Verified with a new
    `test-shadow-host-dedup.mjs`: a host with both `role="combobox"` and an open shadow root
    wrapping a real input now produces exactly one `single` (the real internal input, not the
    host). Full 29-file regression suite re-run clean.

47. **`simulateClick`'s synthetic `PointerEvent`s were silently defaulting to `isPrimary: false`**
    - the actual root cause behind BambooHR's Country dropdown never opening even after finding
    45's detection fix. Diagnosed through direct back-and-forth with the user rather than a
    static capture (a closed-state HTML snapshot can't show what happens on click): confirmed
    the detected button/label/routing were all correct, then confirmed a real manual click on
    the exact same button opens the dropdown normally - meaning the gap was specifically in the
    synthetic click mechanism itself, not detection or matching. `PointerEventInit`'s `isPrimary`
    property defaults to `false` unless explicitly set, but a real mouse-originated pointer event
    always reports `isPrimary: true` - a component library built pointer-event-first can
    reasonably (and BambooHR's "Fabric" Select button apparently does) gate its own open/activate
    logic on exactly that flag, silently treating an `isPrimary: false` pointerdown as a
    secondary/synthetic touch point to ignore rather than a real click. Fixed by explicitly
    setting `isPrimary: true`, `pointerId: 1`, `pointerType: "mouse"` (plus `button: 0` on the
    shared opts) in both `simulateClick` implementations (Auto Fill and Learn), matching what a
    genuine mouse click's PointerEvent actually carries instead of leaving it at
    `PointerEventInit`'s own defaults. Verified with a new `test-simulateclick-pointer.mjs` -
    since jsdom doesn't implement `PointerEvent` at all, stubs a minimal fake specifically to
    capture and assert on the init dict `simulateClick` actually constructs the event with.
    This is a foundational fix: `simulateClick` is the single shared click mechanism behind
    combobox-filling, group-option-clicking, and now confirmed-fixed for BambooHR - any other
    ATS whose custom components gate on `isPrimary` benefits from this too, not just BambooHR.
    Full 30-file regression suite re-run clean.

48. **New: `chrome.debugger`-based "trusted click" fallback**, for widgets whose own JS
    specifically checks `event.isTrusted` before reacting. After finding 47's `isPrimary` fix
    didn't actually resolve BambooHR's Country dropdown (confirmed live: it still never opens
    via any synthetic event), and confirming via direct back-and-forth that a real manual click
    opens it normally while every synthetic `dispatchEvent` variant tried does not - traced this
    to a hard, unfixable-from-page-JS limitation: `isTrusted` can never be set to `true` by any
    script, by deliberate browser design, no matter how the event is constructed. The only way
    around it is dispatching input at the browser-internals level via the Chrome DevTools
    Protocol (`chrome.debugger`), which Chrome treats as genuinely trusted - the same mechanism
    tools like Puppeteer use. Explicitly discussed the real trade-off with the user before
    implementing (a persistent, unavoidable "this extension started debugging this browser"
    banner for however long the debugger stays attached) - user opted in.
    Added `"debugger"` to `manifest.json` permissions; `background.js` now has a `TRUSTED_CLICK`
    message handler that attaches the debugger to the sender's own tab (via `sender.tab.id`,
    no need to pass a tabId explicitly), sends one `Input.dispatchMouseEvent` press+release pair
    at the given coordinates, and detaches immediately - kept as brief as possible, since the
    banner is only visible while attached. `sidepanel.js` gained a `trustedClick(el)` helper
    (in both copies of `fillReactSelectByClick`'s file) that messages this handler and resolves
    to whether it succeeded; wired in as an explicit fallback - only tried after `simulateClick`
    plus the full normal option-polling budget already came up completely empty (no options
    ever appeared), never as the default path, since the vast majority of sites already work
    correctly with the free, invisible synthetic-click approach. Verified with a new
    `test-trustedclick-fallback.mjs`: a button wired to do nothing on any synthetic event
    (matching the reported live behavior) only opens in response to the mocked
    `chrome.runtime.sendMessage("TRUSTED_CLICK", ...)`, confirming the fallback actually fires
    and the field gets filled correctly once it does - and that it only escalates after the full
    normal-poll budget is exhausted (confirmed via elapsed time), not eagerly. Full 32-file
    regression suite re-run clean (existing tests that never define `global.chrome` still pass -
    `trustedClick`'s try/catch safely resolves to `false` if `chrome` is unavailable, rather than
    throwing). **Not yet confirmed against the real live BambooHR page** - needs the user to test
    with this synced.

49. **BambooHR's "Province" field was left unmatched** - reported live after finding 48's
    debugger-based click confirmed working (Country now fills correctly): the real captured
    markup showed Province is a plain MUI text input (`<input name="state.value" type="text">`),
    no dropdown/cascading logic involved at all, yet it stayed empty. Root cause:
    `ContactInfo.state` was deliberately excluded from `STRUCTURED_PATTERNS` entirely (a past
    decision, since some "State" questions carry conditional wording a profile value can't know
    about - "select N/A unless you live in the US or Australia"). For a plain, non-conditional
    "Province"/"State" label this left a real, available profile fact ("Masovian") unused,
    forcing either manual input or an ungrounded AI-generation guess. Added a pattern requiring
    the label to be the WHOLE (normalized) label, not just start with those words - a first
    attempt anchored only to the start (`^(state|province)\b`) was caught by the test itself
    still matching "State (select N/A unless you live in the US or Australia)" (that label
    genuinely starts with "State"), reintroducing the exact risk this was supposed to avoid;
    requiring the entire label correctly excludes any trailing qualifier text. Verified with
    `test-province-state-field.mjs`: a plain "Province" field is now filled from
    `profile.contact.state`, while the conditional-wording label correctly still falls through
    unmatched. Full 33-file regression suite re-run clean.

50. **`TECH_SKILL_KEYWORDS` was missing several real keywords, plus a plural-matching bug** -
    reported live on a fresh "Save Sample" capture of the same BambooHR posting
    (`cgfag-bamboohr-com-20260728T001550Z.html`): the extracted "Tech skills" list was missing
    terms the posting's real text explicitly names in its "Nice to Have" section - Podman,
    OpenShift, Jenkins, SonarQube, OpenSearch, Dynatrace - none of which were in the keyword
    list at all. Separately, the existing `"REST(?:ful)? API"` keyword never matched the
    posting's actual wording ("...maintain REST APIs...") because its `\b` word boundary is
    checked right after "API", and "API"/"s" are both word characters with no boundary between
    them - the plural form silently never matches. (Location/Salary/Seniority were separately
    confirmed CORRECT as "Not mentioned" - the posting's JSON-LD `jobLocation.address` has every
    field explicitly `null`, and the full free-text description mentions none of these at all.)
    Added the six missing keywords and changed the API pattern to `"REST(?:ful)? APIs?"` to cover
    both singular and plural without a duplicate near-identical entry. Full regression suite
    re-run clean (`test-structured-location.mjs`'s existing tech-skill scenario unaffected).

51. **BambooHR's Country selection left "Province" unfilled** even after finding 49's plain-input
    fix - reported live with the real markup: while Country still shows its default (United
    States), the same field is actually a `fab-Select` DROPDOWN labeled "State" (button +
    hidden native `<select name="state.value">`), not a text input at all. The instant Country
    is changed to a country without enumerable states (e.g. Poland), BambooHR's own JS removes
    that dropdown's button+hidden-select nodes outright and replaces them with the plain
    "Province" text input finding 49 already handles - same `name="state.value"`, but a
    completely different set of DOM nodes. Root cause: `runAutofillInPage` collects `singles`
    ONCE up front, before any field gets filled. Country is filled earlier in that same pass, so
    by the time the loop reaches the already-collected State entry, its button+hidden-select
    nodes have already been removed from the document - `fillSingle` silently does nothing to a
    detached element, and the real, live Province input that replaced it never gets touched at
    all (this is why it still read "0"/empty even with finding 49 live). Fixed by capturing a
    stable relocation key (`nearestNamedControlKey` - the field's own `name` attribute, or if
    absent, a same-container `[name]` sibling's) for every single immediately after collection,
    while all elements are still live; when a single is found to be `!element.isConnected` at
    fill time, re-runs `collectFormFields()` and relocates to whichever fresh single shares that
    same key, before falling through to the old fill logic on the live replacement. (First
    attempt computed the key AFTER detecting staleness instead of upfront - broke silently,
    since BambooHR's real swap uses `innerHTML` reassignment, which nulls a removed node's
    `parentElement`, so `closest()` on the already-stale node can't walk up to find the key
    at all; caught by my own test failing with an empty `unmatched` array.) Verified with
    `test-stale-state-after-country.mjs`: Country fills via the existing trustedClick fallback,
    the swap happens exactly like the real page, and the live Province `<input>` that replaces
    the old State dropdown ends up correctly filled with `profile.contact.state` - checked
    against the actual DOM node, not just the reported result. Full 35-file regression suite
    re-run clean.

52. **A real ats.rippling.com application wrongly filled 7 unrelated questions with "Fluent"** -
    reported live with a real "Save Sample" capture (`ats-rippling-com-20260728T090109Z.html`):
    "...unrestricted right to work...", "...require sponsorship...", "...salary
    expectations...", and 4 others all got the same QA-bank answer meant for a completely
    different language-proficiency question. Root cause: Rippling's own custom Select widget
    wraps its combobox 6 DOM levels deep in framework wrapper divs, with no id/for/
    aria-labelledby/fieldset link to its real question at all - the real text sits as a plain,
    unassociated sibling `<p>` several ancestor levels further up. `resolveOwnLabel` trusted the
    combobox's own `aria-label="Select"` (its literal, still-unselected placeholder state, not a
    real label) immediately, so every one of these 7 fields resolved to the identical string
    "Select", which is why one QA-bank match got applied to all of them at once. Fixed two
    things: (1) added `isGenericSelectPlaceholder()` and stopped trusting an element's own
    aria-label when it's just a bare "Select"/"Choose an option"/etc. verb rather than an
    informative value (BambooHR's Country button's `aria-label="Country United States"` - a
    genuinely selected value - is unaffected, verified by a dedicated regression scenario); (2)
    widened the final plain-sibling-text climb in `resolveOwnLabel` from 4 to 10 ancestor levels
    (deep enough to reach Rippling's real floating `<p>`) and added the same "stop if an ancestor
    holds more than one real control" gate `findLabelInAncestors`/`findHeadingInAncestors`
    already use, so the deeper climb doesn't run past its own field into a shared section's text.
    Verified with `test-rippling-select-label.mjs` using the real captured markup (trimmed to
    the two confirmed real questions): both now resolve to their own distinct real question text
    instead of the shared placeholder. Full 36-file regression suite re-run clean.

53. **BambooHR (Fabric) required free-text questions never reached GPT generation at all** -
    reported live: a real application (`agilityfeat-bamboohr-com-20260728T090611Z.html`) had
    several genuinely required questions ("Detail your DevOps experience with LiveKit...", "How
    much notice would you need...") all reported as needing manual input, none ever sent to GPT,
    even though they're plain non-consequential text/textarea questions that should have
    qualified. Root cause: BambooHR's own `<label for="...">` wraps its visual required-asterisk
    in `<span aria-hidden="true">*</span>` (a screen-reader-friendly pattern - a bare "*"
    shouldn't be read aloud), but `cleanedText()` (used internally by `resolveOwnLabel`'s own
    `label[for=id]` lookup) already strips anything `aria-hidden` before `isRequiredField` ever
    sees the text, so its own `/[*•✱]/` check against that already-cleaned text could never see
    the marker - every BambooHR question silently read as "not required" and got excluded from
    generation eligibility (`canGenerate`) regardless of how genuinely required and generatable
    it otherwise was. Fixed by having `isRequiredField` read the associated `<label>`'s RAW
    (un-stripped) `textContent` directly for the marker check, bypassing `cleanedText` entirely
    for this one purpose - specifically to still catch markers that are legitimately hidden from
    assistive tech but very much still real, visible required indicators for a sighted
    applicant. Verified with `test-bamboohr-required-asterisk.mjs` using the real captured
    label/asterisk markup: the LiveKit question now correctly reports `canGenerate: true`. Full
    37-file regression suite re-run clean.

54. **A real Teamtailor application (`careers.tryhackme.com`) silently filled "Which cloud
    platforms have you worked with?" with "No"** - a technology checklist, nothing to do with
    prior employment, wrongly matched to a saved answer for a genuine "Have you ever worked here
    before?" question. Root cause: `detectCategory`'s `worked_here_before` pattern
    (`/have you (ever )?(worked|been employed)\b/i`) is unanchored, so it also matches "...have
    you worked with?" as a bare substring - and `matchQaBank` treats a category match as an
    instant, unconditional win (bypassing word-overlap scoring entirely, by design, so genuine
    boilerplate reuses across differently-worded phrasing of the SAME question), so the
    unrelated "No" answer won outright regardless of topic. Fixed by excluding "worked with"
    specifically (`worked(?!\s+with\b)`) across all three duplicated copies of
    `CATEGORY_PATTERNS`/`MATCH_CATEGORY_PATTERNS` - real "worked here before" boilerplate never
    phrases itself as "worked with", that wording specifically signals collaborating with a
    tool/technology, not being employed by an entity. Verified with
    `test-worked-with-category-false-positive.mjs`: the cloud-platforms checklist now correctly
    falls through to unmatched, while a genuinely-worded "Have you ever worked at this company
    before?" question still matches via category exactly as before.

55. **The same application's rangeslider.js "years of experience" question was silently
    undetected entirely** - not even reported as unmatched, so the applicant had no way to know
    via the extension's own report that it existed. Root cause: rangeslider.js (and similar
    slider widgets) keeps the REAL, required native `<input type="range">` in the DOM but styles
    it to near-zero size (`width:1px; height:100%; opacity:0`), drawing a separate fully custom
    `.rangeslider` div as the actual visible widget - the same "real control, fake decorative
    visual on top of it" shape as select2's hidden `<select>` (already carved out), but
    `isVisible()`'s decoy-detection heuristic (`rect.width<=1`, built for Workable's plain-text
    a11y honeypots) doesn't distinguish the two and silently excluded it as if it were a decoy.
    Fixed by exempting `input[type="range"]` from that rect-size check the same way select2's
    hidden select already is (still gated on the earlier display:none/visibility:hidden/
    aria-hidden-ancestor checks, so a genuinely removed/hidden range input is still excluded).
    Also extended `isFreeText` (gates `canGenerate`) to include `type="range"` alongside the
    other plain text-like input types, since a numeric range question ("How many years of
    experience...?") is exactly as generatable as a plain text/number question, not a discrete
    option-picker like a select/combobox. Verified with `test-teamtailor-rangeslider.mjs` using
    the real captured markup: the question is now detected and correctly reports
    `canGenerate: true`. Full 39-file regression suite re-run clean.

56. **A real GR8_TECH Greenhouse application (`job-boards.eu.greenhouse.io`) wrongly filled a
    referrer-name question with the applicant's OWN name** - "Enter the full name of our
    employee who suggested this job opportunity" (explicitly described as "Only if the job
    opportunity was suggested to you by one of our employees") matched the generic
    `full\s*name` structured pattern regardless of whose name was actually being asked for -
    an actively wrong answer (implying self-referral), not just a missed field. Fixed by
    excluding referral/nomination-context labels (`referr`/`recommend`/`suggest`/`nominat`)
    from that pattern across both duplicated copies. Verified with
    `test-greenhouse-referral-city-remuneration.mjs`: the question now correctly falls through
    to unmatched instead.

57. **Same application: "Enter your current location city" was left unmatched** even though
    `profile.contact.city` was available - "city" is the field's LAST word, not the first, so
    the `^city\b`-anchored structured pattern never matched it. Broadened to also match a
    trailing "city" (`\bcity\s*$`) across both duplicated copies. Verified with the same test:
    now correctly filled from `profile.contact.city`.

58. **Same application: "Enter your remuneration expectations" was sent to GPT generation**
    instead of being blocked as consequential - "remuneration" (a genuine salary synonym) wasn't
    in `CONSEQUENTIAL_RE` at all, so an AI-invented compensation figure nearly got submitted as a
    real expectation (only failed to reach the field because the GPT reply itself came back
    malformed - see finding 59). Added "remuneration" to `CONSEQUENTIAL_RE`. Verified with the
    same test: now correctly blocked from generation (`canGenerate: false`).

59. **The same GPT-auto generation call failed with a malformed/truncated JSON reply**
    (`Expected ':' after property name...`, raw reply cut off mid-property). Root cause: the
    existing "retry if empty" loop in `submitChatGptPromptInPage` only guards against reading
    the assistant message container before React has committed ANY content - it doesn't guard
    against `isGenerating()` (the stop button disappearing) reporting "finished" a beat BEFORE a
    long reply's LAST chunk has actually committed to the DOM, so the very first non-empty read
    can still be a genuine, non-empty, mid-stream snapshot - exactly what was reported live.
    Fixed by re-reading after a short pause and requiring two consecutive reads to agree before
    trusting the text, same principle as the existing empty-retry loop but checking for
    stability instead of mere non-emptiness. Verified with a new scenario in
    `test-chatgpt-tab.mjs` (2d): a message that populates with truncated text before settling to
    the real final text now correctly returns the settled text, not the truncated snapshot. (My
    first draft of this fix's own comment broke the test file's `extractFunction` helper - it
    contained literal, unbalanced `{`/`}` characters describing the truncated JSON shape, and
    that helper naively counts braces in raw source text with no awareness of comments, so it
    ran straight past the real end of `submitChatGptPromptInPage` into the next function
    entirely. Rewrote the comment to describe the shape in words instead - a reminder that any
    comment added to a function these tests extract by brace-counting must itself stay
    brace-balanced.) Full 41-file regression suite re-run clean.

60. **GPT-auto generation (and "Generate JSON") appears to silently stall whenever the ChatGPT
    tab isn't visible on screen** (covered by another app/window), only ever completing once the
    user looks at it again - reported live, both for Auto Fill's batched answer generation and
    the separate "Generate JSON" resume flow, since both go through the same
    `runChatGptPrompt`/`submitChatGptPromptInPage` mechanism. Root cause is genuinely ambiguous
    between (a) Chrome throttling this function's OWN `setTimeout`-based polling while the tab
    is hidden (checking far less often than the nominal 200-500ms interval), or (b) ChatGPT's
    own page pausing whatever renders the stop button's removal/the answer text while hidden (a
    likely but unconfirmed hypothesis, since only (a) is fixable from extension code - a hard
    freeze in the OTHER page's own rendering can't be forced to keep running from here no matter
    what this codebase does). Added `waitForStopButtonGoneViaMutation()`, a `MutationObserver`-
    based wait that reacts to the actual DOM mutation the instant it happens, independent of any
    timer's cadence - raced ALONGSIDE (via `Promise.race`, not replacing) the existing, untouched
    `sleep()`-based poll loop for "wait for generation to finish": whichever notices first wins,
    with identical fall-through behavior (same timeout, same error) if the mutation approach
    doesn't help at all. This only fixes cause (a) - if the real bottleneck turns out to be (b),
    this change is harmless (no behavior change) but doesn't help either; this hasn't been
    confirmed live yet against an actual hidden-tab run. Verified in isolation with a new
    `test-chatgpt-mutation-fallback.mjs` (the shared global 5ms setTimeout cap in
    `test-chatgpt-tab.mjs` would mask real timing behavior, so this helper is tested separately,
    with real un-capped delays): resolves promptly when the stop button is actually removed via
    a real mutation (not by waiting out the full safety timeout), still resolves via its own
    timeout if no mutation ever comes (never hangs forever), and resolves immediately if
    generation had already finished before the wait even started. Full 42-file regression suite
    re-run clean.

61. **New `extractJobTitle()`** - the side panel had no job-title extraction or field at all
    (only Company/Job Description/Job URL) - needed for the new "Save to Portal log" feature
    (a separate internal Portal system for tracking bids, unrelated to any ATS). Added a
    `#jobTitle` field to `sidepanel.html` and extraction logic to `extractPageInfo()`, then
    checked the result against every real "Save Sample" capture collected so far (~120 files) -
    a genuinely thorough real-data sweep turned up far more failure classes than the initial
    implementation handled:
    - A heading or `<title>` that's just generic apply-flow chrome, not a job title at all -
      "Apply" (Rippling, PinpointHQ - both have no real `<h1>`, or a generic one), "Application
      Submitted" (a BreezyHR post-submit confirmation page - TWO `<h1>`s, the first generic,
      the second real), "Careers"/"Career Center" (Hibob, ADP), "Job openings" (PeopleForce).
    - Boilerplate as a PREFIX, not just the far more commonly-handled suffix - "Apply -
      Software Engineer, Retrieval" (Rippling `<title>`), "New Application | Senior Java
      Engineer (Core) | Hazelcast Careers" (PinpointHQ), "Applying for Software Engineer -
      Identity & Access Mgmt" (an ADP `<h2>` - it has no `<h1>` at all), "Candidate Profile -
      Software Engineer (Jenkins & .NET)" (iCIMS).
    - `og:title` is frequently cleaner than `<title>` on an application-FORM sub-page
      specifically (Rippling), but NOT always more reliable than a clean `<h1>` - Zoho Recruit
      and PeopleForce both order theirs "Company - Job Title" (company FIRST), which would
      silently return just the company name if trusted ahead of a good `<h1>`/`<h2>`.
    - A bare, single-word `og:title` ("SLG" - Skeeled's own brand abbreviation, nothing else)
      is more likely to be a company/brand fragment than a real title - rejected in favor of
      the fuller `<title>` tag.
    - A missing character (`,`) in the suffix-stripping regex's character class made the whole
      match silently fail on any title containing a comma (e.g. "Software Engineer (ReactJS,
      TypeScript)"), falling through to the untouched original text, dangling trailing "|"
      included.
    - `querySelectorAll("h1, h2")` returns elements in raw DOCUMENT order, not grouped by tag -
      a SuccessFactors noscript "JavaScript is turned off..." warning is an `<h2>` sitting
      BEFORE the real job-title `<h1>` in the markup, so it won by default; every `<h1>` must
      be checked (and rejected if generic) before any `<h2>` is even considered.
    - An `<h2>` fallback (needed for ADP/PeopleForce, which have no usable `<h1>`) is itself
      risky when a page has no `<h1>` at all but a clean `<title>`/`og:title` - a join.com
      posting's only `<h2>` is either a form question ("What is your expected yearly
      compensation in EUR?" - excluded via a trailing "?" check, since a job title never ends
      in one) or an apply-flow stepper label ("Upload your CV"/"Confirm your CV" - no reliable
      keyword to exclude these generically). Resolved via a structural signal instead: whether
      an `<h1>` element existed on the page AT ALL, even if it was rejected for being generic.
      A present-but-generic `<h1>` ("Job openings" - PeopleForce) signals the page structures
      its real content via headings, so its own `<h2>` is checked before `<title>`/`og:title`;
      with NO `<h1>` at all (join.com), `<title>`/`og:title` are checked first and a
      generic-content `<h2>` is only the last resort.
    - Hibob's own "apply" sub-page has no heading tag at all and no `og:title` - the real title
      only exists in a specific known class, `.job-ad-title`.
    - Three real captures had no fixable title at all, confirmed genuine (not extraction bugs):
      a Hibob capture with `fields: []` (an un-hydrated SPA shell, captured before the real
      content ever rendered), a Workday capture whose `page_url` was literally
      `.../jobTasks/completed/application` (a post-submission confirmation page with nothing
      to extract), and an Innovecs capture whose `page_url` was the generic careers homepage,
      not any specific job posting.
    Verified with 16 scenarios in `test-jobtitle-extraction.mjs`, one per real failure class
    above, plus re-ran extraction against all ~120 real captures after each fix until only the
    3 genuinely-unfixable cases remained. Full 44-file regression suite re-run clean.

62. **New "Save to Portal log" feature (piece 1 of a larger, separate project)** - a
    company-internal bid-tracking system ("Portal", an AppGini-generated app with no API and
    no CSV import - browser automation against its own web UI is the only way to interact
    with it) needs each real application recorded (platform/company/title/URL/tailor-or-not/
    resume stack). Building the live Portal-write automation directly into the live apply flow
    was judged too fragile/risky to do inline (an unfamiliar Company-autocomplete widget,
    AJAX-dependent dropdown population, etc.) - split into two pieces instead: (1) log each
    application locally now (this finding), (2) a separate end-of-day batch-push pass, built
    later once real logged data exists to test against.
    - `sidepanel.html`: new "Platform" `<select>` (the Portal's own real Site option list,
      confirmed from live captures/HTML - LINKEDIN MSG/DIRECT EMAIL deliberately excluded per
      instruction, since those aren't things a batch of jobs would share) and a "Save to Portal
      log" button, in a new `#portalLogSection`.
    - `sidepanel.js`: the Platform select is STICKY - persisted via `chrome.storage.local`
      (not the backend `/settings`, since it's a per-browser-session preference, not a
      per-person profile fact) and stays set across jobs until manually changed, since real
      usage works through batches of jobs from one source at a time. The Save button is a
      separate, explicit, manual action (does NOT fire automatically off Generate JSON/Auto
      Fill), gathers profile name + platform + company/title/url + tailor flag, and computes
      resume_stack/description per an explicit rule: tailored bid -> "Full"/"Full"; non-tailor
      bid -> the fixed resume's own already-saved `stack` field (already a free-text
      tech-stack string entered at upload time - no new tech-skill extraction needed at all)
      + " - not tailor". `loadResumesForPicker()`'s resume `<option>`s now also carry
      `dataset.stack` so this is independently retrievable from the display text.
    - `companion-service`: new `PortalLogEntry`/`PortalLogResponse` schemas and a
      `POST /portal-log` endpoint that appends one JSON line (with a server-side timestamp) to
      a NEW shared per-person/per-day file (`compute_person_day_dir()`, a new `utils.py`
      helper reusing `compute_save_dir`'s existing per-person/per-day path convention, just
      without the per-company subfolder - a whole day's applications need to land in ONE file
      for the later end-of-day batch push to read back at once). Verified end-to-end with a
      throwaway `TestClient`-based script (no existing pytest suite in this codebase to fit
      into): entry written correctly with the real server-side timestamp, a second call
      appends a new line rather than overwriting the first.
    Full 44-file JS regression suite re-run clean (extension-side changes only - the backend
    endpoint has no jsdom equivalent, verified separately as above).

63. **"Sync to Portal" (piece 2 of the Portal-log project)** - drives a real, visible tab
    against the Portal's own web UI directly (no API, no CSV import), pushing exactly ONE
    not-yet-synced log entry per click - deliberately one-at-a-time rather than the whole
    day's queue in one run (even though full-batch was the earlier stated preference,
    reconsidered once actually building it): this automation has never been confirmed against
    the live Portal, so a mistake writes into a real, shared, multi-person tracking system -
    each entry gets checked in the Portal itself (the tab is left open, not closed, showing
    the result) before the next one runs.
    - `sidepanel.js`: three new injected functions targeting the Portal's own pages -
      `fillPortalAddJobInPage` (job_jobs_add.php: Site/Company/URL/Title + an inline-added
      Offer row's Profile/Resume/Description, then Save; detects the real "already exists"
      error and reports `duplicate: true` instead of treating it as success),
      `findPortalJobIdInPage` (reads a job's id out of its own "Offers" link href on the
      search-results page), `addPortalOfferInPage` (the existing-job fallback path: same
      Offer-row filling, saved via that row's own save checkmark). Profile is matched
      fuzzily (Portal options are sometimes a bare first name - "Pawel" - against the
      profile's own full name, "Pawel Kaminski"); Resume is matched by keyword against the
      stack string, falling back to the LAST real option (never the blank "Please select")
      if nothing matches, both per explicit instruction. `runPortalSync()` orchestrates the
      whole flow (open tab -> fill -> duplicate fallback -> mark synced via
      `/portal-log/mark-synced`), reusing `runChatGptPrompt`'s own tab-lifecycle pattern
      (`waitForTabComplete`/a post-load hydration pause).
    - Login handling: `loginToPortalIfNeededInPage`, confirmed against the real login page's
      markup (a plain `#username`/`#password` pair + `#submitLogin1` - standard AppGini
      login form) - checked once after opening the tab, since the browser's own session
      cookie for the Portal can expire independently of this automation. Login always
      redirects to a fixed dashboard page regardless of where the tab was trying to go, so
      `ensureLoggedIn()` explicitly re-navigates back to the intended URL afterward rather
      than assuming login preserves the original destination.
    - New `portal_username`/`portal_password` Settings fields, plus `portal_base_url` (just
      the host/IP, e.g. `http://172.20.1.135` - "/mgr/..." paths are added in code, not typed
      by the user). None of these three are used by the CURRENT tab-based sync's login step
      for anything beyond that one expired-session fallback (the tab already inherits the
      user's own real, already-authenticated session the rest of the time) - saved now
      mainly for a planned future switch to a separate, out-of-band Playwright-driven browser
      (deferred until this tab-based version proves out live), which would have no session
      of its own and need to log in itself every run. Moved into their own new "Portal" tab
      in `options.html`/`options.js` (own badge/dirty-tracking/save button), not folded into
      the existing "Generation" section, per explicit instruction.
    - Considered and explicitly deferred: driving a completely separate, out-of-band
      Playwright browser instead of a tab in the user's own browser - would avoid ever taking
      over a tab the user is actively looking at, but needs its own persisted login session
      (no existing cookies to inherit) and a new pip dependency; revisit once this simpler,
      same-browser version is confirmed working live.
    Verified with 9 new scenarios in `test-portal-sync.mjs` against the exact real HTML
    captured/pasted live throughout this feature's design (the real login form, the real
    Add-Job form's Site/Company/URL/Title + Inline-Add-revealed Offer row including the
    AJAX-populated Resume dropdown, the real "already exists" duplicate error, the real
    search-results row's Offers-link href, the real standalone Offers-list page's Inline Add
    + row-level save). The Company-autocomplete popup's exact live DOM shape (typing a name,
    clicking a suggestion vs. "Add new") could not be verified this way - no real capture of
    that popup while open exists yet - so that specific piece remains an unconfirmed
    first-draft guess, same caveat as the rest of this genuinely new, untested-live
    automation. Full 45-file regression suite re-run clean.

64. **First live "Sync to Portal" run wrote the wrong Description for a tailored bid** -
    confirmed working end to end (the row was added correctly), but Description showed "Full"
    where real, pre-existing Portal rows use the literal word "Tailor" instead - the specific
    stack already shows separately via the Resume column's own "[Full]"/"[Java]" bracket, so
    Description is meant to mark the bid TYPE only, not repeat the stack name. Fixed: tailor
    mode's Description is now the literal "Tailor" (Resume dropdown selection stays "Full",
    unaffected - confirmed correct as-is, a real tailored-bid row in the same live data used a
    non-"Full" resume stack ("Java"), but explicitly decided NOT to add tech-skill-based
    resume matching to tailor mode for that reason - "Full" stays the fixed choice there).
    Full 45-file regression suite re-run clean (no dedicated new test - this is a one-line
    literal-string change already covered structurally by the existing portal-sync tests).

65. **Fixed a real bug found live: "Sync to Portal" skipped an existing already-added Offer row
    unnecessarily** on the existing-job fallback path - `addPortalOfferInPage` now scans the
    EXISTING (already-saved) rows for one matching this profile + today's date BEFORE clicking
    "Inline Add" at all; if one already matches, it's treated as already-synced and no duplicate
    row is added. This is a stronger, live-Portal-based source of truth than this codebase's own
    local per-day log file's `synced` flag, which could in principle drift out of sync with
    reality (e.g. a network hiccup between a successful Portal save and the follow-up call that
    marks it synced locally) - confirmed preference: check the Portal itself, not just a local
    flag. Also fixed: on the "Jobs, Add new" page specifically (unlike the existing-job Offers
    page), a real, editable Offer row is already present by default - confirmed live, clicking
    "Inline Add" there reveals a SECOND, unwanted row instead of the one already there;
    `fillPortalAddJobInPage` no longer clicks it at all, relying on `fillOfferRow`'s own polling
    to find the already-present row directly.

66. **Redesigned "Sync to Portal" to act on whatever's currently in the side panel, not a queue
    read from the log** - confirmed preference: syncing means "push the job I'm looking at right
    now", not "whichever entry happens to be oldest in today's log file" (those aren't always the
    same job, e.g. several jobs logged earlier today before coming back to sync just the one
    currently open). `runPortalSync()` no longer calls `GET /portal-log` to pick an entry at all -
    it builds the entry fresh from the panel's own fields via a new shared
    `buildPortalLogEntryFromPanel()` helper (factored out of "Save to Portal log"'s own handler,
    used by both now), pushes it live, and on success writes it to today's log AS ALREADY SYNCED
    (a fresh `POST /portal-log` + `POST /portal-log/mark-synced` using the write response's own
    new `index` field, added specifically so this doesn't need a separate GET round trip first) -
    so today's log still ends up a complete record of every application actually pushed, without
    ever having decided WHICH one to push by reading that same file back. Also: the tab now
    closes automatically after a successful sync (confirmed preference - previously left open
    always), staying open only on failure so there's still something to inspect. Verified the
    new `index` field with a direct backend round-trip: two entries get indices 0 and 1
    respectively, and the second can be immediately marked synced using its own just-returned
    index with no prior GET at all. Full 45-file JS regression suite re-run clean (the portal-
    sync tests target the injected page-automation functions directly, unaffected by this
    orchestration-level change).

67. **Two more real bugs found from the first live end-to-end "Sync to Portal" runs:**
    - **Tab didn't close despite a visible Portal success** - the tab-close (added in finding
      66) was gated on this codebase's OWN log-write/mark-synced calls succeeding, positioned
      AFTER them; a companion-service hiccup in THAT unrelated bookkeeping step threw and
      skipped straight to the outer error handler, leaving the tab open even though the actual
      Portal push had already gone through fine (a real new row was visible in the Portal).
      Reordered: the tab now closes and the success message is shown based on the PORTAL PUSH
      alone; the log-write/mark-synced calls run afterward as a best-effort step (a failure
      there appends a warning to the message instead of overwriting a real success with
      "Sync failed").
    - **A duplicate Offer row got added for the same profile on the same day** - the existing-
      row dedup check (finding 66) ran once, immediately after navigating to the Offers page,
      and requiring the row count to merely repeat across 2 checks in a row to conclude "no
      match" - but "zero rows, then zero rows again 300ms later" looks identical whether the
      grid has genuinely finished with none, or its own AJAX response for populating rows
      simply hadn't landed within that one interval yet. Widened to require the count to stay
      unchanged across at least 3 consecutive checks (not 2) before trusting a "no match"
      result - a synthetic test using a row that only appears ~400ms late (simulating exactly
      this AJAX-timing gap) caught the original 2-check version failing immediately.
    Verified with 2 new scenarios in `test-portal-sync.mjs`: a same-profile/same-day row that
    only appears after a short delay is still correctly caught (no duplicate added), and a
    genuinely-empty grid still settles quickly (well under the timeout) rather than always
    waiting out the full budget.

68. **Company-autocomplete widget fully wired up using real captured markup of both its states**
    (a live suggestion popup, and the real "has-error" state when nothing matches) - the one
    piece explicitly flagged as an unconfirmed first-draft guess since this automation's initial
    build. Confirmed live: it's a real ajax-suggest widget, NOT the always-present-but-hidden
    "shiny_box" hint container (a different, unrelated element) - a genuinely new popup/list
    appears elsewhere in the DOM once a match exists; when nothing matches, blurring the field
    adds a real "has-error" class to the field's own wrapper (the "Company" label visibly turns
    red). Rewrote the suggestion-finding logic to use the same before/after-visibility snapshot
    technique `fillReactSelectByClick` already uses for react-select menus (conceptually the
    same "a hidden popup becomes visible after user input" shape) instead of the original naive
    "any div/li whose text matches" scan, which had no way to distinguish a genuinely new
    suggestion from unrelated pre-existing page text. For the no-match case, now explicitly
    blurs the field (triggering the real page's own validation) before clicking "Add new",
    rather than clicking it unconditionally the instant no suggestion appeared. Verified with 2
    new scenarios in `test-portal-sync.mjs` built from the real markup shared live: a suggestion
    that appears after typing (not the pre-existing hidden hint box) is found and clicked, and a
    genuinely new company blurs the field and clicks "Add new" instead. Full 47-file regression
    suite re-run clean. Still not confirmed: what happens immediately AFTER clicking "Add new"
    on the real live page (whether it opens a modal/sub-form requiring further input to actually
    create and link the new company, which this codebase's own code does not yet handle at all)
    - this needs a live test to find out.

69. **The real root cause of the duplicate-check bug, found by re-reading already-captured real
    markup instead of guessing again** - both prior fix attempts (findings 65/67) were chasing an
    AJAX-timing theory, but the actual bug was much simpler and had been there since finding 66's
    original implementation: `data-record-id` lives on the CHILD `<td>` elements, never on the
    `<tr>` itself (confirmed against real markup already captured earlier in this project:
    `<tr class="bs-gridrow" id="gridRow4"><td ... data-record-id="4">...`) - the selector
    `tr.bs-gridrow[data-record-id]` could never match ANY row at all, meaning the dedup check
    always silently found zero existing rows regardless of what was actually in the Portal, no
    matter how the polling/timing logic around it was tuned. Fixed by dropping the nonexistent
    tr-level attribute requirement entirely and excluding the hidden "gridRowAdd" template row by
    its own class instead (`tr.bs-gridrow:not(.gridRowAdd)` - real already-saved rows carry only
    "bs-gridrow", the never-clicked Inline Add placeholder carries both). **My own test fixtures
    had made the exact same mistake** (putting `data-record-id` on the `<tr>` in the synthetic
    HTML), so all of them passed against the broken selector too and never caught this - fixed
    all the fixtures to match the real markup shape, then confirmed by temporarily reverting the
    selector fix alone and re-running: the corrected fixtures now fail loudly against the old
    selector, then pass again once reverted back to the fix, actually proving the tests are
    meaningful this time rather than just passing coincidentally either way. Also added a
    TEMPORARY step-by-step `debug` trail (returned from both `fillPortalAddJobInPage` and
    `addPortalOfferInPage`, surfaced directly in the side panel's own status text via a new
    `white-space: pre-wrap` rule on `#portalSyncResult`) so the next live run's exact behavior -
    company suggestion found or not, Add new clicked or not, existing rows found before the
    dedup check, duplicate error text if any - is readable directly without needing DevTools
    open at all; remove once the Company-autocomplete piece is also confirmed working live.
    Full 47-file regression suite re-run clean.

70. **A real live run confirmed the duplicate-check fix (finding 69) worked. Company-adding was
    still broken, and the debug trail itself pointed to a bigger structural bug**: a real attempt
    came back "Failed: ... unknown error" with NO debug text at all - which can only happen if
    the whole result object was lost, not just an error message being empty. Separately reported
    live: after clicking "Add new" for a genuinely new company, the WHOLE TAB closed almost
    immediately ("so fast" - not even a modal visibly appearing first). Both point to the same
    root cause: `fillPortalAddJobInPage` returned "ok: true" the instant it finished clicking
    through the form (including Save), and the orchestrator treated ANY "ok: true" as "fully
    done, safe to close the tab" - immediately - before Save's own real server-side processing
    (or "Add new"'s own modal/AJAX, if any) ever had a chance to finish. If clicking Save
    actually triggers a genuine page navigation (not just an in-page AJAX update), that would
    also destroy the injected script's own execution context mid-run, before it could return
    anything at all - matching the "unknown error, no debug" symptom exactly.
    - Split `fillPortalAddJobInPage` into two phases: it now only fills the form and clicks
      Save, returning immediately (`{ok: true, saveClicked: true, debug}`) without waiting or
      checking anything about what happens next. A new, SEPARATE `checkPortalAddJobResultInPage`
      runs afterward, once `runPortalSync` has properly waited out any navigation
      (`waitForTabComplete` + an extra pause) - checking for the real duplicate-error state
      without needing the same execution context that clicked Save to still be alive.
    - The "Add new" branch now captures whatever NEWLY-visible element appears after clicking it
      (same before/after-visibility technique as the suggestion-finding logic), logging its tag
      and outerHTML to the debug trail - still don't have real markup for what "Add new"
      actually opens, so this is real diagnostic instrumentation for the next live attempt, not
      a confirmed fix for that specific path yet.
    - A real debug trail from a live existing-company run showed the suggestion WAS found (a
      DIV) and clicked, yet the company still ended up empty - meaning the click didn't actually
      populate the real hidden value, or the wrong element was matched. Added debug logging of
      the clicked element's own outerHTML plus the hidden value immediately after clicking, so
      the next attempt shows definitively which element is being clicked and whether it worked.
    - Debug-merging bug fixed along the way: the accumulated fill-phase debug (Company/Site
      info) was only being preserved in the duplicate-URL branch, silently dropped on the plain
      success/failure paths - now merged in unconditionally right after the outcome is known,
      regardless of which path it takes.
    Verified with 2 replacement scenarios in `test-portal-sync.mjs` (the old duplicate-detection
    scenario for `fillPortalAddJobInPage` no longer applies now that responsibility moved to
    `checkPortalAddJobResultInPage`, tested separately). Full 47-file regression suite re-run
    clean. Still an open live question: whether "Add new" opens a modal/sub-form needing further
    input (unconfirmed), and why the existing-company suggestion click isn't actually linking
    the real hidden value despite finding and clicking something.

71. **The two open questions from finding 70 were both answered by a real live run with the new
    debug logging, and both diagnoses were confirmed root causes**:
    - Existing company (LTG): the suggestion was found and clicked, but the hidden company id
      stayed empty while the display field showed "Ltg" (the typed text, not "LTG" - the
      correctly-cased text from the suggestion). This is the exact same quirk already documented
      elsewhere in this file for react-select's own menu (`fillReactSelectByClick`): **the
      Portal's real ajax-suggest widget binds its selection handler to `mousedown`, not `click`**
      (the standard trick autocomplete widgets use to fire before the field's own `blur` hides
      the suggestion list) - a plain `.click()` only ever dispatches a "click" event, which that
      handler never sees. Fixed by adding a `fireClick()` helper that dispatches a full
      `mousedown`/`mouseup`/`click` sequence, matching a real user's click, and using it for both
      the suggestion click and (see below) the "Add new" link/modal-save click.
    - New company: clicking "Add new" opens a real Bootstrap modal ("Companies, Add new") with
      its own, completely separate Company Name input and Save button - real markup captured
      live: `input[id="value_company_name_10"]` / `button[id="saveButton10"]` inside a
      `.modal-content` (the `10` is a dynamic AppGini page id, not a fixed constant). The old
      code clicked "Add new" and then went straight on to click the MAIN form's own `#saveButton1`
      without ever touching that modal - saving the job with the company still empty, matching
      exactly what was reported ("it open the add new button and show the add new modal but
      didn't write in the input and saved it then save the whole add job"). Fixed by polling for
      `input[id^="value_company_name_"]` after clicking "Add new", filling it, then finding its
      Save button via `.closest(".modal-content")` + `button[id^="saveButton"]` (generic prefix
      match, not the fixed `10`) and clicking that instead, then waiting for `.modal-backdrop` to
      disappear before moving on.
    Verified with a new scenario proving a `mousedown`-only handler (not `click`) still gets
    triggered and populates the hidden field, one extending the existing "genuinely new company"
    scenario to simulate the real modal (asserting the modal's OWN input gets filled and its OWN
    Save button gets clicked, not the main form's), and the pre-existing suggestion-click scenario
    re-verified passing unchanged (a real `click` listener still fires as part of the sequence).
    One test-harness-only bug caught along the way: the test file didn't expose `MouseEvent` as a
    global (only `Event`), so the fix's own test initially failed with "MouseEvent is not defined"
    - not a production bug, since real browser tabs always have it, but fixed in the harness
    (`test-portal-sync.mjs`'s `setupDom`) for the test to actually exercise the real code path.
    Full regression suite re-run clean. **Confirmed working live** - a real "Sync to Portal" run
    reported success for both paths, closing out this whole Portal-integration debugging arc.
    The TEMPORARY `debug` trail (in `fillPortalAddJobInPage`, `addPortalOfferInPage`,
    `checkPortalAddJobResultInPage`, the orchestrator's debug-merging/appending logic, and the
    `white-space: pre-wrap` CSS rule on `#portalSyncResult`) has been removed now that it did its
    job - all findings above (69, 70, 71) remain the record of what it found and why each fix was
    made.

76b. **`portal_automation.HEADLESS` flipped to `True`** - the Playwright rebuild (finding 72) was
    deliberately left headed so the first live runs could be watched directly; confirmed working
    properly by the user, now switched to run invisibly, the whole reason for moving off
    chrome.tabs in the first place. `chatgpt_automation.HEADLESS` (the separate, experimental
    "gpt-auto-headless" option, finding 74) stays headed for now - that one is still blocked at
    sign-in (Cloudflare/Google), unconfirmed, and explicitly left alone per instruction.

72. **Portal sync rebuilt on Playwright, out-of-band from the user's own browser entirely -
    fixes the "hidden tabs" complaint (the chrome.tabs-based version briefly opened/closed a
    real, visible tab in the user's own browser on every sync) and merges "Save to Portal log"
    + "Sync to Portal" back into ONE button/action**, now that live sync is confirmed reliable
    (finding 71) and the two-button split's original reason (safety during a still-flaky build)
    no longer applies.
    - New `companion-service/app/portal_automation.py` (Playwright, async) replaces ALL of the
      old chrome.scripting-injected functions (`fillPortalAddJobInPage`,
      `checkPortalAddJobResultInPage`, `loginToPortalIfNeededInPage`, `findPortalJobIdInPage`,
      `addPortalOfferInPage`, plus the orchestrator's `waitForTabComplete`/`navigateAndWait`/
      `ensureLoggedIn` - all deleted from `sidepanel.js`) with the equivalent logic ported to
      Playwright's own Page/Locator API: `_ensure_logged_in`, `_fill_add_job`, `_fill_company`,
      `_fill_offer_row`, `_select_option_by_fuzzy_name`, `_select_resume_by_stack`,
      `_handle_existing_job`, `_find_existing_offer_row`. Runs via a real, persistent, HEADLESS
      Chromium (`launch_persistent_context`, profile dir `portal_automation.BROWSER_PROFILE_DIR`,
      excluded from `sync.sh`) - its own login session survives across companion-service
      restarts, logging itself in via the Settings credentials only when that session has
      actually expired. New `POST /portal-sync` endpoint in `main.py` runs it server-side.
    - **The mousedown-vs-click quirk (finding 71) needed NO workaround here at all** - Playwright's
      `.click()` is a real, OS-level trusted input event (mousedown+mouseup+click), unlike a
      synthetic DOM `element.click()`, which is exactly why the old JS version needed the manual
      `fireClick()` 3-event-dispatch hack in the first place. Confirmed with an ad hoc check (a
      suggestion handler bound to `mousedown` only) - Playwright's plain click reached it with no
      extra code needed.
    - The extension's `#portalLogBtn` ("Save & Sync to Portal" - renamed) now does both steps in
      one click: `POST /portal-log` (writes today's local record), then `POST /portal-sync`
      (pushes it live via the above), then `POST /portal-log/mark-synced` on success. `#portalSyncBtn`
      and its whole result/status-line pair were removed from `sidepanel.html`.
    - Per explicit instruction, no automated test file was written for `portal_automation.py`
      (going forward, this project's own manual live testing replaces writing test cases) - it
      was instead exercised with a handful of throwaway, unsaved smoke checks during development
      (route-interception-based fake Portal pages covering login+redirect, the mousedown-bound
      suggestion click, the new-company modal fill, duplicate detection, and the existing-job
      dedup/Inline-Add fallback) - all passed, but nothing from these checks was kept as a
      committed test asset.
    - `requirements.txt` gained `playwright==1.61.0`; `setup.bat` now also runs
      `playwright install chromium` after `pip install`.

73. **Reported live, first real attempt at the new Playwright sync: the headed browser window
    opened the login page but never typed anything into username/password.** Root cause found
    by reading the code, not guessing: `buildSettingsPayload()` in `options.js` never included
    `portal_username`/`portal_password` at all. Since `PUT /settings` replaces the WHOLE settings
    object (not a partial patch - `store.save_settings` just overwrites `settings.json` with
    whatever `Settings` object FastAPI parsed from the body, and missing fields fall back to
    their Pydantic default of `""`), **every settings save from EITHER tab silently wiped both
    fields back to empty strings immediately afterward** - including right after typing them in
    and clicking "Save Portal settings" itself, which is exactly why the user's second question
    ("where is portal username/password saving?") led here: they WERE being saved to
    `~/.job-apply-project/data/settings.json`, then immediately blanked again by that same save
    call. This one bug fully explains both reported symptoms at once (blank login fields live,
    and "settings saving isn't working"). Fixed by adding both fields to `buildSettingsPayload()`.
    Re-save Portal settings once after pulling this fix - anything saved before it is gone.

74. **A Playwright rebuild of "gpt-auto" (same out-of-band pattern as Portal, finding 72) was
    tried and confirmed BLOCKED live - kept as a distinct, separate 5th provider option
    ("gpt-auto-headless") instead of replacing the working tab-based one.** Reported live on the
    very first real attempt: Cloudflare's own bot-detection showed a "Just a moment..." challenge
    screen instead of the real chatgpt.com page, and separately, signing in via Google refused
    with "Couldn't sign you in - this browser or app may not be secure" (Google's own OAuth
    anti-automation protection). Two different companies, two separate real, deliberate
    anti-automation layers - not bugs to route around. Per explicit instruction, no attempt was
    made to defeat this with browser-fingerprint-spoofing/stealth techniques (an unreliable arms
    race, and a step into circumventing another company's real anti-automation protections on
    their own product - a meaningfully different situation from the Portal, an internal tool with
    no such protections at all).
    - `providerSelect`/`answerProviderSelect` in `sidepanel.html` gained a genuinely separate 5th
      option, `gpt-auto-headless` ("GPT (auto, headless - experimental)"), alongside the restored,
      working `gpt-auto` ("GPT (auto via ChatGPT tab)"). `runChatGptPrompt` (chrome.tabs-based,
      reuses the user's OWN real, already-logged-in browser session/fingerprint - the reason it
      isn't blocked the way the automated one is) is back to its original form; a new, separate
      `runChatGptPromptHeadless` calls the Playwright path. Every call site
      (`generateBtn`/batched-answer-generation) branches on which of the two values is selected.
    - New `companion-service/app/chatgpt_automation.py` (Playwright, async) + new
      `POST /chatgpt-prompt` endpoint + `companion-service/login_chatgpt.py`/`.bat` (a one-time,
      manual, headed login step - `input()`-gated so it waits for a keypress before closing;
      never attempts any login itself, on purpose, given the above) all kept in the codebase, not
      deleted, in case a way through Cloudflare/Google's blocks ever presents itself - just not
      anyone's default, and clearly marked experimental in the UI (`options.html`'s
      `gptAutoHeadlessHint`, shown only when that specific option is selected).
    - Ported the same composer-fill/send/wait-for-response/reconstruct-markdown/delete-
      conversation flow to Playwright's Page/Locator API - `insert_text` for the composer (a
      real, trusted paste-equivalent) instead of the old per-line `<p>` DOM construction, and
      `locator.wait_for(state="detached")` (real browser DOM-change events) instead of a manual
      setTimeout poll for waiting out generation.
    - **Real bug caught by an ad hoc (unsaved) smoke check before ever reaching real chatgpt.com**:
      the send-button poll called `_find_first(page, SEND_BUTTON_SELECTORS, timeout_ms=1)`
      intending "check once, immediately" - but `_find_first`'s loop count is `timeout_ms // 200`,
      and `1 // 200 == 0`, so it always returned `None` without checking a single selector. Fixed
      by splitting out a `_find_now()` helper (checks once, no internal wait) for this and the
      options-button lookup, keeping `_find_first`'s own poll only for the composer search (which
      genuinely needs a real timeout budget).
    - Per explicit instruction, no automated test file was written or saved for either the
      Playwright build or the revert - verified with throwaway, unsaved route-interception smoke
      checks only (a fake composer/send/stop-button/assistant-message page, and a separate
      not-logged-in case), which is what caught the bug above. Nothing from these checks was kept
      as a committed test asset.

75. **Reported live on the restored tab-based "gpt-auto" (not the headless one): a resume-JSON
    generation attempt came back with a genuinely truncated reply** (`Unexpected end of JSON
    input`, raw text cut off mid-word inside the `summary` field) - first suspected to be a
    transcription bug from restoring `submitChatGptPromptInPage` by hand (finding 74's revert),
    but a careful line-by-line re-check against the original found it byte-identical - not a
    restoration bug. The real gap: the existing "two consecutive equal reads = stable" check
    (already in the code, predating this whole Playwright detour) can't actually distinguish
    "genuinely finished" from "frozen mid-stream because the tab lost real OS focus and got
    throttled" - both produce identical repeated reads. Two fixes, addressing both the likely
    cause and the detection gap:
    - `runChatGptPrompt` now also explicitly calls `chrome.windows.update(tab.windowId, {
      focused: true })` right after creating the tab (best-effort, never blocks generation if it
      fails) - `chrome.tabs.create({active: true})` alone only makes it the active TAB within its
      OWN window, not necessarily bringing that WINDOW to real OS-level foreground if the side
      panel's own window (or anything else) currently has focus - a very plausible real trigger
      for exactly this kind of stall.
    - `submitChatGptPromptInPage`'s stability loop now ALSO requires the settled text to actually
      parse as JSON (via new `looksLikeCompleteJson()`) before trusting it - not just "unchanged
      since last read." A stable-but-invalid read now keeps polling, with longer pauses in the
      back half (300ms -> 600ms, 20 attempts total, up from 10 at a flat 300ms) to give a
      previously-throttled tab real time to catch up now that its window has been refocused.
      Falls back to returning whatever text settled if it still never parses, same as before -
      no regression for a genuinely non-JSON reply (shouldn't happen for this codebase's prompts,
      but stays a safe fallback rather than hanging forever).
    Confirmed live afterward: switching away from the ChatGPT tab mid-generation (to another tab
    or another app entirely) does stall it until switching back - directly validating the root
    cause above. The one-time window-focus call only covers the moment generation starts, not
    the whole ~couple-minute wait that follows, so `runChatGptPrompt` now also nudges the tab
    back to "active within its own window" every 3 seconds for as long as generation is running
    (`chrome.tabs.update(tab.id, {active: true})` in a `setInterval`, cleared once the awaited
    call settles).
    - **Still confirmed truncated afterward, specifically when switching to a DIFFERENT
      APPLICATION (not just another Chrome tab)**: the explicit, stated requirement is being
      able to do something else entirely (another tab OR another app) while generation runs in
      the background, unattended - `chrome.tabs.update`/`chrome.windows.update` only control
      which tab/window CHROME itself considers front-most, which can't prevent Chrome from
      throttling a window that isn't genuinely on screen at all (a real OS-level app switch).
      Real fix: `chrome.debugger` (Chrome DevTools Protocol) - the same mechanism
      `background.js`'s `TRUSTED_CLICK` handler already relies on for genuinely trusted clicks -
      can tell Chrome to keep a specific page in its "active" lifecycle state and emulate
      permanent focus regardless of what's actually on screen. `runChatGptPrompt` now attaches
      to the ChatGPT tab for the duration of generation and sends `Page.setWebLifecycleState({
      state: "active"})` + `Emulation.setFocusEmulationEnabled({enabled: true})`, detaching once
      generation finishes (real, unavoidable cost: Chrome's own "this extension started
      debugging this browser" banner shows on that tab the whole time, same tradeoff already
      accepted for `TRUSTED_CLICK`). Both commands are wrapped in their own try/catch and the
      whole attach is best-effort - if the debugger fails to attach (DevTools already open on
      that tab, etc.) or either command isn't supported, generation still proceeds using only
      the existing tab/window-focus mitigations, just without this extra protection.
    - **Not yet confirmed live** - these two specific CDP method names/behaviors couldn't be
      verified from here (no real Chrome browser available in this environment to test
      chrome.debugger against). Needs a real test: start a generation, immediately switch to a
      completely different application (not just another tab) for the whole duration, and check
      whether the resulting JSON comes back complete.
    - **Reported live: the periodic `chrome.tabs.update({active:true})` nudge (added earlier in
      this same finding) visibly yanked the user BACK to the ChatGPT tab every few seconds even
      after deliberately switching to another one - worse than the stall it was meant to fix.**
      Removed entirely. The chrome.debugger-based fix above is the mechanism actually meant to
      let generation finish correctly without ever needing to be the visible/active tab - if it
      turns out insufficient on its own, the right next step is strengthening THAT, not forcibly
      stealing the tab back.
    - **Reported live: running several "Generate JSON" tabs at once (each browser tab has its own
      independent side panel, confirmed - see `makeSidePanelPerTab` in `background.js`), the 5th
      concurrent one got stuck on "Opening ChatGPT tab..." indefinitely, only unsticking once ALL
      4 of the others finished and their tabs closed.** Root cause: `chrome.debugger.attach()`
      can BLOCK INDEFINITELY (neither resolving nor rejecting) once Chrome's own limit on
      simultaneous debugger sessions per extension is reached, rather than erroring out - the
      5th call was simply queued, waiting for a session slot that only freed up once another
      generation's `finally` block detached its own session. Not a side-panel-sharing bug (a
      real, reasonable suspicion at the time, given the symptom) - fully explained by this alone.
      Fixed by racing the attach call against a 4-second timeout: if a session isn't granted
      quickly, that generation proceeds without the debugger-based throttling protection
      (falling back to the tab/window-focus mitigations already in place), rather than hanging.
      If the attach DOES eventually resolve after the timeout already gave up on it, it's
      immediately detached again rather than left attached and silently consuming a session
      slot until that tab happens to close.
    - **Reported live: the 4-second-timeout fix did NOT resolve it - still got stuck on "Opening
      ChatGPT tab and generating..." under conditions that no longer matched the debugger-
      session-limit theory (as few as one other tab running, not specifically a 5th).** Rather
      than guess a third fix blind, `runChatGptPrompt` gained a TEMPORARY `onProgress` callback,
      notifying at every major awaited step (tab created, debugger step done, tab finished
      loading, executeScript starting/returning) - wired into both call sites
      (`generateBtn`/batched-answer-generation) to append each step with a timestamp directly to
      the visible status text, so the next live report shows exactly which awaited call is
      actually stuck, instead of another guess. `#generateResult`/`#autofillResult` gained a
      temporary `white-space: pre-wrap` CSS rule so the trail's line breaks actually render.
      Remove both (the `onProgress` plumbing and the CSS rule) once the real bottleneck is
      confirmed live and fixed - same pattern already used successfully for the Portal-sync
      debugging (findings 69-71).
    - Follow-up live reports resolved two separate things without needing the progress trail at
      all: the "stuck at executeScript" report turned out to be checked only ~2-3 seconds in -
      nowhere near enough time to reach any further checkpoint (tab load alone typically takes
      20-30+ seconds before generation even starts) - not a bug. The "generated but nothing saved
      to the field, no message at all" report remains open and unexplained - a real possibility
      worth checking next time it happens: the ORIGINATING job tab (not the ChatGPT automation
      tab) getting discarded/reloaded by Chrome under memory pressure from running several heavy
      chatgpt.com tabs at once would silently wipe out its own side panel's in-flight JS state
      with no error to show, matching the symptom exactly - `autoDiscardable: false` has only
      ever been applied to the ChatGPT automation tab, never to the tab actually hosting the side
      panel that's awaiting it.
    - Explicitly requested: the ChatGPT automation tab is now created backgrounded
      (`chrome.tabs.create({..., active: false})`, was `active: true`) so it stops interrupting
      whatever tab/app the user is actually using - the one-time `chrome.windows.update(...,
      {focused: true})` call (added earlier in this same finding) was removed entirely for the
      same reason, since forcing window focus would have undone exactly that. The
      chrome.debugger-based fix is what's now solely relied on to keep generation reliable
      despite genuinely never being the visible/active tab.

76. **Keyboard shortcuts added for every button in the side panel** - explicitly requested "all
    buttons should have a key," all global (fire from anywhere, including the actual job page
    itself, not just while the side panel has focus), all 2-key combos (`Alt+<letter>`, not
    `Ctrl+Shift+<letter>` - explicitly requested "I don't want 3 keyword clicking").
    - `manifest.json` gained a `"commands"` section with all 10 named commands. Chrome only
      auto-applies a `suggested_key` default for the first 4 declared (`auto-fill` = Alt+F,
      `generate-json` = Alt+G, `extract-from-page` = Alt+E, `learn-page` = Alt+L) - the
      remaining 6 (`generate-pdf`, `save-sample`, `attach-resume`, `portal-sync`,
      `open-settings`, `refresh-panel`) have no `suggested_key` at all (not a bug - Chrome
      simply doesn't support auto-assigning more than 4), so each `description` string includes
      its own suggested key (e.g. "Generate PDF - suggest Alt+P in chrome://extensions/shortcuts")
      as a hint for the one-time manual binding step every user needs to do for those 6, on
      `chrome://extensions/shortcuts`.
    - Real architectural problem solved: `chrome.commands.onCommand` fires in the background
      service worker, which has no direct handle on any specific tab's own side panel document -
      and `chrome.runtime.sendMessage` broadcasts to EVERY open extension context, including
      OTHER tabs' own side panel instances, which stay alive/running in the background
      simultaneously (confirmed live - concurrent GPT generations across several tabs kept
      running after switching away from them, finding 75). Naively relaying a shortcut this way
      would fire it in every open tab's panel at once, not just the one the user is actually
      looking at. Fixed with a "know my own tab" pattern: each side panel instance captures
      `chrome.tabs.query({active:true, currentWindow:true})`'s result ONCE at load time into
      `myTabId` - reliable because a per-tab panel document only ever loads/becomes active
      exactly when its OWN tab becomes the active one, unlike re-querying "the active tab" later
      (which would give the wrong answer once the user switches tabs). `background.js`'s
      `chrome.commands.onCommand` listener includes the CURRENTLY active tab's id in the
      broadcast message; each panel's own listener (`sidepanel.js`) ignores anything where
      `message.tabId !== myTabId`, so only the correct tab's own panel ever acts on it.
    - "Generate JSON" and "Copy prompt for GPT" share one shortcut (`generate-json`, Alt+G) -
      only one of the two is ever visible at a time (the existing `isManualGpt` toggle in
      `applyTailorMode`), so the listener fires whichever one currently is.

77. **Three real bugs found from two real captures, reported live as "Attach Resume to Form"/
    "country selection" not working - all confirmed against real markup, no guessing.**
    - **ats.rippling.com's own Resume input is real markup `type="File"` (capital F)**, not
      lowercase - `input[type="file"]` is a CSS ATTRIBUTE selector, which matches the literal
      attribute VALUE case-sensitively (unlike the browser's own normalized `.type` IDL
      property, which always reflects lowercase regardless of source casing) - so
      `attachResumeFileInPage`'s `collectFileInputs` silently missed a real, working file input
      entirely. Fixed by filtering plain `<input>` elements by the normalized `.type` property
      instead of a CSS attribute-value selector, which sidesteps this whole class of bug.
    - **jumo-careers-hibob-com's own upload widget (`<careers-ui-upload-document-control>`, an
      Angular custom element with a preceding `.label` div and a plain `<button>Add file</button>`
      trigger) renders NO `<input type="file">` anywhere in the page at all until that button is
      clicked** - same "nothing to find on a first pass" shape SAP SuccessFactors' own widget
      already needed `revealSuccessFactorsAttachmentInputs` for (a fix made earlier this same
      session), just a completely different framework/markup. New `revealHibobAttachmentInputs`
      in `attachResumeFileInPage`, using the same RESUME_RE/EXCLUDE_RE label-matching, clicks the
      button and polls GLOBALLY (not just within the widget's own subtree, since it isn't
      confirmed where Angular actually inserts the real input once created) for a new file input
      to appear.
    - **HiBob's own "Country" field is a plain `<div role="button" aria-haspopup="true"
      aria-expanded="false">`, NOT a real `<button>` tag** - `field-detector.js`'s own field-
      collection selector already handled BambooHR's real `<button aria-haspopup="true">`
      Country field (a prior finding), but was tag-restricted to `button[aria-haspopup="true"]`,
      so this div-based version was invisible to detection entirely - reported live as "country
      selection is not working," which was actually this field never being found or reported at
      all (same class of bug as the BambooHR case, just a styled `<div>` instead of a real
      `<button>`). Fixed by adding `[role="button"][aria-haspopup="true"]` to the collection
      selector - deliberately kept paired with the SAME `aria-haspopup="true"` qualifier already
      trusted for the `<button>` case, not matching any bare `[role="button"]`, for the identical
      false-positive reasons already documented there (phone country-code pickers, generic icon
      buttons, "import your resume" banners). No filling-logic changes needed at all -
      `looksLikeComboboxPick` already classifies anything with `aria-expanded` (which this
      element already has) as a combobox needing click-and-select handling, and
      `fillReactSelectByClick`'s existing generic ARIA (`role="listbox"`/`role="option"`)
      fallback doesn't depend on react-select's own classNamePrefix convention at all - once
      collected, it should already work.
    - Per explicit instruction, no automated test file was written for any of these three.

78. **Real, potentially serious bug: in non-tailor mode, manually picking a different resume in
    the dropdown could get silently reverted back to the auto-suggested one before "Attach
    Resume to Form" was clicked - meaning the WRONG resume file could be attached/submitted with
    no indication anything had changed.** Root cause: `loadResumesForPicker()` rebuilds the whole
    `<select>` from scratch and re-applies the job-description-based suggestion every time it
    runs - and it runs on EVERY window "focus"/document "visibilitychange" event (via
    `applyTailorMode`'s own callers), not just once on initial load. Simply switching away to
    look at the actual job page and back was enough to silently wipe out a manual pick. Fixed by
    capturing whatever resume id was already selected before rebuilding the options, and
    re-selecting that same one afterward if it still exists in the reloaded list - only actually
    falls back to computing a fresh suggestion when nothing was selected before, or that resume
    no longer exists (e.g. deleted in Settings). Any stale "Suggested based on..." hint text is
    cleared when preserving a selection, so it can't keep pointing at a different resume than
    what's now shown. Per explicit instruction, no automated test file was written for this.

79. **"Mode" (tailor a resume per job vs. use one uploaded resume as-is) moved from the shared,
    global Settings blob to per-person storage** - explicitly requested: this same install is
    shared by several people, and their preference on this specifically differs, unlike the
    other Settings fields (provider, model config, Portal credentials, etc.), which stay global
    for now ("for others, let's do it later").
    - `companion-service`: new `config.tailor_mode_file(person)` (`people/<person>/
      tailor_mode.json`), `store.get_tailor_mode`/`save_tailor_mode` (mirroring
      `get_resume_template`/`save_resume_template` exactly), new `TailorModeChoice` schema, and
      new `GET`/`PUT /tailor-mode` endpoints (mirroring `/resume-template`). `Settings.tailor_mode`
      removed from `schemas.py` entirely - it's no longer part of that model at all, not just
      unused.
    - `sidepanel.js`: `applyTailorMode()` now fetches `/tailor-mode` alongside `/settings` (in
      parallel); the `tailorModeSelect` change handler PUTs to `/tailor-mode` directly instead of
      going through the generic `patchSetting()` helper (same reasoning `templateSelect` already
      had for the same kind of per-person field). `buildPortalLogEntryFromPanel` no longer takes
      a `settings` param at all - it reads tailor mode straight off the DOM
      (`tailorSection`'s own visibility, which `applyTailorMode()` already keeps in sync), one
      fewer network round trip for the "Save & Sync to Portal" click.
    - `options.js`: `buildSettingsPayload()` no longer includes `tailor_mode` at all (it's not a
      field on `Settings` to carry forward anymore).
    - **Unrelated bug caught in passing while touching these schemas**: `Settings.provider`/
      `answer_provider`'s `Literal` type (and `ProviderTestRequest.provider`) never included
      `"gpt-auto-headless"` after that 5th provider option was added earlier this session -
      meaning saving Settings with it selected would have been rejected by Pydantic validation
      (a 422) the first time anyone actually tried it. Fixed by adding it to all three.
    - Per explicit instruction, no automated test file was written for this.

80. **Reported live: pressing a global keyboard shortcut (Alt+G) opened 2 ChatGPT tabs instead
    of 1, but only sometimes - the second browser tab it was pressed in specifically, not the
    first, third, or later ones.** Root cause: `myTabId` (used by every side panel instance to
    decide whether an incoming shortcut broadcast is meant for it - finding 76) was captured via
    an ASYNC `chrome.tabs.query({active:true, currentWindow:true})` at load time - "whichever tab
    is active right now," not "which tab this specific panel document was actually created for."
    If the user switched tabs while a panel was still initializing (an entirely ordinary thing to
    do), that query could resolve AFTER the switch, capturing the WRONG tab's id - so two
    different tabs' own panels could both end up with the same (incorrect) `myTabId`, and a
    single shortcut broadcast would then match and fire in both of them at once. Fixed by baking
    the real tabId directly into each panel's own URL instead: `background.js`'s
    `makeSidePanelPerTab` now calls `chrome.sidePanel.setOptions({tabId, path:
    \`sidepanel.html?tabId=${tabId}\`, ...})` (was a fixed `"sidepanel.html"` for every tab), and
    `sidepanel.js` reads `myTabId` synchronously from `location.search` instead of querying for
    it - no async timing dependency left to race against at all. Per explicit instruction, no
    automated test file was written for this.

81. **Two explicitly requested Portal-sync/UX improvements, unrelated to each other:**
    - **A headless/headed toggle for Portal sync** - sync failures are hard to diagnose with a
      fully invisible browser. New `Settings.portal_headless: bool = True` (global, alongside the
      other Portal fields); `portal_automation.sync_portal_entry` now takes `headless` as a
      parameter (default `True`) instead of reading the old hardcoded module-level `HEADLESS`
      constant (removed); `main.py`'s `/portal-sync` passes `settings.portal_headless` through.
      Checkbox (`#portalHeadful`, phrased as "show the browser window" - the more intuitive way
      round for a user to think about it, inverted against the actual `portal_headless` field)
      lives directly in the job-apply side panel, right next to "Save & Sync to Portal" itself -
      moved there from Settings' Portal tab per explicit follow-up ("not in settings, in
      sidepanel"), saved immediately on change via the existing `patchSetting()` helper (same
      pattern as `deleteGptConversationsToggle`), not a separate Save button. Unchecking it lets
      the next sync attempt be watched directly as a real, visible Playwright window instead of
      guessing blind, the same way this was manually toggled during development (findings
      72/76b).
    - **Picking a Platform in one already-open tab's panel now updates every other already-open
      tab's panel live, not just tabs opened later.** `chrome.storage.local` (what
      `platformSelect`'s "sticky across the whole side panel session" value already lived in) is
      already shared browser-wide, but each panel only ever read it ONCE at its own load time -
      explicitly requested, since working through a batch of jobs from the same source often
      means several tabs are already open at once, and picking the platform in one didn't carry
      over to the others already open. New `chrome.storage.onChanged` listener in `sidepanel.js`
      updates `platformSelect`'s value live whenever it changes in a different tab's panel.
    - Per explicit instruction, no automated test file was written for either.

82. **Two more real bugs, both found from real live reports on the same day the headless toggle
    (finding 81) shipped.**
    - **Reported live: "the headless checkbox isn't checkable."** Root cause: `applyTailorMode()`
      re-runs on every window "focus"/document "visibilitychange" event, unconditionally
      overwriting every control it sets - and clicking directly into an unfocused side panel (the
      very first click on ANY control, including the checkbox itself) fires exactly such a
      "focus" event as part of that SAME click. The resulting concurrent `applyTailorMode()` call
      re-fetched `/settings` before the checkbox's own save had finished, then immediately
      stomped the checkbox right back to its old value - same class of bug, and same underlying
      cause, as `loadResumesForPicker`'s own "manual pick gets silently reverted" fix (finding
      78), just triggered by a focus event instead of a generic refresh. Fixed by skipping every
      control `applyTailorMode()` sets (`tailorModeSelect`, `providerSelect`,
      `answerProviderSelect`, `deleteGptConversationsToggle`, `portalHeadful`) whenever it's the
      currently focused element - the standard "don't overwrite what the user is actively
      interacting with" guard.
    - **Reported live: a real Portal sync failed with a 500 - `Locator.click: Timeout 30000ms
      exceeded` on `#saveButton1`, blocked by `<div role="dialog" class="bs-popup modal in">
      intercepts pointer events`.** The "Companies, Add new" modal (finding 72) was still open
      when the main form's Save button was clicked - `_fill_company`'s own close-wait only ever
      checked `.modal-backdrop`, never the actual dialog wrapper itself (a DIFFERENT element,
      confirmed live: `role="dialog" class="bs-popup modal in"`), so a still-open modal could
      silently continue past that point undetected. New shared `_wait_for_no_modal()` (selector
      `.modal.in, .modal-backdrop, [role="dialog"].in`) replaces the old single-element
      `.modal-backdrop.wait_for(state="detached")` call, polling until EVERY modal-like element
      is genuinely gone rather than tracking one specific handle that could go stale or simply be
      watching the wrong piece of a multi-part modal entirely. Also called defensively right
      before `_fill_add_job`'s own final Save click, as cheap insurance against any stray modal,
      not only one specifically left over from the Company step. Verified with an ad hoc,
      unsaved smoke check (not a committed test file, per explicit instruction) simulating a
      modal that stays open ~800ms after its own Save click - confirmed the old code's exact
      failure shape and the new code correctly waiting it out.

83. **Reported live: a real jobs.lever.co application's batched-answer prompt showed two real
    questions ("When are you available to start working?", "Please share a link to your
    portfolio or previous work.") both as the literal string "Type your response" instead.**
    Root cause: an ancestor sibling-text climb ALREADY existed in `resolveOwnLabel`
    (`field-detector.js`), written specifically to solve this exact Lever shape (question text
    lives in a sibling `<div class="application-label"><div class="text">...</div></div>` of an
    ancestor, not the field itself) - but it was positioned AFTER the raw `placeholder` fallback
    in the priority chain, and Lever's own custom text-input questions all carry the identical
    generic placeholder `"Type your response"` (never the real question) - so the placeholder
    check returned that meaningless boilerplate immediately, before the fix actually meant to
    solve this case ever got a chance to run at all. Fixed by moving that ancestor-climb ahead of
    the placeholder check (matching where its siblings `findLabelInAncestors`/
    `findHeadingInAncestors` already sit - a real nearby label signal outranking a generic
    placeholder is this file's own established priority pattern, not a new one). Also added
    `isGenericTextPlaceholder()` (matches "Type your response"/"Type your answer") as
    defense-in-depth on the placeholder check itself, in case the ancestor-climb ever fails to
    find a match for some other Lever question shape. Verified with an ad hoc, unsaved smoke
    check (not a committed test file, per explicit instruction) against the real captured markup,
    confirming the fix resolves to the real question text instead of the placeholder.

84. **Reported live: a required GDPR consent checkbox on atolls.com's application form visually
    ticked correctly via Auto Fill, but the site's own validation never cleared ("Please accept
    the terms to proceed." stayed visible, `aria-invalid="true"` stayed set).** Root cause: the
    exact same class of bug `nativeSet` already exists to solve for TEXT fields (React/similar
    frameworks override the native property setter on a controlled element instance to track
    their own internal state), just never applied to the `checked` property. A plain
    `element.checked = true` write goes through that SAME overridden setter, silently updating
    the framework's own tracked-checked cache to already match - so the `input`/`change` events
    dispatched right after get compared against a cache that already agrees, and the framework's
    real `onChange` handler never fires, even though the checkbox's own native DOM state
    genuinely did change. New `nativeSetChecked()` (mirrors `nativeSet`'s exact technique -
    call the ORIGINAL prototype setter directly, bypassing whatever the framework overrode on
    the instance) replaces every plain `.checked = x` assignment across all three fill paths in
    `sidepanel.js` (`fillSingle`/`runAutofillInPage`'s consent-field path, a grouped-radio/
    checkbox-peer helper, and `fillGeneratedAnswersInPage`'s own AI-answer-filling loop).
    - **A second, independently real bug found in the same investigation**: two of those three
      spots additionally called the checkbox's own real `.click()` AFTER already setting
      `.checked = true` - since a genuine `.click()` on a checkbox always TOGGLES its current
      state (regardless of how that state got there), this unconditionally flipped an
      already-just-checked box right back to UNCHECKED. Removed - `nativeSetChecked` is now the
      one and only place `checked` gets set, so there's no second toggle left to undo it.
    - Verified with two ad hoc, unsaved smoke checks (not committed test files, per explicit
      instruction): one against the real captured Atolls markup confirming the consent-field
      path is what actually handles this checkbox; a second directly simulating React's own
      instance-level property-override trick, confirming the old plain-assignment approach never
      triggers a framework's real `onChange` (0 fires) while `nativeSetChecked` correctly does
      (1 fire).

85. **Extended the "single option → auto-fill; several → stamp for AI select-pick" mechanism
    (the user's own recent addition, for required native `<select>` fields) to custom,
    non-native comboboxes too** - explicitly requested, since a react-select-style
    `[role="combobox"]`/`button[aria-haspopup]`/etc. widget has no `.options` list to read the
    way a real `<select>` does, so it was previously invisible to this whole mechanism
    entirely (QA-bank match or nothing).
    - Confirmed the fill side already fully supports this with zero changes needed:
      `fillGeneratedAnswersInPage` already has `else if (looksLikeComboboxPick(el)) { ok = await
      fillReactSelectByClick(el, value); }`, and the orchestrator's own `selectPickCandidates`
      filter (`Array.isArray(u.options) && u.options.length > 1`) was never gated on tag at all
      - the ENTIRE downstream pipeline (sending to AI, getting an answer back, filling by
      `data-af-idx`) already worked generically. The only real gap was option-DISCOVERY during
      detection.
    - New `discoverComboboxOptions()` in `runAutofillInPage` (`sidepanel.js`) opens a combobox
      the same way `fillReactSelectByClick` does (`simulateClick` + `findComboboxOptions`),
      reads whatever renders, then closes it back down (Escape + blur) without selecting
      anything - this is a discovery-only pass; the real pick happens later through the normal
      fill path's own independent open/close cycle, whether that's the immediate
      single-option auto-fill (`fillSingle`, same as the native-select path) or the AI-picked
      answer from a later batch.
    - New detection branch mirrors the native-`<select>` one exactly (same `isRequiredField`
      gate, same "1 → auto-fill via `fillSingle`, 2+ → `stampIdx` + push to `unmatched` with an
      `options` array, 0 → fall through to generic handling" shape), just sourcing its option
      list from `discoverComboboxOptions` instead of a native `.options` read.
    - Verified with an ad hoc, unsaved smoke check (not a committed test file, per explicit
      instruction) against a synthetic react-select-style widget: a single-option scenario
      correctly discovers exactly that one option, and a multiple-option scenario correctly
      discovers all real options while excluding a generic "Select..." placeholder option.

86. **Reported live on a real job-boards.greenhouse.io application (DistroKid): "7 fields
    filled, then GPT opened, generated all answers, GPT closed - then nothing gets filled. Just
    opens a select box and closes it."** Investigated after a large amount of Greenhouse-
    specific combobox-filling logic was found already in place (`fillGreenhouseViaReactFiber`,
    `tryGreenhouseRemixSelect`, trusted-click/keyboard-navigation fallbacks in
    `fillReactSelectByClick`) - clearly already under heavy iteration, so this was investigated
    by reading, not guessed at blind.
    - **Confirmed, fixed**: `fillGeneratedAnswersInPage`'s own per-field dispatch loop had NO
      try/catch around any individual field's fill logic - an exception thrown anywhere while
      processing ONE field (a Greenhouse combobox interaction being the most likely candidate,
      given its own elaborate multi-fallback logic) would propagate uncaught out of the WHOLE
      loop, aborting it immediately. Since the fill count is only ever returned once, after the
      loop fully completes, this doesn't just fail the one problem field - it silently discards
      credit for every OTHER field already successfully filled earlier in the exact same batch,
      matching the reported "generated all answers, then nothing gets filled" shape precisely
      (not "the select field specifically didn't fill" - literally nothing in that batch did).
      Fixed by wrapping each field's fill attempt in its own try/catch, so one bad field can no
      longer sacrifice the rest of the batch's results.
    - **Not yet confirmed as the FULL fix** - this addresses the cascading-failure shape but
      doesn't by itself explain why the Greenhouse combobox itself failed to commit a value in
      the first place (the "opens and closes" part) - that's still an open question, given how
      much fallback logic already exists for exactly this widget. Next step if it recurs after
      this fix: check the browser's own DevTools console during a live run for a thrown error
      (now caught, but still logged if a `console.error`/similar is added, or visible via a
      breakpoint) to identify exactly which fallback path is failing and why.
    - Investigated via a temporary alternate mount of the VMware shared folder
      (`/home/administrator/hgfs-mount/`, since `/mnt/hgfs` itself is root-owned and requires
      sudo this session didn't have passwordless access to) - `sync.sh` itself still points at
      `/mnt/hgfs/...` and was NOT modified; syncing during this investigation was done with a
      one-off manual `rsync` command instead. If `/mnt/hgfs` stops working again, either restore
      it directly (`sudo mount -t fuse.vmhgfs-fuse .host:/ /mnt/hgfs`) or mount to an
      owned directory the same way.
    - Update: `/mnt/hgfs` itself has since been properly restored with `-o allow_other` (no more
      workaround needed) and the catch block above now does `console.error` the caught error
      (field idx/label + the actual thrown error) instead of swallowing it silently, so a
      recurrence gives real diagnostic data instead of another guess.

87. **Reported live on a real Greenhouse application: the phone country-code combobox visibly
    opened/cycled through options (arrow-key style) then closed, reopened and typed a country
    name to commit correctly - then, AFTER other fields had already been filled, it silently
    changed to a DIFFERENT, wrong country, non-deterministically (a different wrong country each
    run).** Root cause: `fillGeneratedAnswersInPage`'s `findElementByLabel` - the fallback re-
    lookup used when a GPT-answered field's original `data-af-idx` stamp is no longer found in
    the DOM (e.g. after a React re-render elsewhere on the page) - matches purely by label text,
    with no concept of Greenhouse's phone widget having its own dial-code sub-picker labeled bare
    **"Country"** (the exact same collision `matchStructuredField` already guards against
    elsewhere, see the comment at its `isPhoneDialCodePicker` check - but that guard lives only in
    `runAutofillInPage`'s scope; `findElementByLabel` had no idea phone-dial-code pickers even
    exist). When a genuinely different "Country" question (residence/nationality, worded as bare
    "Country" on some Greenhouse postings) loses its own DOM stamp and falls back to this label
    lookup, it matches the phone widget's "Country" label instead and overwrites the already-
    correct dial code with that OTHER question's GPT-generated answer - which varies run to run,
    explaining the "different wrong country each time" shape exactly. Fixed by adding a local
    `isPhoneDialCodePicker` + `rejectPhoneDialCode` guard to every match path in
    `findElementByLabel`, skipping a phone-dial-code-picker match unless the target label itself
    is actually asking about a dial/calling/country code.

88. **Reported live on Greenhouse (confirmed by the user): the "Phone" number field ends up with
    a WRONG value after autofill** - the number field is filled once, then changes to something
    incorrect. Confirmed from a real capture (job-boards-greenhouse-io-20260810T060909Z.html)
    that Greenhouse's phone widget is actually TWO separate, adjacent pieces: `.phone-input__country`
    (the react-select "Country" combobox already covered by #87) AND `.phone-input__phone`, which
    is itself wrapped in a real intl-tel-input widget (`.iti`, confirmed via
    `class="... iti__tel-input"` + `data-intl-tel-input-id="0"` on the actual `<input id="phone">`).
    - **A wrong first attempt was caught and reverted before syncing broadly**: initially assumed
      (by analogy with Workday, which genuinely does want local-digits-only in its plain phone-
      number field) that `.phone-input__country`'s presence meant the number field should also get
      its country-code prefix stripped. That's backwards for Greenhouse - `.iti`'s own
      `setPhoneValue`/`iti.setNumber()` needs the FULL "+48…" string to auto-detect its embedded
      country flag; stripping the prefix first would have left it with nothing to detect from.
      Reverted the `hasSeparateCountryCodeField`/phone-pattern change, and instead added a
      `matchStructuredField(label, element)` → `get(profile, element)` signature extension so the
      phone pattern can check `element.closest('.iti')` and always return the FULL value for any
      intl-tel-input-wrapped field, documenting the invariant rather than guessing at it again.
    - **Root cause of the actual "ends up wrong" bug is NOT yet confirmed** - the real mechanism
      (most likely candidate: some sync between `.phone-input__country`'s react-select and the
      `.iti` widget's own internal country-detection, given both represent the same real-world
      fact and are filled independently by two different code paths in the same loop) needs live
      data to pin down rather than more blind guessing, especially after the above wrong turn.
      Added temporary diagnostic-only logging (`[Auto Fill][phone-watch]` console lines) in
      `runAutofillInPage`: logs the phone number's value right after it's filled, then polls it
      every 400ms for 8s logging any change with a timestamp; also logs which of the three
      country-picker fill attempts (already-shown / dial-code / country-name) actually committed.
      Not a fix - remove once a repro's console output identifies the real mechanism.
    - Next step: reproduce live with DevTools console open on the Greenhouse tab, and read off the
      `[Auto Fill][phone-watch]` lines - they'll show the exact value transition and rough timing,
      which should make the actual cause obvious instead of guessed at.
    - **Follow-up, resolved**: user's repro showed the Phone number field working correctly (the
      `[phone-watch]` "filled ... watching for later changes" line appeared and never fired a
      "changed" warning) - so #86/the reverted wrong-turn theory above was a dead end. The ACTUAL
      wrong field was the "Country" dial-code picker itself, now showing an unrelated country
      (Armenia, then Romania on a different capture) with a different value each site, still with
      ZERO of the new `[phone-watch]` country-picker logs firing at all - meaning
      `isPhoneDialCodePicker`'s whole dedicated fill block wasn't even reached, or all 3 of its own
      attempts genuinely failed to commit. Traced the fallthrough: when all 3 attempts fail, the
      field falls through EVERY exclusion further down (all of which correctly check
      `isPhoneDialCodePicker`) and lands, unguarded, on the generic catch-all
      `unmatched.push({idx, label, type, canGenerate})` at the very end of the loop - with
      `canGenerate: false` (correctly non-generatable as free text) and no `options` (correctly
      excluded from select-pick too), so per the orchestrator's own `generationCandidates`/
      `selectPickCandidates` filters it should never reach the AI at all.
    - **Root cause confirmed**: `matchQaBankEntry`'s word-overlap tier needs >=2 shared
      significant words, and a bare "Country" label is only ONE word - it can never clear that
      bar; its category-shortcut tier has no pattern for bare "country" either (checked
      `MATCH_CATEGORY_PATTERNS` directly). The ONLY tier that can still match a one-word label is
      the plain exact-text tier (`normLabel === normQuestion`) - meaning the wrong country values
      seen live are near-certainly a STALE, previously-learned QA-bank entry (`{question:
      "Country", answer: "<wrong country>"}`), saved by some EARLIER buggy run (most likely #87's
      now-fixed `findElementByLabel` label-collision bug, before it existed) and silently
      reapplied on every subsequent run since - independent of any downstream code fix, since the
      QA bank itself is what's wrong, not the matching logic. Different sites showing different
      wrong countries is consistent with multiple separate bad entries having been saved over
      time (or the SAME entry read differently) rather than fresh AI hallucination each run.
    - **Fixed defensively regardless**: added a `skipQaMatch: isPhoneDialCodePicker(element)` flag
      to the catch-all `unmatched.push`, and made both the gpt-auto local QA-bank match loop and
      the server-side `/match-answers` semantic-match loop skip any item so flagged - a
      phone-dial-code picker's only correct value is profile.contact.phone/country directly, it
      must never be handed ANY saved/learned/AI-matched answer, past or future. This closes the
      gap regardless of whether the live bad value is exactly this stale-entry mechanism.
    - **Action still needed from the user**: open Settings → Q&A and delete any saved entry whose
      question is literally "Country" (or very close to it) - the code fix above stops it from
      being APPLIED going forward, but the bad saved answer itself isn't automatically removed.

89. **User confirmed #88's QA-bank theory was a dead end for this symptom - the ACTUAL live
    report: while a completely UNRELATED later question ("Are you comfortable with the salary
    range?") has its own combobox opened during Auto Fill, the ALREADY-CORRECTLY-FILLED phone
    NUMBER field suddenly reverts/changes.** Root cause: `setPhoneValue`'s intl-tel-input JS-API
    path (`iti.setNumber(value)`) writes the input's `.value` through the library's own internal
    DOM assignment, with no idea a React component might also be watching this same input.
    React tracks controlled inputs via each element's own `_valueTracker`, comparing its cached
    value against what a dispatched `input` event reports before deciding whether to invoke the
    component's real `onChange` - `setPhoneValue` dispatched `input`/`change` afterward but never
    reset that tracker first (unlike `nativeSet`, which already does this for plain text inputs -
    the same category of gap, just missing in this one specific path). Without it, React can
    decide nothing really changed and never update ITS OWN internal state to match what's
    visibly on screen - the DOM looks right until ANY unrelated later re-render (opening a
    completely different combobox elsewhere on the page is enough to trigger one), at which point
    React re-renders this controlled input from its own still-stale pre-fill state, silently
    reverting the visible value. Fixed by resetting `_valueTracker` to the current value right
    before calling `setNumber()`/`plugin.setNumber()`, same trick `nativeSet` already uses.
    - Also explicitly requested: step/tier-level diagnostic logging (`[Auto Fill][country-retry
      "<value>"]` console lines) added throughout `tryGreenhouseRemixSelect`'s 4 fallback tiers
      (React-fiber direct, click-poll, keyboard-nav, type-to-filter) in BOTH duplicate copies -
      logs which tier committed, how many polls/steps it took, and what it saw, to answer "why
      does this need 3 retries instead of one" with real data instead of guessing at Greenhouse's
      own react-select internals blind.
    - Not yet confirmed live - needs a retest to know whether the React-tracker fix actually stops
      the phone number from reverting when a later, unrelated combobox opens.

90. **Follow-up from the tier logging in #89: the user's live console output directly proved the
    "why 3 retries" cause, AND surfaced a real, separate verification bug.** Renamed the
    `[country-retry]` log tag to `[combobox-retry]` first - it was misleadingly implying
    phone-specific logging, when `tryGreenhouseRemixSelect` is actually the shared fill helper
    for every Greenhouse react-select combobox on the page (confirmed live: the exact same tag
    fired for "No"/sponsorship, "60000 EUR"/salary, "European Union"/region, "Advanced"/English
    level - none phone-related at all, which is what the user was asking about).
    - **Bug 1, the actual "3 retries" cause**: the dial-code guess `String(profile.contact.phone)
      .match(/^(\+\d+)/)?.[1]` is greedy - for "+48694542078" it captures the ENTIRE leading digit
      run ("+48694542078"), not just the calling code ("+48"), since there's no way to know the
      code's real boundary (1-3 digits) from the digit string alone (same ambiguity
      `setPhoneValue` already documents elsewhere). The live log showed this bogus full-number
      "target" burning all 4 `fillReactSelectByClick` fallback tiers (~4-5s, including a 25-step
      keyboard scan through "united states...benin" that never gets anywhere near "poland" in an
      alphabetical list) on a GUARANTEED failure, every single run, before ever reaching the
      correct country-name attempt. Fixed by dropping the dial-code guess entirely and using
      `profile.contact.country` (unambiguous) as the only fill attempt.
    - **Bug 2, found only because of bug 1's log noise**: even the country-name attempt, which the
      log proved DOES correctly find and click "Poland +48" (poll #0, first try, confirmed via a
      real `simulateClick` in the stack trace), still got reported as FAILED - because this
      widget's own committed display is ALWAYS just "+48" (flag + calling code, confirmed from
      the earlier capture's markup), never the country name, and `comboboxValueCommitted`'s plain
      text compare checked the display against "Poland" and found no textual overlap with "+48"
      at all. The interaction worked; only the SUCCESS CHECK was wrong. Fixed by also accepting
      any bare "+<digits>" display as a valid success signal for this specific picker, alongside
      the normal text compare (kept, in case some other site's version of this widget does show
      the country name instead).
    - Noted in the same session, likely unrelated: a `my.greenhouse.io/users/self` 401
      Unauthorized + uncaught `UnauthorizedError` fired from Greenhouse's OWN `phone_input.tsx`/
      `country_input.tsx` handlers during the click (visible in the user's console output) - looks
      like the app tries to fetch/sync a logged-in candidate profile on phone/country change and
      fails for an anonymous applicant. Uncaught promise rejections don't block other already-
      scheduled synchronous code, so this is very unlikely to be why the click's own state commit
      appeared to fail - included here only in case it recurs and turns out to matter after all.
    - Not yet confirmed live - needs a retest showing the country picker committing on the very
      first attempt with no more "FAILED to commit" warnings.

91. **Follow-up retest of #90 showed the fix was only half-applied.** The outer
    `isPhoneDialCodePicker` block correctly recognized the "+48" display as success afterward
    (`"country picker committed via country name..."` did print), but the retest logs showed
    `tryGreenhouseRemixSelect` itself STILL burned through all 4 fallback tiers first, same as
    before - #90's fix only patched the outer post-hoc check, not the verification INSIDE the
    retry loop that decides whether to stop early. Root cause: `comboboxValueCommitted` calls
    `isReactSelectAlreadySet` first, and THAT function still did the same plain country-name text
    compare against a "+48" display - so tier 2's very first click (poll #0, confirmed committing
    correctly in the live log) still read back as "not committed" internally, forcing all 3
    remaining tiers to run for nothing every single time. Fixed at the actual source this time:
    added the same "+<digits> display on a phone-dial-code picker counts as committed" check
    directly inside `isReactSelectAlreadySet` (in both duplicate copies), which
    `comboboxValueCommitted` already calls first - so this one fix covers every caller,
    including tryGreenhouseRemixSelect's own internal tier-2 verification this time.
    - Also reported: the phone-number-reverts-later bug from #89 is still unconfirmed either way,
      because the diagnostic watcher only ran for 8s (20 ticks) and a real multi-field form's
      remaining comboboxes (several seconds each through their own fallback tiers) easily run
      past that before the field the user actually saw revert is even reached - the watcher had
      already stopped by then, so it never got a chance to log the real transition. Extended to
      2 minutes (300 ticks) to comfortably cover a full run instead of guessing at a duration.
    - Not yet confirmed live - needs a retest with the country picker committing in well under
      1 second (poll #0, no tier 3/4 at all this time), AND, if the phone number still reverts,
      an actual `[phone-watch] value changed from X to Y` log line this time instead of silence.

92. **#91's retry fix confirmed live** - country picker now commits on poll #0, no tier 3/4 at
    all. But the user clarified the actual live symptom is the COUNTRY/DIAL-CODE display itself
    ("+48") changing later, not the number digits (the number-field watcher already confirmed
    those stay put) - reported specifically as happening when a much LATER, unrelated question
    ("Are you comfortable with the salary range?") gets its own combobox opened. Realized the
    existing phone-watch instrumentation only ever polled the NUMBER input's `.value` - there was
    ZERO logging watching the country picker's OWN displayed value over time, so a change there
    would never have been caught regardless of watcher duration. Added a matching watcher
    (`reactSelectDisplayValue` polled every 400ms for 2 minutes) right after the country picker
    is filled, logging `"country picker changed from X to Y"` if it ever does.
    - Not yet confirmed live - needs a retest showing either no change at all, or (this time) an
      actual before/after value for what the country/dial-code display changes TO.

93. **#92's new watcher immediately caught it, with an unambiguous smoking gun.** Live log:
    `"+48" -> "+376"` (Andorra) at ~5.2s after fill, then `"+376" -> "+374"` (Armenia) at ~26s -
    both early entries in an ALPHABETICALLY-sorted country list, at timings that landed exactly
    during a LATER, completely unrelated field's ("60000 EUR") OWN tier-3 keyboard-navigation
    fallback (repeated `ArrowDown` key presses dispatched for THAT field, not this one).
    - **Root cause**: the country/dial-code picker's dropdown was never explicitly closed after a
      successful commit (tier 2's click already correctly selects+closes the VISIBLE menu, but
      nothing resets whatever internal "which listbox is active" state Greenhouse's remix
      react-select tracks). Later, totally unrelated `ArrowDown` presses meant for a DIFFERENT
      field's own retry logic get silently absorbed by this picker instead, walking it one
      option at a time through the alphabetical country list and changing its already-correct
      value out from under a field that had already finished minutes earlier in wall-clock terms
      (this form's later comboboxes each burn several seconds of their own fallback tiers).
    - **Fixed**: added an explicit close-down step (`Escape` keydown/keyup + `.blur()` + a short
      settle wait - the exact same pattern `discoverComboboxOptions` already uses elsewhere in
      this file for the same reason) right after the country picker's commit is confirmed,
      before moving on to any other field.
    - Scoped to just this picker for now, since that's the one with a live, reproduced report -
      the same "still marked active, later steals unrelated ArrowDown presses" mechanism could in
      principle affect any OTHER Greenhouse combobox filled via tryGreenhouseRemixSelect's tier 2
      click-poll (which never explicitly closes down either), so if a similar report ever surfaces
      for a non-phone field, apply the same closeComboboxDown() step there too.
    - Not yet confirmed live - needs a retest with NO `"country picker changed from..."` warning
      appearing at all, however long the rest of the form takes to fill.

94. **#93's Escape/blur close-down did NOT fix it - retest showed the EXACT same "+48" ->
    "+376" -> "+374" progression, at the same timings, during the same unrelated "60000 EUR"
    field's own tier-3 keyboard-nav.** User asked three sharp questions that reframed the
    investigation: (1) could a DIFFERENT field's autofill directly affect the phone/country
    picker, (2) is a "retry" genuinely re-processing the SAME field, or is some later pass
    starting over from the beginning (re-touching already-filled fields), (3) is this related to
    an EARLIER-session report of "pressing Enter changes the phone code"?
    - Clarified (2): the two separate script-execution contexts seen in every log (VM1839 then
      VM1915, etc.) are `runAutofillInPage` (the first, structured/QA-bank pass) followed by
      `fillGeneratedAnswersInPage` (a SEPARATE, later pass that applies AI-matched/generated
      answers to whatever the first pass left unmatched) - not a restart from the beginning. A
      field showing up in BOTH just means the first pass's own attempt at it failed and it fell
      through to the second pass with a fresh answer.
    - (1) and (3) both remain genuinely open and are exactly why the Escape/blur fix didn't help:
      that fix assumed the country picker's OWN internal "open" state just needed clearing, but
      if EITHER (a) some GLOBAL keyboard-routing mechanism still delivers a later field's own
      Enter/ArrowDown to whatever Greenhouse's app considers "active" regardless of this widget's
      own DOM state, or (b) the later field's OWN fillReactSelectByClick call is somehow being
      handed the COUNTRY PICKER'S element directly (a stale/colliding `data-af-idx` resolving to
      the wrong node - same shape as the earlier findElementByLabel bug, #87), closing this one
      widget down properly wouldn't prevent either. The user's recollection that pressing Enter
      specifically (not just ArrowDown) previously changed the phone code fits (b) less than (a) -
      Enter is what COMMITS a highlighted option, consistent with a highlight that ArrowDown
      presses elsewhere kept moving actually belonging to this widget the whole time.
    - Added a direct diagnostic to tell (a) and (b) apart instead of guessing further: every call
      to `fillReactSelectByClick` now logs a warning if the element it was actually handed is
      inside `.phone-input__country`, including the desiredText it was asked to search for. If
      "60000 EUR" (or any other unrelated field's own answer) shows up tagged against the country
      picker's own element, that's (b) confirmed directly - the wrong node, not a leaked event.
    - Not yet confirmed live - needs a retest reading off whether this new warning appears at all
      during the "60000 EUR" field's own attempt.

95. **#94's diagnostic came back clean - the new warning never fired.** Retest showed the EXACT
    same "+48" -> "+376" -> "+374" progression, at the same timings, during the same "60000 EUR"
    field's own tier-3 keyboard-nav - but `fillReactSelectByClick` was never once called with the
    country picker's own element as `element`. Directly rules out (b) (wrong DOM node from a
    stale/colliding idx or label match) - "60000 EUR"'s own fill code genuinely operates on its
    own, correct element the whole time.
    - New leading theory (a): `dispatchKey` fires KeyboardEvents via `element.dispatchEvent()` on
      the CORRECT element, but that's not the same as real browser focus. If Greenhouse's own app
      routes keyboard navigation based on `document.activeElement` (a document-level listener,
      common for widget libraries that don't rely purely on React's per-component event-target
      routing) rather than the dispatched event's own target, these ArrowDown/Enter presses could
      land on whatever ACTUALLY holds real focus regardless of which element they were dispatched
      on. Notably, every successful commit in every log so far has been via tier 2 (a real click
      on a real rendered option, which DOES properly move real focus/relies on React's own click
      handler) - keyboard-nav (tier 3) has not committed even once in any live log yet, consistent
      with keyboard events not reliably reaching the intended component's own logic at all. Also
      notable: this codebase already has a `trustedClick` mechanism (real OS-level clicks via
      `chrome.debugger`, because Greenhouse's app ignores synthetic mouse events for opening) but
      has NO equivalent trusted-KEYBOARD mechanism anywhere - every ArrowDown/Enter/Escape
      dispatched throughout this whole file is a synthetic, untrusted KeyboardEvent.
    - Added a direct, minimal check instead of building a whole trusted-key mechanism speculatively
      first: logs a warning whenever `document.activeElement !== element` right before dispatching
      ArrowDown in the tier-3 loop, naming whatever element actually holds focus at that moment.
    - Not yet confirmed live - if this warning fires during "60000 EUR"'s own tier-3 attempt
      naming the phone/country picker's own input as the actual focus holder, that's the
      confirmed mechanism, and the real fix becomes either (i) a trusted-keyboard-event helper
      (chrome.debugger's Input.dispatchKeyEvent, mirroring trustedClick) or (ii) making sure
      focus is more forcefully and durably moved before any keyboard-nav step, not guessed at
      again - which one depends on what this log actually shows.

96. **#95's focus-mismatch check also came back clean - confirmed the user's OWN 401/fetchProfile
    timing check too (only happened once, doesn't correlate with the later changes).** Three
    separate mechanisms now directly disproven by real data: not a wrong DOM element target
    (#94), not stuck/wrong browser focus (#95), not a fetchProfile-retry-triggered reset. Rather
    than propose a fourth blind code theory, switched tools entirely: asked the user to set a
    DevTools DOM breakpoint ("break on subtree modifications") on the country picker's own
    element to capture the REAL call stack at the moment of mutation - this didn't pan out in
    practice (fiddly to set up correctly by hand; the user's reply came back as the element's
    current HTML, not a paused call stack).
    - Built the same capability directly into the diagnostic instead, needing no manual DevTools
      interaction at all: `traceCountryPickerMutations()` temporarily wraps the DOM mutation
      primitives React actually uses to update this widget's own subtree specifically
      (`Node.prototype.insertBefore` - covers `appendChild` too in Chromium -, `removeChild`,
      `replaceChild`, and the `CharacterData.prototype.data` setter for plain text-node updates),
      scoped to just this picker's own `.select-shell` container (not the whole page), logging a
      REAL synchronous stack trace (`new Error().stack`) the instant anything touches that
      subtree - something polling `reactSelectDisplayValue` can never provide, since by the time
      a poll notices a change, the causing call stack is long gone. Auto-restores the original
      methods after 90s. Called right alongside the existing `watchCountryDisplay()`.
    - Not yet confirmed live - needs a retest pasting back whatever `MUTATION ...` warning(s)
      appear, which should finally show the actual responsible code path directly instead of
      requiring another guess-and-eliminate round.

97. **#96's monkey-patch-based tracer came back completely silent - zero MUTATION warnings -
    while the value still changed exactly as before ("+48" -> "+376" -> "+374", same timings).**
    Recognized this as a bug in the DIAGNOSTIC itself, not evidence the underlying issue stopped
    happening: `chrome.scripting.executeScript` runs this whole script in an ISOLATED WORLD, a
    separate JS realm from the page's own scripts, with its own independent copy of built-ins
    like `Node.prototype`. Patching that copy's `insertBefore`/`removeChild`/`replaceChild`/
    `CharacterData.data` has ZERO effect on React's own calls to the same-named methods, which go
    through the PAGE's own, completely different copy - the trap could never have fired
    regardless of what was actually happening on the page. (Plain DOM operations like
    `element.value = ...`/`.dispatchEvent()`/`.click()` still work fine across this boundary
    because the underlying DOM tree itself is shared between worlds - only the JS-level built-in
    PROTOTYPES are separated per-realm; this is why everything else in this file has worked
    normally despite running in the isolated world the whole time.)
    - Replaced with `MutationObserver` instead, a real browser API that watches the actual shared
      DOM tree directly rather than intercepting realm-scoped function calls, so it isn't subject
      to the same isolation gap - it fires regardless of which world caused the change. Trade-off:
      its callback runs asynchronously, so it can't capture the ORIGINAL synchronous call stack a
      same-realm patch could have gotten - but it will actually fire this time, and reports real
      mutation records (type, target, old/new text, added/removed nodes), which is still far more
      than "we polled and it was different" with zero insight into what changed.
    - Not yet confirmed live - needs a retest pasting back whatever `MUTATION observed inside
      country picker subtree` warning(s) appear. If genuinely NOTHING fires even now, that would
      mean the picker's OWN subtree literally isn't being touched at all, and whatever changes
      `reactSelectDisplayValue`'s read result must be happening one level up (e.g. an ancestor
      swap/remount that replaces this whole `.select-shell` wholesale) - worth widening the
      observed root to a broader ancestor if this retest also comes back silent.

98. **#97's MutationObserver worked, and finally delivered a real answer.** Two mutation events
    caught, each with a genuine React-DOM internal commit call stack (`scheduler.production.min.js`'s
    `postMessage`-based deferred/concurrent-mode scheduling, real `react-dom` fiber-commit
    functions) - not anything from this extension's own click/keyboard/focus code. The country
    picker is being independently re-rendered by GREENHOUSE'S OWN REACT APP via its own deferred
    scheduler at some point during a run, resetting an already-correct value on its own. This
    closes out the investigation that started at #90: three separate own-code theories (wrong
    element target #94, stuck/wrong focus #95, fetchProfile-retry-timing correlation checked
    directly by the user) were each ruled out first with live evidence before concluding this -
    not guessed as a default explanation once other ideas ran out.
    - Leading theory for WHY: every commit to this field also triggers Greenhouse's own
      `fetchProfile()` call (visible in every capture since the very first Poland attempt), which
      401s for an anonymous applicant (confirmed live: `UnauthorizedError: Unauthorized: User is
      not logged in`). Most likely that call's own delayed error-handling resets this field as a
      side effect, entirely inside Greenhouse's own app code - not something preventable from
      outside their app.
    - **Fixed by outlasting it instead of trying to prevent it**: added `reverifyPhoneCountryPickerInPage(profile)`,
      a new small, self-contained top-level function (duplicates just `fillGreenhouseViaReactFiber`'s
      own short helpers, not the full multi-tier DOM-click fallback chain, since the widget is
      definitely already mounted by this point) that waits 3s, checks whether the picker's
      display is still a valid "+NN" dial code, and if not, re-fills it directly via React fiber
      manipulation. Wired into the `autofillBtn` handler as a genuinely final step - runs once,
      across all frames, AFTER `fillGeneratedAnswersInPage` and its stray-frame sweep have both
      already completed for everything else on the page - so nothing later in the run can still
      knock it over. Reports "Corrected the phone country code, which the site's own app reset
      mid-run." in the final status text when it actually had to fix something.
    - Not yet confirmed live - needs a retest confirming the picker ends up correct AFTER the
      whole run completes (not just immediately after its own initial fill), and checking whether
      the new status-text note appears when a mid-run reset did happen.

99. **User pushed for the actual final on-page state (not mid-run console logs) and it exposed a
    real bug in #98's own fix, plus a separate, previously-unseen gap.** Final state showed the
    country picker STILL wrong ("+374") despite #98's re-verify step supposedly running.
    - **Root cause of #98 not working**: its own "is this correct" check only verified SHAPE
      ("does this look like some +NN dial code"), not VALUE - and the wrong value Greenhouse's
      own app resets this field TO ("+374") is ALSO shaped like a real dial code. The check saw
      "+374", concluded "looks fine, nothing to fix", and skipped the re-fill entirely every time.
    - **Fixed with exact-value verification instead of shape verification**: since any genuinely
      correct calling code must be a literal PREFIX of the profile's own full phone number (e.g.
      "+48" is a prefix of "+48694542078"; "+374" is not), checking that directly sidesteps the
      "which exact length is the real code" ambiguity noted elsewhere in this file entirely.
      Applied in THREE places that all had the same shape-only flaw: `reverifyPhoneCountryPickerInPage`
      itself, the earlier "already showed"/"committed via country name" checks in
      `runAutofillInPage`'s own `isPhoneDialCodePicker` block, and - the deepest, most important
      one - `isReactSelectAlreadySet` itself (called first by `comboboxValueCommitted`, which
      `tryGreenhouseRemixSelect`'s own tiers use to decide whether to stop early). That last one
      matters most: without fixing it, a re-fill attempt starting while the picker already shows
      a WRONG-but-valid-looking code would short-circuit at the very first line of
      `fillReactSelectByClick`, claim "already correct", and never even attempt to click the real
      target - the outer checks would have nothing real to verify regardless of how they
      themselves were written. Also stopped trusting `fillReactSelectByClick`'s own boolean
      return value in the outer check (was `committed || isCorrectDialCode(nowShown)`) for the
      same reason - relies solely on reading the actual resulting value back off the DOM now.
    - Added console logging (`final re-check: ...`) to `reverifyPhoneCountryPickerInPage` so the
      next retest shows definitively whether it detected a wrong value and what it did about it.
    - **Separate, newly confirmed gap, not yet investigated**: the final on-page state also showed
      two OTHER required select fields ("What is your level of experience with AWS?", "How many
      years of experience... building and scaling backend systems...") left on the placeholder
      "Select..." - never filled at all. The console log showed a `combobox-retry "Expert"` value
      committing successfully on poll #0, but "Expert" doesn't appear on EITHER of those two
      fields (or anywhere else) in the final state - suggesting it landed on some OTHER,
      similarly-worded skill-level field instead (same general shape as #87's bare-"Country"
      label collision, just for a different set of fields this time). Needs its own investigation
      - not yet started.
    - Not yet confirmed live - needs a retest for both: does the country picker now end up
      correct, and does the AWS/backend-systems gap still happen (ideally with a fresh Save
      Sample capture of that section of the form, to see the real label text and structure).

100. **#99's exact-value detection worked perfectly, but its own re-fill attempt didn't - retest
     showed `"+374" is WRONG ... re-filling` immediately followed by `now showing "+374" (still
     wrong)`.** Root cause: the re-fill duplicated `fillGreenhouseViaReactFiber`'s direct-React-
     fiber technique standalone - but "tier 1 (React fiber direct)" has never once succeeded in
     ANY log across this entire investigation, on this page, for ANY field. Only real clicks
     (tier 2, inside `tryGreenhouseRemixSelect`) have ever actually committed a value here. A
     standalone re-implementation using only the one approach that's never worked on this page
     was never going to work either - this was a design mistake (reached for the smallest/
     simplest helper to duplicate, not the one actually proven reliable).
     - **Fixed by not duplicating fill logic a second time at all**: renamed the function to
       `checkPhoneCountryPickerInPage` and stripped it down to detection only (still waits 3s,
       still uses the exact-prefix check from #99 - that part worked correctly). If it reports
       `wasWrong`, the `autofillBtn` handler now re-runs `runAutofillInPage` itself (the same
       code that already commits this field correctly via real clicks earlier in the same run,
       re-injecting field-detector.js first in case anything remounted since), then calls the
       check function again to confirm and build the status-text note. Most other fields' own
       fillSingle/isReactSelectAlreadySet checks should short-circuit quickly when already
       correct, so this mainly just re-does the one thing that's actually still wrong, reusing
       proven logic instead of a second, weaker copy of it.
     - Not yet confirmed live - needs a retest confirming the country picker ends up correct in
       the FINAL on-page state this time (not just the console's own "FIXED" log line), and that
       re-running runAutofillInPage doesn't visibly disrupt any other already-correct field.

101. **User saved the full console output to a file for a retest, which revealed both that #100's
     fix genuinely works AND why it wasn't enough by itself.** Full trace: country picker drifted
     "+48" -> "+376" (5.6s) -> "+1" (29.2s) - `checkPhoneCountryPickerInPage` correctly caught
     "+1" as wrong and triggered `runAutofillInPage` again - the re-run's own "Poland" attempt
     genuinely succeeded (`iti__flag iti__pl`, text "48", "committed via country name "Poland"
     (now showing "+48")" - #100 confirmed working). But the SAME re-run ALSO reprocesses "60000
     EUR" against the salary-comfort Yes/No field again (since runAutofillInPage reprocesses
     every field), which immediately re-triggered the exact same drift mechanism ("+48" ->
     "+374" again) - re-breaking what the re-run had just fixed, moments later.
     - **Every single drift event across every retest in this whole investigation (#89-#101)
       has happened during or immediately after a "60000 EUR" retry attempt specifically, and
       NEVER after any other field's clean, quick commit** - "No"/"Yes"/"European Union"/
       "Advanced"/"Expert" all commit on poll #0 with zero correlated mutations afterward, every
       time. "60000 EUR" is the one answer that never matches its own field's real options
       ([yes, no]) and always burns through all 4 fallback tiers - and is ALSO the one thing
       that's ever preceded a drift.
     - **Found the likely root cause of "60000 EUR" itself while investigating this connection**:
       `MATCH_CATEGORY_PATTERNS`' `salary_expectations` category (`/\bsalary\b|\bcompensation\b|
       .../i`, three independently-drifted copies in this file) matches on the bare word
       "salary" alone - matching BOTH "Are you comfortable with the salary range...?" (a Yes/No
       question) AND "What are your salary expectations?" (a genuinely open numeric question)
       into the SAME category. `matchQaBankEntry`'s category-shortcut trusts a category match
       unconditionally, bypassing word-overlap scoring entireley - so a saved/generated answer
       meant for the numeric expectation question ("60000 EUR") got applied to the Yes/No
       comfort question instead, which can never commit it.
     - **Fixed at the pattern source** (all three copies): added a negative lookahead excluding
       any question containing "comfortable" from the `salary_expectations` category match, so
       the two semantically different questions can no longer collide via the category shortcut.
       If this is indeed the root cause, it should eliminate "60000 EUR" ever being tried against
       this field at all - which, per the 100% correlation observed above, should also eliminate
       the recurring country-picker drift as a direct consequence, without needing to fully
       understand Greenhouse's own internal trigger mechanism.
     - Not yet confirmed live - needs a retest checking BOTH: does "60000 EUR" still appear at
       all in the console (it shouldn't), and does the country picker now stay correct through
       the whole run with no drift and no re-run needed.

102. **#101's fix DID stop the drift and eliminated "60000 EUR" - confirmed live, zero drift,
     zero "60000 EUR" this run - but at a real cost the user correctly rejected**: two fields
     that used to get filled ("Are you comfortable with the salary range?" -> Yes, and the API
     architecture experience level -> Advanced) came back completely EMPTY instead. Blocking the
     whole category match to stop one bad answer also blocked whatever legitimate path was
     filling the *other* question sharing that category - the wrong trade-off, since an unfilled
     required field is worse than an occasionally-wrong one the user can correct, and the user
     said so directly ("removing that field not filling that field doesn't make sense").
     - **User's own hypothesis, and it's the better fix**: "in field, write other text doesn't
       option in selectbox make that error I think" - i.e. typing text that doesn't match ANY
       real option is itself what's risky, regardless of WHY the mismatch happened. Confirmed
       correct on inspection: tier 4's last resort, when NOTHING matches even after typing, was
       to blindly press Enter anyway and return whatever comboboxValueCommitted said - leaving
       the widget holding non-matching typed text, uncommitted, in an undefined open/focused
       state. That ambiguous state, not the specific mismatched answer itself, is the likely
       actual vector for corrupting a DIFFERENT, unrelated field later.
     - **Reverted #101's category-pattern change entirely** (all three copies, back to the
       original bare `/\bsalary\b/` pattern) - restores whatever legitimate matching path was
       filling "Yes"/"Advanced" before, with no attempt to suppress the mismatched "60000 EUR"
       answer at its source anymore.
     - **Fixed at the actual point of risk instead**: tier 4's fallback no longer types
       non-matching text and blindly presses Enter. When nothing matches even after typing, it
       now closes cleanly (Escape, clears the typed text back to empty, blurs) and returns
       false - the ONE mismatched field still correctly ends up needing the user's input (an
       honest outcome for a genuinely wrong/unmatched answer), without leaving the widget in an
       ambiguous state that risked leaking into something else. Applied to both duplicate copies
       of tryGreenhouseRemixSelect.
     - Not yet confirmed live - needs a retest confirming ALL of: "Yes"/"Advanced" (or their
       runtime equivalents) are filled again, "60000 EUR" (or whatever mismatched answer occurs)
       still fails cleanly on its own field only, and the country/phone picker does not drift
       even though the mismatch itself is no longer being prevented from happening.

103. **User pasted the ACTUAL prompt body sent to GPT for batch-answering (captured live), which
     settled where "60000 EUR" really comes from - not a code bug at all.** It's a genuine, saved
     QA-bank entry (`Q: What are your salary expectations? A: 60000 EUR`) that GPT is choosing to
     reuse for a completely different question ("Are you comfortable with the salary range?"),
     against its own instruction not to. #101/#102's entire investigation into local
     category-collision matching was chasing the wrong layer - the mismatch is happening inside
     GPT's own batch-answer call, not in this file's own matching functions at all.
     - **Root cause found in `companion-service/app/prompt.py`**: `build_batch_answer_system_prompt`
       has ~25 lines of much more detailed, explicit grounding rules sitting commented out
       directly above the live code - including the exact asymmetric-risk framing needed here
       ("a missed reuse is safe... inventing a reuse that isn't really the same question is
       not"). The live replacement was two thin lines, one containing a typo ("truable" instead
       of "truthful"). Matches a prior Explore-agent finding from earlier this session ("~25
       lines of commented-out grounding rules replaced by 2 terse lines... looks like an
       interrupted edit") - this is very likely leftover from an in-progress Cursor edit that
       never got finished, not anything introduced this session.
     - **Fixed**: restored the detailed grounding rules, fixed the typo, and added a new,
       explicit rule directly naming the exact failure mode observed live - a saved numeric
       salary figure answers "what are your expectations", NOT a separate yes/no "are you
       comfortable with this range" question, even though both mention salary; same for any
       other pair of questions sharing a subject but asking for different things (country name
       vs. phone country code, city vs. full address).
     - **Separate, NOT fixed (data, not code)**: the pasted QA bank itself has other entries that
       look wrong/garbled from past applications - `Are you eligible to work in this country? ->
       +48`, `Do you have a disability? -> 9`, `Do you have the right to work in Serbia? -> 1
       week`, `Security code -> e`, a privacy-notice checkbox answered `85273466004`, `Country ->
       +48`, and (most tellingly) `Where are you currently located...? -> 60000 EUR` - the exact
       same mismatch pattern, just saved into the bank itself instead of happening live. No live
       access to the user's own running companion-service data from here - the user needs to
       review/clean these up via the extension's own Settings -> Q&A tab. The prompt fix above
       reduces how easily GPT reuses a wrong-but-adjacent entry, but doesn't remove already-wrong
       saved entries, which can still get reused correctly-but-wrongly for their own actual
       matching question.
     - Not yet confirmed live - needs a retest of the exact same salary-comfort/salary-expectation
       question pair to see whether GPT now correctly declines to reuse the numeric entry for it.

104. **User pushed back correctly on #103: the prompt wording wasn't the real issue - several
     fields end up unfilled even when GPT generates a reasonable answer for them.** Found a
     genuinely separate, more fundamental bug in how batched GPT answers get matched back to
     their own question: `aiCandidates.forEach((item, i) => { const ans = answers[i]; ... })` -
     ChatGPT's returned answer at array position `i` was matched to the question that had been
     SENT at position `i`, by raw array position, with NO verification the two arrays were even
     the same length. The prompt asks for "one entry per question, in the same order", but
     nothing ever checked ChatGPT actually honored that.
     - If ChatGPT's reply is ever even one entry short, has an extra one, or reorders anything -
       plausible for a large batch, and this form's own batch was large (287-entry Q&A bank,
       many questions) - EVERY answer after the misalignment point silently shifts onto the
       WRONG question. This explains the exact symptom precisely: one skill-level answer
       ("Expert") landing on a completely different question than intended, and several
       questions after it in the same batch ending up totally unfilled (their real answer had
       shifted onto someone else's slot instead, or the shifted-in answer failed THAT other
       field's own options validation and got silently dropped).
     - **Fixed properly, not just patched**: rather than just validating array length (which
       would only turn a silent corruption into an all-or-nothing failure for the whole batch),
       changed the contract so each answer self-identifies which question it belongs to.
       `_BATCH_ANSWER_SCHEMA_CONTRACT` (prompt.py) now requires a `question_number` field per
       answer, matching the number each question was given in the prompt's own numbered list.
       sidepanel.js now builds a `question_number -> answer` map and looks up `aiCandidates[i]`'s
       answer by `i + 1` explicitly, instead of trusting raw array position. One missing or
       misnumbered answer now only costs that ONE question (correctly falls through to "need
       your input", reported via a new generationErrors note with the count) - it can no longer
       cascade and corrupt every answer that came after it in the same batch.
     - Not yet confirmed live - needs a retest of a large batch (many questions in one run, like
       this report's own case) checking that every question gets either its own correct answer
       or an honest "need your input", with no more answers landing on the wrong question.

105. **#104's fix was too strict live**: only 1 question ("Where is your current residence?")
     ever reached ChatGPT this run, ChatGPT answered it correctly ("European Union"), but the
     status text showed `1 of 1 answer(s) came back without a usable question_number`. Root
     cause: the companion-service (a separate Python process) doesn't auto-reload, so it can
     still be serving an OLDER prompt that never asked ChatGPT for `question_number` at all - in
     which case EVERY answer is missing it through no fault of ChatGPT's, and the strict
     rejection added in #104 discarded a perfectly good answer outright. Fixed by falling back to
     that entry's own array position whenever `question_number` is missing/invalid, instead of
     rejecting it - keeps the old (correct, as long as counts genuinely match) behavior working
     when the field isn't there at all, while still using it to guard against misalignment
     whenever it IS present. (Also separately noticed and re-applied #103's own grounding-rules
     restoration to `build_batch_answer_system_prompt` - it had reverted back to the old weak
     wording + "truable" typo somehow between rounds, unrelated to anything requested.)
     - **Second, separate question the user asked and NOT yet answered**: why did the other 3
       required combobox questions ("level of experience with AWS", "years of experience...
       backend systems", the same shape of question as "API architecture" which DID work
       earlier) never even get asked at all - straight to "need your input" without ever
       becoming a GPT/select-pick candidate. Confirmed the field markup itself is structurally
       identical to "API architecture" (same Greenhouse remix react-select, same required
       marker) via a fresh capture, so it's not a structural/markup difference. Means
       `discoverComboboxOptions` is coming back with 0 options for these specific fields
       specifically, causing them to fall through to the generic catch-all with no options
       attached - but why some structurally-identical fields on the same page succeed and others
       don't is still unknown. Added diagnostic logging (`[Auto Fill][combobox-discovery] "<label>"
       -> N option(s) found`) for every required-combobox discovery attempt, to see live which
       fields succeed vs. fail and in what order, instead of guessing at a cause with no
       fields-page-specific data yet.
     - Not yet confirmed live - needs a retest checking BOTH: does the phone/country + salary
       question set now get correctly answered via question_number, and what the new
       combobox-discovery log lines show for the AWS/backend-systems fields specifically.

106. **#105's new logging answered its own question immediately.** Live result:
     `discoverComboboxOptions` found options for only 1 of 5 required combobox fields on the same
     page ("Where is your current residence?" -> 8 options); the other 4 - including "Are you
     comfortable with the salary range?", whose real Yes/No options were separately CONFIRMED to
     exist and be reachable via `tryGreenhouseRemixSelect`'s own retry chain in the exact same
     run - all came back with 0. This is the actual, direct reason the 3 skill-level questions
     never became GPT candidates at all: with no `options` discovered, they can never qualify for
     `selectPickCandidates`, and being comboboxes they're not `canGenerate`-eligible either, so
     they have no path to an answer whatsoever - "need your input" was the only possible outcome
     for them regardless of anything about prompts, question_number, or the QA bank.
     - **Root cause**: `discoverComboboxOptions` only ever tried opening the dropdown ONCE (a
       single `trustedClick` + `simulateClick`), with no fallback if the flyout genuinely never
       opened - unlike `tryGreenhouseRemixSelect`'s own `ensureOpen()`, which is the actual
       proven-reliable mechanism used everywhere else in this file (trustedClick, then
       simulateClick, then ArrowDown, then a trustedClick retry). Option discovery was
       structurally less robust than the fill step itself, despite needing the exact same "does
       this stubborn widget's flyout actually open" reliability.
     - **Fixed**: gave `discoverComboboxOptions` the same multi-step open-retry sequence
       `ensureOpen()` already uses, checking `aria-expanded` between each step instead of
       assuming the first attempt worked.
     - Not yet confirmed live - needs a retest showing the AWS/backend-systems/salary-comfort
       fields now discovering real options instead of 0, and getting stamped as genuine
       select-pick candidates that can actually reach GPT.

107. **#106 confirmed working live - every field now gets answered.** User's next ask: speed -
     the whole run visibly opens/closes comboboxes slowly. Trimmed wait times and retry counts
     in the specific places that were the real cost centers, without touching any of the retry
     LOGIC that just got fixed for reliability over the last several findings:
     - Tier 2 (click-poll): 18 polls x 80ms -> 10 x 60ms. Successful matches exit on poll #0
       regardless (confirmed true in every live log this whole investigation), so this only
       shortens the worst case for a genuine mismatch that was going to fail anyway.
     - Tier 3 (keyboard-nav): 25 steps x 70ms -> 8 x 50ms. Has never once committed successfully
       in any live run on this site across the entire investigation (every real commit came via
       tier 2) - cut way down instead of removed outright, so it still gets a much shorter
       chance on other sites/widgets where it might actually work.
     - Tier 4's clean-close wait: 150ms -> 100ms.
     - `discoverComboboxOptions`'s own open-retry sequence (#106's fix): 250/200/120/220ms ->
       180/150/90/160ms.
     - The final phone/country re-verify wait (#98): 3000ms -> 1200ms - this was sized to wait
       out a delayed Greenhouse-side reset that #106 traced back to unreliable option discovery
       causing repeated failed retries in the first place; now that that's fixed, this wait is a
       cheap safety margin rather than load-bearing, so it didn't need to stay this long.
     - Left tier 1 (React fiber direct) and the overall 4-tier fallback STRUCTURE untouched -
       tier 1 is synchronous with no delay of its own regardless, and changing which tiers run in
       what order is exactly the kind of change likely to reintroduce something #90-#106 just
       spent this many rounds fixing.
     - Not yet confirmed live - needs a retest confirming the run feels meaningfully faster
       AND that reliability holds (every field still gets an answer or an honest "need your
       input", nothing silently breaks from the shorter waits).

108. **Contributor log convention (Claude ↔ Cursor handoff).** `Author: Cursor`. No autofill
    behavior change — documents how assistants should record fixes in this file. When Cursor
    changes product code, append the next numbered finding with `Author: Cursor` (symptom,
    root cause, files/functions, live-confirmed or not, cross-refs to prior `#NN`). Claude
    entries use `Author: Claude` the same way. See the "Contributor log" section at the top
    of this file.

109. **PeopleForce (fotc.peopleforce.io): gpt-auto never opened for required screening
    questions; footer locale picker surfaced as "Powered by PeopleForce".** `Author: Cursor`.
    Reported live: Auto Fill filled 3 profile fields, then listed 7 "need your input" including
    B2B/salary/availability/proficiency questions — but no ChatGPT tab opened.
    - **Root cause 1**: PeopleForce marks required via `<label class="required">`, but the
      label's `for` points at the question text, not the real input id (`field_store_data_*`),
      so `isRequiredField` never fired → every custom question got `canGenerate: false`.
    - **Root cause 2**: Consequential questions (B2B, etc.) are intentionally excluded from
      `canGenerate`, and gpt-auto only batched fields with `canGenerate: true` — so even after
      fixing required detection, B2B/salary still wouldn't reach the batch unless QA matched
      in-pass.
    - **Root cause 3**: Footer `#career_locale` language `<select>` resolved its label from
      nearby "Powered by PeopleForce" footer text.
  - **Fixed**: `isRequiredField` walks up to a sibling `label.required`; stamp
      `gptBatchEligible` separately from `canGenerate`; gpt-auto batches
      `gptBatchEligible` fields (batch prompt still uses QA bank — consequential answers come
      from saved entries, not invented). `field-detector.js`: exclude `#career_locale`, resolve
      pf-phone-number label from `label[for="career_application_form_phone_numbers"]`. Expanded
      `CATEGORY_PATTERNS` / `MATCH_CATEGORY_PATTERNS` for monthly rate, availability-to-start,
      B2B contract, Polish proficiency.
    - **Verified offline** via `test-detect.mjs` on capture
      `fotc-peopleforce-io-20260811T054719Z.html`: 9 real fields, phone labeled, locale picker
      gone. **Not yet confirmed live** that gpt-auto now opens for the screening batch.

110. **SAP SuccessFactors (career55.sapsf.eu): discovery worked but fills didn't stick;
    gender split into 3 fields; QA category leaked +48 onto work-auth picklists.** `Author: Cursor`.
    Reported live: 14 filled (7 matched, 7 generated), 16 "need your input" including passwords,
    gender option labels, marketing checkboxes, and SF paginated picklists (Country, Phone Type,
    State). Console `[combobox-discovery]` logs showed options found for most picklists — discovery
    was fine; commit verification was not.
    - **Root cause 1**: `comboboxValueCommitted` / `reactSelectDisplayValue` only understood
      react-select `__single-value` nodes — SF RCM picklists commit via the visible input's
      `title` + hidden `tor__f*` value, so every SF pick looked "not committed" after click even
      when the DOM had updated (e.g. `title="Yes"` on legal-auth).
    - **Root cause 2**: SF Gender uses `<ul role="radiogroup" aria-labelledby="…">` with
      `label_tor__fgender` in the table — not a `<fieldset>`, so `collectRadioCheckboxGroups`
      left "No Selection"/"Female"/"Male" as three separate unmatched fields.
    - **Root cause 3**: `authorized_to_work` category regex also matched bare "Eligible to Work",
      letting category-match pull unrelated QA answers; dial-code-shaped values like `+48` were
      not rejected for yes/no picklists.
    - **Root cause 4**: State/Province stays `disabled` until Country commits — singles loop ran
      once up front while State was still disabled.
    - **Fixed**: SF-aware `reactSelectDisplayValue` / `comboboxValueCommitted` /
      `isReactSelectAlreadySet` (both injected copies); radiogroup + `label_tor__*` grouping;
      `isAutofillExcludedField` for passwords/marketing/middle name; split `eligible_to_work`
      category; `isPlausibleQaComboboxAnswer`; post-pass SF State re-scan after Country; trim
      `needsHuman` report noise. **Not yet confirmed live** on career55.sapsf.eu.

111. **PeopleForce (adroiti.peopleforce.io): phone not filled; footer locale and salary
    currency chrome in "need your input".** `Author: Cursor`.
    Reported live: 4 filled, 4 need your input — `(no label)`, Links, `(no label)`, Powered by
    PeopleForce — phone number left empty.
    - **Root cause 1**: `pf-phone-number` widget splits country (globe dialog) + visible tel
      input; plain `nativeSet`/`setPhoneValue` never committed to Vue. Visible tel id uses
      brackets (`career_application_form[phone_numbers][]`) so `label[for=id]` fails when the
      pf-phone label resolver misses.
    - **Root cause 2**: Hidden sync `input[type=tel][hidden]`, readonly currency display
      (`EUR - Euro`), and `#career_locale` footer picker still surfaced as bogus fields.
    - **Fixed**: `fillPeopleForcePhone()` (dial-code dialog + local number + hidden sync);
      `matchStructuredField` fallback for any `pf-phone-number` input; stronger label lookup;
      exclude pf-phone hidden/button/currency/search/locale from detection. Links maps to
      linkedin/website when present. **Verified offline** on
      `adroiti-peopleforce-io-20260811T064457Z.html`: 6 real fields, phone labeled, locale/currency
      gone. **Not yet confirmed live**.

112. **Diagnostics: console capture + structured run logs + platform testing workflow.**
    `Author: Cursor`. User feedback: autofill slower than manual; need platform-by-platform
    fixes with better logs. Added `console-capture.js` (injected before field-detector on
    Auto Fill / Learn / Save Sample); `[Auto Fill][run|detect|filled|unmatched|summary]` logs
    at end of `runAutofillInPage`; Save Sample writes `*.console.log` beside HTML/JSON.
    Workflow doc: `extension/test-forms/PLATFORM_TESTING.md`.

113. **Platform priority: Tier-1 major ATS first (Greenhouse, Workday, Lever, SR, Ashby,
    BambooHR, Teamtailor).** `Author: Cursor`. ~185 unique Save Sample pages (~525 HTML incl.
    frames); Tier-1 ≈ 93 (50%). Strategy: fix shared engine per platform, sweep all captures
    for that host as regression suite — not 185 hand-fixes. Added `tools/platform-inventory.mjs`;
    updated `PLATFORM_TESTING.md` with ordered queue and Tier-2 deferral (PeopleForce, SF, …).

114. **ChatGPT batch-answer replies with stray trailing text after otherwise-valid JSON crashed
    the whole batch.** `Author: Claude`. Reported live on 3m-consultancy Zoho: raw reply
    `{"answers":[...]}_]().`  - `JSON.parse` rejects the WHOLE string the instant anything
    follows the closing brace, discarding a fully-correct batch of answers over a few stray
    trailing characters. A prior fix (`Author: Cursor`, plain `indexOf("{")`/`lastIndexOf("}")`
    slice) handles this exact shape but breaks if any answer string itself contains a literal
    `{`/`}` (an answer mentioning code, JSON, etc.) - `lastIndexOf` would grab the wrong brace
    entirely. Replaced with `extractFirstJsonValue` (new helper near `stripJsonFences`): scans
    from the first `{`/`[`, tracks real bracket depth while ignoring anything inside string
    literals, and returns the first balanced span regardless of what either the JSON content or
    the trailing garbage contains. Applied at both call sites that parse a raw ChatGPT reply
    (resume-generation and batch-answer). Not yet confirmed live against the exact repro.

115. **`chrome.debugger.attach()` in `background.js`'s `TRUSTED_CLICK` handler had NO timeout at
    all - a regression of an earlier, already-fixed bug.** `Author: Claude`. Reported live on
    3m-consultancy Zoho: single combobox fill attempts taking 60-90+ seconds each (multiple
    minutes total across a handful of fields), with no error ever surfacing anywhere. Root
    cause: `attach()` can hang INDEFINITELY rather than reject when it hits Chrome's own
    concurrent-debugger-session limit (this exact failure mode was found and fixed earlier in
    this project's history with a timeout race, but that fix is absent from the current
    `background.js` - lost in a later rewrite, not something removed deliberately). Fixed by
    racing `attach()` against a 4s timeout; on timeout, falls back to `sidepanel.js`'s own
    non-trusted-click paths (fast, normal failure) instead of hanging silently for minutes with
    nothing to show for it. Best-effort cleanup attempt if a late attach lands after the race
    already gave up. Not yet confirmed live.

116. **Optional combobox/picklist fields were still getting the full slow multi-tier retry
    treatment via the structured-profile-value path, bypassing the "skip if optional" guard
    entirely.** `Author: Claude`. Reported live on the SAME 3m-consultancy Zoho page (user:
    "filling unrequired field, why?"): the optional "Current Job Title" picklist (real options:
    `-None-`/`Fresher`/`Project-Lead`/`Project-Manager`) got the profile's own free-text headline
    ("Senior Software Engineer at Endava") thrown at it via `fillSingle` - which for any
    combobox-shaped element unconditionally calls the full `fillReactSelectByClick` retry chain
    regardless of required status. That guessed value obviously matched none of the 4 real
    options, so it burned through every fallback tier (including a live debugger-attach
    `trustedClick` cycle, see #115) before settling on `-None-` anyway - for a field the
    applicant didn't need filled at all. An existing guard (`Author: Cursor`,
    `!isRequiredField(...) && !qaAnswerUsable`, its own code comment references this same
    3m-consultancy Zoho repro) already protects the LATER discovery-and-stamp-for-AI branch, but
    that guard runs after this earlier structured-value attempt, so it never got a chance to
    prevent it. Fixed by skipping the structured-value attempt entirely when `looksLikeComboboxPick(element)
    && !isRequiredField(element, host)` - a free-text profile value can only ever match a fixed
    option list by coincidence, so there's no reason to force a guess into an optional field.
    Not yet confirmed live.

117. **Phenom (careers.adobe.com) required native selects + checkboxes were left empty —
    same Workday-style fields, different widgets.** `Author: Cursor`. Capture
    `careers-adobe-com-20260813T100512Z`: Auto Fill reported 13 filled while **Phone Device
    Type**, **Country Phone Code**, and three required lone checkboxes (marketing *, privacy
    consent, certify-accuracy) stayed on Please Select / `ischecked="false"`. Root causes:
    (1) `isPhoneDialCodePicker` only recognized Greenhouse `.phone-input__country` and Oracle
    HCM prefix widgets — Phenom's native `<select id="phoneWidget.countryPhoneCode"
    autocomplete="tel-country-code">` was stamped for GPT with ~200 country options instead of
    picking `Poland (+48)` from the profile. (2) Structured phone regex explicitly excludes
    labels containing `type|device`, so Phone Device Type (Mobile / Personal) never got a
    default. (3) Lone required checkboxes: certify text has no agree/consent/privacy, so
    `CONSENT_RE` missed it; even matching privacy boxes need a wrapping-`<label>` click plus
    Phenom's `ischecked` attribute, not a `.checked` write alone. Fixed by recognizing native
    tel-country-code selects and filling them with country/(+code), defaulting Phone Device
    Type to Mobile, auto-checking required/consent/certify lone boxes via label click, and
    reading the filled native select in `findCountryCallingCode` so the number field can drop
    the duplicate `+48`. Not yet confirmed live.

118. **Workable English conversation level was filled with the site locale
    `English US ‎(English US)‎` instead of Fluent.** `Author: Cursor`. Capture
    `apply-workable-com-20260813T101015Z`: first-pass Auto Fill reported `learned` for
    "What is your english conversation level?" with that locale string (bidi marks included —
    the same shape as Workable/Chrome language-switcher labels). A proficiency question
    category-matched a poisoned QA-bank row (or an exact Learn of the pre-filled locale
    textarea) instead of the real "Fluency in English → Fluent" entries. Fixed by treating
    `English US (English US)` / `English (United States)` as UI-locale answers: drop them from
    the autofill QA bank, skip them in `matchQaBank` / `isPlausibleQaComboboxAnswer`, don't
    Learn them onto proficiency questions, and default remaining English/Polish level
    free-text to Fluent. Not yet confirmed live.

119. **Greenhouse remix (job-boards.greenhouse.io/lokainc) open/close loop + phone focus
    thrash.** `Author: Cursor`. Capture `job-boards-greenhouse-io-20260813T112331Z`.
    Reported live: Auto Fill kept opening and closing dropdowns, focusing Phone over and over,
    and looking stuck in a loop. Causes (all from that console log):
    - **Phone / Country**: after the remix `#country` combobox already showed `+48`,
      `setPhoneValue`'s intl-tel-input DOM fallback still opened the 240-country flag list
      (~20s of focus). Later hear-about ArrowDown leaked into Country (`+48` → `+1`).
      `comboboxValueCommitted` treated *any* `+NN` as success, so the phone-country-only
      second pass skipped Poland (`skip display already committed` with `+1`).
      `checkPhoneCountryPickerInPage` only queried `.phone-input__country` (remix uses
      `#country` in `.select-shell`).
    - **Location (City)**: typed `"Warsaw, Poland"`; GH Places returned 0 hits for ~35 polls.
      Bare `"Warsaw"` maps immediately to `"Warsaw, Mazowieckie, Poland"`.
    - **Privacy Policy**: only real option is `Confirm`. Three consent loops tried
      `I agree` / `Yes` / `Agree` / `Accept`, each a full open/close (11–18s gaps), because
      matchOption's agree/accept/consent regex missed `Confirm`.
    - **Hear about**: `"Where did you first find out about this job?"` missed
      `hear_about` (`did you hear` only). GPT later emitted `"LinkedIn Ad"` which is not in
      the 29-option list, then 4-tier retry including ArrowDown.
    - **Yes/No skills**: discovery found `[Yes, No]` but `inferSkillExperienceYesNo` returned
      null (essay QA rejected), so retry picks were empty and fields waited for GPT.
    Fixed: skip iti flag UI when a separate Country combobox exists; treat remix `#country`
    as a dial picker; require the displayed code to be a prefix of the profile phone;
    query `#country` in the final re-check; Places query = city only; one-shot consent via
    fiber `Confirm`; map LinkedIn/LinkedIn Ad → first LinkedIn option; expand hear_about +
    skill Yes/No infer. Not yet confirmed live.

120. **Apaleo Greenhouse hear-about got the LinkedIn profile URL; relocation plans still
    treated as a city Places field.** `Author: Cursor`. Capture
    `job-boards-greenhouse-io-20260813T124048Z`. "How did you hear about this opportunity?
    … (e.g., Apaleo website, WeAreDevelopers, LinkedIn…)" matched the structured `/website/`
    pattern and filled `https://www.linkedin.com/in/…` (source `profile`). The LinkedIn-as-
    example fix from an earlier apaleo run never covered `website`. "Current location and
    relocation plans" (Based in Germany / outside the EU …) still had `\blocation\b` so
    `isLocationAutocomplete` typed QA "Romania" and picked "Select…". Fixed: website/portfolio
    structured match only for fields that ASK for a URL; skip any `http` value on hear-about;
    exclude relocation-plans from Places; map "Based in {country}" when that option exists
    (Romania has no matching option among those three — leave for the applicant). Not yet
    confirmed live.

121. **HiBob careers (muchbetter.careers.hibob.com): Attach Resume opened a dialog; Yes/No
    radios never filled.** `Author: Cursor`. Capture `muchbetter-careers-hibob-com-20260813T124619Z`.
    Auto Fill reported 4 text fields only (`groups=0`). Causes:
    - **Radios**: `<careers-ui-yes-no-question-control>` uses clipped `.brd-input` radios
      (`clip:rect(0 0 0 0); 1×1px`) inside `role=radiogroup` with no `aria-labelledby`. The
      question lives on a sibling `.label`. Group detection dropped them (`if (!groupLabel)
      continue`); `isVisible` then dropped the 1px inputs; leftover `tabindex="-1"` lone
      boxes are skipped as Ashby decoys. Same for consent `.bchk-input`.
    - **Attach**: `revealHibobAttachmentInputs` clicked the first `<button>` — when a file
      is already shown that's **Delete**, which opens a confirm dialog (the "form in a
      dialog"). Add file actually opens a CDK overlay where the real `<input type=file>` lives.
    Fixed: HiBob Yes/No group label from `.label`; treat `.brd-input`/`.bchk-input` as visible
    when the sibling label is; click `label[for]`; Attach only clicks "Add file", waits for
    overlay file input / Browse, confirms Attach/Save; if only Delete exists, remove then
    Add file. Not yet confirmed live.

122. **Loka Greenhouse (job-boards.greenhouse.io/lokainc): "Where did you first find out
    about this job?" opened 100+ times.** `Author: Cursor`. Capture
    `job-boards-greenhouse-io-20260813T130714Z`. The widget is a react-select **multi-select**
    (`id=question_4391086007[]`, `select__value-container--is-multi`). Options are
    "linkedin inmail" / "LinkedIn Post" / "LinkedIn Ad" — not the literal `"LinkedIn"` the
    filler tried because the profile has a LinkedIn URL. Includes-match clicked a LinkedIn-*
    row (capture even shows a "LinkedIn Ad" chip), but `reactSelectDisplayValue` only read
    `__single-value`, so verify always saw `display=""` and treated the pick as failed.
    Clicking the same multi-select option again **toggles it off**. Remix then returned
    `false` (not `"no-match"`), so the generic type/wait path ran ~45 more clicks plus
    `trustedClick` — the ~94s gap `13:04:26` → `13:06:00` with no combobox-retry logs.
    Discovery then retried `"LinkedIn"` *before* `"LinkedIn Post"`. Same log: "What Country
    are you currently based in?" (197 countries) was classified as `relocation` because
    `currently based` matched, QA "Yes" was deferred, retry picks were empty — should have
    been Romania from `profile.contact.country`.
    Fixed: read `__multi-value__label` chips; fiber `isMulti` onChange passes an array;
    remix returns `"no-match"` after a 4-tier fail so we don't fall through; hear-about
    picks a real LinkedIn-* option (Post/Ad/inmail) and never retries bare `"LinkedIn"`;
    relocation regex no longer matches country "currently based in" lists. Not yet
    confirmed live.

123. **Same Loka hear-about: still typed every LinkedIn-* label and toggled chips.**
    `Author: Cursor`. After #122 the widget still opened 10+ times: it typed
    "LinkedIn Post", then "LinkedIn Ad", then "LinkedIn Jobs", and clicking a
    multi-select option that was already on **removed** it. Causes:
    - `reactSelectDisplayValue` read the filter `<input>` *before* chips, so typed
      text looked "committed" and the next pass typed a sibling label.
    - LinkedIn family/includes matching treated "LinkedIn Ad" as a hit on
      "LinkedIn Post" (and vice versa), so each retry clicked a *different* row.
    - Type-to-filter + GPT retry walked every LinkedIn-* option.
    Fixed: chips before filter text; ignore Greenhouse input.value; only family-match
    bare `"LinkedIn"`; never type-filter hear-about; don't click an already-selected
    option (toggle); one hear-about attempt (`data-af-hear-about-tried`); GPT/QA
    coerce to a single LinkedIn-* option. Not yet confirmed live.

124. **Cloudbeds Greenhouse (job-boards.greenhouse.io/cloudbedsthirdpartyboard): skill Yes/No
    guessed No; salary left for the applicant.** `Author: Cursor`. Capture
    `job-boards-greenhouse-io-20260813T133132Z`. Profile this run: Gabriel Barbosa.
    Result: filled 15 (3 generated); 1 need-input: "What are your salary expectations?".
    Skill Yes/No used `inferSkillExperienceYesNo`: Python/TypeScript → Yes, but React Native /
    Expo / payment / fiscalization → No because the matcher required the exact phrase
    (`blob.includes("react native")` fails when the resume only says React) and unknown
    stacks defaulted to No. A first-pass family map (TypeScript → React Native) was the
    wrong fix — that would Yes every adjacent stack. Fixed: tokenize the question, word-
    boundary match against resume+summary, and only treat *equivalent names* as the same
    skill (react.js/reactjs → react, react native → react, k8s → kubernetes, node.js →
    node, postgres → postgresql, ci/cd → cicd). TypeScript alone does not imply React
    Native. Also classify "Experience owning …" as skill_experience so Terraform/Docker/K8s
    is not skipped. Salary: GPT batch had been setting `answerable: false`; the batch
    prompt now ALWAYS answers salary/notice (no local/JD invented figure in the extension).
    Companion `reload=False` — restart `python3 run.py` for the prompt. Not yet confirmed
    live.

125. **Loka Greenhouse (job-boards.greenhouse.io/lokainc): Location (City) empty; skill
    Yes/No filled No.** `Author: Cursor`. Capture `job-boards-greenhouse-io-20260813T133621Z`
    (Dragos Radu). Places typed "Bucharest" and aborted at poll#10 still-loading (~2.4s);
    the same query succeeded at poll#8 on `20260813T130714Z`. Cause: a 12-poll cap plus
    skipping `readOptions` while any `__loadingIndicator` was visible. Fixed: read options
    even while the spinner shows; wait up to ~8s while loading; abort empty (non-loading)
    waits quickly. Skill Yes/No ("Do you have professional experience with Python and SQL…",
    "…AWS…") had been answering No via per-tech resume matching. Don't hardcode tools in
    code: "do you have experience with …" Yes/No → **Yes**. If QA has no answer and it
    isn't that pattern, leave it for GPT. Not yet confirmed live.

126. **Loka Greenhouse Attach Resume: `uploadFile` of undefined.** `Author: Cursor`.
    `Resume file attached (Dragos_Radu.pdf) → Resume/CV*` then the page threw
    `Cannot read properties of undefined (reading 'uploadFile')`. Remix
    `.file-upload` (`data-allow-s3="false"`) still runs a change handler that
    calls `uploader.uploadFile`. Fixed: if a React-fiber `uploadFile` exists, call
    it; otherwise set `input.files` and do not fire change/input. Location Places
    extra keyboard/pac-item work reverted (slow network); wait a bit longer (~10s)
    while the spinner is up.

127. **Loka Greenhouse Attach Resume still not attached (fake filename).** `Author: Cursor`.
    Capture `job-boards-greenhouse-io-20260813T143502Z`. After #126 the toast said
    `Resume file attached (Dragos_Radu.pdf) → Resume/CV*` but the widget still showed
    Attach / Google Drive / Enter manually plus a painted `data-af-resume-name` div.
    Root cause: `data-allow-s3="false"` is FileUpload's unused default (Field never
    passes `allowS3`); S3 uploaders are still created by `fetchFields` →
    `JBEN_URL/uncacheable_attributes/presigned_fields`. Submit (`Na()`) only sends
    `resume_url` from React `{file:{name,url}}`, not the native `<input type=file>`.
    #126 skipped `change` and never waited for `uploadManager.uploaders.resume`, so
    the form never got a URL. Fixed in `attachResumeFileInPage` /
    `greenhouseRemixAttach`: wait for the real uploader (and retry `fetchFields` if
    empty), then fire change so GH's own handler uploads and swaps in
    `.file-upload__filename`. No fake name. Fail instead of claiming success.
    Not yet confirmed live.

128. **Attach Resume: "Greenhouse resume uploader did not initialize (S3 presign)".**
    `Author: Cursor`. Live after #127: Attach Resume failed immediately with that
    message and never put a file on Resume/CV*. Root cause: #127 waited for
    `uploadManager.uploaders.resume` on React fiber from isolated-world
    `executeScript`. That fiber is not readable there (same as Autofill "tier 1
    React fiber" never committing on these boards), so change never ran. Before
    #126/#127, set `input.files` + `change` was enough — the page handler uploads.
    Restored that path; retry change if the widget is still empty; succeed only
    when `.file-upload__filename` appears. Not yet confirmed live.

129. **Pod Point Pinpoint (careers.pod-point.com): address fields all got postcode
    `02-472`; Questions section left blank.** `Author: Cursor`. Capture
    `careers-pod-point-com-20260813T152008Z`. Address Line 1/2, Town, and Postcode
    have no `label[for]`; `resolveOwnLabel` used the section `<legend>` "1. Personal
    Details…" and QA-matched that heading to stored postcode `02-472`. Country
    already showed Poland so it was skipped. Questions (Right to Work, pronouns,
    disability, reasonable adjustments, referred Yes/No) were not in
    `singles=11 groups=0`: Pinpoint `.checkable-input` radios fail the 1px
    visibility check, and section legends would have stolen radio group labels.
    Fixed: Pinpoint `.external-form__label` sibling labels; ignore numbered
    section legends; treat `.checkable-input` / `.react-select__control` as
    visible; map Postcode/Town/Address Line 1 from profile; Line 2 stays empty;
    `right to work` + `reasonable adjustments` categories; referral Yes/No → No.
    Right to Work is a visa-status list — do not fill QA "No". Not yet confirmed
    live.

130. **SmartRecruiters screening (jobs.smartrecruiters.com Redcare): English level left as
    `(no label)`; GitHub link asked for input; EU/Germany Yes/No never detected.**
    `Author: Cursor`. Capture `jobs-smartrecruiters-com-20260813T160201Z`.
    - **English select**: question text is `<span slot="label-content">` on
      `sr-question-field-select`, not on nested `spl-autocomplete` (`label=""`). Inner
      `spl-input` lives in that autocomplete's shadow, so `closest()` never reached the
      light-DOM slot (`(no label)`). Menu was already open; `findComboboxOptions` saw
      `aria-controls` listbox, found no light-DOM `[role=option]`, and returned `[]`
      (`combobox-discovery "" -> 0`). Fixed: `closestCrossingShadow`; read container slot
      / `aria-label` minus `"Select "`; pierce `spl-select-option` even when the menu was
      already open; default Fluent once the label matches.
    - **GitHub**: pattern matched `"Please add your GitHub link / account details"` but
      `ContactInfo` has no `github` and website was LinkedIn, so structured value was
      null and `canGenerate=false`. Now scrape `github.com/{user}` from the whole profile
      and fill a URL; if still empty, do not block GPT.
    - **Radios**: `collectSplRadioGroups` required `name^="question_"`; live radios have
      `name=""`. Group by `spl-radio-group`. "Eligible to work in the EU?" (Poland → Yes)
      and "reside in Germany?" (Poland → No). Not yet confirmed live.

131. **SmartRecruiters required vs optional was wrong.** `Author: Cursor`. Same Redcare
    capture. GitHub and "reside in Germany?" are `required: false` in
    `sr-screening-questions-form` `definition` (no `required=""`, no `*`,
    `aria-required="false"`). English level and EU eligibility are `required: true`.
    `isRequiredField` never read that JSON or the host `required` attribute — optional
    GitHub still went to "need your input" via structured-null, and Save Sample labeled
    the empty English select `"Value is"` from the `"Value is required"` error slot.
    Fixed: `isSmartRecruitersRequiredField` uses definition JSON first, then host
    `required` / asterisk / fieldset `aria-required`; optional SR radios are not stamped;
    ignore `"Value is required"` chrome as a label. Not yet confirmed live.

132. **Website field got LinkedIn URL.** `Author: Cursor`. Structured website/portfolio
    pattern used `p.contact.website || p.contact.linkedin`, so a separate Website field
    was filled with the LinkedIn profile when website was empty. Fixed: website/portfolio
    only use `contact.website`; LinkedIn stays on LinkedIn fields. Also reject a
    `contact.website` that is itself a linkedin.com URL. Not yet confirmed live.

133. **SmartRecruiters screening still failing (Redcare 20260813T180741Z): radios
    invisible; English fake-filled; notice/salary left for input.** `Author: Cursor`.
    Profile: Stefan Iacob (Bucharest, Romania). Log: `groups=0 singles=4`, English
    "Native / Advanced" reported learned but input stayed empty, notice+salary
    `canGenerate=true` never gpt-filled.
    - **Radios**: `<spl-radio>` lives inside `sr-screening-questions-form` open shadow —
      `document.querySelectorAll("spl-radio")` returned []. Fixed: deep shadow walk +
      `closestCrossingShadow` for group labels. EU eligibility Yes for any EU residence
      country (not Poland-only — Romania).
    - **English**: QA "Native / Advanced" tried as exact option; fill returned true without
      a committed display. Fixed: discover options, coerce to Native/Fluent, only count
      filled when display is non-empty.
    - **Notice/salary**: stamp/`data-af-idx` lookup missed shadow inputs; empty model
      answers were silent. Fixed: deep `data-af-idx` query; surface generationErrors when
      salary/notice return no answer. Not yet confirmed live.

134. **Pod Point Pinpoint (careers.pod-point.com 20260813T181131Z): Country left as
    Poland; optional Gender/Ethnicity open/close thrash; required Right to Work
    skipped.** `Author: Cursor`. Profile: Stefan Iacob (Romania). Filled 12 (3 matched)
    but never logged Country; Gender/Ethnicity each burned discovery+GPT while the page
    marks them `required:false` under optional equality monitoring.
    - **Required detection**: Pinpoint uses `.external-form__label--required` (and
      react-on-rails `required` JSON), not native `required` on react-select inputs.
      `isRequiredField` treated Country + Right to Work as optional → residence Country
      structured value was nulled and silently `continue`d; RTW never discovered.
      Fixed: `isPinpointRequiredField` in field-detector.js.
    - **Country**: also exempt residence Country from the "skip optional combobox
      structured fill" guard so profile `contact.country` always overwrites a wrong
      default (Poland → Romania).
    - **Optional EEO**: `shouldSkipOptionalDemographic` skips Gender / Ethnicity /
      Sexuality / Religion / Age / equality_monitoring / optional disability self-ID
      even when QA has Male/White — no open/close. Required Disability Confident still
      fills. Not yet confirmed live.

135. **SmartRecruiters: do not fill optional screening fields.** `Author: Cursor`.
    User request: optional SR fields need not be filled. Definition already marks GitHub /
    "reside in Germany?" as `required:false` — radios were skipped from "need your input"
    but optional singles (e.g. GitHub) could still get a profile URL. Fixed: when
    `isSmartRecruitersRequiredField === false`, skip profile/QA/GPT for that single or
    group entirely. Required English / EU eligibility still fill. Not yet confirmed live.

## Known gaps (not yet acted on)

- `Profile` schema (`companion-service/app/schemas.py`) has no fields for: nickname/preferred
  name, pronouns, birthday, desired salary. Several ATSs ask for these.
- The QA-bank matcher (`matchQaBank`) is still a crude word-overlap heuristic outside the
  small set of `CATEGORY_PATTERNS` below. It's been tightened to require 2+ shared
  significant words (or an exact normalized match) after testing turned up a false positive
  — a bare "Country" field matched an unrelated "are you legally authorized to work in this
  country" QA-bank entry on a single shared word — but it's still not a semantic matcher and
  could still misfire on short, generic labels outside the categorized ones.
- **Fixed**: react-select-style Yes/No comboboxes (New Relic's "Have you ever been employed
  by New Relic?", "...require sponsorship...?", etc.) weren't filling even with an obviously
  applicable QA-bank default like "Have you ever worked at this company before? → No" — two
  compounding causes, both fixed. (1) Plain word-overlap can't bridge different companies'
  wording of the same boilerplate question (employed≠worked, "New Relic"≠"this company") — a
  new `CATEGORY_PATTERNS`/`detectCategory()` regex layer in `matchQaBank` now matches by
  category (worked_here_before / currently_employed_here / authorized_to_work /
  requires_sponsorship) when the literal words don't overlap enough. (2) Even matched,
  there was no mechanism to actually *fill* a react-select — added
  `fillReactSelectByClick()`, which clicks the control, waits for React's async menu render,
  and clicks the option whose text matches. Its target classes are derived from the
  control's own `classNamePrefix` (visible already on the closed control, e.g.
  `select__control`) rather than guessed, since react-select always names every sub-element
  from that same one prefix — falls back to a generic `[role="listbox"]`/`[role="option"]`
  search if no prefixed classes are found. First version used `.click()` and passed a
  synthetic test — but still silently failed live on a real page with the QA bank correctly
  populated. Root cause: **react-select opens its menu on `mousedown`, not `click`** (a
  well-documented quirk of the library — it's why every react-select testing guide mentions
  the same workaround); a programmatic `.click()` only ever dispatches a "click" event, which
  react-select's own handlers never see, so the menu never actually opens. Fixed by firing a
  full `mousedown`/`mouseup`/`click` sequence instead (`simulateClick()`), matching what a
  real user's click naturally produces — harmless for anything listening for plain "click"
  too. This is also why the earlier "verified with a synthetic test" claim for this feature
  was too strong: the mock listened for `click`, not `mousedown`, so it validated the
  option-matching logic but not the actual interaction protocol real react-select requires.
  Redid the test listening for `mousedown` instead, and confirmed the old `.click()`-only
  code produces exactly the reported symptom (`"filled": []`, every field left as
  "needs your input") against that faithful mock, while the fixed code correctly fills both
  non-consent fields — proof the test discriminates rather than trivially passing either way.
  "Country of residence"/"State" from `greenhouse-newrelic-PARTIAL.html` still aren't handled
  — those need a real, non-Yes/No option list (not yet captured, dropdown was seen closed)
  plus a QA-bank entry to match against, neither of which yes/no category patterns cover.
- The New Relic Greenhouse form's split "Country" (calling code) + "Phone" (number) fields
  aren't kept in sync by anything in this codebase — `setPhoneValue()` correctly drives the
  "Phone" field's own intl-tel-input widget, but the separate "Country" combobox is a
  different field entirely and is left unfilled (safe, but incomplete). Could plausibly be
  derived from the profile's own phone number or location without fabricating anything, but
  not implemented since it requires the react-select listbox-driving gap above to actually
  fill it once derived.

## Automated capture (`captured/` subfolder)

As of the "Save Sample" button in the side panel, samples can also be captured directly
from real usage instead of copy-pasting into chat. Clicking it runs the same DETECT+MATCH
logic as Auto Fill (read-only — it never fills the page) on every frame, then POSTs the
result to a new `POST /save-sample` endpoint (`companion-service/app/main.py`), which writes
each frame as a `<host>-<timestamp>[-frame<N>].html` + matching `.json` pair into this
`captured/` folder. The `.json` sidecar records `page_url`, `frame_url`, `frame_id`,
`captured_at`, and the `fields` array (`label`, `type`, `source`: `profile`/`learned`/
`unmatched`, `value`). Unlike the hand-curated fixtures above (which were picked for their
distinctive bugs and are meaningfully annotated), `captured/` accumulates automatically and
is meant as raw material for a later batch pipeline — not itself hand-annotated.

## Capturing more samples

`copy(document.body.outerHTML)` in the DevTools console is faster than manual
Inspect→Copy. **For large modern SPA pages** (heavy component frameworks, embedded country
lists, etc.) — paste can hit a ~50K character chat message limit. Save as a file instead
(in the shared folder, so it can be read with no size limit) rather than pasting inline.
