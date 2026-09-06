"""Durable, bounded storage for version-1 workspace mutation journals."""

from __future__ import annotations

import copy
import errno
import logging
import os
import re
import shutil
import stat
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, cast

from filelock import FileLock, Timeout

from sidecar.ai.error_codes import CMP_TOOL_DISABLED, CMP_TOOL_OUTSIDE_WORKSPACE
from sidecar.ai.tools.workspace_mutation_journal_contract import (
    MAX_JOURNAL_BYTES,
    ContractFailure,
    PathSignature,
    canonical_json_bytes,
    parse_record_bytes,
    seal_record,
    signature_for_path,
    validate_record,
    validate_relative_path,
    workspace_identity,
)

logger = logging.getLogger(__name__)

MAX_CHANGE_SETS_PER_WORKSPACE = 200
MAX_RECOVERY_OBJECT_BYTES_PER_WORKSPACE = 768 * 1024 * 1024
MAX_JOURNAL_RECEIPT_BYTES_PER_WORKSPACE = 16 * 1024 * 1024
MAX_RECEIPT_BYTES = 8 * 1024
MAX_SCAN_CHANGE_SETS = 10_000
LOCK_TIMEOUT_SECONDS = 15.0
ACTIVE_RETENTION_SECONDS = 30 * 24 * 60 * 60
TEMP_CLEANUP_MIN_AGE_SECONDS = 300

_WORKSPACE_ID_RE = re.compile(r"^ws_[0-9a-f]{32}$")
_CHANGE_SET_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_TEMP_RE = re.compile(r"^journal\.json\.[0-9A-Za-z_-]{1,80}\.tmp$")


@dataclass(frozen=True)
class QuotaLimits:
    max_change_sets: int = MAX_CHANGE_SETS_PER_WORKSPACE
    max_recovery_object_bytes: int = MAX_RECOVERY_OBJECT_BYTES_PER_WORKSPACE
    max_journal_bytes: int = MAX_JOURNAL_RECEIPT_BYTES_PER_WORKSPACE
    max_journal_file_bytes: int = MAX_JOURNAL_BYTES


@dataclass(frozen=True)
class StoreResult:
    ok: bool
    record: dict[str, Any] | None = None
    failure: ContractFailure | None = None
    evicted_change_set_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class _StoredSet:
    change_set_id: str
    path: Path
    record: dict[str, Any]
    journal_bytes: int
    sort_key: tuple[str, str]


@dataclass(frozen=True)
class _Usage:
    set_count: int
    journal_bytes: int
    recovery_object_bytes: int


