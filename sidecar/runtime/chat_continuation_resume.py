"""Dormant executor for the closed before-tool-dispatch continuation slice."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping, NoReturn

from sidecar.ai.feature_flags import is_resource_discipline_enabled
from sidecar.ai.routing import loop_event_emit, mutation_change_set_lifecycle, plan_mode_transition
from sidecar.ai.routing import tool_loop as _tool_loop
from sidecar.ai.routing.quota_runtime import restore_runtime_quota
from sidecar.ai.routing.tool_call_execution import execute_tool_calls_sequentially
from sidecar.ai.routing.tool_execution_snapshots import split_visible_execution_arguments
from sidecar.ai.routing.tool_loop_run import _ToolLoopRun
from sidecar.ai.routing.tool_resource_deferral import ToolLoopSuspended
from sidecar.ai.routing.tool_restored_inputs import RestoredToolInputs
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.approval_input_bundle import decode_approval_inputs
from sidecar.runtime.chat_continuation_batch import attention as _attention
from sidecar.runtime.chat_continuation_batch import (
    preflight_pending_batch as _preflight_pending_batch,
)
from sidecar.runtime.continuation_codec import (
    MAX_CONTINUATION_BODY_BYTES,
    MAX_CONTINUATION_TOOL_CALLS,
    decode_continuation_checkpoint,
)
from sidecar.runtime.continuation_context import ContinuationContext
from sidecar.runtime.decision_restore import (
    build_restored_approval_result,
    decode_decision_outcomes,
)
from sidecar.runtime.execution_context import ExecutionContext

_MIN_ARTIFACT_BYTES = 2
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_TOOL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_CHECKPOINT_ID = re.compile(r"checkpoint_[0-9a-f]{64}\Z")
_CHECKPOINT_REF_KEYS = frozenset(
    {"schema_version", "checkpoint_id", "sha256", "bytes", "source_attempt"}
)
_ATTEMPT_KEYS = frozenset({"attempt_id", "stream_id", "incarnation", "authority_revision"})
_CALL_KEYS = frozenset(
    {
        "call_id", "tool_id", "arguments", "idempotency_key", "coerced",
        "malformed_arguments", "argument_repairs",
    }
)
class ContinuationResumeError(ValueError):
    """A hydrated artifact or its fresh request binding is invalid."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _fail(code: str) -> NoReturn:
    raise ContinuationResumeError(code)


def _record(value: Any, keys: frozenset[str], name: str) -> dict[str, Any]:
    if (
        not isinstance(value, Mapping)
        or isinstance(value, (str, bytes, bytearray))
        or any(not isinstance(key, str) for key in value)
        or set(value) != keys
    ):
        _fail(f"invalid_{name}")
    return dict(value)


def _attempt(value: Any) -> dict[str, str]:
    attempt = _record(value, _ATTEMPT_KEYS, "resolved_source_attempt")
    if any(not isinstance(item, str) or _ID.fullmatch(item) is None for item in attempt.values()):
        _fail("invalid_resolved_source_attempt")
    return attempt


def _canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as error:
        raise ContinuationResumeError("invalid_continuation_artifact_json") from error


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            _fail("duplicate_continuation_artifact_key")
        value[key] = item
    return value


def _tool_calls(body: bytes, digest: str) -> tuple[ToolCallRequest, ...]:
    if (
        not isinstance(body, bytes)
        or not _MIN_ARTIFACT_BYTES <= len(body) <= MAX_CONTINUATION_BODY_BYTES
        or not isinstance(digest, str)
        or _SHA256.fullmatch(digest) is None
        or hashlib.sha256(body).hexdigest() != digest
    ):
        _fail("invalid_tool_batch_bytes")
    try:
        decoded = json.loads(
            body.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda _value: _fail("invalid_tool_batch_number"),
        )
    except ContinuationResumeError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContinuationResumeError("invalid_tool_batch_json") from error
    if (
        _canonical_json(decoded) != body
        or not isinstance(decoded, dict)
        or set(decoded) != {"calls"}
    ):
        _fail("invalid_tool_batch_shape")
    calls = decoded["calls"]
    if not isinstance(calls, list) or not 1 <= len(calls) <= MAX_CONTINUATION_TOOL_CALLS:
        _fail("invalid_tool_batch_calls")
    result: list[ToolCallRequest] = []
    for item in calls:
        call = _record(item, _CALL_KEYS, "tool_batch_call")
        repairs = call["argument_repairs"]
        if (
            not isinstance(call["call_id"], str)
            or _ID.fullmatch(call["call_id"]) is None
            or not isinstance(call["tool_id"], str)
            or _TOOL_ID.fullmatch(call["tool_id"]) is None
            or not isinstance(call["arguments"], dict)
            or not isinstance(call["idempotency_key"], str)
            or not isinstance(call["coerced"], bool)
            or not isinstance(call["malformed_arguments"], bool)
            or not isinstance(repairs, list)
            or any(not isinstance(repair, str) for repair in repairs)
        ):
            _fail("invalid_tool_batch_call")
        result.append(ToolCallRequest(
            call_id=call["call_id"], tool_id=call["tool_id"],
            arguments=call["arguments"], idempotency_key=call["idempotency_key"],
            coerced=call["coerced"],
            malformed_arguments=call["malformed_arguments"],
            argument_repairs=tuple(repairs),
        ))
    return tuple(result)


