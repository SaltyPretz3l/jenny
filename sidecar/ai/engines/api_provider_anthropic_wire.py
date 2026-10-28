"""Anthropic Messages request building for a user's own API key (row 78, P3a).

Pure request shaping, no I/O: headers, the message-history mapping, the tool
payload, the adaptive-thinking switches and the request-scoped cache that
replays signed thinking blocks inside one tool loop. SSE parsing lives in
``api_provider_anthropic_stream``; the engine in ``api_provider_anthropic``.

Prompt-cache layout: tools render before ``system``, so one ephemeral
breakpoint on the single system block caches tools plus system, and the
top-level ``cache_control`` auto-caches the conversation tail (two breakpoints,
under the API's limit of four). The leading system run is the only system text;
later system rows (wind-down and budget nudges) are demoted in place to user
text so the cached prefix stays byte-stable between iterations.
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from typing import Any

from sidecar.ai.engines.base import EMPTY_ASSISTANT_CONTENT_PLACEHOLDER, EngineMessage
from sidecar.ai.engines.vision_input import VisionImage

ANTHROPIC_VERSION = "2026-10-21"
THINKING_BETA = "thinking-binding-controls-2026-08-01"
MAX_OUTPUT_CEILING = 32_768
_SYSTEM_JOINER = "\n\n"
_EPHEMERAL = {"type": "ephemeral"}
_EFFORT_LEVELS = {
    "minimal": "low",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
    "max": "max",
    "ultra": "max",
}
_NO_THINKING_EFFORTS = frozenset({"", "none", "default"})
_IMAGE_MEDIA_TYPES = frozenset({"image/jpeg", "image/png", "image/gif", "image/webp"})
_EMPTY_TOOL_OUTPUT = "(no output)"

# Replay cache bounds mirror the ChatGPT reasoning cache: a count floor large enough
# for one long tool loop, a hard count ceiling, and an aggregate byte ceiling because a
# signed thinking block is an opaque blob of unbounded size.
DEFAULT_MAX_REPLAY_ENTRIES = 64
MAX_REPLAY_ENTRIES_CEILING = 512
MAX_REPLAY_BYTES = 8 * 1024 * 1024
_NOMINAL_BLOCK_BYTES = 4096


def static_headers() -> dict[str, str]:
    return {
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "accept": "text/event-stream",
    }


def output_cap(limits: Mapping[str, Any], context_length: int) -> int:
    return min(int(limits["max_output_tokens"]), MAX_OUTPUT_CEILING, context_length // 2)


def thinking_effort(requested: str | None, *, supported: bool) -> tuple[bool, str | None]:
    """``(thinking requested, wire effort)``; an unknown effort still thinks, with no effort."""
    if not supported:
        return False, None
    key = str(requested or "").strip().lower()
    if key in _NO_THINKING_EFFORTS:
        return False, None
    return True, _EFFORT_LEVELS.get(key)


# -- replay cache ----------------------------------------------------------------


def _block_size(block: Mapping[str, Any]) -> int:
    try:
        return len(json.dumps(block, separators=(",", ":"), default=str))
    except (TypeError, ValueError, RecursionError):
        return _NOMINAL_BLOCK_BYTES


class ThinkingReplayCache:
    """Signed thinking blocks of the current request, keyed by the turn's tool_use ids.

    Anthropic signs each thinking block against the conversation prefix, and Jenny does
    not persist signatures, so blocks live only for one request's tool loop and are
    never offered to another request. FIFO eviction by first capture on count and bytes.
    """

    def __init__(self, max_entries: int = DEFAULT_MAX_REPLAY_ENTRIES) -> None:
        self._max_entries = max(1, min(int(max_entries), MAX_REPLAY_ENTRIES_CEILING))
        self._blocks: dict[tuple[str, str], tuple[dict[str, Any], ...]] = {}
        self._sizes: dict[tuple[str, str], int] = {}
        self._order: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._total_bytes = 0
        self._lock = threading.RLock()

    def store(
        self, request_key: str, tool_ids: Sequence[str], blocks: Sequence[Mapping[str, Any]]
    ) -> None:
        if not request_key or not blocks:
            return
        frozen = tuple(dict(block) for block in blocks)
        size = sum(_block_size(block) for block in frozen)
        with self._lock:
            for tool_id in tool_ids:
                key = (request_key, str(tool_id))
                self._total_bytes -= self._sizes.get(key, 0)
                self._blocks[key] = frozen
                self._sizes[key] = size
                self._total_bytes += size
                self._order.setdefault(key, None)
            self._evict_locked()

    def snapshot(self, request_key: str) -> dict[str, tuple[dict[str, Any], ...]]:
        if not request_key:
            return {}
        with self._lock:
            return {tid: blocks for (rk, tid), blocks in self._blocks.items() if rk == request_key}

    def release(self, request_key: str) -> None:
        if not request_key:
            return
        with self._lock:
            for key in [key for key in self._order if key[0] == request_key]:
                self._drop_locked(key)

    def clear(self) -> None:
        with self._lock:
            self._blocks.clear()
            self._sizes.clear()
            self._order.clear()
            self._total_bytes = 0

    def __len__(self) -> int:
        with self._lock:
            return len(self._blocks)

    def _drop_locked(self, key: tuple[str, str]) -> None:
        self._order.pop(key, None)
        self._blocks.pop(key, None)
        self._total_bytes -= self._sizes.pop(key, 0)

    def _evict_locked(self) -> None:
        while self._order and (
            len(self._order) > self._max_entries or self._total_bytes > MAX_REPLAY_BYTES
        ):
            self._drop_locked(next(iter(self._order)))
        self._total_bytes = max(0, self._total_bytes)


# -- messages ----------------------------------------------------------------------


def _text_of(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    return "".join(
        str(item["text"])
        for item in value
        if isinstance(item, dict) and isinstance(item.get("text"), str)
    )


def _role_of(message: EngineMessage) -> str:
    role = message.get("role")
    return role.strip().lower() if isinstance(role, str) else ""


def _text_block(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def _image_blocks(message: EngineMessage, *, vision: bool) -> list[dict[str, Any]]:
    images = message.get("images")
    if not vision or not isinstance(images, list):
        return []
    return [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image.mime_type,
                "data": image.as_base64(),
            },
        }
        for image in images
        if isinstance(image, VisionImage) and image.mime_type in _IMAGE_MEDIA_TYPES
    ]


def _call_fields(raw: Any) -> tuple[str, str, dict[str, Any]] | None:
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or raw.get("tool_id") or "").strip()
    call_id = str(raw.get("call_id") or raw.get("id") or "").strip()
    if not name or not call_id:
        return None
    arguments = raw.get("arguments")
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except ValueError:
            arguments = {}
    return name, call_id, arguments if isinstance(arguments, dict) else {}


def _paired_call_ids(messages: Sequence[EngineMessage]) -> set[str]:
    """Ids with both a tool_use and a tool_result; the API rejects an unpaired block."""
    calls: set[str] = set()
    results: set[str] = set()
    for message in messages:
        role = _role_of(message)
        if role == "assistant":
            for raw in message.get("tool_calls") or []:
                fields = _call_fields(raw)
                if fields is not None:
                    calls.add(fields[1])
        elif role == "tool":
            call_id = message.get("tool_call_id")
            if isinstance(call_id, str) and call_id.strip():
                results.add(call_id.strip())
    return calls & results


def _assistant_blocks(
    message: EngineMessage,
    paired: set[str],
    replay: Mapping[str, Sequence[dict[str, Any]]],
) -> list[dict[str, Any]]:
    content = _text_of(message.get("content"))
    calls = [
        fields
        for raw in message.get("tool_calls") or []
        if (fields := _call_fields(raw)) is not None and fields[1] in paired
    ]
    blocks: list[dict[str, Any]] = []
    for _name, call_id, _arguments in calls:
        cached = replay.get(call_id)
        if cached:
            blocks.extend(dict(block) for block in cached)
            break
    placeholder_only = bool(calls) and content == EMPTY_ASSISTANT_CONTENT_PLACEHOLDER
    if content.strip() and not placeholder_only:
        blocks.append(_text_block(content))
    blocks.extend(
        {"type": "tool_use", "id": call_id, "name": name, "input": arguments}
        for name, call_id, arguments in calls
    )
    return blocks


def _tool_result_block(message: EngineMessage) -> dict[str, Any] | None:
    call_id = message.get("tool_call_id")
    if not isinstance(call_id, str) or not call_id.strip():
        return None
    text = _text_of(message.get("content"))
    return {
        "type": "tool_result",
        "tool_use_id": call_id.strip(),
        "content": text if text.strip() else _EMPTY_TOOL_OUTPUT,
    }


def _merge_turns(turns: list[tuple[str, list[dict[str, Any]]]]) -> list[dict[str, Any]]:
    """Merge consecutive same-role turns so one round's tool_results share one user message."""
    merged: list[dict[str, Any]] = []
    for role, blocks in turns:
        if not blocks:
            continue
        if merged and merged[-1]["role"] == role:
            merged[-1]["content"].extend(blocks)
        else:
            merged.append({"role": role, "content": list(blocks)})
    for message in merged:
        if message["role"] == "user":
            # tool_result blocks must lead the user message that answers a tool round.
            message["content"].sort(key=lambda block: block["type"] != "tool_result")
    while merged and merged[0]["role"] != "user":
        merged.pop(0)
    return merged


