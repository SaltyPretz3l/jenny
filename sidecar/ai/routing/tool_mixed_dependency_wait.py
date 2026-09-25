"""Mixed-outcome child waits with exact results and separate child receipt proofs."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, fields
from types import SimpleNamespace
from typing import Any

from sidecar.ai.routing.tool_dependency_wait import (
    _ID,
    _SHA,
    MAX_RESULT_BYTES,
    MAX_SPAWNS,
    BeforeDependencyWaitContinuation,
    CompletedSpawnRef,
)
from sidecar.ai.routing.tool_resource_deferral import (
    BeforeToolDispatchContinuation,
    _freeze_loop_quota,
)
from sidecar.runtime.continuation_outcomes import outcome_refs


@dataclass(frozen=True, slots=True)
class MixedDependencyWaitContinuation(BeforeDependencyWaitContinuation):
    completed_effects_json: bytes = b"[]"
    current_execution_count: int = 0

    def _prior_outcome_count(self) -> int:
        # Failed preflight results were never reserved; preserve the actual
        # counter, independently bounded against the complete effect ledger.
        return self.tool_calls_consumed - len(self.ordered_call_ids)

    def __post_init__(self) -> None:
        effects = json.loads(self.completed_effects_json)
        refs = self.completed_spawn_refs + self.completed_wait_refs
        if (
            not isinstance(effects, list)
            or not 1 <= len(effects) <= MAX_SPAWNS
            or not self.completed_spawn_refs
            or len(refs) > MAX_SPAWNS
            or any(
                not isinstance(ref, CompletedSpawnRef)
                or not _ID.fullmatch(ref.call_id)
                or not _ID.fullmatch(ref.child_work_id)
                or not _SHA.fullmatch(ref.result_sha256)
                for ref in refs
            )
            or len({ref.call_id for ref in refs}) != len(refs)
            or not 1 <= self.tool_calls_consumed <= len(effects) + 1
            or not 0 <= self.prior_effect_count <= len(effects)
            or (self.prior_checkpoint_json is None and self.prior_effect_count)
            or not 0 <= self.current_execution_count <= len(effects) - self.prior_effect_count
            or self.pending.tool_id != "session_wait"
            or len(self.ordered_call_ids) != 1
            or self.pending.call_id in {ref["call_id"] for ref in effects}
        ):
            raise ValueError("invalid_mixed_dependency_continuation")
        BeforeToolDispatchContinuation.__post_init__(self)


def _child_refs(outcomes: Any) -> tuple[tuple, tuple]:
    spawns: list[CompletedSpawnRef] = []
    waits: list[CompletedSpawnRef] = []
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
                    or receipt["child_work_id"] not in {ref.child_work_id for ref in spawns}
                )
            )
        ):
            raise ValueError("mixed_child_receipt_invalid")
        body = json.dumps(
            receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode()
        (spawns if spawn else waits).append(
            CompletedSpawnRef(
                outcome.call_id, receipt["child_work_id"], hashlib.sha256(body).hexdigest()
            )
        )
    return tuple(spawns), tuple(waits)


def mixed_dependency_state(loop: Any) -> dict | None:
    # Imported at the request edge: decision snapshot imports the checkpoint
    # transport, which imports the legacy dependency dataclass at startup.
    from sidecar.runtime.decision_checkpoint import _assert_supported, _previous  # noqa: PLC0415

    context = loop.request_context
    hydrated = getattr(context, "runtime_continuation_resume", None)
    if hydrated is None and (
        loop.runtime.dependency_resume
        or all(item.tool_name == "session_spawn" for item in loop.outcomes)
    ):
        return None
    if hydrated is not None and not hydrated.completed_outcomes():
        checkpoint = hydrated.checkpoint()
        if checkpoint["kind"] == "before_dependency_wait":
            raise ValueError("mixed_dependency_history_unavailable")
    previous, predecessor = _previous(context)
    _assert_supported(
        SimpleNamespace(
            request_context=context,
            quota_state_json=_freeze_loop_quota(loop),
            tool_calls=(),
            outcomes=loop.outcomes,
            frozen_inputs=(),
            tool_contract=loop.tool_contract,
        )
    )
    effects = outcome_refs(loop.outcomes)
    if effects[: len(previous)] != previous:
        raise ValueError("mixed_dependency_effects_changed")
    spawns, waits = _child_refs(loop.outcomes)
    records = loop.runtime.emitted_tool_calls
    current = {
        item.call_id: item
        for item in loop.outcomes
        if item.call_id not in {ref["call_id"] for ref in previous}
    }
    if any(
        call_id not in current
        or call_id not in loop.runtime.tool_result_emitted_call_ids
        or record.get("tool_name") != current[call_id].tool_name
        or record.get("arguments") != current[call_id].tool_input
        for call_id, record in records.items()
    ):
        raise ValueError("mixed_dependency_execution_unsettled")
    return {
        "completed_spawn_refs": spawns,
        "completed_wait_refs": waits,
        "completed_effects_json": json.dumps(
            effects, sort_keys=True, separators=(",", ":")
        ).encode(),
        "prior_checkpoint_json": (
            json.dumps(predecessor, sort_keys=True, separators=(",", ":")).encode()
            if predecessor
            else None
        ),
        "prior_effect_count": len(previous),
        "current_execution_count": len(records),
    }


def build_mixed_dependency(base: Any, loop: Any, state: dict) -> MixedDependencyWaitContinuation:
    values = {item.name: getattr(base, item.name) for item in fields(base)}
    values["tool_calls_consumed"] = loop.runtime.tool_calls_consumed
    return MixedDependencyWaitContinuation(**values, **state)
