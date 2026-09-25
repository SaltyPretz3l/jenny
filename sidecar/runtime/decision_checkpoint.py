"""Frozen decision-wait projection of an existing approval plan.

No live plan, provider object, timer or consent is serialized. The application
must independently attest the suspended waiter and canonical completed outcomes.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import time
import uuid
from dataclasses import dataclass, replace
from typing import Any

from sidecar.ai.routing.quota_runtime import freeze_runtime_quota
from sidecar.ai.routing.tool_execution_snapshots import split_visible_execution_arguments
from sidecar.ai.routing.tool_quota_state import decode_quota_state
from sidecar.ai.routing.tool_quotas import _classify_call
from sidecar.ai.routing.tool_resource_deferral import (
    PreparedToolDeferral,
    ToolLoopSuspended,
    build_before_tool_dispatch_continuation,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.approval_input_bundle import checkpoint_approval_input, encode_approval_inputs
from sidecar.runtime.continuation_checkpoint import _exchange, _request_params
from sidecar.runtime.continuation_codec import encode_continuation_checkpoint
from sidecar.runtime.continuation_context import ContinuationContext
from sidecar.runtime.continuation_outcomes import outcome_refs
from sidecar.runtime.mutation_continuation import (
    FrozenMutationCheckpoint,
    prepare_mutation_checkpoint,
)

logger = logging.getLogger(__name__)

_MAX_BYTES = 1024 * 1024
_MAX_CALLS = 256


def _json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode()


def _previous(context: Any) -> tuple[list[dict], dict | None]:
    hydrated = getattr(context, "runtime_continuation_resume", None)
    if hydrated is None:
        return [], None
    checkpoint = hydrated.checkpoint()
    if checkpoint["kind"] not in {
        "before_decision_wait", "before_dependency_wait", "before_tool_dispatch"
    }:
        raise ValueError("decision_predecessor_kind_unsupported")
    encoded = encode_continuation_checkpoint(checkpoint)
    previous = (checkpoint["completed_effect_refs"] if "completed_effect_refs" in checkpoint
                else outcome_refs(hydrated.completed_outcomes()))
    if checkpoint["kind"] == "before_dependency_wait" and not previous:
        raise ValueError("dependency_outcomes_unavailable")
    return previous, {
        "schema_version": 1, "checkpoint_id": checkpoint["identity"]["checkpoint_id"],
        "sha256": encoded.sha256, "bytes": len(encoded.body),
        "source_attempt": checkpoint["source_attempt"],
    }


def _completed(plan: Any, previous: list[dict]) -> list[dict]:
    refs = {ref["call_id"]: dict(ref) for ref in previous}
    seen = set()
    for outcome in plan.outcomes:
        if (not outcome.call_id or outcome.call_id in seen
                or not isinstance(outcome.output, str)
                or not isinstance(outcome.success, bool)
                or getattr(outcome, "trusted_attachments", False)):
            raise ValueError("decision_outcome_unavailable")
        seen.add(outcome.call_id)
        ref = {"call_id": outcome.call_id, "tool_id": outcome.tool_name,
               "success": outcome.success,
               "result_sha256": hashlib.sha256(outcome.output.encode()).hexdigest()}
        if outcome.call_id in refs and refs[outcome.call_id] != ref:
            raise ValueError("decision_outcome_conflict")
        refs[outcome.call_id] = ref
    if len(refs) >= _MAX_CALLS:
        raise ValueError("decision_outcome_capacity")
    return list(refs.values())


def _assert_supported(plan: Any, mutation: FrozenMutationCheckpoint | None = None) -> None:
    context = plan.request_context
    if ((getattr(plan, "change_set_id", "") and mutation is None)
            or getattr(context, "vision_images", ())
            or getattr(context, "approvals_pre_granted", False)):
        raise ValueError("decision_transient_state_unsupported")
    if (any(item.effective_tool_arguments.get("_jenny_change_set_id")
            for item in plan.frozen_inputs)
            or (mutation is None and any(getattr(item, "metadata", {}).get("workspace_change_set")
                                        for item in plan.outcomes))):
        raise ValueError("decision_mutation_state_unsupported")
    quota = getattr(plan, "quota_state_json", None)
    if quota is not None:
        decode_quota_state(quota)
    probes = [*plan.tool_calls, *(ToolCallRequest(tool_id=item.tool_name,
              arguments={}, call_id=item.call_id) for item in plan.outcomes)]
    for call in probes:
        classification = _classify_call(call, tool_contract=plan.tool_contract)
        if (call.tool_id == "delegate" or (quota is None and (
                classification.web_or_browser or classification.code_intelligence))):
            raise ValueError("decision_quota_state_unavailable")


@dataclass(frozen=True)
class DecisionSnapshot:
    context: ContinuationContext
    params_json: bytes
    mutation: FrozenMutationCheckpoint | None = None

    def decision(self) -> dict[str, Any]:
        return json.loads(self.params_json)["decision"]

    def suspend(self, response: Any, *, write_message: Any,
                response_reader_factory: Any, cancel_handle: Any) -> None:
        params = json.loads(self.params_json)
        if (not isinstance(response, dict)
                or set(response) != {"schema_version", "request_id", "decision"}
                or type(response["schema_version"]) is not int
                or response["schema_version"] != 1
                or response["request_id"] != self.context.source_attempt.stream_id
                or response["decision"] != params["decision"]):
            raise ValueError("decision_pause_response_invalid")
        try:
            if self.mutation is not None:
                self.mutation.transition("bind", self.context, params["decision"])
            reference = _exchange(context=self.context, params=params,
                                  write_message=write_message,
                                  response_reader_factory=response_reader_factory,
                                  cancel_handle=cancel_handle, timeout_seconds=30.0)
            if reference is None:
                raise ValueError("decision_checkpoint_missing")
            if self.mutation is not None:
                self.mutation.transition("confirm", self.context, params["decision"])
        except Exception as error:
            # Publication failure/ambiguity cannot grant future execution. Keep
            # the exact binding and protected effects as cancellation evidence.
            if self.mutation is not None:
                try:
                    self.mutation.transition("release", self.context, params["decision"])
                except Exception:
                    error.add_note("Mutation checkpoint release remains unconfirmed.")
            raise
        raise ToolLoopSuspended(reference)


def _prepare_decision(
    plan: Any, *, kind: str, now: float | None = None, config: Any = None,
) -> DecisionSnapshot | None:
    """Freeze before the human wait; unsupported transient state keeps its waiter."""
    context = getattr(plan, "request_context", None)
    continuation = getattr(context, "continuation_context", None)
    if not isinstance(continuation, ContinuationContext):
        return None
    try:
        previous, predecessor = _previous(context)
        refs = _completed(plan, previous)
        mutation = prepare_mutation_checkpoint(plan, refs, config)
        if any(item.effective_tool_arguments.get("_jenny_change_set_id") not in
               (None, "", getattr(plan, "change_set_id", "")) for item in plan.frozen_inputs):
            raise ValueError("decision_mutation_owner_mismatch")
        # Private mutation identity is reissued only by the execution owner after
        # fresh consent. The immutable checkpoint carries a journal reference for
        # completed mutations, never attribution for a pending call.
        frozen_inputs = [checkpoint_approval_input(frozen) for frozen in plan.frozen_inputs]
        plan = replace(plan, frozen_inputs=tuple(frozen_inputs),
                       change_set_id=plan.change_set_id if mutation is not None else "")
        _assert_supported(plan, mutation)
        calls = tuple(replace(call, arguments=split_visible_execution_arguments(call)[0])
                      for call in plan.tool_calls)
        # Approval has already frozen its entire window. Question suffix calls
        # have not reached execution-time freezing and are validated on resume.
        if not calls:
            raise ValueError("decision_later_frozen_inputs_unavailable")
        first = calls[0]
        if ({call.call_id for call in calls} & {ref["call_id"] for ref in refs}
                or (plan.approved_call_id or plan.call_id) not in {call.call_id for call in calls}):
            raise ValueError("decision_call_identity_conflict")
        frozen = plan.frozen_input_for_call(first.call_id)
        pending = PreparedToolDeferral.freeze(wait=None, call_id=first.call_id,
                                             tool_id=first.tool_id, frozen_inputs=frozen)
        consumed = plan.tool_call_limit - plan.remaining_tool_calls
        if (type(consumed) is not int or not len(calls) <= consumed <= len(calls) + len(refs)
                or consumed > plan.tool_call_limit):
            raise ValueError("decision_budget_unavailable")
        deadline = plan.wall_clock_deadline
        clock = time.monotonic() if now is None else now
        if deadline is not None and (not math.isfinite(deadline) or not math.isfinite(clock)):
            raise ValueError("decision_deadline_unavailable")
        remaining_ms = None if deadline is None else max(int((deadline - clock) * 1000), 0)
        base = build_before_tool_dispatch_continuation(
            pending, ordered_call_ids=tuple(call.call_id for call in calls),
            current_iteration=plan.completed_iterations,
            remaining_iterations=plan.remaining_iterations,
            tool_call_limit=plan.tool_call_limit, tool_calls_consumed=len(calls),
            active_budget_ms_remaining=remaining_ms, tool_calls=calls,
            quota_state_json=getattr(plan, "quota_state_json", None),
        )
        params = _request_params(continuation, base)
        params.update(phase="decision_checkpoint", completed_effect_refs=refs,
                      prior_effect_count=len(previous), prior_checkpoint_ref=predecessor,
                      decision={"kind": kind, "decision_id": f"decision_{uuid.uuid4().hex}",
                                "call_id": plan.approved_call_id or plan.call_id,
                                "execution_started": kind == "user_questions"})
        if kind == "approval" and len(calls) > 1:
            leaves = tuple(PreparedToolDeferral.freeze(wait=None, call_id=call.call_id,
                tool_id=call.tool_id, frozen_inputs=plan.frozen_input_for_call(call.call_id))
                .frozen_input_bytes for call in calls)
            params["approval_inputs_bytes"], params["approval_inputs_sha256"] = (
                encode_approval_inputs(leaves))
        params["position"]["tool_calls_consumed"] = consumed
        params["eligibility"]["prior_outcome_count"] = len(refs) - len(previous)
        # Execution count is independently attested from the application's live
        # canonical prefix; outcomes may include failures before execution.
        params["eligibility"]["emitted_tool_execution_count"] = 0
        if mutation is not None:
            params["mutation_ref"] = mutation.reference()
        body = _json(params)
        if len(body) > _MAX_BYTES:
            raise ValueError("decision_snapshot_capacity")
        return DecisionSnapshot(continuation, body, mutation)
    except (
        ValueError, TypeError, IndexError, AttributeError, OverflowError, ToolExecutionFailure
    ) as error:
        logger.warning("decision_snapshot_unavailable", extra={"reason": type(error).__name__})
        return None


@dataclass(frozen=True)
class _QuestionInputs:
    request_context: Any
    tool_contract: Any
    tool_calls: tuple
    outcomes: tuple
    frozen_inputs: tuple
    call_id: str
    tool_call_limit: int
    remaining_tool_calls: int
    completed_iterations: int
    remaining_iterations: int
    wall_clock_deadline: float | None
    approved_call_id: str = ""
    change_set_id: str = ""
    quota_state_json: bytes | None = None

    def frozen_input_for_call(self, call_id: str) -> Any:
        if call_id != self.call_id:
            raise ValueError("decision_frozen_call_mismatch")
        return self.frozen_inputs[0]


def prepare_approval_decision(
    plan: Any, *, now: float | None = None, config: Any = None
) -> DecisionSnapshot | None:
    return _prepare_decision(plan, kind="approval", now=now, config=config)


def prepare_question_decision(  # noqa: PLR0913 - captures one immutable dispatcher boundary.
    frozen_input: Any, *, runtime: Any, request_context: Any, tool_contract: Any,
    pending_calls: tuple, completed_outcomes: tuple, config: Any = None,
) -> DecisionSnapshot | None:
    if not pending_calls or pending_calls[0].tool_id != "ask_user":
        return None
    if runtime.tool_call_limit is None:
        return None
    from sidecar.ai.routing.mutation_change_set_lifecycle import (  # noqa: PLC0415
        current_run_change_set_id,
    )
    inputs = _QuestionInputs(
        change_set_id=current_run_change_set_id(),
        quota_state_json=freeze_runtime_quota(runtime, config,
            outcomes=completed_outcomes, tool_contract=tool_contract),
        request_context=request_context, tool_contract=tool_contract,
        tool_calls=pending_calls, outcomes=completed_outcomes, frozen_inputs=(frozen_input,),
        call_id=pending_calls[0].call_id, tool_call_limit=runtime.tool_call_limit,
        remaining_tool_calls=runtime.remaining_tool_calls,
        completed_iterations=runtime.current_iteration,
        remaining_iterations=max(runtime.iteration_base + runtime.max_iterations
                                 - runtime.current_iteration, 0),
        wall_clock_deadline=runtime.wall_clock_deadline,
    )
    return _prepare_decision(inputs, kind="user_questions", now=runtime.clock(), config=config)
