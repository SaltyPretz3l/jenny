"""Cross-process bootstrap locking for the managed Python runtime."""

from __future__ import annotations

import ctypes
import json
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

BOOTSTRAP_LOCK_TIMEOUT_SECONDS = 300
BOOTSTRAP_LOCK_POLL_SECONDS = 0.2
# A lock (or a retained staging tree) older than this is reclaimed even when
# its owner pid is alive, because a pid can be reused. It must therefore
# exceed the longest bootstrap a live owner may legitimately run --
# interpreter.MAX_BOOTSTRAP_BUDGET_SECONDS (1800) -- or a slow first install
# has its staging tree deleted from under it by the next caller.
BOOTSTRAP_LOCK_STALE_SECONDS = 1860
# Bounded retry budget for releasing our own just-finished lock file when a
# concurrent reader transiently holds it open (Windows-only failure mode;
# see _unlink_lock_best_effort). ~50ms total — far more than a single
# `read_text()` call needs to release its handle.
_LOCK_UNLINK_RETRY_ATTEMPTS = 25
_LOCK_UNLINK_RETRY_SLEEP_SECONDS = 0.002

_BOOTSTRAP_THREAD_LOCKS_GUARD = threading.Lock()
_BOOTSTRAP_THREAD_LOCKS: dict[str, tuple[Any, int]] = {}


def _bootstrap_lock_payload() -> dict[str, float | int]:
    return {
        "pid": os.getpid(),
        "created_at": time.time(),
    }


def _write_bootstrap_lock(lock_fd: int) -> None:
    os.ftruncate(lock_fd, 0)
    os.write(lock_fd, json.dumps(_bootstrap_lock_payload()).encode("utf-8"))


def _read_bootstrap_lock(lock_path: Path) -> tuple[int | None, float | None] | None:
    try:
        raw = lock_path.read_text(encoding="utf-8").strip()
    except PermissionError:
        # The lock file exists but another thread/process currently holds an
        # exclusive handle on it (observed as a transient Windows sharing
        # violation under real concurrent contention on the *same* lock).
        # That is proof the owner is alive right now — propagate rather than
        # let the generic OSError branch below collapse it into "unreadable"
        # (which `_should_recover_bootstrap_lock` would otherwise treat the
        # same as a corrupt/abandoned lock and try to steal).
        raise
    except OSError:
        return None
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        try:
            return int(raw.splitlines()[0].strip()), None
        except (IndexError, ValueError):
            return None
    if not isinstance(payload, dict):
        return None
    pid = payload.get("pid")
    created_at = payload.get("created_at")
    normalized_pid = int(pid) if isinstance(pid, (int, float)) else None
    normalized_created_at = float(created_at) if isinstance(created_at, (int, float)) else None
    return normalized_pid, normalized_created_at


def _process_exists(pid: int) -> bool:
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
    handle = kernel32.kernel32.OpenProcess(0x1000, False, safe_pid)
    if not handle:
        return False
    kernel32.kernel32.CloseHandle(handle)
    return True


def _should_recover_bootstrap_lock(
    lock_path: Path,
    *,
    same_process_lock_acquired: bool = False,
) -> bool:
    try:
        metadata = _read_bootstrap_lock(lock_path)
    except PermissionError:
        # Definitely alive (see _read_bootstrap_lock) — never reclaim.
        return False
    if metadata is None:
        return True
    pid, created_at = metadata
    if pid is not None:
        if same_process_lock_acquired and pid == os.getpid():
            return True
        if not _process_exists(pid):
            return True
    if created_at is None:
        return pid is None
    return (time.time() - created_at) >= BOOTSTRAP_LOCK_STALE_SECONDS


