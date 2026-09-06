from __future__ import annotations

import ctypes
import io
import json
import logging
import re
import subprocess
import threading
import time
import types
from pathlib import Path

import pytest

import sidecar.runtime.process_containment as process_containment_module

# The POSIX group probe is substituted on process_containment, not here: the
# receipt observers (root_reaped / tree_is_empty / surviving_pids) live there
# now, beside the TerminationReceipt whose fields they fill in. Patching the
# re-exported alias on this module would bind a name nothing calls.
import sidecar.runtime.subprocess_manager as subprocess_manager_module
import sidecar.runtime.worker_payload as worker_payload_module
from sidecar.runtime.subprocess_manager import (
    ContainmentPolicy,
    SubprocessManager,
    TaskAlreadyRunningError,
    _build_background_env,
    _write_worker_payload,
    process_exists,
)
from sidecar.runtime.worker_secrets import (
    MAX_SECRETS_FRAME_BYTES,
    SecretFrameError,
    read_secrets_frame,
)
from tests.sidecar.runtime.test_subprocess_containment import FakeContainment

_SENTINEL = "sentinel-bearer-token-value"


class _RecordingStdin(io.BytesIO):
    """Control-pipe double. ``close()`` is recorded, not performed, so the

    delivered bytes stay readable after the handoff thread closes the pipe.
    """

    def __init__(self) -> None:
        super().__init__()
        self.written = bytearray()
        self.closed_flag = False

    def write(self, data) -> int:  # type: ignore[override]
        chunk = bytes(data)
        self.written.extend(chunk)
        return len(chunk)

    def close(self) -> None:  # type: ignore[override]
        self.closed_flag = True


class _BlockingProcess:
    def __init__(self, pid: int = 4321) -> None:
        self.pid = pid
        self.returncode: int | None = None
        self._exited = threading.Event()
        self.terminated = False
        self.killed = False
        self.stdin = _RecordingStdin()

    def poll(self) -> int | None:
        return self.returncode if self._exited.is_set() else None

    def wait(self, timeout: float | None = None) -> int:
        if timeout is not None and not self._exited.wait(timeout):
            raise subprocess.TimeoutExpired("fake", timeout)
        self._exited.wait()
        if self.returncode is None:
            self.returncode = 0
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 0
        self._exited.set()

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9
        self._exited.set()

    def finish(self, returncode: int = 0) -> None:
        self.returncode = returncode
        self._exited.set()


class _KillRequiredProcess(_BlockingProcess):
    def terminate(self) -> None:
        self.terminated = True

    def wait(self, timeout: float | None = None) -> int:
        if self.killed:
            return super().wait(timeout)
        if timeout is not None:
            raise subprocess.TimeoutExpired("fake", timeout)
        return super().wait(timeout)


class _SlowKillRequiredProcess(_KillRequiredProcess):
    def wait(self, timeout: float | None = None) -> int:
        if timeout is not None:
            time.sleep(timeout)
        return super().wait(0 if timeout is not None else None)


class _PostKillWaitTimeoutProcess(_BlockingProcess):
    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True

    def wait(self, timeout: float | None = None) -> int:
        raise subprocess.TimeoutExpired("fake", timeout)


@pytest.fixture(autouse=True)
def deterministic_containment(monkeypatch: pytest.MonkeyPatch) -> list[FakeContainment]:
    """Keep every manager in this module away from real kernel containment.

    These tests spawn fabricated processes with invented pids. On Windows the
    production factory would build a real Job Object and hand it one of those
    pids, which either fails (noise) or - if the pid happens to belong to a live
    unrelated process - assigns a stranger to a job whose KILL_ON_JOB_CLOSE
    would later kill it. Tests that specifically exercise containment override
    this with their own factory.
    """
    built: list[FakeContainment] = []

    def factory(*, policy: ContainmentPolicy) -> FakeContainment:
        containment = FakeContainment(policy=policy)
        built.append(containment)
        return containment

    monkeypatch.setattr(
        subprocess_manager_module, "create_child_containment", factory
    )
    return built


def _wait_until(predicate, timeout_seconds: float = 1.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("timed out waiting for predicate")


def test_spawn_json_worker_tracks_running_task_and_cleans_payload_on_exit(tmp_path: Path) -> None:
    process = _BlockingProcess()
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)

    manager.spawn_json_worker(
        "session_notes",
        {"hello": "world"},
        payload_dir=tmp_path,
        task_key="session_notes:test",
    )

    payload_files = list(tmp_path.glob("*.json"))
    assert manager.is_task_running("session_notes:test") is True
    assert len(payload_files) == 1

    process.finish()
    _wait_until(lambda: payload_files[0].exists() is False)

    assert payload_files[0].exists() is False
    manager.close()

def test_worker_payload_rejects_oversize_before_creating_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(worker_payload_module, "MAX_BACKGROUND_PAYLOAD_BYTES", 32)

    with pytest.raises(ValueError, match="exceeds"):
        _write_worker_payload(tmp_path, {"content": "x" * 100})

    assert list(tmp_path.glob("*.json")) == []


def test_spawn_json_worker_deadline_terminates_and_emits_coded_redacted_log(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    process = _BlockingProcess()
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)
    caplog.set_level(logging.WARNING, logger="sidecar.runtime.subprocess_manager")

    manager.spawn_json_worker(
        "automation_probe",
        {"hello": "world"},
        payload_dir=tmp_path,
        task_key="automation_probe:sensitive-request-id",
        timeout_seconds=0.01,
    )
    _wait_until(lambda: process.terminated)

    timeout_record = next(
        record
        for record in caplog.records
        if getattr(record, "event", "") == "sidecar.runtime.background_worker.timeout"
    )
    assert timeout_record.code == "CMP-MEM-0009"
    assert timeout_record.task_type == "automation_probe"
    assert "sensitive-request-id" not in timeout_record.getMessage()
    manager.close()


def test_spawn_module_rejects_duplicate_running_task_keys() -> None:
    process = _BlockingProcess()
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)

    manager.spawn_module("sidecar.runtime.background_worker", task_key="bg_task")

    with pytest.raises(RuntimeError, match="already running"):
        manager.spawn_module("sidecar.runtime.background_worker", task_key="bg_task")

    manager.close()


