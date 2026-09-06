"""Parent-process death watchdog for the sidecar.

The sidecar's only real-time tie to Electron's lifetime is stdin EOF, which the
main loop notices while reading framed messages. When the sidecar is blocked
inside a child subprocess (codex-cli, an MCP tool) it is not reading stdin and
will not see the parent die -- leaving an orphaned Python process. This is worst
on Windows, where Electron can be SIGKILLed with no graceful stdin close and the
OS neither reparents nor signals the child.

This module runs an independent daemon thread that polls whether the parent is
still alive and force-exits the sidecar when it disappears, bounding orphan
lifetime to one poll interval regardless of what the main thread is doing. On
POSIX it also (best-effort) places the sidecar in its own process group so the
teardown can sweep any inherited children.

Residual gap (documented, accepted): this is a *bounded-time* guard, not the
kernel-instant teardown a Windows Job Object with KILL_ON_JOB_CLOSE assigned to
the sidecar would give. Node's ``child_process`` cannot assign the spawned
sidecar to a Job Object without a native addon, so that heavier dependency is
deliberately not taken here. The bounded window is one poll interval.
"""

from __future__ import annotations

import ctypes
import logging
import os
import signal
import threading
from typing import Any, Callable

from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

PARENT_PID_ENV = "JENNY_PARENT_PID"
DEFAULT_POLL_INTERVAL_SECONDS = 2.0
# Budget for draining every registered manager on parent loss. Deliberately
# short: the parent is already gone, nothing is waiting on a graceful answer,
# and the containment handles are the backstop for anything that overruns.
PARENT_LOSS_DRAIN_SECONDS = 3.0

_WINDOWS_SYNCHRONIZE = 0x00100000
_WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_WINDOWS_WAIT_OBJECT_0 = 0x0


def _windows_process_is_alive(pid: int) -> bool:
    # A local WinDLL instance so setting prototypes never mutates the shared
    # ctypes.windll.kernel32 used elsewhere (e.g. subprocess_manager). Uses the
    # cross-platform ctypes.c_* types rather than ctypes.wintypes, which cannot
    # be imported off Windows.
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.WaitForSingleObject.restype = ctypes.c_uint32
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

    handle = kernel32.OpenProcess(
        _WINDOWS_SYNCHRONIZE | _WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION,
        0,
        pid,
    )
    if not handle:
        # The pid no longer resolves to a process object => gone.
        return False
    try:
        # WAIT_OBJECT_0 means the process object is signaled, i.e. it has
        # exited. A still-running process returns WAIT_TIMEOUT. This detects a
        # terminated-but-handle-still-open process, which a bare OpenProcess
        # existence check would miss.
        return kernel32.WaitForSingleObject(handle, 0) != _WINDOWS_WAIT_OBJECT_0
    finally:
        kernel32.CloseHandle(handle)


