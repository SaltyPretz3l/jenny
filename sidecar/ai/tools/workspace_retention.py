"""Active-use retention and wall-review glue for workspace recovery.

Electron supplies the cumulative clock on ``chat.send``. This module persists
bounded baselines, exposes the review RPC operations, and runs synchronous
best-effort maintenance at startup and after commits. It never creates a timer.
"""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Mapping, cast

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import (
    ACTIVE_RETENTION_SECONDS,
    MAX_CHANGE_SETS_PER_WORKSPACE,
    WorkspaceMutationJournalStore,
)
from sidecar.ai.tools.workspace_store import (
    MAX_STORE_LIST_ENTRIES,
    GuardedWorkspaceStore,
    WorkspaceStoreKind,
)

logger = logging.getLogger(__name__)

RETENTION_ERROR_CODE = CMP_TOOL_EXECUTION_FAILED


class WorkspaceRetentionError(RuntimeError):
    """Bounded error shape consumed by the shared recovery RPC handler."""

    def __init__(
        self, reason: str, message: str, *, details: Mapping[str, object] | None = None
    ) -> None:
        super().__init__(message)
        self.code = RETENTION_ERROR_CODE
        self.reason = reason
        self.message = message
        self.details = dict(details or {})


# Bounded scan/ledger sizes mirror the store's change-set order of magnitude.
MAX_LEDGER_BASELINE_ENTRIES = 300
MAX_ACTIVE_USE_SECONDS = (1 << 53) - 1
MAX_TOUCHED_CHANGE_SETS = MAX_CHANGE_SETS_PER_WORKSPACE
_LEDGER_NAME = ".retention-active-use.json"
_LEDGER_MAX_BYTES = 512 * 1024
_OPEN_OR_RETAINED_STATES = frozenset(
    {"prepared", "in_progress", "committed", "interrupted", "rolled_back"}
)


# ── chat.send -> journal active-use accounting ──────────────────────────────


def touch_workspace_active_use(brain_container: Any, params: object) -> None:
    """Best-effort chat.send hook: advance active-use accounting for one turn.

    No-op whenever ``params`` is not a dict, the field is absent/negative, or
    the workspace/recovery roots are not configured -- this must never affect
    chat.send's own result. Safe to call once per chat.send request; calling
    it again with the same value is idempotent (the running counters are
    monotonic, see ``_advance_active_use``).
    """
    if not isinstance(params, dict):
        return
    raw_seconds = params.get("workspace_active_use_seconds")
    if type(raw_seconds) is not int or not 0 <= raw_seconds <= MAX_ACTIVE_USE_SECONDS:
        return
    config = getattr(getattr(brain_container, "stack", None), "config", None)
    workspace_root = str(getattr(config, "tools_workspace_root", "") or "").strip()
    state_root = str(getattr(config, "electron_state_root", "") or "").strip()
    if not workspace_root or not state_root:
        return
    try:
        guarded = GuardedWorkspaceStore(Path(workspace_root))
        _record_current_active_use(guarded, raw_seconds)
        store = WorkspaceMutationJournalStore(Path(state_root) / "workspace-recovery")
        record_active_use_seconds(store, workspace_root, raw_seconds, guarded=guarded)
    except Exception as error:  # noqa: BLE001 - accounting must never fail chat.send
        logger.warning(
            "workspace_retention_active_use_touch_failed",
            extra={"reason": type(error).__name__},
        )


