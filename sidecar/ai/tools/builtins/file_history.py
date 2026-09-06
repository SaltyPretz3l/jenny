"""Workspace-local checkpoint helpers for destructive filesystem tools.

Checkpoints self-lock through a per-thread reentrant registry. Dedupe uses
content identity, metadata stores relative versioned snapshot names, and
retention enforces count, age, and byte quotas with metadata reconciliation.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import stat as stat_module
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol

from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_store import (
    MAX_STORE_LIST_ENTRIES,
    GuardedWorkspaceStore,
    StoreRef,
    WorkspaceStoreKind,
)
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

BACKUP_ROOT = Path(".jenny") / "backups"
BACKUP_HASH_LENGTH = 16
CONTENT_TOKEN_HASH_LENGTH = 32
MAX_BACKUP_SNAPSHOTS = 100
MAX_BACKUP_AGE_DAYS = 30
MAX_BACKUP_TOTAL_BYTES = 256 * 1024 * 1024
MAX_CHECKPOINT_VERSION = 1_000_000_000
MAX_CHECKPOINT_SOURCE_BYTES = 64 * 1024 * 1024
CHECKPOINT_LOCK_TIMEOUT_SECONDS = 15.0
_RECONCILE_LOCK_TIMEOUT_SECONDS = 2.0

@dataclass(frozen=True)
class CheckpointInfo:
    created: bool
    version: int | None = None
    display_path: str | None = None
    object_id: str | None = None
    workspace_relative_path: str | None = None
    byte_size: int | None = None
    sha256: str | None = None


@dataclass(frozen=True)
class CheckpointPaths:
    relative_path: str
    file_hash: str
    metadata_ref: StoreRef
    lock_ref: StoreRef


class ActiveUseAgeSource(Protocol):
    """WO-26 seam: active-use (not wall-clock) age eligibility for one snapshot.

    Structural, mirroring ``trash_maintenance.ActiveUseAgeSource`` -- kept as
    a separate protocol (not imported from that sibling module) so this file
    and ``trash_maintenance.py`` stay free of a cross-import; both are
    satisfied by the same concrete tracker in
    ``sidecar.ai.tools.workspace_retention``.
    """

    def is_age_eligible(self, entry_name: str, created_at_ns: int) -> bool: ...


def checkpoint_paths_for(target_path: Path, workspace_root: Path) -> CheckpointPaths:
    relative_path = _workspace_relative_path(target_path, workspace_root)
    store = GuardedWorkspaceStore(workspace_root)
    return _checkpoint_paths_for_relative(relative_path, store)


def _checkpoint_paths_for_relative(
    relative_path: str,
    store: GuardedWorkspaceStore,
) -> CheckpointPaths:
    file_hash = hashlib.sha256(relative_path.encode("utf-8")).hexdigest()[:BACKUP_HASH_LENGTH]
    return CheckpointPaths(
        relative_path=relative_path,
        file_hash=file_hash,
        metadata_ref=store.resolve(WorkspaceStoreKind.BACKUPS, f"{file_hash}.json"),
        lock_ref=store.resolve(WorkspaceStoreKind.BACKUPS, f"{file_hash}.lock"),
    )


# ── re-entrant per-thread checkpoint locking ─────────────────────────────────
# A thread that already holds a file's checkpoint lock (via the public
# checkpoint_lock_for/checkpoint_store_lock_for context managers) must be able
# to call create_checkpoint without deadlocking on a second FileLock instance,
# while an UNLOCKED caller still gets full cross-process/thread exclusion.
_HELD_LOCKS = threading.local()


def _held_lock_keys() -> set[tuple[str, str]]:
    keys = getattr(_HELD_LOCKS, "keys", None)
    if keys is None:
        keys = set()
        _HELD_LOCKS.keys = keys
    return keys


@contextmanager
def _reentrant_checkpoint_lock(
    store: GuardedWorkspaceStore,
    paths: CheckpointPaths,
    *,
    timeout_seconds: float,
) -> Iterator[None]:
    held = _held_lock_keys()
    key = (store.cache_key, paths.file_hash)
    if key in held:
        yield
        return
    with store.file_lock(paths.lock_ref, timeout_seconds=timeout_seconds):
        held.add(key)
        try:
            yield
        finally:
            held.discard(key)


@contextmanager
def checkpoint_lock_for(
    target_path: Path,
    workspace_root: Path,
    *,
    timeout_seconds: float,
) -> Iterator[None]:
    store = GuardedWorkspaceStore(workspace_root)
    paths = checkpoint_paths_for(target_path, workspace_root)
    with _reentrant_checkpoint_lock(store, paths, timeout_seconds=timeout_seconds):
        yield


@contextmanager
def checkpoint_store_lock_for(
    relative_path: str,
    store: GuardedWorkspaceStore,
    *,
    timeout_seconds: float,
) -> Iterator[None]:
    paths = _checkpoint_paths_for_relative(relative_path, store)
    with _reentrant_checkpoint_lock(store, paths, timeout_seconds=timeout_seconds):
        yield


# ── checkpoint creation ──────────────────────────────────────────────────────


def plan_checkpoint(target_path: Path, workspace_root: Path) -> CheckpointInfo:
    """Resolve the exact recovery object without creating it."""
    if not target_path.exists():
        return CheckpointInfo(created=False)
    store = GuardedWorkspaceStore(workspace_root)
    paths = checkpoint_paths_for(target_path, workspace_root)
    with _reentrant_checkpoint_lock(
        store, paths, timeout_seconds=CHECKPOINT_LOCK_TIMEOUT_SECONDS
    ):
        try:
            source = store.read_workspace_source(
                target_path, max_bytes=MAX_CHECKPOINT_SOURCE_BYTES
            )
        except ToolExecutionFailure as error:
            raise ToolExecutionFailure(
                code=error.code,
                message=f"failed to read file before checkpoint: {error.message}",
                retryable=error.retryable,
            ) from error
        metadata = _load_metadata(store, paths.metadata_ref)
        content_token = _content_token(source.data)
        if _should_skip_checkpoint(store, metadata, content_token):
            last_snapshot = metadata["last_snapshot"]
            return _checkpoint_info(
                snapshot_name=str(last_snapshot["snapshot_name"]),
                version=int(last_snapshot["version"]),
                data=source.data,
                created=False,
            )
        version = _next_checkpoint_version(store, paths, metadata)
        return _checkpoint_info(
            snapshot_name=f"{paths.file_hash}@v{version}.bak",
            version=version,
            data=source.data,
            created=True,
        )


def checkpoint_matches_plan(actual: CheckpointInfo, planned: CheckpointInfo) -> bool:
    """Confirm creation fulfilled the recovery object referenced by the journal."""
    return actual == planned


def materialize_checkpoint_plan(
    target_path: Path,
    workspace_root: Path,
    planned: CheckpointInfo,
    *,
    is_object_pinned: Callable[[str], bool] | None = None,
    apply_retention: bool = True,
) -> CheckpointInfo:
    actual = create_checkpoint(
        target_path,
        workspace_root,
        is_object_pinned=is_object_pinned,
        apply_retention=apply_retention,
    )
    if not checkpoint_matches_plan(actual, planned):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="checkpoint identity changed after journal reservation",
            retryable=True,
        )
    return actual


def create_checkpoint(
    target_path: Path,
    workspace_root: Path,
    *,
    is_object_pinned: Callable[[str], bool] | None = None,
    apply_retention: bool = True,
) -> CheckpointInfo:
    if not target_path.exists():
        return CheckpointInfo(created=False)

    store = GuardedWorkspaceStore(workspace_root)
    paths = checkpoint_paths_for(target_path, workspace_root)
    with _reentrant_checkpoint_lock(
        store, paths, timeout_seconds=CHECKPOINT_LOCK_TIMEOUT_SECONDS
    ):
        try:
            source = store.read_workspace_source(
                target_path, max_bytes=MAX_CHECKPOINT_SOURCE_BYTES
            )
        except ToolExecutionFailure as error:
            raise ToolExecutionFailure(
                code=error.code,
                message=f"failed to read file before checkpoint: {error.message}",
                retryable=error.retryable,
            ) from error
        return _create_checkpoint_locked(
            store=store,
            paths=paths,
            data=source.data,
            source_stat=source.stat_result,
            is_object_pinned=is_object_pinned,
            apply_retention=apply_retention,
        )


def create_store_checkpoint(
    source_ref: StoreRef,
    relative_path: str,
    store: GuardedWorkspaceStore,
    *,
    is_object_pinned: Callable[[str], bool] | None = None,
    apply_retention: bool = True,
) -> CheckpointInfo:
    paths = _checkpoint_paths_for_relative(relative_path, store)
    with _reentrant_checkpoint_lock(
        store, paths, timeout_seconds=CHECKPOINT_LOCK_TIMEOUT_SECONDS
    ):
        source = store.read(source_ref, max_bytes=MAX_CHECKPOINT_SOURCE_BYTES, missing_ok=True)
        if source is None:
            return CheckpointInfo(created=False)
        return _create_checkpoint_locked(
            store=store,
            paths=paths,
            data=source.data,
            source_stat=source.stat_result,
            is_object_pinned=is_object_pinned,
            apply_retention=apply_retention,
        )


def _create_checkpoint_locked(  # noqa: PLR0913 - explicit checkpoint controls.
    *,
    store: GuardedWorkspaceStore,
    paths: CheckpointPaths,
    data: bytes,
    source_stat: os.stat_result,
    is_object_pinned: Callable[[str], bool] | None = None,
    apply_retention: bool = True,
) -> CheckpointInfo:
    metadata = _load_metadata(store, paths.metadata_ref)
    content_token = _content_token(data)
    if _should_skip_checkpoint(store, metadata, content_token):
        log_event(
            logger,
            logging.DEBUG,
            component="ai.tools.file_history",
            event="ai.tools.file_history.checkpoint_skipped",
            message=f"Skipped unchanged checkpoint for {paths.relative_path}",
            status="skipped",
            data={"path": paths.relative_path, "reason": "unchanged"},
        )
        last_snapshot = metadata["last_snapshot"]
        return _checkpoint_info(
            snapshot_name=str(last_snapshot["snapshot_name"]),
            version=int(last_snapshot["version"]),
            data=data,
            created=False,
        )

    version = _next_checkpoint_version(store, paths, metadata)
    snapshot_name = f"{paths.file_hash}@v{version}.bak"
    snapshot_ref = store.resolve(WorkspaceStoreKind.BACKUPS, snapshot_name)
    try:
        # Snapshot first, metadata second — both individually temp+rename
        # atomic. A crash between the two leaves an UNREFERENCED snapshot
        # (harmless; retention collects it), never metadata pointing at a
        # missing snapshot.
        snapshot = store.write_bytes_atomic(
            snapshot_ref,
            data,
            max_bytes=MAX_CHECKPOINT_SOURCE_BYTES,
            mode=stat_module.S_IMODE(source_stat.st_mode),
        )
    except ToolExecutionFailure as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to create checkpoint: {error.message}",
            retryable=True,
        ) from error

    payload = _checkpoint_payload(
        paths=paths,
        version=version,
        snapshot_name=snapshot_name,
        content_token=content_token,
        source_stat=source_stat,
        data=data,
    )
    store.write_json_atomic(paths.metadata_ref, payload)
    if apply_retention:
        _apply_backup_retention(
            store,
            active_file_hash=paths.file_hash,
            is_object_pinned=is_object_pinned,
        )
    log_event(
        logger,
        logging.DEBUG,
        component="ai.tools.file_history",
        event="ai.tools.file_history.checkpoint_created",
        message=f"Created checkpoint for {paths.relative_path}",
        status="success",
        data={"path": paths.relative_path, "checkpoint": snapshot.display_path, "version": version},
    )
    return _checkpoint_info(
        snapshot_name=snapshot_name,
        version=version,
        data=data,
        created=True,
    )


def _checkpoint_info(
    *, snapshot_name: str, version: int, data: bytes, created: bool
) -> CheckpointInfo:
    relative_path = f"{BACKUP_ROOT.as_posix()}/{snapshot_name}"
    return CheckpointInfo(
        created=created,
        version=version,
        display_path=relative_path,
        object_id=f"backup:{snapshot_name}",
        workspace_relative_path=relative_path,
        byte_size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )


# ── metadata ─────────────────────────────────────────────────────────────────


def _content_token(data: bytes) -> str:
    digest = hashlib.sha256(data).hexdigest()[:CONTENT_TOKEN_HASH_LENGTH]
    return f"{len(data)}:{digest}"


def _checkpoint_payload(  # noqa: PLR0913 - complete persisted snapshot identity.
    *,
    paths: CheckpointPaths,
    version: int,
    snapshot_name: str,
    content_token: str,
    source_stat: os.stat_result,
    data: bytes,
) -> dict[str, object]:
    # Store only relative, versioned snapshot identity so a relocated workspace
    # root keeps resolving its own history.
    return {
        "format": 2,
        "path": paths.relative_path,
        "file_hash": paths.file_hash,
        "latest_version": version,
        "last_snapshot": {
            "version": version,
            "snapshot_name": snapshot_name,
            "content_token": content_token,
            "source_mtime_ns": source_stat.st_mtime_ns,
            "source_size": source_stat.st_size,
            "byte_size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "created_at": datetime.now(UTC).isoformat(),
        },
    }


def _load_metadata(store: GuardedWorkspaceStore, ref: StoreRef) -> dict[str, Any]:
    try:
        raw = store.read_bytes(ref, max_bytes=1024 * 1024, missing_ok=True)
    except ToolExecutionFailure as error:
        if error.code != CMP_TOOL_CAP_EXCEEDED:
            raise
        log_event(
            logger,
            logging.WARNING,
            component="ai.tools.file_history",
            event="ai.tools.file_history.metadata_ignored",
            message="Ignored oversized checkpoint metadata",
            status="degraded",
            data={"reason": "oversized"},
        )
        return {}
    if raw is None:
        return {}
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _snapshot_ref_from_metadata(
    store: GuardedWorkspaceStore,
    last_snapshot: dict[str, Any],
) -> StoreRef | None:
    snapshot_name = last_snapshot.get("snapshot_name")
    if isinstance(snapshot_name, str) and snapshot_name:
        try:
            return store.resolve(WorkspaceStoreKind.BACKUPS, snapshot_name)
        except ToolExecutionFailure:
            return None
    # Format-1 compatibility: derive from the persisted display path.
    display_path = last_snapshot.get("display_path")
    if isinstance(display_path, str):
        return _backup_ref_from_display_path(store, display_path)
    return None


def _should_skip_checkpoint(
    store: GuardedWorkspaceStore,
    metadata: dict[str, Any],
    content_token: str,
) -> bool:
    last_snapshot = metadata.get("last_snapshot")
    if not isinstance(last_snapshot, dict):
        return False
    recorded_token = last_snapshot.get("content_token")
    if not isinstance(recorded_token, str) or recorded_token != content_token:
        # Includes format-1 metadata (no token): dedupe by CONTENT identity
        # only — mtime/size can lie (same-size timestamp-preserving edits).
        return False
    recorded_size = last_snapshot.get("byte_size")
    recorded_sha256 = last_snapshot.get("sha256")
    if type(recorded_size) is not int or not isinstance(recorded_sha256, str):
        return False
    snapshot_ref = _snapshot_ref_from_metadata(store, last_snapshot)
    if snapshot_ref is None:
        return False
    try:
        snapshot = store.read(
            snapshot_ref,
            max_bytes=MAX_CHECKPOINT_SOURCE_BYTES,
            missing_ok=True,
        )
    except ToolExecutionFailure:
        return False
    return (
        snapshot is not None
        and len(snapshot.data) == recorded_size
        and hashlib.sha256(snapshot.data).hexdigest() == recorded_sha256
    )


def _next_checkpoint_version(
    store: GuardedWorkspaceStore,
    paths: CheckpointPaths,
    metadata: dict[str, Any],
) -> int:
    latest_version = metadata.get("latest_version")
    highest = (
        latest_version
        if type(latest_version) is int and 0 <= latest_version <= MAX_CHECKPOINT_VERSION
        else 0
    )
    for candidate in store.list_entries(store.resolve(WorkspaceStoreKind.BACKUPS)):
        if not candidate.name.startswith(f"{paths.file_hash}@v") or not candidate.name.endswith(
            ".bak"
        ):
            continue
        version = _parse_snapshot_version(candidate.name)
        highest = max(highest, version)
    next_version = highest + 1
    while store.exists(
        store.resolve(
            WorkspaceStoreKind.BACKUPS,
            f"{paths.file_hash}@v{next_version}.bak",
        )
    ):
        next_version += 1
    return next_version


def _parse_snapshot_version(candidate_name: str) -> int:
    stem = Path(candidate_name).stem
    marker = "@v"
    if marker not in stem:
        return 0
    version_text = stem.rsplit(marker, 1)[-1]
    if not version_text.isdigit():
        return 0
    version = int(version_text)
    return version if version <= MAX_CHECKPOINT_VERSION else 0


# ── retention (count + age + bytes) and metadata reconcile ──────────────────


def apply_backup_retention_best_effort(
    workspace_root: Path,
    *,
    is_object_pinned: Callable[[str], bool] | None = None,
    active_use_age_source: ActiveUseAgeSource | None = None,
) -> None:
    """Apply retention after a journal has pinned a prepared batch's snapshots."""
    try:
        _apply_backup_retention(
            GuardedWorkspaceStore(workspace_root),
            is_object_pinned=is_object_pinned,
            active_use_age_source=active_use_age_source,
        )
    except ToolExecutionFailure as error:
        _log_evict_failed("batch-retention", type(error).__name__)


