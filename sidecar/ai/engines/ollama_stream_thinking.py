"""Thinking-stream helpers for the Ollama runtime stream loops."""

from __future__ import annotations

import logging
from typing import Any

from sidecar.runtime.ollama_support import StreamingEvent, ThinkingRepetitionGuard

logger = logging.getLogger("sidecar.ai.engines.ollama_runtime")


def _thinking_stop_reason(thinking_guard: ThinkingRepetitionGuard | None) -> str | None:
    if thinking_guard is None:
        return None
    return thinking_guard.stop_reason


def _thinking_suppressed(
    thinking_guard: ThinkingRepetitionGuard | None,
    text: str,
) -> bool:
    return thinking_guard is not None and thinking_guard.feed(text)


def _emit_thinking(
    engine: Any,
    thinking_guard: ThinkingRepetitionGuard | None,
    text: str,
    *,
    suppression_state: list[bool] | None = None,
    thinking_parts: list[str] | None = None,
):
    if _thinking_suppressed(thinking_guard, text):
        if suppression_state is not None and not suppression_state[0]:
            logger.info(
                "Suppressing Ollama thinking stream after guard tripped.",
                extra={
                    "model": engine.model_name,
                    "reason": _thinking_stop_reason(thinking_guard),
                },
            )
            suppression_state[0] = True
        return
    if thinking_parts is not None:
        thinking_parts.append(text)
    yield StreamingEvent(kind="thinking", text=text)


def _thinking_delta(accumulated: str, chunk: str) -> tuple[str, str]:
    """Append an incremental thinking chunk verbatim.

    Ollama streams ``message.thinking`` per token, so a chunk equal to or
    prefixed by earlier text is a real repeat (``"0","0"``, ``" is"," island"``),
    never a cumulative snapshot; any dedupe here silently corrupts numbers.
    """
    if not chunk:
        return "", accumulated
    return chunk, accumulated + chunk


_MALFORMED_LINE_LOG_CAP = 3


def _note_malformed_stream_line(engine: Any, malformed_count: int, line: object) -> int:
    """Count malformed NDJSON lines, logging the first three per request.

    Only line length is recorded, never content.
    """
    malformed_count += 1
    if malformed_count <= _MALFORMED_LINE_LOG_CAP:
        try:
            line_length = len(line)  # type: ignore[arg-type]
        except TypeError:
            line_length = -1
        logger.warning(
            "Skipping malformed Ollama NDJSON line (possible token loss).",
            extra={
                "model": getattr(engine, "model_name", ""),
                "malformed_line_count": malformed_count,
                "line_length": line_length,
                "further_occurrences_suppressed": malformed_count == _MALFORMED_LINE_LOG_CAP,
            },
        )
    return malformed_count
