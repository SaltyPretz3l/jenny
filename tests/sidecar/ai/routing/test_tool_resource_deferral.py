from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_RESOURCE_EXCEEDED
from sidecar.ai.routing.loop_events import ToolExecutingEvent, ToolResultEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import execute_tool_calls_sequentially
from sidecar.ai.routing.tool_resource_deferral import (
    PreparedToolDeferral,
    ToolResourceDeferred,
    ToolResourceWait,
    build_before_tool_dispatch_continuation,
    first_batch_deferral_eligible,
    suspend_loop_for_resource,
)
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.approval_plan import FrozenExecutionInputs, stable_hash


def _wait(call_id: str = "call_1") -> ToolResourceWait:
    return ToolResourceWait(
        operation_id=call_id,
        resource_class="native_processes",
        reason="capacity",
    )


def _frozen() -> FrozenExecutionInputs:
    effective = {"count": 1.0, "label": "caf\u00e9", "nested": [1, {"ok": True}]}
    return FrozenExecutionInputs(
        call_id="call_1",
        tool_name="run_command",
        visible_tool_arguments={"count": 1.0, "label": "caf\u00e9"},
        effective_tool_arguments=effective,
        injected_arg_keys=("_jenny_session_id",),
        effective_args_fingerprint=stable_hash(effective),
        execution_context_payload={"session_id": "session_1"},
    )


def _call(call_id: str = "call_1", tool_id: str = "run_command") -> ToolCallRequest:
    return ToolCallRequest(
        call_id=call_id,
        tool_id=tool_id,
        arguments={"count": 1.0, "label": "caf\u00e9"},
        idempotency_key="",
        argument_repairs=("closed_string",),
    )


def _prepared() -> PreparedToolDeferral:
    return PreparedToolDeferral.freeze(
        wait=_wait(), call_id="call_1", tool_id="run_command", frozen_inputs=_frozen()
    )


def test_prepared_input_retains_exact_python_canonical_bytes_and_fingerprint() -> None:
    prepared = _prepared()

    assert b'"count":1.0' in prepared.frozen_input_bytes
    assert b'caf\\u00e9' in prepared.frozen_input_bytes
    assert prepared.frozen_input_sha256 == hashlib.sha256(
        prepared.frozen_input_bytes
    ).hexdigest()
    assert prepared.effective_args_sha256 == _frozen().effective_args_fingerprint
    assert prepared.frozen_input() == json.loads(prepared.frozen_input_bytes)


def test_prepared_input_and_generated_batch_views_are_fresh() -> None:
    prepared = _prepared()
    deferred = ToolResourceDeferred(_wait(), prepared)
    calls = (_call(), _call("call_2", "read_file"))
    continuation = build_before_tool_dispatch_continuation(
        deferred,
        ordered_call_ids=("call_1", "call_2"),
        current_iteration=1,
        remaining_iterations=3,
        tool_call_limit=20,
        tool_calls_consumed=2,
        active_budget_ms_remaining=5_000,
        tool_calls=calls,
    )

    first_input = prepared.frozen_input()
    first_input["effective_tool_arguments"]["count"] = 99
    first_calls = continuation.tool_calls()
    first_calls[0].arguments["count"] = 99

    assert prepared.frozen_input()["effective_tool_arguments"]["count"] == 1.0
    assert continuation.tool_calls()[0].arguments["count"] == 1.0
    assert continuation.tool_batch_sha256 == hashlib.sha256(
        continuation.tool_batch_bytes
    ).hexdigest()
    assert b'"count":1.0' in continuation.tool_batch_bytes


def test_callback_receives_exact_batch_and_input_without_mutable_aliases() -> None:
    captured: list[Any] = []
    checkpoint_ref = {
        "schema_version": 1,
        "checkpoint_id": f"checkpoint_{'a' * 64}",
        "sha256": "b" * 64,
        "bytes": 100,
        "source_attempt": {
            "attempt_id": "attempt_1",
            "stream_id": "stream_1",
            "incarnation": "incarnation_1",
            "authority_revision": "authority_1",
        },
    }

    def checkpoint(context: Any) -> dict[str, Any]:
        captured.append(context)
        context.pending.frozen_input()["effective_tool_arguments"]["count"] = 99
        context.tool_calls()[0].arguments["count"] = 99
        return checkpoint_ref

    runtime = LoopRuntime(
        request_id="request_1",
        session_id="session_1",
        streaming=True,
        tool_call_limit=20,
        continuation_checkpoint=checkpoint,
    )
    runtime.tool_calls_consumed = 2
    loop = SimpleNamespace(runtime=runtime, iteration_total=4,
                           kernel=SimpleNamespace(_config=None), outcomes=[], tool_contract=None)
    deferred = ToolResourceDeferred(_wait(), _prepared())
    calls = (_call(), _call("call_2", "read_file"))

    suspended = suspend_loop_for_resource(
        loop, deferred, ordered_calls=calls, current_iteration=1
    )

    assert suspended.checkpoint_ref == checkpoint_ref
    assert captured[0].pending.effective_arguments()["count"] == 1.0
    assert captured[0].tool_calls()[0].arguments["count"] == 1.0


