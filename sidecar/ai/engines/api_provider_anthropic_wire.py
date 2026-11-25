"""Anthropic Messages request building for a user's own API key (row 78, P3a).

Pure request shaping, no I/O: headers, the message-history mapping, the tool
payload, the adaptive-thinking switches and the request-keyed cache that
replays signed thinking blocks inside one tool loop. SSE parsing lives in
``api_provider_anthropic_stream``; the engine in ``api_provider_anthropic``.

Prompt-cache layout: tools render before ``system``. The base prompt and the
leading system run are two system blocks with an ephemeral breakpoint each, so
the first caches tools plus the base prompt and a per-turn row in the run (the
memory recalled for this message, git context) costs only the run. The
top-level ``cache_control`` auto-caches the conversation tail (three
breakpoints, under the API's limit of four). Later system rows (wind-down and
budget nudges) are demoted in place to user text so the cached prefix stays
byte-stable between iterations.
"""

from __future__ import annotations

import json
import re
import threading
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sidecar.ai.context.context_rows import CONTEXT_ROLE, render_context_entries
from sidecar.ai.engines.base import EMPTY_ASSISTANT_CONTENT_PLACEHOLDER, EngineMessage
from sidecar.ai.engines.vision_input import VisionImage

ANTHROPIC_VERSION = "2026-10-21"
THINKING_BETA = "thinking-binding-controls-2026-08-01"
# Thinking counts toward ``max_tokens``, so a large window gets a 64,000 default. A
# smaller window keeps 32,768, which its context budget is sized around; a larger
# reply is the user's explicit pin.
DEFAULT_OUTPUT_CEILING = 64_000
SMALL_WINDOW_OUTPUT_CEILING = 32_768
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
_OFF_EFFORT = "none"
_DEFAULT_EFFORTS = frozenset({"", "default"})
# ``claude-<family>-<major>[-<minor>]``; a trailing date is not a minor version.
_MODEL_VERSION_RE = re.compile(
    r"(?:^|[/.])claude-[a-z]+-(?P<major>\d{1,2})(?:[-.](?P<minor>\d{1,2}))?(?!\d)"
)
# ``claude-3-5-sonnet-...`` and older: the version leads the id.
_LEGACY_MODEL_RE = re.compile(r"(?:^|[/.])claude-(?P<major>\d)(?!\d)")
_ADAPTIVE_SINCE = (4, 6)
_XHIGH_SINCE = (4, 7)
_IMAGE_MEDIA_TYPES = frozenset({"image/jpeg", "image/png", "image/gif", "image/webp"})
_EMPTY_TOOL_OUTPUT = "(no output)"

# Replay cache bounds: one entry per tool call, so the count sits above the longest
# cloud turn (500 calls plus 30 browser calls), with an aggregate byte ceiling because
# a signed thinking block is an opaque blob of unbounded size. A finished chat turn's
# blocks are not released; they wait here for FIFO eviction.
DEFAULT_MAX_REPLAY_ENTRIES = 600
MAX_REPLAY_BYTES = 8 * 1024 * 1024
_NOMINAL_BLOCK_BYTES = 4096


def static_headers() -> dict[str, str]:
    return {
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "accept": "text/event-stream",
        # The stream is read as raw bytes; the API compresses it when a client offers
        # to accept that, and httpx offers by default.
        "accept-encoding": "identity",
    }