def _checkpoint_ref(
    value: Any, *, checkpoint_body: bytes, checkpoint_sha256: str,
) -> dict[str, Any]:
    ref = _record(value, _CHECKPOINT_REF_KEYS, "checkpoint_ref")
    size = ref["bytes"]
    if (
        ref["schema_version"] != 1
        or isinstance(ref["schema_version"], bool)
        or not isinstance(ref["checkpoint_id"], str)
        or _CHECKPOINT_ID.fullmatch(ref["checkpoint_id"]) is None
        or ref["sha256"] != checkpoint_sha256
        or isinstance(size, bool)
        or not isinstance(size, int)
        or size != len(checkpoint_body)
        or not _MIN_ARTIFACT_BYTES <= size <= MAX_CONTINUATION_BODY_BYTES
    ):
        _fail("invalid_checkpoint_ref")
    return {**ref, "source_attempt": _attempt(ref["source_attempt"])}


@dataclass(frozen=True, slots=True, init=False)
class HydratedBeforeToolDispatchResume:
    """Exact durable artifacts resolved by the application before stream B exists."""

    _checkpoint_body: bytes
    _checkpoint_sha256: str
    _tool_batch_body: bytes
    _tool_batch_sha256: str
    _frozen_input_body: bytes
    _frozen_input_sha256: str
    _canonical_events_body: bytes | None
    _approval_inputs_body: bytes | None

    @classmethod
    def from_artifacts(  # noqa: PLR0913
        cls,
        *,
        checkpoint_body: bytes,
        checkpoint_sha256: str,
        checkpoint_ref: Mapping[str, Any],
        resolved_source_attempt: Mapping[str, Any],
        tool_batch_bytes: bytes,
        tool_batch_sha256: str,
        frozen_input_bytes: bytes,
        frozen_input_sha256: str,
        allow_dependency: bool = False,
        canonical_events_bytes: bytes | None = None,
        approval_inputs_bytes: bytes | None = None,
    ) -> HydratedBeforeToolDispatchResume:
        if (
            not isinstance(checkpoint_body, bytes)
            or not isinstance(checkpoint_sha256, str)
            or _SHA256.fullmatch(checkpoint_sha256) is None
            or hashlib.sha256(checkpoint_body).hexdigest() != checkpoint_sha256
        ):
            _fail("invalid_checkpoint_bytes")
        checkpoint = decode_continuation_checkpoint(checkpoint_body)
        decision = checkpoint["kind"] == "before_decision_wait"
        dependency = checkpoint["kind"] == "before_dependency_wait"
        if (checkpoint["kind"] != "before_tool_dispatch"
                and not decision and not (dependency and allow_dependency is True)):
            _fail("continuation_resume_boundary_unsupported")
        ref = _checkpoint_ref(
            checkpoint_ref, checkpoint_body=checkpoint_body, checkpoint_sha256=checkpoint_sha256,
        )
        resolved = _attempt(resolved_source_attempt)
        calls = _tool_calls(tool_batch_bytes, tool_batch_sha256)
        restored = RestoredToolInputs.from_canonical_bytes(frozen_input_bytes, frozen_input_sha256)
        pending = checkpoint["pending_call"]
        position = checkpoint["position"]
        source = restored.source_frozen_inputs()
        source_scope = source.execution_context_payload
        try:
            first_visible, _attribution = split_visible_execution_arguments(calls[0])
        except ToolExecutionFailure:
            _fail("continuation_artifact_mismatch")
        if (
            checkpoint["identity"]["checkpoint_id"] != ref["checkpoint_id"]
            or checkpoint["source_attempt"] != ref["source_attempt"]
            or checkpoint["source_attempt"] != resolved
            or checkpoint["canonical_refs"]["tool_batch_ref"]["sha256"]
            != tool_batch_sha256
            or pending["frozen_input_ref"]["sha256"] != frozen_input_sha256
            or pending["effective_args_sha256"] != source.effective_args_fingerprint
            or pending["call_id"] != source.call_id
            or pending["tool_id"] != source.tool_name
            or tuple(position["ordered_call_ids"]) != tuple(call.call_id for call in calls)
            or calls[0].call_id != pending["call_id"]
            or calls[0].tool_id != pending["tool_id"]
            or _canonical_json(first_visible)
            != _canonical_json(source.visible_tool_arguments)
            or source_scope["session_id"] != checkpoint["identity"]["session_id"]
            or source_scope["logical_turn_id"] != checkpoint["identity"]["turn_id"]
            or source_scope["authority_revision"]
            != checkpoint["source_attempt"]["authority_revision"]
            or source_scope["project_id"] != checkpoint["authority"]["project_id"]
            or source_scope["root_id"] != checkpoint["authority"]["root_id"]
            or source_scope["root_revision"] != checkpoint["authority"]["root_revision"]
            or calls[0].tool_id == "delegate"
            or any(call.tool_id == "delegate" for call in calls)
            or (not dependency and not decision and "completed_effect_refs" not in checkpoint
                and (position["completed_iterations"] != 1
                                    or position["current_iteration"] != 1))
        ):
            _fail("continuation_artifact_mismatch")
        if checkpoint.get("approval_inputs_ref") is not None:
            if approval_inputs_bytes is None:
                _fail("approval_inputs_missing")
            decode_approval_inputs(approval_inputs_bytes, checkpoint, calls, frozen_input_bytes)
        elif approval_inputs_bytes is not None:
            _fail("unexpected_approval_inputs")
        if "completed_effect_refs" in checkpoint or decision or (dependency and (
            "completed_effect_refs" in checkpoint or canonical_events_bytes is not None
        )):
            if canonical_events_bytes is None:
                _fail("decision_canonical_events_missing")
            decode_decision_outcomes(canonical_events_bytes, checkpoint)
        elif canonical_events_bytes is not None:
            _fail("unexpected_decision_canonical_events")
        instance = object.__new__(cls)
        object.__setattr__(instance, "_checkpoint_body", checkpoint_body)
        object.__setattr__(instance, "_checkpoint_sha256", checkpoint_sha256)
        object.__setattr__(instance, "_tool_batch_body", tool_batch_bytes)
        object.__setattr__(instance, "_tool_batch_sha256", tool_batch_sha256)
        object.__setattr__(instance, "_frozen_input_body", frozen_input_bytes)
        object.__setattr__(instance, "_frozen_input_sha256", frozen_input_sha256)
        object.__setattr__(instance, "_canonical_events_body", canonical_events_bytes)
        object.__setattr__(instance, "_approval_inputs_body", approval_inputs_bytes)
        return instance

    def checkpoint(self) -> dict[str, Any]:
        return decode_continuation_checkpoint(self._checkpoint_body)

    def tool_calls(self) -> tuple[ToolCallRequest, ...]:
        return _tool_calls(self._tool_batch_body, self._tool_batch_sha256)

    def completed_outcomes(self) -> tuple[Any, ...]:
        return (() if self._canonical_events_body is None else
                decode_decision_outcomes(self._canonical_events_body, self.checkpoint()))

    def restored_inputs(self) -> tuple[RestoredToolInputs, ...]:
        if self._approval_inputs_body is None:
            return (self.restored_input(),)
        return decode_approval_inputs(self._approval_inputs_body, self.checkpoint(),
                                      self.tool_calls(), self._frozen_input_body)

    def restored_input(self) -> RestoredToolInputs:
        return RestoredToolInputs.from_canonical_bytes(
            self._frozen_input_body, self._frozen_input_sha256
        )


