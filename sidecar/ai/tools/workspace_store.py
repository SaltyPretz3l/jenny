"""Guarded, operation-owning storage for workspace-local ``.jenny`` state.

Callers receive opaque references and immutable receipts, never a ``Path`` they
can later mutate without revalidation.  Every read/write/move/delete resolves
the reference again, checks real/lstat identities immediately before use, and
quarantines hostile pre-existing link objects instead of following them.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import sqlite3
import stat as stat_module
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from itertools import islice
from pathlib import Path
from typing import Iterator, Sequence
from weakref import WeakValueDictionary

from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import ensure_safe_internal_destination
from sidecar.ai.tools.workspace_path_identity import (
    NodeIdentity,
    WorkspaceLeafIdentity,
    bounded_workspace_store_limit,
    canonical_workspace_path_identity,
    is_link_object,
    normalize_workspace_store_parts,
    resolve_workspace_leaf,
    revalidate_workspace_leaf,
)
from sidecar.ai.tools.workspace_store_file_ops import (
    create_empty_regular_leaf,
    fsync_directory,
    link_exclusive,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.file_locking import acquire_file_lock

logger = logging.getLogger(__name__)

MAX_STORE_READ_BYTES = 64 * 1024 * 1024
MAX_STORE_WRITE_BYTES = 64 * 1024 * 1024
MAX_STORE_LIST_ENTRIES = 10_000
MAX_STORE_DELETE_ENTRIES = 10_000
_MAX_QUARANTINE_SOURCE_CHARS = 160
_JENNY_DIR = ".jenny"
_SAFE_QUARANTINE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
# Trailing-dot/space Windows I/O quirk; mirrors workspace-root-identity.js.
_JENNY_DIR_TRAILING_RE = re.compile(r"[.\s]+$")


class WorkspaceStoreKind(str, Enum):
    ARTIFACTS = "artifacts"
    BACKUPS = "backups"
    OMISSIONS = "omissions"
    QUARANTINE = "quarantine"
    TOOL_RESULTS = "tool-results"
    TRASH = "trash"


@dataclass(frozen=True)
class StoreRef:
    kind: WorkspaceStoreKind
    parts: tuple[str, ...] = ()


@dataclass(frozen=True)
class StoredObject:
    ref: StoreRef
    display_path: str
    absolute_path: str
    name: str
    size_bytes: int


@dataclass(frozen=True)
class StoreRead:
    data: bytes
    stat_result: os.stat_result


@dataclass(frozen=True)
class StoreEntry:
    ref: StoreRef
    name: str
    is_directory: bool
    size_bytes: int
    mtime_ns: int


@dataclass(frozen=True)
class DeleteOutcome:
    removed: bool
    quarantined: bool
    entries_removed: int


@dataclass(frozen=True)
class _ResolvedRef:
    ref: StoreRef
    path: Path
    ancestors: tuple[tuple[Path, NodeIdentity], ...]
    leaf_identity: NodeIdentity | None


class _RootLockState:
    def __init__(self) -> None:
        self.lock = threading.RLock()


_ROOT_LOCKS_GUARD = threading.Lock()
_ROOT_LOCKS: WeakValueDictionary[str, _RootLockState] = WeakValueDictionary()


def _lock_for_root(identity_key: str) -> _RootLockState:
    with _ROOT_LOCKS_GUARD:
        state = _ROOT_LOCKS.get(identity_key)
        if state is None:
            state = _RootLockState()
            _ROOT_LOCKS[identity_key] = state
        return state


class GuardedWorkspaceStore:
    """The sole operation owner for managed ``.jenny`` paths."""

    def __init__(self, workspace_root: Path | str) -> None:
        try:
            self._root = Path(workspace_root).resolve(strict=True)
            root_stat = self._root.stat(follow_symlinks=False)
        except OSError as error:
            raise _store_failure("workspace store root is unavailable") from error
        if not stat_module.S_ISDIR(root_stat.st_mode):
            raise _store_failure("workspace store root is not a directory", retryable=False)
        if _JENNY_DIR_TRAILING_RE.sub("", self._root.name).lower() == _JENNY_DIR:
            raise _store_failure("workspace root cannot be .jenny state directory", retryable=False)
        self._root_identity = NodeIdentity.from_stat(root_stat)
        canonical = canonical_workspace_path_identity(self._root, self._root)
        identity_key = f"{canonical.key}:{self._root_identity.device}:{self._root_identity.inode}"
        self._lock_state = _lock_for_root(identity_key)
        self._lock = self._lock_state.lock
        self._cache_key = hashlib.sha256(identity_key.encode("utf-8")).hexdigest()

    @property
    def cache_key(self) -> str:
        """A non-path cache identity for long-lived store clients."""
        return self._cache_key

    def resolve(
        self,
        kind: WorkspaceStoreKind | str,
        name: str | Path | Sequence[str] | None = None,
    ) -> StoreRef:
        """Return an opaque, validated reference (no filesystem lookup)."""
        if not isinstance(kind, WorkspaceStoreKind):
            try:
                kind = WorkspaceStoreKind(str(kind))
            except ValueError as error:
                raise _store_failure("unknown workspace store kind", retryable=False) from error
        parts = normalize_workspace_store_parts(name)
        return StoreRef(kind=kind, parts=parts)

    def child(self, parent: StoreRef, *parts: str) -> StoreRef:
        additions = normalize_workspace_store_parts(parts)
        return StoreRef(parent.kind, (*parent.parts, *additions))

    def display_path(self, ref: StoreRef) -> str:
        suffix = "/".join((ref.kind.value, *ref.parts))
        return f"{_JENNY_DIR}/{suffix}"

    def exists(self, ref: StoreRef) -> bool:
        with self._lock:
            resolved = self._prepare(ref, create_parents=False)
            return resolved.leaf_identity is not None

    def stat(self, ref: StoreRef) -> StoreEntry | None:
        with self._lock:
            resolved = self._prepare(ref, create_parents=False)
            if resolved.leaf_identity is None:
                return None
            self._revalidate(resolved)
            try:
                value = resolved.path.stat(follow_symlinks=False)
            except OSError as error:
                raise _store_failure("workspace store entry changed during stat") from error
            return StoreEntry(
                ref=ref,
                name=resolved.path.name,
                is_directory=stat_module.S_ISDIR(value.st_mode),
                size_bytes=max(int(value.st_size), 0),
                mtime_ns=max(int(value.st_mtime_ns), 0),
            )

    def read_bytes(
        self,
        ref: StoreRef,
        *,
        max_bytes: int,
        missing_ok: bool = False,
    ) -> bytes | None:
        result = self.read(ref, max_bytes=max_bytes, missing_ok=missing_ok)
        return None if result is None else result.data

    def read(
        self,
        ref: StoreRef,
        *,
        max_bytes: int,
        missing_ok: bool = False,
    ) -> StoreRead | None:
        limit = bounded_workspace_store_limit(max_bytes, MAX_STORE_READ_BYTES)
        with self._lock:
            resolved = self._prepare(ref, create_parents=False)
            if resolved.leaf_identity is None:
                if missing_ok:
                    return None
                raise _store_failure("workspace store entry does not exist", retryable=False)
            if not stat_module.S_ISREG(resolved.leaf_identity.mode):
                raise _store_failure("workspace store entry is not a regular file", retryable=False)
            if resolved.leaf_identity.size > limit:
                raise _cap_failure("workspace store read exceeds byte limit")
            self._before_operation(ref)
            self._revalidate(resolved)
            flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            fd: int | None = None
            try:
                fd = os.open(str(resolved.path), flags)
                opened_stat = os.fstat(fd)
                if NodeIdentity.from_stat(opened_stat) != resolved.leaf_identity:
                    raise _store_failure("workspace store entry changed before read")
                data = _read_fd_bounded(fd, limit)
                final_stat = os.fstat(fd)
                if NodeIdentity.from_stat(final_stat) != resolved.leaf_identity:
                    raise _store_failure("workspace store entry changed during read")
                return StoreRead(data=data, stat_result=final_stat)
            except ToolExecutionFailure:
                raise
            except OSError as error:
                raise _store_failure("workspace store read failed") from error
            finally:
                if fd is not None:
                    os.close(fd)

    def write_text_atomic(
        self,
        ref: StoreRef,
        text: str,
        *,
        max_bytes: int = MAX_STORE_WRITE_BYTES,
    ) -> StoredObject:
        try:
            encoded = text.encode("utf-8", errors="strict")
        except UnicodeEncodeError as error:
            raise _store_failure(
                "workspace store text is not valid UTF-8", retryable=False
            ) from error
        return self.write_bytes_atomic(ref, encoded, max_bytes=max_bytes)

    def write_json_atomic(
        self,
        ref: StoreRef,
        payload: object,
        *,
        max_bytes: int = MAX_STORE_WRITE_BYTES,
    ) -> StoredObject:
        encoded = (
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        ).encode("utf-8")
        return self.write_bytes_atomic(ref, encoded, max_bytes=max_bytes)

    def write_bytes_atomic(
        self,
        ref: StoreRef,
        content: bytes,
        *,
        max_bytes: int = MAX_STORE_WRITE_BYTES,
        mode: int | None = None,
    ) -> StoredObject:
        return self._write_bytes_atomic(
            ref,
            content,
            max_bytes=max_bytes,
            mode=mode,
            exclusive=False,
        )

    def write_unique_bytes(
        self,
        parent: StoreRef,
        *,
        file_stem: str,
        file_extension: str,
        content: bytes,
        max_bytes: int = MAX_STORE_WRITE_BYTES,
    ) -> StoredObject:
        for counter in range(1, 10_001):
            suffix = "" if counter == 1 else f"-{counter}"
            ref = self.child(parent, f"{file_stem}{suffix}{file_extension}")
            try:
                return self._write_bytes_atomic(
                    ref,
                    content,
                    max_bytes=max_bytes,
                    mode=0o600,
                    exclusive=True,
                )
            except FileExistsError:
                continue
        raise _cap_failure("workspace store unique-name attempts exhausted")

    def read_workspace_source(
        self,
        source: Path,
        *,
        max_bytes: int = MAX_STORE_READ_BYTES,
    ) -> StoreRead:
        """Guarded bounded read of a workspace file, not a store entry.

        The source is resolved as a workspace leaf, link objects are refused,
        and open-file identity is checked before and after the bounded read.
        """
        limit = bounded_workspace_store_limit(max_bytes, MAX_STORE_READ_BYTES)
        source_identity = resolve_workspace_leaf(self._root, str(source))
        if source_identity.is_link_object:
            raise _store_failure("checkpoint source cannot be a link object")
        revalidate_workspace_leaf(source_identity)
        try:
            fd = os.open(
                str(source_identity.leaf_path),
                os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
        except ToolExecutionFailure:
            raise
        except OSError as error:
            raise _store_failure("failed to open checkpoint source") from error
        try:
            source_stat = os.fstat(fd)
            if NodeIdentity.from_stat(source_stat) != source_identity.leaf_identity:
                raise _store_failure("checkpoint source changed before read")
            if not stat_module.S_ISREG(source_stat.st_mode):
                raise _store_failure("checkpoint source is not a regular file", retryable=False)
            if source_stat.st_size > limit:
                raise _cap_failure("checkpoint source exceeds byte limit")
            data = _read_fd_bounded(fd, limit)
            if NodeIdentity.from_stat(os.fstat(fd)) != source_identity.leaf_identity:
                raise _store_failure("checkpoint source changed during read")
        finally:
            os.close(fd)
        return StoreRead(data=data, stat_result=source_stat)

    def move_workspace_leaf_atomic(
        self,
        source: WorkspaceLeafIdentity,
        destination: StoreRef,
    ) -> StoredObject:
        if canonical_workspace_path_identity(source.root, self._root).key != (
            canonical_workspace_path_identity(self._root, self._root).key
        ):
            raise _store_failure("move source belongs to a different workspace", retryable=False)
        with self._lock:
            resolved = self._prepare(destination, create_parents=True)
            if resolved.leaf_identity is not None:
                raise _store_failure("workspace store move destination already exists")
            self._before_operation(destination)
            revalidate_workspace_leaf(source)
            self._revalidate(resolved)
            try:
                os.replace(source.leaf_path, resolved.path)
            except OSError as error:
                raise _store_failure("workspace store move failed") from error
            return self._receipt(destination, source.leaf_identity.size)

    def delete(
        self,
        ref: StoreRef,
        *,
        recursive: bool,
        max_entries: int = MAX_STORE_DELETE_ENTRIES,
    ) -> DeleteOutcome:
        if ref.kind is WorkspaceStoreKind.QUARANTINE:
            raise _store_failure("direct quarantine deletion is not supported", retryable=False)
        limit = bounded_workspace_store_limit(max_entries, MAX_STORE_DELETE_ENTRIES)
        with self._lock:
            resolved = self._prepare(ref, create_parents=False)
            if resolved.leaf_identity is None:
                return DeleteOutcome(removed=False, quarantined=False, entries_removed=0)
            if stat_module.S_ISDIR(resolved.leaf_identity.mode) and not recursive:
                raise _store_failure(
                    "recursive delete is required for a directory", retryable=False
                )
            tombstone = self.resolve(
                WorkspaceStoreKind.QUARANTINE,
                _quarantine_name(ref.kind.value, resolved.path.name, "deleted"),
            )
            tombstone_path = self._prepare(tombstone, create_parents=True)
            self._before_operation(ref)
            self._revalidate(resolved)
            self._revalidate(tombstone_path)
            try:
                os.replace(resolved.path, tombstone_path.path)
            except OSError as error:
                raise _store_failure("workspace store delete quarantine move failed") from error
            counter = [0]
            try:
                self._remove_no_follow(tombstone_path.path, counter=counter, limit=limit)
            except (OSError, ToolExecutionFailure) as error:
                self._log_delete_degraded(ref, type(error).__name__)
                return DeleteOutcome(
                    removed=False,
                    quarantined=True,
                    entries_removed=counter[0],
                )
            return DeleteOutcome(
                removed=not tombstone_path.path.exists()
                and not tombstone_path.path.is_symlink(),
                quarantined=True,
                entries_removed=counter[0],
            )

    def list_entries(
        self,
        parent: StoreRef,
        *,
        max_entries: int = MAX_STORE_LIST_ENTRIES,
        quarantine_links: bool = True,
    ) -> tuple[StoreEntry, ...]:
        """List one directory level. Link objects are quarantined by default.

        ``quarantine_links=False`` (WIDE-044) is for the TRASH kind, where a
        soft-deleted junction/symlink is a LEGITIMATE resident: the link is
        reported as a non-directory leaf (never followed, never descended
        into) instead of being destroyed by a maintenance listing.
        """
        limit = bounded_workspace_store_limit(max_entries, MAX_STORE_LIST_ENTRIES)
        with self._lock:
            resolved = self._prepare(parent, create_parents=False)
            if resolved.leaf_identity is None:
                return ()
            if not stat_module.S_ISDIR(resolved.leaf_identity.mode):
                raise _store_failure(
                    "workspace store list target is not a directory", retryable=False
                )
            self._before_operation(parent)
            self._revalidate(resolved)
            try:
                with os.scandir(resolved.path) as iterator:
                    raw_entries = list(islice(iterator, limit + 1))
            except OSError as error:
                raise _store_failure("workspace store list failed") from error
            if len(raw_entries) > limit:
                raise _cap_failure("workspace store list exceeds entry limit")
            entries: list[StoreEntry] = []
            for entry in raw_entries:
                entry_path = Path(entry.path)
                is_link = False
                try:
                    if is_link_object(entry_path):
                        if quarantine_links:
                            self._quarantine_component(
                                resolved.path,
                                entry_path,
                                kind=parent.kind,
                                depth=len(parent.parts) + 1,
                            )
                            continue
                        is_link = True
                    value = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                child_ref = self.child(parent, entry.name)
                entries.append(
                    StoreEntry(
                        ref=child_ref,
                        name=entry.name,
                        is_directory=(not is_link) and stat_module.S_ISDIR(value.st_mode),
                        size_bytes=max(int(value.st_size), 0),
                        mtime_ns=max(int(value.st_mtime_ns), 0),
                    )
                )
            return tuple(entries)

    @contextlib.contextmanager
    def file_lock(self, ref: StoreRef, *, timeout_seconds: float) -> Iterator[None]:
        with self._lock:
            resolved = self._prepare(ref, create_parents=True)
            if resolved.leaf_identity is None:
                try:
                    self._write_bytes_atomic(
                        ref,
                        b"",
                        max_bytes=0,
                        mode=0o600,
                        exclusive=True,
                    )
                except FileExistsError:
                    pass
                resolved = self._prepare(ref, create_parents=True)
            if resolved.leaf_identity is None:
                raise _store_failure("workspace store lock was not created")
            if not stat_module.S_ISREG(resolved.leaf_identity.mode):
                raise _store_failure("workspace store lock target is not a regular file")
            self._before_operation(ref)
            self._revalidate(resolved, allow_metadata_changes=True)
            path = resolved.path
        with acquire_file_lock(path, timeout_seconds=timeout_seconds):
            with self._lock:
                self._revalidate(resolved, allow_metadata_changes=True)
            yield

    def open_sqlite(self, ref: StoreRef) -> sqlite3.Connection:
        """Open a guarded SQLite file while retaining operation ownership."""

        with self._lock:
            resolved = self._prepare(ref, create_parents=True)
            if resolved.leaf_identity is None:
                self._revalidate(resolved)
                create_empty_regular_leaf(resolved.path)
                resolved = self._prepare(ref, create_parents=False)
            if resolved.leaf_identity is not None and not stat_module.S_ISREG(
                resolved.leaf_identity.mode
            ):
                raise _store_failure("workspace store database target is not a file")
            if resolved.leaf_identity is None:
                raise _store_failure("workspace store database was not created")
            self._before_operation(ref)
            self._revalidate(resolved)
            try:
                connection = sqlite3.connect(
                    str(resolved.path), timeout=5.0, check_same_thread=False
                )
            except sqlite3.Error as error:
                raise _store_failure("workspace store database open failed") from error
            try:
                verified = self._prepare(ref, create_parents=False)
                if (
                    verified.leaf_identity is None
                    or not verified.leaf_identity.same_object(resolved.leaf_identity)
                ):
                    raise _store_failure("workspace store database identity changed")
                self._revalidate(verified)
            except Exception:
                connection.close()
                raise
            return connection

    def revalidate(self, ref: StoreRef) -> None:
        with self._lock:
            resolved = self._prepare(ref, create_parents=False)
            if resolved.leaf_identity is None:
                raise _store_failure("workspace store entry does not exist")
            self._revalidate(resolved)

    def _write_bytes_atomic(
        self,
        ref: StoreRef,
        content: bytes,
        *,
        max_bytes: int,
        mode: int | None,
        exclusive: bool,
    ) -> StoredObject:
        limit = bounded_workspace_store_limit(max_bytes, MAX_STORE_WRITE_BYTES)
        if len(content) > limit:
            raise _cap_failure("workspace store write exceeds byte limit")
        with self._lock:
            resolved = self._prepare(ref, create_parents=True)
            if resolved.leaf_identity is not None:
                if exclusive:
                    raise FileExistsError(self.display_path(ref))
                if not stat_module.S_ISREG(resolved.leaf_identity.mode):
                    raise _store_failure("workspace store write target is not a regular file")
            existing_mode = (
                stat_module.S_IMODE(resolved.leaf_identity.mode)
                if resolved.leaf_identity is not None
                else None
            )
            try:
                temp_parent_identity = _node_identity(resolved.path.parent)
                self._revalidate(resolved)
                fd, temp_name = tempfile.mkstemp(
                    prefix=f".{resolved.path.name}.",
                    suffix=".tmp",
                    dir=str(resolved.path.parent),
                )
                temp_path = Path(temp_name)
                temp_identity = NodeIdentity.from_stat(os.fstat(fd))
            except ToolExecutionFailure:
                raise
            except OSError as error:
                raise _store_failure("workspace store temp creation failed") from error
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
                self._revalidate(resolved)
                if not _node_identity(temp_path).same_object(temp_identity):
                    raise _store_failure("workspace store temp identity changed")
                os.chmod(temp_path, mode or existing_mode or 0o600)
                self._before_operation(ref)
                self._revalidate(resolved)
                if exclusive:
                    link_exclusive(temp_path, resolved.path)
                    temp_path.unlink()
                else:
                    os.replace(temp_path, resolved.path)
                fsync_directory(resolved.path.parent)
            except FileExistsError:
                _unlink_if_identity(
                    temp_path,
                    temp_identity,
                    temp_parent_identity,
                )
                raise
            except ToolExecutionFailure:
                _unlink_if_identity(
                    temp_path,
                    temp_identity,
                    temp_parent_identity,
                )
                raise
            except OSError as error:
                _unlink_if_identity(
                    temp_path,
                    temp_identity,
                    temp_parent_identity,
                )
                raise _store_failure("workspace store atomic write failed") from error
            return self._receipt(ref, len(content))

    def _prepare(  # noqa: C901, PLR0912 - one guarded path-chain state machine.
        self, ref: StoreRef, *, create_parents: bool
    ) -> _ResolvedRef:
        _validate_store_ref(ref)
        self._revalidate_root()
        jenny = self._ensure_jenny_root(create=create_parents)
        if jenny is None:
            path = self._root / _JENNY_DIR / ref.kind.value
            if ref.parts:
                path = path.joinpath(*ref.parts)
            return _ResolvedRef(
                ref,
                path,
                ((self._root, self._root_identity),),
                None,
            )
        ancestors: list[tuple[Path, NodeIdentity]] = [
            (self._root, self._root_identity),
            (jenny, _node_identity(jenny)),
        ]
        current = jenny
        components = (ref.kind.value, *ref.parts)
        leaf_identity: NodeIdentity | None = None
        for index, component in enumerate(components):
            is_leaf = index == len(components) - 1
            candidate = current / component
            identity = _lstat_optional(candidate)
            if identity is not None:
                link = is_link_object(candidate)
                invalid_parent = not is_leaf and not stat_module.S_ISDIR(identity.mode)
                if link or invalid_parent:
                    if candidate.name == WorkspaceStoreKind.QUARANTINE.value and current == jenny:
                        self._repair_quarantine_dir(candidate)
                    else:
                        self._quarantine_component(
                            current,
                            candidate,
                            kind=ref.kind,
                            depth=index,
                        )
                    identity = None
            if identity is None:
                if is_leaf:
                    leaf_identity = None
                    break
                if not create_parents:
                    return _ResolvedRef(ref, candidate, tuple(ancestors), None)
                self._revalidate_ancestors(tuple(ancestors))
                try:
                    candidate.mkdir(mode=0o700)
                except FileExistsError:
                    pass
                except OSError as error:
                    raise _store_failure("workspace store directory creation failed") from error
                identity = _node_identity(candidate)
                if is_link_object(candidate) or not stat_module.S_ISDIR(identity.mode):
                    raise _store_failure("workspace store directory identity is unsafe")
            if is_leaf:
                leaf_identity = identity
            else:
                current = candidate
                ancestors.append((current, identity))

        path = jenny.joinpath(*components)
        ensure_safe_internal_destination(self._root, path)
        return _ResolvedRef(ref, path, tuple(ancestors), leaf_identity)

    def _ensure_jenny_root(self, *, create: bool) -> Path | None:
        jenny = self._root / _JENNY_DIR
        identity = _recover_pending(jenny, ".jenny-quarantine-*.pending")
        if identity is not None and (
            is_link_object(jenny) or not stat_module.S_ISDIR(identity.mode)
        ):
            self._quarantine_top_level_jenny(jenny, identity)
            identity = None
        if identity is None:
            if not create:
                return None
            self._revalidate_root()
            try:
                jenny.mkdir(mode=0o700)
            except FileExistsError:
                pass
            except OSError as error:
                raise _store_failure("workspace store root creation failed") from error
        current = _node_identity(jenny)
        if is_link_object(jenny) or not stat_module.S_ISDIR(current.mode):
            raise _store_failure("workspace store root identity is unsafe")
        return jenny

    def _quarantine_top_level_jenny(self, jenny: Path, identity: NodeIdentity) -> None:
        self._revalidate_root()
        _quarantine_layout(jenny, identity, (WorkspaceStoreKind.QUARANTINE.value,))
        self._log_quarantine(WorkspaceStoreKind.QUARANTINE, depth=0, reason="jenny_root")

    def _repair_quarantine_dir(self, quarantine: Path) -> None:
        identity = _node_identity(quarantine)
        destination = _quarantine_layout(quarantine, identity, ())
        if identity.same_object(_node_identity(destination)):
            self._log_quarantine(WorkspaceStoreKind.QUARANTINE, depth=1, reason="quarantine_root")

    def _quarantine_component(
        self,
        parent: Path,
        candidate: Path,
        *,
        kind: WorkspaceStoreKind,
        depth: int,
    ) -> None:
        parent_identity = _node_identity(parent)
        candidate_identity = _node_identity(candidate)
        quarantine = self._ensure_quarantine_dir()
        destination = quarantine / _quarantine_name(kind.value, candidate.name, "unsafe")
        if (
            not _node_identity(parent).same_object(parent_identity)
            or _node_identity(candidate) != candidate_identity
        ):
            raise _store_failure("unsafe workspace store component changed before quarantine")
        try:
            os.replace(candidate, destination)
        except OSError as error:
            raise _store_failure("unsafe workspace store component quarantine failed") from error
        self._log_quarantine(kind, depth=depth, reason="link_or_layout")

    def _ensure_quarantine_dir(self) -> Path:
        jenny = self._root / _JENNY_DIR
        quarantine = jenny / WorkspaceStoreKind.QUARANTINE.value
        identity = _recover_pending(quarantine, ".quarantine-*.pending")
        if identity is not None and (
            is_link_object(quarantine) or not stat_module.S_ISDIR(identity.mode)
        ):
            self._repair_quarantine_dir(quarantine)
            identity = _node_identity(quarantine)
        if identity is None:
            try:
                quarantine.mkdir(mode=0o700)
            except FileExistsError:
                pass
            except OSError as error:
                raise _store_failure("workspace quarantine directory creation failed") from error
            identity = _node_identity(quarantine)
        if is_link_object(quarantine) or not stat_module.S_ISDIR(identity.mode):
            raise _store_failure("workspace quarantine directory is unsafe")
        return quarantine

    def _revalidate(self, resolved: _ResolvedRef, *, allow_metadata_changes: bool = False) -> None:
        self._revalidate_ancestors(resolved.ancestors)
        current = _lstat_optional(resolved.path)
        changed = current != resolved.leaf_identity
        if allow_metadata_changes and resolved.leaf_identity is not None:
            changed = not resolved.leaf_identity.same_object(current)
        if changed:
            raise _store_failure("workspace store entry changed before use")
        if current is not None and is_link_object(resolved.path):
            raise _store_failure("workspace store entry became a link before use")

    def _revalidate_ancestors(
        self, ancestors: tuple[tuple[Path, NodeIdentity], ...]
    ) -> None:
        for path, expected in ancestors:
            current = _node_identity(path)
            if not current.same_object(expected) or is_link_object(path):
                raise _store_failure("workspace store parent changed before use")

    def _revalidate_root(self) -> None:
        current = _node_identity(self._root)
        if not current.same_object(self._root_identity) or is_link_object(self._root):
            raise _store_failure("workspace store root changed before use")

    def _receipt(self, ref: StoreRef, size_bytes: int) -> StoredObject:
        path = self._root / _JENNY_DIR / ref.kind.value
        if ref.parts:
            path = path.joinpath(*ref.parts)
        return StoredObject(
            ref=ref,
            display_path=self.display_path(ref),
            absolute_path=str(path),
            name=path.name,
            size_bytes=max(int(size_bytes), 0),
        )

    def _remove_no_follow(self, path: Path, *, counter: list[int], limit: int) -> None:
        if counter[0] >= limit:
            raise _cap_failure("workspace store delete exceeds entry limit")
        identity = _node_identity(path)
        if is_link_object(path):
            _unlink_link_object(path, identity)
            counter[0] += 1
            return
        if stat_module.S_ISDIR(identity.mode):
            with os.scandir(path) as iterator:
                remaining = limit - counter[0]
                children = list(islice(iterator, remaining + 1))
            if len(children) > remaining:
                raise _cap_failure("workspace store delete exceeds entry limit")
            for child in children:
                self._remove_no_follow(Path(child.path), counter=counter, limit=limit)
            if counter[0] >= limit:
                raise _cap_failure("workspace store delete exceeds entry limit")
            path.rmdir()
            counter[0] += 1
            return
        path.unlink()
        counter[0] += 1

    def _log_quarantine(
        self,
        kind: WorkspaceStoreKind,
        *,
        depth: int,
        reason: str,
    ) -> None:
        log_event(
            logger,
            logging.WARNING,
            component="ai.tools.workspace_store",
            event="ai.tools.workspace_store.link_quarantined",
            message="Quarantined an unsafe workspace-local storage object",
            status="degraded",
            data={"kind": kind.value, "depth": max(depth, 0), "reason": reason},
        )

    def _log_delete_degraded(self, ref: StoreRef, error_type: str) -> None:
        log_event(
            logger,
            logging.WARNING,
            component="ai.tools.workspace_store",
            event="ai.tools.workspace_store.delete_degraded",
            message="Workspace-local storage deletion remained quarantined",
            status="degraded",
            data={"kind": ref.kind.value, "error_type": error_type},
        )

    def _before_operation(self, _ref: StoreRef) -> None:
        """Deterministic test seam immediately before identity revalidation."""


def _validate_store_ref(ref: StoreRef) -> None:
    if not isinstance(ref, StoreRef) or not isinstance(ref.kind, WorkspaceStoreKind):
        raise _store_failure("workspace store reference is invalid", retryable=False)
    if normalize_workspace_store_parts(ref.parts) != ref.parts:
        raise _store_failure("workspace store reference is invalid", retryable=False)


def _node_identity(path: Path) -> NodeIdentity:
    try:
        return NodeIdentity.from_stat(path.stat(follow_symlinks=False))
    except OSError as error:
        raise _store_failure("workspace store identity probe failed") from error


def _lstat_optional(path: Path) -> NodeIdentity | None:
    try:
        return NodeIdentity.from_stat(path.lstat())
    except FileNotFoundError:
        return None
    except OSError as error:
        raise _store_failure("workspace store identity probe failed") from error


def _recover_pending(target: Path, pattern: str) -> NodeIdentity | None:
    if (identity := _lstat_optional(target)) is not None:
        return identity
    if (pending := next(target.parent.glob(pattern), None)) is None:
        return None
    try:
        os.replace(pending, target)
    except OSError as error:
        raise _store_failure("workspace store pending layout recovery failed") from error
    return _node_identity(target)


def _quarantine_layout(
    source: Path, identity: NodeIdentity, destination_parts: tuple[str, ...],
) -> Path:
    parent_identity = _node_identity(source.parent)
    pending_prefix = ".jenny-quarantine-" if destination_parts else ".quarantine-"
    source_name = "jenny" if destination_parts else "quarantine"
    pending = source.parent / f"{pending_prefix}{uuid.uuid4().hex}.pending"
    quarantine = pending.joinpath(*destination_parts)
    staged_destination = quarantine / _quarantine_name("layout", source_name, "unsafe")
    try:
        if not _node_identity(source.parent).same_object(parent_identity):
            raise OSError("layout parent changed")
        if _node_identity(source) != identity:
            raise OSError("layout source changed")
        pending.mkdir(mode=0o700)
        quarantine.mkdir(mode=0o700, exist_ok=True)
        os.replace(source, staged_destination)
        os.replace(pending, source)
    except (OSError, ToolExecutionFailure) as error:
        if (
            _node_identity(source.parent).same_object(parent_identity)
            and _lstat_optional(source) is None
            and _lstat_optional(staged_destination) == identity
        ):
            with contextlib.suppress(OSError):
                os.replace(staged_destination, source)
        for directory in (quarantine, pending):
            with contextlib.suppress(OSError):
                directory.rmdir()
        raise _store_failure("unsafe workspace store layout quarantine failed") from error
    return source.joinpath(*destination_parts, staged_destination.name)


def _read_fd_bounded(fd: int, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = os.read(fd, min(64 * 1024, limit + 1 - total))
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        total += len(chunk)
        if total > limit:
            raise _cap_failure("workspace store read exceeds byte limit")


def _unlink_link_object(path: Path, identity: NodeIdentity) -> None:
    try:
        path.unlink()
    except IsADirectoryError:
        path.rmdir()
    except PermissionError:
        if stat_module.S_ISDIR(identity.mode):
            path.rmdir()
        else:
            raise


def _unlink_if_identity(
    path: Path,
    expected: NodeIdentity | None,
    expected_parent: NodeIdentity,
) -> None:
    if expected is None:
        return
    try:
        parent_now = _node_identity(path.parent)
        current = _lstat_optional(path)
        if (
            not parent_now.same_object(expected_parent)
            or current is None
            or not current.same_object(expected)
        ):
            return
        path.unlink()
    except (OSError, ToolExecutionFailure):
        return


def _quarantine_name(kind: str, name: str, reason: str) -> str:
    safe_name = (_SAFE_QUARANTINE_NAME.sub("-", name).strip(".-") or "entry")[
        :_MAX_QUARANTINE_SOURCE_CHARS
    ]
    stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
    return f"{kind}-{safe_name}-{reason}-{stamp}-{uuid.uuid4().hex}"


def _store_failure(message: str, *, retryable: bool = True) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message=message, retryable=retryable)


def _cap_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_CAP_EXCEEDED, message=message, retryable=False)


__all__ = [
    "DeleteOutcome", "GuardedWorkspaceStore",
    "MAX_STORE_DELETE_ENTRIES", "MAX_STORE_LIST_ENTRIES",
    "MAX_STORE_READ_BYTES", "MAX_STORE_WRITE_BYTES",
    "StoreEntry", "StoreRead", "StoreRef", "StoredObject", "WorkspaceStoreKind",
]
