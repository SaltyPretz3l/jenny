"""Shared imports/helpers for ``sidecar.ai.engines.vllm_engine``."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from typing import Any

from sidecar.ai.engines.base import EngineMessage
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.error_codes import CMP_STREAM_INCOMPLETE
from sidecar.ai.exceptions import (
    EngineConnectionError,
    GenerationError,
    ModelNotLoadedError,
    UnsupportedModalityError,
)
from sidecar.ai.reasoning_parser import (
    DelimitedReasoningParser,
    ReasoningExtraction,
    extract_delimited_reasoning,
    strip_known_reasoning_blocks,
    strip_known_reasoning_markers,
)
from sidecar.ai.thinking_guard import ThinkingRepetitionGuard
from sidecar.ai.tools.models import (
    GenerationResult,
    GenerationUsage,
    StreamChunk,
    StreamingEvent,
    ToolCallRequest,
    coerce_tool_arguments,
    ensure_tool_call_id,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.local_engine.messages import (
    contains_primary_system_message,
    demote_non_leading_system_messages,
    merge_consecutive_system_messages,
)

logger = logging.getLogger(__name__)


def log_vllm_stream_terminal_gap(
    engine: Any,
    *,
    finish_reason: str,
    inband_error: str = "",
) -> None:
    """Emit the actionable event for a vLLM stream that did not end cleanly.

    Without this event a socket EOF mid-answer is indistinguishable from a
    complete completion (the finish-reason half rides the terminal
    ``StreamingEvent``).

    This lives in ``sidecar.runtime`` rather than the engine module because
    ``vllm_engine_generation`` is AT the 6-module ``sidecar.ai`` leaf import
    fan-out cap and ``CMP_STREAM_INCOMPLETE`` lives in ``sidecar.ai.error_codes``.
    """
    log_event(
        logger,
        logging.WARNING,
        component="ai.engines.vllm",
        event="ai.engines.vllm.stream_incomplete",
        message="vLLM stream ended without clean terminal evidence.",
        status="degraded",
        data={
            "code": CMP_STREAM_INCOMPLETE,
            "model": getattr(engine, "model_name", None),
            "finish_reason": finish_reason,
            "inband_error": inband_error,
        },
    )


def extract_reasoning_delta(delta: Any) -> str:
    """Return the reasoning text carried by an OpenAI-compatible delta/message.

    vLLM's reasoning parsers emit parsed thinking under ``reasoning_content``.
    Other OpenAI-compatible servers -- and potentially future vLLM builds --
    use a bare ``reasoning`` key for the same payload.

    ``reasoning_content`` is checked FIRST so every currently-observed vLLM
    response keeps byte-identical behavior; ``reasoning`` is a pure fallback.
    Reading only one spelling is not a cosmetic gap: the reasoning-only
    fail-closed guard is driven by the normalizer's reasoning-delta counter,
    so a spelling we never read looks exactly like "the model never thought",
    which both drops the thinking text and disarms the guard.
    """
    if not isinstance(delta, Mapping):
        return ""
    for key in ("reasoning_content", "reasoning"):
        value = delta.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _as_non_empty_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized if normalized else None


def _normalize_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return ""


def _tool_call_name(candidate: Any) -> str | None:
    if not isinstance(candidate, dict):
        return None
    return _as_non_empty_string(candidate.get("name") or candidate.get("tool_id"))


def _tool_call_id(candidate: Any) -> str | None:
    if not isinstance(candidate, dict):
        return None
    return _as_non_empty_string(candidate.get("id") or candidate.get("call_id"))


def _tool_call_arguments(candidate: Any) -> dict[str, Any]:
    if not isinstance(candidate, dict):
        return {}
    arguments = candidate.get("arguments")
    if isinstance(arguments, dict):
        return arguments
    if isinstance(arguments, str) and arguments.strip():
        try:
            parsed = json.loads(arguments)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def _build_openai_compatible_tool_calls(raw_calls: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_calls, list):
        return []
    tool_calls: list[dict[str, Any]] = []
    for raw_call in raw_calls:
        name = _tool_call_name(raw_call)
        if name is None:
            continue
        call_id = _tool_call_id(raw_call)
        entry: dict[str, Any] = {
            "type": "function",
            "function": {
                "name": name,
                "arguments": json.dumps(_tool_call_arguments(raw_call)),
            },
        }
        if call_id is not None:
            entry["id"] = call_id
        tool_calls.append(entry)
    return tool_calls


def _build_messages(
    *,
    prompt: str,
    system: str,
    messages: list[EngineMessage] | None,
) -> list[dict[str, Any]]:
    if messages:
        normalized: list[dict[str, Any]] = []
        for item in messages:
            role = _as_non_empty_string(item.get("role"))
            if role is None:
                continue
            mapped_role = role.lower()
            if mapped_role not in {"system", "user", "assistant", "tool"}:
                continue
            content = _normalize_content(item.get("content"))
            has_content = bool(content.strip())
            images = item.get("images")
            vision_images = (
                images
                if mapped_role == "user"
                and isinstance(images, list)
                and images
                and all(isinstance(image, VisionImage) for image in images)
                else []
            )
            if mapped_role == "assistant":
                tool_calls = _build_openai_compatible_tool_calls(item.get("tool_calls"))
                if not has_content and not tool_calls:
                    continue
                assistant_message: dict[str, Any] = {
                    "role": "assistant",
                    "content": content if has_content else None,
                }
                if tool_calls:
                    assistant_message["tool_calls"] = tool_calls
                normalized.append(assistant_message)
                continue
            if mapped_role == "tool":
                tool_call_id = _as_non_empty_string(item.get("tool_call_id"))
                if tool_call_id is None or not has_content:
                    # Without this signal a dropped tool result is invisible:
                    # the model sees its own tool_calls but no matching
                    # result, then reports "no tool results provided in the
                    # prompt". Log the cause so operators can trace it
                    # without exposing the body.
                    log_event(
                        logger,
                        logging.WARNING,
                        component="ai.engine.vllm",
                        event="ai.engine.vllm.tool_message_dropped",
                        message="Dropping tool message before vLLM dispatch.",
                        status="degraded",
                        data={
                            "reason": (
                                "missing_tool_call_id" if tool_call_id is None else "empty_content"
                            ),
                            "tool_name": _as_non_empty_string(item.get("name")) or "",
                            "raw_tool_call_id": str(item.get("tool_call_id") or ""),
                            "content_length": len(content),
                        },
                    )
                    continue
                normalized.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": content,
                    }
                )
                continue
            if vision_images:
                content_parts: list[dict[str, Any]] = (
                    [{"type": "text", "text": content}] if has_content else []
                )
                content_parts.extend(
                    {
                        "type": "image_url",
                        "image_url": {"url": image.as_data_uri()},
                    }
                    for image in vision_images
                )
                normalized.append({"role": "user", "content": content_parts})
                continue
            if not has_content:
                continue
            normalized.append({"role": mapped_role, "content": content})
        system_prompt = _as_non_empty_string(system)
        if normalized:
            # Prepend the router-supplied primary system prompt unless that
            # exact prompt already rides in `messages` — other system rows
            # (runtime overlays, a compaction summary) must not suppress it;
            # see contains_primary_system_message. Adjacent system rows are
            # merged below, keeping the primary first.
            if system_prompt is not None and not contains_primary_system_message(
                normalized,
                system_prompt,
            ):
                normalized.insert(0, {"role": "system", "content": system_prompt})
            # Collapse adjacent system messages: quirky GGUF chat templates
            # served via vLLM / llama.cpp's llama-server can fail tool-call
            # parser generation when given more than one (see
            # merge_consecutive_system_messages). Order/content preserved.
            return merge_consecutive_system_messages(demote_non_leading_system_messages(normalized))

    constructed: list[dict[str, Any]] = []
    system_prompt = _as_non_empty_string(system)
    if system_prompt is not None:
        constructed.append({"role": "system", "content": system_prompt})
    constructed.append({"role": "user", "content": prompt})
    return constructed


def _build_tools_payload(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for tool in tools:
        name = _as_non_empty_string(tool.get("name"))
        if name is None:
            continue
        if tool.get("defer_loading") is True:
            continue
        description = _as_non_empty_string(tool.get("description")) or ""
        parameters = tool.get("parameters") if isinstance(tool.get("parameters"), dict) else {}
        payload.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": parameters,
                },
            }
        )
    return payload


def _parse_tool_calls(raw_calls: Any, *, request_id: str | None = None) -> list[ToolCallRequest]:
    if not isinstance(raw_calls, list):
        return []

    parsed: list[ToolCallRequest] = []
    position = 0
    for item in raw_calls:
        if not isinstance(item, dict):
            continue
        function = item.get("function")
        if not isinstance(function, dict):
            continue
        name = _as_non_empty_string(function.get("name"))
        if name is None:
            continue
        # Shared with the streaming normalizer: a provider ``arguments`` string
        # that does not parse as a JSON object used to be swallowed into ``{}``
        # here and dispatched as an otherwise-normal call, while the STREAMING
        # path rejected the identical wire shape. The flag carries that verdict
        # to the tool loop, which rejects just this call.
        arguments, malformed_raw = coerce_tool_arguments(function.get("arguments"))
        call_id = ensure_tool_call_id(
            _as_non_empty_string(item.get("id")),
            provider="openai",
            tool_name=name,
            request_id=request_id,
            position=position,
        )
        parsed.append(
            ToolCallRequest(
                tool_id=name,
                arguments=arguments,
                call_id=call_id,
                malformed_arguments=malformed_raw is not None,
            )
        )
        position += 1
    return parsed


__all__ = [
    "DelimitedReasoningParser",
    "EngineConnectionError",
    "GenerationError",
    "GenerationResult",
    "GenerationUsage",
    "ModelNotLoadedError",
    "ReasoningExtraction",
    "StreamChunk",
    "StreamingEvent",
    "ThinkingRepetitionGuard",
    "UnsupportedModalityError",
    "_build_messages",
    "_build_tools_payload",
    "_normalize_content",
    "_parse_tool_calls",
    "extract_delimited_reasoning",
    "extract_reasoning_delta",
    "strip_known_reasoning_blocks",
    "strip_known_reasoning_markers",
]
