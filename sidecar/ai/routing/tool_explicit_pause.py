"""Observe durable application pause intent at the closed first-tool boundary."""

from __future__ import annotations

from typing import Any, Sequence

from sidecar.ai.routing.tool_execution_snapshots import freeze_effective_execution_inputs
from sidecar.ai.routing.tool_resource_deferral import (
    PreparedToolDeferral,
    ToolLoopSuspended,
    continuation_from_loop,
    first_batch_deferral_eligible_for_loop,
)


def probe_explicit_pause(loop_run: Any, ordered_calls: Sequence[Any], iteration: int) -> None:
    """Called only after the first-batch eligibility and approval gates pass."""
    runtime = loop_run.runtime
    probe = getattr(getattr(runtime, "continuation_checkpoint", None), "probe_pause", None)
    if not callable(probe):
        return
    runtime.raise_if_interrupted()
    call = ordered_calls[0]
    context = loop_run.request_context
    frozen = freeze_effective_execution_inputs(
        loop_run.kernel, call, session_id=loop_run.session_id,
        read_snapshot_cache=loop_run.read_snapshot_cache,
        tool_contract=loop_run.tool_contract,
        plan_mode=bool(getattr(context, "plan_mode", False)),
        read_only=bool(getattr(context, "read_only", False)),
        approved_plan=getattr(context, "approved_plan", None),
        turn_id=str(getattr(runtime, "logical_turn_id", "") or runtime.request_id),
        execution_context=getattr(context, "execution_context", None),
    )
    prepared = PreparedToolDeferral.freeze(
        wait=None, call_id=call.call_id, tool_id=call.tool_id, frozen_inputs=frozen,
    )
    checkpoint = probe(continuation_from_loop(
        loop_run, prepared, ordered_calls=ordered_calls, current_iteration=iteration,
    ))
    runtime.raise_if_interrupted()
    if checkpoint is not None:
        raise ToolLoopSuspended(checkpoint)


def prepare_first_batch_pause(
    loop_run: Any, *, current_iteration: int, outcomes_before_batch: int,
    remaining_calls: Sequence[tuple[Any, int]], ordered_calls: Sequence[Any],
) -> bool:
    """Share the closed resource-continuation eligibility before probing pause."""
    eligible = first_batch_deferral_eligible_for_loop(
        loop_run, current_iteration=current_iteration,
        outcomes_before_batch=outcomes_before_batch,
        remaining_calls=remaining_calls, ordered_calls=ordered_calls,
    )
    if eligible:
        probe_explicit_pause(loop_run, ordered_calls, current_iteration)
    return eligible


def prepare_tool_continuation(loop_run: Any, **boundary: Any) -> bool:
    """Probe supported boundaries after policy filtering, before any dispatch."""
    from sidecar.ai.routing.tool_dependency_wait import probe_dependency_wait  # noqa: PLC0415

    eligible = prepare_first_batch_pause(loop_run, **boundary)
    probe_dependency_wait(loop_run, **boundary)
    return eligible


def resource_callback(loop_run: Any, iteration: int) -> Any:
    from sidecar.ai.routing.tool_resource_progress import (  # noqa: PLC0415
        resource_deferral_callback as build,
    )
    return build(loop_run, iteration)
