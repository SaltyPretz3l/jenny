"""Focused tests for the Phase 9 ``loop_event_emit`` helpers.

Covers:
* Extracted helpers behave identically to the pre-Phase-9 ``tool_loop``
  inline implementations for the ``ToolExecutingEvent`` /
  ``ToolResultEvent`` / ``StreamResetEvent`` shapes.
* :func:`pre_dispatch_emit_executing` emits one ``ToolExecutingEvent``
  per call, records the call_id on the runtime, and is idempotent when
  combined with the in-loop ``emit_tool_executing`` (no double-emit).
* Defensive: emit_tool_executing on a runtime whose ``emit`` callable
  raises does not propagate the exception out of ``pre_dispatch_emit_executing``.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.error_codes import CMP_LOOP_TOOL_INTERRUPTED
from sidecar.ai.routing.loop_event_emit import (
    build_interrupted_tool_outcome,
    emit_interrupted_results_for_pending_calls,
    emit_stream_reset_for_retry,
    emit_tool_executing,
    emit_tool_result,
    pre_dispatch_emit_executing,
)
from sidecar.ai.routing.loop_events import (
    LoopEvent,
    PhaseStartedEvent,
    StreamResetEvent,
    ToolExecutingEvent,
    ToolResultEvent,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_observation import (
    KIND_TOOL_EXECUTION_FAILED,
    ToolObservationStore,
)
from sidecar.ai.tools.models import ToolCallRequest


def _make_runtime(
    *, streaming: bool = True, phase_events_enabled: bool = False
) -> tuple[LoopRuntime, list[LoopEvent]]:
    captured: list[LoopEvent] = []

    def _emit(event: LoopEvent) -> None:
        captured.append(event)

    runtime = LoopRuntime(
        emit=_emit, request_id="req_x", streaming=streaming
    )
    runtime.phase_events_enabled = phase_events_enabled
    return runtime, captured


def _call(call_id: str = "c1", tool_id: str = "read_file") -> ToolCallRequest:
    return ToolCallRequest(
        tool_id=tool_id,
        arguments={"path": "a.py"},
        call_id=call_id,
    )


class _FakeOutcome:
    def __init__(
        self, *, tool_name: str = "read_file", success: bool = True
    ) -> None:
        self.tool_name = tool_name
        self.output = "ok"
        self.success = success
        self.tool_input = {"path": "a.py"}
        self.content_type = "text/plain"
        self.ui_payload = None
        self.generated_artifacts = ()
        self.error_code = ""
        self.metadata = None


def test_emit_tool_executing_emits_event_with_arguments() -> None:
    runtime, captured = _make_runtime()
    call = _call()
    call_id = emit_tool_executing(runtime, call, "req_x", index=0)
    assert call_id == "c1"
    assert len(captured) == 1
    event = captured[0]
    assert isinstance(event, ToolExecutingEvent)
    assert event.call_id == "c1"
    assert event.tool_name == "read_file"
    assert event.arguments == {"path": "a.py"}


def test_emit_tool_executing_with_phase_events_emits_phase_started() -> None:
    runtime, captured = _make_runtime(phase_events_enabled=True)
    call = _call()
    emit_tool_executing(runtime, call, "req_x", index=0)
    assert len(captured) == 2
    assert isinstance(captured[0], PhaseStartedEvent)
    assert captured[0].phase_kind == "tool_use"
    assert isinstance(captured[1], ToolExecutingEvent)


def test_emit_tool_result_emits_tool_result_event() -> None:
    runtime, captured = _make_runtime()
    emit_tool_result(runtime, _FakeOutcome(), call_id="c1")
    assert len(captured) == 1
    event = captured[0]
    assert isinstance(event, ToolResultEvent)
    assert event.call_id == "c1"
    assert event.tool_name == "read_file"
    assert event.success is True


def test_emit_stream_reset_for_retry_clears_token_marker() -> None:
    runtime, captured = _make_runtime(streaming=True)
    streamed: set[str] = {"chat.token", "chat.thinking"}
    emit_stream_reset_for_retry(runtime, streamed)
    assert len(captured) == 1
    assert isinstance(captured[0], StreamResetEvent)
    assert captured[0].reason == ""
    assert "chat.token" not in streamed
    assert "chat.stream_reset" in streamed
    assert "chat.thinking" in streamed


def test_emit_stream_reset_for_retry_forwards_reason() -> None:
    runtime, captured = _make_runtime(streaming=True)
    streamed: set[str] = {"chat.token"}
    emit_stream_reset_for_retry(runtime, streamed, reason="tool_continuation")
    assert len(captured) == 1
    assert isinstance(captured[0], StreamResetEvent)
    assert captured[0].reason == "tool_continuation"


def test_pre_dispatch_emit_executing_emits_one_event_per_call() -> None:
    runtime, captured = _make_runtime()
    calls = (_call("c1", "read_file"), _call("c2", "glob_files"))
    pre_dispatch_emit_executing(
        runtime=runtime, tool_calls=calls, request_id="req_x"
    )
    assert len(captured) == 2
    assert all(isinstance(e, ToolExecutingEvent) for e in captured)
    assert [e.call_id for e in captured] == ["c1", "c2"]


def test_pre_dispatch_emit_executing_records_call_ids_on_runtime() -> None:
    runtime, _captured = _make_runtime()
    calls = (_call("c1"), _call("c2"))
    pre_dispatch_emit_executing(
        runtime=runtime, tool_calls=calls, request_id="req_x"
    )
    assert runtime.pre_dispatch_emitted_call_ids == {"c1", "c2"}


def test_pre_dispatch_then_in_loop_emit_does_not_double_emit() -> None:
    runtime, captured = _make_runtime()
    call = _call("c1")
    pre_dispatch_emit_executing(
        runtime=runtime, tool_calls=(call,), request_id="req_x"
    )
    # Simulate the in-loop call site (sequential dispatch path).
    returned = emit_tool_executing(runtime, call, "req_x", index=0)
    assert returned == "c1"  # caller still gets the call_id back
    # Only the pre-dispatch event should be in captured.
    assert len(captured) == 1
    assert isinstance(captured[0], ToolExecutingEvent)


def test_pre_dispatch_emit_executing_swallows_emit_failures() -> None:
    """A failing emit must not raise out of pre_dispatch_emit_executing."""
    failures: list[str] = []

    def _bad_emit(event: LoopEvent) -> None:
        failures.append("called")
        raise RuntimeError("boom")

    runtime = LoopRuntime(emit=_bad_emit, request_id="req_x", streaming=True)
    runtime.phase_events_enabled = False
    calls = (_call("c1"), _call("c2"))
    # No exception expected.
    pre_dispatch_emit_executing(
        runtime=runtime, tool_calls=calls, request_id="req_x"
    )
    assert len(failures) == 2  # both calls were attempted


def test_pre_dispatch_emit_executing_no_op_for_empty_tool_calls() -> None:
    runtime, captured = _make_runtime()
    pre_dispatch_emit_executing(
        runtime=runtime, tool_calls=(), request_id="req_x"
    )
    assert captured == []
    assert runtime.pre_dispatch_emitted_call_ids == set()


def test_pre_dispatch_emitted_set_is_per_runtime_instance() -> None:
    """Each fresh LoopRuntime gets its own emitted set; no leakage."""
    runtime_a, _ = _make_runtime()
    runtime_b, _ = _make_runtime()
    pre_dispatch_emit_executing(
        runtime=runtime_a, tool_calls=(_call("c1"),), request_id="req_x"
    )
    assert runtime_a.pre_dispatch_emitted_call_ids == {"c1"}
    assert runtime_b.pre_dispatch_emitted_call_ids == set()


# ---------------------------------------------------------------------------
# Phase 6 Q19: emit_interrupted_results_for_pending_calls audits a
# ``tool_execution_failed`` row so the Electron promotion bridge can
# promote the synthetic outcome into ``payload.promoted_observations``.
# ---------------------------------------------------------------------------


def test_emit_interrupted_results_for_pending_calls_audits_observation() -> None:
    captured: list[LoopEvent] = []
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_orphan")
    runtime = LoopRuntime(
        emit=captured.append,
        request_id="req_orphan",
        streaming=True,
        observation_store=store,
    )
    runtime.record_tool_executing(
        call_id="call-pending",
        tool_name="inspect_harness",
        arguments={"q": "x"},
    )

    class _InterruptedOutcome:
        def __init__(self) -> None:
            self.tool_name = "inspect_harness"
            self.output = "interrupted"
            self.success = False
            self.tool_input = {"q": "x"}
            self.content_type = "text/plain"
            self.ui_payload = None
            self.generated_artifacts = ()
            self.error_code = "CMP-LOOP-0013"
            self.metadata = {"interrupted": True}

    def _factory(_record: dict[str, Any], _output: str) -> Any:
        outcome = _InterruptedOutcome()
        outcome.call_id = "call-pending"
        return outcome

    streamed: set[str] = set()
    settled = emit_interrupted_results_for_pending_calls(
        runtime=runtime,
        outcomes=[],
        streamed_event_types=streamed,
        outcome_factory=_factory,
    )

    assert settled == 1
    audit_events = store.recent_events(request_id="req_orphan", limit=50)
    assert audit_events
    last = audit_events[-1]
    assert last.kind == KIND_TOOL_EXECUTION_FAILED
    assert last.tool_call_id == "call-pending"
    assert last.tool_name == "inspect_harness"
    assert last.error_code == "CMP-LOOP-0013"


def test_build_interrupted_tool_outcome_matches_orphan_settle_contract() -> None:
    """The shared builder is the single source for orphan-settled outcomes."""
    outcome = build_interrupted_tool_outcome(
        {
            "call_id": "call-committed",
            "tool_name": "read_file",
            "arguments": {"path": "a.py"},
        },
        "System error: tool execution interrupted. Retry if needed.",
    )

    assert outcome.call_id == "call-committed"
    assert outcome.tool_name == "read_file"
    assert outcome.success is False
    assert outcome.error_code == CMP_LOOP_TOOL_INTERRUPTED
    assert outcome.tool_input == {"path": "a.py"}
    assert outcome.metadata == {"interrupted": True, "recovery": "orphaned_tool_call"}


def test_build_interrupted_tool_outcome_tolerates_missing_record_fields() -> None:
    """A malformed pending record still yields a well-formed terminal outcome."""
    outcome = build_interrupted_tool_outcome({"call_id": " call-x "}, "stopped")

    assert outcome.call_id == "call-x"
    assert outcome.tool_name == "tool"
    assert outcome.tool_input == {}
    assert outcome.output == "stopped"
