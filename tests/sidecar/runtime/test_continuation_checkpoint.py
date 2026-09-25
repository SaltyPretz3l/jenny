from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_resource_deferral import (
    PreparedToolDeferral,
    ToolResourceDeferred,
    ToolResourceWait,
    build_before_tool_dispatch_continuation,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.approval import approval_resolution_from_response
from sidecar.runtime.approval_plan import ApprovalPlan, FrozenExecutionInputs, stable_hash
from sidecar.runtime.continuation_checkpoint import (
    MAX_CHECKPOINT_REQUEST_BYTES,
    MAX_CHECKPOINT_SNAPSHOT_BYTES,
    build_continuation_checkpoint_callback,
)
from sidecar.runtime.continuation_context import continuation_context_from_params
from sidecar.runtime.decision_checkpoint import prepare_approval_decision
from sidecar.runtime.execution_context import execution_context_from_params


class _Reader:
    def __init__(self, response: Any) -> None:
        self.response = response
        self.closed = False
        self.timeouts: list[float] = []

    def __call__(self, timeout: float) -> dict[str, Any]:
        self.timeouts.append(timeout)
        if isinstance(self.response, BaseException):
            raise self.response
        return self.response() if callable(self.response) else self.response

    def close(self) -> None:
        self.closed = True


def _context():
    execution_context = execution_context_from_params(
        {
            "execution_context": {
                "schema_version": 1,
                "authority_revision": "authority_1",
                "project_id": "project_1",
                "root_path": None,
                "root_id": None,
                "root_revision": 0,
                "device_id": None,
                "inode": None,
                "tool_policy_snapshot": {"version": 3, "legacy_policies": {}},
                "knowledge_roots": [],
            }
        }
    )
    assert execution_context is not None
    context = continuation_context_from_params(
        {
            "continuation_context": {
                "schema_version": 1,
                "work_id": "work_1",
                "turn_id": "turn_1",
                "source_attempt": {
                    "attempt_id": "attempt_1",
                    "stream_id": "stream_1",
                    "incarnation": "incarnation_1",
                    "authority_revision": "authority_1",
                },
                "authority": {
                    "project_id": "project_1",
                    "root_id": None,
                    "root_revision": 0,
                    "sha256": "a" * 64,
                },
                "route": {
                    "route_id": "route_1",
                    "route_revision": "configuration:4",
                    "sha256": "b" * 64,
                },
            }
        },
        request_id="stream_1",
        session_id="session_1",
        execution_context=execution_context,
    )
    assert context is not None
    return context


def _continuation(payload: str = "caf\u00e9"):
    effective = {"content": payload, "count": 1.0}
    frozen = FrozenExecutionInputs(
        call_id="call_1",
        tool_name="run_command",
        visible_tool_arguments={"content": payload},
        effective_tool_arguments=effective,
        injected_arg_keys=("_jenny_session_id",),
        effective_args_fingerprint=stable_hash(effective),
        execution_context_payload={"authority_revision": "authority_1"},
    )
    wait = ToolResourceWait(
        operation_id="call_1",
        resource_class="native_processes",
        reason="capacity",
    )
    prepared = PreparedToolDeferral.freeze(
        wait=wait,
        call_id="call_1",
        tool_id="run_command",
        frozen_inputs=frozen,
    )
    calls = (
        ToolCallRequest(
            call_id="call_1",
            tool_id="run_command",
            arguments={"content": payload},
            idempotency_key="idem_1",
            argument_repairs=("closed_string",),
        ),
        ToolCallRequest(
            call_id="call_2",
            tool_id="read_file",
            arguments={"path": "a.txt"},
            idempotency_key="idem_2",
        ),
    )
    return build_before_tool_dispatch_continuation(
        ToolResourceDeferred(wait, prepared),
        ordered_call_ids=("call_1", "call_2"),
        current_iteration=1,
        remaining_iterations=3,
        tool_call_limit=20,
        tool_calls_consumed=2,
        active_budget_ms_remaining=5_000,
        tool_calls=calls,
    )


def _checkpoint_ref() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "checkpoint_id": "checkpoint_" + ("c" * 64),
        "sha256": "d" * 64,
        "bytes": 4096,
        "source_attempt": _context().source_attempt.to_wire(),
    }