def _apply_backup_retention(
    store: GuardedWorkspaceStore,
    *,
    now_ns: int | None = None,
    active_file_hash: str | None = None,
    is_object_pinned: Callable[[str], bool] | None = None,
    active_use_age_source: ActiveUseAgeSource | None = None,
) -> None:
    """Evict under hard pressure, preferring oldest active-age-eligible snapshots.

    Quotas are read from module constants at call time (test-injectable), the
    clock is injectable, and every eviction is best-effort. Evicted snapshot
    names are reconciled against their metadata so no ``last_snapshot`` keeps
    pointing at a snapshot that no longer exists.

    ``now_ns`` remains injectable for compatibility and ordering tests, but it
    never makes a snapshot eligible. Eligibility comes from the persisted
    active-use source and controls priority; hard quotas remain unconditional.
    """
    del now_ns
    source = active_use_age_source or _default_active_use_source(store)
    snapshots = sorted(
        (
            candidate
            for candidate in store.list_entries(
                store.resolve(WorkspaceStoreKind.BACKUPS),
                max_entries=MAX_STORE_LIST_ENTRIES,
            )
            if "@v" in candidate.name and candidate.name.endswith(".bak")
        ),
        key=lambda candidate: (candidate.mtime_ns, candidate.name),
    )
    total_bytes = sum(entry.size_bytes for entry in snapshots)
    evicted: list[str] = []
    # The NEWEST snapshot is never evicted: it is the one safety net a write
    # that just happened relies on, even when a quota is still exceeded.
    candidates = [
        (entry, source.is_age_eligible(entry.name, entry.mtime_ns))
        for entry in snapshots[:-1]
    ]
    candidates.sort(key=lambda item: not item[1])
    for entry, _eligible in candidates:
        over_count = len(snapshots) - len(evicted) > MAX_BACKUP_SNAPSHOTS
        over_bytes = total_bytes > MAX_BACKUP_TOTAL_BYTES
        if not (over_count or over_bytes):
            break
        if is_object_pinned is not None and is_object_pinned(f"backup:{entry.name}"):
            continue
        try:
            outcome = store.delete(entry.ref, recursive=False)
        except ToolExecutionFailure as error:
            _log_evict_failed(entry.name, type(error).__name__)
            continue
        if not outcome.removed:
            _log_evict_failed(entry.name, "delete_degraded")
            continue
        total_bytes -= entry.size_bytes
        evicted.append(entry.name)
    flush = getattr(source, "flush", None)
    if callable(flush):
        flush()
    if evicted:
        _reconcile_metadata_after_eviction(
            store, evicted, active_file_hash=active_file_hash
        )