def _bind_fresh_request(
    hydrated: HydratedBeforeToolDispatchResume,
    *,
    runtime: Any,
    request_context: Any,
    request_id: str,
    session_id: str | None,
) -> dict[str, Any]:
    checkpoint = hydrated.checkpoint()
    continuation = getattr(request_context, "continuation_context", None)
    execution = getattr(request_context, "execution_context", None)
    logical_turn_id = str(getattr(request_context, "logical_turn_id", "") or "")
    current_session = str(session_id or "")
    if not isinstance(continuation, ContinuationContext) or not isinstance(
        execution, ExecutionContext
    ):
        _fail("continuation_fresh_context_required")
    source_a = checkpoint["source_attempt"]
    source_b = continuation.source_attempt.to_wire()
    if (
        request_id != getattr(request_context, "request_id", None)
        or request_id != getattr(runtime, "request_id", None)
        or request_id != source_b["stream_id"]
        or request_id == source_a["stream_id"]
        or logical_turn_id != checkpoint["identity"]["turn_id"]
        or logical_turn_id != continuation.turn_id
        or current_session != checkpoint["identity"]["session_id"]
        or current_session != continuation.enclosing_session_id
        or continuation.work_id != checkpoint["identity"]["work_id"]
        or continuation.authority.to_wire() != checkpoint["authority"]
        or continuation.route.to_wire() != checkpoint["route"]
        or source_b["authority_revision"] != execution.authority_revision
        or execution.project_id != checkpoint["authority"]["project_id"]
        or execution.root_id != checkpoint["authority"]["root_id"]
        or execution.root_revision != checkpoint["authority"]["root_revision"]
        or str(getattr(runtime, "logical_turn_id", "") or "") != logical_turn_id
        or str(getattr(runtime, "session_id", "") or "") != current_session
    ):
        _fail("continuation_fresh_context_mismatch")
    if (
        getattr(request_context, "approvals_pre_granted", False)
        or getattr(request_context, "vision_images", ())
        or getattr(runtime, "preview_images", {})
        or getattr(runtime, "emitted_tool_calls", {})
        or getattr(runtime, "tool_result_emitted_call_ids", set())
        or int(getattr(runtime, "tool_calls_consumed", 0) or 0) != 0
        or getattr(runtime, "tool_call_limit", None) is not None
    ):
        _fail("continuation_fresh_runtime_not_empty")
    return checkpoint


