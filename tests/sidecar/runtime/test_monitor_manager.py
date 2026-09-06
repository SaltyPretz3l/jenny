from __future__ import annotations

import json
import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime import monitor_manager as monitor_manager_module
from sidecar.runtime.monitor_manager import MonitorManager
from sidecar.runtime.monitor_salience import SalienceVerdict


def _status_payload(
    monitor_id: str,
    *,
    state: str,
    persistent: bool = True,
) -> dict[str, object]:
    terminal = state != "running"
    return {
        "version": 1,
        "monitor_id": monitor_id,
        "description": "test monitor",
        "state": state,
        "persistent": persistent,
        "timeout_ms": 5_000,
        "event_count": 0,
        "dropped_event_count": 0,
        "suppressed_event_count": 0,
        "events": [],
        "terminal_reason": "exit" if terminal else None,
        "exit_code": 0 if terminal else None,
        "success": True if terminal else None,
        "started_at": "2026-07-12T12:00:00.000Z",
        "updated_at": "2026-07-12T12:00:01.000Z",
        "terminal": terminal,
    }


def _instant_command() -> str:
    if os.name == "nt":
        return 'Write-Output "HELLO_MONITOR"'
    return "printf 'HELLO_MONITOR\\n'"


def _sleep_command() -> str:
    if os.name == "nt":
        return "Start-Sleep -Seconds 5"
    return "sleep 5"


def _many_lines_command() -> str:
    if os.name == "nt":
        return '1..3 | ForEach-Object { Write-Output "LINE$_" }'
    return "printf 'LINE1\\nLINE2\\nLINE3\\n'"


def _wait_for_terminal_notification(
    events: list[dict[str, object]], *, timeout_seconds: float = 2.0
) -> None:
    """Block until the terminal monitor notification has been appended to *events*.

    The production poll contract returns as soon as terminal status is set:
    MonitorManager._finish_active assigns active.terminal_status BEFORE it emits
    the terminal notification and sets terminal_event.
    The terminal and final output_batch *notifications* are appended by the
    reader/flush thread one step later, so a test that inspects the notification
    stream the instant the terminal poll returns races that thread. Under load —
    notably the full suite's CPU contention with coverage's sys.settrace active —
    the thread lags enough to lose the race. Poll until the stream has quiesced.
    The terminal notification is emitted last, so once it is present every
    preceding output_batch notification has already landed.
    """
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if any(
            event.get("params", {}).get("terminal") is True for event in list(events)
        ):
            return
        time.sleep(0.01)


def _wait_for_terminal(
    manager: MonitorManager,
    monitor_id: str,
    *,
    timeout_seconds: float,
) -> dict[str, object]:
    deadline = time.monotonic() + timeout_seconds
    while True:
        remaining = deadline - time.monotonic()
        digest = manager.poll_monitor(
            monitor_id,
            wait_ms=max(0, min(100, int(remaining * 1000))),
        )
        if digest["terminal"] or remaining <= 0:
            return digest


def test_monitor_streams_output_and_persists_terminal_state(tmp_path: Path) -> None:
    events: list[dict[str, object]] = []
    manager = MonitorManager(runtime_root=tmp_path / "runtime")

    result = manager.start_monitor(
        command=_instant_command(),
        description="Watch for the first line",
        timeout_ms=5_000,
        persistent=True,
        cwd=tmp_path,
        workspace_root=tmp_path,
        request_id="stream_1",
        trace_id="trace_1",
        session_id="session_1",
        tool_call_id="call_1",
        notification_writer=events.append,
    )

    assert result.monitor_id
    assert result.metadata["monitor"]["state"] == "running"

    terminal = _wait_for_terminal(manager, result.monitor_id, timeout_seconds=5)

    assert terminal["state"] == "completed"
    # The output_batch and terminal notifications are appended by the reader/flush
    # thread after the terminal poll returns; quiesce the stream before asserting on
    # it so this does not race the writer under load.
    _wait_for_terminal_notification(events)
    assert any(
        event.get("method") == "monitor.event"
        and event.get("params", {}).get("kind") == "output_batch"
        and any(
            entry.get("text") == "HELLO_MONITOR"
            for entry in event.get("params", {}).get("events", [])
            if isinstance(entry, dict)
        )
        for event in events
    )
    assert any(
        event.get("method") == "monitor.event"
        and event.get("params", {}).get("terminal") is True
        for event in events
    )

    record_path = tmp_path / "runtime" / "monitors" / result.monitor_id / "status.json"
    status = json.loads(record_path.read_text(encoding="utf-8"))
    assert status["state"] == "completed"
    assert status["persistent"] is True
    assert status["event_count"] >= 1