class WorkspaceMutationJournalStore:
    """Owns journal durability, retention, receipts, pins, and reconciliation."""

    def __init__(  # noqa: PLR0913 - explicit durability hooks and injected clock.
        self,
        recovery_root: str | Path,
        *,
        quotas: QuotaLimits | None = None,
        after_in_progress_flush_before_first_workspace_mutation: Callable[[], None] | None = None,
        on_evict: Callable[[str, str], None] | None = None,
        on_commit: Callable[[str, str], None] | None = None,
        now_provider: Callable[[], datetime] | None = None,
    ) -> None:
        self.version_root = Path(recovery_root).absolute() / "v1"
        self.quotas = quotas or QuotaLimits()
        self.after_in_progress_flush_before_first_workspace_mutation = (
            after_in_progress_flush_before_first_workspace_mutation
        )
        self.on_evict = on_evict
        self.on_commit = on_commit
        self.now_provider = now_provider or (lambda: datetime.now(UTC))
        self._cleanup_orphan_temps()

    @classmethod
    def from_version_root(
        cls, version_root: str | Path, **kwargs: Any
    ) -> WorkspaceMutationJournalStore:
        """Construct from the already-versioned root passed across MCP argv."""

        root = Path(version_root)
        if root.name != "v1":
            raise ValueError("workspace recovery version root must end in v1")
        return cls(root.parent, **kwargs)

    def journal_path(self, workspace_id: str, change_set_id: str) -> Path:
        self._validate_ids(workspace_id, change_set_id)
        self._assert_safe_store_path(workspace_id, change_set_id)
        return self.version_root / workspace_id / change_set_id / "journal.json"

    def load(self, workspace_id: str, change_set_id: str) -> StoreResult:
        try:
            journal_path = self.journal_path(workspace_id, change_set_id)
            data = _read_bounded(journal_path, self.quotas.max_journal_file_bytes)
        except FileNotFoundError:
            return _store_failure("journal_not_found", "Workspace journal was not found.")
        except (OSError, ValueError) as error:
            return _store_failure(
                "journal_read_failed",
                "Workspace journal could not be read.",
                (type(error).__name__,),
            )
        parsed = parse_record_bytes(data, byte_cap=self.quotas.max_journal_file_bytes)
        if not parsed.ok:
            return StoreResult(ok=False, failure=parsed.failure)
        return StoreResult(ok=True, record=parsed.record)

    def find_open_change_set(
        self,
        workspace_root: str | Path,
        *,
        session_id: str,
        turn_id: str,
    ) -> StoreResult:
        """Find the sole non-terminal change set for one chat turn."""

        try:
            identity = workspace_identity(workspace_root)
            matches = [
                item.record
                for item in self._scan_workspace(identity.workspace_id)
                if item.record["state"] in {"prepared", "in_progress"}
                and item.record["session_id"] == session_id
                and item.record["turn_id"] == turn_id
            ]
        except (OSError, ValueError) as error:
            return _store_failure(
                "journal_lookup_failed",
                "Workspace recovery turn lookup failed.",
                (type(error).__name__,),
            )
        if len(matches) > 1:
            return _store_failure(
                "journal_turn_ambiguous",
                "Multiple open workspace recovery sets matched one turn.",
            )
        return StoreResult(ok=True, record=matches[0] if matches else None)

    def reserve(self, record: Mapping[str, Any]) -> StoreResult:
        """Reserve hard quotas, evicting only oldest eligible sets."""

        prepared = _prepare_record(record, set_commit_pin=False)
        if isinstance(prepared, StoreResult):
            return prepared
        sealed, data = prepared
        workspace_id = cast(str, sealed["workspace"]["workspace_id"])
        change_set_id = cast(str, sealed["change_set_id"])
        try:
            with self._lock(workspace_id):
                return self._reserve_locked(workspace_id, change_set_id, sealed, len(data))
        except Timeout:
            return _store_failure("journal_lock_timeout", "Workspace journal lock timed out.")
        except (OSError, ValueError) as error:
            return _store_failure(
                "journal_reservation_failed",
                "Workspace recovery quota could not be reserved.",
                (type(error).__name__,),
            )

    def write_transition(
        self,
        record: Mapping[str, Any],
        *,
        workspace_root: str | Path | None = None,
        retention_only: bool = False,
    ) -> StoreResult:
        """Seal, reserve, and durably install one complete journal transition."""

        prepared = _prepare_record(record, set_commit_pin=not retention_only)
        if isinstance(prepared, StoreResult):
            return prepared
        sealed, data = prepared
        workspace_id = cast(str, sealed["workspace"]["workspace_id"])
        change_set_id = cast(str, sealed["change_set_id"])
        if len(data) > self.quotas.max_journal_file_bytes:
            return _store_failure("journal_oversized", "Workspace journal exceeds its byte cap.")
        try:
            notify_commit = False
            with self._lock(workspace_id), self._lock(workspace_id, change_set_id):
                previous = self.load(workspace_id, change_set_id)
                if retention_only and (
                    not previous.ok
                    or previous.record is None
                    or not _is_retention_only_update(previous.record, sealed)
                ):
                    return _store_failure(
                        "journal_retention_update_invalid",
                        "Workspace retention update changed immutable journal data.",
                    )
                previous_state = (
                    previous.record["state"]
                    if previous.ok and previous.record
                    else None
                )
                result = self._write_transition_locked(
                    sealed, data, workspace_root, transfer_commit_pin=not retention_only
                )
                notify_commit = (
                    not retention_only
                    and result.ok
                    and sealed["state"] == "committed"
                    and previous_state != "committed"
                )
        except Timeout:
            return _store_failure("journal_lock_timeout", "Workspace journal lock timed out.")
        except (OSError, ValueError) as error:
            logger.warning(
                "workspace_mutation_journal_write_failed",
                extra={"reason": type(error).__name__},
            )
            result = _store_failure(
                "journal_write_failed",
                "Workspace journal could not be written durably.",
                (type(error).__name__,),
            )
            notify_commit = False
        if notify_commit:
            self._notify_commit(workspace_id, change_set_id)
        return result

    def _write_transition_locked(
        self,
        sealed: dict[str, Any],
        data: bytes,
        workspace_root: str | Path | None,
        *,
        transfer_commit_pin: bool = True,
    ) -> StoreResult:
        workspace_id = cast(str, sealed["workspace"]["workspace_id"])
        change_set_id = cast(str, sealed["change_set_id"])
        reservation = self._reserve_locked(workspace_id, change_set_id, sealed, len(data))
        if not reservation.ok:
            return reservation
        journal_path = self.journal_path(workspace_id, change_set_id)
        _write_bytes_durable(journal_path, data, through_directory=self.version_root)
        verification = self.load(workspace_id, change_set_id)
        if not verification.ok:
            return verification
        if _is_first_applying_transition(sealed):
            callback = self.after_in_progress_flush_before_first_workspace_mutation
            if callback is not None:
                callback()
        if transfer_commit_pin and sealed["state"] == "committed":
            self._transfer_newest_committed_pin(workspace_id, change_set_id)
        if workspace_root is not None:
            self._refresh_receipt_best_effort(Path(workspace_root), sealed)
        return StoreResult(
            ok=True,
            record=sealed,
            evicted_change_set_ids=reservation.evicted_change_set_ids,
        )

    def _notify_commit(self, workspace_id: str, change_set_id: str) -> None:
        if self.on_commit is None:
            return
        try:
            self.on_commit(workspace_id, change_set_id)
        except Exception as error:  # noqa: BLE001 - post-commit maintenance is best-effort.
            logger.warning(
                "workspace_mutation_journal_commit_hook_failed",
                extra={"reason": type(error).__name__},
            )

    def reconcile_workspace(self, workspace_root: str | Path) -> tuple[StoreResult, ...]:
        """Reclassify non-terminal sets using current pre/post signatures."""

        try:
            identity = workspace_identity(workspace_root)
        except (OSError, ValueError) as error:
            return (
                _store_failure(
                    "workspace_identity_unavailable",
                    "Workspace identity could not be verified.",
                    (type(error).__name__,),
                ),
            )
        results: list[StoreResult] = []
        try:
            with self._lock(identity.workspace_id):
                for stored in self._scan_workspace(identity.workspace_id):
                    with self._lock(identity.workspace_id, stored.change_set_id):
                        loaded = self.load(identity.workspace_id, stored.change_set_id)
                        if not loaded.ok or loaded.record is None:
                            results.append(loaded)
                            continue
                        if loaded.record["state"] not in {"prepared", "in_progress"}:
                            continue
                        if not _record_matches_identity(loaded.record, identity.fingerprint):
                            results.append(_identity_failure())
                            continue
                        reconciled = self._reconcile_record(loaded.record, Path(workspace_root))
                        results.append(self._write_mapping_locked(reconciled, Path(workspace_root)))
        except Timeout:
            results.append(
                _store_failure("journal_lock_timeout", "Workspace journal lock timed out.")
            )
        except (OSError, ValueError) as error:
            results.append(
                _store_failure(
                    "journal_reconciliation_failed",
                    "Workspace journal reconciliation failed.",
                    (type(error).__name__,),
                )
            )
        return tuple(results)

    def complete_no_effect_rollback(
        self,
        workspace_id: str,
        change_set_id: str,
        *,
        workspace_root: str | Path,
    ) -> StoreResult:
        """Commit the verified no-op reverse path for a pre-mutation crash."""

        try:
            identity = workspace_identity(workspace_root)
            if identity.workspace_id != workspace_id:
                return _identity_failure()
            with self._lock(workspace_id), self._lock(workspace_id, change_set_id):
                return self._complete_no_effect_rollback_locked(
                    workspace_id,
                    change_set_id,
                    Path(workspace_root),
                    identity.fingerprint,
                )
        except Timeout:
            return _store_failure("journal_lock_timeout", "Workspace journal lock timed out.")
        except (OSError, ValueError) as error:
            return _store_failure(
                "journal_rollback_failed",
                "Workspace no-effect rollback failed.",
                (type(error).__name__,),
            )

    def _complete_no_effect_rollback_locked(
        self,
        workspace_id: str,
        change_set_id: str,
        workspace_root: Path,
        fingerprint: str,
    ) -> StoreResult:
        loaded = self.load(workspace_id, change_set_id)
        if not loaded.ok or loaded.record is None:
            return loaded
        record = loaded.record
        if not _record_matches_identity(record, fingerprint):
            return _identity_failure()
        operations = cast(list[dict[str, Any]], record["operations"])
        reversible = (
            record["state"] == "interrupted"
            and not record["completed_sequences"]
            and all(
                operation["status"] == "planned"
                and _operation_matches(operation, "pre_signature", workspace_root)
                for operation in operations
            )
        )
        if not reversible:
            return _store_failure(
                "journal_no_effect_rollback_conflict",
                "Workspace no longer matches the no-effect rollback preflight.",
            )
        return self._write_mapping_locked(_no_effect_rollback_record(record), workspace_root)

    def pinned_recovery_object_ids(self, workspace_id: str | None = None) -> frozenset[str]:
        """Return recovery objects protected by valid, retained journals."""

        records = self._scan_all_records(workspace_id)
        pinned: set[str] = set()
        for stored in records:
            retention = cast(dict[str, Any], stored.record["retention"])
            if retention["protected"]:
                pinned.update(_recovery_object_sizes(stored.record))
            restore = cast(dict[str, Any], stored.record["restore"])
            if restore["status"] in {"preflight", "in_progress", "interrupted"}:
                for occupant in cast(list[dict[str, Any]], restore["protected_occupants"]):
                    pinned.add(cast(str, occupant["object_id"]))
        return frozenset(pinned)

    def is_recovery_object_pinned(self, object_id: str, *, workspace_id: str | None = None) -> bool:
        return object_id in self.pinned_recovery_object_ids(workspace_id)

    def _write_mapping_locked(self, record: Mapping[str, Any], workspace_root: Path) -> StoreResult:
        prepared = _prepare_record(record, set_commit_pin=True)
        if isinstance(prepared, StoreResult):
            return prepared
        sealed, data = prepared
        if len(data) > self.quotas.max_journal_file_bytes:
            return _store_failure("journal_oversized", "Workspace journal exceeds its byte cap.")
        return self._write_transition_locked(sealed, data, workspace_root)

    def _reserve_locked(
        self,
        workspace_id: str,
        change_set_id: str,
        incoming: Mapping[str, Any],
        incoming_bytes: int,
    ) -> StoreResult:
        stored_sets = [
            item
            for item in self._scan_workspace(workspace_id)
            if item.change_set_id != change_set_id
        ]
        newest_committed = _newest_committed_id(stored_sets)
        eviction_plan: list[_StoredSet] = []
        observed_at = self.now_provider()
        while _over_quota(_projected_usage(stored_sets, incoming, incoming_bytes), self.quotas):
            candidate = next(
                (
                    item
                    for item in stored_sets
                    if _eligible_for_eviction(item, newest_committed, observed_at)
                ),
                None,
            )
            if candidate is None:
                return StoreResult(
                    ok=False,
                    failure=ContractFailure(
                        code=CMP_TOOL_OUTSIDE_WORKSPACE,
                        reason="journal_quota_exceeded",
                        message="Workspace recovery quota cannot be reserved safely.",
                    ),
                    evicted_change_set_ids=(),
                )
            stored_sets.remove(candidate)
            eviction_plan.append(candidate)
        for candidate in eviction_plan:
            self._remove_set(candidate)
        evicted = [candidate.change_set_id for candidate in eviction_plan]
        return StoreResult(ok=True, evicted_change_set_ids=tuple(evicted))

    def _scan_workspace(self, workspace_id: str) -> list[_StoredSet]:
        if not _WORKSPACE_ID_RE.fullmatch(workspace_id):
            return []
        workspace_path = self.version_root / workspace_id
        if not workspace_path.is_dir() or workspace_path.is_symlink():
            return []
        records: list[_StoredSet] = []
        for index, child in enumerate(sorted(workspace_path.iterdir(), key=lambda item: item.name)):
            if index >= MAX_SCAN_CHANGE_SETS:
                logger.warning("workspace_mutation_journal_scan_bounded")
                break
            valid_directory = child.is_dir() and not child.is_symlink()
            if not valid_directory or not _CHANGE_SET_ID_RE.fullmatch(child.name):
                continue
            journal_path = child / "journal.json"
            try:
                journal_bytes = journal_path.stat().st_size
            except OSError:
                continue
            loaded = self.load(workspace_id, child.name)
            if not loaded.ok or loaded.record is None:
                logger.warning(
                    "workspace_mutation_journal_ignored",
                    extra={"change_set_id": child.name},
                )
                continue
            wall_time = cast(dict[str, Any], loaded.record["wall_time"])
            records.append(
                _StoredSet(
                    change_set_id=child.name,
                    path=child,
                    record=loaded.record,
                    journal_bytes=journal_bytes,
                    sort_key=(cast(str, wall_time["prepared_at"]), child.name),
                )
            )
        return sorted(records, key=lambda item: item.sort_key)

    def _scan_all_records(self, workspace_id: str | None) -> list[_StoredSet]:
        if workspace_id is not None:
            return self._scan_workspace(workspace_id)
        if not self.version_root.is_dir() or self.version_root.is_symlink():
            return []
        records: list[_StoredSet] = []
        for child in self.version_root.iterdir():
            if child.is_dir() and not child.is_symlink() and _WORKSPACE_ID_RE.fullmatch(child.name):
                records.extend(self._scan_workspace(child.name))
        return records

    def _remove_set(self, stored: _StoredSet) -> None:
        expected_parent = self.version_root / cast(str, stored.record["workspace"]["workspace_id"])
        if stored.path.parent.absolute() != expected_parent.absolute():
            raise ValueError("journal eviction target escaped its workspace recovery root")
        if stored.path.is_symlink() or _is_junction(stored.path):
            raise ValueError("journal eviction target is an unsafe link")
        shutil.rmtree(stored.path)
        _fsync_directory(expected_parent)
        if self.on_evict is not None:
            workspace_id = cast(str, stored.record["workspace"]["workspace_id"])
            try:
                self.on_evict(workspace_id, stored.change_set_id)
            except Exception as error:  # noqa: BLE001 - post-eviction hook is best-effort.
                logger.warning(
                    "workspace_mutation_journal_evict_hook_failed",
                    extra={"reason": type(error).__name__},
                )

    def _transfer_newest_committed_pin(self, workspace_id: str, change_set_id: str) -> None:
        for stored in self._scan_workspace(workspace_id):
            should_pin = stored.change_set_id == change_set_id
            retention = cast(dict[str, Any], stored.record["retention"])
            if retention["pinned_as_newest_committed"] == should_pin:
                continue
            updated = copy.deepcopy(stored.record)
            cast(dict[str, Any], updated["retention"])["pinned_as_newest_committed"] = should_pin
            cast(dict[str, Any], updated["wall_time"])["updated_at"] = _utc_now()
            data = canonical_json_bytes(seal_record(updated))
            with self._lock(workspace_id, stored.change_set_id):
                journal_path = stored.path / "journal.json"
                _write_bytes_durable(journal_path, data, through_directory=self.version_root)
                verified = self.load(workspace_id, stored.change_set_id)
                if not verified.ok:
                    raise OSError("committed journal pin transfer failed verification")

    def _refresh_receipt(self, workspace_root: Path, record: Mapping[str, Any]) -> None:
        identity = workspace_identity(workspace_root)
        recorded_workspace = cast(dict[str, Any], record["workspace"])
        if identity.fingerprint != recorded_workspace["fingerprint"]:
            raise ValueError("workspace recovery receipt identity changed")
        jenny_root = workspace_root / ".jenny"
        if workspace_root.is_symlink() or _is_junction(workspace_root):
            raise ValueError("workspace recovery receipt root is unsafe")
        if jenny_root.is_symlink() or _is_junction(jenny_root):
            raise ValueError("workspace recovery receipt directory is unsafe")
        receipt_path = workspace_root / ".jenny" / "workspace-recovery.json"
        receipt = _build_receipt(record)
        data = canonical_json_bytes(receipt)
        events = cast(list[str], receipt["coverage"]["known_unjournaled_tool_call_ids"])
        while len(data) > MAX_RECEIPT_BYTES and events:
            events.pop()
            data = canonical_json_bytes(receipt)
        if len(data) > MAX_RECEIPT_BYTES:
            raise ValueError("workspace recovery receipt exceeds its byte cap")
        _write_bytes_durable(receipt_path, data, through_directory=workspace_root)

    def _refresh_receipt_best_effort(self, workspace_root: Path, record: Mapping[str, Any]) -> None:
        try:
            self._refresh_receipt(workspace_root, record)
        except (OSError, TypeError, ValueError) as error:
            logger.warning(
                "workspace_mutation_journal_receipt_refresh_failed",
                extra={"reason": type(error).__name__},
            )

    def _reconcile_record(self, record: Mapping[str, Any], workspace_root: Path) -> dict[str, Any]:
        updated = copy.deepcopy(dict(record))
        operations = cast(list[dict[str, Any]], updated["operations"])
        if updated["state"] == "prepared":
            state = (
                "rolled_back"
                if all(
                    _operation_matches(item, "pre_signature", workspace_root) for item in operations
                )
                else "interrupted"
            )
        else:
            self._reconcile_in_progress_operations(operations, workspace_root)
            state = "interrupted"
        updated["state"] = state
        updated["termination_reason"] = "process_recovered"
        updated["completed_sequences"] = sorted(
            operation["sequence"] for operation in operations if operation["status"] == "applied"
        )
        timestamp = _utc_now()
        wall_time = cast(dict[str, Any], updated["wall_time"])
        wall_time["updated_at"] = timestamp
        wall_time["terminal_at"] = timestamp
        if state == "rolled_back":
            cast(dict[str, Any], updated["retention"])["protected"] = False
        return updated

    def _reconcile_in_progress_operations(
        self, operations: list[dict[str, Any]], workspace_root: Path
    ) -> None:
        for operation in operations:
            status = operation["status"]
            if status == "applying":
                if _operation_matches(operation, "pre_signature", workspace_root):
                    operation["status"] = "planned"
                elif _operation_matches(operation, "post_signature", workspace_root):
                    operation["status"] = "applied"
                else:
                    operation["status"] = "unknown"
            elif status == "applied" and not _operation_matches(
                operation, "post_signature", workspace_root
            ):
                operation["status"] = "unknown"

    @contextmanager
    def _lock(self, workspace_id: str, change_set_id: str | None = None) -> Iterator[None]:
        self._validate_ids(workspace_id, change_set_id)
        self._assert_safe_store_path(workspace_id, change_set_id)
        name = f"{change_set_id}.lock" if change_set_id else "workspace.lock"
        lock_path = self.version_root / workspace_id / ".locks" / name
        _ensure_directory_durable(lock_path.parent, through_directory=self.version_root)
        with FileLock(str(lock_path), timeout=LOCK_TIMEOUT_SECONDS):
            yield

    def _cleanup_orphan_temps(self) -> None:
        if not self.version_root.is_dir() or self.version_root.is_symlink():
            return
        cleaned = 0
        for workspace_path in self.version_root.iterdir():
            if not _safe_store_directory(workspace_path, _WORKSPACE_ID_RE):
                continue
            for set_path in workspace_path.iterdir():
                if not _safe_store_directory(set_path, _CHANGE_SET_ID_RE):
                    continue
                cleaned += _clean_set_temps(set_path, MAX_SCAN_CHANGE_SETS - cleaned)
                if cleaned >= MAX_SCAN_CHANGE_SETS:
                    logger.warning("workspace_mutation_journal_temp_cleanup_bounded")
                    return

    @staticmethod
    def _validate_ids(workspace_id: str, change_set_id: str | None) -> None:
        if not _WORKSPACE_ID_RE.fullmatch(workspace_id):
            raise ValueError("invalid workspace journal id")
        if change_set_id is not None and not _CHANGE_SET_ID_RE.fullmatch(change_set_id):
            raise ValueError("invalid change-set id")

    def _assert_safe_store_path(self, workspace_id: str, change_set_id: str | None) -> None:
        paths = [self.version_root, self.version_root / workspace_id]
        if change_set_id is not None:
            paths.append(paths[-1] / change_set_id)
        for path in paths:
            if path.is_symlink() or _is_junction(path):
                raise ValueError("workspace journal store contains an unsafe link")
            if path.exists() and not path.is_dir():
                raise ValueError("workspace journal store contains an unsafe link")


