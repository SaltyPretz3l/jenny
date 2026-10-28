"""Capture an exact unstarted suffix after settled ordinary tool effects."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from functools import partial
from types import SimpleNamespace
from typing import Any

from sidecar.ai.routing.tool_resource_deferral import (
    BeforeToolDispatchContinuation,
    ToolLoopSuspended,
    _freeze_loop_quota,
    build_before_tool_dispatch_continuation,
    canonical_json_bytes,
    extend_continuation,
)
from sidecar.runtime.continuation_outcomes import outcome_refs
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

_MAX_EFFECTS = 256


@dataclass(frozen=True, slots=True)
class ResourceProgressContinuation(BeforeToolDispatchContinuation):
    completed_effects_json: bytes = b"[]"
    prior_checkpoint_json: bytes | None = None
    prior_effect_count: int = 0
    current_execution_count: int = 0

    def _prior_outcome_count(self) -> int:
        return self.tool_calls_consumed - len(self.ordered_call_ids)

    def __post_init__(self) -> None:
        effects = json.loads(self.completed_effects_json)
        pending = set(self.ordered_call_ids)
        if (
            not isinstance(effects, list)
            or not effects
            or len(effects) >= _MAX_EFFECTS
            or not len(pending) <= self.tool_calls_consumed <= len(pending) + len(effects)
            or not 0 <= self.prior_effect_count <= len(effects)
            or (self.prior_checkpoint_json is None and self.prior_effect_count)
            or not 0 <= self.current_execution_count <= len(effects) - self.prior_effect_count
            or any(ref["call_id"] in pending for ref in effects)
        ):
            raise ValueError("resource_progress_invalid")
        BeforeToolDispatchContinuation.__post_init__(self)


@dataclass(frozen=True, slots=True)
class SettledEffects:
    """Every completed effect ref, proven to extend the predecessor and be settled."""

    effects: list[dict]
    previous: list[dict]
    predecessor: dict | None
    current_execution_count: int

    def checkpoint_fields(self) -> dict[str, Any]:
        return {
            "completed_effects_json": canonical_json_bytes(self.effects),
            "prior_checkpoint_json": (
                canonical_json_bytes(self.predecessor) if self.predecessor else None
            ),
            "prior_effect_count": len(self.previous),
            "current_execution_count": self.current_execution_count,
        }


def settled_effects(
    loop: Any, *, tool_calls: tuple = (), quota_state_json: bytes | None
) -> SettledEffects | None:
    """Return the settled effect ledger, or None while a current execution is unsettled.

    Raises ValueError when the request carries unsupported transient state or the
    completed effects no longer extend the predecessor checkpoint's effects.
    """

    # Imported at the request edge: decision snapshot imports the checkpoint
    # transport, which imports the legacy dependency dataclass at startup.
    from sidecar.runtime.decision_checkpoint import _assert_supported, _previous

    _assert_supported(
        SimpleNamespace(
            request_context=loop.request_context,
            quota_state_json=quota_state_json,
            tool_calls=tool_calls,
            outcomes=loop.outcomes,
            frozen_inputs=(),
            tool_contract=loop.tool_contract,
        )
    )
    previous, predecessor = _previous(loop.request_context)
    effects = outcome_refs(loop.outcomes)
    if effects[: len(previous)] != previous:
        raise ValueError("continuation_effects_changed")
    previous_ids = {ref["call_id"] for ref in previous}
    current = {item.call_id: item for item in loop.outcomes if item.call_id not in previous_ids}
    runtime = loop.runtime
    records = runtime.emitted_tool_calls
    if any(
        call_id not in current
        or call_id not in runtime.tool_result_emitted_call_ids
        or record.get("tool_name") != current[call_id].tool_name
        or record.get("arguments") != current[call_id].tool_input
        for call_id, record in records.items()
    ):
        return None
    return SettledEffects(effects, previous, predecessor, len(records))


def _capture(loop: Any, iteration: int, deferred: Any, calls: tuple) -> Any:
    runtime = loop.runtime
    if (
        not runtime.streaming
        or not callable(runtime.continuation_checkpoint)
        or runtime.preview_images
        or getattr(runtime, "mutation_started", False)
        or getattr(loop, "_jenny_change_set_id", "")
        or getattr(loop, "approvals_pre_granted", False)
        or getattr(loop.request_context, "approved_plan", None)
    ):
        return None
    quota = _freeze_loop_quota(loop)
    if quota is None or deferred.prepared is None:
        return None
    if deferred.prepared.frozen_input()["effective_tool_arguments"].get("_jenny_change_set_id"):
        return None
    settled = settled_effects(loop, tool_calls=calls, quota_state_json=quota)
    if settled is None or not settled.effects:
        return None
    deadline = runtime.wall_clock_deadline
    base = build_before_tool_dispatch_continuation(
        deferred,
        ordered_call_ids=tuple(call.call_id for call in calls),
        current_iteration=iteration,
        remaining_iterations=max(int(loop.iteration_total) - iteration, 0),
        tool_call_limit=runtime.tool_call_limit,
        tool_calls_consumed=len(calls),
        active_budget_ms_remaining=None
        if deadline is None
        else max(int((deadline - runtime.clock()) * 1000), 0),
        tool_calls=calls,
        quota_state_json=quota,
    )
    return extend_continuation(
        base,
        ResourceProgressContinuation,
        tool_calls_consumed=runtime.tool_calls_consumed,
        **settled.checkpoint_fields(),
    )


def _suspend(loop: Any, iteration: int, deferred: Any, calls: tuple) -> None:
    try:
        captured = _capture(loop, iteration, deferred, calls)
    except (ValueError, TypeError, AttributeError) as error:
        # Capture is optional: fall back to the legacy retryable wait, but keep
        # the reason observable.
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.resource_progress_capture_skipped",
            message="Resource progress continuation was not captured",
            status="degraded",
            data={"error_type": type(error).__name__},
        )
        return
    if captured is not None:
        # Publication failures propagate: never fabricate a pending result after
        # an ambiguous persistence attempt.
        raise ToolLoopSuspended(loop.runtime.continuation_checkpoint(captured))


def resource_deferral_callback(loop: Any, iteration: int) -> Any:
    return partial(_suspend, loop, iteration)