def test_spawn_module_reserves_task_key_before_popen_returns() -> None:
    process = _BlockingProcess()
    popen_entered = threading.Event()
    release_popen = threading.Event()
    spawned: list[_BlockingProcess] = []
    first_errors: list[BaseException] = []

    def popen_factory(*_args, **_kwargs):
        spawned.append(process)
        popen_entered.set()
        assert release_popen.wait(1.0)
        return process

    manager = SubprocessManager(popen_factory=popen_factory)

    def spawn_first() -> None:
        try:
            manager.spawn_module("sidecar.runtime.background_worker", task_key="same-key")
        except BaseException as exc:  # pragma: no cover - assertion reports the value
            first_errors.append(exc)

    first = threading.Thread(target=spawn_first)
    first.start()
    assert popen_entered.wait(1.0)

    with pytest.raises(RuntimeError, match="already running"):
        manager.spawn_module("sidecar.runtime.background_worker", task_key="same-key")

    release_popen.set()
    first.join(1.0)
    assert first.is_alive() is False
    assert first_errors == []
    assert spawned == [process]
    process.finish()
    manager.close()


def test_spawn_module_waiter_start_failure_rolls_back_child_and_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _BlockingProcess()
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)

    def fail_start(_thread) -> None:
        raise RuntimeError("waiter start failed")

    monkeypatch.setattr(subprocess_manager_module.threading.Thread, "start", fail_start)

    with pytest.raises(RuntimeError, match="waiter start failed"):
        manager.spawn_json_worker(
            "session_notes",
            {"hello": "world"},
            payload_dir=tmp_path,
            task_key="waiter-failure",
        )

    assert process.terminated is True
    assert process.poll() is not None
    assert list(tmp_path.glob("*.json")) == []
    assert manager._children == {}  # noqa: SLF001
    manager.close()


def test_spawn_rejects_reuse_while_posix_descendant_group_is_alive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _BlockingProcess(pid=4242)
    process.finish()
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)
    child = subprocess_manager_module.ManagedSubprocess(
        task_key="retained-group",
        process=process,
    )
    manager._children[child.task_key] = child  # noqa: SLF001
    group_alive = True

    def process_group_exists(_pid: int) -> bool:
        return group_alive

    monkeypatch.setattr(
        process_containment_module,
        "posix_process_group_exists",
        process_group_exists,
    )

    with pytest.raises(RuntimeError, match="already running"):
        manager.spawn_module(
            "sidecar.runtime.background_worker",
            task_key=child.task_key,
        )

    assert manager._children[child.task_key] is child  # noqa: SLF001
    group_alive = False
    manager.close()


def test_close_waits_for_starting_spawn_then_reaps_and_cleans_payload(
    tmp_path: Path,
) -> None:
    process = _BlockingProcess()
    popen_entered = threading.Event()
    release_popen = threading.Event()
    spawn_errors: list[BaseException] = []

    def popen_factory(*_args, **_kwargs):
        popen_entered.set()
        assert release_popen.wait(1.0)
        return process

    manager = SubprocessManager(popen_factory=popen_factory)

    def spawn_worker() -> None:
        try:
            manager.spawn_json_worker(
                "session_notes",
                {"hello": "world"},
                payload_dir=tmp_path,
                task_key="closing-key",
            )
        except BaseException as exc:
            spawn_errors.append(exc)

    spawn_thread = threading.Thread(target=spawn_worker)
    spawn_thread.start()
    assert popen_entered.wait(1.0)
    payload_files = list(tmp_path.glob("*.json"))
    assert len(payload_files) == 1

    close_thread = threading.Thread(
        target=manager.close,
        kwargs={"timeout_seconds": 0.5},
    )
    close_thread.start()
    time.sleep(0.02)
    assert close_thread.is_alive() is True

    release_popen.set()
    spawn_thread.join(1.0)
    close_thread.join(1.0)

    assert spawn_thread.is_alive() is False
    assert close_thread.is_alive() is False
    assert len(spawn_errors) == 1
    assert isinstance(spawn_errors[0], RuntimeError)
    assert "closed" in str(spawn_errors[0])
    assert process.terminated is True
    assert process.poll() is not None
    assert payload_files[0].exists() is False
    assert manager._children == {}  # noqa: SLF001


def test_close_timeout_cleans_starting_payload_before_popen_returns(
    tmp_path: Path,
) -> None:
    process = _BlockingProcess()
    popen_entered = threading.Event()
    release_popen = threading.Event()
    spawn_errors: list[BaseException] = []

    def popen_factory(*_args, **_kwargs):
        popen_entered.set()
        assert release_popen.wait(1.0)
        return process

    manager = SubprocessManager(popen_factory=popen_factory)

    def spawn_worker() -> None:
        try:
            manager.spawn_json_worker(
                "session_notes",
                {"hello": "world"},
                payload_dir=tmp_path,
                task_key="slow-start",
            )
        except BaseException as exc:
            spawn_errors.append(exc)

    spawn_thread = threading.Thread(target=spawn_worker)
    spawn_thread.start()
    assert popen_entered.wait(1.0)
    payload_files = list(tmp_path.glob("*.json"))
    assert len(payload_files) == 1

    started_at = time.monotonic()
    manager.close(timeout_seconds=0.02)
    elapsed = time.monotonic() - started_at

    assert elapsed < 0.25
    assert spawn_thread.is_alive() is True
    assert payload_files[0].exists() is False

    release_popen.set()
    spawn_thread.join(1.0)
    assert spawn_thread.is_alive() is False
    assert len(spawn_errors) == 1
    assert isinstance(spawn_errors[0], RuntimeError)
    assert process.terminated is True
    assert manager._children == {}  # noqa: SLF001


def test_old_waiter_cannot_finalize_replacement_with_same_task_key() -> None:
    first_process = _BlockingProcess(pid=1001)
    second_process = _BlockingProcess(pid=1002)
    processes = iter([first_process, second_process])
    waiter_gate = threading.Event()
    cleanup_calls: list[int] = []
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: next(processes))
    original_wait_for_exit = manager._wait_for_exit  # noqa: SLF001
    original_cleanup_payload = manager._cleanup_payload  # noqa: SLF001

    def delayed_wait(child) -> None:
        assert waiter_gate.wait(1.0)
        original_wait_for_exit(child)

    def tracked_cleanup(child) -> None:
        cleanup_calls.append(child.process.pid)
        original_cleanup_payload(child)

    manager._wait_for_exit = delayed_wait  # type: ignore[method-assign]  # noqa: SLF001
    manager._cleanup_payload = tracked_cleanup  # type: ignore[method-assign]  # noqa: SLF001

    manager.spawn_module("sidecar.runtime.background_worker", task_key="reused")
    first_process.finish()
    manager.spawn_module("sidecar.runtime.background_worker", task_key="reused")

    waiter_gate.set()
    _wait_until(lambda: cleanup_calls.count(first_process.pid) == 1)

    assert manager.is_task_running("reused") is True
    assert manager._children["reused"].process is second_process  # type: ignore[union-attr]  # noqa: SLF001
    second_process.finish()
    manager.close()