def _read_bounded(path: Path, byte_cap: int) -> bytes:
    with path.open("rb") as handle:
        data = handle.read(byte_cap + 1)
    if len(data) > byte_cap:
        raise ValueError("journal byte cap exceeded")
    return data


def _safe_store_directory(path: Path, name_pattern: re.Pattern[str]) -> bool:
    return bool(
        name_pattern.fullmatch(path.name)
        and not path.is_symlink()
        and not _is_junction(path)
        and path.is_dir()
    )


def _clean_set_temps(set_path: Path, remaining: int) -> int:
    cleaned = 0
    for candidate in set_path.iterdir():
        if cleaned >= remaining:
            break
        if not _TEMP_RE.fullmatch(candidate.name) or candidate.is_symlink():
            continue
        try:
            if time.time() - candidate.stat().st_mtime < TEMP_CLEANUP_MIN_AGE_SECONDS:
                continue
            candidate.unlink(missing_ok=True)
            cleaned += 1
        except OSError as error:
            logger.warning(
                "workspace_mutation_journal_temp_cleanup_failed",
                extra={"reason": type(error).__name__},
            )
    return cleaned


def _prepare_record(
    record: Mapping[str, Any], *, set_commit_pin: bool
) -> tuple[dict[str, Any], bytes] | StoreResult:
    try:
        working = copy.deepcopy(dict(record))
        retention = working.get("retention")
        if set_commit_pin and isinstance(retention, dict):
            retention["pinned_as_newest_committed"] = working.get("state") == "committed"
        sealed = seal_record(working)
        data = canonical_json_bytes(sealed)
    except (TypeError, ValueError, OverflowError):
        return _store_failure("journal_canonicalization_failed", "Journal could not be encoded.")
    validation = validate_record(sealed)
    if not validation.ok:
        return StoreResult(ok=False, failure=validation.failure)
    return sealed, data