def _result(**overrides: Any) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "operation_id": "call_1",
        "status": "checkpointed",
        "checkpoint_ref": _checkpoint_ref(),
        **overrides,
    }


def _callback(sent: list[dict[str, Any]], result: Any, *, cancel_handle: Any = None):
    readers: list[_Reader] = []

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        response = result() if callable(result) else result
        reader = _Reader({"id": rpc_id, "result": response})
        readers.append(reader)
        return reader

    callback = build_continuation_checkpoint_callback(
        context=_context(),
        write_message=sent.append,
        response_reader_factory=factory,
        cancel_handle=cancel_handle,
    )
    assert callback is not None
    return callback, readers


def test_checkpoint_request_is_exact_and_returns_only_normalized_reference() -> None:
    sent: list[dict[str, Any]] = []
    continuation = _continuation()
    callback, readers = _callback(sent, _result())

    checkpoint_ref = callback(continuation)

    assert checkpoint_ref == _checkpoint_ref()
    assert checkpoint_ref is not _checkpoint_ref()
    assert set(sent[0]) == {"jsonrpc", "api_version", "id", "method", "params"}
    assert sent[0]["jsonrpc"] == "2.0"
    assert sent[0]["api_version"] == "2026-08-17"
    assert sent[0]["method"] == "runtime.operation"
    params = sent[0]["params"]
    assert set(params) == {
        "api_version",
        "schema_version",
        "kind",
        "phase",
        "request_id",
        "session_id",
        "authority_revision",
        "operation_id",
        "continuation_context",
        "position",
        "eligibility",
        "tool_calls",
        "tool_batch_bytes",
        "tool_batch_sha256",
        "frozen_input",
        "frozen_input_bytes",
        "frozen_input_sha256",
    }
    assert params["kind"] == "continuation"
    assert params["phase"] == "checkpoint"
    assert params["request_id"] == "stream_1"
    assert params["session_id"] == "session_1"
    assert params["authority_revision"] == "authority_1"
    assert params["operation_id"] == "call_1"
    assert params["continuation_context"] == _context().to_wire()
    assert params["position"] == {
        "completed_iterations": 1,
        "remaining_iterations": 3,
        "current_iteration": 1,
        "tool_call_limit": 20,
        "tool_calls_consumed": 2,
        "active_budget_ms_remaining": 5_000,
        "ordered_call_ids": ["call_1", "call_2"],
    }
    assert params["eligibility"] == {
        "pending_call_index": 0,
        "prior_outcome_count": 0,
        "emitted_tool_execution_count": 0,
        "preview_count": 0,
        "approval_pending": False,
        "mutation_started": False,
    }
    assert params["tool_calls"] == json.loads(continuation.tool_batch_bytes)["calls"]
    assert base64.b64decode(params["tool_batch_bytes"]) == continuation.tool_batch_bytes
    assert params["tool_batch_sha256"] == continuation.tool_batch_sha256
    assert params["frozen_input"] == continuation.pending.frozen_input()
    assert base64.b64decode(params["frozen_input_bytes"]) == (
        continuation.pending.frozen_input_bytes
    )
    assert params["frozen_input_sha256"] == continuation.pending.frozen_input_sha256
    assert readers[0].closed is True


def test_source_snapshots_and_returned_reference_are_fresh() -> None:
    sent: list[dict[str, Any]] = []
    continuation = _continuation()
    original_batch = continuation.tool_batch_bytes
    original_input = continuation.pending.frozen_input()
    callback, _readers = _callback(sent, _result())

    first = callback(continuation)
    first["source_attempt"]["attempt_id"] = "mutated"
    sent[0]["params"]["continuation_context"]["work_id"] = "mutated"
    second = callback(continuation)

    assert second["source_attempt"]["attempt_id"] == "attempt_1"
    assert sent[1]["params"]["continuation_context"]["work_id"] == "work_1"
    assert continuation.tool_batch_bytes == original_batch
    assert continuation.pending.frozen_input() == original_input


