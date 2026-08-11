# Platform-by-platform autofill testing

Goal: each ATS reaches **100% of fillable fields** with **zero manual input** on a real
apply form. Fix one platform completely before moving to the next.

## Workflow (per platform)

1. **Pick one live apply URL** for the platform (e.g. `peopleforce.io`, `sapsf.eu`, `greenhouse.io`).
2. **Reload the extension** after code changes (`chrome://extensions` → refresh).
3. **Run Auto Fill** (Alt+F). Watch the side panel result line.
4. **Open DevTools → Console** on the apply tab — filter `[Auto Fill]` to see per-field detail.
5. **Save Sample** (Alt+S) — saves HTML + field JSON + **`.console.log`** (buffer from step 3–4).
6. **Offline check** (from repo root):
   ```bash
   node tools/test-detect.mjs extension/test-forms/captured/<slug>.html
   node tools/sweep-captured.mjs extension/test-forms/captured --limit 20
   ```
7. **Fix** detection/fill for that platform only; append finding to `NOTES.md` (`Author: Cursor`).
8. **Re-run steps 3–6** until Auto Fill reports no real `need your input` items.
9. Mark platform **verified live** in `NOTES.md` before starting the next.

## What gets logged

All injected scripts now buffer console output. Lines tagged `[Auto Fill]` are the important ones:

| Tag | Meaning |
|-----|---------|
| `[Auto Fill][run]` | Autofill started on this frame |
| `[Auto Fill][detect]` | Field counts after detection |
| `[Auto Fill][filled]` | Field filled (source + label + value preview) |
| `[Auto Fill][unmatched]` | Left for user/GPT (with options count if combobox) |
| `[Auto Fill][summary]` | End-of-pass totals |
| `[Auto Fill][combobox-discovery]` | Combobox option discovery |
| `[Auto Fill][combobox-retry …]` | Greenhouse/SF combobox fill tiers |

**Tip:** Run Auto Fill, then Save Sample — the `.console.log` file captures that run's buffer.

## Platform priority queue

Work top to bottom; skip if no live URL available.

| Priority | Platform | Host pattern | Status |
|----------|----------|--------------|--------|
| 1 | PeopleForce | `*.peopleforce.io` | In progress (phone fixed #111) |
| 2 | SAP SuccessFactors | `*.sapsf.*`, `*.successfactors.com` | In progress (#110) |
| 3 | Greenhouse | `*.greenhouse.io` | Partial (combobox stack) |
| 4 | Workday | `*.myworkdayjobs.com` | Partial |
| 5 | Lever | `*.lever.co` | Partial |
| 6 | SmartRecruiters | `*.smartrecruiters.com` | Partial |
| 7 | Ashby | `*.ashbyhq.com` | Partial |
| 8 | BambooHR | `*.bamboohr.com` | Partial |

Update the **Status** column when a platform is verified live end-to-end.

## Definition of done (one platform)

- [ ] `test-detect.mjs` lists all real fields with correct labels (no footer/locale noise)
- [ ] Auto Fill fills every profile/QA-backed field on a live form
- [ ] GPT batch only opens for genuinely unknown free-text (not broken comboboxes)
- [ ] Save Sample JSON shows correct `source` per field
- [ ] `.console.log` shows no failed combobox commits for required picklists
- [ ] Documented in `NOTES.md` with capture filename + **verified live** note
