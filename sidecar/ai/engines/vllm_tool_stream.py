"""Tool-stream helpers for the vLLM / OpenAI-compatible engine.

Split from ``vllm_engine_generation.py`` (at the 1015-line ratchet, 2026-09-20)
when truncated-tool-call handling and guard verdict logging landed. Same
extraction-not-hub shape as ``vllm_sse_stream.py``.
"""

from __future__ import annotations

import logging
from collections.abc import Generator
from typing import Any

from sidecar.ai.engines.engine_events import ENGINE_EVENT_TOOL_CALL_DELTA, EngineEvent
from sidecar.ai.engines.vllm_sse_stream import (
    _decode_sse_chunk,
    _iter_cancel_aware_sse_lines,
    _parse_usage,
)
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_PROVIDER_ERROR,
    NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS,
    NORMALIZED_KIND_TOOL_CALL_COMPLETED,
    NORMALIZED_KIND_TOOL_CALL_DELTA,
    NORMALIZED_KIND_TOOL_CALL_INCOMPLETE,
    NormalizedStreamEvent,
    ProviderStreamNormalizer,
)
from sidecar.ai.thinking_guard import budget_trip_check, thinking_budget_abort_enabled
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.vllm_engine_support import (
    GenerationError,
    GenerationUsage,
    StreamChunk,
    StreamingEvent,
    ThinkingRepetitionGuard,
    _normalize_content,
    extract_reasoning_delta,
)

logger = logging.getLogger(__name__)

THINKING_BUDGET_ABORT_EVENT = "ai.engines.vllm.thinking_budget_abort"
THINKING_GUARD_SUPPRESSED_EVENT = "ai.engines.vllm.thinking_guard_suppressed"
TOOL_CALL_TRUNCATED_EVENT = "ai.engines.vllm.tool_call_truncated"
TOOL_CALL_REJECTED_EVENT = "ai.engines.vllm.tool_call_rejected"

_SSE_DATA_PREFIX = "data: "
_SSE_DONE_SENTINEL = "[DONE]"


def _raise_if_cancelled(cancel_handle: Any) -> None:
    if cancel_handle is None:
        return
    raise_method = getattr(cancel_handle, "raise_if_cancelled", None)
    if callable(raise_method):
        raise_method()


def _collect_normalized_tool_calls(
    events: list[NormalizedStreamEvent],
    calls: list[ToolCallRequest],
    *,
    truncated: list[NormalizedStreamEvent] | None = None,
) -> bool:
    """Collect completed calls; return whether any tool-call arguments streamed.

    A ``tool_call_incomplete`` event (arguments cut off by the provider's
    ``length`` terminal or by EOF) is never executed and never fatal: it is
    recorded in ``truncated`` and the caller's finish reason (``length`` /
    ``incomplete``) carries the verdict to the thinking-budget checkpoint
    continuation. Owner turn 2026-09-20: this used to raise CMP-AI-0005
    before the finish reason was ever resolved. Unparseable JSON under a
    clean terminal stays the model's own error.
    """
    saw_argument_delta = False
    for event in events:
        if event.kind == NORMALIZED_KIND_TOOL_CALL_DELTA:
            saw_argument_delta = True
        elif event.kind == NORMALIZED_KIND_TOOL_CALL_INCOMPLETE:
            if truncated is not None:
                truncated.append(event)
        elif event.kind == NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS:
            raise GenerationError("vLLM returned malformed tool-call arguments")
        if (
            event.kind != NORMALIZED_KIND_TOOL_CALL_COMPLETED
            or not isinstance(event.arguments_delta, dict)
        ):
            continue
        calls.append(
            ToolCallRequest(
                tool_id=str(event.tool_name or ""),
                arguments=dict(event.arguments_delta),
                call_id=str(event.tool_call_id or ""),
            )
        )
    return saw_argument_delta


