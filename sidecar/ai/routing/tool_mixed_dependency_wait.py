"""Mixed-outcome child waits with exact results and separate child receipt proofs."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sidecar.ai.routing.tool_dependency_wait import (
    _ID,
    _SHA,
    MAX_SPAWNS,
    BeforeDependencyWaitContinuation,
    CompletedSpawnRef,
    child_refs,
)
from sidecar.ai.routing.tool_resource_deferral import (
    BeforeToolDispatchContinuation,
    _freeze_loop_quota,
    extend_continuation,
)
from sidecar.ai.routing.tool_resource_progress import settled_effects


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


def mixed_dependency_state(loop: Any) -> dict | None:
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
    settled = settled_effects(loop, quota_state_json=_freeze_loop_quota(loop))
    if settled is None:
        raise ValueError("mixed_dependency_execution_unsettled")
    spawns, waits = child_refs(loop.outcomes)
    return {
        "completed_spawn_refs": spawns,
        "completed_wait_refs": waits,
        **settled.checkpoint_fields(),
    }


def build_mixed_dependency(base: Any, loop: Any, state: dict) -> MixedDependencyWaitContinuation:
    return extend_continuation(
        base,
        MixedDependencyWaitContinuation,
        tool_calls_consumed=loop.runtime.tool_calls_consumed,
        **state,
    )
