"""Platform liveness + per-child containment for sidecar-owned subprocesses.

Split out of ``subprocess_manager.py``, which had grown two unrelated jobs in one
file. The manager proper is pure Python bookkeeping - reservations, a task-keyed
registry, waiter threads, terminate -> kill escalation - all of it under one lock
and testable on any machine. Everything here is the opposite: OS-conditional
kernel calls (``os.killpg`` on POSIX, ``OpenProcess``/Job Objects on Windows)
where only one branch is ever live on a given box, and where the failure modes
are handle lifetimes and permission errors rather than lock ordering. Keeping
them apart means a change to one cannot quietly perturb the other.

Two questions live here, and they are not the same question. ``process_exists``
and :func:`posix_process_group_exists` answer "is this thing still alive?" -
best-effort, advisory, and used to decide whether a child has actually been
reaped. :class:`ChildContainment` answers "who owns this tree, and can I prove
it is gone?" - a kernel-level guarantee plus the interrogation that turns a
termination attempt into a receipt.

Containment is **per child**, not per manager. A manager-wide Job Object cannot
be closed to reap one task without killing every other task the sidecar owns, so
it can never underwrite a single task's termination; and on Windows
``Popen.kill`` only touches the root pid, leaving every descendant (torch and
inductor compile workers, CUDA helpers) orphaned. One job per spawn is what
makes "this task's tree is gone" both enforceable and checkable.

The Job Object itself is deliberately NOT reimplemented here.
:mod:`sidecar.runtime.process_job` already owns it with its Win32 ABI pinned,
which matters more than it looks: an unpinned ``restype`` defaults to C ``int``
and truncates a 64-bit ``HANDLE``, producing a job that reports success and
contains nothing. This module wraps that one implementation so the sidecar has a
single Job Object rather than a manager-private copy free to drift from it.
"""

from __future__ import annotations

import ctypes
import logging
import os
import signal
import subprocess
from ctypes import wintypes
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Protocol

from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.process_job import WindowsJobObject, windows_process_is_alive

logger = logging.getLogger(__name__)

__all__ = [
    "ChildContainment",
    "ContainedChild",
    "ContainmentPolicy",
    "ContainmentUnavailableError",
    "TerminationReceipt",
    "WindowsJobObject",
    "build_receipt",
    "confirm_child_containment",
    "create_child_containment",
    "log_containment_degraded",
    "open_child_containment",
    "posix_process_group_exists",
    "process_exists",
    "root_reaped",
    "surviving_pids",
    "tree_is_empty",
    "uses_posix_process_groups",
]

_WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_POSIX_SIGKILL = getattr(signal, "SIGKILL", 9)


class ContainmentPolicy(Enum):
    """Containment policy for sidecar-owned subprocesses."""

    BEST_EFFORT = "best_effort"


class ContainmentUnavailableError(RuntimeError):
    """A child could not be placed under kernel containment.

    ``stage`` distinguishes the three failure points, because they are not the
    same incident and callers unwind differently: ``"create"`` happens before
    any process exists, while ``"assign"`` and ``"verify"`` happen with a live
    child that must be killed before the task key is released.
    """

    def __init__(self, message: str, *, stage: str) -> None:
        super().__init__(message)
        self.stage = str(stage)


class ChildContainment(Protocol):
    """One spawn's containment: launch flags, membership proof, and a kill."""

    kind: str

    def popen_kwargs(self) -> dict[str, Any]: ...

    def assign(self, pid: int) -> None: ...

    def verify(self) -> bool: ...

    def surviving_pids(self) -> tuple[int, ...]: ...

    def is_empty(self) -> bool: ...

    def kill_tree(self) -> None: ...

    def close(self) -> None: ...


@dataclass(frozen=True)
class TerminationReceipt:
    """What is actually known about a termination attempt.

    Lives beside :class:`ChildContainment` because every field except the key is
    an observation made *through* one. ``terminate_task`` used to return a bare
    ``bool`` that meant both "the tree is provably gone" and "this manager has
    never heard of that key" - two answers a caller must not conflate, and on
    Windows the first was a lie by omission, since reaping the root says nothing
    about its descendants.

    ``known``       this manager tracked the key at all
    ``reaped``      the root process exited and was waited on
    ``contained``   the child had kernel containment to interrogate
    ``tree_empty``  VERIFIED empty - no assigned pids / no surviving group
    ``escalated``   the last rung of the ladder that was used
    """

    task_key: str
    known: bool
    reaped: bool
    contained: bool
    tree_empty: bool
    escalated: str
    surviving_pids: tuple[int, ...] = ()

    @property
    def terminated(self) -> bool:
        return self.reaped and self.tree_empty

    def __bool__(self) -> bool:
        # Source compatibility: existing call sites treat the return value as a
        # truthy "did it die", and they keep working unchanged.
        return self.terminated


class ContainedChild(Protocol):
    """The three fields a receipt is observed through.

    Structural rather than an import of ``ManagedSubprocess``: the receipt and
    the containment it interrogates live here, the child registry lives in
    ``subprocess_manager``, and neither should have to import the other.
    """

    task_key: str
    process: Any
    containment: "ChildContainment | None"


