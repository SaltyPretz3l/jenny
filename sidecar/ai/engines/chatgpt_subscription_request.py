"""Responses request serialization for ChatGPT subscriptions.

Request shaping lives here; chatgpt_subscription_stream owns SSE parsing and HTTP
error classification to preserve the sibling import limit.
"""

from __future__ import annotations

import json
from typing import Any

from sidecar.ai.engines.base import EMPTY_ASSISTANT_CONTENT_PLACEHOLDER, EngineMessage
from sidecar.ai.engines.vision_input import VisionImage

_ALLOWED_REASONING_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
# Byte-identical to the joiner used by merge_consecutive_system_messages in
# sidecar/runtime/local_engine/messages.py: the leading system run must reach
# ChatGPT as the same single block ollama/vLLM/llama-server receive.
_INSTRUCTION_JOINER = "\n\n"


def normalize_reasoning_effort(value: str | None) -> str | None:
    normalized = str(value or "").strip().lower()
    # Historical product-level "ultra" maps to wire-level "max". New UI
    # profiles no longer advertise Ultra because Codex now gives it delegation
    # semantics that Jenny does not implement.
    if normalized == "ultra":
        normalized = "max"
    return normalized if normalized in _ALLOWED_REASONING_EFFORTS else None


def _text_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    return "".join(
        str(item.get("text") or "")
        for item in value
        if isinstance(item, dict) and isinstance(item.get("text"), str)
    )


def non_empty_string(value: Any) -> str:
    return str(value).strip() if isinstance(value, str) else ""


def _message_item(
    role: str,
    text: str,
    images: Any = (),
) -> dict[str, Any]:
    content_type = "output_text" if role == "assistant" else "input_text"
    content: list[dict[str, Any]] = []
    has_images = role == "user" and bool(images)
    if text or not has_images:
        content.append({"type": content_type, "text": text})
    if has_images:
        for image in images:
            if isinstance(image, VisionImage):
                content.append(
                    {
                        "type": "input_image",
                        "image_url": image.as_data_uri(),
                        "detail": "auto",
                    }
                )
    return {
        "type": "message",
        "role": role,
        "content": content,
    }


def _function_call_items(raw_calls: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_calls, list):
        return []
    items: list[dict[str, Any]] = []
    for raw_call in raw_calls:
        if not isinstance(raw_call, dict):
            continue
        name = non_empty_string(raw_call.get("name") or raw_call.get("tool_id"))
        call_id = non_empty_string(raw_call.get("call_id") or raw_call.get("id"))
        if not name or not call_id:
            continue
        arguments = raw_call.get("arguments")
        if isinstance(arguments, str):
            serialized_arguments = arguments
        elif isinstance(arguments, dict):
            serialized_arguments = json.dumps(arguments, separators=(",", ":"))
        else:
            serialized_arguments = "{}"
        items.append(
            {
                "type": "function_call",
                "name": name,
                "arguments": serialized_arguments,
                "call_id": call_id,
            }
        )
    return items