def split_system(system: str, messages: Sequence[EngineMessage]) -> tuple[str, list[EngineMessage]]:
    """Fold ``system`` and the leading system run into one block; return the remainder."""
    base = str(system or "")
    base_key = base.strip()
    segments: list[str] = [base] if base_key else []
    cursor = 0
    for message in messages:
        if _role_of(message) != "system":
            break
        text = _text_of(message.get("content"))
        if text.strip() and text.strip() != base_key:
            segments.append(text)
        cursor += 1
    return _SYSTEM_JOINER.join(segments), list(messages[cursor:])


def build_messages(
    prompt: str,
    messages: Sequence[EngineMessage] | None,
    *,
    vision: bool,
    replay: Mapping[str, Sequence[dict[str, Any]]],
) -> list[dict[str, Any]]:
    if not messages:
        return [{"role": "user", "content": [_text_block(prompt)]}] if prompt.strip() else []
    paired = _paired_call_ids(messages)
    turns: list[tuple[str, list[dict[str, Any]]]] = []
    for message in messages:
        role = _role_of(message)
        text = _text_of(message.get("content"))
        if role == "system" and text.strip():
            turns.append(("user", [_text_block(text)]))
        elif role == "user":
            blocks = _image_blocks(message, vision=vision)
            if text.strip():
                blocks.append(_text_block(text))
            turns.append(("user", blocks))
        elif role == "assistant":
            turns.append(("assistant", _assistant_blocks(message, paired, replay)))
        elif role == "tool":
            block = _tool_result_block(message)
            if block is not None and block["tool_use_id"] in paired:
                turns.append(("user", [block]))
    return _merge_turns(turns)