def test_close_terminates_children_and_removes_payload_files(tmp_path: Path) -> None:
    process = _BlockingProcess()
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)

    manager.spawn_json_worker(
        "bg_task",
        {"hello": "world"},
        payload_dir=tmp_path,
        task_key="bg_task",
    )

    payload_files = list(tmp_path.glob("*.json"))
    waiter = manager._children["bg_task"].waiter
    manager.close(timeout_seconds=0.01)

    assert process.terminated is True
    # Bounded, not instantaneous. Whichever of close() and the waiter thread
    # pops the child first owns the unlink, and _finalize_child pops under the
    # lock but unlinks outside it - so close() can legitimately return in the
    # window where the key is already gone and the file is a microsecond behind.
    # Asserting on the instant close() returns was a ~30% flake (reproduced
    # identically at d670b88d, before any of this packet's changes).
    _wait_until(lambda: payload_files[0].exists() is False)
    assert manager.is_task_running("bg_task") is False
    assert waiter is not None
    # Bounded rather than instantaneous: close() joins waiters with whatever is
    # left of its deadline, and a 0.01s budget is routinely already spent by the
    # time the join runs. The contract being pinned is that the waiter thread
    # ends, not that it ends before close() returns (pre-existing ~20% flake).
    _wait_until(lambda: waiter.is_alive() is False)


def test_close_falls_back_to_kill_when_terminate_times_out() -> None:
    process = _KillRequiredProcess()
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)

    manager.spawn_module("sidecar.runtime.background_worker", task_key="bg_task")
    manager.close(timeout_seconds=0.01)

    assert process.terminated is True
    assert process.killed is True


def test_spawn_module_filters_sensitive_parent_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = {}
    process = _BlockingProcess()

    def popen_factory(_command, **kwargs):
        captured.update(kwargs)
        return process

    monkeypatch.setenv("PATH", "C:\\Windows\\System32")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-parent-secret")
    monkeypatch.setenv("GITHUB_TOKEN", "github-secret")
    monkeypatch.setenv("JENNY_DIAGNOSTICS", "1")

    manager = SubprocessManager(popen_factory=popen_factory)
    manager.spawn_module("sidecar.runtime.background_worker", task_key="bg_task")

    env = captured["env"]
    assert env["PATH"] == "C:\\Windows\\System32"
    assert env["JENNY_DIAGNOSTICS"] == "1"
    assert env["PYTHONUNBUFFERED"] == "1"
    assert env["JENNY_BACKGROUND_PARENT_PID"]
    assert "OPENAI_API_KEY" not in env
    assert "GITHUB_TOKEN" not in env
    process.finish()
    manager.close()


def test_best_effort_job_object_failure_falls_back_to_plain_process_tracking() -> None:
    """BEST_EFFORT callers keep spawning when containment is unavailable.

    Re-scoped from the old whole-manager fail-open: this behaviour is still
    correct for spawn_module (session notes, memory suggestions) and is now
    scoped to that policy alone. The fail-closed REQUIRED counterpart lives in
    test_subprocess_containment.py.
    """
    process = _BlockingProcess()
    manager = SubprocessManager(
        popen_factory=lambda *_args, **_kwargs: process,
        containment_factory=lambda *, policy: (_ for _ in ()).throw(
            OSError("job unavailable")
        ),
    )

    manager.spawn_module("sidecar.runtime.background_worker", task_key="bg_task")

    assert manager.is_task_running("bg_task") is True
    process.finish()
    manager.close()


def test_close_terminates_children_in_parallel() -> None:
    processes = [_SlowKillRequiredProcess(pid=5000 + index) for index in range(4)]
    index = 0

    def popen_factory(*_args, **_kwargs):
        nonlocal index
        process = processes[index]
        index += 1
        return process

    manager = SubprocessManager(popen_factory=popen_factory)
    for task_index in range(4):
        manager.spawn_module("sidecar.runtime.background_worker", task_key=f"task-{task_index}")

    started_at = time.monotonic()
    manager.close(timeout_seconds=0.05)
    elapsed = time.monotonic() - started_at

    assert elapsed < 0.25
    assert all(process.terminated for process in processes)
    assert all(process.killed for process in processes)


# ---------------------------------------------------------------------------
# process_exists — uncovered branches
# ---------------------------------------------------------------------------


def test_process_exists_returns_false_for_zero_pid(monkeypatch: pytest.MonkeyPatch) -> None:
    """pid <= 0 fast-path returns False without consulting the OS."""
    kill_calls: list[tuple[int, int]] = []

    def fake_kill(pid: int, sig: int) -> None:
        kill_calls.append((pid, sig))

    monkeypatch.setattr(subprocess_manager_module.os, "kill", fake_kill)
    result = process_exists(0)
    assert result is False
    assert kill_calls == [], "os.kill must not be called for pid <= 0"


def test_process_exists_returns_false_for_negative_pid(monkeypatch: pytest.MonkeyPatch) -> None:
    """Negative pid is also invalid — returns False."""
    kill_calls: list[tuple[int, int]] = []

    def fake_kill(pid: int, sig: int) -> None:
        kill_calls.append((pid, sig))

    monkeypatch.setattr(subprocess_manager_module.os, "kill", fake_kill)
    result = process_exists(-1)
    assert result is False
    assert kill_calls == []


def test_process_exists_posix_kill_success(monkeypatch: pytest.MonkeyPatch) -> None:
    """On a POSIX-named OS, os.kill(pid, 0) not raising means the process exists."""
    kill_calls: list[tuple[int, int]] = []

    def fake_kill(pid: int, sig: int) -> None:
        kill_calls.append((pid, sig))

    monkeypatch.setattr(subprocess_manager_module.os, "name", "posix")
    monkeypatch.setattr(subprocess_manager_module.os, "kill", fake_kill)

    result = process_exists(9999)
    assert result is True
    assert kill_calls == [(9999, 0)], "os.kill must be called with (pid, 0)"


