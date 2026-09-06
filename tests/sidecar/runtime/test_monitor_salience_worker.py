"""Worker-protocol and status-record coverage for the monitor salience gate.

Split from ``test_monitor_salience_budget.py`` (test-file size gate): that file
keeps the budget/latch/visibility tests against a fake worker; this one owns
the ``MonitorSalienceWorker`` response protocol (fake spawn context), the
``monitor_status`` salience-key round-trips, and the only tests that spawn a
real subprocess (``test_real_worker_*``).
"""

from __future__ import annotations

import re
import time

import pytest

from sidecar.ai.tools.builtins.regex_safety import looks_like_catastrophic_regex
from sidecar.runtime import monitor_salience as salience_module
from sidecar.runtime.monitor_salience import MonitorSalienceWorker
from sidecar.runtime.monitor_status import (
    MonitorStatusError,
    decode_monitor_status,
    encode_monitor_status,
    validate_monitor_status,
)


class _FakeWorkerConnection:
    """Pipe stand-in: the ready message first, then one scripted response."""

    def __init__(self, response: object) -> None:
        self.closed = False
        self.recv_calls = 0
        self._response = response

    def send(self, payload: object) -> None:
        return None

    def poll(self, _timeout: float = 0.0) -> bool:
        return True

    def recv(self) -> object:
        self.recv_calls += 1
        if self.recv_calls == 1:
            return salience_module._WORKER_READY_MESSAGE  # noqa: SLF001
        return self._response

    def close(self) -> None:
        self.closed = True


class _FakeWorkerProcess:
    def __init__(self) -> None:
        self.daemon = False
        self.alive = False

    def start(self) -> None:
        self.alive = True

    def is_alive(self) -> bool:
        return self.alive

    def terminate(self) -> None:
        self.alive = False

    def join(self, timeout: float) -> None:
        return None

    def close(self) -> None:
        self.alive = False


class _FakeWorkerContext:
    """Spawn-context stand-in, so MonitorSalienceWorker starts no real child."""

    def __init__(self, response: object) -> None:
        self.parent = _FakeWorkerConnection(response)
        self.child = _FakeWorkerConnection(response)
        self.process = _FakeWorkerProcess()

    def Pipe(self) -> tuple[object, object]:  # noqa: N802 - mirrors multiprocessing ctx
        return self.parent, self.child

    def Process(self, target: object, args: object) -> object:  # noqa: N802
        _ = (target, args)
        return self.process


class _StartFailWorkerProcess(_FakeWorkerProcess):
    def __init__(self) -> None:
        super().__init__()
        self.join_calls = 0
        self.terminate_calls = 0

    def start(self) -> None:
        self.alive = True
        raise RuntimeError("process start failed")

    def terminate(self) -> None:
        self.terminate_calls += 1
        super().terminate()

    def join(self, timeout: float) -> None:
        self.join_calls += 1


def _legacy_status_payload(monitor_id: str) -> dict[str, object]:
    """A version-1 record as an older build wrote it: no salience keys at all."""
    return {
        "version": 1,
        "monitor_id": monitor_id,
        "description": "legacy monitor",
        "state": "completed",
        "persistent": False,
        "timeout_ms": 1_000,
        "event_count": 0,
        "dropped_event_count": 0,
        "suppressed_event_count": 0,
        "events": [],
        "terminal_reason": "exit",
        "exit_code": 0,
        "success": True,
        "started_at": "2026-07-30T12:00:00.000Z",
        "updated_at": "2026-07-30T12:00:01.000Z",
        "terminal": True,
    }


def test_worker_process_construction_failure_closes_both_pipe_endpoints() -> None:
    ctx = _FakeWorkerContext({})

    def _fail_process(*, target: object, args: object) -> object:
        _ = (target, args)
        raise RuntimeError("process construction failed")

    ctx.Process = _fail_process  # type: ignore[method-assign]
    worker = MonitorSalienceWorker(ignore_specs=[], match_specs=[], ctx=ctx)

    with pytest.raises(RuntimeError, match="construction failed"):
        worker.evaluate("line", timeout_seconds=1.0)

    assert ctx.parent.closed is True
    assert getattr(ctx.child, "closed", False) is True
    assert worker._parent_conn is None  # noqa: SLF001
    assert worker._process is None  # noqa: SLF001


def test_worker_process_start_failure_reaps_child_and_closes_pipes() -> None:
    ctx = _FakeWorkerContext({})
    ctx.child = _FakeWorkerConnection({})
    ctx.process = _StartFailWorkerProcess()
    worker = MonitorSalienceWorker(ignore_specs=[], match_specs=[], ctx=ctx)

    with pytest.raises(RuntimeError, match="process start failed"):
        worker.evaluate("line", timeout_seconds=1.0)

    assert ctx.parent.closed is True
    assert ctx.child.closed is True
    assert ctx.process.terminate_calls == 1
    assert ctx.process.join_calls >= 1
    assert worker._parent_conn is None  # noqa: SLF001
    assert worker._process is None  # noqa: SLF001




