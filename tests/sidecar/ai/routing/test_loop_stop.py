from __future__ import annotations

from sidecar.ai.error_codes import (
    CMP_LOOP_BUDGET_EXCEEDED,
    CMP_LOOP_CYCLE_DETECTED,
    CMP_LOOP_REPEATED_OBSERVATIONS,
)
from sidecar.ai.routing.loop_events import StopEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.loop_stop import (
    SUBCODE_GUARDRAIL_ABORTED,
    LoopState,
    StopController,
    StopDecision,
    _tool_call_signature,
)
from sidecar.ai.routing.tool_observation import (
    KIND_TOOL_EXECUTION_OBSERVED,
    KIND_TURN_FAILED,
    ToolObservationEvent,
    ToolObservationStore,
    tool_argument_fingerprint,
)
from sidecar.ai.tools.models import ToolCallRequest


def _call(tool_id: str, **arguments: object) -> ToolCallRequest:
    return ToolCallRequest(
        tool_id=tool_id,
        arguments=arguments or {"path": "notes.txt"},
        call_id=tool_id,
    )


def _controller() -> tuple[StopController, list[object]]:
    events: list[object] = []
    runtime = LoopRuntime(emit=events.append, request_id="req_loop_stop")
    return StopController(runtime=runtime), events


def test_cycle_detection_allows_first_consecutive_repeat() -> None:
    call = _call("read_file", path="a.txt")
    signature = (_tool_call_signature(call),)
    controller, events = _controller()

    reason = controller.evaluate(
        LoopState(
            iteration=2,
            max_iterations=8,
            elapsed_seconds=0.1,
            last_tool_calls=(call,),
            tool_call_history=(signature,),
        )
    )

    assert reason is None
    assert events == []


def test_cycle_detection_allows_two_consecutive_identical_batches() -> None:
    """Regression: write -> read -> identical read must NOT stop the turn.

    The runner advances ``tool_call_history`` after execution, so at the
    next preflight ``last_tool_calls`` equals ``history[-1]``: two window
    entries mean exactly two real executions. Small local models routinely
    re-read a file they just wrote; the guardrail intervenes at three.
    """
    call = _call("read_file", path="a.txt")
    signature = (_tool_call_signature(call),)
    other = (_tool_call_signature(_call("write_file", path="a.txt")),)
    controller, events = _controller()

    reason = controller.evaluate(
        LoopState(
            iteration=3,
            max_iterations=8,
            elapsed_seconds=0.2,
            last_tool_calls=(call,),
            tool_call_history=(other, signature, signature),
        )
    )

    assert reason is None
    assert events == []


def test_cycle_detection_degrades_on_three_consecutive_repeats_with_user_hint() -> None:
    """First detection of a three-execution repeat is recoverable: DEGRADE
    with a summarize hint, and no terminal StopEvent is emitted (the runner
    pauses tools and the turn continues to a graceful finish)."""
    call = _call("read_file", path="a.txt")
    signature = (_tool_call_signature(call),)
    controller, events = _controller()

    reason = controller.evaluate(
        LoopState(
            iteration=4,
            max_iterations=8,
            elapsed_seconds=0.3,
            last_tool_calls=(call,),
            tool_call_history=(signature, signature, signature),
        )
    )

    assert reason is not None
    assert reason.decision is StopDecision.DEGRADE
    assert reason.code == CMP_LOOP_CYCLE_DETECTED
    assert reason.user_hint
    assert events == []


def test_cycle_detection_stops_after_hint_already_attempted() -> None:
    """Once the one-per-turn cycle hint is spent, a repeat detection is a
    terminal STOP and emits the StopEvent for downstream promotion."""
    call = _call("read_file", path="a.txt")
    signature = (_tool_call_signature(call),)
    controller, events = _controller()

    reason = controller.evaluate(
        LoopState(
            iteration=5,
            max_iterations=8,
            elapsed_seconds=0.4,
            last_tool_calls=(call,),
            tool_call_history=(signature, signature, signature),
            cycle_hint_attempted=True,
        )
    )

    assert reason is not None
    assert reason.decision is StopDecision.STOP
    assert reason.code == CMP_LOOP_CYCLE_DETECTED
    assert len(events) == 1
    assert isinstance(events[0], StopEvent)
    assert events[0].code == CMP_LOOP_CYCLE_DETECTED
    assert events[0].user_hint == reason.user_hint