def test_prepared_input_rejects_identity_fingerprint_and_non_json_drift() -> None:
    wrong_identity = _frozen()
    object.__setattr__(wrong_identity, "call_id", "call_2")
    with pytest.raises(ValueError, match="invalid_frozen_execution_inputs"):
        PreparedToolDeferral.freeze(
            wait=_wait(), call_id="call_1", tool_id="run_command",
            frozen_inputs=wrong_identity,
        )

    wrong_hash = _frozen()
    object.__setattr__(wrong_hash, "effective_args_fingerprint", "0" * 64)
    with pytest.raises(ValueError, match="effective_args_fingerprint_mismatch"):
        PreparedToolDeferral.freeze(
            wait=_wait(), call_id="call_1", tool_id="run_command",
            frozen_inputs=wrong_hash,
        )

    non_json = _frozen()
    non_json.effective_tool_arguments["bad"] = float("nan")
    with pytest.raises(ValueError, match="invalid_frozen_execution_inputs"):
        PreparedToolDeferral.freeze(
            wait=_wait(), call_id="call_1", tool_id="run_command",
            frozen_inputs=non_json,
        )


def _eligibility(**overrides: Any) -> bool:
    values = {
        "callback": lambda _checkpoint: {},
        "streaming": True,
        "iteration_base": 0,
        "current_iteration": 1,
        "outcomes_before_batch": 0,
        "outcomes_after_filter": 0,
        "emitted_tool_execution_count": 0,
        "preview_count": 0,
        "has_images": False,
        "mutation_started": False,
        "approval_resume": False,
        "auto_checkpoint_pending": False,
        "contains_delegate": False,
        "ordered_call_ids": ("call_1", "call_2"),
        "pending_call_id": "call_1",
        "pending_tool_id": "run_command",
    }
    values.update(overrides)
    return first_batch_deferral_eligible(**values)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("callback", None),
        ("streaming", False),
        ("iteration_base", 1),
        ("current_iteration", 2),
        ("outcomes_before_batch", 1),
        ("outcomes_after_filter", 1),
        ("emitted_tool_execution_count", 1),
        ("preview_count", 1),
        ("has_images", True),
        ("mutation_started", True),
        ("approval_resume", True),
        ("auto_checkpoint_pending", True),
        ("contains_delegate", True),
        ("pending_call_id", "call_2"),
    ],
)
def test_closed_first_batch_eligibility_rejects_unsupported_state(
    field: str, value: object,
) -> None:
    assert _eligibility() is True
    assert _eligibility(**{field: value}) is False


class _DeferredKernel:
    def __init__(self) -> None:
        self._config = SimpleNamespace(tool_result_envelope_enabled=False)

    def _execute_tool(self, *_args: Any, **_kwargs: Any) -> ToolExecutionOutcome:
        raise ToolResourceDeferred(_wait())

    def _update_read_snapshot_cache(self, *_args: Any, **_kwargs: Any) -> None:
        return

    def _assistant_tool_call_message(self, *_args: Any) -> dict[str, str]:
        return {"role": "assistant"}

    def _tool_result_message(self, *_args: Any) -> dict[str, str]:
        return {"role": "tool"}


class _SecondDeferredKernel(_DeferredKernel):
    def __init__(self) -> None:
        super().__init__()
        self.executed: list[str] = []

    def _execute_tool(
        self, call: ToolCallRequest, **_kwargs: Any
    ) -> ToolExecutionOutcome:
        self.executed.append(call.call_id)
        if call.call_id == "call_2":
            raise ToolResourceDeferred(_wait("call_2"))
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output="ok",
            success=True,
            tool_input=dict(call.arguments),
            call_id=call.call_id,
        )


def _sequential(
    *, allow: bool, events: list[Any], outcomes: list[ToolExecutionOutcome]
) -> None:
    runtime = LoopRuntime(
        emit=events.append,
        request_id="request_1",
        session_id="session_1",
        streaming=True,
        tool_call_limit=20,
    )
    execute_tool_calls_sequentially(
        indexed_calls=[(_call(), 1)],
        runtime=runtime,
        kernel=_DeferredKernel(),
        result=SimpleNamespace(),
        request_id="request_1",
        session_id="session_1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        tool_payload_ref=[],
        allow_resource_deferral=allow,
    )
def test_eligible_wait_emits_neither_executing_nor_result() -> None:
    events: list[Any] = []
    outcomes: list[ToolExecutionOutcome] = []
    with pytest.raises(ToolResourceDeferred):
        _sequential(allow=True, events=events, outcomes=outcomes)

    assert events == []
    assert outcomes == []


def test_legacy_wait_retains_paired_executing_and_result() -> None:
    events: list[Any] = []
    outcomes: list[ToolExecutionOutcome] = []
    _sequential(allow=False, events=events, outcomes=outcomes)

    assert [type(event) for event in events] == [ToolExecutingEvent, ToolResultEvent]
    assert outcomes[0].error_code == CMP_RESOURCE_EXCEEDED


def test_second_call_wait_after_effect_is_a_paired_failure_without_checkpoint() -> None:
    events: list[Any] = []
    checkpoints: list[Any] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="request_1",
        session_id="session_1",
        streaming=True,
        tool_call_limit=20,
        continuation_checkpoint=lambda value: checkpoints.append(value) or {},
    )
    kernel = _SecondDeferredKernel()
    outcomes: list[ToolExecutionOutcome] = []

    execute_tool_calls_sequentially(
        indexed_calls=[(_call(), 1), (_call("call_2", "read_file"), 2)],
        runtime=runtime,
        kernel=kernel,
        result=SimpleNamespace(),
        request_id="request_1",
        session_id="session_1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        tool_payload_ref=[],
        allow_resource_deferral=True,
    )

    assert kernel.executed == ["call_1", "call_2"]
    assert [outcome.success for outcome in outcomes] == [True, False]
    assert outcomes[1].error_code == CMP_RESOURCE_EXCEEDED
    assert [type(event) for event in events] == [
        ToolExecutingEvent, ToolResultEvent, ToolExecutingEvent, ToolResultEvent,
    ]
    assert checkpoints == []
