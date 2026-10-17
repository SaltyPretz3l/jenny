"""Best-effort, loop-thread instrumentation for prompt heuristic fires."""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.routing import tool_budget_filter
from sidecar.ai.routing.loop_events import HeuristicFireEvent

logger = logging.getLogger(__name__)


def emit_heuristic_fire(runtime: Any, name: str, **detail: str | int | bool) -> None:
    """A diagnostic delivery failure must never change heuristic behavior."""
    try:
        runtime.emit(HeuristicFireEvent(name=name, detail=detail))
    except Exception:  # noqa: BLE001 - diagnostic delivery must never change heuristic behavior.
        logger.debug("Heuristic fire notification failed: %s", name, exc_info=True)


def append_cycle_hint(loop: Any, stop_reason: Any) -> None:
    """Keep the capped call-site at one line, with the emit after the row."""
    loop.working_messages.append({"role": "system", "content": stop_reason.user_hint})
    emit_heuristic_fire(loop.runtime, "loop_cycle_hint", code=stop_reason.code)


def emit_continuation_relevance(loop: Any) -> None:
    """Count only an applied budget filter that borrowed substantive history."""
    metadata = getattr(loop.tool_resolution_context, "budget_filter_metadata", None)
    if not metadata or isinstance(getattr(loop.request_context, "approved_plan", None), dict):
        return
    if (
        tool_budget_filter._is_continuation_utterance(loop.latest_user_content)
        and tool_budget_filter._most_recent_substantive_user_content(loop.working_messages)
    ):
        emit_heuristic_fire(loop.runtime, "continuation_relevance")