def _default_active_use_source(store: GuardedWorkspaceStore) -> ActiveUseAgeSource:
    from sidecar.ai.tools.workspace_retention import active_use_age_source  # noqa: PLC0415

    return active_use_age_source(store, "backup")


def _reconcile_metadata_after_eviction(
    store: GuardedWorkspaceStore,
    evicted_names: list[str],
    *,
    active_file_hash: str | None,
) -> None:
    for file_hash in sorted({name.split("@v", 1)[0] for name in evicted_names}):
        try:
            metadata_ref = store.resolve(WorkspaceStoreKind.BACKUPS, f"{file_hash}.json")
        except ToolExecutionFailure:
            continue
        if file_hash == active_file_hash:
            # Our own lock is already held (re-entrant); reconcile directly.
            _trim_orphaned_last_snapshot(store, metadata_ref)
            continue
        # Another file's metadata: take ITS lock (short timeout, skip on
        # contention — the next eviction pass retries) so a concurrent
        # checkpoint of that file is never clobbered.
        paths = CheckpointPaths(
            relative_path="",
            file_hash=file_hash,
            metadata_ref=metadata_ref,
            lock_ref=store.resolve(WorkspaceStoreKind.BACKUPS, f"{file_hash}.lock"),
        )
        try:
            with _reentrant_checkpoint_lock(
                store, paths, timeout_seconds=_RECONCILE_LOCK_TIMEOUT_SECONDS
            ):
                _trim_orphaned_last_snapshot(store, metadata_ref)
        except ToolExecutionFailure:
            continue


