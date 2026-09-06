"""Contained subprocess runs for the managed Python runtime bootstrap.

Every bootstrap step -- interpreter probes, venv creation, the wheelhouse /
``uv`` / network installs, import validation, the pip probe -- used to go
through a bare ``subprocess.run(..., timeout=N)``. On timeout that kills the
direct child only: ``python -m venv`` spawns ``ensurepip``, pip spawns build
backends on the network path, and each of those outlived the deadline as an
orphan holding the staging tree open. The oddity was local: ``sandbox.py`` in
this same package treats containment as mandatory for the user's code while
the machinery that builds the sandbox had none.

``run`` keeps the ``subprocess.run`` call shape the bootstrap already uses
(and its tests already stub) but launches the child inside a Windows Job
Object -- created suspended, assigned, then resumed, the same launch gate
``sandbox.py`` uses so a descendant created before assignment cannot escape --
or in a fresh POSIX session, so a timeout or an interrupted bootstrap takes
the whole tree with it.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from contextlib import contextmanager, suppress
from contextvars import ContextVar
from typing import Any, Iterator, Sequence

from sidecar.ai.tools.builtins.python_runtime.job_object import JobObject

IS_WINDOWS = os.name == "nt"

# Generous by design. These caps exist so KILL_ON_JOB_CLOSE reaches every
# descendant, not to police pip's memory: a limit tight enough to kill a
# legitimate wheel unpack would recreate the "fails identically forever"
# class the resume path was built to end.
BOOTSTRAP_JOB_MEMORY_LIMIT_MB = 4096
BOOTSTRAP_JOB_MAX_PROCESSES = 32
# After a kill, how long to wait for the pipes to reach EOF. A descendant that
# somehow survived the tree kill and still holds the pipe must not turn a
# reported timeout into a hang.
_POST_KILL_DRAIN_SECONDS = 10.0
# A step that has already lost its budget still gets one second, so a timeout
# is reported as such rather than as a launch that never happened.
_MIN_TIMEOUT_SECONDS = 1.0

_BOOTSTRAP_DEADLINE: ContextVar[float | None] = ContextVar(
    "python_runtime_bootstrap_deadline", default=None
)


@contextmanager
def bootstrap_deadline(deadline_monotonic: float | None) -> Iterator[None]:
    """Cap every ``run`` inside the block at the time left before the deadline.

    Phase constants (120s for pip, 180s for import validation) stay as the
    ceiling; the deadline only ever lowers them. Without this, a deadline
    checked between phases could still be overrun by a whole phase.
    """
    token = _BOOTSTRAP_DEADLINE.set(deadline_monotonic)
    try:
        yield
    finally:
        _BOOTSTRAP_DEADLINE.reset(token)


def effective_timeout(timeout: float) -> float:
    """The step timeout, lowered to the remaining bootstrap deadline if any."""
    deadline = _BOOTSTRAP_DEADLINE.get()
    if deadline is None:
        return float(timeout)
    return max(_MIN_TIMEOUT_SECONDS, min(float(timeout), deadline - time.monotonic()))


def _spawn(argv: Sequence[str], **kwargs: Any) -> subprocess.Popen[str]:
    """Seam for tests: the one place a real process is created."""
    return subprocess.Popen(list(argv), **kwargs)


def _kill_tree(proc: subprocess.Popen[str], job: JobObject) -> None:
    """Kill the child and everything it started.

    Windows: closing the job with KILL_ON_JOB_CLOSE terminates every process
    it holds; the direct kill afterwards covers a child that was never
    assigned (assignment itself failed). POSIX: the child is a session leader,
    so its PGID equals its PID and one ``killpg`` reaches the grandchildren;
    fall back to a direct kill when there is no such group.
    """
    if IS_WINDOWS:
        job.close()
        with suppress(OSError):
            proc.kill()
        return
    # Looked up rather than referenced: neither name exists on Windows, and
    # this module is type-checked there too.
    killpg = getattr(os, "killpg", None)
    sigkill = getattr(signal, "SIGKILL", None)
    try:
        if killpg is None or sigkill is None:
            raise OSError("process groups are unavailable on this platform")
        killpg(proc.pid, sigkill)
    except OSError:
        with suppress(OSError):
            proc.kill()


def _drain_after_kill(proc: subprocess.Popen[str]) -> tuple[str, str]:
    try:
        stdout, stderr = proc.communicate(timeout=_POST_KILL_DRAIN_SECONDS)
    except subprocess.TimeoutExpired:
        for pipe in (proc.stdout, proc.stderr):
            if pipe is not None:
                with suppress(OSError):
                    pipe.close()
        return "", ""
    return stdout or "", stderr or ""


def run(  # noqa: PLR0913 - mirrors the subprocess.run keywords the bootstrap uses
    argv: Sequence[str],
    *,
    timeout: float,
    check: bool = False,
    cwd: str | os.PathLike[str] | None = None,
    env: dict[str, str] | None = None,
    encoding: str = "utf-8",
    errors: str = "replace",
) -> subprocess.CompletedProcess[str]:
    """Run ``argv`` to completion inside a process tree we can always kill.

    Mirrors ``subprocess.run(argv, capture_output=True, text=True, timeout=...,
    check=...)``: returns a ``CompletedProcess`` with decoded ``stdout`` /
    ``stderr``, raises ``CalledProcessError`` when ``check`` is set and the
    exit code is non-zero, and raises ``TimeoutExpired`` (carrying whatever
    output was captured) after the tree has been killed.
    """
    timeout = effective_timeout(timeout)
    popen_kwargs: dict[str, Any] = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": encoding,
        "errors": errors,
        "cwd": cwd,
        "env": env,
    }
    if IS_WINDOWS:
        popen_kwargs["creationflags"] = int(getattr(subprocess, "CREATE_SUSPENDED", 0x00000004))
    else:
        popen_kwargs["start_new_session"] = True

    with JobObject(
        memory_limit_mb=BOOTSTRAP_JOB_MEMORY_LIMIT_MB,
        max_processes=BOOTSTRAP_JOB_MAX_PROCESSES,
    ) as job:
        proc = _spawn(argv, **popen_kwargs)
        try:
            job.assign(proc)
            job.resume(proc)
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc, job)
            stdout, stderr = _drain_after_kill(proc)
            raise subprocess.TimeoutExpired(
                list(argv), timeout, output=stdout, stderr=stderr
            ) from None
        except BaseException:
            _kill_tree(proc, job)
            _drain_after_kill(proc)
            raise
    completed: subprocess.CompletedProcess[str] = subprocess.CompletedProcess(
        list(argv), int(proc.returncode), stdout or "", stderr or ""
    )
    if check:
        completed.check_returncode()
    return completed
