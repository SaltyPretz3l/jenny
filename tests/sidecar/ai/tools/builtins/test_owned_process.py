"""Regression gates for WIDE-015 and WIDE-041 process ownership."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar import _owned_process_bootstrap as owned_process_bootstrap_module
from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins import git_ops as git_ops_module
from sidecar.ai.tools.builtins import git_process as git_process_module
from sidecar.ai.tools.builtins import owned_process as owned_process_module
from sidecar.ai.tools.builtins import owned_process_windows as owned_process_windows_module
from sidecar.ai.tools.builtins import shell_background as shell_background_module
from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcessCapacityError,
    OwnedProcessService,
    OwnedProcessShutdownError,
)
from sidecar.ai.tools.builtins.shell import run_command_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _wait_until(predicate: object, *, timeout_seconds: float = 2.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if callable(predicate) and predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition did not settle before the test deadline")


def test_sync_shell_high_volume_capture_is_bounded_and_counted(tmp_path: Path) -> None:
    script = tmp_path / "emit_both.py"
    script.write_text(
        "import sys\n"
        "chunk = 'x' * 65536\n"
        "for _ in range(40):\n"
        "    sys.stdout.write(chunk)\n"
        "    sys.stderr.write(chunk)\n",
        encoding="utf-8",
    )
    command = subprocess.list2cmdline([sys.executable, str(script)])

    # The bounded-capture contract requires the child to have actually run to
    # completion (exit 0). Under whole-machine contention (-n 8 alongside the
    # JS suite) the launch chain can transiently fail before the child writes
    # anything (observed: Windows bootstrap target Popen failure -> exit 126,
    # zero counters), and a tight timeout can expire on pure CPU starvation.
    # Those are infra failures outside this contract, so retry them; a real
    # capture/counting regression keeps exit 0 and fails on every attempt.
    body: dict[str, object] = {}
    for attempt in range(3):
        try:
            result = run_command_tool(
                {"command": command, "timeout_seconds": 60},
                _guard(tmp_path),
            )
        except ToolExecutionFailure:
            if attempt == 2:
                raise
            continue
        body = json.loads(result.output)
        if body.get("exit_code") == 0:
            break
    assert body.get("exit_code") == 0, body

    counters = body.get("output_counters")
    assert isinstance(counters, dict), body
    assert counters["stdout_bytes"] == 40 * 65536, body
    assert counters["stderr_bytes"] == 40 * 65536, body
    assert counters["captured_bytes"] <= 4 * 1024 * 1024, body
    assert counters["discarded_bytes"] > 0, body
    assert body["output_truncated"] is True, body
    assert body["full_output_complete"] is False, body


class _BlockingProcess:
    def __init__(self, release: threading.Event, pid: int) -> None:
        self._release = release
        self.pid = pid
        self.returncode: int | None = None

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        self._release.wait(timeout=5.0)
        self.returncode = 0
        return "done", ""

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        self._release.wait(timeout=timeout or 5.0)
        self.returncode = 0
        return 0

    def terminate(self) -> None:
        self.returncode = -15
        self._release.set()

    def kill(self) -> None:
        self.returncode = -9
        self._release.set()


def test_background_process_saturation_refuses_before_spawn(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    release = threading.Event()
    spawned = 0

    def _spawn(_argv: list[str], *, cwd: Path) -> object:
        nonlocal spawned
        spawned += 1
        return shell_background_module._ManagedBackgroundProcess(  # noqa: SLF001
            process=_BlockingProcess(release, 10_000 + spawned)
        )

    monkeypatch.setattr(shell_background_module, "_spawn_background_process", _spawn)
    with shell_background_module._lock:  # noqa: SLF001
        shell_background_module._active_jobs.clear()  # noqa: SLF001

    try:
        for _ in range(4):
            shell_background_module.start_background_job(
                ["fake"],
                cwd=tmp_path,
                workspace_root=tmp_path,
                timeout_seconds=30,
            )

        with pytest.raises(ToolExecutionFailure) as raised:
            shell_background_module.start_background_job(
                ["fake"],
                cwd=tmp_path,
                workspace_root=tmp_path,
                timeout_seconds=30,
            )
        assert raised.value.code == CMP_TOOL_CAP_EXCEEDED
        assert spawned == 4
    finally:
        release.set()
        _wait_until(lambda: not shell_background_module._active_jobs)  # noqa: SLF001


def test_initial_status_publication_failure_terminates_before_refusal(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    release = threading.Event()
    process = _BlockingProcess(release, 20_001)
    managed = shell_background_module._ManagedBackgroundProcess(process=process)  # noqa: SLF001
    terminated: list[object] = []

    monkeypatch.setattr(
        shell_background_module,
        "_spawn_background_process",
        lambda _argv, *, cwd: managed,
    )
    monkeypatch.setattr(shell_background_module, "_write_status", lambda *_a, **_kw: False)

    def _terminate(job: object, *, timeout_seconds: float) -> None:
        terminated.append(job)
        process.terminate()

    monkeypatch.setattr(shell_background_module, "_terminate_background_process", _terminate)
    with shell_background_module._lock:  # noqa: SLF001
        shell_background_module._active_jobs.clear()  # noqa: SLF001

    with pytest.raises(ToolExecutionFailure) as raised:
        shell_background_module.start_background_job(
            ["fake"],
            cwd=tmp_path,
            workspace_root=tmp_path,
            timeout_seconds=30,
        )

    assert raised.value.code == CMP_TOOL_IO_FAILED
    assert terminated == [managed]
    assert process.poll() is not None
    assert not shell_background_module._active_jobs  # noqa: SLF001


def test_terminal_status_failure_uses_bounded_in_memory_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    release = threading.Event()
    release.set()
    process = _BlockingProcess(release, 30_001)
    managed = shell_background_module._ManagedBackgroundProcess(process=process)  # noqa: SLF001
    original_write_status = shell_background_module._write_status  # noqa: SLF001

    monkeypatch.setattr(
        shell_background_module,
        "_spawn_background_process",
        lambda _argv, *, cwd: managed,
    )

    def _fail_terminal_status(store: object, job_ref: object, status: dict[str, object]) -> bool:
        if status.get("state") == "running":
            original_write_status(store, job_ref, status)
            return True
        return False

    monkeypatch.setattr(shell_background_module, "_write_status", _fail_terminal_status)
    with shell_background_module._lock:  # noqa: SLF001
        shell_background_module._active_jobs.clear()  # noqa: SLF001

    job_id, _pid = shell_background_module.start_background_job(
        ["fake"],
        cwd=tmp_path,
        workspace_root=tmp_path,
        timeout_seconds=30,
    )
    _wait_until(lambda: job_id not in shell_background_module._active_jobs)  # noqa: SLF001

    status = shell_background_module.read_background_job(tmp_path, job_id)
    assert status["state"] == "completed"
    assert status["exit_code"] == 0
    assert status["stdout"] == "done"


def test_stale_running_status_is_reconciled_after_restart(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    job_id = "abcdef012345"
    status_dir = tmp_path / ".jenny" / "tool-results" / job_id
    status_dir.mkdir(parents=True)
    status_file = status_dir / "status.json"
    status_file.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "job_id": job_id,
                "state": "running",
                "pid": 99_999,
            }
        ),
        encoding="utf-8",
    )
    old = time.time() - 30
    status_file.touch()
    os.utime(status_file, (old, old))
    monkeypatch.setattr(shell_background_module, "_process_is_alive", lambda _pid: False)

    status = shell_background_module.read_background_job(tmp_path, job_id)

    assert status["state"] == "failed"
    assert status["exit_code"] == -1
    assert "ownership was lost" in str(status["error"])
    persisted = json.loads(status_file.read_text(encoding="utf-8"))
    assert persisted["state"] == "failed"


@pytest.mark.skipif(os.name != "nt", reason="Windows-specific safe liveness probe")
def test_windows_pid_liveness_never_uses_os_kill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[int] = []

    def _safe_probe(pid: int) -> bool:
        observed.append(pid)
        return True

    monkeypatch.setattr(
        owned_process_module,
        "windows_process_is_alive",
        _safe_probe,
    )

    def _unsafe_kill(*_args: object) -> None:
        raise AssertionError("Windows liveness must not call os.kill")

    monkeypatch.setattr(owned_process_module.os, "kill", _unsafe_kill)

    assert owned_process_module.owned_process_pid_is_alive(1234) is True
    assert observed == [1234]


class _FakeWinFunction:
    def __init__(self, return_value: int) -> None:
        self.return_value = return_value
        self.calls: list[tuple[object, ...]] = []
        self.argtypes: list[object] | None = None
        self.restype: object | None = None

    def __call__(self, *args: object) -> int:
        self.calls.append(args)
        return self.return_value


class _FakeKernel32:
    def __init__(self) -> None:
        self.job_handle = 0x1_0000_0001
        self.process_handle = 0x2_0000_0002
        self.CreateJobObjectW = _FakeWinFunction(self.job_handle)
        self.SetInformationJobObject = _FakeWinFunction(1)
        self.OpenProcess = _FakeWinFunction(self.process_handle)
        self.AssignProcessToJobObject = _FakeWinFunction(1)
        self.CloseHandle = _FakeWinFunction(1)
        self.GetExitCodeProcess = _FakeWinFunction(1)
        self.GetLastError = _FakeWinFunction(0)


def test_windows_job_bindings_pin_pointer_safe_signatures_and_handles() -> None:
    kernel32 = _FakeKernel32()

    job = owned_process_windows_module.WindowsJobObject(kernel32=kernel32)
    job.assign_pid(4321)
    job.close()

    assert kernel32.CreateJobObjectW.argtypes is not None
    assert kernel32.CreateJobObjectW.restype is not None
    assert kernel32.OpenProcess.argtypes is not None
    assert kernel32.OpenProcess.restype is not None
    assert kernel32.AssignProcessToJobObject.argtypes is not None
    assert kernel32.AssignProcessToJobObject.restype is not None
    assert kernel32.SetInformationJobObject.calls[0][0] == kernel32.job_handle
    assert kernel32.AssignProcessToJobObject.calls == [
        (kernel32.job_handle, kernel32.process_handle)
    ]
    assert kernel32.CloseHandle.calls == [
        (kernel32.process_handle,),
        (kernel32.job_handle,),
    ]


def test_windows_bootstrap_preserves_target_contract(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    observed: dict[str, object] = {}

    class _TargetProcess:
        def wait(self) -> int:
            return 17

    def _popen(argv: list[str], **kwargs: object) -> _TargetProcess:
        observed["argv"] = argv
        observed.update(kwargs)
        return _TargetProcess()

    # The bootstrap half now lives in `sidecar/_owned_process_bootstrap.py` (kept
    # out of this package so a spawn does not import the tool runtime); patch it
    # there. `owned_process_windows` re-exports the same objects, so the calls
    # below still go through this module's public surface.
    monkeypatch.setattr(owned_process_bootstrap_module.subprocess, "Popen", _popen)
    frame = owned_process_windows_module.encode_windows_bootstrap_payload(
        ["tool.exe", "", "argument with spaces"],
        cwd=tmp_path,
        env={"SAFE_KEY": "safe-value"},
    )

    exit_code = owned_process_windows_module.run_windows_owned_process_bootstrap(
        io.BytesIO(frame)
    )

    assert exit_code == 17
    assert observed["argv"] == ["tool.exe", "", "argument with spaces"]
    assert observed["cwd"] == str(tmp_path)
    assert observed["env"] == {"SAFE_KEY": "safe-value"}
    assert observed["stdin"] == subprocess.DEVNULL


def test_windows_bootstrap_preserves_cmd_command_string(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    observed: dict[str, object] = {}

    class _TargetProcess:
        def wait(self) -> int:
            return 0

    def _popen(argv: list[str] | str, **kwargs: object) -> _TargetProcess:
        observed["argv"] = argv
        observed.update(kwargs)
        return _TargetProcess()

    monkeypatch.setattr(owned_process_bootstrap_module.sys, "platform", "win32")
    monkeypatch.setattr(owned_process_bootstrap_module.subprocess, "Popen", _popen)
    command = '"C:\\Program Files\\Python\\python.exe" "script file.py" && echo done'
    frame = owned_process_windows_module.encode_windows_bootstrap_payload(
        ["cmd.exe", "/d", "/s", "/c", command],
        cwd=tmp_path,
        env=None,
    )

    exit_code = owned_process_windows_module.run_windows_owned_process_bootstrap(
        io.BytesIO(frame)
    )

    assert exit_code == 0
    assert observed["argv"] == (
        "cmd.exe /d /s /c "
        '""C:\\Program Files\\Python\\python.exe" "script file.py" && echo done"'
    )


@pytest.mark.skipif(os.name != "nt", reason="Windows Job bootstrap race oracle")
def test_windows_target_cannot_start_before_job_assignment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    marker = tmp_path / "target-started.txt"
    script = tmp_path / "target.py"
    script.write_text(
        "import pathlib, sys\n"
        "pathlib.Path(sys.argv[1]).write_text('started', encoding='utf-8')\n"
        "print('target-output')\n",
        encoding="utf-8",
    )
    assignment_entered = threading.Event()
    permit_assignment = threading.Event()
    real_job_type = owned_process_windows_module.WindowsJobObject

    class _DelayedJob(real_job_type):
        def assign_pid(self, pid: int) -> None:
            assignment_entered.set()
            if not permit_assignment.wait(timeout=5):
                raise AssertionError("test did not release Job assignment")
            super().assign_pid(pid)

    monkeypatch.setattr(owned_process_module, "WindowsJobObject", _DelayedJob)
    service = OwnedProcessService()
    argv = [sys.executable, str(script), str(marker)]
    spawned: list[object] = []
    errors: list[BaseException] = []

    def _spawn() -> None:
        try:
            spawned.append(service.spawn(argv, cwd=tmp_path, allow_queue=False))
        except BaseException as error:  # pragma: no cover - reported below
            errors.append(error)

    thread = threading.Thread(target=_spawn)
    thread.start()
    assert assignment_entered.wait(timeout=5)
    time.sleep(0.2)
    assert not marker.exists(), "target escaped before Job assignment completed"

    permit_assignment.set()
    thread.join(timeout=5)
    assert not thread.is_alive()
    assert not errors
    assert len(spawned) == 1
    result = service.wait(spawned[0], timeout_seconds=5)  # type: ignore[arg-type]
    assert result.args == tuple(argv)
    assert result.returncode == 0
    assert result.stdout.strip() == "target-output"
    assert marker.read_text(encoding="utf-8") == "started"


@pytest.mark.skipif(os.name != "nt", reason="Windows Job bootstrap refusal oracle")
def test_windows_job_assignment_refusal_never_releases_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    marker = tmp_path / "refused-target-started.txt"
    script = tmp_path / "refused_target.py"
    script.write_text(
        "import pathlib, sys\n"
        "pathlib.Path(sys.argv[1]).write_text('escaped', encoding='utf-8')\n",
        encoding="utf-8",
    )
    real_job_type = owned_process_windows_module.WindowsJobObject

    class _RefusingJob(real_job_type):
        def assign_pid(self, pid: int) -> None:
            time.sleep(0.2)
            raise OSError("simulated Job assignment refusal")

    monkeypatch.setattr(owned_process_module, "WindowsJobObject", _RefusingJob)
    service = OwnedProcessService()

    with pytest.raises(OSError, match="simulated Job assignment refusal"):
        service.spawn(
            [sys.executable, str(script), str(marker)],
            cwd=tmp_path,
            allow_queue=False,
        )

    time.sleep(0.2)
    assert not marker.exists(), "target escaped after Job assignment refusal"
    assert service.snapshot().active == 0


def test_owned_process_drains_blocking_stdout_and_stderr_concurrently(
    tmp_path: Path,
) -> None:
    script = tmp_path / "blocked_reader.py"
    script.write_text(
        "import os\n"
        "chunk = b'x' * 65536\n"
        "for _ in range(96):\n"
        "    os.write(1, chunk)\n"
        "os.write(2, b'stderr-finished')\n",
        encoding="utf-8",
    )
    service = OwnedProcessService(max_capture_bytes=256 * 1024)

    result = service.run(
        [sys.executable, str(script)],
        cwd=tmp_path,
        timeout_seconds=10,
    )

    assert result.returncode == 0
    assert result.output.stdout_bytes == 96 * 65536
    assert result.output.stderr_bytes == len(b"stderr-finished")
    assert result.output.captured_bytes <= 256 * 1024
    assert result.output.discarded_bytes > 0
    assert service.snapshot().active == 0


def test_posix_owned_process_stdin_is_closed_and_service_remains_usable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    real_popen = subprocess.Popen
    observed_stdin: list[object] = []

    def _popen(argv: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
        observed_stdin.append(kwargs.get("stdin"))
        return real_popen(argv, **kwargs)

    monkeypatch.setattr(
        owned_process_module,
        "os",
        SimpleNamespace(name="posix"),
    )
    monkeypatch.setattr(owned_process_module.subprocess, "Popen", _popen)
    service = OwnedProcessService(max_active=1, max_queued=0)

    eof_result = service.run(
        [
            sys.executable,
            "-c",
            "import sys; print(len(sys.stdin.buffer.read()))",
        ],
        cwd=tmp_path,
        timeout_seconds=5,
    )
    followup_result = service.run(
        [sys.executable, "-c", "print('ready')"],
        cwd=tmp_path,
        timeout_seconds=5,
    )

    assert eof_result.returncode == 0
    assert eof_result.stdout.strip() == "0"
    assert followup_result.returncode == 0
    assert followup_result.stdout.strip() == "ready"
    assert observed_stdin == [subprocess.DEVNULL, subprocess.DEVNULL]
    assert service.snapshot().active == 0


def test_git_adapter_routes_through_owned_process_service(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: dict[str, object] = {}

    class _FakeOwner:
        def run(self, argv: list[str], **kwargs: object) -> object:
            captured["argv"] = argv
            captured.update(kwargs)
            return subprocess.CompletedProcess(argv, 0, "owned-output", "")

    owner = _FakeOwner()

    def _get_owner() -> _FakeOwner:
        return owner

    monkeypatch.setattr(
        git_process_module,
        "get_owned_process_service",
        _get_owner,
    )

    output = git_ops_module._run_git(["status"], cwd=tmp_path)  # noqa: SLF001

    assert output == "owned-output"
    assert captured["argv"][:3] == ["git", "--no-pager", "--no-optional-locks"]
    assert captured["cwd"] == tmp_path
    assert captured["timeout_seconds"] == git_ops_module.GIT_TIMEOUT_SECONDS


def test_background_job_uses_owned_bounded_capture(tmp_path: Path) -> None:
    script = tmp_path / "background_output.py"
    script.write_text(
        "import os\n"
        "chunk = b'x' * 65536\n"
        "for _ in range(48):\n"
        "    os.write(1, chunk)\n"
        "    os.write(2, chunk)\n",
        encoding="utf-8",
    )
    job_id, _pid = shell_background_module.start_background_job(
        [sys.executable, str(script)],
        cwd=tmp_path,
        workspace_root=tmp_path,
        timeout_seconds=10,
    )

    status: dict[str, object] = {}
    _wait_until(
        lambda: bool(
            status.update(shell_background_module.read_background_job(tmp_path, job_id))
            or status.get("state") in {"completed", "failed"}
        ),
        timeout_seconds=10,
    )

    assert status["state"] == "completed"
    assert status["output_truncated"] is True
    assert status["output_size_exceeded"] is True
    assert status["full_output_complete"] is False
    assert status["output_counters"]["discarded_bytes"] > 0
    full_output_path = Path(str(status["full_output_path"]))
    assert full_output_path.stat().st_size <= 4 * 1024 * 1024 + 256


def test_owned_process_timeout_terminates_spawned_grandchild(tmp_path: Path) -> None:
    child_marker = tmp_path / "child-survived.txt"
    spawned_marker = tmp_path / "child-spawned.txt"
    child = tmp_path / "child.py"
    parent = tmp_path / "parent.py"
    child.write_text(
        "import pathlib, sys, time\n"
        "time.sleep(2.0)\n"
        "pathlib.Path(sys.argv[1]).write_text('survived', encoding='utf-8')\n",
        encoding="utf-8",
    )
    parent.write_text(
        "import pathlib, subprocess, sys, time\n"
        "subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])\n"
        "pathlib.Path(sys.argv[3]).write_text('spawned', encoding='utf-8')\n"
        "time.sleep(30)\n",
        encoding="utf-8",
    )
    service = OwnedProcessService()

    result = service.run(
        [
            sys.executable,
            str(parent),
            str(child),
            str(child_marker),
            str(spawned_marker),
        ],
        cwd=tmp_path,
        timeout_seconds=1.0,
    )

    assert result.timed_out is True
    assert spawned_marker.exists(), "parent did not reach the grandchild-spawn checkpoint"
    time.sleep(1.5)
    assert not child_marker.exists()
    assert service.snapshot().active == 0


def test_owned_process_normal_exit_terminates_spawned_grandchild(tmp_path: Path) -> None:
    child_marker = tmp_path / "normal-exit-child-survived.txt"
    spawned_marker = tmp_path / "normal-exit-child-spawned.txt"
    child = tmp_path / "normal_exit_child.py"
    parent = tmp_path / "normal_exit_parent.py"
    child.write_text(
        "import pathlib, sys, time\n"
        "time.sleep(2.0)\n"
        "pathlib.Path(sys.argv[1]).write_text('survived', encoding='utf-8')\n",
        encoding="utf-8",
    )
    parent.write_text(
        "import pathlib, subprocess, sys\n"
        "subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])\n"
        "pathlib.Path(sys.argv[3]).write_text('spawned', encoding='utf-8')\n",
        encoding="utf-8",
    )
    service = OwnedProcessService()

    result = service.run(
        [
            sys.executable,
            str(parent),
            str(child),
            str(child_marker),
            str(spawned_marker),
        ],
        cwd=tmp_path,
        timeout_seconds=5.0,
    )

    assert result.returncode == 0
    assert result.timed_out is False
    assert spawned_marker.exists(), "parent did not spawn its child"
    time.sleep(2.5)
    assert not child_marker.exists()
    assert service.snapshot().active == 0


def test_owned_process_abort_and_shutdown_release_capacity(tmp_path: Path) -> None:
    sleeper = tmp_path / "sleep.py"
    sleeper.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
    service = OwnedProcessService(max_active=1, max_queued=0)
    abort_event = threading.Event()
    abort_event.set()

    aborted = service.run(
        [sys.executable, str(sleeper)],
        cwd=tmp_path,
        timeout_seconds=30,
        abort_event=abort_event,
    )
    assert aborted.aborted is True
    assert service.snapshot().active == 0

    owned = service.spawn(
        [sys.executable, str(sleeper)],
        cwd=tmp_path,
        allow_queue=False,
    )
    service.shutdown()
    assert owned.process.poll() is not None
    assert service.snapshot().active == 0
    with pytest.raises(OwnedProcessShutdownError):
        service.spawn(
            [sys.executable, str(sleeper)],
            cwd=tmp_path,
            allow_queue=False,
        )


def test_pipe_reader_start_failure_terminates_and_releases_capacity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    sleeper = tmp_path / "reader_failure_sleep.py"
    sleeper.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
    service = OwnedProcessService(max_active=1, max_queued=0)
    owned = service.spawn(
        [sys.executable, str(sleeper)],
        cwd=tmp_path,
        allow_queue=False,
    )

    def _fail_reader(*_args: object, **_kwargs: object) -> threading.Thread:
        raise RuntimeError("reader thread unavailable")

    monkeypatch.setattr(service, "_start_reader", _fail_reader)

    with pytest.raises(RuntimeError, match="reader thread unavailable"):
        service.wait(owned, timeout_seconds=30)

    assert owned.process.poll() is not None
    assert service.snapshot().active == 0


def test_owned_process_caps_active_and_queued_work(tmp_path: Path) -> None:
    sleeper = tmp_path / "short_sleep.py"
    sleeper.write_text("import time\ntime.sleep(0.1)\n", encoding="utf-8")
    service = OwnedProcessService(max_active=1, max_queued=1)
    first = service.spawn(
        [sys.executable, str(sleeper)],
        cwd=tmp_path,
        allow_queue=False,
    )
    queued_results: list[object] = []

    def _run_queued() -> None:
        queued_results.append(
            service.run(
                [sys.executable, str(sleeper)],
                cwd=tmp_path,
                timeout_seconds=5,
            )
        )

    queued_thread = threading.Thread(target=_run_queued)
    queued_thread.start()
    _wait_until(lambda: service.snapshot().queued == 1)

    with pytest.raises(OwnedProcessCapacityError):
        service.spawn(
            [sys.executable, str(sleeper)],
            cwd=tmp_path,
            allow_queue=True,
            queue_timeout_seconds=0,
        )

    service.cancel(first)
    queued_thread.join(timeout=5)
    assert not queued_thread.is_alive()
    assert len(queued_results) == 1
    assert service.snapshot().active == 0
    assert service.snapshot().queued == 0