def root_reaped(child: ContainedChild) -> bool:
    try:
        return child.process.poll() is not None
    except Exception:  # noqa: BLE001
        logger.warning(
            "failed to inspect background subprocess state task_key=%s pid=%s",
            child.task_key,
            getattr(child.process, "pid", 0),
            exc_info=True,
        )
        return False


def tree_is_empty(child: ContainedChild) -> bool:
    containment = child.containment
    if containment is None:
        # Uncontained. The POSIX group probe is the only descendant evidence
        # available, and on Windows there is none at all - which is exactly
        # why the GPU worker's policy refuses to run in this state.
        return not posix_process_group_exists(int(getattr(child.process, "pid", 0) or 0))
    try:
        return bool(containment.is_empty())
    except Exception:  # noqa: BLE001
        logger.warning(
            "failed to interrogate child containment task_key=%s",
            child.task_key,
            exc_info=True,
        )
        return False


def surviving_pids(child: ContainedChild) -> tuple[int, ...]:
    containment = child.containment
    pid = int(getattr(child.process, "pid", 0) or 0)
    if containment is None:
        return (pid,) if pid > 0 and not root_reaped(child) else ()
    try:
        return tuple(int(entry) for entry in containment.surviving_pids())
    except Exception:  # noqa: BLE001
        logger.debug("failed to list surviving contained pids", exc_info=True)
        return (pid,) if pid > 0 else ()


def build_receipt(child: ContainedChild, *, escalated: str) -> TerminationReceipt:
    """Observe the child right now and state only what was actually checked."""
    empty = tree_is_empty(child)
    return TerminationReceipt(
        task_key=child.task_key,
        known=True,
        reaped=root_reaped(child),
        contained=child.containment is not None,
        tree_empty=empty,
        escalated=escalated,
        surviving_pids=() if empty else surviving_pids(child),
    )


def uses_posix_process_groups() -> bool:
    return os.name != "nt"


def posix_process_group_exists(group_id: int) -> bool:
    if not uses_posix_process_groups():
        return False
    kill_process_group = getattr(os, "killpg", None)
    if not callable(kill_process_group):
        return False
    try:
        kill_process_group(int(group_id), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        logger.warning(
            "failed to confirm background subprocess group exit group_id=%s",
            group_id,
            exc_info=True,
        )
        return True
    return True


def process_exists(pid: int) -> bool:
    """Best-effort cross-platform process existence check."""
    safe_pid = int(pid)
    if safe_pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(safe_pid, 0)
        except OSError:
            return False
        return True

    kernel32 = getattr(ctypes, "windll", None)
    if kernel32 is None:
        return False
    win_api = kernel32.kernel32
    open_process = win_api.OpenProcess
    open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    open_process.restype = wintypes.HANDLE
    close_handle = win_api.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL
    access = _WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION
    handle = open_process(access, False, safe_pid)
    if not handle:
        return False
    close_handle(handle)
    return True


class WindowsJobContainment:
    """Per-child Windows Job Object with kill-on-close tree ownership."""

    kind = "windows_job_object"

    def __init__(self, job: WindowsJobObject) -> None:
        self._job = job
        self._pid = 0
        self._closed = False

    def popen_kwargs(self) -> dict[str, Any]:
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}

    def assign(self, pid: int) -> None:
        self._pid = int(pid)
        try:
            self._job.assign_pid(self._pid)
        except Exception as error:  # noqa: BLE001 - normalized for the caller
            raise ContainmentUnavailableError(
                f"AssignProcessToJobObject failed for pid {self._pid}: {error}",
                stage="assign",
            ) from error

    def verify(self) -> bool:
        if self._pid <= 0 or self._closed:
            return False
        try:
            return bool(self._job.contains_pid(self._pid))
        except Exception:  # noqa: BLE001
            logger.debug("job membership probe failed", exc_info=True)
            return False

    def surviving_pids(self) -> tuple[int, ...]:
        if self._closed:
            # The handle is gone (kill_tree fell back to KILL_ON_JOB_CLOSE), so
            # the job can no longer be interrogated. The root pid is the only
            # thing still addressable; report it while it is alive rather than
            # claiming an empty tree we can no longer see.
            if self._pid > 0 and windows_process_is_alive(self._pid):
                return (self._pid,)
            return ()
        try:
            assigned = self._job.assigned_process_ids()
        except Exception:  # noqa: BLE001
            logger.debug("job process-id query failed", exc_info=True)
            return (self._pid,) if self._pid > 0 else ()
        # A pid can linger in the list while its process object is held open by
        # a handle we own, so membership alone would over-report survivors.
        return tuple(pid for pid in assigned if windows_process_is_alive(pid))

    def is_empty(self) -> bool:
        return not self.surviving_pids()

    def kill_tree(self) -> None:
        if self._closed:
            return
        try:
            if self._job.terminate_tree():
                return
        except Exception:  # noqa: BLE001
            logger.debug("TerminateJobObject failed", exc_info=True)
        # Last resort: dropping the handle triggers KILL_ON_JOB_CLOSE, which
        # still reaps the tree but costs the ability to prove it.
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._job.close()
        except Exception:  # noqa: BLE001
            logger.debug("failed to close child Job Object", exc_info=True)


