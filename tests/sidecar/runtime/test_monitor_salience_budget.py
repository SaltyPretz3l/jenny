"""Budget, latch, and visibility coverage for the monitor salience gate.

The gate evaluates caller-supplied regexes in a spawned child process under a
per-monitor lifetime budget of search time (``MONITOR_SALIENCE_BUDGET_SECONDS``).
Every test here injects a fake worker through
``manager._salience_worker_factory`` so the latch/budget/visibility behaviour is
deterministic and spawns nothing. The worker response protocol, the
``monitor_status`` salience-key round-trips, and the real-subprocess
end-to-end tests live in ``test_monitor_salience_worker.py`` (split to
respect the test-file size gate).
"""

from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path

import pytest

from sidecar.runtime.monitor_manager import MonitorManager, _ActiveMonitor
from sidecar.runtime.monitor_salience import (
    MONITOR_SALIENCE_BUDGET_SECONDS,
    SalienceVerdict,
)

_GATE_DISABLED_EVENT = "monitor.salience_gate_disabled"


class _ScriptedWorker:
    """Fake salience worker with a scripted verdict / exception per call."""

    def __init__(
        self,
        *,
        verdict: SalienceVerdict | None = None,
        raises: BaseException | None = None,
    ) -> None:
        self.calls = 0
        self.closed = 0
        self._verdict = verdict
        self._raises = raises

    def evaluate(self, text: str, *, timeout_seconds: float) -> SalienceVerdict:
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        assert self._verdict is not None
        return self._verdict

    def close(self) -> None:
        self.closed += 1



def _make_manager(tmp_path: Path, worker: object | None = None) -> MonitorManager:
    manager = MonitorManager(runtime_root=tmp_path / "runtime")
    if worker is not None:
        manager._salience_worker_factory = lambda active: worker  # noqa: SLF001
    return manager


def _record_path(manager: MonitorManager, monitor_id: str) -> Path:
    return manager._status_store.record_path(monitor_id)  # noqa: SLF001


def _make_active(
    manager: MonitorManager,
    *,
    monitor_id: str = "mon_0000000000b1",
) -> _ActiveMonitor:
    """Build a real _ActiveMonitor wired to the manager's record dir."""
    return _ActiveMonitor(
        monitor_id=monitor_id,
        description="salience monitor",
        timeout_ms=1_000,
        persistent=False,
        cwd=_record_path(manager, monitor_id).parent,
        request_id="req_salience",
        trace_id="trace_salience",
        session_id="session_salience",
        tool_call_id="call_salience",
        notification_writer=None,
        shell_argv=["sh", "-lc", "echo hi"],
        match_patterns=[re.compile("keep")],
    )


def _drain_timer(active: _ActiveMonitor) -> None:
    if active.output_flush_timer is not None:
        active.output_flush_timer.cancel()
        active.output_flush_timer = None


def _gate_disabled_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if getattr(record, "event", "") == _GATE_DISABLED_EVENT
    ]



# --------------------------------------------------------------------------
# Budget accounting and the pass-through latch
# --------------------------------------------------------------------------
def test_budget_exhaustion_latches_pass_through(tmp_path: Path) -> None:
    # Each verdict would suppress the line AND costs 1.2s of search time, so the
    # 2.0s budget is gone after two lines.
    worker = _ScriptedWorker(
        verdict=SalienceVerdict(ignored=True, matched=False, elapsed_seconds=1.2)
    )
    manager = _make_manager(tmp_path, worker)
    active = _make_active(manager)

    manager._record_output_event(active, stream="stdout", text="line 1")  # noqa: SLF001
    assert active.events == []
    assert active.salience_budget_spent_seconds == pytest.approx(1.2)
    assert active.salience_gate_disabled is False

    manager._record_output_event(active, stream="stdout", text="line 2")  # noqa: SLF001
    _drain_timer(active)
    # The second verdict still applies (the line is suppressed) and only THEN
    # does the latch trip.
    assert active.events == []
    assert active.salience_budget_spent_seconds == pytest.approx(2.4)
    assert active.salience_gate_disabled is True
    assert active.salience_gate_disabled_reason == "budget_exhausted"
    assert worker.closed == 1

    for index in range(3, 6):
        manager._record_output_event(active, stream="stdout", text=f"line {index}")  # noqa: SLF001
    _drain_timer(active)

    # Pass-through: unmatched lines are now emitted, and the worker is never
    # consulted again.
    assert [event["text"] for event in active.events] == ["line 3", "line 4", "line 5"]
    assert active.suppressed_event_count == 2
    assert active.event_count == 5
    assert worker.calls == 2