def _restore_runtime_position(runtime: Any, checkpoint: dict[str, Any]) -> None:
    position = checkpoint["position"]
    remaining_iterations = position["remaining_iterations"]
    if remaining_iterations > int(getattr(runtime, "max_iterations", 0) or 0):
        _attention("iteration_budget_changed")
    saved_budget = position["active_budget_ms_remaining"]
    now = float(runtime.clock())
    current_deadline = getattr(runtime, "wall_clock_deadline", None)
    if saved_budget is not None:
        if saved_budget <= 0:
            _attention("active_budget_exhausted")
        if current_deadline is not None:
            current_remaining = max(int((float(current_deadline) - now) * 1000), 0)
            saved_budget = min(saved_budget, current_remaining)
        if saved_budget <= 0:
            _attention("active_budget_exhausted")
        runtime.wall_clock_deadline = now + (saved_budget / 1000)
    runtime.iteration_base = position["completed_iterations"]
    runtime.current_iteration = position["current_iteration"]
    runtime.max_iterations = remaining_iterations
    runtime.tool_call_limit = position["tool_call_limit"]
    runtime.tool_calls_consumed = position["tool_calls_consumed"]
    refs = (checkpoint.get("completed_spawn_refs", []) + checkpoint.get("completed_wait_refs", [])
            + checkpoint.get("completed_effect_refs", []))
    runtime.turn_call_ids.update([ref["call_id"] for ref in refs] + position["ordered_call_ids"])
    if checkpoint["kind"] == "before_dependency_wait":
        body = _canonical_json(checkpoint)
        runtime.dependency_resume = {"checkpoint": checkpoint, "reference": {
            "schema_version": 1, "checkpoint_id": checkpoint["identity"]["checkpoint_id"],
            "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body),
            "source_attempt": checkpoint["source_attempt"],
        }}