_RETENTION_MUTABLE_FIELDS = frozenset(
    {
        "created_active_use_seconds",
        "last_accessed_active_use_seconds",
        "active_age_seconds",
        "wall_clock_review_presented_at",
    }
)


def _is_retention_only_update(
    current: Mapping[str, Any], incoming: Mapping[str, Any]
) -> bool:
    def immutable_projection(record: Mapping[str, Any]) -> dict[str, Any]:
        projected = copy.deepcopy(dict(record))
        projected.pop("integrity", None)
        wall_time = projected.get("wall_time")
        if isinstance(wall_time, dict):
            wall_time.pop("updated_at", None)
        retention = projected.get("retention")
        if isinstance(retention, dict):
            for key in _RETENTION_MUTABLE_FIELDS:
                retention.pop(key, None)
        return projected

    return immutable_projection(current) == immutable_projection(incoming)


def _write_bytes_durable(path: Path, data: bytes, *, through_directory: Path) -> None:
    _ensure_directory_durable(path.parent, through_directory=through_directory)
    descriptor, temp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        with path.open("r+b") as installed:
            os.fsync(installed.fileno())
        directory = path.parent
        stop = through_directory.absolute()
        while True:
            _fsync_directory(directory)
            if directory.absolute() == stop or directory.parent == directory:
                break
            directory = directory.parent
    finally:
        temp_path.unlink(missing_ok=True)