class PosixProcessGroupContainment:
    """Per-child POSIX session/process group, killable as one unit."""

    kind = "posix_process_group"

    def __init__(self) -> None:
        self._pid = 0

    def popen_kwargs(self) -> dict[str, Any]:
        # ``start_new_session=True`` rather than ``preexec_fn=os.setpgrp``:
        # preexec_fn runs arbitrary Python between fork and exec in a process
        # that has threads (waiters, pumps, the diagnostics queue), where only
        # async-signal-safe work is legal and a lock held by another thread at
        # fork time deadlocks the child. CPython implements start_new_session
        # with a setsid() in the same C-level pre-exec path, which is the safe
        # equivalent already used by owned_process and provisioning_process.
        return {"start_new_session": True}

    def assign(self, pid: int) -> None:
        # Nothing to do: setsid() ran inside the child before exec, so the
        # grouping already exists by the time Popen returns. verify() is what
        # confirms it rather than assuming it.
        self._pid = int(pid)

    def verify(self) -> bool:
        if self._pid <= 0:
            return False
        get_process_group = getattr(os, "getpgid", None)
        if not callable(get_process_group):
            return False
        try:
            return int(get_process_group(self._pid)) == self._pid
        except OSError:
            # Includes the child having already exited: there is then no group
            # we can claim to own, so this is unverified, not verified-empty.
            return False

    def surviving_pids(self) -> tuple[int, ...]:
        if self._pid <= 0:
            return ()
        return (self._pid,) if posix_process_group_exists(self._pid) else ()

    def is_empty(self) -> bool:
        return not self.surviving_pids()

    def kill_tree(self) -> None:
        kill_process_group = getattr(os, "killpg", None)
        if self._pid <= 0 or not callable(kill_process_group):
            return
        try:
            kill_process_group(self._pid, _POSIX_SIGKILL)
        except ProcessLookupError:
            return
        except OSError:
            logger.debug("killpg(SIGKILL) failed", exc_info=True)

    def close(self) -> None:
        return None


def create_child_containment(
    *,
    policy: ContainmentPolicy = ContainmentPolicy.BEST_EFFORT,
) -> ChildContainment | None:
    """Build best-effort containment for one child."""
    if os.name == "nt":
        try:
            return WindowsJobContainment(WindowsJobObject())
        except Exception:  # noqa: BLE001
            logger.debug("child Job Object unavailable", exc_info=True)
            return None
    if callable(getattr(os, "killpg", None)) and callable(getattr(os, "getpgid", None)):
        return PosixProcessGroupContainment()
    return None


def open_child_containment(
    *,
    task_key: str,
    policy: ContainmentPolicy,
    factory: Callable[..., ChildContainment | None] = create_child_containment,
) -> ChildContainment | None:
    """Resolve one child's containment before its process exists."""
    try:
        containment = factory(policy=policy)
    except Exception as error:  # noqa: BLE001
        log_containment_degraded(
            task_key=task_key,
            stage=str(getattr(error, "stage", "") or "create"),
            reason=str(error),
        )
        return None
    if containment is None:
        log_containment_degraded(
            task_key=task_key,
            stage="create",
            reason="child containment is unavailable on this platform",
        )
    return containment


def confirm_child_containment(
    containment: ChildContainment | None,
    *,
    pid: int,
    task_key: str,
    policy: ContainmentPolicy,
) -> ChildContainment | None:
    """Assign a live child and prove the assignment took.

    ``verify()`` is not redundant with a successful ``assign()``: on Windows the
    assign can report success for a process that is already exiting, and the
    only statement the kernel makes about membership itself is
    ``IsProcessInJob``. Trusting the return code is precisely the check that
    misses a job which looks created and contains nothing.

    Returns the containment to keep, or ``None`` when the child proceeds
    uncontained.
    """
    if containment is None:
        return None
    safe_pid = int(pid)
    stage = "assign"
    try:
        containment.assign(safe_pid)
        stage = "verify"
        if not containment.verify():
            raise ContainmentUnavailableError(
                f"containment could not be confirmed for pid {safe_pid}",
                stage="verify",
            )
    except ContainmentUnavailableError as error:
        containment.close()
        log_containment_degraded(
            task_key=task_key, stage=error.stage, reason=str(error)
        )
        return None
    except Exception as error:  # noqa: BLE001
        containment.close()
        log_containment_degraded(task_key=task_key, stage=stage, reason=str(error))
        return None
    return containment


def log_containment_degraded(*, task_key: str, stage: str, reason: str) -> None:
    """Warn actionably when fail-open BEST_EFFORT containment degrades."""
    log_event(
        logger,
        logging.WARNING,
        component="runtime.lifecycle",
        event="sidecar.runtime.containment_degraded",
        message="background subprocess is running without kernel containment",
        status="degraded",
        data={
            "task_key": str(task_key)[:200],
            "stage": str(stage),
            "reason": str(reason)[:200],
            "policy": ContainmentPolicy.BEST_EFFORT.value,
        },
    )
