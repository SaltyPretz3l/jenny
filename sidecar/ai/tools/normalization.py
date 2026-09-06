# ruff: noqa: PLR0911
"""Provider-specific tool response normalization utilities."""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Tuple
from uuid import uuid4

from .models import GenerationResult, ToolCallRequest


def _gen_call_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:10]}"


def _coerce_arguments(raw: Any) -> Tuple[Dict[str, Any], bool]:
    """Return ``(arguments_dict, was_coerced)``.

    ``was_coerced`` is True when the raw input could not be interpreted as a
    valid dict and was defaulted to ``{}``.  Callers use this flag to reject
    side-effecting tool calls that would otherwise execute with empty defaults.
    """
    if isinstance(raw, dict):
        return raw, False
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return {}, True
        try:
            decoded = json.loads(text)
            if isinstance(decoded, dict):
                return decoded, False
        except json.JSONDecodeError:
            pass
    return {}, True


def _normalize_tool_calls(
    entries: Iterable[Dict[str, Any]],
    *,
    id_prefix: str,
    name_getter,
    args_getter,
    id_getter,
) -> List[ToolCallRequest]:
    calls: List[ToolCallRequest] = []
    for item in entries:
        name = str(name_getter(item) or "").strip()
        if not name:
            continue
        call_id = str(id_getter(item) or _gen_call_id(id_prefix))
        arguments: Dict[str, Any]
        arguments, was_coerced = _coerce_arguments(args_getter(item))
        calls.append(
            ToolCallRequest(
                tool_id=name,
                arguments=arguments,
                call_id=call_id,
                coerced=was_coerced,
            )
        )
    return calls


def parse_openai_response(payload: Dict[str, Any]) -> GenerationResult:
    """Normalize OpenAI-compatible payloads into ``GenerationResult``."""
    choices = payload.get("choices", [])
    if not choices:
        return GenerationResult()

    first = choices[0] or {}
    message = first.get("message", {}) or {}
    tool_calls = _normalize_tool_calls(
        message.get("tool_calls", []) or [],
        id_prefix="openai",
        name_getter=lambda item: (item.get("function") or {}).get("name"),
        args_getter=lambda item: (item.get("function") or {}).get("arguments"),
        id_getter=lambda item: item.get("id"),
    )

    finish_reason = str(first.get("finish_reason", "stop") or "stop")
    if tool_calls and finish_reason == "stop":
        finish_reason = "tool_calls"

    return GenerationResult(
        content=str(message.get("content") or ""),
        tool_calls=tuple(tool_calls),
        finish_reason=finish_reason,
    )


def parse_ollama_response(payload: Dict[str, Any]) -> GenerationResult:
    """Normalize Ollama ``/api/chat`` payloads into ``GenerationResult``."""
    message = payload.get("message", {}) or {}
    tool_calls = _normalize_tool_calls(
        message.get("tool_calls", []) or [],
        id_prefix="ollama",
        name_getter=lambda item: (item.get("function") or {}).get("name"),
        args_getter=lambda item: (item.get("function") or {}).get("arguments"),
        id_getter=lambda item: item.get("id"),
    )

    finish_reason = "tool_calls" if tool_calls else "stop"
    return GenerationResult(
        content=str(message.get("content") or ""),
        tool_calls=tuple(tool_calls),
        finish_reason=finish_reason,
    )


def parse_anthropic_response(payload: Dict[str, Any]) -> GenerationResult:
    """Normalize Anthropic-style content-block payloads."""
    root = payload.get("message", payload) or {}
    blocks = root.get("content", []) or []
    if not isinstance(blocks, list):
        blocks = []

    text_parts: List[str] = []
    calls: List[ToolCallRequest] = []
    for block in blocks:
        block_type = str(block.get("type", ""))
        if block_type == "text":
            text_parts.append(str(block.get("text", "")))
            continue
        if block_type == "tool_use":
            arguments: Dict[str, Any]
            arguments, was_coerced = _coerce_arguments(block.get("input", {}))
            calls.append(
                ToolCallRequest(
                    tool_id=str(block.get("name", "")),
                    arguments=arguments,
                    call_id=str(block.get("id") or _gen_call_id("anthropic")),
                    coerced=was_coerced,
                )
            )

    finish_reason = "tool_calls" if calls else str(payload.get("stop_reason", "stop"))
    return GenerationResult(
        content="".join(text_parts).strip(),
        tool_calls=tuple(calls),
        finish_reason=finish_reason,
    )


def normalize_generation_response(payload: Dict[str, Any], provider: str) -> GenerationResult:
    """Normalize provider payloads into a canonical generation result."""
    normalized = (provider or "").strip().lower()
    if normalized in {"openai", "cloud", "gemini", "together"}:
        return parse_openai_response(payload)
    if normalized == "anthropic":
        return parse_anthropic_response(payload)
    if normalized == "ollama":
        return parse_ollama_response(payload)

    # Fallback heuristics for unknown providers.
    if "choices" in payload:
        return parse_openai_response(payload)
    message = payload.get("message", {})
    if isinstance(message, dict) and "tool_calls" in message:
        return parse_ollama_response(payload)
    if isinstance(payload.get("content"), list):
        return parse_anthropic_response(payload)
    return GenerationResult(content=str(message.get("content") or payload.get("content") or ""))