def _ensure_directory_durable(path: Path, *, through_directory: Path) -> None:
    if not path.absolute().is_relative_to(through_directory.absolute()):
        raise ValueError("durable directory escaped its boundary")
    created: list[Path] = []
    current = path
    while not current.exists():
        created.append(current)
        current = current.parent
    path.mkdir(parents=True, exist_ok=True)
    for directory in reversed(created):
        _fsync_directory(directory.parent)
        _fsync_directory(directory)


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        windows_best_effort = os.name == "nt" and error.errno in {
            errno.EACCES,
            errno.EINVAL,
            errno.EPERM,
        }
        if not windows_best_effort:
            raise
        logger.debug(
            "workspace_mutation_journal_directory_fsync_degraded",
            extra={"reason": type(error).__name__},
        )


def _is_first_applying_transition(record: Mapping[str, Any]) -> bool:
    if record["state"] != "in_progress" or record["completed_sequences"]:
        return False
    operations = cast(list[dict[str, Any]], record["operations"])
    return bool(operations and operations[0]["status"] == "applying")


def _operation_matches(
    operation: Mapping[str, Any], signature_key: str, workspace_root: Path
) -> bool:
    for endpoint_name in ("source", "destination"):
        endpoint = operation[endpoint_name]
        if endpoint is None:
            continue
        endpoint = cast(dict[str, Any], endpoint)
        relative_path = endpoint["relative_path"]
        if not validate_relative_path(relative_path).ok:
            return False
        target = _safe_workspace_target(workspace_root, cast(str, relative_path))
        if target is None:
            return False
        actual = signature_for_path(target)
        if not actual.ok or actual.signature is None:
            return False
        expected = PathSignature.from_mapping(cast(Mapping[str, object], endpoint[signature_key]))
        if actual.signature != expected:
            return False
    return True