def test_precancelled_checkpoint_fails_without_transport_or_suspension() -> None:
    sent: list[dict[str, Any]] = []
    factory_called = False

    def factory(_rpc_id: int, **_kwargs: Any) -> _Reader:
        nonlocal factory_called
        factory_called = True
        return _Reader({})

    callback = build_continuation_checkpoint_callback(
        context=_context(),
        write_message=sent.append,
        response_reader_factory=factory,
        cancel_handle=SimpleNamespace(cancelled=True),
    )
    assert callback is not None
    with pytest.raises(ToolExecutionFailure, match="cancelled") as caught:
        callback(_continuation())
    assert caught.value.retryable is True
    assert sent == []
    assert factory_called is False


def test_timeout_failure_closes_reader() -> None:
    sent: list[dict[str, Any]] = []
    reader = _Reader(TimeoutError("lost response"))
    callback = build_continuation_checkpoint_callback(
        context=_context(),
        write_message=sent.append,
        response_reader_factory=lambda _rpc_id, **_kwargs: reader,
        cancel_handle=None,
    )
    assert callback is not None
    with pytest.raises(ToolExecutionFailure, match="incomplete") as caught:
        callback(_continuation())
    assert caught.value.retryable is True
    assert reader.closed is True


@pytest.mark.parametrize(
    "mutate",
    [
        lambda result: result.update(schema_version=True),
        lambda result: result.update(operation_id="other_call"),
        lambda result: result.update(extra="forged"),
        lambda result: result["checkpoint_ref"].update(checkpoint_id="checkpoint_bad"),
        lambda result: result["checkpoint_ref"].update(bytes=True),
        lambda result: result["checkpoint_ref"].update(bytes=1),
        lambda result: result["checkpoint_ref"]["source_attempt"].update(
            attempt_id="other_attempt"
        ),
        lambda result: result["checkpoint_ref"].update(extra="forged"),
    ],
)
def test_malformed_or_stale_checkpoint_response_is_rejected(mutate) -> None:
    result = _result()
    mutate(result)
    callback, _readers = _callback([], result)

    with pytest.raises(ToolExecutionFailure, match="response_malformed"):
        callback(_continuation())


def test_closed_rejection_is_a_failure_not_a_suspension() -> None:
    result = {
        "schema_version": 1,
        "operation_id": "call_1",
        "status": "rejected",
        "reason": "checkpoint_store_busy",
    }
    callback, _readers = _callback([], result)

    with pytest.raises(ToolExecutionFailure, match="checkpoint_store_busy"):
        callback(_continuation())


def test_snapshot_digest_and_per_value_byte_bounds_are_reasserted() -> None:
    continuation = _continuation()
    object.__setattr__(continuation, "tool_batch_sha256", "0" * 64)
    callback, _readers = _callback([], _result())
    with pytest.raises(ToolExecutionFailure, match="tool_batch_bytes_invalid"):
        callback(continuation)

    oversized = _continuation()
    body = b"x" * (MAX_CHECKPOINT_SNAPSHOT_BYTES + 1)
    object.__setattr__(oversized, "_tool_batch_json", body)
    object.__setattr__(oversized, "tool_batch_sha256", hashlib.sha256(body).hexdigest())
    with pytest.raises(ToolExecutionFailure, match="tool_batch_bytes_invalid"):
        callback(oversized)


def test_outer_request_bound_refuses_large_valid_duplicates_before_transport() -> None:
    continuation = _continuation("x" * 260_000)
    assert len(continuation.tool_batch_bytes) < MAX_CHECKPOINT_SNAPSHOT_BYTES
    assert len(continuation.pending.frozen_input_bytes) < MAX_CHECKPOINT_SNAPSHOT_BYTES
    sent: list[dict[str, Any]] = []
    callback, _readers = _callback(sent, _result())

    with pytest.raises(ToolExecutionFailure, match="request_too_large"):
        callback(continuation)
    assert sent == []
    assert MAX_CHECKPOINT_REQUEST_BYTES == 1024 * 1024


def test_builder_omission_and_timeout_validation_are_closed() -> None:
    assert (
        build_continuation_checkpoint_callback(
            context=None,
            write_message=None,
            response_reader_factory=None,
            cancel_handle=None,
        )
        is None
    )
    with pytest.raises(TypeError, match="ContinuationContext"):
        build_continuation_checkpoint_callback(
            context=object(),  # type: ignore[arg-type]
            write_message=None,
            response_reader_factory=None,
            cancel_handle=None,
        )
    with pytest.raises(ToolExecutionFailure, match="timeout_invalid"):
        build_continuation_checkpoint_callback(
            context=_context(),
            write_message=None,
            response_reader_factory=None,
            cancel_handle=None,
            timeout_seconds=float("nan"),
        )