def record_active_use_seconds(
    store: WorkspaceMutationJournalStore,
    workspace_root: str | Path,
    workspace_active_use_seconds: int,
    *,
    guarded: GuardedWorkspaceStore | None = None,
) -> tuple[str, ...]:
    """Advance retention active-use accounting for one workspace's change sets.

    Best-effort per set: a durable-write failure for one record is logged and
    skipped rather than raised, so one bad record cannot block the others.
    Returns the ids of change sets that were actually rewritten.
    """
    if (
        type(workspace_active_use_seconds) is not int
        or not 0 <= workspace_active_use_seconds <= MAX_ACTIVE_USE_SECONDS
    ):
        return ()
    try:
        identity = workspace_identity(workspace_root)
    except (OSError, ValueError):
        return ()
    workspace_store = guarded or GuardedWorkspaceStore(Path(workspace_root))
    ledger = _load_ledger(workspace_store)
    baselines = _bounded_mapping(ledger.get("journal_baselines"))
    touched: list[str] = []
    live_ids: set[str] = set()
    for change_set_id in _iter_change_set_ids(store, identity.workspace_id):
        loaded = store.load(identity.workspace_id, change_set_id)
        if not loaded.ok or loaded.record is None:
            continue
        record = loaded.record
        if record["state"] not in _OPEN_OR_RETAINED_STATES:
            continue
        live_ids.add(change_set_id)
        retention = cast(dict[str, Any], record["retention"])
        baseline = baselines.get(change_set_id)
        if baseline is None:
            recorded = retention.get("created_active_use_seconds")
            baseline = (
                recorded
                if type(recorded) is int and recorded > 0
                else workspace_active_use_seconds
            )
            if len(baselines) < MAX_LEDGER_BASELINE_ENTRIES:
                baselines[change_set_id] = baseline
        updated = _advance_active_use(record, baseline, workspace_active_use_seconds)
        if updated is None:
            continue
        result = store.write_transition(
            updated, workspace_root=workspace_root, retention_only=True
        )
        if result.ok:
            touched.append(change_set_id)
        else:
            logger.warning(
                "workspace_retention_active_use_write_failed",
                extra={"change_set_id": change_set_id},
            )
    ledger["journal_baselines"] = _prune_baselines(baselines, frozenset(live_ids))
    _save_ledger(workspace_store, ledger)
    return tuple(touched)


def _advance_active_use(
    record: Mapping[str, Any], baseline: int, seconds: int
) -> dict[str, Any] | None:
    retention = cast(dict[str, Any], record["retention"])
    created = cast(int, retention["created_active_use_seconds"])
    last = cast(int, retention["last_accessed_active_use_seconds"])
    if retention["active_age_seconds"] >= ACTIVE_RETENTION_SECONDS:
        return None
    new_created = baseline if created == 0 else created
    new_last = max(last, seconds, new_created)
    new_age = min(MAX_ACTIVE_USE_SECONDS, max(0, new_last - new_created))
    if (new_created, new_last, new_age) == (
        created,
        last,
        retention["active_age_seconds"],
    ):
        return None
    updated = copy.deepcopy(dict(record))
    updated_retention = cast(dict[str, Any], updated["retention"])
    updated_retention["created_active_use_seconds"] = new_created
    updated_retention["last_accessed_active_use_seconds"] = new_last
    updated_retention["active_age_seconds"] = new_age
    cast(dict[str, Any], updated["wall_time"])["updated_at"] = _utc_now()
    return updated


def _iter_change_set_ids(store: WorkspaceMutationJournalStore, workspace_id: str) -> list[str]:
    workspace_dir = store.version_root / workspace_id
    try:
        children = sorted(workspace_dir.iterdir(), key=lambda item: item.name)
    except OSError:
        return []
    ids: list[str] = []
    for child in children:
        if len(ids) >= MAX_TOUCHED_CHANGE_SETS:
            logger.warning(
                "workspace_retention_scan_bounded", extra={"workspace_id": workspace_id}
            )
            break
        if child.is_dir() and not child.is_symlink():
            ids.append(child.name)
    return ids


# ── wall-clock review RPCs ───────────────────────────────────────────────────


def list_recovery_review(
    store: WorkspaceMutationJournalStore,
    workspace_root: str | Path,
    *,
    now: datetime | None = None,
) -> dict[str, object]:
    """List change sets whose 365-day wall-clock review is due but unacknowledged.

    Never mutates. A set stays listed on every call until
    ``acknowledge_recovery_review`` durably records
    ``wall_clock_review_presented_at`` -- only then may a later maintenance
    pass age-evict it on the wall cap.
    """
    try:
        identity = workspace_identity(workspace_root)
    except (OSError, ValueError) as error:
        raise WorkspaceRetentionError(
            "workspace_identity_unavailable", "Workspace identity could not be verified."
        ) from error
    due: list[dict[str, object]] = []
    for change_set_id in _iter_change_set_ids(store, identity.workspace_id):
        loaded = store.load(identity.workspace_id, change_set_id)
        if not loaded.ok or loaded.record is None:
            continue
        record = loaded.record
        retention = cast(dict[str, Any], record["retention"])
        if not _wall_clock_review_due(retention, now or datetime.now(UTC)):
            continue
        due.append(_review_entry(record))
    due.sort(key=lambda item: str(item["wall_clock_review_due_at"]), reverse=True)
    return {"workspace_id": identity.workspace_id, "due_for_review": due}