def output_cap(limits: Mapping[str, Any], context_length: int) -> int:
    """The reply budget: the model's limit inside half the window, with a default ceiling.

    The ceiling is 64,000 where that is at most an eighth of the window and 32,768
    otherwise, so a 200,000-token model compacts where it did before. A pinned limit
    has no ceiling.
    """
    cap = min(int(limits["max_output_tokens"]), context_length // 2)
    if limits["sources"]["max_output_tokens"] == "pin":
        return cap
    ceiling = max(SMALL_WINDOW_OUTPUT_CEILING, min(DEFAULT_OUTPUT_CEILING, context_length // 8))
    return min(cap, ceiling)


@dataclass(frozen=True)
class ThinkingPlan:
    """What one request says about thinking.

    ``adaptive`` sends the ``thinking`` field (adaptive, block binding, the beta header)
    and replays the held thinking blocks; without it the request names no thinking
    control at all. ``effort`` is ``output_config.effort``, or ``None`` for the model's
    default.
    """

    adaptive: bool
    effort: str | None = None
    display: str = "summarized"


_NO_THINKING = ThinkingPlan(adaptive=False)


def model_version(model: str) -> tuple[int, int] | None:
    """``(major, minor)`` of a Claude model id; ``None`` for any other id."""
    key = str(model or "").strip().lower()
    legacy = _LEGACY_MODEL_RE.search(key)
    if legacy is not None:
        return int(legacy["major"]), 0
    match = _MODEL_VERSION_RE.search(key)
    if match is None:
        return None
    return int(match["major"]), int(match["minor"] or 0)


def thinking_plan(requested: str | None, *, supported: bool, model: str) -> ThinkingPlan:
    """Map Jenny's effort setting onto the wire for ``model``.

    A Claude model from 4.6 on always gets adaptive thinking, because leaving the field
    out does not turn thinking off there: it runs at the model's default effort with no
    text. "Off" is therefore the lowest effort with the text omitted. Older Claude
    models take a token budget this transport does not send, so they get no thinking
    control. An id that is not a Claude version keeps the earlier shape: thinking only
    when an effort is asked for.
    """
    if not supported:
        return _NO_THINKING
    key = str(requested or "").strip().lower()
    version = model_version(model)
    if version is None:
        if key == _OFF_EFFORT or key in _DEFAULT_EFFORTS:
            return _NO_THINKING
        return ThinkingPlan(adaptive=True, effort=_EFFORT_LEVELS.get(key))
    if version < _ADAPTIVE_SINCE:
        return _NO_THINKING
    if key == _OFF_EFFORT:
        return ThinkingPlan(adaptive=True, effort="low", display="omitted")
    effort = _EFFORT_LEVELS.get(key)
    if effort == "xhigh" and version < _XHIGH_SINCE:
        effort = "high"
    return ThinkingPlan(adaptive=True, effort=effort)


# -- replay cache ----------------------------------------------------------------


def _block_size(block: Mapping[str, Any]) -> int:
    try:
        return len(json.dumps(block, separators=(",", ":"), default=str))
    except (TypeError, ValueError, RecursionError):
        return _NOMINAL_BLOCK_BYTES


class ThinkingReplayCache:
    """Signed thinking blocks per request, keyed by the turn's tool_use ids.

    Anthropic signs each thinking block against the conversation prefix, and Jenny does
    not persist signatures, so blocks serve one request's tool loop (an approval pause
    included) and are never offered to another request. FIFO eviction by first capture
    on count and bytes.
    """

    def __init__(self, max_entries: int = DEFAULT_MAX_REPLAY_ENTRIES) -> None:
        self._max_entries = max(1, int(max_entries))
        self._blocks: dict[tuple[str, str], tuple[dict[str, Any], ...]] = {}
        self._sizes: dict[tuple[str, str], int] = {}
        self._order: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._total_bytes = 0
        self._lock = threading.RLock()

    def store(
        self, request_key: str, tool_ids: Sequence[str], blocks: Sequence[Mapping[str, Any]]
    ) -> None:
        if not request_key or not blocks or not tool_ids:
            return
        frozen = tuple(dict(block) for block in blocks)
        # A parallel round's ids share these blocks, so each id carries an equal share
        # of the bytes: counting them whole per id evicted a busy turn's own blocks.
        share = -(-sum(_block_size(block) for block in frozen) // len(tool_ids))
        with self._lock:
            for tool_id in tool_ids:
                key = (request_key, str(tool_id))
                self._total_bytes -= self._sizes.get(key, 0)
                self._blocks[key] = frozen
                self._sizes[key] = share
                self._total_bytes += share
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
    block: dict[str, Any] = {
        "type": "tool_result",
        "tool_use_id": call_id.strip(),
        "content": text if text.strip() else _EMPTY_TOOL_OUTPUT,
    }
    if message.get("is_error") is True:
        block["is_error"] = True
    return block


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


def system_parts(
    system: str, messages: Sequence[EngineMessage]
) -> tuple[str, str, list[EngineMessage]]:
    """``(base, leading_run, remainder)``: the base prompt, the leading system run
    joined (deduped against the base), and the messages after the run."""
    base = str(system or "")
    base_key = base.strip()
    segments: list[str] = []
    cursor = 0
    for message in messages:
        if _role_of(message) != "system":
            break
        text = _text_of(message.get("content"))
        if text.strip() and text.strip() != base_key:
            segments.append(text)
        cursor += 1
    return base, _SYSTEM_JOINER.join(segments), list(messages[cursor:])


def system_blocks(base: str, run: str) -> list[dict[str, Any]]:
    """One cached block for the base prompt and one for the leading run.

    The leading run holds per-turn rows (memory recalled for this message, the
    tool-set hash, git and active-file context), so folding it into the base
    block made every turn's first call re-read tools plus the whole system
    prompt. With its own breakpoint the stable base stays a cache hit (three
    breakpoints with the top-level one, under the API's four).
    """
    return [
        {"type": "text", "text": text, "cache_control": dict(_EPHEMERAL)}
        for text in (base, run)
        if text.strip()
    ]


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


def _required_sets(branches: Any) -> list[str]:
    """Each branch's required arguments, when every branch is such a list; else nothing."""
    sets: list[str] = []
    for branch in branches if isinstance(branches, list) else []:
        required = branch.get("required") if isinstance(branch, dict) else None
        if not isinstance(required, list) or not required:
            return []
        sets.append(" + ".join(str(key) for key in required))
    return sets


def _input_schema(tool: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
    """``(input_schema, description)`` in the shape the Messages API admits.

    The API answers 400 to a top-level ``anyOf``, ``oneOf`` or ``allOf`` in a tool's
    ``input_schema``, which is how Jenny's schemas say "one of these argument sets".
    The combinator is dropped from the model-facing copy and its sets are named in the
    description; the call is still checked against the full schema before it runs.
    """
    schema = tool.get("parameters")
    input_schema = dict(schema) if isinstance(schema, dict) else {}
    input_schema.setdefault("type", "object")
    description = str(tool.get("description") or "").strip()
    input_schema.pop("allOf", None)
    for key in ("anyOf", "oneOf"):
        sets = _required_sets(input_schema.pop(key, None))
        if sets:
            description = f"{description} Give one of these argument sets: {'; '.join(sets)}."
    return input_schema, description.strip()


def build_tools(tools: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for tool in tools:
        name = str(tool.get("name") or "").strip()
        if not name or tool.get("defer_loading") is True:
            continue
        input_schema, description = _input_schema(tool)
        payload.append(
            {
                "name": name,
                "description": description,
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
    thinking: ThinkingPlan,
    vision: bool,
    replay: Mapping[str, Sequence[dict[str, Any]]],
) -> tuple[dict[str, Any], dict[str, str]]:
    """The request body plus the per-request headers (the thinking beta, when requested)."""
    system_base, system_run, remainder = system_parts(system, messages or [])
    history = build_messages(
        prompt,
        remainder if messages else None,
        vision=vision,
        # Without the block-binding field an edited history is a hard error on an
        # enforced account, so blocks are replayed only alongside it.
        replay=replay if thinking.adaptive else {},
    )
    payload: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "stream": True,
        "messages": history,
        "cache_control": dict(_EPHEMERAL),
    }
    if blocks := system_blocks(system_base, system_run):
        payload["system"] = blocks
    tool_payload = build_tools(tools)
    if tool_payload:
        payload["tools"] = tool_payload
        payload["tool_choice"] = {"type": "auto"}
    headers: dict[str, str] = {}
    if thinking.adaptive:
        payload["thinking"] = {
            "type": "adaptive",
            "display": thinking.display,
            "block_binding": {"prefix_mismatch_behavior": "drop_block"},
        }
        if thinking.effort is not None:
            payload["output_config"] = {"effort": thinking.effort}
        headers["anthropic-beta"] = THINKING_BETA
    return payload, headers


# Generation-only fields the count endpoint does not take.
_COUNT_DROPPED_FIELDS = ("max_tokens", "stream", "cache_control")


def build_count_request(
    *,
    model: str,
    messages: Sequence[Any],
    tools: Sequence[dict[str, Any]],
    vision: bool,
) -> dict[str, Any] | None:
    """The ``/messages/count_tokens`` body for these router rows (row 183 W2).

    The same system blocks, history and tools a real request sends, without the generation
    fields or thinking. ``context`` rows (linked chats, handoffs) count as their user entries.
    ``None`` with no messages, or with an image: the ladder budgets images itself.
    """
    rows: list[Any] = []
    for message in messages:
        if isinstance(message, dict) and str(message.get("role", "")).lower() == CONTEXT_ROLE:
            rows.extend(render_context_entries(message))
        else:
            rows.append(message)
    if not rows:
        return None
    payload, _headers = build_request(
        model=model, max_tokens=1, system="", prompt="", messages=rows, tools=tools,
        thinking=_NO_THINKING, vision=vision, replay={},
    )
    if any(
        isinstance(block, dict) and block.get("type") == "image"
        for message in payload["messages"]
        for block in (message.get("content") if isinstance(message.get("content"), list) else ())
    ):
        return None
    for field_name in _COUNT_DROPPED_FIELDS:
        payload.pop(field_name, None)
    for tool in payload.get("tools", ()):
        tool.pop("eager_input_streaming", None)  # a streaming field the count does not need
    return payload if payload["messages"] else None


__all__ = [
    "ANTHROPIC_VERSION",
    "DEFAULT_OUTPUT_CEILING",
    "SMALL_WINDOW_OUTPUT_CEILING",
    "THINKING_BETA",
    "ThinkingPlan",
    "ThinkingReplayCache",
    "build_count_request",
    "build_messages",
    "build_request",
    "build_tools",
    "model_version",
    "output_cap",
    "system_blocks",
    "system_parts",
    "static_headers",
    "thinking_plan",
]