def test_explicit_pause_probe_can_continue_without_a_checkpoint() -> None:
    sent: list[dict[str, Any]] = []
    callback, readers = _callback(
        sent,
        {
            "schema_version": 1,
            "operation_id": "call_1",
            "status": "continue",
        },
    )
    assert callback.probe_pause(_continuation()) is None
    assert sent[0]["params"]["phase"] == "pause_probe"
    assert readers[0].closed
    with pytest.raises(ToolExecutionFailure):
        callback(_continuation())


def test_explicit_pause_probe_returns_the_same_closed_checkpoint_reference() -> None:
    sent: list[dict[str, Any]] = []
    callback, _readers = _callback(sent, _result())
    assert callback.probe_pause(_continuation()) == _checkpoint_ref()
    assert sent[0]["params"]["phase"] == "pause_probe"


def _decision_plan():

    arguments = {"path": "fixture.txt"}
    frozen = FrozenExecutionInputs(
        call_id="call_1",
        tool_name="read_file",
        visible_tool_arguments=arguments,
        effective_tool_arguments=arguments,
        injected_arg_keys=(),
        effective_args_fingerprint=stable_hash(arguments),
        execution_context_payload={"authority_revision": "authority_1"},
    )
    return ApprovalPlan(
        request_id="stream_1", trace_id=None, session_id="session_1",
        latest_user_content="Read", working_messages=(), generation_result=None,
        tool_resolution_context=None, read_snapshot_cache={}, usage_totals=None,
        streamed_event_types=frozenset(), system_prompt="", prompt_cache_enabled=False,
        cache_source_key="", request_messages_hash="", tool_payload=(), tool_statuses=(),
        tool_contract_hash="", effective_args_fingerprint="", execution_context_fingerprint="",
        model_identity_fingerprint="", system_prompt_hash="", sampling_params_hash="",
        message_history_hash="", parent_approval_plan_hash="", approval_plan_hash="",
        request_context=SimpleNamespace(continuation_context=_context()),
        tool_calls=(ToolCallRequest(call_id="call_1", tool_id="read_file", arguments=arguments),),
        frozen_inputs=(frozen,),
        outcomes=(
            ToolExecutionOutcome(
                tool_name="list_dir", output="failed", success=False, call_id="completed_1"
            ),
        ),
        tool_contract=None,
        approved_call_id="call_1",
        call_id="call_1",
        tool_call_limit=10,
        remaining_tool_calls=9,
        wall_clock_deadline=105.0,
        completed_iterations=2,
        remaining_iterations=6,
    )


def test_decision_snapshot_preserves_uncharged_failure_and_wait_entry_budget():

    plan = _decision_plan()
    snapshot = prepare_approval_decision(plan, now=100.0)
    assert snapshot is not None
    params = json.loads(snapshot.params_json)
    assert params["position"]["tool_calls_consumed"] == 1
    assert params["eligibility"]["prior_outcome_count"] == 1
    assert params["position"]["active_budget_ms_remaining"] == 5000
    assert params["completed_effect_refs"][0]["success"] is False
    plan.tool_calls[0].arguments["path"] = "changed.txt"
    assert json.loads(snapshot.params_json)["tool_calls"][0]["arguments"]["path"] == "fixture.txt"


@pytest.mark.parametrize("mutation", ["frozen_mutation", "outcome_mutation", "no_input", "quota"])
def test_unsupported_decision_snapshot_keeps_the_existing_waiter(mutation):

    plan = _decision_plan()
    if mutation == "frozen_mutation":
        plan.frozen_inputs[0].effective_tool_arguments["_jenny_change_set_id"] = "change_1"
    elif mutation == "outcome_mutation":
        plan.outcomes[0].metadata["workspace_change_set"] = "change_1"
    elif mutation == "no_input":
        plan = replace(plan, frozen_inputs=())
    else:
        plan = replace(plan, tool_calls=(replace(plan.tool_calls[0], tool_id="web_search"),))
    assert prepare_approval_decision(plan, now=100.0) is None


