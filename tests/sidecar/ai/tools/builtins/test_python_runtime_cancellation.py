"""Behavioral regressions for Python runtime subprocess cancellation."""

from __future__ import annotations

import subprocess
import sys
import threading
import time
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import MagicMock

import psutil
import pytest

from sidecar.ai.error_codes import CMP_TOOL_COMMAND_ABORTED
from sidecar.ai.tools.builtins import cancellation
from sidecar.ai.tools.builtins.python_runtime import sandbox, tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

# The real wrapper imports the runtime venv's scientific stack, which the test
# interpreter does not carry. This stand-in keeps the real child process,
# argv shape and result file while running the script directly.
_STUB_RUNNER = """
import json, runpy, sys
runpy.run_path(sys.argv[2], run_name="__main__")
with open(sys.argv[3], "w", encoding="utf-8") as handle:
    json.dump({"schema_version": 1, "stdout": "", "stderr": "", "images": [],
               "tables": [], "error": None, "last_expr_repr": None}, handle)
"""


def _use_stub_runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runner = tmp_path / "stub_runner.py"
    runner.write_text(_STUB_RUNNER, encoding="utf-8")
    monkeypatch.setattr(
        sandbox.bootstrap_subprocess,
        "managed_python_argv",
        lambda python: [str(python), "-s", str(runner)],
    )


def test_real_child_cancellation_removes_process_and_scratch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sandbox.tempfile, "tempdir", str(tmp_path))
    _use_stub_runner(tmp_path, monkeypatch)
    abort_event = threading.Event()
    finished = threading.Event()
    child_pids: list[int] = []
    pid_path = tmp_path / "child.pid"

    def cancel_after_pid() -> None:
        deadline = time.monotonic() + 10.0
        while not finished.wait(0.01) and time.monotonic() < deadline:
            if pid_path.exists():
                pid_text = pid_path.read_text(encoding="ascii")
                if pid_text:
                    child_pids.append(int(pid_text))
                    abort_event.set()
                    return

    timer = threading.Thread(target=cancel_after_pid, daemon=True)
    timer.start()
    started = time.monotonic()
    try:
        with pytest.raises(RuntimeError) as caught:
            sandbox.execute_sandboxed(
                code=(
                    "import os, time\n"
                    "from pathlib import Path\n"
                    "Path('child.pid').write_text(str(os.getpid()), encoding='ascii')\n"
                    "time.sleep(60)\n"
                ),
                venv_python=Path(sys.executable),
                timeout_seconds=30,
                memory_limit_mb=512,
                working_directory=tmp_path,
                abort_event=abort_event,
            )
        assert time.monotonic() - started < 10.0
        assert isinstance(caught.value, sandbox.SandboxExecutionCancelled)
        assert caught.value.cleanup_confirmed is True
        assert len(child_pids) == 1
        # A venv interpreter on Windows is a launcher whose real interpreter
        # is a grandchild: the kill-on-close job reaps it as the sandbox exits.
        reap_deadline = time.monotonic() + 5.0
        while psutil.pid_exists(child_pids[0]) and time.monotonic() < reap_deadline:
            time.sleep(0.05)
        assert not psutil.pid_exists(child_pids[0])
        assert not list(tmp_path.glob("jenny-pyexec-*"))
    finally:
        finished.set()
        timer.join(timeout=1.0)


def test_pre_set_event_does_not_spawn_or_leave_scratch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sandbox.tempfile, "tempdir", str(tmp_path))
    abort_event = threading.Event()
    abort_event.set()

    def unexpected_spawn(*_args: object, **_kwargs: object) -> None:
        pytest.fail("cancelled execution must not spawn a child")

    monkeypatch.setattr(sandbox.subprocess, "Popen", unexpected_spawn)
    with pytest.raises(sandbox.SandboxExecutionCancelled) as caught:
        sandbox.execute_sandboxed(
            code="print('must not run')",
            venv_python=Path(sys.executable),
            timeout_seconds=30,
            memory_limit_mb=512,
            abort_event=abort_event,
        )
    assert caught.value.cleanup_confirmed is True
    assert not list(tmp_path.glob("jenny-pyexec-*"))