def _finish_pending_batch(
    run: _ToolLoopRun,
    result: GenerationResult,
    iteration_calls: list[Any],
) -> Any | None:
    run._refund_failed_web_outcomes(0, tool_contract=run.tool_contract)
    plan_mode_exited = run._apply_plan_mode_transition(run.outcomes)
    run._append_failed_tool_context_if_needed()
    last_error = (
        str(run.outcomes[-1].output)
        if run.outcomes and not run.outcomes[-1].success
        else None
    )
    run.last_tool_calls = tuple(iteration_calls)
    run.tool_call_history, run.error_output_history = run._advance_cycle_history(
        (), (), run.last_tool_calls, last_error
    )
    next_contract = run.kernel._assemble_tool_contract(
        request_context=run.request_context,
        resolution_context=run.tool_resolution_context,
    )
    if plan_mode_exited:
        plan_mode_transition.apply_restored_tool_contract(
            working_messages=run.working_messages,
            tool_statuses=next_contract.status_entries,
        )
    next_payload = (
        run._next_cycle_recovery_payload(next_contract, run.outcomes)
        if run.runtime.remaining_tool_calls > 0 else []
    )
    if run.budget_tracker is not None:
        run.budget_tracker.num_tools = _tool_loop.count_full_tool_schemas(next_payload)
        current_tokens = _tool_loop.tool_loop_compaction.compact_tool_loop_context(
            run, num_tools=run.budget_tracker.num_tools
        )
        run.budget_tracker.record_iteration(
            None, current_tokens, made_tool_progress=any(item.success for item in run.outcomes)
        )
        run._emit_iteration_context_usage(
            iteration=run.completed_generations, result=result,
            current_context_tokens=current_tokens
        )
        if not run.budget_tracker.check_should_continue():
            return _tool_loop.tool_loop_recovery.budget_exhausted_wind_down(
                run, result,
                reason=run.budget_tracker.stop_reason() or "diminishing_returns",
            )
    run.tool_contract = next_contract
    run.tool_payload = next_payload
    run.tool_statuses = next_contract.status_entries
    return None


def _terminal_loop_result(decision: Any, outcomes: list[Any]) -> _tool_loop.ToolLoopResult:
    return _tool_loop.ToolLoopResult(
        thinking_text=decision.thinking_text,
        thinking_kind=decision.thinking_kind,
        persist_thinking=decision.persist_thinking,
        response_text=decision.response_text,
        approval_request=decision.approval_request,
        approval_plan=decision.approval_plan,
        outcomes=[*outcomes, *decision.tool_results],
        usage_totals=decision.usage,
        streamed_event_types=set(decision.streamed_event_types),
        completion_source=decision.completion_source,
        terminal_error_code=decision.terminal_error_code,
        terminal_subcode=decision.terminal_subcode,
        terminal_error_retryable=decision.terminal_error_retryable,
    )


