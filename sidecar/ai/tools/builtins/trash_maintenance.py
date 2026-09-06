"""Retention and maintenance primitives for the ``.jenny/trash`` store.

* ``apply_trash_retention`` enforces count + age + aggregate-byte quotas,
  evicting the OLDEST entries first and never the newest one (the entry a
  delete that just happened relies on). Quotas are module constants read at
  call time (test-injectable) and the clock is injectable.
* ``list_trash_entries`` / ``purge_trash_entry`` / ``purge_trash`` are the
  tool-level primitives (no UI): enumerate the timestamped entries newest
  first with bounded recursive sizes, delete one by name, or empty the trash.

Everything goes through :class:`GuardedWorkspaceStore` — no raw path writes.
Entry age comes from the entry's ``%Y%m%dT%H%M%S_%f`` stamp (the name
``delete_file`` assigns), falling back to filesystem mtime for foreign names.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Callable, Protocol

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_store import (
    MAX_STORE_LIST_ENTRIES,
    GuardedWorkspaceStore,
    StoreRef,
    WorkspaceStoreKind,
)
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

MAX_TRASH_ENTRIES = 200
MAX_TRASH_AGE_DAYS = 30
MAX_TRASH_TOTAL_BYTES = 512 * 1024 * 1024
# Bounded recursive-size walk: enough for any sane trash entry, small enough
# that a pathological tree cannot stall a delete.
MAX_SIZE_WALK_ENTRIES = 5_000

_STAMP_FORMAT = "%Y%m%dT%H%M%S_%f"


@dataclass(frozen=True)
class TrashEntry:
    ref: StoreRef
    name: str
    created_at_ns: int
    size_bytes: int
    is_directory: bool


@dataclass(frozen=True)
class TrashRetentionOutcome:
    evicted_names: tuple[str, ...]
    remaining_entries: int


class ActiveUseAgeSource(Protocol):
    """WO-26 seam: active-use (not wall-clock) age eligibility for one entry.

    Structural (no import of ``sidecar.ai.tools.workspace_retention`` here --
    that module imports this one) so a caller can plug in the active-use
    clock without this file knowing anything about the journal or Electron's
    cumulative counter.
    """

    def is_age_eligible(self, entry_name: str, created_at_ns: int) -> bool: ...

def _created_at_ns(name: str, mtime_ns: int) -> int:
    try:
        stamped = datetime.strptime(name, _STAMP_FORMAT).replace(tzinfo=UTC)
    except ValueError:
        return mtime_ns
    return int(stamped.timestamp() * 1_000_000_000)


def _entry_total_bytes(store: GuardedWorkspaceStore, ref: StoreRef, *, is_directory: bool,
                       size_bytes: int) -> int:
    if not is_directory:
        return size_bytes
    total = 0
    seen = 0
    stack: list[StoreRef] = [ref]
    while stack:
        current = stack.pop()
        try:
            # quarantine_links=False: a trashed junction/symlink is a
            # legitimate resident here — count it as a leaf, never follow it,
            # and NEVER let a size walk quarantine (destroy) trashed content.
            children = store.list_entries(current, quarantine_links=False)
        except ToolExecutionFailure:
            continue
        for child in children:
            seen += 1
            if seen > MAX_SIZE_WALK_ENTRIES:
                log_event(
                    logger,
                    logging.WARNING,
                    component="ai.tools.trash_maintenance",
                    event="ai.tools.trash_maintenance.size_walk_bounded",
                    message="Trash entry size walk exceeded its entry bound",
                    status="degraded",
                    data={"max_entries": MAX_SIZE_WALK_ENTRIES},
                )
                return MAX_TRASH_TOTAL_BYTES + 1
            if child.is_directory:
                stack.append(child.ref)
            else:
                total += child.size_bytes
    return total


def list_trash_entries(
    store: GuardedWorkspaceStore,
    *,
    max_entries: int = MAX_STORE_LIST_ENTRIES,
) -> tuple[TrashEntry, ...]:
    """Enumerate top-level trash entries, NEWEST first, with recursive sizes."""
    trash_root = store.resolve(WorkspaceStoreKind.TRASH)
    entries: list[TrashEntry] = []
    for raw in store.list_entries(
        trash_root, max_entries=max_entries, quarantine_links=False
    ):
        entries.append(
            TrashEntry(
                ref=raw.ref,
                name=raw.name,
                created_at_ns=_created_at_ns(raw.name, raw.mtime_ns),
                size_bytes=_entry_total_bytes(
                    store, raw.ref, is_directory=raw.is_directory, size_bytes=raw.size_bytes
                ),
                is_directory=raw.is_directory,
            )
        )
    entries.sort(key=lambda entry: (entry.created_at_ns, entry.name), reverse=True)
    return tuple(entries)


def apply_trash_retention(
    store: GuardedWorkspaceStore,
    *,
    now_ns: int | None = None,
    is_entry_pinned: Callable[[str], bool] | None = None,
    active_use_age_source: ActiveUseAgeSource | None = None,
) -> TrashRetentionOutcome:
    """Evict under hard pressure, preferring oldest active-age-eligible entries.

    Best-effort: a failed eviction is logged and skipped. The NEWEST entry is
    never evicted — a delete that just happened must stay reversible even
    when a quota is still exceeded.

    ``now_ns`` remains injectable for compatibility and ordering tests, but it
    never makes an entry eligible. Eligibility comes from the persisted
    active-use source and controls priority; hard quotas remain unconditional.
    """
    del now_ns
    source = active_use_age_source or _default_active_use_source(store)
    entries = list(
        reversed(list_trash_entries(store, max_entries=MAX_STORE_LIST_ENTRIES))
    )
    total_bytes = sum(entry.size_bytes for entry in entries)
    evicted: list[str] = []
    candidates = [
        (entry, source.is_age_eligible(entry.name, entry.created_at_ns))
        for entry in entries[:-1]
    ]
    candidates.sort(key=lambda item: not item[1])
    for entry, _eligible in candidates:
        over_count = len(entries) - len(evicted) > MAX_TRASH_ENTRIES
        over_bytes = total_bytes > MAX_TRASH_TOTAL_BYTES
        if not (over_count or over_bytes):
            break
        if is_entry_pinned is not None and is_entry_pinned(entry.name):
            continue
        if not _delete_entry(store, entry.ref, entry.name):
            continue
        total_bytes -= entry.size_bytes
        evicted.append(entry.name)
    flush = getattr(source, "flush", None)
    if callable(flush):
        flush()
    if evicted:
        log_event(
            logger,
            logging.INFO,
            component="ai.tools.trash_maintenance",
            event="ai.tools.trash_maintenance.retention_applied",
            message=f"Evicted {len(evicted)} trash entr(y/ies) past retention quotas",
            status="success",
            data={"evicted": len(evicted), "remaining": len(entries) - len(evicted)},
        )
    return TrashRetentionOutcome(
        evicted_names=tuple(evicted),
        remaining_entries=len(entries) - len(evicted),
    )


def _default_active_use_source(store: GuardedWorkspaceStore) -> ActiveUseAgeSource:
    from sidecar.ai.tools.workspace_retention import active_use_age_source  # noqa: PLC0415

    return active_use_age_source(store, "trash")


def apply_trash_retention_best_effort(
    store: GuardedWorkspaceStore,
    *,
    is_entry_pinned: Callable[[str], bool] | None = None,
    active_use_age_source: ActiveUseAgeSource | None = None,
) -> None:
    """Retention that NEVER raises — for use right after a successful delete.

    A retention failure must never turn a successful reversible delete into
    a tool failure; it is logged and swallowed here so callers stay lean.
    """
    try:
        apply_trash_retention(
            store,
            is_entry_pinned=is_entry_pinned,
            active_use_age_source=active_use_age_source,
        )
    except ToolExecutionFailure as error:
        log_event(
            logger,
            logging.WARNING,
            component="ai.tools.trash_maintenance",
            event="ai.tools.trash_maintenance.retention_failed",
            message="Trash retention failed after a delete",
            status="degraded",
            data={"error_type": type(error).__name__},
        )


def purge_trash_entry(store: GuardedWorkspaceStore, name: str) -> bool:
    """Delete ONE top-level trash entry by its exact name. Returns removal."""
    try:
        ref = store.resolve(WorkspaceStoreKind.TRASH, name)
    except ToolExecutionFailure:
        return False
    if len(ref.parts) != 1:
        # A nested path is not a top-level entry; refuse quietly.
        return False
    return _delete_entry(store, ref, name)


def purge_trash(store: GuardedWorkspaceStore) -> int:
    """Delete EVERY top-level trash entry. Returns how many were removed."""
    removed = 0
    for entry in list_trash_entries(store):
        if _delete_entry(store, entry.ref, entry.name):
            removed += 1
    return removed


def _delete_entry(store: GuardedWorkspaceStore, ref: StoreRef, name: str) -> bool:
    try:
        outcome = store.delete(ref, recursive=True)
    except ToolExecutionFailure as error:
        _log_evict_failed(name, type(error).__name__)
        return False
    if not outcome.removed:
        _log_evict_failed(name, "delete_degraded")
        return False
    return True


def _log_evict_failed(name: str, error_type: str) -> None:
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.trash_maintenance",
        event="ai.tools.trash_maintenance.evict_failed",
        message=f"Failed to evict trash entry: {name}",
        status="failure",
        data={"path": name, "error_type": error_type},
    )


__all__ = [
    "MAX_TRASH_AGE_DAYS",
    "MAX_TRASH_ENTRIES",
    "MAX_TRASH_TOTAL_BYTES",
    "ActiveUseAgeSource",
    "TrashEntry",
    "TrashRetentionOutcome",
    "apply_trash_retention",
    "apply_trash_retention_best_effort",
    "list_trash_entries",
    "purge_trash",
    "purge_trash_entry",
]
