"""Closed first dependency wait after only successful durable child spawns."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, fields
from typing import Any

from sidecar.ai.routing.auto_checkpoint import should_create_checkpoint
from sidecar.ai.routing.tool_execution_snapshots import freeze_effective_execution_inputs
from sidecar.ai.routing.tool_resource_deferral import (
    BeforeToolDispatchContinuation,
    PreparedToolDeferral,
    ToolLoopSuspended,
    _freeze_loop_quota,
    build_before_tool_dispatch_continuation,
    canonical_json_bytes,
    extend_continuation,
)

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
MAX_SPAWNS = 255
MAX_RESULT_BYTES = 32768
MIN_DEPENDENCY_ITERATION = 2
_SHA = re.compile(r"[a-f0-9]{64}\Z")


@dataclass(frozen=True)
class CompletedSpawnRef:
    call_id: str
    child_work_id: str
    result_sha256: str

    def to_wire(self) -> dict[str, str]:
        return {item.name: getattr(self, item.name) for item in fields(self)}


@dataclass(frozen=True, slots=True)
class BeforeDependencyWaitContinuation(BeforeToolDispatchContinuation):
    completed_spawn_refs: tuple[CompletedSpawnRef, ...]
    completed_wait_refs: tuple[CompletedSpawnRef, ...] = ()
    prior_checkpoint_json: bytes | None = None
    prior_effect_count: int = 0

    def _prior_outcome_count(self) -> int:
        return len(self.completed_spawn_refs) + len(self.completed_wait_refs)

    def __post_init__(self) -> None:
        refs = self.completed_spawn_refs + self.completed_wait_refs
        if (
            not isinstance(refs, tuple)
            or not 1 <= len(refs) <= MAX_SPAWNS
            or any(
                not isinstance(ref, CompletedSpawnRef)
                or not _ID.fullmatch(ref.call_id)
                or not _ID.fullmatch(ref.child_work_id)
                or not _SHA.fullmatch(ref.result_sha256)
                for ref in refs
            )
            or len({ref.call_id for ref in refs}) != len(refs)
            or not self.completed_spawn_refs
            or len({ref.child_work_id for ref in self.completed_spawn_refs})
            != len(self.completed_spawn_refs)
            or any(
                ref.child_work_id
                not in {spawn.child_work_id for spawn in self.completed_spawn_refs}
                for ref in self.completed_wait_refs
            )
            or (
                self.prior_checkpoint_json is None
                and (self.completed_wait_refs or self.prior_effect_count)
            )
            or (
                self.prior_checkpoint_json is not None
                and not 1 <= self.prior_effect_count < len(refs)
            )
            or self.pending.tool_id != "session_wait"
            or len(self.ordered_call_ids) != 1
            or self.current_iteration < MIN_DEPENDENCY_ITERATION
            or self.pending.call_id in {ref.call_id for ref in refs}
        ):
            raise ValueError("invalid_dependency_continuation")
        BeforeToolDispatchContinuation.__post_init__(self)


def child_refs(
    outcomes: Iterable[Any],
    *,
    spawns: Iterable[CompletedSpawnRef] = (),
    waits: Iterable[CompletedSpawnRef] = (),
) -> tuple[tuple[CompletedSpawnRef, ...], tuple[CompletedSpawnRef, ...]]:
    """Strictly validate child spawn/wait receipts and hash each canonical body.

    ``spawns``/``waits`` seed refs proven by a predecessor checkpoint; a wait
    receipt must name a child spawned by a seeded or earlier current spawn.
    """

    spawn_refs = list(spawns)
    wait_refs = list(waits)
    for outcome in outcomes:
        if outcome.tool_name not in {"session_spawn", "session_wait"}:
            continue
        if outcome.success is not True:
            raise ValueError("mixed_child_outcome_uncertain")
        receipt = json.loads(outcome.output)
        spawn = outcome.tool_name == "session_spawn"
        expected = (
            {"root_run_id", "child_work_id", "session_id", "turn_id"}
            if spawn
            else {"child_work_id", "session_id", "turn_id", "status", "result", "truncated"}
        )
        if (
            not isinstance(receipt, dict)
            or set(receipt) != expected
            or any(
                not isinstance(receipt[key], str) or not _ID.fullmatch(receipt[key])
                for key in ("child_work_id", "session_id", "turn_id")
            )
            or (
                spawn
                and (
                    not isinstance(receipt["root_run_id"], str)
                    or not _ID.fullmatch(receipt["root_run_id"])
                )
            )
            or (
                not spawn
                and (
                    receipt["status"] not in {"completed", "failed", "cancelled"}
                    or type(receipt["truncated"]) is not bool
                    or not isinstance(receipt["result"], str)
                    or len(receipt["result"].encode()) > MAX_RESULT_BYTES
                    or receipt["child_work_id"] not in {ref.child_work_id for ref in spawn_refs}
                )
            )
        ):
            raise ValueError("mixed_child_receipt_invalid")
        body = json.dumps(
            receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode()
        (spawn_refs if spawn else wait_refs).append(
            CompletedSpawnRef(
                outcome.call_id, receipt["child_work_id"], hashlib.sha256(body).hexdigest()
            )
        )
    return tuple(spawn_refs), tuple(wait_refs)


def completed_effects(
    loop: Any,
) -> tuple[tuple[CompletedSpawnRef, ...], tuple[CompletedSpawnRef, ...]]:
    runtime = loop.runtime
    records = list(runtime.emitted_tool_calls.values())
    previous = (runtime.dependency_resume or {}).get("checkpoint", {})
    prior_spawns = [CompletedSpawnRef(**ref) for ref in previous.get("completed_spawn_refs", [])]
    prior_waits = [CompletedSpawnRef(**ref) for ref in previous.get("completed_wait_refs", [])]
    if (
        not records
        or len(records) != len(loop.outcomes)
        or set(runtime.emitted_tool_calls) != runtime.tool_result_emitted_call_ids
    ):
        return (), ()
    if previous and (records[0].get("call_id") != previous["pending_call"]["call_id"]
                     or records[0].get("tool_name") != "session_wait"):
        return (), ()
    for record, outcome in zip(records, loop.outcomes, strict=True):
        tool = record.get("tool_name")
        if (
            tool not in {"session_spawn", "session_wait"}
            or (tool == "session_wait" and not previous)
            or outcome.tool_name != tool
            or outcome.success is not True
            or getattr(outcome, "call_id", None) != record.get("call_id")
            or record.get("arguments") != outcome.tool_input
        ):
            return (), ()
    try:
        spawns, waits = child_refs(loop.outcomes, spawns=prior_spawns, waits=prior_waits)
    except (ValueError, TypeError):
        return (), ()
    if previous and (
        not waits
        or waits[len(previous.get("completed_wait_refs", []))].call_id
        != previous["pending_call"]["call_id"]
    ):
        return (), ()
    return spawns, waits


def probe_dependency_wait(
    loop: Any,
    *,
    current_iteration: int,
    outcomes_before_batch: int,
    remaining_calls: Any,
    ordered_calls: Any,
) -> None:
    runtime = loop.runtime
    context = loop.request_context
    probe = getattr(runtime.continuation_checkpoint, "probe_dependency", None)
    if (
        not callable(probe)
        or not getattr(context, "runtime_children_enabled", False)
        or not runtime.streaming
        or (runtime.iteration_base and not runtime.dependency_resume
            and getattr(context, "runtime_continuation_resume", None) is None)
        or current_iteration < MIN_DEPENDENCY_ITERATION
        or len(ordered_calls) != 1
        or len(remaining_calls) != 1
        or remaining_calls[0][0] is not ordered_calls[0]
        or ordered_calls[0].tool_id != "session_wait"
        or outcomes_before_batch != len(loop.outcomes)
        or runtime.preview_images
        or getattr(context, "vision_images", ())
        or getattr(runtime, "mutation_started", False)
        or getattr(runtime, "change_set_id", "")
        or should_create_checkpoint(
            feature_flags=getattr(loop.kernel._config, "feature_flags", None),
            already_created=bool(getattr(loop, "checkpoint_created", False)),
            tool_ids=(call.tool_id for call, _ in remaining_calls),
        )
    ):
        return
    # The mixed dataclass extends this module; import at the request edge.
    from sidecar.ai.routing.tool_mixed_dependency_wait import (
        build_mixed_dependency,
        mixed_dependency_state,
    )
    try:
        mixed = mixed_dependency_state(loop)
    except (ValueError, TypeError, AttributeError):
        return
    refs, waits = ((mixed["completed_spawn_refs"], mixed["completed_wait_refs"])
                   if mixed is not None else completed_effects(loop))
    if (
        not refs
        or (mixed is None and runtime.tool_calls_consumed != len(refs) + len(waits) + 1)
        or len(refs) + len(waits) > MAX_SPAWNS
        or not isinstance(ordered_calls[0].arguments.get("child_work_id"), str)
        or ordered_calls[0].arguments.get("child_work_id")
        not in {ref.child_work_id for ref in refs}
    ):
        return
    runtime.raise_if_interrupted()
    call = ordered_calls[0]
    frozen = freeze_effective_execution_inputs(
        loop.kernel,
        call,
        session_id=loop.session_id,
        read_snapshot_cache=loop.read_snapshot_cache,
        tool_contract=loop.tool_contract,
        plan_mode=context.plan_mode,
        read_only=context.read_only,
        approved_plan=context.approved_plan,
        turn_id=runtime.logical_turn_id,
        execution_context=context.execution_context,
    )
    pending = PreparedToolDeferral.freeze(
        wait=None, call_id=call.call_id, tool_id=call.tool_id, frozen_inputs=frozen
    )
    deadline = runtime.wall_clock_deadline
    remaining_ms = None if deadline is None else max(int((deadline - runtime.clock()) * 1000), 0)
    base = build_before_tool_dispatch_continuation(
        pending,
        ordered_call_ids=(call.call_id,),
        current_iteration=current_iteration,
        remaining_iterations=max(loop.iteration_total - current_iteration, 0),
        tool_call_limit=runtime.tool_call_limit,
        tool_calls_consumed=1,
        active_budget_ms_remaining=remaining_ms,
        tool_calls=ordered_calls,
        quota_state_json=_freeze_loop_quota(loop),
    )
    if mixed is not None:
        checkpoint = probe(build_mixed_dependency(base, loop, mixed))
        runtime.raise_if_interrupted()
        raise ToolLoopSuspended(checkpoint)
    resume = runtime.dependency_resume
    previous = resume["checkpoint"] if resume else {}
    continuation = extend_continuation(
        base,
        BeforeDependencyWaitContinuation,
        tool_calls_consumed=runtime.tool_calls_consumed,
        completed_spawn_refs=refs,
        completed_wait_refs=waits,
        prior_checkpoint_json=canonical_json_bytes(resume["reference"]) if resume else None,
        prior_effect_count=len(previous.get("completed_spawn_refs", []))
        + len(previous.get("completed_wait_refs", [])),
    )
    checkpoint = probe(continuation)
    runtime.raise_if_interrupted()
    raise ToolLoopSuspended(checkpoint)