def _tool_argument_delta_events(
    events: list[NormalizedStreamEvent],
) -> Generator[EngineEvent, None, None]:
    for event in events:
        if event.kind != NORMALIZED_KIND_TOOL_CALL_DELTA:
            continue
        yield EngineEvent(
            kind=ENGINE_EVENT_TOOL_CALL_DELTA,
            tool_call_id=str(event.tool_call_id or ""),
            tool_name=event.tool_name,
            arguments_delta=str(event.arguments_delta or ""),
            sequence=int(event.sequence),
        )


def log_truncated_tool_calls(
    engine: Any,
    truncated: list[NormalizedStreamEvent],
    *,
    terminal_finish_reason: str,
    rejected: bool = False,
) -> None:
    """Name the tool calls dropped because their arguments never finished."""
    if rejected:
        logger.warning(
            "Dropped tool-call input rejected at the argument cap.",
            extra={
                "event": TOOL_CALL_REJECTED_EVENT,
                "model": engine.model_name,
                "reason": "argument_bytes",
                "terminal_finish_reason": str(terminal_finish_reason or ""),
            },
        )
    if not truncated:
        return
    logger.warning(
        "Dropped %d tool call(s) cut off before their arguments finished.",
        len(truncated),
        extra={
            "event": TOOL_CALL_TRUNCATED_EVENT,
            "model": engine.model_name,
            "tool_names": [str(event.tool_name or "") for event in truncated],
            "terminal_finish_reason": str(terminal_finish_reason or ""),
            "argument_chars": sum(len(str(event.arguments_delta or "")) for event in truncated),
        },
    )


def log_guard_verdict(
    engine: Any,
    guard: ThinkingRepetitionGuard | None,
    *,
    aborted: bool,
) -> None:
    """Say at stream end why reasoning was suppressed and how much was counted.

    The engine can suppress deltas before the router ever sees them, so the
    router's own guard log cannot be relied on to explain a silent stream.
    """
    if aborted:
        logger.info(
            "Thinking budget aborted.",
            extra={
                "event": THINKING_BUDGET_ABORT_EVENT,
                "model": engine.model_name,
                "reason": "char_limit",
                "counted_chars": guard.total_chars if guard is not None else None,
                "max_chars": guard.max_chars if guard is not None else None,
            },
        )
        return
    if guard is None or not guard.should_stop:
        return
    logger.info(
        "Thinking stream suppressed by the guard.",
        extra={
            "event": THINKING_GUARD_SUPPRESSED_EVENT,
            "model": engine.model_name,
            "reason": guard.stop_reason,
            "counted_chars": guard.total_chars,
            "max_chars": guard.max_chars,
        },
    )


def _emit_tool_thinking(
    guard: ThinkingRepetitionGuard | None, text: str, parts: list[str]
) -> Generator[StreamChunk, None, None]:
    if not text or (guard is not None and guard.feed(text)):
        return
    parts.append(text)
    yield StreamingEvent(kind="thinking", text=text)


def _log_native_reasoning_suppressed(engine: Any, text: str) -> None:
    context = engine._current_request_context()
    sentinel = context if isinstance(context, dict) else vars(engine)
    if sentinel.get("native_reasoning_suppressed_logged") is True:
        return
    sentinel["native_reasoning_suppressed_logged"] = True
    logger.warning(
        "Dropping %s provider reasoning: reasoning output is disabled for this model.",
        engine._DISPLAY_NAME,
        extra={
            "model": engine.model_name,
            "engine": engine._DISPLAY_NAME,
            "chars": len(text),
        },
    )


