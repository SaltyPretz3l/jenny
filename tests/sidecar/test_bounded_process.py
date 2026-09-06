"""Guards for the bounded spawn helper shared by the policy checks.

`scripts/checks/run_all.py` (the whole-tree pre-commit driver) and pytest both
lack a wall clock of their own, so before this helper an unbounded Node or
Python probe inside a policy check blocked a commit or a test run forever with
nothing printed -- a `tests/sidecar/ai/plugins` run sat stuck for 4.5h on
2026-08-29. These tests pin the properties that make the seam trustworthy: the
ceiling fires and names itself, the whole process tree dies with it, and a
child that reads stdin sees EOF instead of parking on an inherited console.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import psutil
import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks import bounded_process  # noqa: E402
from scripts.checks.bounded_process import resolve_executable, run_bounded  # noqa: E402

# Prints nothing and exits immediately; used for the happy paths.
_ECHO_STDIN = "import sys; sys.stdout.write('[' + sys.stdin.read() + ']')"
# Records its own child's pid, then both generations sleep far past any ceiling
# used here. Only a tree kill reaps the grandchild.
_SPAWNS_A_GRANDCHILD = (
    "import pathlib,subprocess,sys,time;"
    "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(600)']);"
    "pathlib.Path(sys.argv[1]).write_text(str(p.pid), encoding='utf-8');"
    "time.sleep(600)"
)


def _kill_if_alive(pid: int) -> None:
    try:
        psutil.Process(pid).kill()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass


def test_resolve_executable_accepts_an_existing_interpreter() -> None:
    resolved = resolve_executable(sys.executable, needed_for="a unit test")

    assert Path(resolved).is_absolute()
    assert Path(resolved).exists()


def test_resolve_executable_names_the_binary_and_the_caller_when_missing() -> None:
    with pytest.raises(RuntimeError) as excinfo:
        resolve_executable("jenny-no-such-binary", needed_for="the plugin JavaScript AST probe")

    message = str(excinfo.value)
    assert "jenny-no-such-binary" in message
    assert "the plugin JavaScript AST probe" in message


def test_run_bounded_returns_stdout_for_a_normal_command() -> None:
    completed = run_bounded(
        [sys.executable, "-c", _ECHO_STDIN],
        label="echo probe",
        timeout_seconds=60,
        input_text="payload",
    )

    assert completed.returncode == 0
    assert completed.stdout == "[payload]"


def test_run_bounded_reports_a_failing_returncode_instead_of_raising() -> None:
    # Callers decide what a non-zero exit means (the parity check diffs its own
    # output, the boundary check raises); the helper must not pre-empt them.
    completed = run_bounded(
        [sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"],
        label="failing probe",
        timeout_seconds=60,
    )

    assert completed.returncode == 3
    assert completed.stderr == "boom"


def test_run_bounded_closes_stdin_when_there_is_no_input() -> None:
    # Without stdin=PIPE the child would inherit a console and a read() could
    # park forever; an empty read proves the pipe was opened and closed.
    completed = run_bounded(
        [sys.executable, "-c", _ECHO_STDIN],
        label="stdin probe",
        timeout_seconds=60,
    )

    assert completed.returncode == 0
    assert completed.stdout == "[]"


@pytest.mark.skipif(
    not sys.platform.startswith("win"),
    reason="tree kill is taskkill-based; on POSIX kill_tree only reaps the direct child",
)
def test_run_bounded_kills_the_whole_tree_when_the_ceiling_fires(tmp_path: Path) -> None:
    pid_file = tmp_path / "grandchild.pid"
    started = time.monotonic()

    with pytest.raises(RuntimeError) as excinfo:
        run_bounded(
            [sys.executable, "-c", _SPAWNS_A_GRANDCHILD, str(pid_file)],
            label="tree-kill probe",
            timeout_seconds=4,
        )

    elapsed = time.monotonic() - started
    message = str(excinfo.value)
    assert "tree-kill probe" in message, message
    # Not `"4" in message`: the message embeds the command, and tmp_path can
    # contain a literal 4, so that oracle passes for the wrong reason.
    assert "exceeded 4s" in message, message
    # The point of the ceiling is that it fires promptly, not eventually.
    assert elapsed < 30, f"kill path took {elapsed:.1f}s"

    assert pid_file.exists(), "probe did not reach the grandchild spawn before the ceiling"
    grandchild = int(pid_file.read_text(encoding="utf-8"))
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and psutil.pid_exists(grandchild):
            time.sleep(0.1)
        assert not psutil.pid_exists(grandchild), "grandchild survived the tree kill"
    finally:
        _kill_if_alive(grandchild)


def test_run_bounded_reaps_the_child_when_the_wait_is_interrupted(monkeypatch, tmp_path: Path) -> None:
    # Ctrl-C during the pre-commit gate raises inside communicate(). Without the
    # bare-except guard the child is simply abandoned, still running and still
    # holding the pipes -- subprocess.run() guards this and this helper must too.
    pid_file = tmp_path / "grandchild.pid"
    real_popen = subprocess.Popen
    spawned: list[subprocess.Popen[str]] = []

    def _popen_interrupted_once(args, **kwargs):
        process = real_popen(args, **kwargs)
        # Only the probe itself: kill_tree's own taskkill call must run normally.
        if args and args[0] == sys.executable:
            spawned.append(process)
            original = process.communicate
            calls = {"count": 0}

            def _communicate(input=None, timeout=None):  # noqa: A002
                calls["count"] += 1
                if calls["count"] == 1:
                    time.sleep(2)  # let the probe reach its grandchild spawn
                    raise KeyboardInterrupt
                return original(input=input, timeout=timeout)

            process.communicate = _communicate
        return process

    monkeypatch.setattr(bounded_process.subprocess, "Popen", _popen_interrupted_once)

    with pytest.raises(KeyboardInterrupt):
        run_bounded(
            [sys.executable, "-c", _SPAWNS_A_GRANDCHILD, str(pid_file)],
            label="interrupted probe",
            timeout_seconds=60,
        )

    assert len(spawned) == 1
    child = spawned[0].pid
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and psutil.pid_exists(child):
            time.sleep(0.1)
        assert not psutil.pid_exists(child), "child survived an interrupted wait"
    finally:
        _kill_if_alive(child)
        if pid_file.exists():
            _kill_if_alive(int(pid_file.read_text(encoding="utf-8")))


@pytest.mark.skipif(not sys.platform.startswith("win"), reason="taskkill is Windows-only")
def test_kill_tree_says_so_when_taskkill_fails(monkeypatch, capsys) -> None:
    # A silent taskkill failure is the worst case: descendants survive while the
    # caller reports a clean tree kill. The fallback must still run, and must
    # not pretend it reached the whole tree.
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(600)"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        def _failing_taskkill(args, **_kwargs):
            assert args[0] == "taskkill"
            return subprocess.CompletedProcess(args, 1, "", "ERROR: Access is denied.")

        monkeypatch.setattr(bounded_process.subprocess, "run", _failing_taskkill)
        bounded_process.kill_tree(process)

        warning = capsys.readouterr().err
        assert "taskkill failed" in warning, warning
        assert str(process.pid) in warning, warning
        assert "descendants may survive" in warning, warning
        assert "Access is denied" in warning, warning
        # The direct-child fallback still has to run.
        assert process.wait(timeout=10) is not None
    finally:
        _kill_if_alive(process.pid)


def test_kill_tree_is_a_no_op_for_an_already_exited_process(monkeypatch) -> None:
    process = subprocess.Popen(
        [sys.executable, "-c", "pass"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    process.communicate(timeout=30)

    def _unexpected_spawn(*_args, **_kwargs):
        raise AssertionError("kill_tree spawned taskkill for a process that already exited")

    monkeypatch.setattr(bounded_process.subprocess, "run", _unexpected_spawn)

    bounded_process.kill_tree(process)
