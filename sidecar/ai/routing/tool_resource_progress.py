"""Capture an exact unstarted suffix after settled ordinary tool effects."""

from __future__ import annotations

import json
from dataclasses import dataclass, fields
from functools import partial
from types import SimpleNamespace
from typing import Any

from sidecar.ai.routing.tool_resource_deferral import (
    BeforeToolDispatchContinuation,
    ToolLoopSuspended,
    _freeze_loop_quota,
    build_before_tool_dispatch_continuation,
)
from sidecar.runtime.continuation_outcomes import outcome_refs

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


def _capture(loop: Any, iteration: int, deferred: Any, calls: tuple) -> Any:
    from sidecar.runtime.decision_checkpoint import _assert_supported, _previous  # noqa: PLC0415

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
    _assert_supported(
        SimpleNamespace(
            request_context=loop.request_context,
            quota_state_json=quota,
            tool_calls=calls,
            outcomes=loop.outcomes,
            frozen_inputs=(),
            tool_contract=loop.tool_contract,
        )
    )
    if deferred.prepared.frozen_input()["effective_tool_arguments"].get("_jenny_change_set_id"):
        return None
    previous, predecessor = _previous(loop.request_context)
    effects = outcome_refs(loop.outcomes)
    if not effects:
        return None
    if effects[: len(previous)] != previous:
        raise ValueError("resource_progress_effects_changed")
    current = {
        item.call_id: item
        for item in loop.outcomes
        if item.call_id not in {ref["call_id"] for ref in previous}
    }
    records = runtime.emitted_tool_calls
    if any(
        call_id not in current
        or call_id not in runtime.tool_result_emitted_call_ids
        or record.get("tool_name") != current[call_id].tool_name
        or record.get("arguments") != current[call_id].tool_input
        for call_id, record in records.items()
    ):
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
    values = {item.name: getattr(base, item.name) for item in fields(base)}
    values["tool_calls_consumed"] = runtime.tool_calls_consumed
    return ResourceProgressContinuation(
        **values,
        completed_effects_json=json.dumps(effects, sort_keys=True, separators=(",", ":")).encode(),
        prior_checkpoint_json=json.dumps(predecessor).encode() if predecessor else None,
        prior_effect_count=len(previous),
        current_execution_count=len(records),
    )


def _suspend(loop: Any, iteration: int, deferred: Any, calls: tuple) -> None:
    try:
        captured = _capture(loop, iteration, deferred, calls)
    except (ValueError, TypeError, AttributeError):
        return
    if captured is not None:
        # Publication failures propagate: never fabricate a pending result after
        # an ambiguous persistence attempt.
        raise ToolLoopSuspended(loop.runtime.continuation_checkpoint(captured))


def resource_deferral_callback(loop: Any, iteration: int) -> Any:
    return partial(_suspend, loop, iteration)
