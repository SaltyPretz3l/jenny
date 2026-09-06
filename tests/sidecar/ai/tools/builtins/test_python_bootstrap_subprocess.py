"""The bootstrap runner contains the whole process tree of every step.

Two layers: real processes prove a timed-out step takes its grandchild with
it and that the ``subprocess.run`` contract (stdout, stderr, check) survived
the move; fakes pin the launch-gate ordering (assign before resume, kill
before drain) that a real run cannot observe.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import time
import types
from typing import Any

import pytest

from sidecar.ai.tools.builtins.python_runtime import bootstrap_subprocess

# The child prints its grandchild's pid and then both sleep far past the
# runner's timeout. The grandchild gets no pipes of its own so a broken tree
# kill fails the assertion instead of hanging ``communicate`` on an inherited
# pipe.
_SPAWNING_CHILD = (
    "import subprocess, sys, time\n"
    "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'],"
    " stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)\n"
    "print(g.pid, flush=True)\n"
    "time.sleep(120)\n"
)


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        synchronize = 0x00100000
        handle = kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            return False
        try:
            # WAIT_TIMEOUT (0x102) means the process is still running.
            return int(kernel32.WaitForSingleObject(handle, 0)) == 0x102
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_until_dead(pid: int, *, budget_seconds: float = 10.0) -> bool:
    deadline = time.monotonic() + budget_seconds
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.1)
    return not _pid_alive(pid)


def test_timeout_kills_the_grandchild_and_reports_captured_output() -> None:
    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired) as info:
        bootstrap_subprocess.run([sys.executable, "-c", _SPAWNING_CHILD], timeout=3)
    elapsed = time.monotonic() - started
    assert elapsed < 60, "the runner must not wait out the child's own sleep"

    output = info.value.output if isinstance(info.value.output, str) else ""
    assert output.strip().isdigit(), (
        "the timeout must carry the output captured before the kill; got "
        f"{output!r}"
    )
    grandchild_pid = int(output.strip())
    assert _wait_until_dead(grandchild_pid), (
        f"grandchild {grandchild_pid} survived the timed-out bootstrap step"
    )


def test_completed_run_keeps_the_subprocess_run_contract() -> None:
    completed = bootstrap_subprocess.run(
        [sys.executable, "-c", "import sys; print('ok'); sys.stderr.write('note')"],
        timeout=30,
        check=True,
    )
    assert completed.returncode == 0
    assert completed.stdout.strip() == "ok"
    assert completed.stderr == "note"

    with pytest.raises(subprocess.CalledProcessError) as info:
        bootstrap_subprocess.run(
            [sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"],
            timeout=30,
            check=True,
        )
    assert info.value.returncode == 3
    assert info.value.stderr == "boom"

    unchecked = bootstrap_subprocess.run(
        [sys.executable, "-c", "import sys; sys.exit(4)"], timeout=30
    )
    assert unchecked.returncode == 4


class _RecordingJob:
    """Stands in for JobObject and records the order of every call."""

    events: list[str]

    def __init__(self, **_kwargs: Any) -> None:
        self.events = []
        _RecordingJob.last = self

    last: "_RecordingJob | None" = None

    def __enter__(self) -> "_RecordingJob":
        self.events.append("enter")
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.events.append("exit")

    def assign(self, _proc: Any) -> None:
        self.events.append("assign")

    def resume(self, _proc: Any) -> None:
        self.events.append("resume")

    def close(self) -> None:
        self.events.append("close")


def _fake_proc(job: _RecordingJob, communicate_results: list[Any]) -> types.SimpleNamespace:
    def communicate(timeout: float | None = None) -> tuple[str, str]:
        job.events.append(f"communicate(timeout={timeout})")
        result = communicate_results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result

    def kill() -> None:
        job.events.append("kill")

    return types.SimpleNamespace(
        pid=4242,
        returncode=0,
        stdout=None,
        stderr=None,
        communicate=communicate,
        kill=kill,
    )


def test_windows_launch_gate_assigns_before_resuming(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bootstrap_subprocess, "IS_WINDOWS", True)
    monkeypatch.setattr(bootstrap_subprocess, "JobObject", _RecordingJob)
    spawn_kwargs: dict[str, Any] = {}

    def fake_spawn(argv: Any, **kwargs: Any) -> Any:
        spawn_kwargs.update(kwargs)
        job = _RecordingJob.last
        assert job is not None
        job.events.append("spawn")
        return _fake_proc(job, [("out", "err")])

    monkeypatch.setattr(bootstrap_subprocess, "_spawn", fake_spawn)

    completed = bootstrap_subprocess.run(["python", "-c", "pass"], timeout=7)

    job = _RecordingJob.last
    assert job is not None
    assert job.events == [
        "enter",
        "spawn",
        "assign",
        "resume",
        "communicate(timeout=7.0)",
        "exit",
    ], "the child must be assigned to the job while still suspended, then resumed"
    assert spawn_kwargs["creationflags"] & 0x00000004, "the child must start suspended"
    assert "start_new_session" not in spawn_kwargs
    assert (completed.stdout, completed.stderr, completed.returncode) == ("out", "err", 0)


def test_posix_launch_uses_a_fresh_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bootstrap_subprocess, "IS_WINDOWS", False)
    monkeypatch.setattr(bootstrap_subprocess, "JobObject", _RecordingJob)
    spawn_kwargs: dict[str, Any] = {}

    def fake_spawn(argv: Any, **kwargs: Any) -> Any:
        spawn_kwargs.update(kwargs)
        job = _RecordingJob.last
        assert job is not None
        return _fake_proc(job, [("", "")])

    monkeypatch.setattr(bootstrap_subprocess, "_spawn", fake_spawn)
    bootstrap_subprocess.run(["python", "-c", "pass"], timeout=1)
    assert spawn_kwargs.get("start_new_session") is True
    assert "creationflags" not in spawn_kwargs


def test_timeout_kills_the_tree_before_draining(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bootstrap_subprocess, "IS_WINDOWS", True)
    monkeypatch.setattr(bootstrap_subprocess, "JobObject", _RecordingJob)

    def fake_spawn(argv: Any, **kwargs: Any) -> Any:
        job = _RecordingJob.last
        assert job is not None
        return _fake_proc(
            job,
            [subprocess.TimeoutExpired(cmd=argv, timeout=kwargs.get("timeout", 0)), ("partial", "tail")],
        )

    monkeypatch.setattr(bootstrap_subprocess, "_spawn", fake_spawn)

    with pytest.raises(subprocess.TimeoutExpired) as info:
        bootstrap_subprocess.run(["python", "-c", "pass"], timeout=5)

    job = _RecordingJob.last
    assert job is not None
    assert job.events == [
        "enter",
        "assign",
        "resume",
        "communicate(timeout=5.0)",
        "close",
        "kill",
        f"communicate(timeout={bootstrap_subprocess._POST_KILL_DRAIN_SECONDS})",
        "exit",
    ], "on timeout the job must be closed (killing the tree) before the pipes are drained"
    assert info.value.output == "partial"
    assert info.value.stderr == "tail"
    assert info.value.timeout == 5


def test_run_lowers_its_timeout_to_the_remaining_bootstrap_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A phase constant is a ceiling; the bootstrap deadline lowers it.

    Without this a deadline checked only between phases could still be
    overrun by a whole 120s pip run.
    """
    monkeypatch.setattr(bootstrap_subprocess, "IS_WINDOWS", True)
    monkeypatch.setattr(bootstrap_subprocess, "JobObject", _RecordingJob)
    seen: list[float | None] = []

    def fake_spawn(argv: Any, **kwargs: Any) -> Any:
        job = _RecordingJob.last
        assert job is not None
        proc = _fake_proc(job, [("", "")])
        original = proc.communicate

        def communicate(timeout: float | None = None) -> tuple[str, str]:
            seen.append(timeout)
            return original(timeout=timeout)

        proc.communicate = communicate
        return proc

    monkeypatch.setattr(bootstrap_subprocess, "_spawn", fake_spawn)

    with bootstrap_subprocess.bootstrap_deadline(time.monotonic() + 20.0):
        bootstrap_subprocess.run(["python", "-c", "pass"], timeout=120)
        bootstrap_subprocess.run(["python", "-c", "pass"], timeout=5)
    bootstrap_subprocess.run(["python", "-c", "pass"], timeout=120)
    with bootstrap_subprocess.bootstrap_deadline(time.monotonic() - 5.0):
        bootstrap_subprocess.run(["python", "-c", "pass"], timeout=120)

    assert seen[0] is not None and 15.0 < seen[0] <= 20.0, "120s must drop to the ~20s left"
    assert seen[1] == 5.0, "a constant below the remaining budget is kept"
    assert seen[2] == 120.0, "outside the deadline block the constant stands"
    assert seen[3] == bootstrap_subprocess._MIN_TIMEOUT_SECONDS, (
        "an elapsed deadline still gives the step its one-second floor"
    )
