"""Provider tool-call parsing for the schema roundtrip check.

Only :mod:`sidecar.ai.tools.schema_roundtrip` uses this module, and only for the
OpenAI-compatible (``openai``/``vllm``) and Ollama envelopes it builds itself.
Arguments go through :func:`coerce_tool_arguments`, the same resolver the live
streaming and non-streaming parsers use, so the roundtrip cannot drift from them.
"""

from __future__ import annotations

from typing import Any, Iterable
from uuid import uuid4

from .models import GenerationResult, ToolCallRequest, coerce_tool_arguments


def _parse_function_calls(entries: Iterable[Any], *, id_prefix: str) -> tuple[ToolCallRequest, ...]:
    calls: list[ToolCallRequest] = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        function = item.get("function") or {}
        name = str(function.get("name") or "").strip() if isinstance(function, dict) else ""
        if not name:
            continue
        arguments, malformed = coerce_tool_arguments(function.get("arguments"))
        calls.append(
            ToolCallRequest(
                tool_id=name,
                arguments=arguments,
                call_id=str(item.get("id") or f"{id_prefix}_{uuid4().hex[:10]}"),
                coerced=malformed is not None,
            )
        )
    return tuple(calls)


def parse_openai_response(payload: dict[str, Any]) -> GenerationResult:
    """Normalize an OpenAI-compatible chat-completions payload."""
    choices = payload.get("choices") or []
    first = choices[0] if choices and isinstance(choices[0], dict) else {}
    message = first.get("message") or {}
    tool_calls = _parse_function_calls(message.get("tool_calls") or [], id_prefix="openai")
    finish_reason = str(first.get("finish_reason") or "stop")
    if tool_calls and finish_reason == "stop":
        finish_reason = "tool_calls"
    return GenerationResult(
        content=str(message.get("content") or ""),
        tool_calls=tool_calls,
        finish_reason=finish_reason,
    )


def parse_ollama_response(payload: dict[str, Any]) -> GenerationResult:
    """Normalize an Ollama ``/api/chat`` payload."""
    message = payload.get("message") or {}
    tool_calls = _parse_function_calls(message.get("tool_calls") or [], id_prefix="ollama")
    return GenerationResult(
        content=str(message.get("content") or ""),
        tool_calls=tool_calls,
        finish_reason="tool_calls" if tool_calls else "stop",
    )


def normalize_generation_response(payload: dict[str, Any], provider: str) -> GenerationResult:
    """Parse a roundtrip payload: Ollama's envelope, else the OpenAI-compatible one."""
    if (provider or "").strip().lower() == "ollama":
        return parse_ollama_response(payload)
    return parse_openai_response(payload)
