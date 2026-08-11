# Platform-by-platform autofill testing

Goal: each ATS reaches **100% of fillable fields** with **zero manual input** on a real
apply form. Fix the **hard platforms first** (they cover most saved samples), then sweep
every capture for that platform before moving on.

## Scale (saved samples)

Run `node tools/platform-inventory.mjs` for current counts. As of last inventory:

| Metric | Count |
|--------|------:|
| HTML files on disk (incl. iframe frames) | ~525 |
| **Unique apply pages** (json deduped) | **~185** |
| Tier-1 major ATS pages | ~93 (**50%** of unique) |

So “100+ templates” is right — most volume is **Greenhouse, Workday, Lever, SmartRecruiters,
Ashby, BambooHR, Teamtailor**. Smaller ATSs (PeopleForce, SAP SF, Zoho, …) are real but
**Tier 2** until Tier 1 passes the full sweep.

## Tier 1 — fix these first (hardest, most samples)

Work **one platform at a time**. For each: fix core detection/fill → **sweep all captures**
for that host → one live re-test → mark done in this table.

| Order | Platform | Host patterns | ~Samples | Known hard parts | Status |
|------:|----------|---------------|---------:|------------------|--------|
| 1 | **Greenhouse** | `*.greenhouse.io`, `job-boards.greenhouse.io` | 22 | Remix react-select, EEO comboboxes, phone dial-code, location async | Partial (#86 combobox stack) |
| 2 | **Workday** | `*.myworkdayjobs.com`, `*.myworkday.com` | 31 | Multi-step, date spinbuttons, country→state swap, experience panels | Partial |
| 3 | **Lever** | `*.lever.co`, `jobs.lever.co` | 3 | Label-less textareas, ✱ required marker, ancestor label climb | Partial (#18) |
| 4 | **SmartRecruiters** | `*.smartrecruiters.com` | 12 | Shadow DOM `spl-*`, location autocomplete | Partial |
| 5 | **Ashby** | `*.ashbyhq.com`, `jobs.ashbyhq.com` | 15 | Button-group Yes/No, debounced GraphQL save, comboboxes | Partial |
| 6 | **BambooHR** | `*.bamboohr.com` | 8 | Fabric select, country→province DOM swap, file upload | Partial |
| 7 | **Teamtailor** | `*.teamtailor.com` | 2 | Range sliders, checkbox groups | Partial |

**Tier 1 done** = every row above shows `Verified` and `sweep-captured` reports 0 regressions
for that platform’s captures.

## Tier 2 — after Tier 1 is green

PeopleForce, SAP SuccessFactors, Zoho, Rippling, HiBob, iCIMS, Workable, Recruitee, Comeet,
and “other” long-tail hosts. Same workflow; lower priority until Tier 1 sweep is clean.

## Workflow (per platform)

1. **Inventory** — `node tools/platform-inventory.mjs --list=greenhouse` (or workday, …).
2. **Pick worst live URL** for that ATS (or worst failing capture from sweep).
3. **Reload extension** after code changes.
4. **Auto Fill** (Alt+F) → check side panel + DevTools console (`[Auto Fill]` filter).
5. **Save Sample** (Alt+S) → HTML + JSON + **`.console.log`**.
6. **Offline** (from repo root; use mount path if captures live there):
   ```bash
   node tools/platform-inventory.mjs /mnt/hgfs/auto-apply/job-apply-project/extension/test-forms/captured
   node tools/test-detect.mjs /path/to/capture.html
   node tools/sweep-captured.mjs /mnt/hgfs/auto-apply/job-apply-project/extension/test-forms/captured --json tools/sweep-report.json
   ```
7. **Fix** only that platform’s detection/fill paths; append finding to `NOTES.md` (`Author: Cursor`).
8. **Re-sweep all Tier-1 captures** for that platform until detection + first-pass fill stats improve.
9. **Live verify** one fresh apply URL; mark **Verified live** in this file + NOTES.

## What gets logged

| Tag | Meaning |
|-----|---------|
| `[Auto Fill][run]` | Autofill started on this frame |
| `[Auto Fill][detect]` | Field counts after detection |
| `[Auto Fill][filled]` | Field filled (source + label + value preview) |
| `[Auto Fill][unmatched]` | Left for user/GPT (options count if combobox) |
| `[Auto Fill][summary]` | End-of-pass totals |
| `[Auto Fill][combobox-discovery]` | Combobox option discovery |
| `[Auto Fill][combobox-retry …]` | Combobox fill tiers (Greenhouse etc.) |

**Tip:** Auto Fill → then Save Sample — `.console.log` stores that run’s buffer.

## Definition of done (one platform)

- [ ] All **unique captures** for that host classify cleanly in `platform-inventory.mjs`
- [ ] `test-detect.mjs` correct labels on every capture (no footer/upload chrome)
- [ ] `sweep-captured.mjs` first-pass fill rate at target (document baseline in NOTES)
- [ ] Live apply form: no bogus `need your input`; GPT only for real unknowns
- [ ] Save Sample JSON + `.console.log` attached to the verifying capture
- [ ] `NOTES.md` entry with capture slug + **verified live**

## Fixing “all 185” — realistic plan

We do **not** hand-fix 185 pages individually. Each Tier-1 platform gets **one shared engine**
(combobox stack, label resolver, phone widget, …). The ~22 Greenhouse captures are a **regression
suite**: one Greenhouse fix should move all 22. Same for Workday (31), Ashby (15), etc.

After Tier 1 sweeps pass, Tier 2 gets the same treatment with fewer samples each.
