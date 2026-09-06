"""Focused contracts for canonical sequential tool-call execution."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.error_codes import (
    CMP_TOOL_APPROVAL_WINDOW_DROPPED,
    CMP_TOOL_COERCED_ARGS_REJECTED,
    CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED,
)
from sidecar.ai.routing.loop_events import ToolExecutingEvent, ToolResultEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import (
    execute_tool_calls_sequentially,
    pre_filter_tool_calls,
    settle_dropped_tool_calls,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest


def _call(
    tool_id: str,
    *,
    coerced: bool = False,
    call_id: str | None = None,
) -> ToolCallRequest:
    return ToolCallRequest(
        tool_id=tool_id,
        arguments={"path": f"{tool_id}.txt"},
        call_id=call_id or f"call-{tool_id}",
        coerced=coerced,
    )


def _descriptor(name: str, *, side_effecting: bool = False) -> Any:
    return SimpleNamespace(name=name, side_effecting=side_effecting)


class _Contract:
    def __init__(self, entries: dict[str, Any]) -> None:
        self.entries = entries

    def entry(self, name: str) -> Any | None:
        return self.entries.get(name)


def _contract(entries: dict[str, Any]) -> Any:
    return _Contract(entries)


class _McpClient:
    def __init__(self, descriptors: dict[str, Any] | None = None) -> None:
        self.descriptors = descriptors or {}

    def tool_descriptor(self, name: str) -> Any | None:
        return self.descriptors.get(name)


class _Kernel:
    def __init__(self, descriptors: dict[str, Any] | None = None) -> None:
        self._mcp_client = _McpClient(descriptors)
        self.executed: list[str] = []
        self.failures: dict[str, ToolExecutionFailure] = {}

    def _assert_valid_tool_call(self, _call: ToolCallRequest) -> None:
        return

    def _assistant_tool_call_message(
        self,
        _result: Any,
        call: ToolCallRequest,
    ) -> dict[str, object]:
        return {"role": "assistant", "tool": call.tool_id}

    def _tool_result_message(
        self,
        call: ToolCallRequest,
        _outcome: ToolExecutionOutcome,
    ) -> dict[str, object]:
        return {"role": "tool", "tool": call.tool_id}

    def _execute_tool(self, call: ToolCallRequest, **_kwargs: Any) -> ToolExecutionOutcome:
        self.executed.append(call.tool_id)
        failure = self.failures.get(call.tool_id)
        if failure is not None:
            raise failure
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output=f"result:{call.tool_id}",
            success=True,
            tool_input=dict(call.arguments),
            call_id=call.call_id,
        )

    def _execute_tool_search(
        self,
        call: ToolCallRequest,
        **_kwargs: Any,
    ) -> ToolExecutionOutcome:
        self.executed.append(call.tool_id)
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output="found",
            success=True,
            tool_input=dict(call.arguments),
            call_id=call.call_id,
        )

    def _build_tool_payload(self, *_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        return [{"name": "revealed_tool"}]

    def _update_read_snapshot_cache(self, _cache: dict[str, Any], **_kwargs: Any) -> None:
        return


def _runtime(*, streaming: bool = True) -> tuple[LoopRuntime, list[Any]]:
    events: list[Any] = []
    return (
        LoopRuntime(
            emit=events.append,
            request_id="req-1",
            session_id="session-1",
            streaming=streaming,
            tool_call_limit=20,
        ),
        events,
    )


def _prefilter(
    call: ToolCallRequest,
    *,
    kernel: _Kernel,
    tool_contract: Any | None = None,
    read_only: bool = False,
) -> tuple[list[tuple[Any, int]], list[ToolExecutionOutcome], list[Any]]:
    runtime, events = _runtime()
    outcomes: list[ToolExecutionOutcome] = []
    remaining, _ = pre_filter_tool_calls(
        [call],
        kernel=kernel,
        runtime=runtime,
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        tool_contract=tool_contract,
        read_only=read_only,
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        outcome_index=0,
    )
    return remaining, outcomes, events


def test_coerced_side_effecting_call_preserves_stable_error_contract() -> None:
    descriptor = _descriptor("write_file", side_effecting=True)
    entry = SimpleNamespace(
        descriptor=descriptor,
        available=True,
        reason=None,
        deferred=False,
    )

    remaining, outcomes, events = _prefilter(
        _call("write_file", coerced=True),
        kernel=_Kernel(),
        tool_contract=_contract({"write_file": entry}),
    )

    assert remaining == []
    assert len(outcomes) == 1
    assert outcomes[0].error_code == CMP_TOOL_COERCED_ARGS_REJECTED
    assert outcomes[0].metadata == {
        "coerced_arguments_rejected": True,
        "reason": "malformed_side_effecting_arguments",
        "effects": "unknown",
        "failure_class": "bad_arguments",
    }
    assert [type(event) for event in events] == [ToolExecutingEvent, ToolResultEvent]
    assert events[-1].error_code == CMP_TOOL_COERCED_ARGS_REJECTED


def test_missing_contract_entry_falls_back_to_read_only_client_descriptor() -> None:
    descriptor = _descriptor("bridge_read", side_effecting=False)
    call = _call("bridge_read")
    call.arguments["path"] = "<string>"

    remaining, outcomes, _events = _prefilter(
        call,
        kernel=_Kernel({"bridge_read": descriptor}),
        tool_contract=_contract({}),
        read_only=True,
    )

    assert remaining == [(call, 1)]
    assert outcomes == []


def test_missing_contract_entry_and_client_descriptor_fail_closed_in_read_only() -> None:
    call = _call("missing_read_tool")
    call.arguments["path"] = "<string>"
    remaining, outcomes, _events = _prefilter(
        call,
        kernel=_Kernel(),
        tool_contract=_contract({}),
        read_only=True,
    )

    assert remaining == []
    assert outcomes[0].error_code == CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED
    assert outcomes[0].metadata == {
        "placeholder_arguments_rejected": True,
        "reason": "placeholder_literal",
        "effects": "unknown",
        "failure_class": "bad_arguments",
    }


def test_legacy_direct_caller_still_blocks_coerced_side_effecting_descriptor() -> None:
    descriptor = _descriptor("legacy_write", side_effecting=True)
    remaining, outcomes, _events = _prefilter(
        _call("legacy_write", coerced=True),
        kernel=_Kernel({"legacy_write": descriptor}),
    )

    assert remaining == []
    assert outcomes[0].error_code == CMP_TOOL_COERCED_ARGS_REJECTED


def test_plan_mode_blocks_contract_side_effect_before_dispatch() -> None:
    descriptor = _descriptor("write_file", side_effecting=True)
    entry = SimpleNamespace(
        descriptor=descriptor,
        available=True,
        reason=None,
        deferred=False,
    )
    remaining, outcomes, _events = _prefilter(
        _call("write_file"),
        kernel=_Kernel(),
        tool_contract=_contract({"write_file": entry}),
        read_only=True,
    )

    assert remaining == []
    assert outcomes[0].error_code == "CMP-MODE-0002"
    assert outcomes[0].metadata == {
        "read_only_blocked": True,
        "effects": "unknown",
        "failure_class": "denied",
    }


def test_sequential_dispatch_preserves_model_order_and_result_pairing() -> None:
    kernel = _Kernel()
    runtime, events = _runtime()
    outcomes: list[ToolExecutionOutcome] = []
    messages: list[dict[str, object]] = []
    iteration_calls: list[ToolCallRequest] = []
    streamed: set[str] = set()
    calls = [_call("read_file"), _call("glob_files")]

    execute_tool_calls_sequentially(
        indexed_calls=[(calls[0], 1), (calls[1], 2)],
        runtime=runtime,
        kernel=kernel,
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=outcomes,
        working_messages=messages,
        iteration_calls=iteration_calls,
        streamed_event_types=streamed,
        tool_payload_ref=[],
        tool_contract=_contract({}),
    )

    assert kernel.executed == ["read_file", "glob_files"]
    assert [outcome.tool_name for outcome in outcomes] == kernel.executed
    assert [call.tool_id for call in iteration_calls] == kernel.executed
    assert len(messages) == 4
    assert [type(event) for event in events] == [
        ToolExecutingEvent,
        ToolResultEvent,
        ToolExecutingEvent,
        ToolResultEvent,
    ]
    assert streamed == {"tool.executing", "tool.result"}


def test_sequential_dispatch_recovers_typed_tool_failure_and_continues() -> None:
    kernel = _Kernel()
    kernel.failures["read_file"] = ToolExecutionFailure(
        code="CMP-TOOL-0099",
        message="bounded failure",
        retryable=False,
    )
    runtime, _events = _runtime(streaming=False)
    outcomes: list[ToolExecutionOutcome] = []
    calls = [_call("read_file"), _call("glob_files")]

    execute_tool_calls_sequentially(
        indexed_calls=[(calls[0], 1), (calls[1], 2)],
        runtime=runtime,
        kernel=kernel,
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        tool_payload_ref=[],
        tool_contract=_contract({}),
    )

    assert kernel.executed == ["read_file", "glob_files"]
    assert outcomes[0].success is False
    assert outcomes[0].error_code == "CMP-TOOL-0099"
    assert outcomes[1].success is True


def test_tool_search_refreshes_payload_without_reordering() -> None:
    kernel = _Kernel()
    runtime, _events = _runtime(streaming=False)
    payload: list[dict[str, Any]] = [{"name": "tool_search"}]
    call = _call("tool_search")

    execute_tool_calls_sequentially(
        indexed_calls=[(call, 1)],
        runtime=runtime,
        kernel=kernel,
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=[],
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        tool_payload_ref=payload,
    )

    assert kernel.executed == ["tool_search"]
    assert payload == [{"name": "revealed_tool"}]


# ── F19: reserved calls outside the approved window get terminal outcomes ────


def test_settle_dropped_tool_calls_settles_every_reserved_call() -> None:
    """Every budget-reserved call the resume skips gets an explicit outcome."""
    kernel = _Kernel()
    runtime, events = _runtime()
    outcomes: list[ToolExecutionOutcome] = []
    working_messages: list[dict[str, object]] = []
    iteration_calls: list[Any] = []
    streamed: set[str] = set()
    dropped = (
        _call("read_file", call_id="call-early-side-effect"),
        _call("write_file", call_id="call-after-approved"),
    )

    settled = settle_dropped_tool_calls(
        kernel=kernel,
        runtime=runtime,
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        dropped_calls=dropped,
        outcomes=outcomes,
        working_messages=working_messages,
        iteration_calls=iteration_calls,
        streamed_event_types=streamed,
    )

    assert settled == 2
    assert kernel.executed == [], "dropped calls must never dispatch"
    assert [outcome.call_id for outcome in outcomes] == [
        "call-early-side-effect",
        "call-after-approved",
    ]
    assert all(outcome.success is False for outcome in outcomes)
    assert all(
        outcome.error_code == CMP_TOOL_APPROVAL_WINDOW_DROPPED for outcome in outcomes
    )
    assert all(
        outcome.metadata.get("approval_window_dropped") is True for outcome in outcomes
    )
    assert all("approved execution window" in outcome.output for outcome in outcomes)
    executing = [event for event in events if isinstance(event, ToolExecutingEvent)]
    results = [event for event in events if isinstance(event, ToolResultEvent)]
    assert [event.call_id for event in executing] == [
        "call-early-side-effect",
        "call-after-approved",
    ]
    assert [event.call_id for event in results] == [
        "call-early-side-effect",
        "call-after-approved",
    ]
    assert streamed == {"tool.executing", "tool.result"}
    # One assistant/tool message pair per settled call keeps history well-formed.
    assert len(working_messages) == 4
    assert [call.call_id for call in iteration_calls] == [
        "call-early-side-effect",
        "call-after-approved",
    ]


def test_settle_dropped_tool_calls_is_a_no_op_without_dropped_calls() -> None:
    kernel = _Kernel()
    runtime, events = _runtime()
    outcomes: list[ToolExecutionOutcome] = []

    settled = settle_dropped_tool_calls(
        kernel=kernel,
        runtime=runtime,
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        dropped_calls=(),
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
    )

    assert settled == 0
    assert outcomes == []
    assert events == []
