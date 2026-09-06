"""Canonical models for engine-agnostic tool calling."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Dict, Generator, Optional, Tuple, Union
from uuid import uuid4

logger = logging.getLogger(__name__)

@dataclass(frozen=True)
class ToolSchema:
    """Canonical tool definition used across providers."""

    tool_id: str
    name: str
    description: str
    parameters: Dict[str, Any]
    source: str
    version: int
    capabilities: Tuple[str, ...] = ()
    permission_tier: int = 0


@dataclass(frozen=True)
class ToolCallRequest:
    """A tool invocation requested by the model."""

    tool_id: str
    arguments: Dict[str, Any]
    call_id: str = ""
    idempotency_key: str = ""
    coerced: bool = False
    # Set when the provider sent an ``arguments`` string that did not parse as
    # a JSON object. The call is carried (rather than dropped or turned into a
    # turn-fatal error) so the tool loop can reject exactly THAT call and let
    # the model retry, matching what the streaming path already does.
    malformed_arguments: bool = False
    # Healing-net tags applied to reach ``arguments`` (``closed_string``,
    # ``stripped_fence``, ...); empty when the payload parsed cleanly. Consumed
    # by the tool loop's structural-repair policy in ``tool_loop_recovery.py``.
    argument_repairs: tuple[str, ...] = ()


def coerce_tool_arguments(value: Any) -> Tuple[Dict[str, Any], Optional[str]]:
    """Resolve provider-supplied ``arguments`` into a dict or surface malformed raw text.

    Returns ``(parsed_dict, None)`` on success and ``({}, raw_string)`` when
    the value is a string that fails to parse as a JSON object. Empty/None
    values are treated as ``{}`` (success). Callers decide what a malformed
    payload means for their transport -- the streaming normalizer emits
    ``malformed_tool_arguments``; the non-streaming parser flags the
    ``ToolCallRequest``.

    Lives here, beside ``ToolCallRequest``, so the streaming and non-streaming
    paths cannot drift: they previously disagreed, with non-streaming silently
    coercing unparseable arguments to ``{}`` and dispatching anyway.
    """
    if isinstance(value, Mapping):
        return dict(value), None
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return {}, value
        if not isinstance(parsed, Mapping):
            return {}, value
        return dict(parsed), None
    return {}, None


def ensure_tool_call_id(
    call_id: object,
    *,
    provider: str,
    tool_name: str,
    request_id: str | None = None,
    position: int | None = None,
) -> str:
    """Return a stable call-id for a provider tool call.

    If the provider supplied a non-empty id, that id is returned unchanged.

    Otherwise a synthetic id is generated.  The synthetic id is deterministic
    when *request_id* is provided: it is keyed on request_id + provider +
    position + tool_name via SHA-256, ensuring that replaying the same provider
    output within one request always produces the same ids.

    When *request_id* is absent the id falls back to a random UUID-4 fragment.
    Engines that do not yet thread request_id through should still pass
    *position* so call sites are ready for the deterministic path once
    request_id is wired in at the generation layer.
    """
    normalized = str(call_id or "").strip()
    if normalized:
        return normalized
    provider_token = (
        "".join(
            character
            for character in str(provider or "tool").strip().lower()
            if character.isalnum() or character == "_"
        )
        or "tool"
    )
    tool_token = (
        "".join(
            character
            for character in str(tool_name or "call").strip().lower()
            if character.isalnum() or character == "_"
        )
        or "call"
    )
    if request_id:
        key = (
            f"{request_id}:{provider_token}:{position if position is not None else 0}:{tool_token}"
        )
        digest = hashlib.sha256(key.encode()).hexdigest()[:16]
        return f"{provider_token}_{tool_token}_{digest}"
    # Fallback synthesis is expected for engines that omit request IDs, so log it at DEBUG.
    logger.debug(
        "ensure_tool_call_id: synthesizing non-deterministic id "
        "provider=%s tool=%s position=%s (pass request_id for deterministic synthesis)",
        provider_token,
        tool_token,
        position if position is not None else 0,
    )
    return f"{provider_token}_{tool_token}_{uuid4().hex[:10]}"


@dataclass(frozen=True)
class GenerationUsage:
    """Normalized provider usage for a single model generation step."""

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    provider: str = ""
    model: str = ""
    provider_cost_usd: float | None = None
    raw_usage: Dict[str, Any] = field(default_factory=dict)
    # Input tokens of the MOST RECENT generation request. Unlike input_tokens
    # (summed across tool-loop iterations by _merge_generation_usage), merges
    # OVERWRITE this with the latest iteration's value, so it stays a
    # "current request size" reading for the context meter.
    last_request_input_tokens: int = 0
    generation_tokens: int = 0
    generation_duration_ms: float = 0
    prompt_eval_duration_ms: float = 0
    load_duration_ms: float = 0
    time_to_first_token_ms: float = 0


@dataclass(frozen=True)
class GenerationResult:
    """Result from ``generate_with_tools()`` calls.

    ``degraded_tool_transport`` marks a result produced by a plain-generation
    fallback after the engine rejected the native tool payload for this
    request (e.g. Ollama HTTP 400 on a template that rejects tool schemas).
    The tool loop surfaces the degradation to the user; the engine retries
    native tools on the next request.
    """

    content: str = ""
    tool_calls: Tuple[ToolCallRequest, ...] = ()
    finish_reason: str = "stop"
    usage: Optional[GenerationUsage] = None
    thinking_text: str = ""
    degraded_tool_transport: bool = False
    # Set only when an engine actually ran the in-band parser and an explicit
    # candidate failed to parse. Routing must not infer this from response text.
    inband_tool_call_parse_failed: bool = False


# ---------------------------------------------------------------------------
# Extended thinking / streaming types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ThinkingDelta:
    """Emitted by the engine during streaming when extended thinking is active.

    This is a pure data-transfer object — it carries no UI dependencies.
    The orchestrator maps it to dashboard ThinkingStep objects.
    """

    text: str
    is_complete: bool = False


@dataclass(frozen=True)
class StreamingEvent:
    """Structured text-generation stream event.

    Terminal ``kind="done"`` events may carry the provider finish reason
    (e.g. ``"stop"`` or ``FINISH_REASON_REASONING_ONLY``) and the
    provider-reported :class:`GenerationUsage` so consumers get
    request-scoped signals instead of reading shared engine attributes.
    """

    kind: str
    text: str = ""
    finish_reason: str = ""
    usage: Optional[GenerationUsage] = None


StreamChunk = Union[str, ToolCallRequest, ThinkingDelta, StreamingEvent]
"""A single chunk yielded during tool-aware streaming."""

ToolStream = Generator[StreamChunk, None, None]
"""Generator type for ``stream_with_tools()`` methods."""