def test_cycle_detection_allows_short_alternating_window() -> None:
    """A/B/A (compare two files, re-check the first) is a legitimate
    pattern and must not trip the guardrail; only three full A/B rounds
    count as pathological alternation."""
    call_a = _call("read_file", path="a.txt")
    call_b = _call("grep_search", query="needle")
    signature_a = (_tool_call_signature(call_a),)
    signature_b = (_tool_call_signature(call_b),)
    controller, events = _controller()

    reason = controller.evaluate(
        LoopState(
            iteration=3,
            max_iterations=8,
            elapsed_seconds=0.2,
            last_tool_calls=(call_a,),
            tool_call_history=(signature_a, signature_b, signature_a),
        )
    )

    assert reason is None
    assert events == []


def test_cycle_detection_degrades_on_three_full_alternating_rounds() -> None:
    """A,B,A,B,A,B over six executions is pathological alternation. The
    semantic detector cannot see it (observation signatures exclude args
    and real streams interleave several observation kinds per call), so
    the syntactic detector owns it — DEGRADE-first like exact repeats."""
    call_a = _call("read_file", path="a.txt")
    call_b = _call("read_file", path="b.txt")
    signature_a = (_tool_call_signature(call_a),)
    signature_b = (_tool_call_signature(call_b),)
    controller, events = _controller()

    reason = controller.evaluate(
        LoopState(
            iteration=7,
            max_iterations=12,
            elapsed_seconds=0.6,
            last_tool_calls=(call_b,),
            tool_call_history=(
                signature_a,
                signature_b,
                signature_a,
                signature_b,
                signature_a,
                signature_b,
            ),
        )
    )

    assert reason is not None
    assert reason.decision is StopDecision.DEGRADE
    assert reason.code == CMP_LOOP_CYCLE_DETECTED
    assert "alternated" in reason.user_hint
    assert events == []


def test_cycle_detection_allows_non_repeating_window() -> None:
    call_a = _call("read_file", path="a.txt")
    call_b = _call("grep_search", query="needle")
    call_c = _call("glob_files", pattern="*.py")
    signature_a = (_tool_call_signature(call_a),)
    signature_b = (_tool_call_signature(call_b),)
    signature_c = (_tool_call_signature(call_c),)
    controller, events = _controller()

    reason = controller.evaluate(
        LoopState(
            iteration=3,
            max_iterations=8,
            elapsed_seconds=0.2,
            last_tool_calls=(call_c,),
            tool_call_history=(signature_a, signature_b, signature_c),
        )
    )

    assert reason is None
    assert events == []


def test_cycle_detection_degrades_on_repeated_error_output_with_user_hint() -> None:
    controller, events = _controller()

    reason = controller.evaluate(
        LoopState(
            iteration=3,
            max_iterations=8,
            elapsed_seconds=0.2,
            last_error_output="permission denied",
            error_output_history=("permission denied", "permission denied"),
        )
    )

    assert reason is not None
    assert reason.decision is StopDecision.DEGRADE
    assert reason.code == CMP_LOOP_CYCLE_DETECTED
    assert reason.user_hint
    assert events == []


def test_cycle_detection_stops_repeated_error_output_after_hint_attempted() -> None:
    controller, events = _controller()

    reason = controller.evaluate(
        LoopState(
            iteration=4,
            max_iterations=8,
            elapsed_seconds=0.3,
            last_error_output="permission denied",
            error_output_history=("permission denied", "permission denied"),
            cycle_hint_attempted=True,
        )
    )

    assert reason is not None
    assert reason.decision is StopDecision.STOP
    assert reason.code == CMP_LOOP_CYCLE_DETECTED
    assert isinstance(events[0], StopEvent)
    assert events[0].user_hint == reason.user_hint


# ---------------------------------------------------------------------------
# Phase 6 — semantic stuck-loop detector hook
# ---------------------------------------------------------------------------


def _semantic_controller(
    store: ToolObservationStore,
) -> tuple[StopController, list[object]]:
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_loop_stop",
        observation_store=store,
    )
    return (
        StopController(runtime=runtime, observation_store=store),
        events,
    )


