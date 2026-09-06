from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime import monitor_manager as monitor_manager_module
from sidecar.runtime import monitor_manager_streaming as streaming_module
from sidecar.runtime.monitor_manager import MonitorManager


def _active_monitor(manager: MonitorManager, tmp_path: Path, job: object):
    active = manager._build_active_monitor(  # noqa: SLF001
        command="echo hi",
        description="startup failure",
        timeout_ms=5_000,
        persistent=True,
        cwd=tmp_path,
        workspace_root=tmp_path,
        request_id="request-1",
        trace_id="trace-1",
        session_id="session-1",
        tool_call_id="call-1",
        notification_writer=None,
    )
    active.job = job
    manager._active[active.monitor_id] = active  # noqa: SLF001
    return active


def test_monitor_runner_thread_start_failure_rolls_back_active_process(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = SimpleNamespace(stdout=None, stderr=None, returncode=-9)
    job = SimpleNamespace(process=process)
    terminated: list[object] = []

    class _FailingThread:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            _ = (args, kwargs)

        def start(self) -> None:
            raise RuntimeError("runner start failed")

    monkeypatch.setattr(monitor_manager_module, "spawn_managed_background_process", lambda *a, **k: job)
    monkeypatch.setattr(monitor_manager_module.threading, "Thread", _FailingThread)

    def _record_termination(owned: object, *, timeout_seconds: float) -> None:
        _ = timeout_seconds
        terminated.append(owned)

    monkeypatch.setattr(
        monitor_manager_module,
        "terminate_managed_background_process",
        _record_termination,
    )
    manager = MonitorManager(runtime_root=tmp_path / "runtime")

    with pytest.raises(ToolExecutionFailure, match="monitor runner failed to start"):
        manager.start_monitor(
            command="echo hi",
            description="runner startup failure",
            timeout_ms=5_000,
            persistent=True,
            cwd=tmp_path,
            workspace_root=tmp_path,
            request_id="request-1",
            trace_id="trace-1",
            session_id="session-1",
            tool_call_id="call-1",
            notification_writer=None,
        )

    assert terminated == [job]
    assert manager._active == {}  # noqa: SLF001
    monitor_ids = manager._status_store.list_record_ids()  # noqa: SLF001
    assert len(monitor_ids) == 1
    status = manager._status_store.read(monitor_ids[0])  # noqa: SLF001
    assert status is not None
    assert status["state"] == "failed"
    assert status["terminal_reason"] == "process_error"
    assert status["success"] is False


def test_reader_thread_start_failure_terminates_and_settles_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wait_calls: list[float] = []
    def _record_wait(timeout: float) -> None:
        wait_calls.append(timeout)

    process = SimpleNamespace(
        stdout=object(), stderr=object(), returncode=-9, wait=_record_wait
    )
    job = SimpleNamespace(process=process)
    terminated: list[object] = []
    threads: list[Any] = []

    class _ReaderThread:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            _ = (args, kwargs)
            self.index = len(threads)
            self.join_calls: list[float] = []
            threads.append(self)

        def start(self) -> None:
            if self.index == 1:
                raise RuntimeError("reader start failed")

        def join(self, timeout: float) -> None:
            self.join_calls.append(timeout)

    monkeypatch.setattr(streaming_module.threading, "Thread", _ReaderThread)

    def _record_termination(owned: object, *, timeout_seconds: float) -> None:
        _ = timeout_seconds
        terminated.append(owned)

    monkeypatch.setattr(
        monitor_manager_module,
        "terminate_managed_background_process",
        _record_termination,
    )
    manager = MonitorManager(runtime_root=tmp_path / "runtime")
    active = _active_monitor(manager, tmp_path, job)

    manager._run_monitor(active)  # noqa: SLF001

    assert wait_calls == []
    assert terminated == [job]
    assert threads[0].join_calls == [1.0]
    assert threads[1].join_calls == []
    assert active.state == "failed"
    assert active.terminal_reason == "process_error"
    assert active.terminal_event.is_set()
    assert manager._active == {}  # noqa: SLF001