def _record_matches_identity(record: Mapping[str, Any], fingerprint: str) -> bool:
    workspace = cast(dict[str, Any], record["workspace"])
    return workspace["fingerprint"] == fingerprint


def _identity_failure() -> StoreResult:
    return _store_failure(
        "workspace_identity_changed",
        "Workspace identity no longer matches the recovery journal.",
    )


def _no_effect_rollback_record(record: Mapping[str, Any]) -> dict[str, Any]:
    updated = copy.deepcopy(dict(record))
    timestamp = _utc_now()
    for operation in cast(list[dict[str, Any]], updated["operations"]):
        operation["status"] = "skipped"
    updated["state"] = "rolled_back"
    restore = cast(dict[str, Any], updated["restore"])
    restore.update({"status": "committed", "updated_at": timestamp, "completed_at": timestamp})
    cast(dict[str, Any], updated["retention"])["protected"] = False
    wall_time = cast(dict[str, Any], updated["wall_time"])
    wall_time.update({"updated_at": timestamp, "terminal_at": timestamp})
    return updated


def _safe_workspace_target(workspace_root: Path, relative_path: str) -> Path | None:
    target = workspace_root.joinpath(*relative_path.split("/"))
    current = workspace_root
    for part in relative_path.split("/")[:-1]:
        current /= part
        if current.is_symlink() or _is_junction(current):
            return None
        if current.exists() and not current.is_dir():
            return None
        if not current.exists():
            break
    return target


