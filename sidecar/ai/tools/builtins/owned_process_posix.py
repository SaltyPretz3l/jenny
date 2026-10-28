"""POSIX launch preflight and supervisor-report reading for owned processes.

On POSIX every owned target runs under a trusted supervisor that reports over
a pipe: first that its termination handlers are installed, and after the tree
is gone a proof byte naming the cleanup mechanism it used. These helpers read
that report; the process-group signalling stays with the owner service.
"""

from __future__ import annotations

import errno
import os
import select
import shutil
import sys
import threading
from pathlib import Path
from typing import Mapping, Protocol, Sequence

from sidecar._owned_process_supervisor import (
    LINEAGE_CONTAINMENT,
    PROOF_BYTE,
    SAMPLED_PROOF_BYTE,
    SUBREAPER_CONTAINMENT,
)
from sidecar.runtime.external_child_env import external_child_environment

_MAX_SUPERVISOR_REPORT_BYTES = 64


class SupervisedProcess(Protocol):
    """The owned-process fields the supervisor report reads and updates."""

    containment: str
    _supervisor_ready_fd: int | None
    _supervisor_report: bytes
    _supervisor_ready_lock: threading.Lock


def preflight_posix_target(
    argv: Sequence[str], cwd: Path, env: Mapping[str, str] | None,
) -> None:
    """Raise the launch errors Popen raised before the supervisor existed.

    The supervisor reports a failed launch only as an exit status, and
    callers turn a missing program or directory into their own message.
    """
    if not Path(cwd).is_dir():
        raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), str(cwd))
    program = argv[0]
    if os.sep in program and not os.path.isabs(program):
        program = str(Path(cwd) / program)
    search_path = external_child_environment(env).get("PATH", os.defpath)
    if shutil.which(program, path=search_path) is None:
        raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), argv[0])


def read_supervisor_report(owned: SupervisedProcess, timeout_seconds: float) -> None:
    """Collect what the supervisor has written; caller holds the lock."""
    ready_fd = owned._supervisor_ready_fd
    if ready_fd is None or sys.platform == "win32":
        return
    try:
        if timeout_seconds > 0:
            # poll, not select: a descriptor above 1023 breaks select.
            poller = select.poll()
            poller.register(ready_fd, select.POLLIN)
            poller.poll(timeout_seconds * 1000)
        os.set_blocking(ready_fd, False)
        while len(owned._supervisor_report) < _MAX_SUPERVISOR_REPORT_BYTES:
            chunk = os.read(ready_fd, 16)
            if not chunk:
                os.close(ready_fd)
                owned._supervisor_ready_fd = None
                return
            owned._supervisor_report += chunk
    except BlockingIOError:
        return
    except (OSError, ValueError):
        try:
            os.close(ready_fd)
        except OSError:
            pass
        owned._supervisor_ready_fd = None


def await_supervisor_ready(owned: SupervisedProcess, timeout_seconds: float) -> None:
    """Hold the first signal until the supervisor can turn it into a sweep."""
    with owned._supervisor_ready_lock:
        if not owned._supervisor_report:
            read_supervisor_report(owned, timeout_seconds)


def supervisor_proved_cleanup(owned: SupervisedProcess) -> bool:
    """True once the exited supervisor's report carries its proof byte."""
    with owned._supervisor_ready_lock:
        read_supervisor_report(owned, 0.0)
        report = owned._supervisor_report
    # Name the mechanism the supervisor actually used: a sampled sweep
    # releases the slot but is never presented as the kernel-backed proof.
    if PROOF_BYTE in report:
        owned.containment = SUBREAPER_CONTAINMENT
        return True
    if SAMPLED_PROOF_BYTE in report:
        owned.containment = LINEAGE_CONTAINMENT
        return True
    return False


__all__ = [
    "SupervisedProcess",
    "await_supervisor_ready",
    "preflight_posix_target",
    "read_supervisor_report",
    "supervisor_proved_cleanup",
]
