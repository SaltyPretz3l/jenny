"""The `.jenny` workspace store on a hosted host: every operation through the pin.

The desktop store (`workspace_store.py`) checks a path, then uses it: `mkstemp`,
`os.replace`, `mkdir` and quarantine renames by path. On a hosted host a
directory swapped between the check and the use would carry the bytes out of the
pinned root (R12-F01). `GuardedWorkspaceStore.__new__` builds this subclass while
hosted file IO is on, and it routes each operation through the facade's pinned,
handle-relative primitives: reads through `open_regular_file`, writes (the temp
file included) through `write_hosted_bytes_atomic`, listings through
`open_hosted_directory`, removals through `remove_hosted_file`. A link at any
store component makes the pinned walk refuse; nothing is followed, quarantined
or created by path. A scope with no backend answers the path failure, so the
store fails closed. Operations with no pinned form (moves, quarantine purges,
SQLite) are refused. It imports no Electron or renderer code.
"""

from __future__ import annotations

import contextlib
import importlib
import os
import stat as stat_module
import sys
import time
from pathlib import Path
from typing import Any, Iterator

from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools import hosted_file_io as hosted
from sidecar.ai.tools import workspace_store
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.jenny_state_dir import (
    JENNY_GITIGNORE_CONTENT,
    JENNY_GITIGNORE_NAME,
    JENNY_STATE_DIR_NAME,
)
from sidecar.ai.tools.workspace_path_identity import (
    bounded_workspace_store_limit,
    normalize_workspace_store_parts,
)
from sidecar.ai.tools.workspace_store import (
    MAX_STORE_DELETE_ENTRIES,
    MAX_STORE_LIST_ENTRIES,
    MAX_STORE_READ_BYTES,
    MAX_STORE_WRITE_BYTES,
    DeleteOutcome,
    GuardedWorkspaceStore,
    StoredObject,
    StoreEntry,
    StoreRead,
    StoreRef,
    WorkspaceStoreKind,
)

_NO_EXPECTATION = object()
_LOCK_POLL_SECONDS = 0.02


