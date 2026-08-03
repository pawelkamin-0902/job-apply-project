from __future__ import annotations

from typing import Any

import httpx

DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"


class OllamaCliError(Exception):
    pass


async def check_ollama(base_url: str, model: str, timeout_seconds: float = 5.0) -> tuple[bool, str]:
    """Cheap connectivity check: can we reach the server, and is the configured
    model actually pulled there."""
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.get(f"{base_url}/api/tags")
    except httpx.ConnectError:
        return False, f"Could not connect to Ollama at {base_url} — is `ollama serve` running there?"
    except httpx.TimeoutException:
        return False, f"Connection to {base_url} timed out"

    if response.status_code != 200:
        return False, f"Ollama returned HTTP {response.status_code}"

    tags = [m.get("name", "") for m in response.json().get("models", [])]
    if model not in tags:
        available = ", ".join(tags) if tags else "(none)"
        return False, f"Connected, but model '{model}' isn't pulled there. Available: {available}"
    return True, f"Connected — '{model}' is available."


async def run_ollama_chat(
    user_message: str,
    *,
    system_prompt: str,
    model: str,
    format_schema: dict[str, Any] | None = None,
    timeout_seconds: float = 120.0,
    base_url: str = DEFAULT_OLLAMA_BASE_URL,
) -> dict[str, Any]:
    """Call a local Ollama server's chat endpoint, requesting JSON output.

    If format_schema is given, it's passed as Ollama's structured-output schema
    (not just "format": "json") so required fields are enforced mechanically
    instead of relying on the model to remember them from prose instructions.

    Returns the same payload shape as run_claude_code_print (result/session_id/
    total_cost_usd/usage with input_tokens/output_tokens) so callers can treat
    both providers identically. No retry, no fallback: any failure raises
    OllamaCliError once and stops.
    """
    request_body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "format": format_schema if format_schema is not None else "json",
        "stream": False,
    }

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(f"{base_url}/api/chat", json=request_body)
    except httpx.ConnectError as exc:
        raise OllamaCliError(f"Could not connect to Ollama at {base_url} — is `ollama serve` running?") from exc
    except httpx.TimeoutException as exc:
        raise OllamaCliError(f"Ollama request timed out after {timeout_seconds}s") from exc
    except httpx.HTTPError as exc:
        # Covers everything else network-related (dropped/reset connection mid-response,
        # protocol errors, etc.) — most commonly seen when the Ollama process itself
        # crashes or gets killed partway through a long generation (e.g. out of memory on
        # a large prompt/schema for a small local model). Without this, these exceptions
        # went uncaught and surfaced to the extension as an opaque, undebuggable 500.
        raise OllamaCliError(f"Lost connection to Ollama mid-request (it may have crashed or restarted): {exc}") from exc

    if response.status_code == 404:
        raise OllamaCliError(f"Model '{model}' not found on Ollama — run `ollama pull {model}` first")
    if response.status_code != 200:
        raise OllamaCliError(f"Ollama returned HTTP {response.status_code}: {response.text[:500]}")

    try:
        data = response.json()
    except ValueError as exc:
        raise OllamaCliError(f"Ollama returned a non-JSON response: {response.text[:500]}") from exc

    result_text = data.get("message", {}).get("content")
    if not isinstance(result_text, str) or not result_text.strip():
        raise OllamaCliError("Ollama produced no output")

    return {
        "result": result_text,
        "session_id": None,
        "total_cost_usd": 0.0,
        "usage": {
            "input_tokens": data.get("prompt_eval_count"),
            "output_tokens": data.get("eval_count"),
        },
    }