def test_process_exists_posix_kill_oserror_returns_false(monkeypatch: pytest.MonkeyPatch) -> None:
    """On POSIX, an OSError from os.kill means the process does not exist."""
    kill_calls: list[tuple[int, int]] = []

    def fake_kill(pid: int, sig: int) -> None:
        kill_calls.append((pid, sig))
        raise OSError("No such process")

    monkeypatch.setattr(subprocess_manager_module.os, "name", "posix")
    monkeypatch.setattr(subprocess_manager_module.os, "kill", fake_kill)

    result = process_exists(9999)
    assert result is False
    assert kill_calls == [(9999, 0)]


def test_process_exists_windows_windll_none_returns_false(monkeypatch: pytest.MonkeyPatch) -> None:
    """When ctypes.windll is absent (non-Windows build), process_exists returns False."""
    monkeypatch.setattr(subprocess_manager_module.os, "name", "nt")
    # Remove windll from the ctypes namespace seen by the module
    original_windll = getattr(ctypes, "windll", None)
    try:
        if hasattr(ctypes, "windll"):
            del ctypes.windll
        result = process_exists(1234)
    finally:
        if original_windll is not None:
            ctypes.windll = original_windll

    assert result is False


def test_process_exists_windows_open_process_returns_zero_means_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When OpenProcess returns 0 (NULL), the process does not exist."""
    monkeypatch.setattr(subprocess_manager_module.os, "name", "nt")

    open_calls: list[tuple] = []
    close_calls: list[int] = []

    fake_kernel32_ns = types.SimpleNamespace(
        OpenProcess=lambda access, inherit, pid: (open_calls.append((access, inherit, pid)) or 0),
        CloseHandle=lambda h: close_calls.append(h),
    )
    fake_windll = types.SimpleNamespace(kernel32=fake_kernel32_ns)
    monkeypatch.setattr(subprocess_manager_module.ctypes, "windll", fake_windll, raising=False)

    result = process_exists(5555)
    assert result is False
    assert len(open_calls) == 1, "OpenProcess must be called once"
    assert open_calls[0][2] == 5555, "OpenProcess must receive the requested pid"
    assert close_calls == [], "CloseHandle must NOT be called when handle is 0"


def test_process_exists_windows_open_process_success(monkeypatch: pytest.MonkeyPatch) -> None:
    """When OpenProcess returns a non-zero handle the process exists; CloseHandle is called."""
    monkeypatch.setattr(subprocess_manager_module.os, "name", "nt")

    open_calls: list[tuple] = []
    close_calls: list[int] = []

    fake_kernel32_ns = types.SimpleNamespace(
        OpenProcess=lambda access, inherit, pid: (open_calls.append((access, inherit, pid)) or 42),
        CloseHandle=lambda h: close_calls.append(h),
    )
    fake_windll = types.SimpleNamespace(kernel32=fake_kernel32_ns)
    monkeypatch.setattr(subprocess_manager_module.ctypes, "windll", fake_windll, raising=False)

    result = process_exists(5555)
    assert result is True
    assert len(open_calls) == 1
    assert close_calls == [42], "CloseHandle must be called with the returned handle"


# ---------------------------------------------------------------------------
# containment creation is deferred to the spawn, not the manager
# ---------------------------------------------------------------------------


def test_manager_construction_creates_no_containment(
    deterministic_containment: list[FakeContainment],
) -> None:
    """Containment is per child, so constructing a manager must build none."""
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: _BlockingProcess())
    assert deterministic_containment == []
    manager.close()


def test_each_spawn_gets_its_own_containment(
    deterministic_containment: list[FakeContainment],
) -> None:
    """Two tasks must not share one job: reaping one cannot kill the other."""
    processes = [_BlockingProcess(pid=7100), _BlockingProcess(pid=7101)]
    manager = SubprocessManager(
        popen_factory=lambda *_a, **_kw: processes[len(deterministic_containment) - 1]
    )
    manager.spawn_module("sidecar.runtime.background_worker", task_key="one")
    manager.spawn_module("sidecar.runtime.background_worker", task_key="two")

    assert len(deterministic_containment) == 2
    assert deterministic_containment[0] is not deterministic_containment[1]
    assert [item.pid for item in deterministic_containment] == [7100, 7101]
    for process in processes:
        process.finish()
    manager.close()


# ---------------------------------------------------------------------------
# is_task_running — poll() not-None branch (line 205)
# ---------------------------------------------------------------------------


def test_is_task_running_returns_false_when_process_already_exited() -> None:
    """A child whose poll() is non-None is treated as not running."""
    exited_process = _BlockingProcess()
    exited_process.finish(returncode=0)  # poll() now returns 0 (not None)

    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: exited_process)
    manager.spawn_module("sidecar.runtime.background_worker", task_key="bg_exited")

    # Give the waiter thread a moment to finalize (it may or may not have run)
    # but the critical check is is_task_running, which reads poll() directly.
    result = manager.is_task_running("bg_exited")
    assert result is False, "is_task_running must return False when poll() is not None"
    manager.close()


def test_root_exit_with_live_posix_descendants_remains_running_then_finalizes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _BlockingProcess(pid=6122)
    group_alive = True
    # Uncontained on purpose: with no containment object to interrogate, the
    # POSIX group probe is the only descendant evidence the manager has, and
    # that fallback is what this test pins.
    monkeypatch.setattr(
        subprocess_manager_module,
        "create_child_containment",
        lambda *, policy: None,
    )
    monkeypatch.setattr(
        subprocess_manager_module,
        "_uses_posix_process_groups",
        lambda: True,
    )
    monkeypatch.setattr(
        process_containment_module,
        "posix_process_group_exists",
        lambda _group_id: group_alive,
    )
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)
    manager.spawn_json_worker(
        "session_notes",
        {"hello": "world"},
        payload_dir=tmp_path,
        task_key="descendant-owned",
    )
    payload_path = next(tmp_path.glob("*.json"))

    process.finish()
    _wait_until(lambda: process.poll() is not None)
    assert manager.is_task_running("descendant-owned") is True
    assert payload_path.exists() is True

    group_alive = False
    _wait_until(lambda: manager.is_task_running("descendant-owned") is False)
    _wait_until(lambda: payload_path.exists() is False)
    manager.close()


# ---------------------------------------------------------------------------
# spawn_module — guards (lines 218-220, 246-267)
# ---------------------------------------------------------------------------


def test_spawn_module_raises_on_empty_task_key() -> None:
    """An empty/whitespace task_key raises ValueError before spawning anything."""
    spawned: list = []
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: spawned.append(1) or _BlockingProcess())

    with pytest.raises(ValueError, match="task_key is required"):
        manager.spawn_module("sidecar.runtime.background_worker", task_key="")

    assert spawned == [], "popen_factory must not be called when task_key is invalid"
    manager.close()


def test_spawn_module_raises_on_whitespace_only_task_key() -> None:
    """Whitespace-only task_key is stripped to empty — must raise ValueError."""
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: _BlockingProcess())
    with pytest.raises(ValueError, match="task_key is required"):
        manager.spawn_module("sidecar.runtime.background_worker", task_key="   ")
    manager.close()


def test_spawn_module_raises_when_manager_is_closed() -> None:
    """Spawning after close() must raise RuntimeError before any process is launched."""
    spawned: list[int] = []
    manager = SubprocessManager(
        popen_factory=lambda *_a, **_kw: spawned.append(1) or _BlockingProcess()
    )
    manager.close()

    with pytest.raises(RuntimeError, match="closed"):
        manager.spawn_module("sidecar.runtime.background_worker", task_key="after_close")

    assert spawned == [], "popen_factory must not be called once the manager is closed"


def test_spawn_module_passes_extra_args_in_command(monkeypatch: pytest.MonkeyPatch) -> None:
    """Extra args are appended to the command list passed to popen_factory."""
    captured_commands: list[list[str]] = []
    process = _BlockingProcess()

    def popen_factory(command, **_kwargs):
        captured_commands.append(list(command))
        return process

    manager = SubprocessManager(popen_factory=popen_factory)
    manager.spawn_module(
        "sidecar.runtime.background_worker",
        args=["arg1", "arg2"],
        task_key="args_test",
    )

    assert len(captured_commands) == 1
    cmd = captured_commands[0]
    assert cmd[-2] == "arg1"
    assert cmd[-1] == "arg2"
    assert "sidecar.runtime.background_worker" in cmd
    process.finish()
    manager.close()


def test_spawn_module_posix_uses_start_new_session_not_preexec_fn() -> None:
    """POSIX grouping must come from start_new_session, never preexec_fn.

    preexec_fn runs arbitrary Python between fork and exec in a process that has
    threads (waiters, stdio pumps, the diagnostics queue), where a lock held by
    another thread at fork time deadlocks the child. start_new_session is the
    setsid() equivalent CPython performs in the C-level pre-exec path.
    """
    captured_kwargs: list[dict] = []
    process = _BlockingProcess()

    def popen_factory(command, **kwargs):
        captured_kwargs.append(kwargs)
        return process

    manager = SubprocessManager(
        popen_factory=popen_factory,
        containment_factory=lambda *, policy: FakeContainment(
            policy=policy, spawn_kwargs={"start_new_session": True}
        ),
    )
    manager.spawn_module("sidecar.runtime.background_worker", task_key="posix_task")

    assert len(captured_kwargs) == 1
    kw = captured_kwargs[0]
    assert kw["start_new_session"] is True
    assert "preexec_fn" not in kw, "preexec_fn is fork-unsafe in a threaded process"
    assert "creationflags" not in kw, "creationflags must NOT appear on POSIX"
    process.finish()
    manager.close()


def test_posix_containment_declares_start_new_session() -> None:
    """The real POSIX containment object is the source of that launch flag."""
    from sidecar.runtime.process_containment import PosixProcessGroupContainment

    assert PosixProcessGroupContainment().popen_kwargs() == {"start_new_session": True}


def test_terminate_child_signals_owned_posix_process_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _KillRequiredProcess(pid=6123)
    signals: list[tuple[int, int]] = []
    group_alive = True

    def fake_killpg(group_id: int, group_signal: int) -> None:
        nonlocal group_alive
        signals.append((group_id, group_signal))
        if group_signal == subprocess_manager_module._POSIX_SIGKILL:  # noqa: SLF001
            group_alive = False
            process.kill()

    monkeypatch.setattr(
        subprocess_manager_module,
        "_uses_posix_process_groups",
        lambda: True,
    )
    monkeypatch.setattr(
        process_containment_module,
        "posix_process_group_exists",
        lambda _group_id: group_alive,
    )
    monkeypatch.setattr(subprocess_manager_module.os, "killpg", fake_killpg, raising=False)
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)
    child = subprocess_manager_module.ManagedSubprocess(
        task_key="group-owned",
        process=process,
    )

    receipt = manager._terminate_child(child, timeout_seconds=0.01)  # noqa: SLF001

    assert signals == [
        (process.pid, subprocess_manager_module._POSIX_SIGTERM),  # noqa: SLF001
        (process.pid, subprocess_manager_module._POSIX_SIGKILL),  # noqa: SLF001
    ]
    assert process.terminated is False
    assert process.killed is True
    assert receipt.terminated is True
    assert receipt.escalated == "kill"
    manager.close()


def test_terminate_child_falls_back_when_posix_group_signal_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _BlockingProcess(pid=6124)

    def fail_killpg(_group_id: int, _group_signal: int) -> None:
        raise OSError("group unavailable")

    monkeypatch.setattr(
        subprocess_manager_module,
        "_uses_posix_process_groups",
        lambda: True,
    )
    monkeypatch.setattr(
        process_containment_module,
        "posix_process_group_exists",
        lambda _group_id: False,
    )
    monkeypatch.setattr(subprocess_manager_module.os, "killpg", fail_killpg, raising=False)
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)
    child = subprocess_manager_module.ManagedSubprocess(
        task_key="group-fallback",
        process=process,
    )

    receipt = manager._terminate_child(child, timeout_seconds=0.01)  # noqa: SLF001

    assert process.terminated is True
    assert receipt.terminated is True
    manager.close()


def test_spawn_module_nt_sets_creation_flags() -> None:
    """On Windows (nt), popen_kwargs must include creationflags and no preexec_fn."""
    captured_kwargs: list[dict] = []
    process = _BlockingProcess()

    def popen_factory(command, **kwargs):
        captured_kwargs.append(kwargs)
        return process

    manager = SubprocessManager(
        popen_factory=popen_factory,
        containment_factory=lambda *, policy: FakeContainment(
            policy=policy,
            spawn_kwargs={
                "creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200)
            },
        ),
    )
    manager.spawn_module("sidecar.runtime.background_worker", task_key="nt_task")

    assert len(captured_kwargs) == 1
    kw = captured_kwargs[0]
    assert "creationflags" in kw, "creationflags must be set on Windows"
    assert "preexec_fn" not in kw, "preexec_fn must NOT appear on Windows"
    process.finish()
    manager.close()


# ---------------------------------------------------------------------------
# spawn_json_worker — failure path unlinks payload (lines 232-234)
# ---------------------------------------------------------------------------


def test_spawn_json_worker_unlinks_payload_when_spawn_fails(tmp_path: Path) -> None:
    """If spawn_module raises, the payload file must be deleted and the error re-raised."""

    def failing_factory(*_args, **_kwargs) -> None:
        raise RuntimeError("process spawn failed")

    manager = SubprocessManager(popen_factory=failing_factory)

    with pytest.raises(RuntimeError, match="process spawn failed"):
        manager.spawn_json_worker(
            "session_notes",
            {"key": "value"},
            payload_dir=tmp_path,
            task_key="failing_task",
        )

    remaining = list(tmp_path.glob("*.json"))
    assert remaining == [], f"payload file must be removed on spawn failure, found: {remaining}"
    manager.close()


@pytest.mark.parametrize(
    "task_key",
    [
        "automation:x/../../escaped",
        "automation:x\\..\\..\\escaped",
        "C:\\outside\\task",
        "\\\\server\\share\\task",
    ],
)
def test_spawn_json_worker_filename_is_uuid_only_and_independent_of_task_key(
    tmp_path: Path,
    task_key: str,
) -> None:
    captured_commands: list[list[str]] = []
    process = _BlockingProcess()

    def popen_factory(command, **_kwargs):
        captured_commands.append(list(command))
        return process

    manager = SubprocessManager(popen_factory=popen_factory)
    manager.spawn_json_worker(
        "session_notes",
        {"task_key_copy": task_key},
        payload_dir=tmp_path,
        task_key=task_key,
    )

    payload_path = Path(captured_commands[0][-1])
    assert payload_path.parent == tmp_path.resolve()
    assert re.fullmatch(r"[0-9a-f]{32}\.json", payload_path.name)
    assert json.loads(payload_path.read_text(encoding="utf-8")) == {
        "task_key_copy": task_key
    }
    assert task_key not in payload_path.name

    process.finish()
    manager.close()


def test_spawn_json_worker_retries_exclusive_uuid_collision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_hex = "a" * 32
    second_hex = "b" * 32
    (tmp_path / f"{first_hex}.json").write_text("existing", encoding="utf-8")
    generated = iter(
        [
            types.SimpleNamespace(hex=first_hex),
            types.SimpleNamespace(hex=second_hex),
        ]
    )
    # Patched on worker_payload, not subprocess_manager: the payload writer that
    # calls uuid4 moved there, and subprocess_manager only re-exports the helper.
    monkeypatch.setattr(worker_payload_module.uuid, "uuid4", lambda: next(generated))
    captured_commands: list[list[str]] = []
    process = _BlockingProcess()

    def popen_factory(command, **_kwargs):
        captured_commands.append(list(command))
        return process

    manager = SubprocessManager(popen_factory=popen_factory)
    manager.spawn_json_worker(
        "session_notes",
        {"key": "value"},
        payload_dir=tmp_path,
        task_key="collision-test",
    )

    assert Path(captured_commands[0][-1]).name == f"{second_hex}.json"
    assert (tmp_path / f"{first_hex}.json").read_text(encoding="utf-8") == "existing"

    process.finish()
    manager.close()


def test_spawn_json_worker_raises_on_empty_task_key(tmp_path: Path) -> None:
    """An empty task_key must raise ValueError before writing the payload file."""
    spawned: list = []
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: spawned.append(1) or _BlockingProcess())

    with pytest.raises(ValueError, match="task_key is required"):
        manager.spawn_json_worker(
            "session_notes",
            {"k": "v"},
            payload_dir=tmp_path,
            task_key="",
        )

    assert list(tmp_path.glob("*.json")) == [], "no payload should be written for invalid task_key"
    manager.close()


def test_spawn_json_worker_raises_when_task_already_running(tmp_path: Path) -> None:
    """Calling spawn_json_worker while the same key is running must raise RuntimeError."""
    process = _BlockingProcess()
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: process)

    manager.spawn_json_worker(
        "session_notes",
        {"k": "v"},
        payload_dir=tmp_path,
        task_key="dup_key",
    )

    with pytest.raises(RuntimeError, match="already running"):
        manager.spawn_json_worker(
            "session_notes",
            {"k": "v2"},
            payload_dir=tmp_path,
            task_key="dup_key",
        )

    process.finish()
    manager.close()


# ---------------------------------------------------------------------------
# _finalize_child — guard when child is already removed
# ---------------------------------------------------------------------------


def test_finalize_child_is_idempotent() -> None:
    """First _finalize_child removes the child + cleans payload exactly once; second is a no-op."""
    process = _BlockingProcess()
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: process)
    manager.spawn_module("sidecar.runtime.background_worker", task_key="idem_task")

    cleanup_calls: list[str] = []
    manager._cleanup_payload = lambda child: cleanup_calls.append(child.task_key)  # type: ignore[assignment]  # noqa: SLF001

    assert "idem_task" in manager._children  # noqa: SLF001

    # First finalize — pops the child and cleans its payload exactly once.
    manager._finalize_child("idem_task")  # noqa: SLF001
    assert "idem_task" not in manager._children, "child must be removed after finalize"  # noqa: SLF001
    assert cleanup_calls == ["idem_task"], "payload cleanup must run once on first finalize"

    # Second call must be a no-op: no further cleanup, no error.
    manager._finalize_child("idem_task")  # noqa: SLF001
    assert cleanup_calls == ["idem_task"], "second finalize must NOT re-clean the payload"
    manager.close()


# ---------------------------------------------------------------------------
# _cleanup_payload — None payload_path branch (line 308-309)
# ---------------------------------------------------------------------------


def test_cleanup_payload_is_noop_when_payload_path_is_none() -> None:
    """_cleanup_payload with payload_path=None must early-return without touching the FS."""
    from sidecar.runtime.subprocess_manager import ManagedSubprocess

    unlink_calls: list[object] = []

    class _SpyPath:
        def unlink(self, missing_ok: bool = False) -> None:
            unlink_calls.append(self)

    process = _BlockingProcess()
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: process)

    # Control: a non-None payload_path DOES trigger unlink (proves the spy works).
    with_payload = ManagedSubprocess(
        task_key="withpayload", process=process, payload_path=_SpyPath()  # type: ignore[arg-type]
    )
    manager._cleanup_payload(with_payload)  # noqa: SLF001
    assert len(unlink_calls) == 1, "non-None payload_path must trigger unlink()"

    # Target: payload_path=None must NOT trigger any unlink.
    none_child = ManagedSubprocess(task_key="nopayload", process=process, payload_path=None)
    manager._cleanup_payload(none_child)  # noqa: SLF001 — must not raise
    assert len(unlink_calls) == 1, "payload_path=None must NOT trigger unlink()"
    manager.close()


# ---------------------------------------------------------------------------
# close — idempotent (already-closed branch, line 321)
# ---------------------------------------------------------------------------


def test_close_is_idempotent() -> None:
    """Calling close() twice must not raise and must not double-terminate children."""
    process = _BlockingProcess()
    terminate_count = {"n": 0}
    original_terminate = process.terminate

    def counting_terminate():
        terminate_count["n"] += 1
        original_terminate()

    process.terminate = counting_terminate

    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: process)
    manager.spawn_module("sidecar.runtime.background_worker", task_key="idem_close")

    manager.close(timeout_seconds=0.05)
    manager.close(timeout_seconds=0.05)  # second call must be a no-op

    assert terminate_count["n"] == 1, "terminate must be called exactly once"


# ---------------------------------------------------------------------------
# _terminate_child — already-exited process skips terminate (line 355)
# ---------------------------------------------------------------------------


def test_terminate_child_skips_terminate_when_process_already_exited() -> None:
    """_terminate_child must not call terminate() if poll() is already non-None."""
    from sidecar.runtime.subprocess_manager import ManagedSubprocess

    process = _BlockingProcess()
    process.finish(0)  # poll() now returns 0 — already exited

    child = ManagedSubprocess(task_key="already_exited", process=process, payload_path=None)
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: _BlockingProcess())
    manager._terminate_child(child, timeout_seconds=0.1)  # noqa: SLF001

    assert process.terminated is False, "terminate must not be called on an already-exited process"
    manager.close()


# ---------------------------------------------------------------------------
# _terminate_child — exception from terminate() is caught (line 362-363)
# ---------------------------------------------------------------------------


class _TerminateRaisesProcess(_BlockingProcess):
    """Fake process whose terminate() raises an unexpected exception."""

    def __init__(self, pid: int = 4321) -> None:
        super().__init__(pid)
        self.terminate_attempts = 0

    def terminate(self) -> None:
        self.terminate_attempts += 1
        raise ValueError("terminate blew up unexpectedly")


def test_terminate_child_catches_unexpected_exception() -> None:
    """A terminate exception must not suppress kill and bounded reap."""
    from sidecar.runtime.subprocess_manager import ManagedSubprocess

    process = _TerminateRaisesProcess()
    child = ManagedSubprocess(task_key="exploding", process=process, payload_path=None)
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: _BlockingProcess())

    # Must not propagate (the broad except in _terminate_child swallows it).
    receipt = manager._terminate_child(child, timeout_seconds=0.05)  # noqa: SLF001

    assert process.terminate_attempts == 1, "terminate() must have been attempted exactly once"
    assert process.killed is True
    assert receipt.terminated is True
    manager.close()


def test_terminate_child_retains_unreaped_state_after_post_kill_wait_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A child that times out after kill remains explicitly unreaped."""
    from sidecar.runtime.subprocess_manager import ManagedSubprocess

    monkeypatch.setattr(
        subprocess_manager_module, "_CONTAINMENT_VERIFY_SECONDS", 0.05
    )
    process = _PostKillWaitTimeoutProcess()
    child = ManagedSubprocess(task_key="unreaped", process=process, payload_path=None)
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: _BlockingProcess())

    receipt = manager._terminate_child(child, timeout_seconds=0.01)  # noqa: SLF001

    assert process.terminated is True
    assert process.killed is True
    assert receipt.terminated is False
    assert receipt.reaped is False
    # Uncontained on Windows: there is no tree to interrogate, which is exactly
    # the evidence gap REQUIRED containment exists to close.
    assert receipt.contained is False
    manager.close()