def acknowledge_recovery_review(
    store: WorkspaceMutationJournalStore,
    workspace_root: str | Path,
    change_set_id: str,
    *,
    now: datetime | None = None,
) -> dict[str, object]:
    """Durably record that the UI presented one set's wall-clock review."""
    try:
        identity = workspace_identity(workspace_root)
    except (OSError, ValueError) as error:
        raise WorkspaceRetentionError(
            "workspace_identity_unavailable", "Workspace identity could not be verified."
        ) from error
    loaded = store.load(identity.workspace_id, change_set_id)
    if not loaded.ok or loaded.record is None:
        raise WorkspaceRetentionError(
            "change_set_not_found", "Workspace change set was not found."
        )
    record = copy.deepcopy(loaded.record)
    observed_at = now or datetime.now(UTC)
    retention = cast(dict[str, Any], record["retention"])
    if not _wall_clock_review_due(retention, observed_at):
        existing = retention["wall_clock_review_presented_at"]
        if existing is not None:
            return {
                "change_set_id": change_set_id,
                "wall_clock_review_presented_at": existing,
            }
        raise WorkspaceRetentionError(
            "recovery_review_not_due", "Workspace recovery review is not due."
        )
    presented_at = _format_utc(observed_at)
    retention["wall_clock_review_presented_at"] = presented_at
    cast(dict[str, Any], record["wall_time"])["updated_at"] = presented_at
    result = store.write_transition(
        record, workspace_root=workspace_root, retention_only=True
    )
    if not result.ok or result.record is None:
        raise WorkspaceRetentionError(
            "acknowledge_write_failed",
            "Workspace review acknowledgement could not be recorded.",
        )
    acknowledged_retention = cast(dict[str, Any], result.record["retention"])
    return {
        "change_set_id": change_set_id,
        "wall_clock_review_presented_at": acknowledged_retention["wall_clock_review_presented_at"],
    }