def _mixed_command() -> str:
    if os.name == "nt":
        return 'Write-Output "KEEP one"; Write-Output "noise"; Write-Output "KEEP two"'
    return "printf 'KEEP one\\nnoise\\nKEEP two\\n'"


class _InProcessSalienceWorker:
    """In-process stand-in for ``MonitorSalienceWorker`` (spawns nothing).

    The gate's real worker is a spawned child; its startup can outlast the
    reader-thread join in ``_run_monitor``, which would race this test's
    already-real subprocess. Evaluating the same compiled patterns in-process
    keeps the assertion about *which lines are emitted* deterministic.
    """

    def __init__(self, active: object) -> None:
        self._active = active

    def evaluate(self, text: str, *, timeout_seconds: float) -> SalienceVerdict:
        ignore_patterns = getattr(self._active, "ignore_patterns", [])
        match_patterns = getattr(self._active, "match_patterns", [])
        ignored = any(regex.search(text) for regex in ignore_patterns)
        matched = False
        if not ignored:
            matched = not match_patterns or any(regex.search(text) for regex in match_patterns)
        return SalienceVerdict(ignored=ignored, matched=matched, elapsed_seconds=0.0)

    def close(self) -> None:
        return None


def test_monitor_match_patterns_emit_only_matches(tmp_path: Path) -> None:
    events: list[dict[str, object]] = []
    manager = MonitorManager(runtime_root=tmp_path / "runtime")
    manager._salience_worker_factory = _InProcessSalienceWorker  # noqa: SLF001

    result = manager.start_monitor(
        command=_mixed_command(),
        description="Watch for KEEP lines",
        timeout_ms=5_000,
        persistent=False,
        cwd=tmp_path,
        workspace_root=tmp_path,
        match_patterns=["KEEP"],
        request_id="stream_g",
        trace_id="trace_g",
        session_id="session_g",
        tool_call_id="call_g",
        notification_writer=events.append,
    )

    terminal = _wait_for_terminal(manager, result.monitor_id, timeout_seconds=5)
    assert terminal["state"] == "completed"
    assert terminal["suppressed_event_count"] >= 1  # the "noise" line was gated out
    _wait_for_terminal_notification(events)

    emitted_texts = [
        entry.get("text")
        for event in events
        if event.get("params", {}).get("kind") == "output_batch"
        for entry in event.get("params", {}).get("events", [])
        if isinstance(entry, dict)
    ]
    assert emitted_texts  # the KEEP lines surfaced
    assert all("KEEP" in (text or "") for text in emitted_texts)
    assert "noise" not in emitted_texts


@pytest.mark.slow  # spawns a real 5-second sleep subprocess to exercise the timeout path
def test_monitor_timeout_marks_terminal_and_cleans_process(tmp_path: Path) -> None:
    events: list[dict[str, object]] = []
    manager = MonitorManager(runtime_root=tmp_path / "runtime")

    result = manager.start_monitor(
        command=_sleep_command(),
        description="Timeout monitor",
        timeout_ms=200,
        persistent=False,
        cwd=tmp_path,
        workspace_root=tmp_path,
        request_id="stream_timeout",
        trace_id="trace_timeout",
        session_id="session_timeout",
        tool_call_id="call_timeout",
        notification_writer=events.append,
    )

    terminal = _wait_for_terminal(manager, result.monitor_id, timeout_seconds=5)

    assert terminal["state"] == "timeout"
    assert terminal["terminal_reason"] == "timeout"
    # The terminal notification (the only one carrying state=="timeout" here) is
    # appended by the reader/flush thread after the terminal poll returns; quiesce
    # the stream before asserting on it so this does not race the writer.
    _wait_for_terminal_notification(events)
    assert any(event.get("params", {}).get("state") == "timeout" for event in events)