def build_tools(tools: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for tool in tools:
        name = str(tool.get("name") or "").strip()
        if not name or tool.get("defer_loading") is True:
            continue
        schema = tool.get("parameters")
        input_schema = dict(schema) if isinstance(schema, dict) else {}
        input_schema.setdefault("type", "object")
        payload.append(
            {
                "name": name,
                "description": str(tool.get("description") or "").strip(),
                "input_schema": input_schema,
                "eager_input_streaming": True,
            }
        )
    return payload


def build_request(  # noqa: PLR0913 - explicit request-shaping contract.
    *,
    model: str,
    max_tokens: int,
    system: str,
    prompt: str,
    messages: Sequence[EngineMessage] | None,
    tools: Sequence[dict[str, Any]],
    thinking: bool,
    effort: str | None,
    vision: bool,
    replay: Mapping[str, Sequence[dict[str, Any]]],
) -> tuple[dict[str, Any], dict[str, str]]:
    """The request body plus the per-request headers (the thinking beta, when requested)."""
    system_text, remainder = split_system(system, messages or [])
    history = build_messages(
        prompt,
        remainder if messages else None,
        vision=vision,
        replay=replay if thinking else {},
    )
    payload: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "stream": True,
        "messages": history,
        "cache_control": dict(_EPHEMERAL),
    }
    if system_text.strip():
        payload["system"] = [
            {"type": "text", "text": system_text, "cache_control": dict(_EPHEMERAL)}
        ]
    tool_payload = build_tools(tools)
    if tool_payload:
        payload["tools"] = tool_payload
        payload["tool_choice"] = {"type": "auto"}
    headers: dict[str, str] = {}
    if thinking:
        payload["thinking"] = {
            "type": "adaptive",
            "display": "summarized",
            "block_binding": {"prefix_mismatch_behavior": "drop_block"},
        }
        if effort is not None:
            payload["output_config"] = {"effort": effort}
        headers["anthropic-beta"] = THINKING_BETA
    return payload, headers


__all__ = [
    "ANTHROPIC_VERSION",
    "MAX_OUTPUT_CEILING",
    "THINKING_BETA",
    "ThinkingReplayCache",
    "build_messages",
    "build_request",
    "build_tools",
    "output_cap",
    "split_system",
    "static_headers",
    "thinking_effort",
]