def test_rejected_start_keeps_identity_and_payload_owned_when_child_is_unreaped(
    tmp_path: Path,
) -> None:
    from sidecar.runtime.subprocess_manager import ManagedSubprocess

    payload_path = tmp_path / "owned.json"
    payload_path.write_text("{}", encoding="utf-8")
    process = _PostKillWaitTimeoutProcess()
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: process)
    reservation = manager._reserve_start("unreaped-start", payload_path)  # noqa: SLF001
    child = ManagedSubprocess(
        task_key="unreaped-start",
        process=process,
        payload_path=payload_path,
    )

    manager._settle_rejected_start(reservation, child)  # noqa: SLF001

    assert manager._children["unreaped-start"] is child  # noqa: SLF001
    assert payload_path.exists() is True

    process.finish()
    manager._finalize_child("unreaped-start", expected_child=child)  # noqa: SLF001
    assert payload_path.exists() is False
    manager.close()


def test_close_uses_one_deadline_for_reservations_termination_and_joins(
    monkeypatch, tmp_path: Path
) -> None:
    clock = {"now": 10.0}
    observed: dict[str, float] = {}
    payload_path = tmp_path / "timed-out-reservation.json"
    payload_path.write_text("{}", encoding="utf-8")
    manager = SubprocessManager(popen_factory=lambda *_args, **_kwargs: _BlockingProcess())

    monkeypatch.setattr(
        subprocess_manager_module.time,
        "monotonic",
        lambda: clock["now"],
    )

    def begin_close(deadline: float):
        observed["reservation_deadline"] = deadline
        clock["now"] = 13.0
        return [], [payload_path]

    def stop_and_join(_children, deadline: float) -> None:
        observed["termination_deadline"] = deadline
        observed["remaining_at_termination"] = deadline - clock["now"]

    monkeypatch.setattr(manager, "_begin_close", begin_close)
    monkeypatch.setattr(manager, "_stop_and_join_children", stop_and_join)

    result = manager.close(timeout_seconds=5.0)

    assert observed["reservation_deadline"] == 15.0
    assert observed["termination_deadline"] == 15.0
    assert observed["remaining_at_termination"] == 2.0
    assert result.drained is False
    assert result.reservation_count == 1


