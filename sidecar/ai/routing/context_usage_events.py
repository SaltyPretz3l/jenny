"""Mid-turn ``context.usage`` snapshot emission for the composer context ring.

The tool loop already computes the exact "how full is the context window"
figure once per iteration (``compact_tool_loop_context`` feeding
``BudgetTracker.record_iteration``) and then discards it, so the ring showed
the PREVIOUS turn's number for the whole of a long agentic turn. This module
publishes that already-paid-for figure as an ephemeral
:class:`~sidecar.ai.routing.loop_events.ContextUsageEvent`.

Contract:

* EPHEMERAL — no canonical turn event, no journaling. ``chat.done`` stays the
  terminal truth.
* ``context_used_tokens`` uses the SAME ``max(provider truth, sidecar
  estimate)`` rule as ``attach_context_used_tokens`` at terminal, so mid-turn
  and terminal readings never disagree about how they were computed.
* NO cross-iteration high-water mark: compaction legitimately lowers the used
  figure and the ring must follow it back down.
* Emission requires a live ``budget_tracker`` AND the ``context_usage_live``
  flag. With ``token_budget`` off there is no tracker, so a turn emits nothing
  and behaves exactly as it did before this event existed.
* Repeated identical readings are suppressed through a request-scoped memo on
  the ``LoopRuntime`` (never cross-turn).
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.context.token_budget import resolve_context_window_hint
from sidecar.ai.feature_flags import (
    FEATURE_CONTEXT_COMPACTION,
    is_context_usage_live_enabled,
    is_feature_flag_enabled,
)
from sidecar.ai.routing.loop_events import ContextUsageEvent

PHASE_PREFLIGHT = "preflight"
PHASE_ITERATION = "iteration"


def _positive_int(value: Any) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def _context_window(engine: Any) -> int:
    """Same window ``attach_context_window`` publishes at terminal.

    ``resolve_context_window_hint`` (not ``resolve_effective_context_window``)
    so an unknown window stays 0 rather than publishing the generic fallback as
    if it were truth.
    """
    if engine is None:
        return 0
    try:
        return _positive_int(resolve_context_window_hint(engine))
    except Exception:  # noqa: BLE001 — a meter hint must never break a turn
        return 0


def _compact_threshold(budget_tracker: Any) -> int:
    """Exact compaction trigger for the tracker's current tool count.

    Recomputed per emission rather than cached: ``tool_search`` can promote
    deferred schemas between iterations, which moves the denominator.
    """
    budget = getattr(budget_tracker, "budget", None)
    if budget is None:
        return 0
    try:
        num_tools = _positive_int(getattr(budget_tracker, "num_tools", 0))
        return _positive_int(budget.auto_compact_threshold(num_tools))
    except Exception:  # noqa: BLE001 — a meter hint must never break a turn
        return 0


def emit_context_usage(  # noqa: PLR0913 — one flat snapshot, no wrapper DTO
    runtime: Any,
    *,
    phase: str,
    iteration: int,
    budget_tracker: Any,
    feature_flags: Any,
    config: Any,
    engine: Any,
    context_tokens_estimate: Any,
    last_request_input_tokens: Any = 0,
) -> ContextUsageEvent | None:
    """Emit one mid-turn meter snapshot; return the event, or ``None`` if skipped."""
    if runtime is None or budget_tracker is None:
        return None
    if not is_context_usage_live_enabled(feature_flags):
        return None

    estimate = _positive_int(context_tokens_estimate)
    provider_tokens = _positive_int(last_request_input_tokens)
    used = max(provider_tokens, estimate)
    if used <= 0:
        return None

    # Mirror the terminal lanes' gate (attach_compact_threshold call sites):
    # never advertise an auto-compact point that a disabled runtime will not
    # act on. token_budget is implied by the live budget_tracker.
    threshold = (
        _compact_threshold(budget_tracker)
        if is_feature_flag_enabled(feature_flags, FEATURE_CONTEXT_COMPACTION)
        else 0
    )
    window = _context_window(engine)
    signature = (used, threshold, window)
    if getattr(runtime, "context_usage_memo", None) == signature:
        return None
    runtime.context_usage_memo = signature

    event = ContextUsageEvent(
        phase=str(phase or PHASE_ITERATION),
        iteration=max(0, int(iteration or 0)),
        context_used_tokens=used,
        context_used_source="provider" if provider_tokens >= estimate else "estimate",
        context_tokens_estimate=estimate,
        last_request_input_tokens=provider_tokens,
        context_window=window,
        compact_threshold_tokens=threshold,
        model=str(getattr(config, "model", "") or ""),
        provider=str(getattr(config, "engine_type", "") or ""),
    )
    runtime.emit_safe(event)
    return event