def test_semantic_detector_degrades_before_stopping() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_loop_stop")
    fingerprint = tool_argument_fingerprint({"path": "README.md"})
    for _ in range(4):
        store.record(
            ToolObservationEvent(
                kind=KIND_TOOL_EXECUTION_OBSERVED,
                request_id="req_loop_stop",
                tool_name="read_file",
                summary="read_file path=README.md",
                _argument_fingerprint=fingerprint,
            )
        )
    controller, events = _semantic_controller(store)

    # Tool call signatures differ each iteration; syntactic detector misses.
    diverse_signatures = (
        (_tool_call_signature(_call("read_file", path="a.txt")),),
        (_tool_call_signature(_call("read_file", path="b.txt")),),
        (_tool_call_signature(_call("read_file", path="c.txt")),),
    )
    reason = controller.evaluate(
        LoopState(
            iteration=4,
            max_iterations=8,
            elapsed_seconds=0.4,
            last_tool_calls=(_call("read_file", path="d.txt"),),
            tool_call_history=diverse_signatures,
        )
    )

    assert reason is not None
    assert reason.code == CMP_LOOP_REPEATED_OBSERVATIONS
    assert reason.decision is StopDecision.DEGRADE
    assert "pausing tools" in reason.message
    assert events == []
    audit_events = store.recent_events(request_id="req_loop_stop", limit=50)
    assert all(event.kind != KIND_TURN_FAILED for event in audit_events)


def test_semantic_detector_ignores_stale_window_after_degrade_hint() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_loop_stop")
    fingerprint = tool_argument_fingerprint({"path": "README.md"})
    for _ in range(4):
        store.record(
            ToolObservationEvent(
                kind=KIND_TOOL_EXECUTION_OBSERVED,
                request_id="req_loop_stop",
                tool_name="read_file",
                _argument_fingerprint=fingerprint,
            )
        )
    controller, events = _semantic_controller(store)
    first = controller.evaluate(LoopState(iteration=4, max_iterations=8, elapsed_seconds=0.4))
    assert first is not None and first.decision is StopDecision.DEGRADE

    second = controller.evaluate(
        LoopState(
            iteration=5,
            max_iterations=8,
            elapsed_seconds=0.5,
            cycle_hint_attempted=True,
        )
    )
    assert second is None
    assert events == []


def test_semantic_detector_stops_only_after_new_post_hint_repetition() -> None:
    store = ToolObservationStore(max_events_per_turn=20)
    store.ensure_turn(request_id="req_loop_stop")
    fingerprint = tool_argument_fingerprint({"path": "README.md"})
    for _ in range(4):
        store.record(
            ToolObservationEvent(
                kind=KIND_TOOL_EXECUTION_OBSERVED,
                request_id="req_loop_stop",
                tool_name="read_file",
                _argument_fingerprint=fingerprint,
            )
        )
    controller, events = _semantic_controller(store)
    first = controller.evaluate(LoopState(iteration=4, max_iterations=10, elapsed_seconds=0.4))
    assert first is not None and first.decision is StopDecision.DEGRADE
    for _ in range(4):
        store.record(
            ToolObservationEvent(
                kind=KIND_TOOL_EXECUTION_OBSERVED,
                request_id="req_loop_stop",
                tool_name="read_file",
                _argument_fingerprint=fingerprint,
            )
        )

    second = controller.evaluate(
        LoopState(
            iteration=6,
            max_iterations=10,
            elapsed_seconds=0.6,
            cycle_hint_attempted=True,
        )
    )
    assert second is not None and second.decision is StopDecision.STOP
    assert isinstance(events[-1], StopEvent)
    assert events[-1].subcode == SUBCODE_GUARDRAIL_ABORTED
    audit_events = store.recent_events(request_id="req_loop_stop", limit=50)
    assert audit_events[-1].kind == KIND_TURN_FAILED


