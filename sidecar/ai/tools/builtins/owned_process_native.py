"""Resolve the native owned-process launcher, with a cached health probe.

On Windows every command, git call and test-runner helper starts through a small
trusted child (the owned-process bootstrap). `jenny-launch.exe` is a native build
of that child: it takes the same framed request and behaves like the Python
child, without paying an interpreter or one-file unpack on every launch. This
module only decides whether it can be used; the Python child stays the fallback.

SECURITY: the launcher is trusted code that starts every command, so it is
resolved only from two fixed places -- beside the packaged `sidecar.exe`, or
`build/sidecar/` in a source checkout. Never from PATH, the workspace, the
current directory or an environment variable.

`native_launcher_command()` never raises and returns None on any doubt. It is
imported lazily by `owned_process_windows.windows_bootstrap_command` so the
sidecar's start-up import graph does not grow.
"""

from __future__ import annotations

import logging
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

from sidecar._owned_process_bootstrap import BOOTSTRAP_FLAG
from sidecar.ai.config import read_environment_value
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

NATIVE_LAUNCHER_FLAG = "JENNY_ENABLE_NATIVE_LAUNCHER"
NATIVE_LAUNCHER_FILE_NAME = "jenny-launch.exe"
NATIVE_LAUNCHER_VERSION_LINE = "jenny-launch protocol 1"

_PROBE_TIMEOUT_SECONDS = 5
# A first run can time out while a virus scanner reads the new file, so one
# failure is retried later; a second failure stands until the file changes.
_MAX_PROBE_FAILURES = 2
_FAILED_PROBE_RETRY_SECONDS = 30.0
# One entry per launcher file version seen by this process; a rebuild adds one.
_MAX_PROBE_RESULTS = 8
_READY_EVENT = "ai.tools.owned_process.native_launcher_ready"
_UNAVAILABLE_EVENT = "ai.tools.owned_process.native_launcher_unavailable"

_lock = threading.Lock()
# File version -> (healthy, consecutive failures, time of the last probe).
_probe_results: dict[tuple[str, int, int], tuple[bool, int, float]] = {}
_logged: set[str] = set()


def native_launcher_path() -> Path:
    """Return the one fixed location the launcher is allowed to live at."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / NATIVE_LAUNCHER_FILE_NAME
    repository_root = Path(__file__).resolve().parents[4]
    return repository_root / "build" / "sidecar" / NATIVE_LAUNCHER_FILE_NAME


def reset_native_launcher_state() -> None:
    """Forget cached probes and logged diagnostics (tests only)."""
    with _lock:
        _probe_results.clear()
        _logged.clear()


def native_launcher_command() -> list[str] | None:
    """Return the launcher's bootstrap command when it is present and healthy, else None."""
    try:
        return _resolve()
    except Exception:  # noqa: BLE001 - resolution must never fail a command launch
        return None


def _resolve() -> list[str] | None:
    if sys.platform != "win32":
        return None
    if read_environment_value(NATIVE_LAUNCHER_FLAG, "1") == "0":
        _log_once("disabled")
        return None
    path = native_launcher_path()
    try:
        # lstat, not stat: a link at the launcher's path is refused, not followed.
        status = path.lstat()
    except OSError:
        _log_once("missing")
        return None
    if not stat.S_ISREG(status.st_mode):
        _log_once("missing")
        return None
    if not _is_healthy(path, (str(path), status.st_size, status.st_mtime_ns)):
        _log_once("probe_failed")
        return None
    _log_once("ready")
    return [str(path), BOOTSTRAP_FLAG]


def _is_healthy(path: Path, key: tuple[str, int, int]) -> bool:
    """Probe once per file version; a failed probe gets one later retry, then sticks."""
    # The lock is held across the probe so concurrent first callers share one answer.
    with _lock:
        healthy, failures, failed_at = _probe_results.get(key, (False, 0, 0.0))
        retry_due = failures == 0 or (
            failures < _MAX_PROBE_FAILURES
            and time.monotonic() - failed_at >= _FAILED_PROBE_RETRY_SECONDS
        )
        if healthy or not retry_due:
            return healthy
        healthy = _probe(path)
        if key not in _probe_results and len(_probe_results) >= _MAX_PROBE_RESULTS:
            _probe_results.clear()
        _probe_results[key] = (healthy, 0 if healthy else failures + 1, time.monotonic())
        return healthy


def _probe(path: Path) -> bool:
    try:
        completed = subprocess.run(
            [str(path), "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=_PROBE_TIMEOUT_SECONDS,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0 and completed.stdout.strip() == NATIVE_LAUNCHER_VERSION_LINE


def _log_once(reason: str) -> None:
    """Emit one diagnostic per reason per process, never one per command."""
    with _lock:
        if reason in _logged:
            return
        _logged.add(reason)
    ready = reason == "ready"
    log_event(
        logger,
        logging.INFO,
        component="ai.tools.owned_process",
        event=_READY_EVENT if ready else _UNAVAILABLE_EVENT,
        message=(
            "Native owned-process launcher accepted"
            if ready
            else f"Native owned-process launcher unavailable ({reason}); using the Python bootstrap"
        ),
        status="ready" if ready else "fallback",
        data={"reason": reason, "file": NATIVE_LAUNCHER_FILE_NAME},
    )