def resume_before_tool_dispatch(  # noqa: C901, PLR0913, PLR0915
    *,
    hydrated: HydratedBeforeToolDispatchResume,
    runtime: Any,
    kernel: Any,
    request_context: Any,
    working_messages: list[dict[str, object]],
    tool_contract: Any,
    tool_payload: list[dict[str, Any]],
    tool_resolution_context: Any | None,
    tool_preferences: dict[str, tuple[str, ...]] | None,
    mode_policy: Any,
    plan_mode: bool,
    read_only: bool,
    approvals_pre_granted: bool,
    request_id: str,
    session_id: str | None,
    latest_user_content: str,
    reasoning_effort: str | None,
    prompt_cache_enabled: bool,
    cache_source_key: str,
    system_prompt: Any,
    cache_break_detector: Any | None,
    budget_tracker: Any | None,
    read_snapshot_cache: dict[str, Any],
    tool_statuses: Any,
    initial_thinking_text: str | None,
    deferred_budget_initializer: Callable[[], Any],
    request_messages_hash: str,
) -> _tool_loop.ToolLoopResult:
    """Execute the persisted batch, then enter the ordinary next generation."""

    if approvals_pre_granted is not False:
        _fail("continuation_approval_grant_forbidden")
    # The source attempt already emitted its initial status. The fresh worker
    # resumes after that point and must not duplicate the observation.
    _ = initial_thinking_text
    checkpoint = _bind_fresh_request(
        hydrated, runtime=runtime, request_context=request_context,
        request_id=request_id, session_id=session_id,
    )
    _restore_runtime_position(runtime, checkpoint)
    config = getattr(kernel, "_config", None)
    if "quota_state" in checkpoint:
        restore_runtime_quota(runtime, config, checkpoint["quota_state"])
    elif is_resource_discipline_enabled(getattr(config, "feature_flags", None)):
        _fail("continuation_quota_state_unavailable")
    from sidecar.runtime.mutation_continuation import claim_mutation_checkpoint  # noqa: PLC0415
    change_set_id = claim_mutation_checkpoint(
        checkpoint, config=getattr(kernel, "_config", None), request_context=request_context
    )
    run = _ToolLoopRun(
        initial_change_set_id=change_set_id,
        runtime=runtime, kernel=kernel, request_context=request_context,
        working_messages=working_messages, tool_contract=tool_contract,
        tool_payload=tool_payload, tool_resolution_context=tool_resolution_context,
        tool_preferences=tool_preferences, mode_policy=mode_policy,
        plan_mode=plan_mode, read_only=read_only, approvals_pre_granted=False,
        request_id=request_id, session_id=session_id,
        latest_user_content=latest_user_content, reasoning_effort=reasoning_effort,
        prompt_cache_enabled=prompt_cache_enabled, cache_source_key=cache_source_key,
        system_prompt=system_prompt, cache_break_detector=cache_break_detector,
        budget_tracker=budget_tracker, read_snapshot_cache=read_snapshot_cache,
        tool_statuses=tool_statuses, initial_thinking_text=None,
        request_messages_hash=request_messages_hash, initial_outcomes=hydrated.completed_outcomes(),
    )
    calls = hydrated.tool_calls()
    result = GenerationResult(content="", tool_calls=calls)
    try:
        approvals: list[Any] | None = ([] if checkpoint["kind"] == "before_decision_wait"
                     and checkpoint["decision"]["kind"] == "approval" else None)
        remaining, audit_metadata, scan_mode = (
            _preflight_pending_batch(run, result) if approvals is None
            else _preflight_pending_batch(run, result, approvals=approvals)
        )
        if approvals is not None:
            restored = build_restored_approval_result(run, hydrated=hydrated, checkpoint=checkpoint,
                                                     result=result, approval=approvals[0])
            return run._finish(restored, reason="continuation_approval_wait")
        from sidecar.ai.routing.tool_resource_progress import (  # noqa: PLC0415
            resource_deferral_callback,
        )
        iteration_calls: list[Any] = []
        run.outcome_index = len(calls)
        execute_tool_calls_sequentially(
            indexed_calls=remaining, runtime=runtime, kernel=kernel, result=result,
            request_id=request_id, session_id=session_id,
            tool_resolution_context=tool_resolution_context,
            tool_contract=tool_contract, read_snapshot_cache=read_snapshot_cache,
            outcomes=run.outcomes, working_messages=working_messages,
            iteration_calls=iteration_calls,
            streamed_event_types=run.streamed_event_types,
            tool_payload_ref=run.tool_payload, tool_preferences=tool_preferences,
            request_context=request_context, audit_metadata_by_call=audit_metadata,
            approvals_pre_granted=False, scan_approval_mode=scan_mode,
            restored_first_input=hydrated.restored_input(),
            on_resource_deferral=resource_deferral_callback(
                run, checkpoint["position"]["current_iteration"]),
        )
        run.completed_generations = checkpoint["position"]["completed_iterations"]
        early_result = _finish_pending_batch(run, result, iteration_calls)
        if early_result is not None:
            return run._finish(early_result, reason="continuation_budget_exhausted")
        budget_result = deferred_budget_initializer()
        working_messages[:] = budget_result.working_messages
        run.budget_tracker = budget_result.budget_tracker
        if budget_result.terminal_decision is not None:
            terminal = _terminal_loop_result(budget_result.terminal_decision, run.outcomes)
            return run._finish(terminal, reason="continuation_context_budget_terminal")
        if runtime.streaming:
            # Same boundary the in-band tool round emits after its tools
            # (tool_loop_calls._run_tool_phase): Electron closes the pre-approval
            # commentary slice before the next generation restarts its token
            # sequence at 1, so the continuation stops painting into that row.
            loop_event_emit.emit_stream_reset_for_retry(
                runtime, run.streamed_event_types, reason="tool_continuation",
            )
        return run.execute()
    except Exception as error:
        mutation_change_set_lifecycle.finish_run_change_set(
            run, approval_paused=isinstance(error, ToolLoopSuspended),
            reason=f"exception:{type(error).__name__}"
        )
        raise
    finally:
        runtime.preview_images.clear()


__all__ = [
    "ContinuationResumeError",
    "HydratedBeforeToolDispatchResume",
    "resume_before_tool_dispatch",
]