def test_existing_cycle_detection_still_fires_first() -> None:
    """When both syntactic and semantic detectors would fire, the
    syntactic ``CMP_LOOP_CYCLE_DETECTED`` wins (regression guard)."""
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_loop_stop")
    for _ in range(4):
        store.record(
            ToolObservationEvent(
                kind=KIND_TOOL_EXECUTION_OBSERVED,
                request_id="req_loop_stop",
                tool_name="read_file",
                summary="repeat",
                _argument_fingerprint=tool_argument_fingerprint({"path": "a.txt"}),
            )
        )
    controller, _events = _semantic_controller(store)

    call = _call("read_file", path="a.txt")
    signature = (_tool_call_signature(call),)
    reason = controller.evaluate(
        LoopState(
            iteration=4,
            max_iterations=8,
            elapsed_seconds=0.4,
            last_tool_calls=(call,),
            tool_call_history=(signature, signature, signature),
        )
    )

    assert reason is not None
    assert reason.code == CMP_LOOP_CYCLE_DETECTED
    assert reason.decision is StopDecision.DEGRADE

    after_hint = controller.evaluate(
        LoopState(
            iteration=5,
            max_iterations=8,
            elapsed_seconds=0.5,
            cycle_hint_attempted=True,
        )
    )
    assert after_hint is None


def test_evaluate_without_observation_store_skips_semantic_check() -> None:
    """When ``observation_store`` is None the semantic check is a no-op."""
    controller, events = _controller()
    reason = controller.evaluate(
        LoopState(
            iteration=1,
            max_iterations=8,
            elapsed_seconds=0.0,
        )
    )
    assert reason is None
    assert events == []


def test_semantic_detector_swallows_store_exception() -> None:
    """A faulty store must not break the loop — diagnostic-only behavior."""

    class _FaultyStore(ToolObservationStore):
        def recent_events(self, **_: object) -> tuple[ToolObservationEvent, ...]:
            raise RuntimeError("boom")

    store = _FaultyStore()
    controller, events = _semantic_controller(store)
    reason = controller.evaluate(
        LoopState(
            iteration=1,
            max_iterations=8,
            elapsed_seconds=0.0,
        )
    )
    assert reason is None
    assert events == []


# ---------------------------------------------------------------------------
# guardrail_aborted subcode plumbing
# ---------------------------------------------------------------------------


def test_semantic_detector_carries_guardrail_aborted_subcode() -> None:
    """The recoverable semantic reason retains its terminal classification."""
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_loop_stop")
    for _ in range(4):
        store.record(
            ToolObservationEvent(
                kind=KIND_TOOL_EXECUTION_OBSERVED,
                request_id="req_loop_stop",
                tool_name="read_file",
                summary="repeat",
                _argument_fingerprint="same-args",
            )
        )
    controller, events = _semantic_controller(store)

    reason = controller.evaluate(
        LoopState(
            iteration=4,
            max_iterations=8,
            elapsed_seconds=0.4,
            last_tool_calls=(_call("read_file", path="d.txt"),),
            tool_call_history=(),
        )
    )

    assert reason is not None
    assert reason.subcode == SUBCODE_GUARDRAIL_ABORTED
    assert reason.decision is StopDecision.DEGRADE
    assert events == []


def test_syntactic_cycle_detector_does_not_set_subcode() -> None:
    """The cycle detector pre-dates subcodes; it must not accidentally tag a
    cycle/repetition stop with ``guardrail_aborted`` (which would drive the
    "stopped early because the model was looping" footer for the wrong reason).
    """
    call = _call("read_file", path="a.txt")
    signature = (_tool_call_signature(call),)
    events: list[object] = []
    runtime = LoopRuntime(emit=events.append, request_id="req_loop_stop")
    controller = StopController(runtime=runtime)

    reason = controller.evaluate(
        LoopState(
            iteration=4,
            max_iterations=8,
            elapsed_seconds=0.3,
            last_tool_calls=(call,),
            tool_call_history=(signature, signature, signature),
            cycle_hint_attempted=True,
        )
    )

    assert reason is not None
    assert reason.code == CMP_LOOP_CYCLE_DETECTED
    assert reason.subcode is None
    assert isinstance(events[-1], StopEvent)
    assert events[-1].subcode is None


# ---------------------------------------------------------------------------
# Phase 6 Q19 audit emission for syntactic stops (so the Electron promotion
# bridge can promote ``budget.exceeded`` / ``agent.stopped_due_to_loop``).
# ---------------------------------------------------------------------------