def _wall_clock_review_due(retention: Mapping[str, Any], now: datetime) -> bool:
    if retention["wall_clock_review_presented_at"] is not None:
        return False
    due_at_raw = retention.get("wall_clock_review_due_at")
    if not isinstance(due_at_raw, str):
        return False
    try:
        due_at = datetime.fromisoformat(due_at_raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    observed_at = now.replace(tzinfo=UTC) if now.tzinfo is None else now.astimezone(UTC)
    return observed_at >= due_at


def _review_entry(record: Mapping[str, Any]) -> dict[str, object]:
    retention = cast(dict[str, Any], record["retention"])
    return {
        "change_set_id": str(record["change_set_id"]),
        "state": str(record["state"]),
        "operation_count": int(record["operation_count"]),
        "wall_clock_review_due_at": retention["wall_clock_review_due_at"],
        "wall_clock_review_presented_at": retention["wall_clock_review_presented_at"],
        "protected": bool(retention["protected"]),
        "active_age_seconds": int(retention["active_age_seconds"]),
        "prepared_at": cast(dict[str, Any], record["wall_time"])["prepared_at"],
        "updated_at": cast(dict[str, Any], record["wall_time"])["updated_at"],
    }


# ── active-use age tracker for trash/backup retention ───────────────────────


@dataclass
class ActiveUseAgeTracker:
    """Persistent per-entry active-use age source for trash and backups.

    An existing entry's first observation establishes its non-retroactive
    baseline; eligibility thereafter uses only cumulative active seconds.
    """

    current_active_use_seconds: int
    baselines: dict[str, int] = field(default_factory=dict)
    known: bool = True
    threshold_seconds: int = ACTIVE_RETENTION_SECONDS
    save: Callable[[], None] | None = None
    dirty: bool = False

    def is_age_eligible(self, entry_name: str, created_at_ns: int) -> bool:
        del created_at_ns  # unused: age is driven by active seconds, never wall time
        if not self.known:
            return False
        baseline = self.baselines.get(entry_name)
        if baseline is None:
            if len(self.baselines) >= MAX_LEDGER_BASELINE_ENTRIES:
                logger.warning("workspace_retention_ledger_bounded")
                return False
            self.baselines[entry_name] = self.current_active_use_seconds
            self.dirty = True
            return False
        return self.current_active_use_seconds - baseline >= self.threshold_seconds

    def flush(self) -> None:
        if self.dirty and self.save is not None:
            self.save()
            self.dirty = False


def active_use_age_source(
    store: GuardedWorkspaceStore, kind: str
) -> ActiveUseAgeTracker:
    """Build a persistent active-use age source for trash or backups."""
    if kind not in {"trash", "backup"}:
        raise ValueError("active-use source kind must be trash or backup")
    ledger = _load_ledger(store)
    tracker = ActiveUseAgeTracker(
        current_active_use_seconds=_ledger_active_seconds(ledger),
        baselines=_bounded_mapping(ledger.get(f"{kind}_baselines")),
        known=ledger.get("active_use_known") is True,
    )

    def save() -> None:
        ledger[f"{kind}_baselines"] = dict(tracker.baselines)
        _save_ledger(store, ledger)

    tracker.save = save
    return tracker


# ── continuous maintenance (startup + on every journal commit) ─────────────


def run_recovery_maintenance(
    store: WorkspaceMutationJournalStore, workspace_root: str | Path
) -> None:
    """Run bounded best-effort journal/trash/backup maintenance synchronously."""
    root = Path(workspace_root)
    try:
        store.reconcile_workspace(root)
    except (OSError, ValueError) as error:
        logger.warning(
            "workspace_retention_maintenance_reconcile_failed",
            extra={"reason": type(error).__name__},
        )
    try:
        guarded = GuardedWorkspaceStore(root)
    except (OSError, ValueError, ToolExecutionFailure) as error:
        logger.warning(
            "workspace_retention_maintenance_store_unavailable",
            extra={"reason": type(error).__name__},
        )
        return
    ledger = _load_ledger(guarded)
    current_seconds = _ledger_active_seconds(ledger)
    if ledger.get("active_use_known") is True:
        record_active_use_seconds(store, root, current_seconds, guarded=guarded)
        ledger = _load_ledger(guarded)
    trash_tracker = _tracker_from_ledger(guarded, ledger, "trash")
    backup_tracker = _tracker_from_ledger(guarded, ledger, "backup")
    try:
        workspace_id = workspace_identity(root).workspace_id
        pinned_ids = store.pinned_recovery_object_ids(workspace_id)
    except (OSError, ValueError):
        pinned_ids = frozenset()
    from sidecar.ai.tools.builtins.file_history import (  # noqa: PLC0415 - avoid a module cycle
        apply_backup_retention_best_effort,
    )
    from sidecar.ai.tools.builtins.trash_maintenance import (  # noqa: PLC0415 - avoid a module cycle
        apply_trash_retention_best_effort,
    )

    apply_trash_retention_best_effort(
        guarded,
        is_entry_pinned=lambda name: _trash_entry_is_pinned(pinned_ids, name),
        active_use_age_source=trash_tracker,
    )
    apply_backup_retention_best_effort(
        root,
        is_object_pinned=pinned_ids.__contains__,
        active_use_age_source=backup_tracker,
    )
    ledger["current_active_use_seconds"] = current_seconds
    ledger["trash_baselines"] = _prune_baselines(
        trash_tracker.baselines, _live_trash_names(guarded)
    )
    ledger["backup_baselines"] = _prune_baselines(
        backup_tracker.baselines, _live_backup_names(guarded)
    )
    _save_ledger(guarded, ledger)


def _tracker_from_ledger(
    guarded: GuardedWorkspaceStore, ledger: dict[str, Any], kind: str
) -> ActiveUseAgeTracker:
    tracker = ActiveUseAgeTracker(
        current_active_use_seconds=_ledger_active_seconds(ledger),
        baselines=_bounded_mapping(ledger.get(f"{kind}_baselines")),
        known=ledger.get("active_use_known") is True,
    )

    def save() -> None:
        ledger[f"{kind}_baselines"] = dict(tracker.baselines)
        _save_ledger(guarded, ledger)

    tracker.save = save
    return tracker


def _trash_entry_is_pinned(pinned_ids: frozenset[str], entry_name: str) -> bool:
    prefix = f"trash:.jenny/trash/{entry_name}/"
    exact = f"trash:.jenny/trash/{entry_name}"
    return any(
        object_id == exact or object_id.startswith(prefix)
        for object_id in pinned_ids
    )


def _live_trash_names(guarded: GuardedWorkspaceStore) -> frozenset[str]:
    from sidecar.ai.tools.builtins.trash_maintenance import (  # noqa: PLC0415
        list_trash_entries,
    )

    try:
        return frozenset(
            entry.name
            for entry in list_trash_entries(
                guarded, max_entries=MAX_STORE_LIST_ENTRIES
            )
        )
    except ToolExecutionFailure:
        return frozenset()


def _live_backup_names(guarded: GuardedWorkspaceStore) -> frozenset[str]:
    try:
        return frozenset(
            candidate.name
            for candidate in guarded.list_entries(
                guarded.resolve(WorkspaceStoreKind.BACKUPS),
                max_entries=MAX_STORE_LIST_ENTRIES,
            )
            if "@v" in candidate.name and candidate.name.endswith(".bak")
        )
    except ToolExecutionFailure:
        return frozenset()


def _prune_baselines(baselines: Mapping[str, int], live_names: frozenset[str]) -> dict[str, int]:
    kept = {name: value for name, value in baselines.items() if name in live_names}
    if len(kept) > MAX_LEDGER_BASELINE_ENTRIES:
        # Oldest-inserted first -- dict insertion order is preserved.
        overflow = len(kept) - MAX_LEDGER_BASELINE_ENTRIES
        for name in list(kept)[:overflow]:
            kept.pop(name, None)
    return kept


def _bounded_mapping(value: object) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, int] = {}
    for key, raw in value.items():
        if len(result) >= MAX_LEDGER_BASELINE_ENTRIES:
            break
        if isinstance(key, str) and isinstance(raw, int) and not isinstance(raw, bool):
            result[key] = raw
    return result