def _trim_orphaned_last_snapshot(
    store: GuardedWorkspaceStore,
    metadata_ref: StoreRef,
) -> None:
    metadata = _load_metadata(store, metadata_ref)
    last_snapshot = metadata.get("last_snapshot")
    if not isinstance(last_snapshot, dict):
        return
    snapshot_ref = _snapshot_ref_from_metadata(store, last_snapshot)
    if snapshot_ref is not None and store.exists(snapshot_ref):
        return
    metadata.pop("last_snapshot", None)
    metadata["format"] = 2
    store.write_json_atomic(metadata_ref, metadata)


def _log_evict_failed(name: str, error_type: str) -> None:
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.file_history",
        event="ai.tools.file_history.evict_failed",
        message=f"Failed to evict old checkpoint: {name}",
        status="failure",
        data={"path": name, "error_type": error_type},
    )


def _backup_ref_from_display_path(
    store: GuardedWorkspaceStore,
    display_path: str,
) -> StoreRef | None:
    normalized = display_path.replace("\\", "/")
    prefix = f"{BACKUP_ROOT.as_posix()}/"
    if not normalized.startswith(prefix):
        return None
    suffix = normalized[len(prefix) :]
    try:
        return store.resolve(WorkspaceStoreKind.BACKUPS, suffix)
    except ToolExecutionFailure:
        return None


def _workspace_relative_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()
