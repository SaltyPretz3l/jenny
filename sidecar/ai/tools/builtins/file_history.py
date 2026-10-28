"""Workspace-local checkpoint helpers for destructive filesystem tools.

Checkpoints self-lock through a per-thread reentrant registry. Dedupe uses
content identity, metadata stores relative versioned snapshot names, and
retention enforces count and byte quotas (active-use age only orders
eviction) with metadata reconciliation and orphaned metadata/lock cleanup.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import stat as stat_module
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.trash_maintenance import ActiveUseAgeSource
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_store import (
    MAX_STORE_LIST_ENTRIES,
    GuardedWorkspaceStore,
    StoreEntry,
    StoreRead,
    StoreRef,
    WorkspaceStoreKind,
)
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

BACKUP_ROOT = Path(".jenny") / "backups"
BACKUP_HASH_LENGTH = 16
CONTENT_TOKEN_HASH_LENGTH = 32
MAX_BACKUP_SNAPSHOTS = 100
MAX_BACKUP_TOTAL_BYTES = 256 * 1024 * 1024
MAX_CHECKPOINT_VERSION = 1_000_000_000
MAX_CHECKPOINT_SOURCE_BYTES = 64 * 1024 * 1024
CHECKPOINT_LOCK_TIMEOUT_SECONDS = 15.0
_RECONCILE_LOCK_TIMEOUT_SECONDS = 2.0
# A lock file touched this recently may belong to a checkpoint that is about
# to write its first snapshot; the orphan sweep leaves it for a later pass.
ORPHAN_LOCK_MIN_AGE_NS = 60 * 1_000_000_000
_MAX_STALE_METADATA_PER_PASS = 32

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


@dataclass(frozen=True)
class _ContentDigest:
    """One sha256 pass over checkpoint content, shared by every consumer."""

    byte_size: int
    sha256: str

    @classmethod
    def of(cls, data: bytes) -> _ContentDigest:
        return cls(byte_size=len(data), sha256=hashlib.sha256(data).hexdigest())

    @property
    def content_token(self) -> str:
        return f"{self.byte_size}:{self.sha256[:CONTENT_TOKEN_HASH_LENGTH]}"


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


def plan_checkpoint(
    target_path: Path,
    workspace_root: Path,
    *,
    data: bytes | None = None,
) -> CheckpointInfo:
    """Resolve the exact recovery object without creating it.

    ``data`` lets a caller that already holds the file's current bytes (for
    example ``existing_state.raw_bytes``) skip a second read. It only shapes
    the plan: ``materialize_checkpoint_plan`` re-reads the file and refuses
    when the on-disk content no longer matches the planned identity.
    """
    if not target_path.exists():
        return CheckpointInfo(created=False)
    store = GuardedWorkspaceStore(workspace_root)
    paths = checkpoint_paths_for(target_path, workspace_root)
    with _reentrant_checkpoint_lock(
        store, paths, timeout_seconds=CHECKPOINT_LOCK_TIMEOUT_SECONDS
    ):
        if data is None or len(data) > MAX_CHECKPOINT_SOURCE_BYTES:
            data = _read_checkpoint_source(store, target_path).data
        metadata = _load_metadata(store, paths.metadata_ref)
        digest = _ContentDigest.of(data)
        if _should_skip_checkpoint(store, metadata, digest.content_token):
            last_snapshot = metadata["last_snapshot"]
            return _checkpoint_info(
                snapshot_name=str(last_snapshot["snapshot_name"]),
                version=int(last_snapshot["version"]),
                digest=digest,
                created=False,
            )
        version = _next_checkpoint_version(store, paths, metadata)
        return _checkpoint_info(
            snapshot_name=f"{paths.file_hash}@v{version}.bak",
            version=version,
            digest=digest,
            created=True,
        )


def _read_checkpoint_source(store: GuardedWorkspaceStore, target_path: Path) -> StoreRead:
    try:
        return store.read_workspace_source(target_path, max_bytes=MAX_CHECKPOINT_SOURCE_BYTES)
    except ToolExecutionFailure as error:
        raise ToolExecutionFailure(
            code=error.code,
            message=f"failed to read file before checkpoint: {error.message}",
            retryable=error.retryable,
        ) from error


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
        # Always the on-disk bytes: the snapshot must be what the file holds.
        source = _read_checkpoint_source(store, target_path)
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
    digest = _ContentDigest.of(data)
    if _should_skip_checkpoint(store, metadata, digest.content_token):
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
            digest=digest,
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
        source_stat=source_stat,
        digest=digest,
    )
    store.write_json_atomic(paths.metadata_ref, payload)
    if apply_retention:
        # Best-effort: the snapshot and its metadata are already durable, so
        # a retention failure (for example an over-cap listing) must never
        # turn this checkpoint, and the write it protects, into a failure.
        try:
            _apply_backup_retention(
                store,
                active_file_hash=paths.file_hash,
                is_object_pinned=is_object_pinned,
            )
        except ToolExecutionFailure as error:
            _log_evict_failed("checkpoint-retention", type(error).__name__)
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
        digest=digest,
        created=True,
    )


def _checkpoint_info(
    *, snapshot_name: str, version: int, digest: _ContentDigest, created: bool
) -> CheckpointInfo:
    relative_path = f"{BACKUP_ROOT.as_posix()}/{snapshot_name}"
    return CheckpointInfo(
        created=created,
        version=version,
        display_path=relative_path,
        object_id=f"backup:{snapshot_name}",
        workspace_relative_path=relative_path,
        byte_size=digest.byte_size,
        sha256=digest.sha256,
    )


# ── metadata ─────────────────────────────────────────────────────────────────


def _checkpoint_payload(
    *,
    paths: CheckpointPaths,
    version: int,
    snapshot_name: str,
    source_stat: os.stat_result,
    digest: _ContentDigest,
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
            "content_token": digest.content_token,
            "source_mtime_ns": source_stat.st_mtime_ns,
            "source_size": source_stat.st_size,
            "byte_size": digest.byte_size,
            "sha256": digest.sha256,
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
    if type(latest_version) is int and 0 <= latest_version <= MAX_CHECKPOINT_VERSION:
        # Trusted metadata: no directory listing on the hot path. The exists
        # loop below still steps past a snapshot whose metadata write was lost.
        highest = latest_version
    else:
        highest = _highest_listed_version(store, paths.file_hash)
    next_version = highest + 1
    while store.exists(
        store.resolve(
            WorkspaceStoreKind.BACKUPS,
            f"{paths.file_hash}@v{next_version}.bak",
        )
    ):
        next_version += 1
    return next_version


def _highest_listed_version(store: GuardedWorkspaceStore, file_hash: str) -> int:
    """Highest snapshot version on disk, for missing or corrupt metadata."""
    try:
        candidates = store.list_entries(store.resolve(WorkspaceStoreKind.BACKUPS))
    except ToolExecutionFailure as error:
        if error.code != CMP_TOOL_CAP_EXCEEDED:
            raise
        return 0  # Over-cap directory: the caller's exists loop still finds a free name.
    prefix = f"{file_hash}@v"
    return max(
        (
            _parse_snapshot_version(candidate.name)
            for candidate in candidates
            if candidate.name.startswith(prefix) and candidate.name.endswith(".bak")
        ),
        default=0,
    )


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


# ── retention (count + bytes) and metadata reconcile ─────────────────────────


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
    active_file_hash: str | None = None,
    is_object_pinned: Callable[[str], bool] | None = None,
    active_use_age_source: ActiveUseAgeSource | None = None,
) -> None:
    """Evict under hard pressure, preferring oldest active-age-eligible snapshots.

    Quotas are read from module constants at call time (test-injectable) and
    every eviction is best-effort. Evicted snapshot names are reconciled
    against their metadata so no ``last_snapshot`` keeps pointing at a
    snapshot that no longer exists; a file with no snapshot left loses its
    metadata, and lock files with neither metadata nor a snapshot are swept,
    so the backups directory stays bounded by the snapshot quota.

    Wall-clock age never makes a snapshot eligible. Eligibility comes from the
    persisted active-use source and controls priority; the count and byte
    quotas remain unconditional.
    """
    source = active_use_age_source or _default_active_use_source(store)
    listing = store.list_entries(
        store.resolve(WorkspaceStoreKind.BACKUPS),
        max_entries=MAX_STORE_LIST_ENTRIES,
    )
    snapshots = sorted(
        (
            candidate
            for candidate in listing
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
    evicted_set = set(evicted)
    snapshot_hashes = {
        _snapshot_file_hash(entry.name) for entry in snapshots if entry.name not in evicted_set
    }
    evicted_hashes = {_snapshot_file_hash(name) for name in evicted}
    metadata_hashes = {
        entry.name[: -len(".json")] for entry in listing if entry.name.endswith(".json")
    }
    # Metadata left without any snapshot by an earlier pass is cleaned a
    # bounded batch at a time so one write never pays for a large backlog.
    stale_metadata = sorted(metadata_hashes - snapshot_hashes - evicted_hashes)[
        :_MAX_STALE_METADATA_PER_PASS
    ]
    deleted_metadata = _reconcile_metadata_after_eviction(
        store,
        sorted(evicted_hashes | set(stale_metadata)),
        active_file_hash=active_file_hash,
        snapshot_hashes=snapshot_hashes,
    )
    _sweep_orphaned_locks(
        store,
        listing,
        live_hashes=snapshot_hashes | (metadata_hashes - deleted_metadata),
        just_released=deleted_metadata,
    )


def _snapshot_file_hash(snapshot_name: str) -> str:
    return snapshot_name.split("@v", 1)[0]


def _default_active_use_source(store: GuardedWorkspaceStore) -> ActiveUseAgeSource:
    from sidecar.ai.tools.workspace_retention import active_use_age_source

    return active_use_age_source(store, "backup")


def _reconcile_metadata_after_eviction(
    store: GuardedWorkspaceStore,
    file_hashes: list[str],
    *,
    active_file_hash: str | None,
    snapshot_hashes: set[str],
) -> set[str]:
    """Trim or delete metadata for the given files; return hashes whose metadata went."""
    deleted: set[str] = set()
    for file_hash in file_hashes:
        try:
            metadata_ref = store.resolve(WorkspaceStoreKind.BACKUPS, f"{file_hash}.json")
        except ToolExecutionFailure:
            continue
        has_snapshots = file_hash in snapshot_hashes
        if file_hash == active_file_hash:
            # Our own lock is already held (re-entrant); reconcile directly.
            if _trim_orphaned_last_snapshot(
                store, metadata_ref, has_remaining_snapshots=has_snapshots
            ):
                deleted.add(file_hash)
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
                if _trim_orphaned_last_snapshot(
                    store, metadata_ref, has_remaining_snapshots=has_snapshots
                ):
                    deleted.add(file_hash)
        except ToolExecutionFailure:
            continue
    return deleted


def _trim_orphaned_last_snapshot(
    store: GuardedWorkspaceStore,
    metadata_ref: StoreRef,
    *,
    has_remaining_snapshots: bool = True,
) -> bool:
    """Drop a dangling ``last_snapshot``; return True when the metadata was deleted.

    Runs under the file's checkpoint lock. A ``last_snapshot`` that still
    exists means a checkpoint landed after the retention listing, so the
    metadata stays. With no snapshot of the file left, the metadata only
    carries a version counter and is deleted so ``.jenny/backups`` does not
    grow one file per path ever edited.
    """
    metadata = _load_metadata(store, metadata_ref)
    last_snapshot = metadata.get("last_snapshot")
    if isinstance(last_snapshot, dict):
        snapshot_ref = _snapshot_ref_from_metadata(store, last_snapshot)
        if snapshot_ref is not None and store.exists(snapshot_ref):
            return False
    if not has_remaining_snapshots:
        try:
            return store.delete(metadata_ref, recursive=False).removed
        except ToolExecutionFailure as error:
            _log_evict_failed(metadata_ref.parts[-1], type(error).__name__)
            return False
    if not isinstance(last_snapshot, dict):
        return False
    metadata.pop("last_snapshot", None)
    metadata["format"] = 2
    store.write_json_atomic(metadata_ref, metadata)
    return False


def _sweep_orphaned_locks(
    store: GuardedWorkspaceStore,
    listing: Iterable[StoreEntry],
    *,
    live_hashes: set[str],
    just_released: set[str],
) -> None:
    """Best-effort removal of lock files whose hash has no metadata or snapshot.

    ``just_released`` hashes had their metadata deleted under their own lock
    in this pass, so the recent-use age guard (which taking that lock may
    have refreshed) does not apply to them.
    """
    now_ns = time.time_ns()
    held = _held_lock_keys()
    for entry in listing:
        file_hash, dot, suffix = entry.name.partition(".")
        if (
            suffix != "lock"
            or not dot
            or len(file_hash) != BACKUP_HASH_LENGTH
            or any(char not in "0123456789abcdef" for char in file_hash)
            or file_hash in live_hashes
            or (store.cache_key, file_hash) in held
        ):
            continue
        if file_hash not in just_released and now_ns - entry.mtime_ns < ORPHAN_LOCK_MIN_AGE_NS:
            continue
        _delete_orphaned_lock(store, file_hash, entry.ref)


def _delete_orphaned_lock(store: GuardedWorkspaceStore, file_hash: str, lock_ref: StoreRef) -> None:
    try:
        paths = CheckpointPaths(
            relative_path="",
            file_hash=file_hash,
            metadata_ref=store.resolve(WorkspaceStoreKind.BACKUPS, f"{file_hash}.json"),
            lock_ref=lock_ref,
        )
        if os.name == "nt":
            # Windows refuses to rename a file another handle holds open, so
            # an unlocked delete can never pull a held lock from its owner.
            if not store.exists(paths.metadata_ref):
                store.delete(lock_ref, recursive=False)
            return
        # POSIX unlinks a held file freely: take the lock first (no wait). A
        # waiter that later wins the unlinked inode fails file_lock's identity
        # revalidation instead of sharing the critical section.
        with _reentrant_checkpoint_lock(store, paths, timeout_seconds=0.0):
            if not store.exists(paths.metadata_ref):
                store.delete(lock_ref, recursive=False)
    except ToolExecutionFailure:
        return


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