# ── per-workspace active-use ledger (derived cache, not authoritative) ──────


def _ledger_ref(guarded: GuardedWorkspaceStore) -> Any:
    return guarded.resolve(WorkspaceStoreKind.BACKUPS, _LEDGER_NAME)


def _load_ledger(guarded: GuardedWorkspaceStore) -> dict[str, Any]:
    try:
        raw = guarded.read_bytes(_ledger_ref(guarded), max_bytes=_LEDGER_MAX_BYTES, missing_ok=True)
    except ToolExecutionFailure:
        return _empty_ledger()
    if raw is None:
        return _empty_ledger()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return _empty_ledger()
    return payload if isinstance(payload, dict) else _empty_ledger()


def _save_ledger(guarded: GuardedWorkspaceStore, ledger: Mapping[str, Any]) -> None:
    try:
        guarded.write_json_atomic(_ledger_ref(guarded), dict(ledger))
    except ToolExecutionFailure as error:
        logger.warning(
            "workspace_retention_ledger_write_failed",
            extra={"reason": type(error).__name__},
        )


def _empty_ledger() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "active_use_known": False,
        "current_active_use_seconds": 0,
        "journal_baselines": {},
        "trash_baselines": {},
        "backup_baselines": {},
    }


def _record_current_active_use(guarded: GuardedWorkspaceStore, seconds: int) -> None:
    ledger = _load_ledger(guarded)
    current = _ledger_active_seconds(ledger)
    ledger["active_use_known"] = True
    ledger["current_active_use_seconds"] = max(current, seconds)
    _save_ledger(guarded, ledger)


def _ledger_active_seconds(ledger: Mapping[str, Any]) -> int:
    raw = ledger.get("current_active_use_seconds")
    return raw if type(raw) is int and 0 <= raw <= MAX_ACTIVE_USE_SECONDS else 0


def _utc_now() -> str:
    return _format_utc(datetime.now(UTC))


def _format_utc(value: datetime) -> str:
    observed = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return observed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


__all__ = [
    "ActiveUseAgeTracker",
    "WorkspaceRetentionError",
    "acknowledge_recovery_review",
    "active_use_age_source",
    "list_recovery_review",
    "record_active_use_seconds",
    "run_recovery_maintenance",
    "touch_workspace_active_use",
]
