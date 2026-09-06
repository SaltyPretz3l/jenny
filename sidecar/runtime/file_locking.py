"""Cross-process file lock helpers for workspace-local coordination files."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure

if TYPE_CHECKING:
    from filelock import FileLock

# `filelock` costs ~170ms to import because it pulls in asyncio, and this module
# sits in the builtin-tools subprocess import graph that the sidecar blocks on
# during `initialize`. Nothing here needs filelock until a lock is actually
# taken, so it is resolved on first use instead of on the startup path.

BACKGROUND_WRITE_TIMEOUT_SECONDS = 5.0
INTERACTIVE_WRITE_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class FileLockAttempt:
    acquired: bool
    reason: str = ""


def _prepare_file_lock(lock_path: Path) -> FileLock:
    """Create the lock directory and return a ready FileLock instance."""
    from filelock import FileLock  # noqa: PLC0415

    normalized_lock_path = _normalize_lock_path(lock_path)
    try:
        normalized_lock_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to create lock directory: {error}",
            retryable=True,
        ) from error
    return FileLock(str(normalized_lock_path))


def _normalize_lock_path(lock_path: Path) -> Path:
    if lock_path.name.endswith(".lock"):
        return lock_path
    return lock_path.with_name(f"{lock_path.name}.lock")


@contextmanager
def acquire_file_lock(lock_path: Path, *, timeout_seconds: float) -> Iterator[None]:
    """Hold a per-file lock for the duration of a write transaction."""
    from filelock import Timeout as FileLockTimeout  # noqa: PLC0415

    lock = _prepare_file_lock(lock_path)
    try:
        with lock.acquire(timeout=timeout_seconds):
            yield
    except FileLockTimeout as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"timed out waiting for file lock: {lock_path.name}",
            retryable=True,
        ) from error


@contextmanager
def acquire_regenerable_file_lock(
    lock_path: Path,
    *,
    timeout_seconds: float = BACKGROUND_WRITE_TIMEOUT_SECONDS,
) -> Iterator[FileLockAttempt]:
    """Attempt a best-effort lock for background work that can be skipped safely."""
    from filelock import Timeout as FileLockTimeout  # noqa: PLC0415

    lock = _prepare_file_lock(lock_path)
    try:
        with lock.acquire(timeout=timeout_seconds):
            yield FileLockAttempt(acquired=True)
    except FileLockTimeout:
        yield FileLockAttempt(
            acquired=False,
            reason=f"timed out waiting for file lock: {lock_path.name}",
        )
