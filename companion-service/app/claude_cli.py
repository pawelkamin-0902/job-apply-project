from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def check_claude_cli(cli_path: str = "claude") -> tuple[bool, str]:
    """Cheap connectivity check: does the CLI binary resolve on PATH.
    Doesn't invoke it — a real generation call already reports failures clearly."""
    resolved = shutil.which(cli_path)
    if resolved is None:
        return False, f"Claude Code CLI not found on PATH (looked for '{cli_path}')"
    return True, f"Found at {resolved}"


class ClaudeCodeCliError(Exception):
    def __init__(self, message: str, exit_code: int | None = None, stderr: str | None = None) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.stderr = stderr

    def __str__(self) -> str:
        base = super().__str__()
        if self.exit_code is not None:
            base += f" (exit code {self.exit_code})"
        if self.stderr:
            base += f" | stderr: {self.stderr[:800]}"
        return base


def usage_from_cli_payload(payload: dict[str, Any]) -> dict[str, int] | None:
    """Map the CLI's raw `usage` object (which mixes ints, strings, and nested dicts)
    down to the plain integer token counts we actually want to store."""
    raw = payload.get("usage")
    if not isinstance(raw, dict):
        return None
    out: dict[str, int] = {}
    inn = raw.get("input_tokens")
    if isinstance(inn, int):
        out["prompt_tokens"] = inn
    outt = raw.get("output_tokens")
    if isinstance(outt, int):
        out["completion_tokens"] = outt
    for key in ("cache_creation_input_tokens", "cache_read_input_tokens"):
        v = raw.get(key)
        if isinstance(v, int):
            out[key] = v
    if "prompt_tokens" in out and "completion_tokens" in out:
        out["total_tokens"] = out["prompt_tokens"] + out["completion_tokens"]
    return out or None


def _subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    return env


async def run_claude_code_print(
    prompt: str,
    *,
    cwd: Path,
    cli_path: str = "claude",
    timeout_seconds: float = 120.0,
    append_system_prompt: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Run `claude -p --output-format json`, piping `prompt` over stdin, as a one-shot,
    non-persisted call.

    No retry, no fallback: any failure raises ClaudeCodeCliError once and stops.
    """
    # On Windows, npm installs CLI tools as `claude.cmd`/`claude.ps1`, not a bare `claude` file.
    # Interactive shells auto-resolve the extension for you; subprocess spawning does not,
    # so resolve the real executable path explicitly (shutil.which searches PATHEXT on Windows).
    resolved = shutil.which(cli_path)
    if resolved is None:
        raise ClaudeCodeCliError(f"Claude Code CLI not found at '{cli_path}'")

    # The prompt (full profile + job description) can be several KB — too large to pass as a
    # literal command-line argument on Windows, where cmd.exe caps command lines at ~8191 chars
    # and silently truncates past that. Passing "-p" with no value here means the CLI reads the
    # prompt from stdin instead, which has no such limit and sidesteps quoting entirely.
    claude_args = []
    if model:
        claude_args.extend(["--model", model])
    claude_args.extend(["-p", "--output-format", "json", "--tools", "", "--permission-mode", "dontAsk"])
    claude_args.append("--no-session-persistence")

    # The system prompt (instructions + schema contract) is just as capable of blowing past
    # the same ~8191-char Windows command-line limit as the user prompt above — a real ATS
    # instruction set easily runs several thousand characters on its own. Passing it via
    # --append-system-prompt-file (a real file path, always short) instead of
    # --append-system-prompt (the literal text, inline on the command line) sidesteps that
    # limit the same way stdin does for the user prompt.
    system_prompt_file: str | None = None
    if append_system_prompt:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, encoding="utf-8"
        ) as handle:
            handle.write(append_system_prompt)
            system_prompt_file = handle.name
        claude_args.extend(["--append-system-prompt-file", system_prompt_file])

    env = _subprocess_env()

    try:
        try:
            if resolved.lower().endswith((".cmd", ".bat")):
                # .cmd/.bat files aren't real executables on Windows — they need cmd.exe to
                # interpret them. But cmd.exe's own `/c` argument parsing has a notorious bug:
                # when the command line after /c has more than one pair of quotes (guaranteed
                # here, since the resolved path has spaces in it and other args are quoted too),
                # cmd.exe strips the wrong quote characters and mangles the path
                # (e.g. "'C:\Program' is not recognized"). The documented workaround is
                # create_subprocess_shell: it wraps our already fully-quoted command line in
                # exactly one clean outer quote pair via plain string formatting (no
                # re-escaping), which is what makes cmd.exe's quote-stripping land correctly.
                inner_cmdline = subprocess.list2cmdline([resolved, *claude_args])
                proc = await asyncio.create_subprocess_shell(
                    inner_cmdline,
                    cwd=str(cwd),
                    env=env,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
            else:
                proc = await asyncio.create_subprocess_exec(
                    resolved,
                    *claude_args,
                    cwd=str(cwd),
                    env=env,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
        except FileNotFoundError as exc:
            raise ClaudeCodeCliError(f"Claude Code CLI not found at '{cli_path}'") from exc

        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(input=prompt.encode()), timeout=timeout_seconds)
        except TimeoutError as exc:
            proc.kill()
            await proc.wait()
            raise ClaudeCodeCliError(f"Claude Code CLI timed out after {timeout_seconds}s") from exc

        stdout_text = stdout.decode(errors="replace")
        stderr_text = stderr.decode(errors="replace")

        if proc.returncode != 0:
            raise ClaudeCodeCliError(
                "Claude Code CLI exited with a non-zero status",
                exit_code=proc.returncode,
                stderr=stderr_text[:2000] or stdout_text[:2000],
            )

        if not stdout_text.strip():
            raise ClaudeCodeCliError(
                "Claude Code CLI produced no output", exit_code=proc.returncode, stderr=stderr_text[:2000]
            )

        try:
            return json.loads(stdout_text)
        except json.JSONDecodeError as exc:
            raise ClaudeCodeCliError(
                "Claude Code CLI stdout is not valid JSON",
                exit_code=proc.returncode,
                stderr=stdout_text[:2000],
            ) from exc
    finally:
        if system_prompt_file:
            Path(system_prompt_file).unlink(missing_ok=True)
