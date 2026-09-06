"""Dark-path coverage for sidecar.runtime.monitor_manager.

These tests drive the module's helpers and methods DIRECTLY (never through
``start_monitor``'s background thread, never relying on the 0.25s output-flush
``threading.Timer``). The companion suite ``test_monitor_manager.py`` exercises
the happy path, timeout, batching, stale recovery and active-limit fail-close;
this file only targets the uncovered error/edge regions. No real subprocess is
ever spawned: ``spawn_managed_background_process`` /
``terminate_managed_background_process`` are monkeypatched whenever they could
be reached, and ``_run_monitor`` is invoked with hand-built fake jobs whose
streams are ``None`` so reader threads return instantly.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.protocol import MONITOR_EVENT_METHOD
from sidecar.runtime import monitor_manager as monitor_manager_module
from sidecar.runtime.monitor_manager import (
    DEFAULT_MONITOR_TIMEOUT_MS,
    MAX_MONITOR_EVENT_CHARS,
    MAX_MONITOR_EVENTS,
    MAX_MONITOR_OUTPUT_BATCH,
    MAX_MONITOR_TIMEOUT_MS,
    MIN_MONITOR_TIMEOUT_MS,
    MonitorManager,
    _ActiveMonitor,
    _clip_text,
    _coerce_timeout_ms,
    _redacted_shell_argv,
    _resolve_cwd,
    _shell_argv,
)
from sidecar.runtime.monitor_salience import SalienceVerdict
from sidecar.runtime.monitor_status import MonitorStatusError


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
        "description": "dark-path monitor",
        "state": state,
        "persistent": persistent,
        "timeout_ms": 1_000,
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


class _InProcessSalienceWorker:
    """In-process stand-in for ``MonitorSalienceWorker`` (spawns nothing).

    Runs the monitor's own compiled patterns with the production short-circuit
    order and reports a zero search cost, so the deterministic gate assertions in
    this file never depend on a real spawned child process.
    """

    def __init__(self, active: _ActiveMonitor) -> None:
        self._active = active

    def evaluate(self, text: str, *, timeout_seconds: float) -> SalienceVerdict:
        ignored = any(regex.search(text) for regex in self._active.ignore_patterns)
        matched = False
        if not ignored:
            matched = not self._active.match_patterns or any(
                regex.search(text) for regex in self._active.match_patterns
            )
        return SalienceVerdict(ignored=ignored, matched=matched, elapsed_seconds=0.0)

    def close(self) -> None:
        return None


def _make_manager(tmp_path: Path) -> MonitorManager:
    manager = MonitorManager(runtime_root=tmp_path / "runtime")
    # The salience gate otherwise spawns a real subprocess worker per monitor;
    # these dark-path tests assert the gate's decisions, not its isolation.
    manager._salience_worker_factory = _InProcessSalienceWorker  # noqa: SLF001
    return manager


def _record_path(manager: MonitorManager, monitor_id: str) -> Path:
    return manager._status_store.record_path(monitor_id)  # noqa: SLF001


def _make_active(
    manager: MonitorManager,
    *,
    monitor_id: str = "mon_000000000001",
    notification_writer: object | None = None,
    job: object | None = None,
) -> _ActiveMonitor:
    """Build a real _ActiveMonitor wired to the manager's record dir."""
    return _ActiveMonitor(
        monitor_id=monitor_id,
        description="dark-path monitor",
        timeout_ms=1_000,
        persistent=False,
        cwd=_record_path(manager, monitor_id).parent,
        request_id="req_dark",
        trace_id="trace_dark",
        session_id="session_dark",
        tool_call_id="call_dark",
        notification_writer=notification_writer,
        shell_argv=["sh", "-lc", "echo hi"],
        job=job,
    )


# --------------------------------------------------------------------------
# _clip_text truncation (line 99)
# --------------------------------------------------------------------------
def test_clip_text_truncates_overlong_text_to_limit() -> None:
    raw = "x" * (MAX_MONITOR_EVENT_CHARS + 500)

    clipped = _clip_text(raw)

    # The suffix is appended and the head is sliced to limit-14 so the total
    # is exactly the limit.
    assert clipped.endswith("...[truncated]")
    assert len(clipped) == MAX_MONITOR_EVENT_CHARS
    assert clipped[: MAX_MONITOR_EVENT_CHARS - 14] == "x" * (MAX_MONITOR_EVENT_CHARS - 14)


# --------------------------------------------------------------------------
# _coerce_timeout_ms (lines 104, 106, 113-114, 120, 126)
# --------------------------------------------------------------------------
def test_coerce_timeout_none_returns_default() -> None:
    assert _coerce_timeout_ms(None) == DEFAULT_MONITOR_TIMEOUT_MS


def test_coerce_timeout_bool_raises() -> None:
    # bool is an int subclass; the code rejects it explicitly before int().
    with pytest.raises(ToolExecutionFailure, match="must be an integer") as exc:
        _coerce_timeout_ms(True)
    assert exc.value.retryable is False


def test_coerce_timeout_non_numeric_string_raises() -> None:
    with pytest.raises(ToolExecutionFailure, match="must be an integer"):
        _coerce_timeout_ms("not-a-number")