def _unlink_lock_best_effort(lock_path: Path) -> None:
    """Delete a lock file this call just finished owning.

    On Windows, deleting a file can transiently fail with PermissionError
    while a *different* thread/process holds even a short-lived read handle
    on it (e.g. another waiter's `_read_bootstrap_lock` mid-poll) — unlike
    POSIX, where unlink always succeeds regardless of open handles. That
    reader releases its handle in microseconds, so a short bounded retry
    resolves the overwhelmingly common case; if it never clears, leaving the
    file behind is still safe; the next `_bootstrap_lock` caller's own
    pid/age-based staleness check reclaims it deterministically.
    """
    for attempt in range(_LOCK_UNLINK_RETRY_ATTEMPTS):
        try:
            lock_path.unlink()
            return
        except FileNotFoundError:
            return
        except PermissionError:
            if attempt + 1 >= _LOCK_UNLINK_RETRY_ATTEMPTS:
                return
            time.sleep(_LOCK_UNLINK_RETRY_SLEEP_SECONDS)


@contextmanager
def _bootstrap_thread_lock(lock_path: Path) -> Iterator[None]:
    """Serialize same-process contenders before they inspect the file lock."""
    key = os.path.normcase(str(lock_path.resolve()))
    with _BOOTSTRAP_THREAD_LOCKS_GUARD:
        entry = _BOOTSTRAP_THREAD_LOCKS.get(key)
        lock, users = entry if entry is not None else (threading.Lock(), 0)
        _BOOTSTRAP_THREAD_LOCKS[key] = (lock, users + 1)
    lock.acquire()
    try:
        yield
    finally:
        lock.release()
        with _BOOTSTRAP_THREAD_LOCKS_GUARD:
            current = _BOOTSTRAP_THREAD_LOCKS.get(key)
            if current is not None and current[0] is lock:
                if current[1] <= 1:
                    _BOOTSTRAP_THREAD_LOCKS.pop(key, None)
                else:
                    _BOOTSTRAP_THREAD_LOCKS[key] = (lock, current[1] - 1)


@contextmanager
def _bootstrap_file_lock(
    lock_path: Path,
    *,
    same_process_lock_acquired: bool = False,
    deadline_monotonic: float | None = None,
) -> Iterator[None]:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + BOOTSTRAP_LOCK_TIMEOUT_SECONDS
    if deadline_monotonic is not None:
        # The caller's bootstrap deadline caps the wait: a lock held by a
        # slow sibling must not spend a budget the caller no longer has.
        deadline = min(deadline, deadline_monotonic)
    lock_fd: int | None = None
    while lock_fd is None:
        try:
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_RDWR)
        except FileExistsError:
            if _should_recover_bootstrap_lock(
                lock_path,
                same_process_lock_acquired=same_process_lock_acquired,
            ):
                try:
                    lock_path.unlink()
                    continue
                except FileNotFoundError:
                    continue
                except PermissionError:
                    # Owner started actively holding the file the instant
                    # after we decided it looked reclaimable (e.g. it is
                    # rewriting the lock payload right now) — fall through to
                    # the deadline/backoff below rather than treat this as a
                    # successful reclaim.
                    pass
            if time.monotonic() >= deadline:
                raise TimeoutError(  # noqa: B904
                    f"Timed out waiting for python runtime bootstrap lock: {lock_path}"
                )
            time.sleep(BOOTSTRAP_LOCK_POLL_SECONDS)
        else:
            try:
                _write_bootstrap_lock(lock_fd)
            except Exception:
                os.close(lock_fd)
                lock_fd = None
                _unlink_lock_best_effort(lock_path)
                raise
    try:
        yield
    finally:
        os.close(lock_fd)
        _unlink_lock_best_effort(lock_path)


@contextmanager
def _bootstrap_lock(
    lock_path: Path,
    *,
    deadline_monotonic: float | None = None,
) -> Iterator[None]:
    # Avoid the Windows reader/unlink race between threads in this process;
    # the file lock still provides exclusion across distinct processes.
    with _bootstrap_thread_lock(lock_path):
        with _bootstrap_file_lock(
            lock_path,
            same_process_lock_acquired=True,
            deadline_monotonic=deadline_monotonic,
        ):
            yield