def _projected_usage(
    stored_sets: list[_StoredSet], incoming: Mapping[str, Any], incoming_bytes: int
) -> _Usage:
    receipt_bytes = len(canonical_json_bytes(_build_receipt(incoming)))
    journal_bytes = incoming_bytes + receipt_bytes + sum(item.journal_bytes for item in stored_sets)
    object_sizes: dict[str, int] = {}
    for item in stored_sets:
        _merge_object_sizes(object_sizes, _recovery_object_sizes(item.record))
    _merge_object_sizes(object_sizes, _recovery_object_sizes(incoming))
    return _Usage(
        set_count=len(stored_sets) + 1,
        journal_bytes=journal_bytes,
        recovery_object_bytes=sum(object_sizes.values()),
    )


def _recovery_object_sizes(record: Mapping[str, Any]) -> dict[str, int]:
    sizes: dict[str, int] = {}
    for operation in cast(list[dict[str, Any]], record["operations"]):
        for recovery_object in cast(list[dict[str, Any]], operation["recovery_objects"]):
            signature = cast(dict[str, Any], recovery_object["signature"])
            sizes[cast(str, recovery_object["object_id"])] = cast(int, signature["byte_size"])
    restore = cast(dict[str, Any], record["restore"])
    for recovery_object in cast(list[dict[str, Any]], restore["protected_occupants"]):
        signature = cast(dict[str, Any], recovery_object["signature"])
        sizes[cast(str, recovery_object["object_id"])] = cast(int, signature["byte_size"])
    return sizes


