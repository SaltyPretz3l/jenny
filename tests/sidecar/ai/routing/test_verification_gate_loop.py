"""End-to-end verification-gate behaviour through the real tool loop.

``test_verification_gate.py`` covers the gate module in isolation. This file
drives ``ChatRouter.build_chat_decision`` -- the actual loop -- because the one
property that must never regress is a property of the *turn*, not of the module:

    a gate failure, an exhausted retry cap, a held single-run lock, and a
    bridge explosion must ALL still produce a completed turn with a final
    response.

It also pins the carve-out arithmetic: the gate's retry iteration must come from
its own allowance, so a model that spent every one of its 8 iterations still gets
a gate retry, and a gate that does not need its grant must hand it back rather
than leaving the model with extra slack.
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing import verification_gate as _gate
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.routing.tool_loop_finalize import _FinalResponseMixin
from sidecar.ai.routing.tool_loop_run import _ToolLoopRun
from sidecar.ai.routing.verification_gate import VERIFICATION_GATE_FLAG
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from tests.sidecar.ai.routing.test_tool_loop import (
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

_REQUEST_ID = "req_verification_gate"


def _edit_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="edit_file",
        description="Edit a file",
        input_schema={
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
            },
            "required": ["file_path", "old_string", "new_string"],
        },
        side_effecting=True,
        server_name="tools",
        tool_family="filesystem",
    )


def _build_gate_router(
    engine: _ToolLoopEngine,
    *,
    gate_enabled: bool = True,
    verify_enabled: bool = True,
    mcp_success: bool = True,
) -> ChatRouter:
    config = RuntimeConfig(
        engine_type="ollama",
        model="qwen",
        tools_workspace_root="C:/workspace",
    )
    config = replace(
        config,
        mode="assist",
        feature_flags={VERIFICATION_GATE_FLAG: gate_enabled},
        tools_verify_enabled=verify_enabled,
    )
    router = ChatRouter(
        config=config,
        engine=engine,
        mcp_client=_StubMCPClient((_edit_descriptor(),), success=mcp_success),
        context_builder=ContextBuilder(None),
    )
    router.set_harness_snapshot_provider(
        lambda **_kwargs: {
            "tools": {"items": [{"name": "edit_file", "display_name": "Edit", "enabled": True}]}
        }
    )
    return router


def _edit_then_answer(*answers: str) -> _ToolLoopEngine:
    """One edit_file call, then one final answer per extra generation."""
    plans = [
        _ToolPlan(
            result=GenerationResult(
                content="",
                tool_calls=(
                    ToolCallRequest(
                        tool_id="edit_file",
                        call_id="call_edit",
                        arguments={
                            "file_path": "src/widget.js",
                            "old_string": "before",
                            "new_string": "after",
                        },
                    ),
                ),
            )
        )
    ]
    plans.extend(
        _ToolPlan(result=GenerationResult(content=answer, finish_reason="stop"))
        for answer in answers
    )
    return _ToolLoopEngine(plans=plans)


def _decide(router: ChatRouter, *, max_iterations: int = 4, has_writer: bool = True):
    return router.build_chat_decision(
        request_id=_REQUEST_ID,
        messages=[{"role": "user", "content": "fix the widget"}],
        latest_user_content="fix the widget",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=lambda _e: None,
            request_id=_REQUEST_ID,
            max_iterations=max_iterations,
            electron_tool_writer=(lambda _m: None) if has_writer else None,
        ),
    )


def _gate_result(metadata, *, output=""):
    return SimpleNamespace(metadata=metadata, output=output, success=True)


# ---------------------------------------------------------------------------
# THE INVARIANT: the turn always completes
# ---------------------------------------------------------------------------


def test_a_failing_gate_still_completes_the_turn(monkeypatch):
    # The gate fails, the model gets one carve-out retry, and its second answer
    # is what the user sees. A completed turn, not a failure.
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _gate_result(
            {"status": "failed", "gate_on_failure": "retry"},
            output="AssertionError: widget is undefined",
        ),
    )
    engine = _edit_then_answer("Done, fixed it.", "Actually the test still fails.")
    decision = _decide(_build_gate_router(engine))

    assert decision.response_text
    assert "Actually the test still fails." in decision.response_text


def test_cap_exhaustion_still_completes_the_turn(monkeypatch):
    # The gate keeps failing. After the cap it must stop retrying and let the
    # answer through with an honest note -- never loop, never fail the turn.
    gate_runs = []

    def _failing_gate(_request):
        gate_runs.append(_request)
        return _gate_result(
            {"status": "failed", "gate_on_failure": "retry"}, output="FAIL widget.test.js"
        )

    monkeypatch.setattr(_gate, "execute_electron_tool", _failing_gate)
    engine = _edit_then_answer("First answer.", "Second answer.", "Third answer.")
    decision = _decide(_build_gate_router(engine))

    assert decision.response_text
    assert "Second answer." in decision.response_text
    assert "did not pass" in decision.response_text
    # The note tells the truth about how hard it tried: two gate runs.
    assert "after 2 attempts" in decision.response_text
    # ...and the second gate run was labelled attempt 2 for the panel.
    assert [dict(request.arguments) for request in gate_runs] == [
        {"action": "gate", "attempt": 1},
        {"action": "gate", "attempt": 2},
    ]
    # Exactly one retry: the first generation is the tool call, then two answers.
    assert engine.call_count == 3
    # ...and exactly two gate runs. The attempt counter is what stops a third:
    # running the user's whole suite again to say the same thing is pure latency.
    assert len(gate_runs) == 2


def test_a_bridge_explosion_still_completes_the_turn(monkeypatch):
    def _boom(_request):
        raise MCPError(code="CMP-TOOL-0001", message="bridge exploded", retryable=False)

    monkeypatch.setattr(_gate, "execute_electron_tool", _boom)
    engine = _edit_then_answer("Done, fixed it.")
    decision = _decide(_build_gate_router(engine))

    assert "Done, fixed it." in decision.response_text
    assert "unverified" in decision.response_text


def test_a_held_single_run_lock_still_completes_the_turn(monkeypatch):
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _gate_result({"status": "skipped", "reason": "already_running"}),
    )
    engine = _edit_then_answer("Done, fixed it.")
    decision = _decide(_build_gate_router(engine))

    assert "Done, fixed it." in decision.response_text
    assert "unverified" in decision.response_text


def test_report_only_mode_annotates_without_retrying(monkeypatch):
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _gate_result(
            {"status": "failed", "gate_on_failure": "report"}, output="FAIL widget"
        ),
    )
    engine = _edit_then_answer("Done, fixed it.")
    decision = _decide(_build_gate_router(engine))

    assert "Done, fixed it." in decision.response_text
    assert "did not pass" in decision.response_text
    # No retry generation was consumed.
    assert engine.call_count == 2


# ---------------------------------------------------------------------------
# The gate stays out of the way
# ---------------------------------------------------------------------------


def test_a_passing_gate_leaves_the_response_untouched(monkeypatch):
    monkeypatch.setattr(
        _gate, "execute_electron_tool", lambda _r: _gate_result({"status": "passed"})
    )
    engine = _edit_then_answer("Done, fixed it.")
    decision = _decide(_build_gate_router(engine))

    assert decision.response_text == "Done, fixed it."


def test_no_designated_gate_leaves_the_response_untouched(monkeypatch):
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _gate_result({"status": "skipped", "reason": "no_gate_configured"}),
    )
    engine = _edit_then_answer("Done, fixed it.")
    decision = _decide(_build_gate_router(engine))

    assert decision.response_text == "Done, fixed it."


@pytest.mark.parametrize(
    ("gate_enabled", "verify_enabled", "why"),
    [
        (False, True, "gate flag off"),
        (True, False, "verify tool not registered"),
    ],
)
def test_the_gate_never_calls_the_bridge_when_disabled(
    monkeypatch, gate_enabled, verify_enabled, why
):
    calls = []
    monkeypatch.setattr(_gate, "execute_electron_tool", calls.append)
    engine = _edit_then_answer("Done, fixed it.")
    decision = _decide(
        _build_gate_router(engine, gate_enabled=gate_enabled, verify_enabled=verify_enabled)
    )

    assert decision.response_text == "Done, fixed it.", why
    assert calls == [], why


def test_a_read_only_turn_never_calls_the_bridge(monkeypatch):
    calls = []
    monkeypatch.setattr(_gate, "execute_electron_tool", calls.append)
    engine = _ToolLoopEngine(
        plans=[_ToolPlan(result=GenerationResult(content="Here you go.", finish_reason="stop"))]
    )
    decision = _decide(_build_gate_router(engine))

    assert decision.response_text == "Here you go."
    assert calls == []


def test_a_refused_mutation_never_calls_the_bridge(monkeypatch):
    # edit_file failed, so nothing changed and there is nothing to verify.
    calls = []
    monkeypatch.setattr(_gate, "execute_electron_tool", calls.append)
    engine = _edit_then_answer("I could not apply that edit.")
    decision = _decide(_build_gate_router(engine, mcp_success=False))

    assert decision.response_text
    assert calls == []


def test_a_headless_runtime_leaves_the_response_untouched():
    # No electron_tool_writer: the gate cannot run and must say nothing.
    engine = _edit_then_answer("Done, fixed it.")
    decision = _decide(_build_gate_router(engine), has_writer=False)

    assert decision.response_text == "Done, fixed it."


# ---------------------------------------------------------------------------
# Carve-out arithmetic
# ---------------------------------------------------------------------------


def test_the_retry_does_not_come_from_the_models_budget(monkeypatch):
    """A model that spent every iteration still gets its gate retry.

    max_iterations=2 is exactly consumed by the edit call plus the first answer,
    so without the carve-out the loop would fall out of its range and end in
    ``max_iterations_summary``.

    Counting generations is NOT enough to prove this: the wind-down summary runs
    a generation of its own, so an eagerly-bound loop consumes exactly the same
    number of plans and returns the same text. The real signal is what the third
    generation WAS -- a tool-capable loop iteration carrying the gate's feedback
    as the newest message, versus a tools-stripped wind-down whose newest message
    is the iteration-limit system prompt.
    """
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _gate_result(
            {"status": "failed", "gate_on_failure": "retry"}, output="FAIL widget"
        ),
    )
    engine = _edit_then_answer("Done, fixed it.", "Fixed for real this time.")
    decision = _decide(_build_gate_router(engine), max_iterations=2)

    assert "Fixed for real this time." in decision.response_text
    assert engine.call_count == 3, "the carve-out bought a third generation"

    third = engine.requests[2]
    assert third.get("tools"), "the carve-out iteration must still be tool-capable"
    newest = third["messages"][-1]
    assert newest["role"] == "user", "a wind-down would append a system message"
    assert "Verification did not pass" in newest["content"]


def test_an_unused_grant_is_handed_back(monkeypatch):
    """A passing gate must not leave the model holding an extra iteration.

    The grant is taken before the gate runs (so "can I retry?" is answered by
    real capacity), which means a gate that passes has to give it back.
    """
    captured = {}
    original = _ToolLoopRun.grant_gate_iteration

    def _spy(self):
        granted = original(self)
        captured["after_grant"] = (self.max_iterations, self.gate_iterations_granted)
        return granted

    monkeypatch.setattr(_ToolLoopRun, "grant_gate_iteration", _spy)
    monkeypatch.setattr(
        _gate, "execute_electron_tool", lambda _r: _gate_result({"status": "passed"})
    )
    engine = _edit_then_answer("Done, fixed it.")
    _decide(_build_gate_router(engine), max_iterations=4)

    assert captured["after_grant"] == (5, 1), "the grant widened the budget"
    # And the loop stopped at the model's own budget: only two generations ran.
    assert engine.call_count == 2


def test_grant_gate_iteration_is_capped():
    run = SimpleNamespace(
        gate_iterations_granted=0,
        max_iterations=8,
        iteration_total=8,
    )
    assert _ToolLoopRun.grant_gate_iteration(run) is True
    assert (run.max_iterations, run.iteration_total) == (9, 9)
    # Cap: GATE_MAX_RETRIES is 1, so a second ask is refused and nothing moves.
    assert _ToolLoopRun.grant_gate_iteration(run) is False
    assert (run.max_iterations, run.iteration_total) == (9, 9)


def test_the_gate_runs_at_most_twice_per_turn(monkeypatch):
    """Two counters, two different jobs -- and both caps matter.

    ``gate_iterations_granted`` caps how many extra ITERATIONS the gate may buy
    (one). ``gate_attempts`` caps how many times the suite may RUN in a turn
    (two: the first check plus the post-fix re-check). They coincide in the common
    retry flow, but not in report-only mode, where the grant is always handed back
    so the iteration cap never engages -- there, ``gate_attempts`` is the only
    thing standing between a multi-recovery turn and running the user's whole test
    suite on every pass through finalize.

    Driven at the mixin seam rather than through a full turn because reaching
    finalize three times in one turn requires stacking unrelated recovery paths.
    """
    runs = []

    def _report_only_failure(request):
        runs.append(request)
        return _gate_result(
            {"status": "failed", "gate_on_failure": "report"}, output="FAIL widget"
        )

    monkeypatch.setattr(_gate, "execute_electron_tool", _report_only_failure)

    loop = SimpleNamespace(
        kernel=SimpleNamespace(
            _config=SimpleNamespace(
                feature_flags={VERIFICATION_GATE_FLAG: True},
                tools_verify_enabled=True,
                tools_execution_timeout_seconds=30,
            )
        ),
        runtime=LoopRuntime(
            emit=lambda _e: None,
            request_id=_REQUEST_ID,
            electron_tool_writer=lambda _m: None,
        ),
        request_id=_REQUEST_ID,
        session_id="sess",
        outcomes=[
            SimpleNamespace(
                tool_name="edit_file", success=True, output="ok", metadata={}
            )
        ],
        gate_attempts=0,
        gate_iterations_granted=0,
        max_iterations=8,
        iteration_total=8,
    )
    loop.grant_gate_iteration = lambda: _ToolLoopRun.grant_gate_iteration(loop)

    decisions = [
        _FinalResponseMixin._run_verification_gate(loop, iteration)
        for iteration in (2, 3, 4, 5)
    ]

    assert len(runs) == 2, "the suite must not run again once the attempt cap is spent"
    assert [d.status for d in decisions] == ["failed", "failed", "", ""]
    # Report-only never retried, so the carve-out was handed back every time and
    # the model's budget is exactly where it started.
    assert (loop.max_iterations, loop.iteration_total) == (8, 8)
    assert loop.gate_iterations_granted == 0


def test_the_note_is_actually_visible_not_just_persisted(monkeypatch):
    """A note appended after the answer streamed must reach the screen.

    ``chat_decision_render`` only emits response tokens when "chat.token" is
    absent from the streamed set, so appending to ``response_text`` alone would
    put the note in the persisted turn and nowhere the user can see it. The
    stream reset clears that marker, which is what makes the full text -- note
    included -- re-emit.
    """
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _gate_result({"status": "skipped", "reason": "already_running"}),
    )
    events = []
    engine = _edit_then_answer("Done, fixed it.")
    router = _build_gate_router(engine)
    decision = router.build_chat_decision(
        request_id=_REQUEST_ID,
        messages=[{"role": "user", "content": "fix the widget"}],
        latest_user_content="fix the widget",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id=_REQUEST_ID,
            max_iterations=4,
            streaming=True,
            electron_tool_writer=lambda _m: None,
        ),
    )

    assert "unverified" in decision.response_text
    assert "chat.token" not in decision.streamed_event_types, (
        "the streamed-token marker must be cleared, or the note never re-emits"
    )
    assert any(
        type(event).__name__ == "StreamResetEvent"
        and getattr(event, "reason", "") == "deterministic_replacement"
        for event in events
    ), "the note needs a stream reset to become visible"


def test_a_passing_gate_does_not_reset_the_stream(monkeypatch):
    # No note, no reset: a clean turn must not flicker.
    monkeypatch.setattr(
        _gate, "execute_electron_tool", lambda _r: _gate_result({"status": "passed"})
    )
    events = []
    engine = _edit_then_answer("Done, fixed it.")
    router = _build_gate_router(engine)
    router.build_chat_decision(
        request_id=_REQUEST_ID,
        messages=[{"role": "user", "content": "fix the widget"}],
        latest_user_content="fix the widget",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id=_REQUEST_ID,
            max_iterations=4,
            streaming=True,
            electron_tool_writer=lambda _m: None,
        ),
    )

    assert not [
        event
        for event in events
        if type(event).__name__ == "StreamResetEvent"
        and getattr(event, "reason", "") == "deterministic_replacement"
    ]