class HostedWorkspaceStore(GuardedWorkspaceStore):
    """The store's operations, each through the active request's pin."""

    def exists(self, ref: StoreRef) -> bool:
        return self._entry(ref) is not None

    def stat(self, ref: StoreRef) -> StoreEntry | None:
        found = self._entry(ref)
        described = _describe(found) if found is not None else None
        if described is None:
            return None
        is_directory, size, mtime_ns = described
        return StoreEntry(ref=ref, name=self._path(ref).name, is_directory=is_directory,
                          size_bytes=size, mtime_ns=mtime_ns)

    def read(self, ref: StoreRef, *, max_bytes: int,
             missing_ok: bool = False) -> StoreRead | None:
        limit = bounded_workspace_store_limit(max_bytes, MAX_STORE_READ_BYTES)
        return _read_pinned(self._path(ref), limit, missing_ok=missing_ok)

    def read_workspace_source(self, source: Path, *,
                              max_bytes: int = MAX_STORE_READ_BYTES) -> StoreRead:
        limit = bounded_workspace_store_limit(max_bytes, MAX_STORE_READ_BYTES)
        found = _read_pinned(Path(source), limit, missing_ok=False)
        if found is None:  # missing_ok=False never answers None
            raise _store_failure("failed to open checkpoint source")
        return found

    def list_entries(self, parent: StoreRef, *, max_entries: int = MAX_STORE_LIST_ENTRIES,
                     quarantine_links: bool = True) -> tuple[StoreEntry, ...]:
        """One level. A link is left out (never followed, never quarantined)."""
        limit = bounded_workspace_store_limit(max_entries, MAX_STORE_LIST_ENTRIES)
        try:
            with hosted.open_hosted_directory(self._path(parent)) as directory:
                raw = directory.scan(limit + 1)
                if len(raw) > limit:
                    raise _cap_failure("workspace store list exceeds entry limit")
                entries: list[StoreEntry] = []
                for entry in raw:
                    described = _describe(entry)
                    child = self._child_or_none(parent, entry.name)
                    if described is None or child is None:
                        continue
                    is_directory, size, mtime_ns = described
                    entries.append(StoreEntry(ref=child, name=entry.name, is_directory=is_directory,
                                              size_bytes=size, mtime_ns=mtime_ns))
                return tuple(entries)
        except ToolExecutionFailure as error:
            if error.code != CMP_TOOL_INVALID_PATH:
                raise
            return ()  # absent, or a link: nothing is listed through it

    def delete(self, ref: StoreRef, *, recursive: bool,
               max_entries: int = MAX_STORE_DELETE_ENTRIES) -> DeleteOutcome:
        """One file, removed through the pin; a directory is refused."""
        if ref.kind is WorkspaceStoreKind.QUARANTINE:
            raise _store_failure("direct quarantine deletion is not supported", retryable=False)
        removed = hosted.remove_hosted_file(self._path(ref))
        return DeleteOutcome(removed=removed, quarantined=False, entries_removed=int(removed))

    def move_workspace_leaf_atomic(self, source: Any, destination: StoreRef) -> StoredObject:
        raise hosted.path_failure()

    def purge_quarantine_entry(self, name: str) -> None:
        raise hosted.path_failure()

    def open_sqlite(self, ref: StoreRef) -> Any:
        raise hosted.path_failure()

    def revalidate(self, ref: StoreRef) -> None:
        if self._entry(ref) is None:
            raise _store_failure("workspace store entry does not exist")

    @contextlib.contextmanager
    def file_lock(self, ref: StoreRef, *, timeout_seconds: float) -> Iterator[None]:
        """The lock file is made through the pin and locked on the pinned handle."""
        path = self._path(ref)
        try:
            self._write_bytes_atomic(ref, b"", max_bytes=0, mode=0o600, exclusive=True)
        except FileExistsError:
            pass
        with hosted.open_regular_file(path, "rb") as handle:
            descriptor = handle.fileno()
            _acquire(descriptor, timeout_seconds, path.name)
            try:
                _require_same_file(path, os.fstat(descriptor))
                yield
            finally:
                _release(descriptor)

    def _write_bytes_atomic(self, ref: StoreRef, content: bytes, *, max_bytes: int,
                            mode: int | None, exclusive: bool) -> StoredObject:
        limit = bounded_workspace_store_limit(max_bytes, MAX_STORE_WRITE_BYTES)
        if len(content) > limit:
            raise _cap_failure("workspace store write exceeds byte limit")
        path = self._path(ref)
        self._ensure_gitignore()
        replaced = hosted.write_hosted_bytes_atomic(
            path, content, expected=None if exclusive else _NO_EXPECTATION,
            no_expectation=_NO_EXPECTATION, mode=mode)
        if not replaced:
            if exclusive:
                raise FileExistsError(self.display_path(ref))
            raise _store_failure("workspace store entry changed before use")
        return self._receipt(ref, len(content))

    def _jenny(self) -> Path:
        """`<pinned root>/.jenny`, built on the active pin's root, never re-resolved."""
        base = hosted.hosted_file_io_root()
        if base is None or _same_text(base) != _same_text(str(self._root)):
            raise hosted.path_failure()
        return Path(base, JENNY_STATE_DIR_NAME)

    def _path(self, ref: StoreRef) -> Path:
        if (not isinstance(ref, StoreRef) or not isinstance(ref.kind, WorkspaceStoreKind)
                or normalize_workspace_store_parts(ref.parts) != ref.parts):
            raise _store_failure("workspace store reference is invalid", retryable=False)
        return self._jenny().joinpath(ref.kind.value, *ref.parts)

    def _entry(self, ref: StoreRef) -> Any:
        """The parent's listing entry for `ref`, or None when absent (or behind a link)."""
        path = self._path(ref)
        try:
            with hosted.open_hosted_directory(path.parent) as directory:
                for entry in directory.scan(MAX_STORE_LIST_ENTRIES + 1):
                    if entry.name == path.name:
                        return entry
        except ToolExecutionFailure as error:
            if error.code != CMP_TOOL_INVALID_PATH:
                raise
        return None

    def _child_or_none(self, parent: StoreRef, name: str) -> StoreRef | None:
        try:
            return self.child(parent, name)
        except ToolExecutionFailure:
            return None

    def _ensure_gitignore(self) -> None:
        """Best effort, as on the desktop: `.jenny/.gitignore`, made only if absent."""
        with contextlib.suppress(ToolExecutionFailure, OSError):
            hosted.write_hosted_bytes_atomic(
                self._jenny() / JENNY_GITIGNORE_NAME, JENNY_GITIGNORE_CONTENT.encode("utf-8"),
                expected=None, no_expectation=_NO_EXPECTATION, mode=0o644)