def test_monitor_batches_output_notifications_and_flushes_before_terminal(tmp_path: Path) -> None:
    events: list[dict[str, object]] = []
    manager = MonitorManager(runtime_root=tmp_path / "runtime")

    result = manager.start_monitor(
        command=_many_lines_command(),
        description="Batch output",
        timeout_ms=5_000,
        persistent=True,
        cwd=tmp_path,
        workspace_root=tmp_path,
        request_id="stream_batch",
        trace_id="trace_batch",
        session_id="session_batch",
        tool_call_id="call_batch",
        notification_writer=events.append,
    )

    terminal = _wait_for_terminal(manager, result.monitor_id, timeout_seconds=5)

    assert terminal["state"] == "completed"

    # Quiesce the async notification stream before inspecting it: the terminal poll
    # returns on terminal status, but the notifications are appended by the
    # reader/flush thread (this also stops the iterations below from racing it).
    _wait_for_terminal_notification(events)

    snapshot = list(events)
    output_batches = [
        event.get("params", {})
        for event in snapshot
        if event.get("method") == "monitor.event"
        and event.get("params", {}).get("kind") == "output_batch"
    ]
    assert output_batches, "expected at least one output_batch notification"
    # The three lines are delivered in order, but they need not coalesce into a
    # single batch: output flushes either at MAX_MONITOR_OUTPUT_BATCH or when the
    # 0.25s flush timer fires. Under load (notably coverage's sys.settrace
    # slowing the reader thread) the timer can fire between lines, splitting the
    # batch. Assert the real contract — every line delivered, in order, across
    # however many batches — not a brittle single-batch assumption.
    delivered = [entry["text"] for batch in output_batches for entry in batch["events"]]
    assert delivered == ["LINE1", "LINE2", "LINE3"]
    # Defensive: a missing event type should surface as a clear assertion, not a
    # bare StopIteration from next().
    terminal_index = next(
        (index for index, event in enumerate(snapshot)
         if event.get("params", {}).get("terminal") is True),
        None,
    )
    batch_index = next(
        (index for index, event in enumerate(snapshot)
         if event.get("params", {}).get("kind") == "output_batch"),
        None,
    )
    assert terminal_index is not None, "expected a terminal monitor notification"
    assert batch_index is not None, "expected an output_batch notification"
    assert batch_index < terminal_index


def test_monitor_recovery_marks_persistent_running_records_stale(tmp_path: Path) -> None:
    monitor_id = "mon_bbbbbbbbbbbb"
    monitor_dir = tmp_path / "runtime" / "monitors" / monitor_id
    monitor_dir.mkdir(parents=True)
    (monitor_dir / "status.json").write_text(
        json.dumps(_status_payload(monitor_id, state="running")),
        encoding="utf-8",
    )

    manager = MonitorManager(runtime_root=tmp_path / "runtime")

    recovered = manager.recover_stale_monitors()

    assert recovered == 1
    status = json.loads((monitor_dir / "status.json").read_text(encoding="utf-8"))
    assert status["state"] == "stale"
    assert status["terminal_reason"] == "stale_recovery"


def test_monitor_rejects_blocked_command_patterns(tmp_path: Path) -> None:
    manager = MonitorManager(runtime_root=tmp_path / "runtime")

    with pytest.raises(ToolExecutionFailure, match="command blocked"):
        manager.start_monitor(
            command="rm -rf /",
            description="bad",
            timeout_ms=1_000,
            persistent=False,
            cwd=tmp_path,
            workspace_root=tmp_path,
            request_id="stream_bad",
            trace_id="trace_bad",
            session_id="session_bad",
            tool_call_id="call_bad",
            notification_writer=lambda _message: None,
        )