def test_gate_disabled_warns_exactly_once(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    worker = _ScriptedWorker(
        verdict=SalienceVerdict(ignored=True, matched=False, elapsed_seconds=2.5)
    )
    manager = _make_manager(tmp_path, worker)
    active = _make_active(manager)

    with caplog.at_level(logging.WARNING):
        manager._record_output_event(active, stream="stdout", text="first")  # noqa: SLF001
        assert active.salience_gate_disabled is True
        assert len(_gate_disabled_records(caplog)) == 1

        for index in range(4):
            manager._record_output_event(active, stream="stdout", text=f"more {index}")  # noqa: SLF001
        _drain_timer(active)

    records = _gate_disabled_records(caplog)
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    assert getattr(records[0], "data", {})["reason"] == "budget_exhausted"
    assert getattr(records[0], "data", {})["budget_seconds"] == MONITOR_SALIENCE_BUDGET_SECONDS


def test_evaluation_timeout_spends_the_whole_budget(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    worker = _ScriptedWorker(raises=TimeoutError("wedged"))
    manager = _make_manager(tmp_path, worker)
    active = _make_active(manager)

    with caplog.at_level(logging.WARNING):
        manager._record_output_event(active, stream="stdout", text="no keep here")  # noqa: SLF001
    _drain_timer(active)

    # Fail-open: the line the worker could not judge is emitted, not dropped.
    assert [event["text"] for event in active.events] == ["no keep here"]
    assert active.salience_gate_disabled is True
    assert active.salience_gate_disabled_reason == "budget_exhausted"
    assert active.salience_budget_spent_seconds == MONITOR_SALIENCE_BUDGET_SECONDS
    assert len(_gate_disabled_records(caplog)) == 1


def test_worker_failure_latches_with_worker_failed_reason(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    worker = _ScriptedWorker(raises=RuntimeError("pipe died"))
    manager = _make_manager(tmp_path, worker)
    active = _make_active(manager)

    with caplog.at_level(logging.WARNING):
        manager._record_output_event(active, stream="stdout", text="no keep here")  # noqa: SLF001
        manager._record_output_event(active, stream="stdout", text="still no keep")  # noqa: SLF001
    _drain_timer(active)

    assert [event["text"] for event in active.events] == ["no keep here", "still no keep"]
    assert active.salience_gate_disabled is True
    assert active.salience_gate_disabled_reason == "worker_failed"
    assert active.salience_budget_spent_seconds == 0.0
    assert worker.calls == 1
    assert len(_gate_disabled_records(caplog)) == 1


def test_worker_factory_failure_latches_with_worker_failed_reason(tmp_path: Path) -> None:
    manager = MonitorManager(runtime_root=tmp_path / "runtime")

    def _boom(active: _ActiveMonitor) -> object:
        raise OSError("no process slots")

    manager._salience_worker_factory = _boom  # noqa: SLF001
    active = _make_active(manager)

    manager._record_output_event(active, stream="stdout", text="no keep here")  # noqa: SLF001
    _drain_timer(active)

    assert [event["text"] for event in active.events] == ["no keep here"]
    assert active.salience_gate_disabled_reason == "worker_failed"


def test_patternless_monitor_never_touches_the_worker(tmp_path: Path) -> None:
    worker = _ScriptedWorker(raises=AssertionError("must not be consulted"))
    manager = _make_manager(tmp_path, worker)
    active = _make_active(manager)
    active.match_patterns = []

    manager._record_output_event(active, stream="stdout", text="anything")  # noqa: SLF001
    _drain_timer(active)

    assert [event["text"] for event in active.events] == ["anything"]
    assert worker.calls == 0
    assert active.salience_gate_disabled is False


def test_dedupe_duplicate_does_not_spend_budget(tmp_path: Path) -> None:
    worker = _ScriptedWorker(
        verdict=SalienceVerdict(ignored=False, matched=True, elapsed_seconds=0.1)
    )
    manager = _make_manager(tmp_path, worker)
    active = _make_active(manager)
    active.dedupe = True

    manager._record_output_event(active, stream="stdout", text="keep me")  # noqa: SLF001
    manager._record_output_event(active, stream="stdout", text="keep me")  # noqa: SLF001
    _drain_timer(active)

    assert [event["text"] for event in active.events] == ["keep me"]
    assert active.suppressed_event_count == 1
    # Second (duplicate) line short-circuits before the worker.
    assert worker.calls == 1
    assert active.salience_budget_spent_seconds == pytest.approx(0.1)


def test_terminal_monitor_does_not_respawn_worker(tmp_path: Path) -> None:
    """A straggler line after termination must not spawn a worker nobody reaps.

    ``_run_monitor`` joins its reader threads with a 1s timeout, so a reader can
    still be draining buffered pipe lines after ``_finish_active`` reaped the
    worker. The line itself is dropped by the in-lock terminal check; the spawn it
    would otherwise trigger would leak a child process.
    """

    class _CountingFactory:
        def __init__(self) -> None:
            self.spawned = 0
            self.worker = _ScriptedWorker(
                verdict=SalienceVerdict(ignored=False, matched=True, elapsed_seconds=0.001)
            )

        def __call__(self, active: _ActiveMonitor) -> _ScriptedWorker:
            self.spawned += 1
            return self.worker

    factory = _CountingFactory()
    manager = MonitorManager(runtime_root=tmp_path / "runtime")
    manager._salience_worker_factory = factory  # noqa: SLF001
    active = _make_active(manager, monitor_id="mon_0000000000b7")
    manager._active[active.monitor_id] = active  # noqa: SLF001

    manager._record_output_event(active, stream="stdout", text="keep me")  # noqa: SLF001
    _drain_timer(active)
    assert [event["text"] for event in active.events] == ["keep me"]
    assert factory.spawned == 1
    assert factory.worker.calls == 1

    # Terminate exactly the way production does: the worker is reaped here.
    manager._finish_active(  # noqa: SLF001
        active,
        state="completed",
        terminal_reason="exit",
        exit_code=0,
        success=True,
    )
    assert factory.worker.closed == 1
    assert active.salience_worker is None

    # A straggler from a still-draining reader thread.
    manager._record_output_event(active, stream="stdout", text="straggler")  # noqa: SLF001
    _drain_timer(active)

    assert factory.spawned == 1
    assert factory.worker.calls == 1
    assert active.salience_worker is None
    assert [event["text"] for event in active.events] == ["keep me"]


def test_latch_during_termination_is_visible_in_terminal_snapshot(tmp_path: Path) -> None:
    """A latch set by an in-flight evaluation must make the terminal snapshot.

    ``_finish_active`` reaps the worker BEFORE it snapshots, so it blocks on
    salience_lock until a mid-evaluation reader thread finishes. Without that first
    reap the snapshot (and the persisted record) would be written while the
    evaluation was still running and would report the gate as still enabled.
    """
    started = threading.Event()
    release = threading.Event()

    class _BlockingWorker:
        def __init__(self) -> None:
            self.calls = 0
            self.closed = 0

        def evaluate(self, text: str, *, timeout_seconds: float) -> SalienceVerdict:
            self.calls += 1
            started.set()
            assert release.wait(30.0), "release event never fired"
            raise TimeoutError("wedged across termination")

        def close(self) -> None:
            self.closed += 1

    class _CountingFactory:
        def __init__(self) -> None:
            self.spawned = 0
            self.worker = _BlockingWorker()

        def __call__(self, active: _ActiveMonitor) -> _BlockingWorker:
            self.spawned += 1
            return self.worker

    factory = _CountingFactory()
    manager = MonitorManager(runtime_root=tmp_path / "runtime")
    manager._salience_worker_factory = factory  # noqa: SLF001
    active = _make_active(manager, monitor_id="mon_0000000000b8")

    reader = threading.Thread(
        target=manager._record_output_event,  # noqa: SLF001
        kwargs={"active": active, "stream": "stdout", "text": "pathological"},
        daemon=True,
    )
    reader.start()
    assert started.wait(30.0), "worker was never consulted"

    finisher = threading.Thread(
        target=manager._finish_active,  # noqa: SLF001
        args=(active,),
        kwargs={
            "state": "completed",
            "terminal_reason": "exit",
            "exit_code": 0,
            "success": True,
        },
        daemon=True,
    )
    finisher.start()
    # Let the finisher reach its pre-snapshot reap and park on salience_lock. With
    # reap #1 in place it parks there however the threads interleave, so this grace
    # is only what makes the without-the-fix failure deterministic rather than racy:
    # the early break is the buggy interleaving (snapshot taken mid-evaluation), and
    # the fixed path simply spends the whole -- deliberately short -- deadline.
    grace_deadline = time.monotonic() + 0.25
    while time.monotonic() < grace_deadline:
        if active.terminal_status is not None:
            break
        time.sleep(0.01)

    release.set()
    finisher.join(30.0)
    reader.join(30.0)
    _drain_timer(active)
    assert not finisher.is_alive()
    assert not reader.is_alive()

    terminal = active.terminal_status
    assert terminal is not None
    assert terminal["salience_gate_disabled"] is True
    assert terminal["salience_gate_disabled_reason"] == "budget_exhausted"
    assert factory.spawned == 1
    assert factory.worker.calls == 1
    assert factory.worker.closed == 1
    assert active.salience_worker is None


# --------------------------------------------------------------------------
# Payload visibility
# --------------------------------------------------------------------------
def test_latch_is_visible_in_metadata_terminal_and_digest(tmp_path: Path) -> None:
    worker = _ScriptedWorker(
        verdict=SalienceVerdict(ignored=False, matched=True, elapsed_seconds=3.0)
    )
    manager = _make_manager(tmp_path, worker)
    active = _make_active(manager)

    manager._record_output_event(active, stream="stdout", text="keep me")  # noqa: SLF001
    _drain_timer(active)

    metadata = manager._metadata(active)  # noqa: SLF001
    assert metadata["salience_gate_disabled"] is True
    assert metadata["salience_gate_disabled_reason"] == "budget_exhausted"

    terminal = manager._terminal_status(active)  # noqa: SLF001
    assert terminal["salience_gate_disabled"] is True
    assert terminal["salience_gate_disabled_reason"] == "budget_exhausted"

    with active.lock:
        digest = manager._build_poll_digest_locked(active, 0)  # noqa: SLF001
    assert digest["salience_gate_disabled"] is True
    assert digest["salience_gate_disabled_reason"] == "budget_exhausted"

    # The line was EMITTED (matched=True), so a pending batch must exist -- asserting
    # "None or ..." would pass vacuously if batching regressed to never batching.
    batch = manager._take_pending_output_batch_locked(active)  # noqa: SLF001
    assert batch is not None
    assert batch["salience_gate_disabled"] is True
    assert batch["salience_gate_disabled_reason"] == "budget_exhausted"


def test_healthy_monitor_reports_gate_enabled(tmp_path: Path) -> None:
    worker = _ScriptedWorker(
        verdict=SalienceVerdict(ignored=False, matched=True, elapsed_seconds=0.001)
    )
    manager = _make_manager(tmp_path, worker)
    active = _make_active(manager, monitor_id="mon_0000000000b2")
    manager._active[active.monitor_id] = active  # noqa: SLF001

    manager._record_output_event(active, stream="stdout", text="keep me")  # noqa: SLF001
    _drain_timer(active)

    assert manager._metadata(active)["salience_gate_disabled"] is False  # noqa: SLF001
    assert manager._metadata(active)["salience_gate_disabled_reason"] is None  # noqa: SLF001
    digest = manager.poll_monitor(active.monitor_id, since_sequence=0)
    assert digest["salience_gate_disabled"] is False
    assert digest["salience_gate_disabled_reason"] is None