def _active_store_class() -> type[GuardedWorkspaceStore] | None:
    return HostedWorkspaceStore if hosted.hosted_file_io_enabled() else None


# Loading this module (the facade does, whenever it turns hosted IO on) makes
# `GuardedWorkspaceStore(...)` build the pinned store while hosted IO is on.
workspace_store._hosted_store_class = _active_store_class


def _same_text(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def _describe(entry: Any) -> tuple[bool, int, int] | None:
    """(is directory, size, mtime ns) of a listed entry; None for a link or a
    special file. A Windows listing has no times: they read as 0."""
    try:
        if entry.is_dir(follow_symlinks=False):
            return True, 0, 0
        value = entry.stat(follow_symlinks=False)
    except OSError:
        return None  # a Windows reparse point reports no size
    mode = getattr(value, "st_mode", None)
    if mode is not None and not stat_module.S_ISREG(mode):
        return None
    return False, max(int(value.st_size), 0), max(int(getattr(value, "st_mtime_ns", 0)), 0)


def _read_pinned(path: Path, limit: int, *, missing_ok: bool) -> StoreRead | None:
    """A bounded read through the pin. With `missing_ok`, a path the pinned walk
    refuses (an absent parent, or a link) reads as absent: nothing is read
    through it, and a write through the same chain is refused by the walk."""
    try:
        with hosted.open_regular_file(path, "rb") as handle:
            if os.fstat(handle.fileno()).st_size > limit:
                raise _cap_failure("workspace store read exceeds byte limit")
            data = bytes(handle.read(limit + 1))
            if len(data) > limit:
                raise _cap_failure("workspace store read exceeds byte limit")
            return StoreRead(data=data, stat_result=os.fstat(handle.fileno()))
    except FileNotFoundError:
        if missing_ok:
            return None
        raise _store_failure("workspace store entry does not exist", retryable=False) from None
    except ToolExecutionFailure as error:
        if missing_ok and error.code == CMP_TOOL_INVALID_PATH:
            return None
        raise
    except OSError as error:
        raise _store_failure("workspace store read failed") from error


def _require_same_file(path: Path, held: os.stat_result) -> None:
    """The name still names the locked file (a POSIX unlink cannot strand a waiter)."""
    try:
        with hosted.open_regular_file(path, "rb") as handle:
            current = os.fstat(handle.fileno())
    except (OSError, ToolExecutionFailure) as error:
        raise _store_failure("workspace store lock changed before use") from error
    if (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
        raise _store_failure("workspace store lock changed before use")


def _acquire(descriptor: int, timeout_seconds: float, name: str) -> None:
    deadline = time.monotonic() + max(float(timeout_seconds), 0.0)
    while True:
        try:
            _lock(descriptor, release=False)
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_IO_FAILED, message=f"timed out waiting for file lock: {name}",
                    retryable=True,
                ) from None
            time.sleep(_LOCK_POLL_SECONDS)


def _release(descriptor: int) -> None:
    with contextlib.suppress(OSError):
        _lock(descriptor, release=True)


def _lock(descriptor: int, *, release: bool) -> None:
    """One byte at offset 0 on Windows, `flock` elsewhere: what `filelock` takes."""
    if sys.platform == "win32":
        msvcrt = importlib.import_module("msvcrt")
        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_UNLCK if release else msvcrt.LK_NBLCK, 1)
        return
    fcntl = importlib.import_module("fcntl")
    fcntl.flock(descriptor, fcntl.LOCK_UN if release else fcntl.LOCK_EX | fcntl.LOCK_NB)


def _store_failure(message: str, *, retryable: bool = True) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message=message, retryable=retryable)


def _cap_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_CAP_EXCEEDED, message=message, retryable=False)


__all__ = ["HostedWorkspaceStore"]
