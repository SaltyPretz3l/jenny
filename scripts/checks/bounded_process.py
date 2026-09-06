"""Bounded external spawns for the policy checks.

Every check that shells out is reached from the pre-commit gate
(``scripts/checks/run_all.py``), the pytest suite, or both, and neither has a
wall clock of its own: a child that never exits blocks a commit or a test run
forever with no error to read. A plugins-suite run stuck for 4.5h on
2026-08-29 had no bounded seam to fail at. These helpers give every spawn a
ceiling, reap the whole tree when it fires, and turn a hang into a named
failure.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path
from shutil import which

import psutil


def _process_group_kwargs() -> dict[str, object]:
    """Start the child so a whole-tree kill can reach it.

    On POSIX a new session makes the child its own process-group leader, which
    is what lets killpg reach descendants. Windows needs nothing here: taskkill
    /T walks the PID tree instead. Mirrors
    scripts/packaging/build_sidecar_artifact.py::_subprocess_group_kwargs.
    """
    if sys.platform.startswith("win"):
        return {}
    return {"start_new_session": True}


def resolve_executable(name: str, *, needed_for: str) -> str:
    """Resolve ``name`` on PATH once, explicitly.

    A missing interpreter then fails here with a readable message instead of
    surfacing as a bare FileNotFoundError from inside a parametrized test.
    Callers pass the resolved absolute path so the spawn cannot re-race PATH.
    """
    resolved = which(name)
    if resolved is None:
        raise RuntimeError(f"`{name}` is not on PATH but {needed_for} requires it")
    return resolved


def kill_tree(process: subprocess.Popen[str]) -> None:
    """Stop ``process`` and everything it spawned."""
    if process.poll() is not None:
        return
    # Windows has no process group to signal and a probe can own grandchildren,
    # so taskkill /T is the only reliable way to reach the whole tree. Mirrors
    # scripts/checks/run_ci.py::_terminate_process_tree.
    if sys.platform.startswith("win"):
        try:
            killed = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )
            if killed.returncode == 0:
                return
            # The fallback below reaches the direct child only, so descendants
            # survive. Say that out loud instead of letting the caller report a
            # clean tree kill it never got.
            detail = (killed.stderr or killed.stdout or "taskkill failed").strip()
            print(
                f"WARN: taskkill failed for pid {process.pid}; attempting a psutil "
                f"descendant sweep before killing the direct child, descendants may survive: "
                f"{detail[-500:]}",
                file=sys.stderr,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
        # taskkill can be denied even for a same-user tree inside a managed job.
        # psutil still lets us enumerate and terminate those descendants. Kill
        # leaves first so a parent cannot orphan a still-running grandchild.
        try:
            descendants = psutil.Process(process.pid).children(recursive=True)
        except (psutil.Error, OSError):
            descendants = []
        for descendant in reversed(descendants):
            try:
                descendant.kill()
            except (psutil.Error, OSError):
                pass
    else:
        # run_bounded starts POSIX children with start_new_session, so the child
        # leads its own group and killpg reaches the descendants taskkill would
        # get on Windows. Unverified from this Windows-only checkout; the idiom
        # is copied from build_sidecar_artifact.py, which uses the same pairing.
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            return
        except (OSError, AttributeError):
            pass
    try:
        process.kill()
    except OSError:
        pass


def _reap(process: subprocess.Popen[str]) -> str:
    """Kill ``process``'s tree and drain its pipes, returning what it managed to say.

    The drain is what closes the pipes; without it the caller can block a second
    time on a process that is already gone. It is bounded like everything else
    here -- ``subprocess.run`` would ``wait()`` unbounded in its context manager,
    which is the exact failure this module exists to prevent.
    """
    kill_tree(process)
    try:
        stdout, stderr = process.communicate(timeout=10)
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return ""
    # Separated: concatenating them bare runs the last stderr line into the
    # first stdout line, which is exactly the text an operator reads to find
    # out why the probe stalled.
    return "\n".join(part.strip() for part in (stderr, stdout) if part and part.strip())


# PLR0913: every knob is a distinct spawn hazard this helper exists to close
# (what to run, what to call it when it hangs, the ceiling, where, what to feed
# stdin, and how to decode). Collapsing any of them into a default would push
# the decision back to the call sites this helper is meant to unify -- the
# parity check decodes strictly on purpose, the boundary probe replaces, and
# run_all.py must stay locale-native.
def run_bounded(  # noqa: PLR0913
    command: list[str],
    *,
    label: str,
    timeout_seconds: float,
    cwd: Path | None = None,
    input_text: str | None = None,
    encoding: str | None = "utf-8",
    errors: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run ``command`` to completion under a hard ceiling.

    On timeout the process tree is killed and a RuntimeError naming ``label``,
    the ceiling, and the command is raised -- never a silent forever-wait.
    """
    process = subprocess.Popen(
        command,
        cwd=cwd,
        # stdin is always a pipe that gets closed, so a child that reads stdin
        # cannot park forever waiting on an inherited console.
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding=encoding,
        errors=errors,
        **_process_group_kwargs(),
    )
    try:
        stdout, stderr = process.communicate(input=input_text, timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        said = _reap(process)
        detail = f"; last output: {said[-500:]}" if said else ""
        raise RuntimeError(
            f"{label} exceeded {timeout_seconds}s and was killed: {' '.join(command)}{detail}"
        ) from None
    except BaseException:
        # Ctrl-C in the pre-commit gate, or a strict-decode failure on the
        # child's output. subprocess.run() guards this with a bare `except:
        # process.kill(); raise`; without the same guard the child outlives the
        # call that started it and keeps holding the pipes.
        _reap(process)
        raise
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
