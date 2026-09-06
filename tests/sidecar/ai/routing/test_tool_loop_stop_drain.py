"""Tests for the stop-abort flush helpers in :mod:`sidecar.ai.routing.tool_loop`.

These helpers run when ``StopController`` aborts the tool loop. They surface
buffered preamble content that ``stream_generate_with_tools`` intentionally
held back during a "preamble + tool_calls" iteration, and they cancel any
in-flight tool calls so the backend's ``pendingToolCalls`` map does not
strand them at ``status="running"`` after the abort.
"""

from __future__ import annotations

from sidecar.ai.error_codes import CMP_LOOP_REPEATED_OBSERVATIONS
from sidecar.ai.routing.loop_events import TokenDeltaEvent, ToolResultEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.loop_stop import (
    SUBCODE_GUARDRAIL_ABORTED,
    StopDecision,
    StopReason,
)
from sidecar.ai.routing.tool_loop import (
    CANCEL_REASON_LOOP_ABORTED,
    GUARDRAIL_FOOTER,
    _build_stopped_response_text,
    _drain_unflushed_buffer,
    _emit_pending_tool_cancellations,
    _mark_buffer_flushed,
    flush_unflushed_terminal_output,
)
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore


def _runtime() -> tuple[LoopRuntime, list[object]]:
    events: list[object] = []
    runtime = LoopRuntime(emit=events.append, request_id="req_drain")
    return runtime, events


def test_drain_unflushed_buffer_emits_one_token_per_chunk() -> None:
    runtime, events = _runtime()
    runtime.last_iteration_unflushed = ["Sure, ", "checking ", "the harness."]

    drained = _drain_unflushed_buffer(runtime)

    assert drained == "Sure, checking the harness."
    assert runtime.last_iteration_unflushed == []
    token_events = [e for e in events if isinstance(e, TokenDeltaEvent)]
    assert [e.delta for e in token_events] == ["Sure, ", "checking ", "the harness."]
    # ``token_index`` is 1-based so transcriptCollector callers can reorder.
    assert [e.token_index for e in token_events] == [1, 2, 3]


def test_drain_unflushed_buffer_skips_empty_deltas() -> None:
    runtime, events = _runtime()
    runtime.last_iteration_unflushed = ["", "real content", "", ""]

    drained = _drain_unflushed_buffer(runtime)

    assert drained == "real content"
    token_events = [e for e in events if isinstance(e, TokenDeltaEvent)]
    assert len(token_events) == 1
    assert token_events[0].delta == "real content"
    assert token_events[0].token_index == 1


def test_drain_unflushed_buffer_returns_empty_string_when_buffer_empty() -> None:
    runtime, events = _runtime()
    runtime.last_iteration_unflushed = []

    drained = _drain_unflushed_buffer(runtime)

    assert drained == ""
    assert events == []


def test_terminal_failure_flushes_buffered_output_before_settlement() -> None:
    runtime, events = _runtime()
    runtime.last_iteration_unflushed = ["Partial work", " remains visible."]

    drained = flush_unflushed_terminal_output(runtime, object())

    assert drained == "Partial work remains visible."
    assert runtime.last_iteration_unflushed == []
    assert [event.delta for event in events if isinstance(event, TokenDeltaEvent)] == [
        "Partial work",
        " remains visible.",
    ]


def test_emit_pending_tool_cancellations_emits_one_result_per_call() -> None:
    runtime, events = _runtime()
    calls = (
        ToolCallRequest(tool_id="inspect_harness", arguments={}, call_id="call_a"),
        ToolCallRequest(
            tool_id="mermaid_generate",
            arguments={"diagram_type": "flowchart"},
            call_id="call_b",
        ),
    )

    cancellations = _emit_pending_tool_cancellations(
        runtime,
        tool_calls=calls,
        code=CMP_LOOP_REPEATED_OBSERVATIONS,
        cancel_reason=CANCEL_REASON_LOOP_ABORTED,
    )

    result_events = [e for e in events if isinstance(e, ToolResultEvent)]
    assert len(cancellations) == 2
    assert len(result_events) == 2
    assert {e.tool_name for e in result_events} == {"inspect_harness", "mermaid_generate"}
    for event in result_events:
        assert event.success is False
        assert event.error_code == CMP_LOOP_REPEATED_OBSERVATIONS
        assert event.metadata == {
            "cancel_reason": CANCEL_REASON_LOOP_ABORTED,
            "effects": "none",
            "failure_class": "cancelled",
        }
        assert "cancelled" in event.content.lower()
    # The mermaid call's tool_input is preserved so the renderer can show
    # what the model was about to run.
    mermaid_event = next(e for e in result_events if e.tool_name == "mermaid_generate")
    assert mermaid_event.tool_input == {"diagram_type": "flowchart"}