def test_coerce_timeout_below_minimum_raises() -> None:
    with pytest.raises(ToolExecutionFailure, match="at least"):
        _coerce_timeout_ms(MIN_MONITOR_TIMEOUT_MS - 1)


def test_coerce_timeout_above_maximum_raises() -> None:
    with pytest.raises(ToolExecutionFailure, match="at most"):
        _coerce_timeout_ms(MAX_MONITOR_TIMEOUT_MS + 1)


# --------------------------------------------------------------------------
# _resolve_cwd empty cwd -> root (line 139)
# --------------------------------------------------------------------------
def test_resolve_cwd_empty_returns_workspace_root(tmp_path: Path) -> None:
    workspace_root = tmp_path / "ws"
    workspace_root.mkdir()

    resolved = _resolve_cwd("   ", workspace_root)

    assert resolved == workspace_root.resolve(strict=False)


def test_resolve_cwd_none_returns_workspace_root(tmp_path: Path) -> None:
    workspace_root = tmp_path / "ws2"
    workspace_root.mkdir()

    resolved = _resolve_cwd(None, workspace_root)

    assert resolved == workspace_root.resolve(strict=False)


# --------------------------------------------------------------------------
# _shell_argv non-nt branch (lines 152-153) + _redacted_shell_argv (158, 161)
# --------------------------------------------------------------------------
def test_shell_argv_posix_uses_lc(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(monitor_manager_module.os, "name", "posix")
    monkeypatch.setattr(
        monitor_manager_module.shutil, "which", lambda _name: "/bin/bash"
    )

    argv = _shell_argv("printf hi")

    assert argv == ["/bin/bash", "-lc", "printf hi"]


def test_shell_argv_posix_falls_back_to_sh(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(monitor_manager_module.os, "name", "posix")
    monkeypatch.setattr(monitor_manager_module.shutil, "which", lambda _name: None)

    argv = _shell_argv("printf hi")

    assert argv == ["sh", "-lc", "printf hi"]


def test_redacted_shell_argv_empty_returns_empty() -> None:
    assert _redacted_shell_argv([]) == []


def test_redacted_shell_argv_posix_keeps_two_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(monitor_manager_module.os, "name", "posix")

    redacted = _redacted_shell_argv(["bash", "-lc", "secret command here"])

    assert redacted == ["bash", "-lc", "<command>"]


# --------------------------------------------------------------------------
# _build_active_monitor empty command -> raise (line 230)
# --------------------------------------------------------------------------
def test_build_active_monitor_empty_command_raises_before_spawn(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)

    def fail_spawn(*_a: object, **_k: object) -> object:
        raise AssertionError("spawn must not be reached for an empty command")

    monkeypatch.setattr(
        monitor_manager_module, "spawn_managed_background_process", fail_spawn
    )

    with pytest.raises(ToolExecutionFailure, match="non-empty string") as exc:
        manager.start_monitor(
            command="   ",
            description="empty",
            timeout_ms=1_000,
            persistent=False,
            cwd=tmp_path,
            workspace_root=tmp_path,
            request_id="r",
            trace_id="t",
            session_id="s",
            tool_call_id="c",
            notification_writer=lambda _m: None,
        )
    assert exc.value.retryable is False


# --------------------------------------------------------------------------
# _reserve_monitor_start closed -> _raise_start_closed (266, 272-273)
# --------------------------------------------------------------------------
def test_reserve_monitor_start_when_closed_marks_failed_and_raises(
    tmp_path: Path,
) -> None:
    manager = _make_manager(tmp_path)
    manager._closed = True  # noqa: SLF001
    active = _make_active(manager)

    with pytest.raises(ToolExecutionFailure, match="closed") as exc:
        manager._reserve_monitor_start(active)  # noqa: SLF001

    assert exc.value.retryable is False
    # _mark_start_failed ran: terminal state + event set + status persisted.
    assert active.state == "failed"
    assert active.terminal_reason == "shutdown"
    assert active.terminal_event.is_set()
    status = json.loads(
        (_record_path(manager, active.monitor_id) / "status.json").read_text(encoding="utf-8")
    )
    assert status["state"] == "failed"
    assert status["terminal"] is True


# --------------------------------------------------------------------------
# _spawn_monitor_process failure (lines 313-317)
# --------------------------------------------------------------------------
def test_spawn_monitor_process_failure_marks_failed_and_decrements(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)
    manager._starting_count = 1  # noqa: SLF001 - reserved one start slot

    def boom(*_a: object, **_k: object) -> object:
        raise OSError("cannot exec")

    monkeypatch.setattr(
        monitor_manager_module, "spawn_managed_background_process", boom
    )

    with pytest.raises(ToolExecutionFailure, match="failed to start: OSError") as exc:
        manager._spawn_monitor_process(active)  # noqa: SLF001

    assert exc.value.retryable is True
    assert manager._starting_count == 0  # noqa: SLF001 - decremented on failure
    assert active.state == "failed"
    assert active.terminal_reason == "spawn_failed"


# --------------------------------------------------------------------------
# recover_stale_monitors error branches (400-401, 404, 408-409, 423-424)
# --------------------------------------------------------------------------
def test_recover_stale_monitors_iterdir_oserror_returns_zero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)

    monkeypatch.setattr(
        manager._status_store,  # noqa: SLF001
        "list_record_ids",
        lambda: (_ for _ in ()).throw(MonitorStatusError("scan failed")),
    )

    assert manager.recover_stale_monitors() == 0


def test_recover_stale_monitors_skips_non_dir_and_bad_json(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    # A plain file (non-dir) inside the monitors root -> skipped at 404.
    (_record_path(manager, "mon_000000000005").parent / "stray.txt").write_text(
        "x", encoding="utf-8"
    )
    # A dir with invalid JSON -> skipped at 408-409.
    bad_dir = _record_path(manager, "mon_000000000005")
    bad_dir.mkdir()
    (bad_dir / "status.json").write_text("{not json", encoding="utf-8")

    # Nothing recoverable -> 0, and no exception raised.
    assert manager.recover_stale_monitors() == 0


def test_recover_stale_monitors_write_oserror_is_logged_not_raised(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    monitor_id = "mon_000000000006"
    monitor_dir = _record_path(manager, monitor_id)
    monitor_dir.mkdir()
    (monitor_dir / "status.json").write_text(
        json.dumps(_status_payload(monitor_id, state="running")),
        encoding="utf-8",
    )

    logged: list[dict[str, object]] = []
    monkeypatch.setattr(
        monitor_manager_module,
        "log_event",
        lambda *a, **k: logged.append(k),
    )

    def boom_write(_monitor_id: object, _payload: dict[str, object]) -> None:
        raise MonitorStatusError("disk full")

    monkeypatch.setattr(manager._status_store, "write", boom_write)  # noqa: SLF001

    recovered = manager.recover_stale_monitors()

    # The write failed for the only candidate, so nothing was counted.
    assert recovered == 0
    assert any(
        entry.get("event") == "monitor.stale_recovery_failed" for entry in logged
    )


# --------------------------------------------------------------------------
# close() terminating an injected fake with job=None (line 442)
# --------------------------------------------------------------------------
def test_close_terminates_active_monitor_with_no_job(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    notifications: list[dict[str, object]] = []
    active = _make_active(
        manager,
        monitor_id="mon_000000000007",
        notification_writer=notifications.append,
        job=None,
    )
    manager._active[active.monitor_id] = active  # noqa: SLF001

    manager.close()

    assert manager._closed is True  # noqa: SLF001
    # _terminate_active(reason="shutdown") -> _finish_active -> terminal notify.
    assert active.state == "failed"
    assert active.terminal_reason == "shutdown"
    assert active.terminal_event.is_set()
    assert any(
        note["params"].get("terminal_reason") == "shutdown"
        and note["params"].get("kind") == "terminal"
        for note in notifications
    )


# --------------------------------------------------------------------------
# _run_monitor direct: nonzero exit -> failed (480-481)
# --------------------------------------------------------------------------
def test_run_monitor_nonzero_exit_marks_failed(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    notifications: list[dict[str, object]] = []
    # stdout/stderr None so reader threads return immediately (512).
    process = SimpleNamespace(
        stdout=None,
        stderr=None,
        returncode=3,
        wait=lambda timeout=None: 3,
    )
    job = SimpleNamespace(process=process, owned_process=None, job_object=None)
    active = _make_active(
        manager,
        monitor_id="mon_000000000009",
        notification_writer=notifications.append,
        job=job,
    )
    manager._active[active.monitor_id] = active  # noqa: SLF001

    manager._run_monitor(active)  # noqa: SLF001

    assert active.state == "failed"
    assert active.terminal_reason == "exit"
    assert active.exit_code == 3
    assert active.success is False
    assert any(
        note["params"].get("state") == "failed"
        and note["params"].get("terminal_reason") == "exit"
        for note in notifications
    )


# --------------------------------------------------------------------------
# _run_monitor direct: wait raises -> process_error (488-493)
# --------------------------------------------------------------------------
def test_run_monitor_wait_raises_marks_process_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    terminated: list[object] = []
    monkeypatch.setattr(
        monitor_manager_module,
        "terminate_managed_background_process",
        lambda job, *, timeout_seconds: terminated.append(job),
    )

    def boom_wait(timeout: float | None = None) -> int:
        raise RuntimeError("wait exploded")

    process = SimpleNamespace(
        stdout=None,
        stderr=None,
        returncode=-9,
        wait=boom_wait,
    )
    job = SimpleNamespace(process=process)
    active = _make_active(manager, monitor_id="mon_00000000000a", job=job)
    manager._active[active.monitor_id] = active  # noqa: SLF001

    manager._run_monitor(active)  # noqa: SLF001

    assert terminated == [job]  # the generic-exception branch terminates the job
    assert active.state == "failed"
    assert active.terminal_reason == "process_error"
    assert active.exit_code == -9
    assert active.success is False


# --------------------------------------------------------------------------
# _read_stream: None stream returns (512); iterating raises -> log (516-517)
# --------------------------------------------------------------------------
def test_read_stream_none_is_noop(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)

    # Should not raise and should not record anything.
    manager._read_stream(active, "stdout", None)  # noqa: SLF001

    assert active.events == []
    assert active.sequence == 0


def test_read_stream_iteration_error_is_logged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)

    logged: list[dict[str, object]] = []
    monkeypatch.setattr(
        monitor_manager_module, "log_event", lambda *a, **k: logged.append(k)
    )

    class ExplodingStream:
        def __iter__(self) -> "ExplodingStream":
            return self

        def __next__(self) -> str:
            raise OSError("stream broke")

    manager._read_stream(active, "stderr", ExplodingStream())  # noqa: SLF001

    assert any(
        entry.get("event") == "monitor.stream_read_failed"
        and entry.get("data", {}).get("stream") == "stderr"
        for entry in logged
    )


# --------------------------------------------------------------------------
# _record_output_event: empty text -> return (532)
# --------------------------------------------------------------------------
def test_record_output_event_empty_text_is_dropped(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)

    manager._record_output_event(active, stream="stdout", text="\r\n")  # noqa: SLF001

    assert active.events == []
    assert active.sequence == 0
    assert active.event_count == 0


# --------------------------------------------------------------------------
# _record_output_event: event cap drop (547-549) + synchronous batch (552, 563-564)
# --------------------------------------------------------------------------
def test_record_output_event_drops_oldest_beyond_cap_and_flushes_synchronously(
    tmp_path: Path,
) -> None:
    manager = _make_manager(tmp_path)
    notifications: list[dict[str, object]] = []
    active = _make_active(
        manager,
        monitor_id="mon_00000000000b",
        notification_writer=notifications.append,
    )

    # Pre-seed the rolling buffer at the cap so the next append overflows.
    for i in range(MAX_MONITOR_EVENTS):
        active.events.append({"sequence": i, "kind": "output", "text": f"old{i}"})

    # Append exactly MAX_MONITOR_OUTPUT_BATCH events synchronously. Each call
    # takes active.lock, appends to events and pending_output_events, and the
    # final one trips len(pending) >= batch -> _take_pending_output_batch_locked
    # WITHOUT ever arming the 0.25s flush timer (that elif is never reached
    # because batch is taken first). This drives 547-549 (cap drop) and the
    # synchronous-flush path 552/563-564 deterministically.
    for i in range(MAX_MONITOR_OUTPUT_BATCH):
        manager._record_output_event(  # noqa: SLF001
            active, stream="stdout", text=f"line-{i}"
        )

    # The rolling buffer never grows past the cap.
    assert len(active.events) == MAX_MONITOR_EVENTS
    # We appended 20 events to a buffer already at the cap -> 20 dropped.
    assert active.dropped_event_count == MAX_MONITOR_OUTPUT_BATCH
    # No flush timer was ever armed (synchronous batch path).
    assert active.output_flush_timer is None
    # pending buffer was drained by the synchronous batch take.
    assert active.pending_output_events == []
    # Exactly one output_batch notification carrying all 20 events.
    output_batches = [
        note["params"]
        for note in notifications
        if note.get("method") == MONITOR_EVENT_METHOD
        and note["params"].get("kind") == "output_batch"
    ]
    assert len(output_batches) == 1
    assert len(output_batches[0]["events"]) == MAX_MONITOR_OUTPUT_BATCH
    assert [e["text"] for e in output_batches[0]["events"]] == [
        f"line-{i}" for i in range(MAX_MONITOR_OUTPUT_BATCH)
    ]


# --------------------------------------------------------------------------
# _terminate_active with job present -> terminate (595-598)
# --------------------------------------------------------------------------
def test_terminate_active_with_job_calls_terminate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    terminated: list[object] = []
    monkeypatch.setattr(
        monitor_manager_module,
        "terminate_managed_background_process",
        lambda job, *, timeout_seconds: terminated.append((job, timeout_seconds)),
    )
    process = SimpleNamespace(returncode=7)
    job = SimpleNamespace(process=process)
    active = _make_active(manager, monitor_id="mon_00000000000c", job=job)
    manager._active[active.monitor_id] = active  # noqa: SLF001

    manager._terminate_active(active, reason="cancelled")  # noqa: SLF001

    assert terminated == [(job, 1.0)]
    assert active.state == "cancelled"
    assert active.exit_code == 7  # taken from job.process.returncode


# --------------------------------------------------------------------------
# _finish_active: already-terminal early return (618) + timer cancel (620-621)
# --------------------------------------------------------------------------
def test_finish_active_returns_early_when_already_terminal(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    notifications: list[dict[str, object]] = []
    active = _make_active(
        manager,
        monitor_id="mon_00000000000d",
        notification_writer=notifications.append,
    )
    active.terminal_event.set()
    active.state = "completed"

    manager._finish_active(  # noqa: SLF001
        active,
        state="failed",
        terminal_reason="should_not_apply",
        exit_code=99,
        success=False,
    )

    # Early return: state untouched, no terminal notification emitted.
    assert active.state == "completed"
    assert active.terminal_reason is None
    assert not any(
        note["params"].get("kind") == "terminal" for note in notifications
    )


def test_finish_active_cancels_pending_flush_timer(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager, monitor_id="mon_00000000000e")

    cancelled: list[bool] = []

    class FakeTimer:
        def cancel(self) -> None:
            cancelled.append(True)

    active.output_flush_timer = FakeTimer()  # type: ignore[assignment]

    manager._finish_active(  # noqa: SLF001
        active,
        state="completed",
        terminal_reason="exit",
        exit_code=0,
        success=True,
    )

    assert cancelled == [True]
    assert active.output_flush_timer is None
    assert active.state == "completed"
    assert active.terminal_event.is_set()


def test_finish_active_claims_terminal_once_and_rejects_late_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager, monitor_id="mon_00000000001d")
    manager._active[active.monitor_id] = active  # noqa: SLF001
    persisted: list[str] = []
    notifications: list[dict[str, object]] = []
    monkeypatch.setattr(
        manager,
        "_safe_write_status",
        lambda current: persisted.append(current.state),
    )
    monkeypatch.setattr(manager, "_prune_terminal_status_dirs", lambda: None)
    monkeypatch.setattr(
        manager,
        "_notify",
        lambda _active, event: notifications.append(dict(event)),
    )
    barrier = threading.Barrier(3)

    def finish(state: str, reason: str) -> None:
        barrier.wait()
        manager._finish_active(  # noqa: SLF001
            active,
            state=state,
            terminal_reason=reason,
            exit_code=0 if state == "completed" else 1,
            success=state == "completed",
        )

    workers = [
        threading.Thread(target=finish, args=("completed", "exit")),
        threading.Thread(target=finish, args=("failed", "process_error")),
    ]
    for worker in workers:
        worker.start()
    barrier.wait()
    for worker in workers:
        worker.join(timeout=1.0)

    assert all(not worker.is_alive() for worker in workers)
    assert active.terminal_event.is_set()
    assert len(persisted) == 1
    terminal_events = [event for event in notifications if event.get("kind") == "terminal"]
    assert len(terminal_events) == 1
    assert active.sequence == 1
    assert active.monitor_id not in manager._active  # noqa: SLF001

    manager._record_output_event(  # noqa: SLF001
        active,
        stream="stdout",
        text="late output",
    )
    assert active.sequence == 1
    assert active.event_count == 0
    assert active.events == []


# --------------------------------------------------------------------------
# _notify: writer None -> return (681); writer raising -> log (694-695)
# --------------------------------------------------------------------------
def test_notify_no_writer_is_noop(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager, notification_writer=None)

    # Spy on notification(): the None-writer guard must short-circuit BEFORE the
    # notification envelope is ever constructed. If the guard is removed, the
    # code falls through to ``writer(notification(...))`` -> notification() runs
    # (and then None(...) raises), so a recorded call here proves the guard ran.
    built: list[tuple[object, object]] = []
    original_notification = monitor_manager_module.notification

    def spy_notification(method: object, params: object) -> object:
        built.append((method, params))
        return original_notification(method, params)

    monkeypatch.setattr(monitor_manager_module, "notification", spy_notification)

    # No writer -> returns early without building or dispatching anything.
    result = manager._notify(active, {"kind": "terminal"})  # noqa: SLF001

    assert result is None
    assert built == []


def test_notify_writer_exception_is_logged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)

    def boom_writer(_message: dict[str, object]) -> None:
        raise RuntimeError("sink down")

    active = _make_active(
        manager, monitor_id="mon_00000000000f", notification_writer=boom_writer
    )

    logged: list[dict[str, object]] = []
    monkeypatch.setattr(
        monitor_manager_module, "log_event", lambda *a, **k: logged.append(k)
    )

    manager._notify(active, {"kind": "output_batch"})  # noqa: SLF001

    assert any(
        entry.get("event") == "monitor.notification_failed" for entry in logged
    )


def test_notify_builds_expected_params_for_real_writer(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    notifications: list[dict[str, object]] = []
    active = _make_active(
        manager, monitor_id="mon_000000000010", notification_writer=notifications.append
    )
    active.state = "running"

    manager._notify(active, {"kind": "output_batch", "sequence": 5})  # noqa: SLF001

    assert len(notifications) == 1
    note = notifications[0]
    assert note["method"] == MONITOR_EVENT_METHOD
    params = note["params"]
    assert params["monitor_id"] == "mon_000000000010"
    assert params["request_id"] == "req_dark"
    assert params["trace_id"] == "trace_dark"
    assert params["session_id"] == "session_dark"
    assert params["tool_call_id"] == "call_dark"
    assert params["state"] == "running"
    assert params["kind"] == "output_batch"
    assert params["sequence"] == 5


# --------------------------------------------------------------------------
# _safe_write_status: OSError -> log + early return (716-717, 728)
# --------------------------------------------------------------------------
def test_safe_write_status_oserror_is_logged_and_skips_prune(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager, monitor_id="mon_000000000011")

    logged: list[dict[str, object]] = []
    monkeypatch.setattr(
        monitor_manager_module, "log_event", lambda *a, **k: logged.append(k)
    )

    def boom_write(_active: object) -> None:
        raise OSError("write denied")

    monkeypatch.setattr(manager, "_write_status", boom_write)

    pruned: list[bool] = []
    monkeypatch.setattr(
        manager, "_prune_terminal_status_dirs", lambda: pruned.append(True)
    )

    manager._safe_write_status(active)  # noqa: SLF001

    assert any(
        entry.get("event") == "monitor.status_persist_failed" for entry in logged
    )
    # Early return at 728 means prune is NOT called on the failure path.
    assert pruned == []


# --------------------------------------------------------------------------
# _raise_if_closed raise (line 735)
# --------------------------------------------------------------------------
def test_raise_if_closed_raises_when_closed(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    manager._closed = True  # noqa: SLF001

    with pytest.raises(ToolExecutionFailure, match="closed") as exc:
        manager._raise_if_closed()  # noqa: SLF001
    assert exc.value.retryable is False


# --------------------------------------------------------------------------
# _read_status: empty id -> None (753-756); bad json -> None (759-761)
# --------------------------------------------------------------------------
def test_read_status_empty_id_is_typed_failure(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)

    with pytest.raises(ToolExecutionFailure, match="invalid or unsafe"):
        manager._read_status("")  # noqa: SLF001


def test_read_status_bad_json_is_typed_failure(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    monitor_id = "mon_000000000012"
    monitor_dir = _record_path(manager, monitor_id)
    monitor_dir.mkdir(parents=True)
    (monitor_dir / "status.json").write_text("{broken", encoding="utf-8")

    with pytest.raises(ToolExecutionFailure, match="invalid or unsafe"):
        manager._read_status(monitor_id)  # noqa: SLF001


def test_read_status_non_dict_payload_is_typed_failure(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    monitor_id = "mon_000000000013"
    monitor_dir = _record_path(manager, monitor_id)
    monitor_dir.mkdir(parents=True)
    (monitor_dir / "status.json").write_text("[1, 2, 3]", encoding="utf-8")

    with pytest.raises(ToolExecutionFailure, match="invalid or unsafe"):
        manager._read_status(monitor_id)  # noqa: SLF001


# --------------------------------------------------------------------------
# _prune_terminal_status_dirs: limit <= 0 -> return (766)
# --------------------------------------------------------------------------
def test_prune_limit_zero_is_noop(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    monkeypatch.setattr(
        monitor_manager_module, "MAX_MONITOR_TERMINAL_STATUS_DIRS", 0
    )
    # Create a terminal dir that WOULD be pruned if the limit were active.
    monitor_id = "mon_000000000014"
    monitor_dir = _record_path(manager, monitor_id)
    monitor_dir.mkdir(parents=True)
    (monitor_dir / "status.json").write_text(
        json.dumps(_status_payload(monitor_id, state="completed")),
        encoding="utf-8",
    )

    manager._prune_terminal_status_dirs()  # noqa: SLF001

    # limit<=0 short-circuits before scanning, so the dir survives.
    assert monitor_dir.exists()


# --------------------------------------------------------------------------
# _prune_terminal_status_dirs: rmtree OSError -> log (778-779)
# --------------------------------------------------------------------------
def test_prune_rmtree_oserror_is_logged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    monkeypatch.setattr(
        monitor_manager_module, "MAX_MONITOR_TERMINAL_STATUS_DIRS", 1
    )
    # Two terminal dirs over a limit of 1 -> one is selected for rmtree.
    for index in range(2):
        monitor_id = f"mon_{index + 32:012x}"
        monitor_dir = _record_path(manager, monitor_id)
        monitor_dir.mkdir(parents=True)
        (monitor_dir / "status.json").write_text(
            json.dumps(_status_payload(monitor_id, state="completed")),
            encoding="utf-8",
        )

    logged: list[dict[str, object]] = []
    monkeypatch.setattr(
        monitor_manager_module, "log_event", lambda *a, **k: logged.append(k)
    )

    def boom_delete(_monitor_id: object) -> None:
        raise MonitorStatusError("delete denied")

    monkeypatch.setattr(manager._status_store, "delete_record", boom_delete)  # noqa: SLF001

    manager._prune_terminal_status_dirs()  # noqa: SLF001

    assert any(
        entry.get("event") == "monitor.status_prune_failed" for entry in logged
    )


# --------------------------------------------------------------------------
# _monitor_record_dirs: iterdir OSError -> [] (792-793)
# --------------------------------------------------------------------------
def test_monitor_record_dirs_oserror_returns_empty(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)

    monkeypatch.setattr(
        manager._status_store,  # noqa: SLF001
        "list_record_ids",
        lambda: (_ for _ in ()).throw(MonitorStatusError("listing failed")),
    )

    assert manager._monitor_record_dirs() == []  # noqa: SLF001


# --------------------------------------------------------------------------
# prune candidate: not-dir (822); stat OSError (832-833); read decode (838-839)
# --------------------------------------------------------------------------
def test_prune_candidate_non_dir_returns_none(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    stray = _record_path(manager, "mon_000000000015").parent / "plain.txt"
    stray.write_text("x", encoding="utf-8")

    candidate = manager._terminal_status_prune_candidate(stray, set())  # noqa: SLF001

    assert candidate is None


def test_prune_candidate_stat_oserror_returns_none(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = _make_manager(tmp_path)
    monitor_id = "mon_000000000015"
    monitor_dir = _record_path(manager, monitor_id)
    monitor_dir.mkdir()
    (monitor_dir / "status.json").write_text(
        json.dumps(_status_payload(monitor_id, state="completed")),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        manager._status_store,  # noqa: SLF001
        "read_with_mtime",
        lambda _monitor_id: (_ for _ in ()).throw(MonitorStatusError("stat denied")),
    )

    candidate = manager._terminal_status_prune_candidate(  # noqa: SLF001
        monitor_dir, set()
    )

    assert candidate is None


# --------------------------------------------------------------------------
# Deterministic salience gating in _record_output_event
# --------------------------------------------------------------------------
def _drain_timer(active: _ActiveMonitor) -> None:
    """Cancel any output-flush timer armed by a sub-batch emit (test hygiene)."""
    if active.output_flush_timer is not None:
        active.output_flush_timer.cancel()
        active.output_flush_timer = None


def test_gate_match_patterns_emits_only_matches(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)
    active.match_patterns = [re.compile("ERROR", re.IGNORECASE)]

    for line in ["ERROR boom", "info ok", "another error", "debug noise"]:
        manager._record_output_event(active, stream="stdout", text=line)  # noqa: SLF001
    _drain_timer(active)

    assert [event["text"] for event in active.events] == ["ERROR boom", "another error"]
    assert active.event_count == 4
    assert active.suppressed_event_count == 2
    assert active.sequence == 2
    # Honest-counting invariant: every line is counted; emitted advance sequence.
    assert active.event_count == active.sequence + active.suppressed_event_count


def test_gate_ignore_patterns_suppress_matches(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)
    active.ignore_patterns = [re.compile("heartbeat")]

    for line in ["start", "heartbeat 1", "heartbeat 2", "done"]:
        manager._record_output_event(active, stream="stdout", text=line)  # noqa: SLF001
    _drain_timer(active)

    assert [event["text"] for event in active.events] == ["start", "done"]
    assert active.suppressed_event_count == 2
    assert active.event_count == active.sequence + active.suppressed_event_count


def test_gate_ignore_beats_match(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)
    active.match_patterns = [re.compile("task")]
    active.ignore_patterns = [re.compile("skip")]

    for line in ["task go", "task skip", "other", "task again"]:
        manager._record_output_event(active, stream="stdout", text=line)  # noqa: SLF001
    _drain_timer(active)

    # "task skip" suppressed by ignore; "other" suppressed by match-miss.
    assert [event["text"] for event in active.events] == ["task go", "task again"]
    assert active.suppressed_event_count == 2


def test_gate_dedupe_collapses_consecutive(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)
    active.dedupe = True

    for line in ["a", "a", "a", "b", "a"]:
        manager._record_output_event(active, stream="stdout", text=line)  # noqa: SLF001
    _drain_timer(active)

    # Consecutive identical emitted lines collapse; the trailing "a" follows "b".
    assert [event["text"] for event in active.events] == ["a", "b", "a"]
    assert active.suppressed_event_count == 2


def test_gate_dedupe_is_per_stream(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)
    active.dedupe = True

    manager._record_output_event(active, stream="stdout", text="x")  # noqa: SLF001
    manager._record_output_event(active, stream="stderr", text="x")  # noqa: SLF001
    manager._record_output_event(active, stream="stdout", text="x")  # noqa: SLF001
    _drain_timer(active)

    # stdout-x and stderr-x both emit; the second stdout-x is a per-stream dup.
    assert len(active.events) == 2
    assert active.suppressed_event_count == 1


def test_gate_suppressed_not_counted_as_dropped(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)
    active.match_patterns = [re.compile("keep")]

    emitted = MAX_MONITOR_EVENTS + 5
    for index in range(emitted):
        manager._record_output_event(active, stream="stdout", text=f"keep {index}")  # noqa: SLF001
    for index in range(3):
        manager._record_output_event(active, stream="stdout", text=f"drop {index}")  # noqa: SLF001
    _drain_timer(active)

    assert active.sequence == emitted                      # emitted lines
    assert active.dropped_event_count == 5                 # emitted overflow beyond the ring
    assert active.suppressed_event_count == 3              # match-miss, never "dropped"
    assert len(active.events) == MAX_MONITOR_EVENTS
    assert active.event_count == active.sequence + active.suppressed_event_count


def test_gate_counts_surface_in_metadata_and_terminal(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager)
    active.ignore_patterns = [re.compile("noise")]

    for line in ["keep", "noise", "noise"]:
        manager._record_output_event(active, stream="stdout", text=line)  # noqa: SLF001
    _drain_timer(active)

    assert manager._metadata(active)["suppressed_event_count"] == 2  # noqa: SLF001
    assert manager._terminal_status(active)["suppressed_event_count"] == 2  # noqa: SLF001


def test_build_active_monitor_rejects_catastrophic_pattern(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    with pytest.raises(ToolExecutionFailure, match="catastrophic"):
        manager._build_active_monitor(  # noqa: SLF001
            command="echo hi",
            description="d",
            timeout_ms=1_000,
            persistent=False,
            cwd=None,
            workspace_root=str(tmp_path),
            match_patterns=["(a+)+$"],
            request_id="r",
            trace_id="t",
            session_id="s",
            tool_call_id="c",
            notification_writer=None,
        )


def test_build_active_monitor_rejects_invalid_regex(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    with pytest.raises(ToolExecutionFailure, match="invalid regex"):
        manager._build_active_monitor(  # noqa: SLF001
            command="echo hi",
            description="d",
            timeout_ms=1_000,
            persistent=False,
            cwd=None,
            workspace_root=str(tmp_path),
            ignore_patterns=["["],
            request_id="r",
            trace_id="t",
            session_id="s",
            tool_call_id="c",
            notification_writer=None,
        )


# --------------------------------------------------------------------------
# poll_monitor: incremental digest, not-found, blocking wait, terminal-from-disk
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "monitor_id",
    [
        "../outside",
        "mon_abcdef012345/../../outside",
        "mon_abcdef012345\\outside",
        "C:\\outside",
        "\\\\server\\share",
        "mon_ABCDEF012345",
    ],
)
def test_monitor_public_lookups_reject_noncanonical_ids(
    tmp_path: Path,
    monitor_id: str,
) -> None:
    manager = _make_manager(tmp_path)

    with pytest.raises(ToolExecutionFailure, match=r"mon_\[0-9a-f\]"):
        manager.poll_monitor(monitor_id)


def test_poll_monitor_unknown_id_returns_not_found(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)

    digest = manager.poll_monitor("mon_000000000018", since_sequence=0)

    assert digest["state"] == "not_found"
    assert digest["terminal"] is True
    assert digest["new_event_count"] == 0


def test_poll_monitor_incremental_cursor(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager, monitor_id="mon_000000000019")
    manager._active[active.monitor_id] = active  # noqa: SLF001
    for line in ["a", "b"]:
        manager._record_output_event(active, stream="stdout", text=line)  # noqa: SLF001
    _drain_timer(active)

    first = manager.poll_monitor(active.monitor_id, since_sequence=0)
    assert first["new_event_count"] == 2
    assert [event["text"] for event in first["new_events"]] == ["a", "b"]
    assert first["cursor"] == 2

    manager._record_output_event(active, stream="stdout", text="c")  # noqa: SLF001
    _drain_timer(active)
    second = manager.poll_monitor(active.monitor_id, since_sequence=first["cursor"])
    assert second["new_event_count"] == 1
    assert [event["text"] for event in second["new_events"]] == ["c"]
    assert second["cursor"] == 3


def test_poll_monitor_nonblocking_empty(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager, monitor_id="mon_00000000001a")
    manager._active[active.monitor_id] = active  # noqa: SLF001

    digest = manager.poll_monitor(active.monitor_id, since_sequence=0, wait_ms=0)

    assert digest["new_event_count"] == 0
    assert digest["terminal"] is False
    assert digest["cursor"] == 0


def test_poll_monitor_wait_times_out_without_events(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager, monitor_id="mon_00000000001b")
    manager._active[active.monitor_id] = active  # noqa: SLF001

    # Exercises the blocking-wait loop; returns an empty digest once the deadline
    # passes (no events arrive, never terminal) without hanging or raising.
    digest = manager.poll_monitor(active.monitor_id, since_sequence=0, wait_ms=60)

    assert digest["new_event_count"] == 0
    assert digest["terminal"] is False


def test_poll_monitor_after_finish_serves_terminal_from_disk(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)
    active = _make_active(manager, monitor_id="mon_00000000001c")
    active.match_patterns = [re.compile("keep")]
    manager._active[active.monitor_id] = active  # noqa: SLF001
    for line in ["keep 1", "skip", "keep 2"]:
        manager._record_output_event(active, stream="stdout", text=line)  # noqa: SLF001

    manager._finish_active(  # noqa: SLF001
        active,
        state="completed",
        terminal_reason="exit",
        exit_code=0,
        success=True,
    )

    # The monitor is popped from the active map; the digest must come from the
    # status.json written by _finish_active (the riskiest poll path).
    assert active.monitor_id not in manager._active  # noqa: SLF001
    digest = manager.poll_monitor(active.monitor_id, since_sequence=0)
    assert digest["terminal"] is True
    assert digest["state"] == "completed"
    assert [event["text"] for event in digest["new_events"]] == ["keep 1", "keep 2"]
    assert digest["suppressed_event_count"] == 1
    assert digest["event_count"] == 3


# --------------------------------------------------------------------------
# _is_terminal_status_payload: running + terminal=True -> True (844)
# --------------------------------------------------------------------------
def test_is_terminal_status_payload_none_is_false(tmp_path: Path) -> None:
    manager = _make_manager(tmp_path)

    assert manager._is_terminal_status_payload(None) is False  # noqa: SLF001


def test_is_terminal_status_payload_running_but_terminal_flag_true(
    tmp_path: Path,
) -> None:
    manager = _make_manager(tmp_path)

    # state still "running" but terminal flag set -> treated as terminal (844).
    assert (
        manager._is_terminal_status_payload(  # noqa: SLF001
            {"state": "running", "terminal": True}
        )
        is True
    )


def test_is_terminal_status_payload_running_not_terminal_is_false(
    tmp_path: Path,
) -> None:
    manager = _make_manager(tmp_path)

    assert (
        manager._is_terminal_status_payload(  # noqa: SLF001
            {"state": "running", "terminal": False}
        )
        is False
    )
