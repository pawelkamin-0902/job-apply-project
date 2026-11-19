from __future__ import annotations

from typing import Any

import httpx

DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
# Cheapest current OpenAI chat model for high-volume resume/answer work. Override in Settings
# (e.g. gpt-6-luna) if JSON quality is too weak for a given job.
DEFAULT_OPENAI_MODEL = "gpt-5-nano"

# Approx USD per 1M tokens for the cost estimate returned to the UI (list prices; not billing).
_MODEL_PRICES_PER_M: dict[str, tuple[float, float]] = {
    "gpt-5-nano": (0.05, 0.40),
    "gpt-6-luna": (0.10, 0.50),
    "gpt-5.6-luna": (0.20, 1.20),
    "gpt-5.4-nano": (0.20, 1.25),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-5-mini": (0.25, 2.00),
}


class OpenAiApiError(Exception):
    pass


def _estimate_cost_usd(model: str, input_tokens: int | None, output_tokens: int | None) -> float | None:
    prices = _MODEL_PRICES_PER_M.get(model)
    if not prices or input_tokens is None or output_tokens is None:
        return None
    inp, out = prices
    return (input_tokens / 1_000_000.0) * inp + (output_tokens / 1_000_000.0) * out


async def check_openai(api_key: str, model: str, timeout_seconds: float = 15.0) -> tuple[bool, str]:
    if not (api_key or "").strip():
        return False, "OpenAI API key is empty — paste it in Settings → Generation."
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.get(
                f"{DEFAULT_OPENAI_BASE_URL}/models/{model}",
                headers={"Authorization": f"Bearer {api_key.strip()}"},
            )
    except httpx.ConnectError:
        return False, "Could not reach api.openai.com"
    except httpx.TimeoutException:
        return False, "Connection to OpenAI timed out"

    if response.status_code == 401:
        return False, "API key rejected (401) — check the key in Settings."
    if response.status_code == 404:
        return False, f"Connected, but model '{model}' was not found for this key."
    if response.status_code != 200:
        return False, f"OpenAI returned HTTP {response.status_code}: {response.text[:300]}"
    return True, f"Connected — '{model}' is available for this key."


async def run_openai_chat(
    user_message: str,
    *,
    system_prompt: str,
    api_key: str,
    model: str = DEFAULT_OPENAI_MODEL,
    format_schema: dict[str, Any] | None = None,
    timeout_seconds: float = 120.0,
) -> dict[str, Any]:
    """Call OpenAI Chat Completions. Returns the same payload shape as Claude/Ollama helpers
    (result / session_id / total_cost_usd / usage) so /generate callers stay provider-agnostic.
    """
    if not (api_key or "").strip():
        raise OpenAiApiError("OpenAI API key is empty — set it in Settings → Generation.")

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message},
    ]
    # Prefer JSON mode whenever a schema is requested (resume / answers). Full strict
    # json_schema needs additionalProperties:false everywhere; Pydantic schemas often don't.
    request_body: dict[str, Any] = {
        "model": model,
        "messages": messages,
    }
    if format_schema is not None:
        request_body["response_format"] = {"type": "json_object"}
        messages[0] = {
            "role": "system",
            "content": (
                f"{system_prompt}\n\n"
                "Respond with a single JSON object only (no markdown fences). "
                f"It must match this JSON Schema:\n{format_schema}"
            ),
        }
        request_body["messages"] = messages

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(
                f"{DEFAULT_OPENAI_BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key.strip()}",
                    "Content-Type": "application/json",
                },
                json=request_body,
            )
    except httpx.ConnectError as exc:
        raise OpenAiApiError("Could not reach api.openai.com") from exc
    except httpx.TimeoutException as exc:
        raise OpenAiApiError(f"OpenAI request timed out after {timeout_seconds}s") from exc
    except httpx.HTTPError as exc:
        raise OpenAiApiError(f"Lost connection to OpenAI mid-request: {exc}") from exc

    if response.status_code == 401:
        raise OpenAiApiError("OpenAI API key rejected (401)")
    if response.status_code != 200:
        raise OpenAiApiError(f"OpenAI returned HTTP {response.status_code}: {response.text[:500]}")

    try:
        data = response.json()
    except ValueError as exc:
        raise OpenAiApiError(f"OpenAI returned a non-JSON response: {response.text[:500]}") from exc

    choices = data.get("choices") or []
    result_text = None
    if choices:
        result_text = (choices[0].get("message") or {}).get("content")
    if not isinstance(result_text, str) or not result_text.strip():
        raise OpenAiApiError("OpenAI produced no output")

    usage = data.get("usage") or {}
    input_tokens = usage.get("prompt_tokens")
    output_tokens = usage.get("completion_tokens")
    return {
        "result": result_text,
        "session_id": data.get("id"),
        "model": model,
        "total_cost_usd": _estimate_cost_usd(model, input_tokens, output_tokens),
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        },
    }