def test_syntactic_cycle_stop_audits_turn_failed_observation() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_loop_stop")
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_loop_stop",
        observation_store=store,
    )
    controller = StopController(runtime=runtime, observation_store=store)
    call = _call("read_file", path="a.txt")
    signature = (_tool_call_signature(call),)

    reason = controller.evaluate(
        LoopState(
            iteration=4,
            max_iterations=8,
            elapsed_seconds=0.3,
            last_tool_calls=(call,),
            tool_call_history=(signature, signature, signature),
            cycle_hint_attempted=True,
        )
    )

    assert reason is not None
    assert reason.decision is StopDecision.STOP
    assert reason.code == CMP_LOOP_CYCLE_DETECTED
    audit_events = store.recent_events(request_id="req_loop_stop", limit=50)
    assert audit_events
    last = audit_events[-1]
    assert last.kind == KIND_TURN_FAILED
    assert last.error_code == CMP_LOOP_CYCLE_DETECTED


def test_recoverable_cycle_degrade_does_not_audit_turn_failed() -> None:
    """A DEGRADE detection continues the turn, so no ``turn_failed`` row may
    reach the observation store — the Q19 promotion bridge would otherwise
    surface an error card for a turn that finished gracefully."""
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_loop_stop")
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_loop_stop",
        observation_store=store,
    )
    controller = StopController(runtime=runtime, observation_store=store)
    call = _call("read_file", path="a.txt")
    signature = (_tool_call_signature(call),)

    reason = controller.evaluate(
        LoopState(
            iteration=4,
            max_iterations=8,
            elapsed_seconds=0.3,
            last_tool_calls=(call,),
            tool_call_history=(signature, signature, signature),
        )
    )

    assert reason is not None
    assert reason.decision is StopDecision.DEGRADE
    assert events == []
    audit_events = store.recent_events(request_id="req_loop_stop", limit=50)
    assert all(event.kind != KIND_TURN_FAILED for event in audit_events)


def test_syntactic_budget_stop_audits_turn_failed_observation() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_loop_stop")
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_loop_stop",
        observation_store=store,
    )
    controller = StopController(
        runtime=runtime,
        max_budget_usd=0.001,
        observation_store=store,
    )

    reason = controller.evaluate(
        LoopState(
            iteration=2,
            max_iterations=8,
            elapsed_seconds=0.1,
            provider_cost_usd=1.0,
            completed_generations=1,
            phase="post_generation",
        )
    )

    assert reason is not None
    assert reason.code == CMP_LOOP_BUDGET_EXCEEDED
    audit_events = store.recent_events(request_id="req_loop_stop", limit=50)
    assert audit_events
    last = audit_events[-1]
    assert last.kind == KIND_TURN_FAILED
    assert last.error_code == CMP_LOOP_BUDGET_EXCEEDED


def test_cloud_budget_without_provider_cost_warns_once_and_never_guesses(caplog) -> None:
    runtime = LoopRuntime(request_id="req_budget_unknown", provider_cost_expected=True)
    controller = StopController(
        runtime=runtime,
        max_budget_usd=0.001,
    )
    state = LoopState(
        iteration=2,
        max_iterations=8,
        elapsed_seconds=0.1,
        provider_cost_usd=None,
        completed_generations=1,
        phase="post_generation",
    )

    assert controller.evaluate(state) is None
    assert controller.evaluate(state) is None
    matching = [
        record for record in caplog.records
        if "configured max_budget_usd cannot be evaluated" in record.getMessage()
    ]
    assert len(matching) == 1


def test_tool_call_signature_ignores_system_metadata() -> None:
    call1 = _call(
        "read_file",
        path="a.txt",
        session_id="session-123",
        request_id="req-abc",
        trace_id="trace-xyz",
        tool_call_id="call-foo",
        api_version="1.0.0",
        _jenny_session_id="jenny-456",
        _any_other_internal="some-internal",
    )
    call2 = _call(
        "read_file",
        path="a.txt",
        session_id="session-789",
        request_id="req-def",
        trace_id="trace-uvw",
        tool_call_id="call-bar",
        api_version="2.0.0",
        _jenny_session_id="jenny-999",
        _any_other_internal="different-internal",
    )

    sig1 = _tool_call_signature(call1)
    sig2 = _tool_call_signature(call2)

    assert sig1 == sig2

    call3 = _call("read_file", path="b.txt")
    sig3 = _tool_call_signature(call3)
    assert sig1 != sig3
