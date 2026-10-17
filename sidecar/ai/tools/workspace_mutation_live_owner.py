"""Process-held OS ownership for live logical-turn mutation journals.

The inference process owns these locks, independently of MCP generations and
approval run objects. Recovery must acquire the same lock before classifying an
abandoned journal. No PID, timestamp or stale lock-file inference is used.
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING, Any, Iterator

from filelock import FileLock, Timeout

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_mutation_journal_contract import _is_junction, workspace_identity

if TYPE_CHECKING:
    from sidecar.ai.tools.workspace_mutation_journal_store import (
        StoreResult,
        WorkspaceMutationJournalStore,
    )

logger = logging.getLogger(__name__)
MAX_LIVE_OWNERS = 1024


@dataclass
class _Owner:
    identity: tuple[str, str]
    lock: FileLock


_OWNERS: dict[str, _Owner] = {}
_MUTEX = RLock()


def _key(path: Path) -> str:
    return os.path.normcase(str(path.absolute()))


def _new_lock(path: Path) -> FileLock:
    # The store validates IDs and its root; validate the extra lock boundary too.
    for parent in (path.parent.parent.parent, path.parent.parent, path.parent):
        if parent.is_symlink() or _is_junction(parent):
            raise ValueError("mutation live owner path contains an unsafe link")
        if parent.exists() and not parent.is_dir():
            raise ValueError("mutation live owner directory is invalid")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or _is_junction(path):
        raise ValueError("mutation live owner lock contains an unsafe link")
    # Resumed/cancelled turns can settle on another request thread.
    return FileLock(str(path), timeout=0, thread_local=False)


def acquire_live_owner(path: Path, *, session_id: str, turn_id: str, timeout: float = 0) -> None:
    """Acquire before publication; repeated calls by this logical turn are inert."""
    identity = (session_id, turn_id)
    with _MUTEX:
        owner = _OWNERS.get(_key(path))
        if owner is not None:
            if owner.identity != identity:
                raise ValueError("mutation change set belongs to another live turn")
            return
        if len(_OWNERS) >= MAX_LIVE_OWNERS:
            raise ValueError("mutation live owner capacity reached")
        lock = _new_lock(path)
        lock.acquire(timeout=timeout)
        _OWNERS[_key(path)] = _Owner(identity, lock)
        logger.debug("workspace_mutation_live_owner_acquired", extra={"live_owners": len(_OWNERS)})


def release_live_owner(path: Path, *, session_id: str, turn_id: str) -> None:
    """Release when a live run ends or a checkpoint handoff is confirmed."""
    with _MUTEX:
        owner = _OWNERS.get(_key(path))
        if owner is None:
            return
        if owner.identity != (session_id, turn_id):
            raise ValueError("mutation live owner release scope changed")
        owner.lock.release()
        del _OWNERS[_key(path)]
        logger.debug("workspace_mutation_live_owner_released", extra={"live_owners": len(_OWNERS)})


def held_owner_path(version_root: Path, change_set_id: str, *,
                    session_id: str, turn_id: str) -> Path | None:
    """Find a held lease by its complete trusted scope, without filesystem reads."""
    with _MUTEX:
        matches = [Path(owner.lock.lock_file) for owner in _OWNERS.values()
            if owner.identity == (session_id, turn_id)
            and Path(owner.lock.lock_file).name == f"{change_set_id}.live.lock"
            and _key(Path(owner.lock.lock_file).parent.parent.parent) == _key(version_root)]
        if len(matches) > 1:
            raise ValueError("mutation live owner scope is ambiguous")
        return matches[0] if matches else None


@contextmanager
def recovery_ownership(path: Path) -> Iterator[bool]:
    """Hold the OS lock through recovery, skipping busy or uncertain ownership."""
    lock = None
    try:
        lock = _new_lock(path)
        lock.acquire(timeout=0)
    except (Timeout, OSError, ValueError) as error:
        logger.debug("workspace_mutation_recovery_ownership_unavailable",
                     extra={"reason": type(error).__name__})
        yield False
        return
    try:
        yield True
    finally:
        lock.release()


def run_journal_owner(run: Any) -> tuple[WorkspaceMutationJournalStore, str] | None:
    from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore

    kernel = getattr(run, "kernel", None) or getattr(run, "_jenny_mutation_kernel", None)
    config = getattr(kernel, "_config", None)
    state_root = str(getattr(config, "electron_state_root", "") or "").strip()
    execution_context = getattr(getattr(run, "request_context", None), "execution_context", None)
    workspace_root = str(
        (
            getattr(execution_context, "root_path", None)
            if execution_context is not None
            else getattr(config, "tools_workspace_root", "")
        )
        or ""
    ).strip()
    if not state_root or not workspace_root:
        return None
    return (
        WorkspaceMutationJournalStore.from_version_root(
            Path(state_root) / "workspace-recovery" / "v1"
        ),
        workspace_root,
    )


def acquire_run_owner(run: Any, change_set_id: str, session_id: str, turn_id: str) -> None:
    owner = run_journal_owner(run)
    if owner is None:
        return
    store, workspace_root = owner
    identity = workspace_identity(workspace_root)
    try:
        acquire_live_owner(
            store.live_owner_path(identity.workspace_id, change_set_id),
            session_id=session_id,
            turn_id=turn_id,
        )
    except (Timeout, OSError, ValueError) as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            retryable=False,
            message=(
                "Live mutation ownership could not be established; "
                "verify prior results and start a new turn."
            ),
            error_details={"failure_class": "conflict", "effects": "none"},
        ) from error


def mutation_ownership_conflict(
    message: str, *, details: dict[str, str] | None = None,
) -> ToolExecutionFailure:
    """Reject invalid preparation before any workspace mutation or journal append."""
    return ToolExecutionFailure(
        code=CMP_TOOL_IO_FAILED,
        message=message,
        retryable=False,
        error_details={"failure_class": "conflict", "effects": "none", **(details or {})},
    )


def reconcile_abandoned_journal(
    store: WorkspaceMutationJournalStore,
    workspace_root: Path,
    workspace_id: str,
    change_set_id: str,
    fingerprint: str,
) -> StoreResult | None:
    """Called under journal transition locks; classify only proven abandonment."""
    from sidecar.ai.tools import workspace_mutation_checkpoint as checkpoints
    from sidecar.ai.tools.workspace_mutation_journal_store import (
        _identity_failure,
        _record_matches_identity,
    )

    with recovery_ownership(store.live_owner_path(workspace_id, change_set_id)) as abandoned:
        if not abandoned:
            return None
        loaded = store.load(workspace_id, change_set_id)
        if not loaded.ok or loaded.record is None:
            return loaded
        if loaded.record["state"] not in {"prepared", "in_progress"}:
            return None
        if not _record_matches_identity(loaded.record, fingerprint):
            return _identity_failure()
        if checkpoints.has_runtime_checkpoint(loaded.record, allow_preparing=True):
            return loaded
        reconciled = store._reconcile_record(loaded.record, workspace_root)
        return store._write_mapping_locked(reconciled, workspace_root)


@contextmanager
def owned_mutation_attribution(
    store: WorkspaceMutationJournalStore, workspace_root: Path, *,
    change_set_id: str, session_id: str, turn_id: str,
) -> Iterator[dict[str, str]]:
    """Keep an explicitly authorized synchronous writer owned through settlement."""
    identity = workspace_identity(workspace_root)
    path = store.live_owner_path(identity.workspace_id, change_set_id)
    acquire_live_owner(path, session_id=session_id, turn_id=turn_id)
    try:
        yield {"_jenny_session_id": session_id, "_jenny_turn_id": turn_id,
               "_jenny_change_set_id": change_set_id}
    finally:
        release_live_owner(path, session_id=session_id, turn_id=turn_id)