def test_emit_pending_tool_cancellations_no_op_when_calls_empty() -> None:
    runtime, events = _runtime()

    cancellations = _emit_pending_tool_cancellations(
        runtime,
        tool_calls=(),
        code=CMP_LOOP_REPEATED_OBSERVATIONS,
        cancel_reason=CANCEL_REASON_LOOP_ABORTED,
    )

    assert cancellations == []
    assert events == []


def test_build_stopped_response_text_appends_footer_when_buffer_drained() -> None:
    reason = StopReason(
        decision=StopDecision.STOP,
        message="Same observation kind=... repeated 4 times consecutively.",
        code=CMP_LOOP_REPEATED_OBSERVATIONS,
        subcode=SUBCODE_GUARDRAIL_ABORTED,
    )

    response, completion_source = _build_stopped_response_text(
        reason,
        "Here is the partial answer.",
    )

    assert response.startswith("Here is the partial answer.")
    assert response.endswith(GUARDRAIL_FOOTER.rstrip())
    assert completion_source == "model"
    # Stop-reason message must NOT leak into the visible body when we have
    # the user's actual partial answer to surface.
    assert "Same observation" not in response


def test_build_stopped_response_text_falls_back_to_stop_message_when_buffer_empty() -> None:
    reason = StopReason(
        decision=StopDecision.STOP,
        message="Loop wall-clock limit exceeded.",
        code="CMP_LOOP_WALL_CLOCK_EXCEEDED",
    )

    response, completion_source = _build_stopped_response_text(reason, "")

    assert response == "Loop wall-clock limit exceeded."
    assert completion_source == "deterministic_tool_fallback"


def test_build_stopped_response_text_strips_trailing_whitespace_before_footer() -> None:
    reason = StopReason(
        decision=StopDecision.STOP,
        message="Same observation ... 4 times.",
        code=CMP_LOOP_REPEATED_OBSERVATIONS,
    )

    response, completion_source = _build_stopped_response_text(
        reason,
        "answer with trailing newlines.\n\n\n",
    )

    # No extra blank lines beyond the footer's own leading "\n\n".
    assert response == "answer with trailing newlines." + GUARDRAIL_FOOTER
    assert completion_source == "model"


def test_build_stopped_response_text_prefers_completed_generation_content() -> None:
    reason = StopReason(
        decision=StopDecision.STOP,
        message="Loop guardrail stopped the turn.",
        code=CMP_LOOP_REPEATED_OBSERVATIONS,
    )

    response, completion_source = _build_stopped_response_text(
        reason,
        "buffered preamble",
        "Complete model answer.",
    )

    assert response == "Complete model answer." + GUARDRAIL_FOOTER
    assert completion_source == "model"


def test_mark_buffer_flushed_promotes_disposition_via_engine_store() -> None:
    """When a turn diagnostics store is wired on the kernel's engine, the
    helper marks the buffered-output disposition as ``flushed`` so the
    snapshot reflects that the preamble reached the user.
    """
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_drain", session_id="sess", mode="chat")
    store.record_buffered_visible_output(
        request_id="req_drain",
        text="partial",
        reason="tool_calls",
    )

    class _Engine:
        _turn_diagnostics_store = store

    class _Kernel:
        _engine = _Engine()

    runtime, _events = _runtime()

    assert (
        store.snapshot()["buffered_visible_output_disposition"] == "dropped"
    )

    _mark_buffer_flushed(_Kernel(), runtime)

    assert (
        store.snapshot()["buffered_visible_output_disposition"] == "flushed"
    )


def test_mark_buffer_flushed_no_op_when_engine_has_no_store() -> None:
    class _Engine:
        pass

    class _Kernel:
        _engine = _Engine()

    runtime, _events = _runtime()
    # Must not raise even though no store is wired.
    _mark_buffer_flushed(_Kernel(), runtime)