# ---------------------------------------------------------------------------
# H1 — a bearer token must not reach ANY of the five observable surfaces
# ---------------------------------------------------------------------------


class _ClosedStdinProcess(_BlockingProcess):
    """Child whose control pipe is already gone (EPIPE on handoff)."""

    def __init__(self, pid: int = 7777) -> None:
        super().__init__(pid)
        self.stdin = _BrokenStdin()


class _BrokenStdin(_RecordingStdin):
    def write(self, data) -> int:  # type: ignore[override]
        raise BrokenPipeError("the child already closed its control pipe")


def _secret_payload() -> dict[str, object]:
    return {
        "config": {"engine_type": "chatgpt", "chatgpt_access_token": _SENTINEL},
        "session_id": "session-1",
    }


def test_spawn_json_worker_keeps_the_token_off_every_observable_surface(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    process = _BlockingProcess()
    captured: dict[str, object] = {}

    def popen_factory(command, **kwargs):
        captured["command"] = list(command)
        captured["kwargs"] = kwargs
        return process

    manager = SubprocessManager(popen_factory=popen_factory)
    with caplog.at_level("DEBUG"):
        manager.spawn_json_worker(
            "session_notes",
            _secret_payload(),
            payload_dir=tmp_path,
            task_key="secret-surfaces",
            secrets={"chatgpt_access_token": _SENTINEL},
        )

    # 1. payload file bytes (read live; _BlockingProcess never exits so the
    #    cleanup path has not run yet).
    payload_bytes = next(tmp_path.glob("*.json")).read_bytes()
    assert _SENTINEL.encode("utf-8") not in payload_bytes
    assert b"chatgpt_access_token" not in payload_bytes
    assert json.loads(payload_bytes.decode("utf-8"))["config"] == {"engine_type": "chatgpt"}

    # 2. argv
    assert _SENTINEL not in " ".join(str(part) for part in captured["command"])

    # 3. child environment
    env = captured["kwargs"]["env"]
    assert all(_SENTINEL not in str(value) for value in env.values())

    # 4. logs
    assert _SENTINEL not in caplog.text

    # 5. the ONE channel that may carry it: the control pipe.
    assert read_secrets_frame(io.BytesIO(bytes(process.stdin.written))) == {
        "chatgpt_access_token": _SENTINEL
    }
    assert process.stdin.closed_flag is True

    process.finish()
    manager.close()


def test_build_background_env_allowlist_drops_a_chatgpt_access_token_variable() -> None:
    env = _build_background_env(
        {"PATH": "C:\\Windows", "CHATGPT_ACCESS_TOKEN": _SENTINEL, "OPENAI_API_KEY": "x"}
    )

    assert env["PATH"] == "C:\\Windows"
    assert "CHATGPT_ACCESS_TOKEN" not in env
    assert all(_SENTINEL not in value for value in env.values())


def test_spawn_json_worker_lifts_a_stray_payload_secret_and_still_forwards_it(
    tmp_path: Path,
) -> None:
    # Lift-and-forward: a stray secret key in the payload config is a security
    # no-op (it leaves the file) AND a behavior no-op (it still reaches the child).
    process = _BlockingProcess()
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: process)

    manager.spawn_json_worker(
        "session_notes",
        _secret_payload(),
        payload_dir=tmp_path,
        task_key="lift-and-forward",
    )

    payload_bytes = next(tmp_path.glob("*.json")).read_bytes()
    assert _SENTINEL.encode("utf-8") not in payload_bytes
    assert read_secrets_frame(io.BytesIO(bytes(process.stdin.written))) == {
        "chatgpt_access_token": _SENTINEL
    }

    process.finish()
    manager.close()