def test_no_abort_event_completes_normally(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sandbox.tempfile, "tempdir", str(tmp_path))
    _use_stub_runner(tmp_path, monkeypatch)
    result = sandbox.execute_sandboxed(
        code=(
            "from pathlib import Path\n"
            "Path('ran.marker').write_text('ok', encoding='ascii')\n"
        ),
        venv_python=Path(sys.executable),
        timeout_seconds=30,
        memory_limit_mb=512,
        working_directory=tmp_path,
        abort_event=None,
    )
    try:
        assert result.returncode == 0
        assert (tmp_path / "ran.marker").read_text(encoding="ascii") == "ok"
        assert result.payload["error"] is None
    finally:
        result.cleanup()
    assert not list(tmp_path.glob("jenny-pyexec-*"))


@pytest.mark.parametrize("unconfirmed", ["child_exit", "scratch_removal"])
def test_unconfirmed_cleanup_still_surfaces_as_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, unconfirmed: str
) -> None:
    monkeypatch.setattr(sandbox.tempfile, "tempdir", str(tmp_path))
    abort_event = threading.Event()
    proc = MagicMock()
    # A real-looking pid that no process group owns: a bare MagicMock indexes
    # as 1, which a POSIX killpg would aim at the init process group.
    proc.pid = 2**22 + 12345
    proc.poll.return_value = None
    proc.stdout.read.return_value = b""
    proc.stderr.read.return_value = b""
    if unconfirmed == "child_exit":
        proc.wait.side_effect = subprocess.TimeoutExpired("python", 5.0)
    else:
        proc.wait.return_value = 0

    def spawn(*_args: object, **_kwargs: object) -> MagicMock:
        abort_event.set()
        return proc

    def failed_remove(_path: Path) -> None:
        raise OSError("scratch directory is still in use")

    monkeypatch.setattr(sandbox.subprocess, "Popen", spawn)
    monkeypatch.setattr(sandbox, "JobObject", lambda **_kwargs: nullcontext(MagicMock()))
    if unconfirmed == "scratch_removal":
        monkeypatch.setattr(sandbox, "_remove_tree", failed_remove)
    with pytest.raises(sandbox.SandboxExecutionCancelled) as caught:
        sandbox.execute_sandboxed(
            code="print('cancelled')",
            venv_python=Path(sys.executable),
            timeout_seconds=30,
            memory_limit_mb=512,
            abort_event=abort_event,
        )
    assert caught.value.cleanup_confirmed is False
    proc.stdout.close.assert_called_once()
    proc.stderr.close.assert_called_once()


def test_tool_pre_set_event_reports_confirmed_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sandbox.tempfile, "tempdir", str(tmp_path))
    abort_event = threading.Event()
    abort_event.set()
    monkeypatch.setattr(cancellation, "current_abort_event", lambda: abort_event)
    monkeypatch.setattr(tool, "_PYTHON_RUNTIME_CONFIG", {})
    monkeypatch.setattr(tool, "ensure_runtime_venv", lambda _config, **_kwargs: Path(sys.executable))
    with pytest.raises(ToolExecutionFailure) as caught:
        tool.python_execute_tool({"code": "print('must not run')"}, WorkspaceGuard(str(tmp_path)))
    assert caught.value.code == CMP_TOOL_COMMAND_ABORTED
    assert caught.value.message == "python execution aborted by user cancellation"
    assert caught.value.retryable is False
    assert not list(tmp_path.glob("jenny-pyexec-*"))


def test_tool_unconfirmed_cancellation_reports_uncertain_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def cancelled_execution(**_kwargs: object) -> None:
        raise sandbox.SandboxExecutionCancelled(cleanup_confirmed=False)

    monkeypatch.setattr(tool, "_PYTHON_RUNTIME_CONFIG", {})
    monkeypatch.setattr(tool, "ensure_runtime_venv", lambda _config, **_kwargs: Path(sys.executable))
    monkeypatch.setattr(tool, "execute_sandboxed", cancelled_execution)
    with pytest.raises(ToolExecutionFailure) as caught:
        tool.python_execute_tool({"code": "print('cancelled')"}, WorkspaceGuard(str(tmp_path)))
    assert caught.value.code == CMP_TOOL_COMMAND_ABORTED
    assert caught.value.retryable is False
    assert caught.value.message == (
        "python execution aborted by user cancellation; cleanup could not be confirmed"
    )