def test_decision_pause_is_not_consent_and_publication_failure_propagates():

    snapshot = prepare_approval_decision(_decision_plan(), now=100.0)
    pause = {"schema_version": 1, "request_id": "stream_1", "decision": snapshot.decision()}
    resolution = approval_resolution_from_response(
        {"id": 7, "result": {"runtime_decision_pause": pause}}, 7
    )
    assert resolution.approved is False
    assert resolution.status == "runtime_pause"
    reader = _Reader({"id": 9, "result": _result(status="rejected", reason="persistence_failed")})

    def response_factory(rpc_id, **_kwargs):
        reader.response["id"] = rpc_id
        return reader

    with pytest.raises(ToolExecutionFailure):
        snapshot.suspend(
            pause,
            write_message=lambda _frame: None,
            response_reader_factory=response_factory,
            cancel_handle=None,
        )
    assert reader.closed
    malformed = approval_resolution_from_response(
        {"id": 7, "result": {"runtime_decision_pause": pause, "approved": True}}, 7
    )
    assert malformed.approved is False
    assert malformed.status == "runtime_pause_invalid"


@pytest.mark.parametrize("consumed", [1, 2])
def test_question_snapshot_retains_failed_prefix_and_reserved_slots(consumed):
    from sidecar.ai.routing.loop_runtime import LoopRuntime
    from sidecar.runtime.decision_checkpoint import prepare_question_decision
    plan = _decision_plan()
    arguments = {"questions": [{"id": "choice", "prompt": "Continue?"}]}
    call = ToolCallRequest(call_id="question_1", tool_id="ask_user", arguments=arguments)
    frozen = replace(plan.frozen_inputs[0], call_id=call.call_id, tool_name=call.tool_id,
                     visible_tool_arguments=arguments, effective_tool_arguments=arguments,
                     effective_args_fingerprint=stable_hash(arguments))
    runtime = LoopRuntime(current_iteration=3, iteration_base=2, max_iterations=6,
                          tool_call_limit=10, tool_calls_consumed=consumed,
                          wall_clock_deadline=105.0, clock=lambda: 100.0)
    snapshot = prepare_question_decision(
        frozen, runtime=runtime, request_context=plan.request_context,
        tool_contract=None, pending_calls=(call,), completed_outcomes=plan.outcomes,
    )
    assert snapshot is not None
    params = json.loads(snapshot.params_json)
    assert params["decision"]["kind"] == "user_questions"
    assert params["decision"]["execution_started"] is True
    assert params["position"]["tool_calls_consumed"] == consumed
    assert params["position"]["remaining_iterations"] == 5
    assert params["position"]["active_budget_ms_remaining"] == 5000
    assert params["completed_effect_refs"][0]["success"] is False
    arguments["questions"][0]["prompt"] = "Changed"
    assert json.loads(snapshot.params_json)["tool_calls"][0]["arguments"]["questions"][0]["prompt"] == "Continue?"


def test_question_snapshot_retains_unfrozen_pending_suffix():
    from sidecar.ai.routing.loop_runtime import LoopRuntime
    from sidecar.runtime.decision_checkpoint import prepare_question_decision
    plan = _decision_plan()
    arguments = {"questions": [{"prompt": "Continue?"}]}
    first = ToolCallRequest(call_id="question_1", tool_id="ask_user", arguments=arguments)
    frozen = replace(plan.frozen_inputs[0], call_id=first.call_id, tool_name=first.tool_id,
                     visible_tool_arguments=arguments, effective_tool_arguments=arguments,
                     effective_args_fingerprint=stable_hash(arguments))
    runtime = LoopRuntime(tool_call_limit=10, tool_calls_consumed=3, current_iteration=1)
    snapshot = prepare_question_decision(frozen, runtime=runtime,
        request_context=plan.request_context, tool_contract=None,
        pending_calls=(first, plan.tool_calls[0]), completed_outcomes=plan.outcomes)
    assert snapshot is not None
    params = json.loads(snapshot.params_json)
    assert params["position"]["ordered_call_ids"] == ["question_1", "call_1"]
    assert params["position"]["tool_calls_consumed"] == 3
    assert params["frozen_input"]["call_id"] == "question_1"
