"""Red-first contract for the W0 phase recorder (tool-contract program).

Pins the closed phase vocabulary, absence-of-unused-phases, failure-phase
retention on exception, and the pre-serialized JSON timings text required by
the stringifying ``to_error_data`` channel.
"""

from __future__ import annotations

import json

import pytest

from sidecar.ai.tools.phase_trace import PHASE_NAMES, PhaseTrace


def test_phase_vocabulary_is_closed_and_ordered() -> None:
    assert PHASE_NAMES == (
        "queue",
        "validate",
        "precondition",
        "acquire_lock",
        "bootstrap",
        "execute",
        "collect",
        "serialize",
    )


def test_unknown_phase_name_is_rejected() -> None:
    trace = PhaseTrace(tool="read_file", call_id="call_1", trace_id="t_1.call_1")
    with pytest.raises(ValueError):
        with trace.phase("warmup"):
            pass


def test_unused_phases_are_absent_not_zero() -> None:
    with PhaseTrace(tool="read_file", call_id="call_1", trace_id="t_1.call_1") as trace:
        with trace.phase("validate"):
            pass
        with trace.phase("execute"):
            pass
    summary = trace.summary()
    assert set(summary) == {"validate", "execute"}
    for entry in summary.values():
        assert isinstance(entry["elapsed_ms"], (int, float))
        assert entry["elapsed_ms"] >= 0


def test_current_phase_tracks_and_failure_phase_is_retained() -> None:
    trace = PhaseTrace(tool="python_execute", call_id="call_9", trace_id="t_9.call_9")
    with pytest.raises(RuntimeError):
        with trace:
            with trace.phase("validate"):
                assert trace.current_phase == "validate"
            with trace.phase("bootstrap"):
                raise RuntimeError("venv build failed")
    # The failure phase survives scope exit so the failure path can report it.
    assert trace.current_phase == "bootstrap"
    assert "bootstrap" in trace.summary()


def test_budget_is_recorded_and_over_budget_flagged() -> None:
    with PhaseTrace(tool="python_execute", call_id="c", trace_id="t.c") as trace:
        with trace.phase("execute", budget_seconds=3600):
            pass
    entry = trace.summary()["execute"]
    assert entry["budget_seconds"] == 3600
    assert "over_budget" not in entry or entry["over_budget"] is False

    with PhaseTrace(tool="python_execute", call_id="c", trace_id="t.c") as trace2:
        with trace2.phase("execute", budget_seconds=0):
            pass
    assert trace2.summary()["execute"]["over_budget"] is True


def test_phase_timings_json_is_preserialized_text() -> None:
    with PhaseTrace(tool="read_file", call_id="c", trace_id="t.c") as trace:
        with trace.phase("execute"):
            pass
    text = trace.phase_timings_json()
    assert isinstance(text, str)
    parsed = json.loads(text)
    assert set(parsed) == {"execute"}
    # Must survive the to_error_data stringify round-trip untouched.
    assert json.loads(str(text)) == parsed


def test_trace_identity_fields_are_exposed() -> None:
    trace = PhaseTrace(tool="run_command", call_id="call_3", trace_id="trace_x.call_3")
    assert trace.tool == "run_command"
    assert trace.call_id == "call_3"
    assert trace.trace_id == "trace_x.call_3"
