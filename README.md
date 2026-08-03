# Auto Job Apply

Chrome extension + local companion service that help you fill job application forms from a
saved profile and Q&A bank, tailor resumes per posting, and extract job facts (location,
salary, skills, etc.) from the page.

Two parts, both run on your machine:

| Path | What it is |
| --- | --- |
| `extension/` | Manifest V3 Chrome extension (side panel, options, onboarding) |
| `companion-service/` | Local FastAPI server at `http://127.0.0.1:3939` |
| `tools/` | Optional Node scripts for offline autofill simulation |
| `extension/test-forms/` | Curated HTML fixtures + engineering notes (for development) |

Personal data (profile, resumes, API token, generated docs) is **not** stored in this repo.
It lives under `~/.job-apply-project/` on your machine. The companion only talks to
`127.0.0.1` unless you opt into an AI provider for generation.

## Prerequisites

- **Google Chrome** (or Chromium) with Manifest V3 support
- **Python 3.10+**
- Optional AI providers (Settings → Generation):
  - [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude` provider)
  - [Ollama](https://ollama.com) (`ollama` provider)
  - Clipboard / ChatGPT paste flow (`gpt` provider — no local model required)

## 1. Install the companion service

**Windows**

```bat
cd companion-service
setup.bat
start.bat
```

**macOS / Linux**

```bash
cd companion-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python run.py
```

Leave it running in the background. It listens on `127.0.0.1:3939` only.

## 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Complete the onboarding tab that opens

## 3. Connect extension ↔ companion (one-time token)

They authenticate with a token created on first contact:

1. With the companion running, click **Test connection** on onboarding (should say Connected).
2. Enter your name → **Save & continue to Settings**. The first attempt may show "Setup
   failed" — expected — it still creates the token file.
3. Copy the token from:
   - Windows: `C:\Users\<you>\.job-apply-project\secret.token`
   - macOS/Linux: `~/.job-apply-project/secret.token`
4. Paste into **API Token** on onboarding → **Save & continue to Settings** again.

Later: Settings → **Connection** has the same URL/token fields.

## 4. Fill in Settings

- **Profile** — contact, experience, education, skills
- **Connection** — companion URL + token
- **Generation** — provider + `apply_root_dir` for saved resumes/cover letters
- **Q&A** — recurring answers (visa, notice period, etc.) for Auto Fill / Learn

## Everyday use

1. Open a job posting → open the side panel (auto-extracts JD / company / URL; use
   **Extract from page** to refresh).
2. **Generate JSON** to tailor a resume (or use your uploaded resume if Tailor is off).
3. On the application form: **Auto Fill**, **Attach Resume**, **Learn this page** (save
   hand-filled answers into the Q&A bank).

Useful shortcuts (chrome://extensions → Keyboard shortcuts): Alt+F Auto Fill, Alt+G
Generate, Alt+E Extract, Alt+L Learn, and others listed in the manifest.

## Where your data lives

| Location | Contents |
| --- | --- |
| `~/.job-apply-project/secret.token` | Extension ↔ companion auth |
| `~/.job-apply-project/data/people/<name>/` | Profile, Q&A, resumes |
| `apply_root_dir` (from Settings) | Generated docs / day logs |

Nothing in those paths belongs in git. Do not commit captures from **Save Sample**
(`extension/test-forms/captured/` is gitignored for that reason).

## Troubleshooting

- **"Backend not running"** — ensure `python run.py` / `start.bat` is still up, then refresh
  the side panel.
- **401 / invalid token** — token in Settings must match `secret.token` exactly.
- **Claude / Ollama generation errors** — verify `claude --version` or `ollama list` in the
  same environment you use to start the companion.

## Developer notes

- `tools/simulate-autofill.js` — run autofill/learn detection against saved HTML + your live
  companion (optional; `cd tools && npm install`).
- `extension/test-forms/NOTES.md` — ATS findings and fix history for contributors.
- `sync.sh` — optional rsync helper for a VMware shared Windows folder (not required for
  normal use).

## Privacy

- Companion binds to localhost only.
- Profile / resumes / Q&A stay on disk under `~/.job-apply-project/`.
- Generation may send prompts to the provider you configure (Claude CLI, Ollama, or whatever
  you paste a GPT prompt into). With generation off / unused, nothing leaves your machine.

## License

No license file is included yet. Add one before publishing if you intend this to be
open source.