def test_spawn_json_worker_survives_a_broken_control_pipe(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    process = _ClosedStdinProcess()
    manager = SubprocessManager(popen_factory=lambda *_a, **_kw: process)

    with caplog.at_level("DEBUG"):
        manager.spawn_json_worker(
            "session_notes",
            {"config": {"engine_type": "chatgpt"}},
            payload_dir=tmp_path,
            task_key="epipe",
            secrets={"chatgpt_access_token": _SENTINEL},
        )

    assert manager.is_task_running("epipe") is True
    warnings = [record for record in caplog.records if record.levelname == "WARNING"]
    assert len(warnings) == 1
    assert "secret handoff did not complete" in warnings[0].getMessage()
    assert _SENTINEL not in caplog.text
    assert process.stdin.closed_flag is True

    process.finish()
    manager.close()


def test_spawn_json_worker_pipes_stdin_while_bare_spawn_module_keeps_devnull(
    tmp_path: Path,
) -> None:
    captured: list[dict[str, object]] = []
    process = _BlockingProcess()

    def popen_factory(_command, **kwargs):
        captured.append(kwargs)
        return process

    manager = SubprocessManager(popen_factory=popen_factory)
    manager.spawn_json_worker(
        "session_notes",
        _secret_payload(),
        payload_dir=tmp_path,
        task_key="piped",
        secrets={"chatgpt_access_token": _SENTINEL},
    )
    process.finish()
    manager.spawn_module("sidecar.runtime.background_worker", task_key="devnull")

    assert captured[0]["stdin"] is subprocess.PIPE
    assert captured[0]["bufsize"] == 0
    assert captured[0]["stdout"] is subprocess.DEVNULL
    assert captured[1]["stdin"] is subprocess.DEVNULL
    assert "bufsize" not in captured[1]
    manager.close()


def test_write_worker_payload_refuses_a_secret_bearing_payload(tmp_path: Path) -> None:
    with pytest.raises(SecretFrameError, match="chatgpt_access_token"):
        _write_worker_payload(tmp_path, {"config": {"chatgpt_access_token": _SENTINEL}})

    assert list(tmp_path.glob("*.json")) == []


def test_spawn_json_worker_rejects_oversize_secrets_before_any_side_effect(
    tmp_path: Path,
) -> None:
    spawned: list[int] = []
    manager = SubprocessManager(
        popen_factory=lambda *_a, **_kw: spawned.append(1) or _BlockingProcess()
    )

    with pytest.raises(SecretFrameError, match="byte limit"):
        manager.spawn_json_worker(
            "session_notes",
            {"config": {"engine_type": "chatgpt"}},
            payload_dir=tmp_path,
            task_key="oversize",
            secrets={"chatgpt_access_token": "z" * (MAX_SECRETS_FRAME_BYTES + 64)},
        )

    assert list(tmp_path.glob("*.json")) == []
    assert spawned == []
    assert manager.is_task_running("oversize") is False
    manager.close()
