"""Tests for sidecar.ai.routing.verification_gate.

The suite is organised around the one property that must never regress:

    **the gate can never prevent a turn from completing.**

Every failure mode -- no bridge, no designated gate, the user's own run holding
the single-run lock, a timeout, an ``MCPError``, a malformed result, or an
exhausted retry cap -- must come back as a decision the finalize path can carry
to a normal final response. Nothing in here may produce a terminal error, and
nothing may raise.

The rest covers the pure decision surface (``should_run_gate`` and its mutation /
already-verified inputs) and the carve-out arithmetic that keeps the gate out of
the model's working iteration budget.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.routing import verification_gate as _gate
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.verification_gate import (
    GATE_MAX_RETRIES,
    VERIFICATION_GATE_FLAG,
    should_run_gate,
    workspace_was_mutated,
)


def _outcome(tool_name, *, success=True, metadata=None):
    return SimpleNamespace(
        tool_name=tool_name,
        success=success,
        output="",
        metadata=metadata or {},
    )


def _make_loop_run(*, has_writer=True, flag_enabled=True, verify_enabled=True):
    runtime = LoopRuntime(
        electron_tool_writer=(lambda message: None) if has_writer else None,
        electron_tool_reader=None,
        electron_tool_reader_factory=None,
        trace_id=None,
        cancel_handle=None,
        wall_clock_deadline=None,
    )
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            feature_flags={VERIFICATION_GATE_FLAG: flag_enabled},
            tools_verify_enabled=verify_enabled,
        ),
    )
    return SimpleNamespace(
        kernel=kernel,
        runtime=runtime,
        request_id="req1",
        session_id="sess1",
        gate_attempts=1,
    )


def _result(metadata, *, output="", success=True):
    return SimpleNamespace(metadata=metadata, output=output, success=success)


# ---------------------------------------------------------------------------
# should_run_gate (pure truth table)
# ---------------------------------------------------------------------------


def test_gate_runs_after_a_successful_typed_mutation():
    assert should_run_gate(
        feature_flags={VERIFICATION_GATE_FLAG: True},
        tools_verify_enabled=True,
        attempts=0,
        outcomes=[_outcome("edit_file")],
    ) is True


@pytest.mark.parametrize(
    ("flags", "verify_enabled", "attempts", "outcomes", "why"),
    [
        ({VERIFICATION_GATE_FLAG: False}, True, 0, [_outcome("edit_file")], "flag off"),
        ({}, True, 0, [_outcome("edit_file")], "flag absent"),
        (
            {VERIFICATION_GATE_FLAG: True},
            False,
            0,
            [_outcome("edit_file")],
            "verify tool not registered",
        ),
        ({VERIFICATION_GATE_FLAG: True}, True, 0, [], "no tool calls at all"),
        (
            {VERIFICATION_GATE_FLAG: True},
            True,
            0,
            [_outcome("read_file"), _outcome("grep_search")],
            "read-only run",
        ),
        (
            {VERIFICATION_GATE_FLAG: True},
            True,
            0,
            [_outcome("edit_file", success=False)],
            "the mutation was refused, so nothing changed",
        ),
        (
            {VERIFICATION_GATE_FLAG: True},
            True,
            0,
            [_outcome("edit_file"), _outcome("verify", metadata={"status": "passed"})],
            "the model already verified and it passed",
        ),
        (
            {VERIFICATION_GATE_FLAG: True},
            True,
            GATE_MAX_RETRIES + 1,
            [_outcome("edit_file")],
            "retry cap already spent",
        ),
    ],
)
def test_gate_does_not_run(flags, verify_enabled, attempts, outcomes, why):
    assert should_run_gate(
        feature_flags=flags,
        tools_verify_enabled=verify_enabled,
        attempts=attempts,
        outcomes=outcomes,
    ) is False, why


def test_run_command_alone_does_not_trigger_the_gate():
    # Deliberately narrower than auto_checkpoint's mutation set: `git status` is
    # not a mutation, and firing a whole suite after every shell call is latency.
    assert workspace_was_mutated([_outcome("run_command")]) is False
    assert workspace_was_mutated([_outcome("write_file")]) is True


def test_a_failed_model_verify_does_not_satisfy_the_gate():
    assert should_run_gate(
        feature_flags={VERIFICATION_GATE_FLAG: True},
        tools_verify_enabled=True,
        attempts=0,
        outcomes=[_outcome("edit_file"), _outcome("verify", metadata={"status": "failed"})],
    ) is True


# ---------------------------------------------------------------------------
# The invariant: the turn always completes
# ---------------------------------------------------------------------------


def test_no_bridge_is_a_silent_no_op(monkeypatch):
    calls = []
    monkeypatch.setattr(_gate, "execute_electron_tool", calls.append)
    decision = _gate.run_gate(_make_loop_run(has_writer=False), retry_allowed=True)
    assert decision == _gate.NO_GATE_ACTION
    assert decision.retry is False
    assert calls == []


def test_an_mcp_error_becomes_a_note_not_an_exception(monkeypatch):
    def _boom(_request):
        raise MCPError(code="CMP-TOOL-0001", message="bridge exploded", retryable=False)

    monkeypatch.setattr(_gate, "execute_electron_tool", _boom)
    decision = _gate.run_gate(_make_loop_run(), retry_allowed=True)
    assert decision.retry is False
    assert decision.reason == "gate_error"
    assert "unverified" in decision.note


def test_an_arbitrary_exception_becomes_a_note_not_an_exception(monkeypatch):
    def _boom(_request):
        raise RuntimeError("something nobody predicted")

    monkeypatch.setattr(_gate, "execute_electron_tool", _boom)
    decision = _gate.run_gate(_make_loop_run(), retry_allowed=True)
    assert decision.retry is False
    assert decision.reason == "gate_error"
    assert decision.note


def test_a_held_single_run_lock_is_a_note_not_a_retry(monkeypatch):
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _result({"status": "skipped", "reason": "already_running"}),
    )
    decision = _gate.run_gate(_make_loop_run(), retry_allowed=True)
    assert decision.retry is False
    assert decision.status == "skipped"
    assert "unverified" in decision.note


def test_no_designated_gate_says_nothing_at_all(monkeypatch):
    # There is nothing to tell the user about: they never asked for a gate.
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _result({"status": "skipped", "reason": "no_gate_configured"}),
    )
    decision = _gate.run_gate(_make_loop_run(), retry_allowed=True)
    assert decision.retry is False
    assert decision.note == ""


def test_a_malformed_result_fails_to_the_truth_not_to_a_block(monkeypatch):
    monkeypatch.setattr(_gate, "execute_electron_tool", lambda _r: _result(None))
    decision = _gate.run_gate(_make_loop_run(), retry_allowed=False)
    # Unrecognised => treated as failing, but still only a note.
    assert decision.retry is False
    assert decision.status == "failed"
    assert decision.note


def test_a_failing_gate_with_no_retry_capacity_only_annotates(monkeypatch):
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _result({"status": "failed", "gate_on_failure": "retry"}, output="FAIL x"),
    )
    decision = _gate.run_gate(_make_loop_run(), retry_allowed=False)
    assert decision.retry is False
    assert decision.status == "failed"
    assert "did not pass" in decision.note


# ---------------------------------------------------------------------------
# Verdict handling
# ---------------------------------------------------------------------------


def test_a_passing_gate_adds_nothing_to_the_response(monkeypatch):
    monkeypatch.setattr(
        _gate, "execute_electron_tool", lambda _r: _result({"status": "passed"})
    )
    decision = _gate.run_gate(_make_loop_run(), retry_allowed=True)
    assert decision.retry is False
    assert decision.note == ""
    assert decision.status == "passed"


def test_a_failing_gate_retries_with_the_failing_output(monkeypatch):
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _result(
            {"status": "failed", "gate_on_failure": "retry"},
            output="AssertionError: expected 3 to equal 4",
        ),
    )
    decision = _gate.run_gate(_make_loop_run(), retry_allowed=True)
    assert decision.retry is True
    assert "AssertionError: expected 3 to equal 4" in decision.feedback
    assert 'verify {"action":"gate"}' in decision.feedback
    # The note path is for turns that finish; a retry must not also annotate.
    assert decision.note == ""


def test_report_only_mode_never_retries(monkeypatch):
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _result(
            {"status": "failed", "gate_on_failure": "report"}, output="FAIL widget"
        ),
    )
    decision = _gate.run_gate(_make_loop_run(), retry_allowed=True)
    assert decision.retry is False
    assert "did not pass" in decision.note


def test_failing_output_handed_back_is_bounded(monkeypatch):
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _result(
            {"status": "failed", "gate_on_failure": "retry"},
            output="x" * (_gate.MAX_FEEDBACK_CHARS * 3),
        ),
    )
    decision = _gate.run_gate(_make_loop_run(), retry_allowed=True)
    assert decision.retry is True
    assert len(decision.feedback) < _gate.MAX_FEEDBACK_CHARS * 2


def test_the_gate_asks_electron_for_the_designated_gate(monkeypatch):
    captured = {}

    def _capture(request):
        captured["tool_name"] = request.tool_name
        captured["arguments"] = dict(request.arguments)
        captured["request_id"] = request.request_id
        return _result({"status": "passed"})

    monkeypatch.setattr(_gate, "execute_electron_tool", _capture)
    _gate.run_gate(_make_loop_run(), retry_allowed=True)
    assert captured["tool_name"] == "verify"
    # The 1-based attempt rides along (harness-only; not in the model schema)
    # so the Test Runner panel can label the run.
    assert captured["arguments"] == {"action": "gate", "attempt": 1}
    # The TURN's request id, not a fresh one: Electron correlates on it.
    assert captured["request_id"] == "req1"


def test_a_loop_run_without_an_attempt_counter_sends_no_attempt(monkeypatch):
    captured = {}

    def _capture(request):
        captured["arguments"] = dict(request.arguments)
        return _result({"status": "passed"})

    monkeypatch.setattr(_gate, "execute_electron_tool", _capture)
    loop_run = _make_loop_run()
    del loop_run.gate_attempts
    _gate.run_gate(loop_run, retry_allowed=True)
    assert captured["arguments"] == {"action": "gate"}


def test_the_note_counts_attempts_honestly():
    # Report-only (or any single run): no fix was attempted, say so.
    single = _gate.build_unverified_note(status="failed", reason="gate_failed", attempts=1)
    assert "did not pass" in single
    assert "no fix was attempted" in single
    assert "attempts" not in single
    # After the retry: the suite still failed, and the count is the truth.
    twice = _gate.build_unverified_note(status="failed", reason="gate_failed", attempts=2)
    assert "still did not pass after 2 attempts" in twice
    assert "no fix was attempted" not in twice
    # Skips never mention attempts at all.
    assert "attempt" not in _gate.build_unverified_note(status="skipped", reason="already_running")


def test_the_decision_note_uses_the_loop_runs_attempt_count(monkeypatch):
    monkeypatch.setattr(
        _gate,
        "execute_electron_tool",
        lambda _r: _result({"status": "failed", "gate_on_failure": "retry"}, output="FAIL x"),
    )
    loop_run = _make_loop_run()
    loop_run.gate_attempts = 2
    decision = _gate.run_gate(loop_run, retry_allowed=False)
    assert decision.retry is False
    assert "after 2 attempts" in decision.note


# ---------------------------------------------------------------------------
# Failure-feedback distillation
# ---------------------------------------------------------------------------

_PYTEST_OUTPUT = (
    "Verification did NOT pass: unit - status failed, 1 failed, 240 passed (12.4s).\n"
    "stdout:\n"
    "============================= test session starts ==========================\n"
    "collected 241 items\n"
    + "\n".join(f"tests/test_mod{i}.py ....           [ {i}%]" for i in range(40))
    + "\n"
    "tests/test_widget.py F                                            [ 99%]\n"
    "================================== FAILURES ================================\n"
    "_______________________________ test_renders _______________________________\n"
    ">       assert widget.count == 4\n"
    "E       assert 3 == 4\n"
    "\n"
    "tests/test_widget.py:12: AssertionError\n"
    "=========================== short test summary info ========================\n"
    "FAILED tests/test_widget.py::test_renders - assert 3 == 4\n"
    "======================== 1 failed, 240 passed in 12.4s =====================\n"
)


def test_distillation_keeps_every_failure_line_and_drops_the_parade():
    distilled = _gate.distill_gate_output(_PYTEST_OUTPUT)

    assert len(distilled) < len(_PYTEST_OUTPUT) / 2, "the pass parade must collapse"
    for kept in (
        "assert 3 == 4",
        "tests/test_widget.py:12: AssertionError",
        "FAILED tests/test_widget.py::test_renders",
        "1 failed, 240 passed",
    ):
        assert kept in distilled, kept
    assert "lines of passing output omitted" in distilled
    # The filters mark omissions with a NUL sentinel for the omission store to
    # splice; the gate has no store, so nothing may leak into a prompt.
    assert "\x00" not in distilled


def test_distillation_passes_unrecognised_output_through_untouched():
    prose = "The workspace test runner exploded in a way no filter models."
    assert _gate.distill_gate_output(prose) == prose
    assert _gate.distill_gate_output("") == ""


def test_distillation_never_raises(monkeypatch):
    def _boom(**_kwargs):
        raise RuntimeError("filter router exploded")

    monkeypatch.setattr(_gate, "select_filter", _boom)
    assert _gate.distill_gate_output(_PYTEST_OUTPUT) == _PYTEST_OUTPUT


def test_feedback_is_distilled_before_it_is_bounded():
    feedback = _gate.build_failure_feedback(_PYTEST_OUTPUT)
    # Without distillation the char budget would be spent on the pass parade and
    # the assertion at the bottom would be the first thing cut.
    assert "assert 3 == 4" in feedback
    assert "tests/test_mod30.py" not in feedback