def process_is_alive(pid: int) -> bool:
    """Liveness check that treats a *terminated* process as dead.

    Unlike a bare existence probe, this reports False once the process has
    exited even if a handle to it still lingers (Windows) or before it is reaped
    by an unrelated parent. The watchdog must self-exit on actual parent death,
    not merely when the pid stops resolving.
    """
    safe_pid = int(pid)
    if safe_pid <= 0:
        return False
    if os.name == "nt":
        return _windows_process_is_alive(safe_pid)
    try:
        os.kill(safe_pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists but owned by another user — still alive.
        return True
    except OSError:
        return False
    return True


def resolve_parent_pid(environ: dict[str, str] | None = None) -> int:
    """Resolve the Electron parent pid, preferring the explicit env override.

    ``JENNY_PARENT_PID`` (set by the SidecarManager at spawn) is authoritative;
    a blank/invalid value falls back to ``os.getppid()``. Returns ``0`` when no
    usable pid is available, which disables the watchdog.
    """
    source = environ if environ is not None else os.environ
    raw = str(source.get(PARENT_PID_ENV, "")).strip()
    if raw:
        try:
            pid = int(raw)
        except ValueError:
            pid = 0
        if pid > 0:
            return pid
    try:
        return int(os.getppid())
    except OSError:
        return 0


class ParentDeathWatchdog:
    """Daemon thread that fires ``on_parent_lost`` once the parent pid is gone."""

    def __init__(
        self,
        *,
        parent_pid: int,
        on_parent_lost: Callable[[], None],
        poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
        liveness_check: Callable[[int], bool] = process_is_alive,
    ) -> None:
        self._parent_pid = int(parent_pid or 0)
        self._on_parent_lost = on_parent_lost
        self._poll_interval_seconds = max(float(poll_interval_seconds), 0.05)
        self._liveness_check = liveness_check
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._fired = False

    def start(self) -> "ParentDeathWatchdog":
        if self._parent_pid <= 0:
            log_event(
                logger,
                logging.WARNING,
                component="runtime.lifecycle",
                event="sidecar.parent_watchdog.disabled",
                message="Parent-death watchdog disabled: no valid parent pid",
                status="degraded",
                data={"parent_pid": self._parent_pid},
            )
            return self
        if self._thread is not None:
            return self
        thread = threading.Thread(
            target=self._run,
            name="parent-death-watchdog",
            daemon=True,
        )
        self._thread = thread
        thread.start()
        return self

    def stop(self, *, timeout: float = 2.0) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=max(float(timeout), 0.0))

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                alive = bool(self._liveness_check(self._parent_pid))
            except Exception:  # noqa: BLE001
                # Fail open: a probe error must never tear the sidecar down.
                logger.debug("parent liveness probe failed", exc_info=True)
                alive = True
            if not alive:
                self._fire()
                return
            self._stop_event.wait(self._poll_interval_seconds)

    def _fire(self) -> None:
        if self._fired:
            return
        self._fired = True
        try:
            self._on_parent_lost()
        except Exception:  # noqa: BLE001
            logger.exception("parent-death watchdog teardown failed")


def _establish_process_group() -> None:
    """Best-effort: make the sidecar lead its own POSIX process group."""
    if os.name == "nt":
        return
    set_pgrp = getattr(os, "setpgrp", None)
    if set_pgrp is None:
        return
    try:
        set_pgrp()
    except OSError:
        logger.debug("failed to establish sidecar process group", exc_info=True)


def _terminate_own_process_group() -> None:
    """Best-effort POSIX sweep of the sidecar's own process group on teardown."""
    if os.name == "nt":
        return
    getpgrp = getattr(os, "getpgrp", None)
    killpg = getattr(os, "killpg", None)
    if getpgrp is None or killpg is None:
        return
    try:
        pgid = getpgrp()
        # Only sweep when *we* lead the group (set via _establish_process_group),
        # so we never signal Electron's original group or unrelated processes.
        if pgid == os.getpid():
            killpg(pgid, signal.SIGTERM)
    except OSError:
        logger.debug("failed to terminate sidecar process group", exc_info=True)


def start_parent_death_watchdog(
    *,
    subprocess_manager: Any = None,
    parent_pid: int | None = None,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    establish_process_group: bool = True,
    liveness_check: Callable[[int], bool] = process_is_alive,
) -> ParentDeathWatchdog:
    """Start the watchdog with the production self-termination teardown.

    On parent loss it closes the injected subprocess manager (the sidecar
    constructs exactly one), sweeps its own POSIX process group, then
    ``os._exit(0)`` -- the only reliable exit when the main thread may be
    blocked inside a child subprocess. ``os._exit`` does not run ``atexit``
    handlers, so the manager must be closed before exit.
    """
    resolved_pid = int(parent_pid) if parent_pid is not None else resolve_parent_pid()
    if establish_process_group:
        _establish_process_group()

    def _on_parent_lost() -> None:
        log_event(
            logger,
            logging.WARNING,
            component="runtime.lifecycle",
            event="sidecar.parent_lost",
            message="Electron parent process is gone; sidecar self-terminating",
            status="degraded",
            data={"parent_pid": resolved_pid},
        )
        try:
            if subprocess_manager is not None:
                subprocess_manager.close(timeout_seconds=PARENT_LOSS_DRAIN_SECONDS)
        except Exception:  # noqa: BLE001
            logger.debug("failed to close the subprocess manager on parent loss", exc_info=True)
        _terminate_own_process_group()
        os._exit(0)

    watchdog = ParentDeathWatchdog(
        parent_pid=resolved_pid,
        on_parent_lost=_on_parent_lost,
        poll_interval_seconds=poll_interval_seconds,
        liveness_check=liveness_check,
    )
    return watchdog.start()