def test_monitor_start_fails_closed_before_spawn_when_active_limit_reached(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = MonitorManager(runtime_root=tmp_path / "runtime")
    for index in range(8):
        manager._active[f"mon_{index:012x}"] = SimpleNamespace()  # noqa: SLF001

    def fail_spawn(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("spawn should not be called when active limit is reached")

    monkeypatch.setattr(
        monitor_manager_module,
        "spawn_managed_background_process",
        fail_spawn,
    )

    with pytest.raises(ToolExecutionFailure, match="active monitor limit"):
        manager.start_monitor(
            command=_instant_command(),
            description="too many",
            timeout_ms=1_000,
            persistent=False,
            cwd=tmp_path,
            workspace_root=tmp_path,
            request_id="stream_limit",
            trace_id="trace_limit",
            session_id="session_limit",
            tool_call_id="call_limit",
            notification_writer=lambda _message: None,
        )


def test_monitor_start_closes_spawned_process_if_manager_closes_during_spawn(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = MonitorManager(runtime_root=tmp_path / "runtime")
    terminated: list[object] = []
    fake_job = SimpleNamespace(
        process=SimpleNamespace(
            returncode=None,
        )
    )

    def fake_spawn(_argv: list[str], *, cwd: Path) -> object:
        assert cwd == tmp_path
        manager.close()
        return fake_job

    def fake_terminate(job: object, *, timeout_seconds: float) -> None:
        assert timeout_seconds > 0
        terminated.append(job)

    monkeypatch.setattr(
        monitor_manager_module,
        "spawn_managed_background_process",
        fake_spawn,
    )
    monkeypatch.setattr(
        monitor_manager_module,
        "terminate_managed_background_process",
        fake_terminate,
    )

    with pytest.raises(ToolExecutionFailure, match="closed"):
        manager.start_monitor(
            command=_instant_command(),
            description="race",
            timeout_ms=5_000,
            persistent=False,
            cwd=tmp_path,
            workspace_root=tmp_path,
            request_id="stream_race",
            trace_id="trace_race",
            session_id="session_race",
            tool_call_id="call_race",
            notification_writer=lambda _message: None,
        )

    assert terminated == [fake_job]


def test_monitor_prunes_old_terminal_status_directories_but_keeps_running(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_root = tmp_path / "runtime"
    monitors_root = runtime_root / "monitors"
    monitors_root.mkdir(parents=True, exist_ok=True)
    manager = MonitorManager(runtime_root=runtime_root)
    monkeypatch.setattr(monitor_manager_module, "MAX_MONITOR_TERMINAL_STATUS_DIRS", 2)

    terminal_dirs: list[Path] = []
    for index in range(4):
        monitor_id = f"mon_{index:012x}"
        monitor_dir = monitors_root / monitor_id
        monitor_dir.mkdir(parents=True, exist_ok=True)
        (monitor_dir / "status.json").write_text(
            json.dumps(_status_payload(monitor_id, state="completed")),
            encoding="utf-8",
        )
        terminal_dirs.append(monitor_dir)
    running_id = "mon_ffffffffffff"
    running_dir = monitors_root / running_id
    running_dir.mkdir(parents=True, exist_ok=True)
    (running_dir / "status.json").write_text(
        json.dumps(_status_payload(running_id, state="running")),
        encoding="utf-8",
    )

    manager._prune_terminal_status_dirs()  # noqa: SLF001

    assert running_dir.exists()
    remaining_terminal_dirs = [path for path in terminal_dirs if path.exists()]
    assert len(remaining_terminal_dirs) == 2
    assert sorted(path.name for path in remaining_terminal_dirs) == [
        "mon_000000000002",
        "mon_000000000003",
    ]


def test_monitor_recovery_prunes_old_stale_status_directories(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_root = tmp_path / "runtime"
    monitors_root = runtime_root / "monitors"
    monitors_root.mkdir(parents=True, exist_ok=True)
    manager = MonitorManager(runtime_root=runtime_root)
    monkeypatch.setattr(monitor_manager_module, "MAX_MONITOR_TERMINAL_STATUS_DIRS", 2)

    stale_dirs: list[Path] = []
    for index in range(4):
        monitor_id = f"mon_{index + 16:012x}"
        monitor_dir = monitors_root / monitor_id
        monitor_dir.mkdir(parents=True, exist_ok=True)
        (monitor_dir / "status.json").write_text(
            json.dumps(_status_payload(monitor_id, state="running")),
            encoding="utf-8",
        )
        stale_dirs.append(monitor_dir)

    recovered = manager.recover_stale_monitors()

    assert recovered == 4
    remaining_stale_dirs = [path for path in stale_dirs if path.exists()]
    assert len(remaining_stale_dirs) == 2
    assert sorted(path.name for path in remaining_stale_dirs) == [
        "mon_000000000012",
        "mon_000000000013",
    ]


def test_clean_monitor_exit_releases_owned_process_lease(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A monitor that exits on its own frees its owned-process capacity lease
    through release (never terminate, which would signal the reaped PID)."""
    released: list[object] = []
    terminated: list[object] = []
    real_release = monitor_manager_module.release_managed_background_process

    def _recording_release(job: object) -> None:
        released.append(job)
        real_release(job)

    monkeypatch.setattr(
        monitor_manager_module, "release_managed_background_process", _recording_release
    )
    monkeypatch.setattr(
        monitor_manager_module,
        "terminate_managed_background_process",
        lambda job, *, timeout_seconds: terminated.append(job),
    )

    manager = MonitorManager(runtime_root=tmp_path / "runtime")
    result = manager.start_monitor(
        command=_instant_command(),
        description="release lease on clean exit",
        timeout_ms=5_000,
        persistent=True,
        cwd=tmp_path,
        workspace_root=tmp_path,
        request_id="release_1",
        trace_id="trace_release_1",
        session_id="session_release_1",
        tool_call_id="call_release_1",
        notification_writer=lambda event: None,
    )

    terminal = _wait_for_terminal(manager, result.monitor_id, timeout_seconds=5)
    assert terminal["state"] == "completed"
    assert len(released) == 1
    assert terminated == []