def _stream_tool_response(  # noqa: C901, PLR0912, PLR0913, PLR0915 - bounded SSE/parser state machine.
    engine: Any,
    response: Any,
    *,
    cancel_handle: Any,
    normalizer: ProviderStreamNormalizer,
    content_parts: list[str], thinking_parts: list[str],
    tool_calls: list[ToolCallRequest],
    parser: Any, guard: ThinkingRepetitionGuard | None,
    truncated: list[NormalizedStreamEvent] | None = None,
) -> Generator[
    StreamChunk | EngineEvent, None, tuple[GenerationUsage | None, bool, bool, str]
]:
    usage: GenerationUsage | None = None
    saw_sentinel = False
    inband_error = ""
    native_thinking_seen = False
    budget_tripped = budget_trip_check(guard)
    for line in _iter_cancel_aware_sse_lines(response, cancel_handle):
        data = line[len(_SSE_DATA_PREFIX) :].strip() if line.startswith(_SSE_DATA_PREFIX) else ""
        if data == _SSE_DONE_SENTINEL:
            saw_sentinel = True
            break
        chunk = _decode_sse_chunk(line)
        if chunk is None:
            continue
        if isinstance(chunk.get("usage"), dict):
            engine._record_provider_usage(chunk)
            usage = _parse_usage(
                chunk,
                model_name=engine.model_name,
                provider=engine._PROVIDER_LABEL,
            )
        normalized = list(normalizer.process_chunk(chunk))
        if _collect_normalized_tool_calls(normalized, tool_calls, truncated=truncated):
            # Arguments carry no visible text; without these a large tool call
            # (a whole file) reads as a silent, stalled engine to the watchdog,
            # and as more reasoning to the reader (gate B1 F19). The router
            # turns each into tool_input_delta, which names the call live.
            yield from _tool_argument_delta_events(normalized)
        if normalizer.terminal_finish_reason == FINISH_REASON_PROVIDER_ERROR:
            # Keep the provider's own words for the terminal-gap event, as stream() does.
            inband_error = str(chunk.get("error") or chunk.get("message") or "")[:200]
            break
        choices = chunk.get("choices")
        if not isinstance(choices, list) or not choices:
            continue
        first = choices[0] if isinstance(choices[0], dict) else {}
        delta = first.get("delta")
        if not isinstance(delta, dict):
            continue
        engine._record_first_chunk()
        reasoning = engine._sanitize_thinking(extract_reasoning_delta(delta))
        if reasoning:
            native_thinking_seen = True
            if engine._reasoning_output_enabled():
                yield from _emit_tool_thinking(guard, reasoning, thinking_parts)
            else:
                _log_native_reasoning_suppressed(engine, reasoning)
        content = _normalize_content(delta.get("content"))
        if content:
            parsed_reasoning = ""
            visible_content = engine._sanitize_content(content)
            if parser is not None and not native_thinking_seen:
                parsed_reasoning, parsed_visible = parser.feed(content)
                parsed_reasoning = engine._sanitize_thinking(parsed_reasoning)
                visible_content = engine._sanitize_content(parsed_visible)
            yield from _emit_tool_thinking(guard, parsed_reasoning, thinking_parts)
            if visible_content:
                engine._record_visible_output(visible_content)
                content_parts.append(visible_content)
                yield StreamingEvent(kind="content", text=visible_content)
        # Abort AFTER this chunk's visible content is out: the budget abort
        # ends the generation but must never eat text the provider already
        # delivered on the tripping chunk.
        if (
            not normalizer.saw_terminal_evidence
            and budget_tripped()
            and thinking_budget_abort_enabled()
        ):
            return usage, saw_sentinel, True, inband_error
    if parser is not None and not native_thinking_seen:
        tail_reasoning, tail_visible = parser.flush()
        yield from _emit_tool_thinking(
            guard, engine._sanitize_thinking(tail_reasoning), thinking_parts
        )
        if (
            not (saw_sentinel or normalizer.saw_terminal_evidence)
            and budget_tripped()
            and thinking_budget_abort_enabled()
        ):
            return usage, saw_sentinel, True, inband_error
        visible_tail = engine._sanitize_content(tail_visible)
        if visible_tail:
            engine._record_visible_output(visible_tail)
            content_parts.append(visible_tail)
            yield StreamingEvent(kind="content", text=visible_tail)
    return usage, saw_sentinel, False, inband_error