def _enforce_call_pairing(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # The backend rejects a function_call without its matching output (and vice
    # versa), so an item missing its pair is dropped rather than sent.
    call_ids = {
        item["call_id"] for item in items if item.get("type") == "function_call"
    }
    output_ids = {
        item["call_id"] for item in items if item.get("type") == "function_call_output"
    }
    paired = call_ids & output_ids
    return [
        item
        for item in items
        if item.get("type") not in {"function_call", "function_call_output"}
        or item.get("call_id") in paired
    ]


def _insert_reasoning_items(
    items: list[dict[str, Any]],
    reasoning_by_call_id: dict[str, dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    # With store:false the backend expects each replayed function_call to be
    # preceded by the reasoning item that produced it; replay captured items
    # once, in place. Calls with no captured item ship without one.
    if not reasoning_by_call_id:
        return items
    emitted: set[int] = set()
    result: list[dict[str, Any]] = []
    for item in items:
        if item.get("type") == "function_call":
            reasoning_item = reasoning_by_call_id.get(item.get("call_id") or "")
            if isinstance(reasoning_item, dict) and id(reasoning_item) not in emitted:
                emitted.add(id(reasoning_item))
                result.append(reasoning_item)
        result.append(item)
    return result


def split_leading_system_run(
    messages: list[EngineMessage],
) -> tuple[list[str], list[EngineMessage]]:
    """Peel the leading contiguous ``system`` run off the front of ``messages``.

    Mirrors the leading-run boundary that
    ``demote_non_leading_system_messages`` draws for template-based local
    engines: rows before the first non-system message keep system authority,
    everything after it does not.
    """
    cursor = 0
    leading_system_texts: list[str] = []
    for message in messages:
        if non_empty_string(message.get("role")).lower() != "system":
            break
        leading_system_texts.append(_text_content(message.get("content")))
        cursor += 1
    return leading_system_texts, list(messages[cursor:])


def build_instructions(*, system: str, leading_system_texts: list[str]) -> str:
    """Fold the base prompt and the leading system run into one instruction block.

    The Responses API carries system authority in ``instructions`` only, so the
    whole leading run has to land there. ``system`` is kept unstripped as
    segment 0 (whitespace in the prompt is the prompt author's), while the
    emptiness and dedup checks compare stripped text.

    The dedup guard is defence in depth: ``engine_messages`` strips the primary
    row by comparing against ``str(system_prompt)`` while the engine receives
    ``StructuredSystemPrompt.to_text()``. Those agree today (``__str__``
    delegates to ``to_text``); if they ever diverge the base prompt would
    otherwise be emitted twice.
    """
    base = str(system or "")
    base_key = base.strip()
    segments: list[str] = [base] if base_key else []
    for text in leading_system_texts:
        stripped = text.strip()
        if not stripped or stripped == base_key:
            continue
        segments.append(text)
    return _INSTRUCTION_JOINER.join(segments)


def build_input_items(
    *,
    prompt: str,
    system: str,
    messages: list[EngineMessage] | None,
    reasoning_by_call_id: dict[str, dict[str, Any]] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Map Jenny chat history onto conventional Responses input items."""
    leading_system_texts, remainder = split_leading_system_run(messages or [])
    instructions = build_instructions(
        system=system,
        leading_system_texts=leading_system_texts,
    )
    items: list[dict[str, Any]] = []
    if not messages:
        if prompt:
            items.append(_message_item("user", str(prompt)))
        return instructions, items

    for message in remainder:
        role = non_empty_string(message.get("role")).lower()
        content = _text_content(message.get("content"))
        if role == "system":
            # Non-leading system rows (wind-down, tool-budget and tool-failure
            # nudges) are demoted in place exactly as
            # demote_non_leading_system_messages does for local engines:
            # recency right before the model's next turn is the property they
            # exist for, so hoisting them into instructions would destroy it.
            if content:
                items.append(_message_item("user", content))
            continue
        if role in {"user", "assistant"}:
            images = message.get("images") or () if role == "user" else ()
            function_calls = (
                _function_call_items(message.get("tool_calls")) if role == "assistant" else []
            )
            # The "(no content)" backfill (ensure_non_empty_assistant_content)
            # exists for providers that reject empty assistant content. Emitted
            # here as a free-standing output_text message it becomes a few-shot
            # pattern the model imitates as visible text, so tool-call rows
            # ship as bare function_call items instead.
            placeholder_only = (
                bool(function_calls) and content == EMPTY_ASSISTANT_CONTENT_PLACEHOLDER
            )
            if (content or images) and not placeholder_only:
                message_item = _message_item(role, content, images=images)
                if message_item["content"]:
                    items.append(message_item)
            items.extend(function_calls)
            continue
        if role == "tool":
            call_id = non_empty_string(message.get("tool_call_id"))
            if call_id:
                items.append(
                    {
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": content,
                    }
                )

    return instructions, _insert_reasoning_items(
        _enforce_call_pairing(items), reasoning_by_call_id
    )


def build_function_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for tool in tools:
        name = non_empty_string(tool.get("name"))
        if not name or tool.get("defer_loading") is True:
            continue
        description = non_empty_string(tool.get("description"))
        parameters = tool.get("parameters")
        payload.append(
            {
                "type": "function",
                "name": name,
                "description": description,
                "strict": False,
                "parameters": parameters if isinstance(parameters, dict) else {},
            }
        )
    return payload


def build_responses_payload(  # noqa: PLR0913 - explicit request-shaping contract.
    *,
    model: str,
    prompt: str,
    system: str,
    messages: list[EngineMessage] | None,
    tools: list[dict[str, Any]],
    reasoning_effort: str | None,
    reasoning_by_call_id: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    instructions, input_items = build_input_items(
        prompt=prompt,
        system=system,
        messages=messages,
        reasoning_by_call_id=reasoning_by_call_id,
    )
    normalized_effort = normalize_reasoning_effort(reasoning_effort)
    reasoning = {"summary": "auto"}
    if normalized_effort is not None:
        reasoning["effort"] = normalized_effort
    return {
        "model": model,
        "instructions": instructions,
        "input": input_items,
        "tools": build_function_tools(tools),
        "tool_choice": "auto",
        "parallel_tool_calls": True,
        "reasoning": reasoning,
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
    }


__all__ = [
    "build_function_tools",
    "build_input_items",
    "build_instructions",
    "build_responses_payload",
    "non_empty_string",
    "normalize_reasoning_effort",
    "split_leading_system_run",
]