def _merge_object_sizes(target: dict[str, int], source: Mapping[str, int]) -> None:
    for object_id, size in source.items():
        target[object_id] = max(size, target.get(object_id, 0))


def _over_quota(usage: _Usage, limits: QuotaLimits) -> bool:
    return (
        usage.set_count > limits.max_change_sets
        or usage.journal_bytes > limits.max_journal_bytes
        or usage.recovery_object_bytes > limits.max_recovery_object_bytes
    )


def _newest_committed_id(stored_sets: list[_StoredSet]) -> str | None:
    committed = [item for item in stored_sets if item.record["state"] == "committed"]
    return max(committed, key=lambda item: item.sort_key).change_set_id if committed else None


def _eligible_for_eviction(
    stored: _StoredSet, newest_committed: str | None, now: datetime
) -> bool:
    state = stored.record["state"]
    restore = cast(dict[str, Any], stored.record["restore"])
    retention = cast(dict[str, Any], stored.record["retention"])
    return (
        state not in {"in_progress", "interrupted"}
        and restore["status"] not in {"preflight", "in_progress", "interrupted"}
        and stored.change_set_id != newest_committed
        and not retention["pinned_as_newest_committed"]
        and _retention_age_eligible(retention, now)
    )


def _retention_age_eligible(retention: Mapping[str, Any], now: datetime) -> bool:
    if retention["active_age_seconds"] >= ACTIVE_RETENTION_SECONDS:
        return True
    if retention["wall_clock_review_presented_at"] is None:
        return False
    try:
        due_at = datetime.fromisoformat(
            cast(str, retention["wall_clock_review_due_at"]).replace("Z", "+00:00")
        )
    except ValueError:
        return False
    observed = now if now.tzinfo is not None else now.replace(tzinfo=UTC)
    return observed >= due_at


def _build_receipt(record: Mapping[str, Any]) -> dict[str, Any]:
    workspace = cast(dict[str, Any], record["workspace"])
    coverage = cast(dict[str, Any], record["coverage"])
    workspace_id = cast(str, workspace["workspace_id"])
    change_set_id = cast(str, record["change_set_id"])
    return {
        "schema_version": 1,
        "workspace_id": workspace_id,
        "latest_change_set_id": change_set_id,
        "latest_state": record["state"],
        "operation_count": record["operation_count"],
        "authoritative_store": f"workspace-recovery/v1/{workspace_id}/{change_set_id}/",
        "updated_at": cast(dict[str, Any], record["wall_time"])["updated_at"],
        "coverage": {
            "level": "typed_tools_only",
            "shell_mutations": "not_journaled_approval_gated",
            "explorer_rename": "not_journaled_until_wo_27_item_2",
            "known_unjournaled_tool_call_ids": list(coverage["known_unjournaled_events"]),
            "partially_undoable": coverage["partially_undoable"],
            "warning": (
                "Undo covers typed write, edit, delete, and move operations only. "
                "Approved shell mutations and Explorer renames may be outside this recovery set."
            ),
        },
    }


def _is_junction(path: Path) -> bool:
    checker = getattr(os.path, "isjunction", None)
    if checker is not None and checker(path):
        return True
    try:
        path_stat = path.lstat()
    except OSError:
        return False
    mount_point_tag = getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)
    return getattr(path_stat, "st_reparse_tag", None) == mount_point_tag


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _store_failure(reason: str, message: str, details: tuple[str, ...] = ()) -> StoreResult:
    return StoreResult(
        ok=False,
        failure=ContractFailure(
            code=CMP_TOOL_DISABLED, reason=reason, message=message, details=details
        ),
    )