# --------------------------------------------------------------------------
# Status-record schema round-trip (additive-optional keys)
# --------------------------------------------------------------------------
def test_status_record_round_trips_salience_keys() -> None:
    payload = _legacy_status_payload("mon_0000000000b3")
    payload["salience_gate_disabled"] = True
    payload["salience_gate_disabled_reason"] = "budget_exhausted"

    decoded = decode_monitor_status(
        encode_monitor_status(payload, expected_monitor_id="mon_0000000000b3"),
        expected_monitor_id="mon_0000000000b3",
    )

    assert decoded["salience_gate_disabled"] is True
    assert decoded["salience_gate_disabled_reason"] == "budget_exhausted"


def test_legacy_status_record_normalizes_to_gate_enabled() -> None:
    legacy = _legacy_status_payload("mon_0000000000b4")

    normalized = validate_monitor_status(legacy, expected_monitor_id="mon_0000000000b4")

    assert normalized["salience_gate_disabled"] is False
    assert normalized["salience_gate_disabled_reason"] is None


def test_status_record_rejects_reason_without_disabled_gate() -> None:
    payload = _legacy_status_payload("mon_0000000000b5")
    payload["salience_gate_disabled"] = False
    payload["salience_gate_disabled_reason"] = "budget_exhausted"

    with pytest.raises(MonitorStatusError, match="salience reason"):
        validate_monitor_status(payload, expected_monitor_id="mon_0000000000b5")


def test_status_record_rejects_unknown_extra_key() -> None:
    payload = _legacy_status_payload("mon_0000000000b6")
    payload["salience_gate_disabled_because"] = "nope"

    with pytest.raises(MonitorStatusError, match="schema version 1"):
        validate_monitor_status(payload, expected_monitor_id="mon_0000000000b6")


# --------------------------------------------------------------------------
# Worker response protocol (fake ctx -- spawns nothing)
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "response",
    [
        pytest.param({"ignored": False}, id="missing_matched_and_elapsed"),
        pytest.param({"ignored": False, "matched": True}, id="missing_elapsed"),
        pytest.param({"matched": True, "elapsed_seconds": 0.1}, id="missing_ignored"),
        pytest.param(["not", "a", "dict"], id="not_a_dict"),
    ],
)
def test_malformed_worker_response_fails_open(response: object) -> None:
    """Any reply short of the full protocol must raise, never yield a verdict.

    Coercing a partial reply would default ``matched=False`` and so SUPPRESS the
    line under a match allow-list -- silently losing output on protocol drift. The
    RuntimeError instead latches the gate off as ``worker_failed`` (fail open).
    """
    ctx = _FakeWorkerContext(response)
    worker = MonitorSalienceWorker(ignore_specs=[], match_specs=[("keep", 0)], ctx=ctx)

    with pytest.raises(RuntimeError, match="invalid response"):
        worker.evaluate("keep me", timeout_seconds=5.0)

    # Reset on the way out, so the next call starts a fresh child.
    assert worker._parent_conn is None  # noqa: SLF001
    assert worker._process is None  # noqa: SLF001
    assert ctx.parent.closed is True
    assert ctx.process.alive is False


# --------------------------------------------------------------------------
# Real spawned worker (the only subprocess tests in this file)
# --------------------------------------------------------------------------
def test_real_worker_evaluates_match_patterns() -> None:
    worker = MonitorSalienceWorker(
        ignore_specs=[],
        match_specs=[("ERROR", re.IGNORECASE)],
    )
    try:
        hit = worker.evaluate("error boom", timeout_seconds=5.0)
        miss = worker.evaluate("info ok", timeout_seconds=5.0)
    finally:
        worker.close()

    assert hit.ignored is False
    assert hit.matched is True
    assert miss.matched is False
    assert hit.elapsed_seconds >= 0.0
    assert miss.elapsed_seconds >= 0.0


@pytest.mark.slow  # spawns a real child and lets a pathological pattern run out its budget
def test_real_worker_bounds_a_catastrophic_pattern() -> None:
    # Each iteration may consume one or two characters, so the number of ways to
    # cover the input is Fibonacci-exponential and the trailing "x" never matches.
    pattern = r"(\w\d?)+x"
    # The static pre-filter passes this pattern (no inner quantifier, no
    # alternation): the subprocess budget, not the heuristic, is the real bound.
    assert looks_like_catastrophic_regex(pattern) is False

    worker = MonitorSalienceWorker(ignore_specs=[], match_specs=[(pattern, 0)])
    started = time.monotonic()
    try:
        with pytest.raises(TimeoutError):
            worker.evaluate("9" * 1900, timeout_seconds=2.0)
        elapsed = time.monotonic() - started
        # The timeout is enforced by the parent, so the call returns promptly even
        # though the child would have spun forever.
        assert elapsed < 30.0
        # The worker recovers: the wedged child was killed, and the next call
        # starts a fresh one.
        recovered = worker.evaluate("abcx", timeout_seconds=5.0)
        assert recovered.matched is True
    finally:
        worker.close()
