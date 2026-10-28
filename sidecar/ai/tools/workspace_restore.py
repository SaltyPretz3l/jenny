"""Durable, conflict-aware workspace recovery on mutation journal v1."""
# ruff: noqa: E501
from __future__ import annotations

import copy
import secrets
from datetime import UTC, datetime
from os import path as os_path
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence, cast

from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_mutation_journal_contract import (
    EMPTY_SHA256,
    PathSignature,
    signature_for_path,
    validate_relative_path,
    workspace_identity,
)
from sidecar.ai.tools.workspace_mutation_journal_store import (
    _CHANGE_SET_ID_RE,
    WorkspaceMutationJournalStore,
)
from sidecar.ai.tools.workspace_restore_io import (
    RestorePathUnsafe,
    bound_workspace,
    copy_new,
    make_parents,
)
from sidecar.ai.tools.workspace_restore_io import (
    fsync_directory as _fsync_directory,  # noqa: F401 - staging imports it from here
)
from sidecar.ai.tools.workspace_restore_io import remove as _remove_exact
from sidecar.ai.tools.workspace_restore_io import replace as _guarded_replace
from sidecar.ai.tools.workspace_restore_io import rmdir as _guarded_rmdir
from sidecar.ai.tools.workspace_restore_staging import (
    _resume_preflight,
    _stage_move_sources,
    _validate_completed_step,  # noqa: F401 - compatibility import
    _validate_resume_state,
)

ALLOWED_OUTCOMES = ("skip", "alternate_name", "protect_then_replace")
MAX_LISTED_CHANGE_SETS = 200
RESTORE_ERROR_CODE = CMP_TOOL_EXECUTION_FAILED

class WorkspaceRestoreError(RuntimeError):
    def __init__(self, reason: str, message: str, *, details: Mapping[str, object] | None = None) -> None:
        super().__init__(message)
        self.code = RESTORE_ERROR_CODE
        self.reason = reason
        self.message = message
        self.details = dict(details or {})

def list_change_sets(
    store: WorkspaceMutationJournalStore, workspace_root: str | Path
) -> dict[str, object]:
    identity = _identity(workspace_root)
    records: list[dict[str, object]] = []
    for change_set_id in _newest_change_set_ids(store, identity.workspace_id):
        loaded = store.load(identity.workspace_id, change_set_id)
        if not loaded.ok or loaded.record is None:
            continue
        records.append(_change_set_summary(loaded.record))
    records.sort(key=lambda item: str(item["updated_at"]), reverse=True)
    return {
        "workspace_id": identity.workspace_id,
        "change_sets": records,
        "outside_undo_set": _outside_undo_set(None),
    }

def preflight_undo(
    store: WorkspaceMutationJournalStore, workspace_root: str | Path, change_set_id: str
) -> dict[str, object]:
    store.reconcile_workspace(workspace_root)
    root, record = _load_record(store, workspace_root, change_set_id)
    _assert_no_other_active_set(store, root, change_set_id)
    return _preflight_loaded(store, root, record)

def _assert_no_other_active_set(
    store: WorkspaceMutationJournalStore, root: Path, change_set_id: str
) -> None:
    """One store scan: Undo and Redo wait while any other change set is open."""
    try:
        stored = store._scan_workspace(_identity(root).workspace_id)
    except OSError as error:
        raise _failure("journal_list_failed", "Workspace recovery sets could not be listed.", error) from error
    if any(item.change_set_id != change_set_id and item.record["state"] in {"prepared", "in_progress"}
           for item in stored):
        raise WorkspaceRestoreError(
            "restore_workspace_busy",
            "Workspace recovery is blocked while another change set is active.",
            details={"status": "busy"},
        )

def _newest_change_set_ids(store: WorkspaceMutationJournalStore, workspace_id: str) -> list[str]:
    """Change-set directory names newest first (UUIDv7), skipping ``.locks`` and strays."""
    try:
        names = sorted((child.name for child in (store.version_root / workspace_id).iterdir()
                        if _CHANGE_SET_ID_RE.fullmatch(child.name)
                        and child.is_dir() and not child.is_symlink()), reverse=True)
    except FileNotFoundError:
        return []
    except OSError as error:
        raise _failure("journal_list_failed", "Workspace recovery sets could not be listed.", error) from error
    return names[:MAX_LISTED_CHANGE_SETS]

def _preflight_loaded(
    store: WorkspaceMutationJournalStore, root: Path, record: dict[str, Any]
) -> dict[str, object]:
    change_set_id = cast(str, record["change_set_id"])
    if record["state"] not in {"committed", "interrupted"}:
        raise WorkspaceRestoreError(
            "change_set_not_restorable",
            "Workspace change set is not in a restorable state.",
        )
    restore = cast(dict[str, Any], record["restore"])
    if restore["status"] == "interrupted":
        raise WorkspaceRestoreError("restore_needs_review", "Interrupted restore requires manual review.", details={"status": "needs_review"})
    if restore["status"] == "in_progress":
        return _resume_preflight(root, record)
    _verify_recovery_objects(root, record)
    plan = _inverse_plan(record)
    staging = _plan_staging(root, record, plan)
    conflicts = _preflight_conflicts(root, plan, staging)
    now = _utc_now()
    restore.update(
        {
            "status": "preflight",
            "requested_at": restore["requested_at"] or now,
            "updated_at": now,
            "completed_at": None,
            "completed_inverse_step_ids": [],
            "decisions": [],
            "staging_entries": staging,
            "protected_occupants": [],
            "partial_result": _partial_result(len(conflicts), record),
        }
    )
    _write_required(store, root, record)
    return {
        "change_set_id": change_set_id,
        "status": "preflight",
        "conflicts": conflicts,
        "inverse_plan": [_public_step(item) for item in plan],
        "staging_entries": copy.deepcopy(staging),
        "outside_undo_set": _outside_undo_set(record),
    }

def undo_change_set(
    store: WorkspaceMutationJournalStore,
    workspace_root: str | Path,
    change_set_id: str,
    decisions: Sequence[Mapping[str, object]] | Mapping[str, object] | None = None,
    *,
    after_inverse_step_persisted: Callable[[str], None] | None = None,
) -> dict[str, object]:
    store.reconcile_workspace(workspace_root)
    root, record = _load_record(store, workspace_root, change_set_id)
    _assert_no_other_active_set(store, root, change_set_id)
    restore = cast(dict[str, Any], record["restore"])
    if restore["status"] == "interrupted":
        raise WorkspaceRestoreError("restore_needs_review", "Interrupted restore requires manual review.", details={"status": "needs_review"})
    if restore["status"] == "committed" and record["state"] == "rolled_back":
        return _receipt(record)
    if restore["status"] != "in_progress":
        if restore["status"] != "preflight":
            _preflight_loaded(store, root, record)  # reconciled and busy-checked above
            _root, record = _load_record(store, root, change_set_id)
            restore = cast(dict[str, Any], record["restore"])
        plan = _inverse_plan(record)
        staging = cast(list[dict[str, Any]], restore["staging_entries"])
        conflicts = _preflight_conflicts(root, plan, staging)
        normalized = _normalize_decisions(decisions, conflicts, change_set_id, root)
        restore["decisions"] = normalized + _dependent_skips(root, plan, staging, normalized)
        restore["status"] = "in_progress"
        restore["updated_at"] = _utc_now()
        _write_required(store, root, record)
    else:
        plan = _inverse_plan(record)
        staging = cast(list[dict[str, Any]], restore["staging_entries"])

    try:
        with bound_workspace(root):
            _validate_resume_state(root, record, plan, staging)
            _stage_move_sources(root, record, plan, staging)
            _execute_missing_steps(store, root, record, plan, staging, after_inverse_step_persisted)
    except RestorePathUnsafe as error:
        raise _resumable_failure(record, error.reason, str(error) if error.details else "A restore path changed before Undo wrote it, so nothing was written there.", error) from error
    except OSError as error:
        raise _resumable_failure(record, "restore_io_failed", "Undo stopped before it finished; run Undo again to resume it.", error) from error
    except WorkspaceRestoreError as error:
        if error.reason in {"recovery_object_changed", "restore_state_ambiguous"}:
            record["state"] = "interrupted"
            restore["status"] = "interrupted"
            restore["updated_at"] = _utc_now()
            _write_required(store, root, record)
            error.details.setdefault("status", "needs_review")
        raise

    _commit_restore(record)
    _write_required(store, root, record)
    return _receipt(record)

def _resumable_failure(record: Mapping[str, Any], reason: str, message: str, error: BaseException) -> WorkspaceRestoreError:
    """A typed failure for a restore left in progress; its completed steps stay
    persisted, and the resumable preflight reports them as ``resume.receipt``."""
    completed = cast(list[str], record["restore"]["completed_inverse_step_ids"])
    return WorkspaceRestoreError(reason, message, details={
        "status": "in_progress", "error_type": type(error).__name__, "completed_count": len(completed), **getattr(error, "details", {}),
    })

def abandon_restore(
    store: WorkspaceMutationJournalStore,
    workspace_root: str | Path,
    workspace_id: str,
    change_set_id: str,
) -> dict[str, object]:
    root, record = _load_record(store, workspace_root, change_set_id)
    if record["workspace"]["workspace_id"] != workspace_id:
        raise WorkspaceRestoreError(
            "workspace_identity_mismatch",
            "Workspace identity no longer matches the recovery journal.",
        )
    restore = cast(dict[str, Any], record["restore"])
    if restore["status"] != "interrupted":
        raise WorkspaceRestoreError(
            "restore_not_interrupted", "Workspace restore is not interrupted."
        )
    now = _utc_now()
    record["state"] = "rolled_back"
    restore.update({"status": "abandoned", "updated_at": now, "completed_at": now})
    cast(dict[str, Any], record["retention"])["protected"] = False
    cast(dict[str, Any], record["wall_time"]).update(
        {"updated_at": now, "terminal_at": now}
    )
    _write_required(store, root, record)
    return _change_set_summary(record)

def restore_trash_entry(
    store: WorkspaceMutationJournalStore,
    workspace_root: str | Path,
    name: str,
    decision: Mapping[str, object] | str | None = None,
) -> dict[str, object]:
    if not isinstance(name, str) or not name or "/" in name or "\\" in name:
        raise WorkspaceRestoreError("trash_entry_invalid", "Trash entry name is invalid.")
    root = _identity(workspace_root).real_path
    root_path = Path(root)
    match = _find_trash_recovery(store, root_path, name)
    if match is None:
        raise WorkspaceRestoreError(
            "trash_entry_not_found",
            "Trash entry has no valid recorded original path.",
        )
    recovery, destination_relative = match
    source = _safe_path(root_path, cast(str, recovery["workspace_relative_path"]))
    destination = _safe_path(root_path, destination_relative)
    _assert_signature(source, cast(Mapping[str, object], recovery["signature"]), "recovery_object_changed")
    current = _signature(destination)
    conflict = current.kind != "missing"
    normalized = _single_decision(decision, conflict, destination_relative, "trash.1", name, root_path)
    outcome = cast(str, normalized["outcome"]) if normalized else "restore"
    target = destination
    protected: dict[str, object] | None = None
    if outcome == "skip":
        return {
            "name": name,
            "status": "committed",
            "restored": [],
            "skipped": [{"relative_path": destination_relative}],
            "renamed_to": [],
            "protected": [],
            "outside_undo_set": _outside_undo_set(None),
        }
    if outcome == "alternate_name":
        assert normalized is not None
        target = _safe_path(root_path, cast(str, normalized["alternate_relative_path"]))
    expected_target = current if target == destination else PathSignature("missing", 0, EMPTY_SHA256)
    try:
        with bound_workspace(root_path):
            if outcome == "protect_then_replace":
                protected = _protect_occupant(root_path, destination, name[:8], "trash.1")
            _copy_recovery_object(source, target, name[:8], 1, expected_target)
    except RestorePathUnsafe as error:
        raise WorkspaceRestoreError(error.reason, str(error) if error.details else "A restore path changed before it was written, so nothing was written there.", details=error.details) from error
    return {
        "name": name,
        "status": "committed",
        "restored": [{"relative_path": destination_relative}] if target == destination else [],
        "skipped": [],
        "renamed_to": (
            [{"relative_path": destination_relative, "restored_relative_path": _relative(root_path, target)}]
            if target != destination else []
        ),
        "protected": [protected] if protected else [],
        "outside_undo_set": _outside_undo_set(None),
        "recovery_retained": True,
    }

def _load_record(
    store: WorkspaceMutationJournalStore, workspace_root: str | Path, change_set_id: str
) -> tuple[Path, dict[str, Any]]:
    identity = _identity(workspace_root)
    loaded = store.load(identity.workspace_id, change_set_id)
    if not loaded.ok or loaded.record is None:
        reason = loaded.failure.reason if loaded.failure else "journal_not_found"
        message = loaded.failure.message if loaded.failure else "Workspace journal was not found."
        raise WorkspaceRestoreError(reason, message)
    record = copy.deepcopy(loaded.record)
    workspace = cast(Mapping[str, object], record["workspace"])
    if (
        workspace.get("workspace_id") != identity.workspace_id
        or workspace.get("fingerprint") != identity.fingerprint
    ):
        raise WorkspaceRestoreError(
            "workspace_identity_mismatch",
            "Workspace identity no longer matches the recovery journal.",
        )
    return Path(identity.real_path), record

def _identity(workspace_root: str | Path) -> Any:
    try:
        return workspace_identity(workspace_root)
    except (OSError, ValueError) as error:
        raise _failure("workspace_identity_unavailable", "Workspace identity could not be verified.", error) from error

def _verify_recovery_objects(root: Path, record: Mapping[str, Any]) -> None:
    for operation in cast(list[dict[str, Any]], record["operations"]):
        if operation["status"] in {"skipped", "planned"}:
            continue
        for recovery in cast(list[dict[str, Any]], operation["recovery_objects"]):
            path = _safe_path(root, cast(str, recovery["workspace_relative_path"]))
            _assert_signature(
                path,
                cast(Mapping[str, object], recovery["signature"]),
                "recovery_object_changed",
            )

def _inverse_plan(record: Mapping[str, Any]) -> list[dict[str, Any]]:
    plan: list[dict[str, Any]] = []
    operations = sorted(
        cast(list[dict[str, Any]], record["operations"]),
        key=lambda item: cast(int, item["sequence"]),
        reverse=True,
    )
    for operation in operations:
        if operation["status"] in {"skipped", "planned"}:
            continue
        for step in cast(list[dict[str, Any]], operation["inverse_steps"]):
            plan.append({"sequence": operation["sequence"], "operation": operation, "step": step})
    return plan

def _plan_staging(
    root: Path, record: Mapping[str, Any], plan: Sequence[Mapping[str, Any]]
) -> list[dict[str, object]]:
    moves = [item for item in plan if item["step"]["kind"] == "move_back"]
    active = {
        cast(str, item["step"]["from_relative_path"]): item
        for item in moves
        if _signature(_safe_path(root, cast(str, item["step"]["from_relative_path"])))
        == PathSignature.from_mapping(item["step"]["expected_current_signature"])
    }
    cycle_sources = set(active)
    while removable := {
        source
        for source in cycle_sources
        if cast(str, active[source]["step"]["to_relative_path"]) not in cycle_sources
    }:
        cycle_sources.difference_update(removable)
    cycle_moves = [active[source] for source in cycle_sources]
    if not cycle_moves:
        return []
    existing = {
        item["inverse_step_id"]: item
        for item in cast(list[dict[str, Any]], record["restore"]["staging_entries"])
    }
    staging: list[dict[str, object]] = []
    short = cast(str, record["change_set_id"]).replace("-", "")[:8]
    for item in cycle_moves:
        step = cast(dict[str, Any], item["step"])
        step_id = cast(str, step["step_id"])
        if step_id in existing:
            staging.append(copy.deepcopy(existing[step_id]))
            continue
        source_relative = cast(str, step["from_relative_path"])
        parent = Path(source_relative).parent.as_posix()
        filename = f".jenny-restore-{short}-{item['sequence']}-{secrets.token_hex(4)}"
        relative = filename if parent == "." else f"{parent}/{filename}"
        if _signature(_safe_path(root, relative)).kind != "missing":
            raise WorkspaceRestoreError("restore_stage_collision", "Restore staging path is occupied.")
        staging.append(
            {
                "inverse_step_id": step_id,
                "stage_relative_path": relative,
                "expected_signature": copy.deepcopy(step["expected_current_signature"]),
            }
        )
    return staging

def _preflight_conflicts(root: Path, plan: Sequence[Mapping[str, Any]], staging: Sequence[Mapping[str, Any]], decisions: Mapping[str, Mapping[str, Any]] | None = None) -> list[dict[str, object]]:
    """Conflicts against the state each step meets; a kept path (skip, alternate name) stays as on disk."""
    virtual: dict[str, PathSignature] = {}
    stage_by_id = {cast(str, item["inverse_step_id"]): item for item in staging}
    move_sources = {
        cast(str, item["step"]["from_relative_path"])
        for item in plan
        if item["step"]["kind"] == "move_back"
    }
    conflicts: list[dict[str, object]] = []
    for item in plan:
        step = cast(dict[str, Any], item["step"])
        kind = cast(str, step["kind"])
        if kind == "remove_empty_parent":
            continue
        source_relative = cast(str, step["from_relative_path"] or "")
        destination_relative = cast(str, step["to_relative_path"] or "")
        expected = PathSignature.from_mapping(step["expected_current_signature"])
        stage = stage_by_id.get(cast(str, step["step_id"]))
        stage_current = (
            _signature(_safe_path(root, cast(str, stage["stage_relative_path"])))
            if stage is not None
            else None
        )
        source_current = (
            stage_current
            if stage_current is not None and stage_current.kind != "missing"
            else (
                _signature(_safe_path(root, source_relative))
                if stage is not None
                else _virtual_signature(root, virtual, source_relative)
            )
        )
        reasons: list[str] = []
        if kind != "restore_object" and source_current != expected:
            reasons.append("source_changed")
        if kind in {"restore_object", "move_back"}:
            destination_current = _virtual_signature(root, virtual, destination_relative)
            internal_move_target = (
                kind == "move_back"
                and cast(str, step["step_id"]) in stage_by_id
                and destination_relative in move_sources
            )
            if not internal_move_target and destination_current.kind != "missing":
                if kind == "restore_object" and destination_current == expected:
                    pass
                else:
                    reasons.append("destination_occupied")
            elif kind == "restore_object" and expected.kind != "missing":  # A19-F6: the edited file is gone
                reasons.append("destination_missing")
        if reasons:
            conflicts.append(
                {
                    "inverse_step_id": step["step_id"],
                    "sequence": item["sequence"],
                    "kind": kind,
                    "relative_path": destination_relative or source_relative,
                    "reasons": reasons,
                    "expected_signature": expected.as_dict(),
                    "current_signature": source_current.as_dict(),
                    "allowed_outcomes": list(ALLOWED_OUTCOMES),
                }
            )
        _apply_virtual_inverse(root, virtual, step, (decisions or {}).get(cast(str, step["step_id"])))
    return conflicts

def _dependent_skips(
    root: Path, plan: Sequence[Mapping[str, Any]], staging: Sequence[Mapping[str, Any]],
    decisions: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    """Skips for older steps that conflict only because a kept file was not
    undone (A19-F5): they depend on the skipped same-file transition."""
    derived: list[dict[str, object]] = []
    while True:
        decided = {cast(str, item["inverse_step_id"]): item for item in [*decisions, *derived]}
        new = [item for item in _preflight_conflicts(root, plan, staging, decided) if item["inverse_step_id"] not in decided]
        if not new:
            return derived
        derived += [{"inverse_step_id": item["inverse_step_id"], "outcome": "skip", "alternate_relative_path": None} for item in new]

def _apply_virtual_inverse(
    root: Path, virtual: dict[str, PathSignature], step: Mapping[str, Any],
    decision: Mapping[str, Any] | None = None,
) -> None:
    kind = cast(str, step["kind"])
    source = cast(str, step["from_relative_path"] or "")
    destination = cast(str, step["to_relative_path"] or "")
    missing = PathSignature("missing", 0, EMPTY_SHA256)
    outcome = decision["outcome"] if decision else None
    if outcome == "skip" or (outcome == "alternate_name" and kind not in {"remove_created", "move_back"}):
        return
    if outcome == "alternate_name":
        virtual[source] = missing  # the source moved to the alternate name
    elif kind in {"remove_created", "remove_empty_parent"}:
        virtual[source] = missing
    elif kind == "move_back":
        value = PathSignature.from_mapping(step["expected_current_signature"])
        virtual[source] = missing
        virtual[destination] = value
    elif kind == "restore_object":
        virtual[destination] = _signature(_safe_path(root, source))

def _normalize_decisions(
    decisions: Sequence[Mapping[str, object]] | Mapping[str, object] | None,
    conflicts: Sequence[Mapping[str, object]],
    change_set_id: str,
    root: Path,
) -> list[dict[str, object]]:
    if decisions is None:
        candidates: list[Mapping[str, object]] = []
    elif isinstance(decisions, Mapping):
        candidates = [
            {"inverse_step_id": key, **(value if isinstance(value, Mapping) else {"outcome": value})}
            for key, value in decisions.items()
        ]
    else:
        candidates = list(decisions)
    by_id = {str(item.get("inverse_step_id") or ""): item for item in candidates}
    required = {cast(str, item["inverse_step_id"]) for item in conflicts}
    if set(by_id) != required:
        raise WorkspaceRestoreError(
            "restore_decisions_incomplete",
            "Every restore conflict requires one explicit outcome.",
            details={"required_inverse_step_ids": sorted(required)},
        )
    normalized: list[dict[str, object]] = []
    for conflict in conflicts:
        step_id = cast(str, conflict["inverse_step_id"])
        candidate = by_id[step_id]
        outcome = str(candidate.get("outcome") or "")
        if outcome not in ALLOWED_OUTCOMES:
            raise WorkspaceRestoreError("restore_decision_invalid", "Restore decision is invalid.")
        alternate: str | None = None
        if outcome == "alternate_name":
            alternate = _alternate_relative_path(
                root,
                cast(str, conflict["relative_path"]),
                change_set_id,
            )
        normalized.append(
            {
                "inverse_step_id": step_id,
                "outcome": outcome,
                "alternate_relative_path": alternate,
            }
        )
    return normalized

def _single_decision(  # noqa: PLR0913
    decision: Mapping[str, object] | str | None,
    conflict: bool,
    destination_relative: str,
    step_id: str,
    short_id: str,
    root: Path,
) -> dict[str, object] | None:
    if not conflict:
        return None
    candidate: dict[str, object] = (
        {"outcome": decision}
        if isinstance(decision, str)
        else {str(key): value for key, value in (decision or {}).items()}
    )
    outcome = str(candidate.get("outcome") or "")
    if outcome not in ALLOWED_OUTCOMES:
        raise WorkspaceRestoreError(
            "restore_decisions_incomplete",
            "The occupied trash destination requires an explicit outcome.",
        )
    alternate = (
        _alternate_relative_path(root, destination_relative, short_id)
        if outcome == "alternate_name"
        else None
    )
    return {"inverse_step_id": step_id, "outcome": outcome, "alternate_relative_path": alternate}

def _execute_missing_steps(  # noqa: PLR0913
    store: WorkspaceMutationJournalStore,
    root: Path,
    record: dict[str, Any],
    plan: Sequence[Mapping[str, Any]],
    staging: Sequence[Mapping[str, Any]],
    callback: Callable[[str], None] | None,
) -> None:
    restore = cast(dict[str, Any], record["restore"])
    completed = cast(list[str], restore["completed_inverse_step_ids"])
    stage_by_id = {cast(str, item["inverse_step_id"]): item for item in staging}
    decisions = _decision_map(record)
    for item in plan:
        step = cast(dict[str, Any], item["step"])
        step_id = cast(str, step["step_id"])
        if step_id in completed:
            continue
        decision = decisions.get(step_id)
        if decision is not None and decision["outcome"] == "protect_then_replace":
            occupants = cast(list[dict[str, Any]], restore["protected_occupants"])
            marker = f"-{step_id.replace('.', '-')}-"
            target_relative = cast(str, step["to_relative_path"] or step["from_relative_path"])
            protected = next(
                (entry for entry in occupants if marker in str(entry["object_id"])),
                None,
            )
            if protected is None and _signature(_safe_path(root, target_relative)).kind == "missing":
                pass  # A missing destination has no occupant to protect.
            elif protected is None:
                protected = _protect_occupant(
                    root,
                    _safe_path(root, target_relative),
                    cast(str, record["change_set_id"]).replace("-", "")[:8],
                    step_id,
                )
                occupants.append(protected)
                _sync_retention(record)
                restore["updated_at"] = _utc_now()
                _write_required(store, root, record)
            else:
                _assert_signature(
                    _safe_path(root, cast(str, protected["workspace_relative_path"])),
                    cast(Mapping[str, object], protected["signature"]),
                    "recovery_object_changed",
                )
                current = _signature(_safe_path(root, target_relative))
                expected = PathSignature.from_mapping(protected["signature"])
                if current.kind != "missing" and current != expected:
                    raise WorkspaceRestoreError(
                        "restore_state_ambiguous",
                        "Restore occupant changed after protection and requires review.",
                    )
        outcome = _execute_step(root, record, step, stage_by_id.get(step_id), decision)
        completed.append(step_id)
        cast(dict[str, Any], item["operation"])["restore_outcome"] = outcome
        restore["updated_at"] = _utc_now()
        _write_required(store, root, record)
        if callback is not None:
            callback(step_id)

def _execute_step(  # noqa: C901, PLR0912
    root: Path,
    record: dict[str, Any],
    step: Mapping[str, Any],
    stage: Mapping[str, Any] | None,
    decision: Mapping[str, Any] | None,
) -> str:
    kind = cast(str, step["kind"])
    outcome = cast(str, decision["outcome"]) if decision else "restored"
    source_relative = cast(str, step["from_relative_path"] or "")
    destination_relative = cast(str, step["to_relative_path"] or "")
    source = _safe_path(root, source_relative) if source_relative else root
    if stage is not None:
        source = _safe_path(root, cast(str, stage["stage_relative_path"]))
    target = _safe_path(root, destination_relative) if destination_relative else source
    if outcome == "skip":
        if stage is not None and _signature(source).kind != "missing":
            original = _safe_path(root, source_relative)
            if _signature(original).kind != "missing":
                raise WorkspaceRestoreError(
                    "restore_state_ambiguous",
                    "Restore staging source destination became occupied.",
                )
            _guarded_replace(source, original)
        return "skipped"
    if outcome == "alternate_name":
        assert decision is not None
        target = _safe_path(root, cast(str, decision["alternate_relative_path"]))
    elif outcome == "protect_then_replace":
        _remove_exact(target)
    if kind == "remove_empty_parent":
        expected = PathSignature.from_mapping(step["expected_current_signature"])
        if _signature(source) != expected:
            return "skipped"
        try:
            _guarded_rmdir(source)
        except OSError:
            return "skipped"
    elif kind == "remove_created":
        if decision is None:
            _assert_signature(source, step["expected_current_signature"], "restore_state_ambiguous")
        if outcome == "alternate_name":
            make_parents(target)
            _guarded_replace(source, target)
        else:
            _remove_exact(source)
    elif kind == "restore_object":
        recovery_signature = _recovery_signature(record, cast(str, step["recovery_object_id"]))
        _assert_signature(source, recovery_signature, "recovery_object_changed")
        if decision is None:
            _assert_signature(target, step["expected_current_signature"], "restore_state_ambiguous")
        expected_target = (
            PathSignature.from_mapping(step["expected_current_signature"])
            if decision is None
            else PathSignature("missing", 0, EMPTY_SHA256)
        )
        _copy_recovery_object(source, target, cast(str, record["change_set_id"])[:8], int(str(step["step_id"]).split(".")[0]), expected_target)
    elif kind == "move_back":
        expected_source = stage["expected_signature"] if stage is not None else step["expected_current_signature"]
        _assert_signature(source, expected_source, "restore_state_ambiguous")
        make_parents(target)
        if _signature(target).kind != "missing":
            raise WorkspaceRestoreError("restore_state_ambiguous", "Restore destination changed after preflight.")
        _guarded_replace(source, target)
    else:
        raise WorkspaceRestoreError("inverse_step_invalid", "Restore plan contains an unknown step.")
    return {
        "alternate_name": "alternate_name",
        "protect_then_replace": "protected_then_replaced",
    }.get(outcome, "restored")

def _protect_occupant(root: Path, occupant: Path, short: str, step_id: str) -> dict[str, object]:
    if _signature(occupant).kind == "missing":
        raise WorkspaceRestoreError("restore_state_ambiguous", "Restore occupant disappeared after review.")
    safe_step = step_id.replace(".", "-")
    name = f"protected-{short}-{safe_step}-{secrets.token_hex(4)}"
    destination = _safe_path(root, f".jenny/backups/{name}")
    _copy_exclusive(occupant, destination)
    signature = _signature(destination)
    return {
        "object_id": f"backup:{name}",
        "store_kind": "backup",
        "workspace_relative_path": _relative(root, destination),
        "role": "protected_occupant",
        "signature": signature.as_dict(),
    }

def _copy_recovery_object(
    source: Path, target: Path, short: str, sequence: int, expected_target: PathSignature | None
) -> None:
    # Staged beside the target through the guarded primitive, then committed by
    # a rename under the same pinned-parent check; never by pathname alone.
    make_parents(target)
    temp = target.parent / f".jenny-restore-{short}-{sequence}-{secrets.token_hex(4)}"
    _copy_exclusive(source, temp)
    try:
        if expected_target is not None and _signature(target) != expected_target:
            raise WorkspaceRestoreError("restore_state_ambiguous", "Restore target changed during recovery.")
        if temp.is_dir() and target.is_dir():  # preserve capped source layout.
            _remove_exact(target)
        _guarded_replace(temp, target)
    except BaseException:
        try:
            _remove_exact(temp)
        except (OSError, RestorePathUnsafe):
            pass  # A temp behind a changed parent is left in place, never chased.
        raise

def _copy_exclusive(source: Path, destination: Path) -> None:
    try:
        copy_new(source, destination)
    except ValueError as error:
        raise WorkspaceRestoreError("recovery_object_unsupported", "Recovery object type is unsupported.") from error
    except ToolExecutionFailure as error:  # MAX_RESTORE_FILE_BYTES, refused before reading
        if error.code != CMP_TOOL_CAP_EXCEEDED:
            raise
        raise WorkspaceRestoreError("recovery_object_too_large", error.message) from error

def _commit_restore(record: dict[str, Any]) -> None:
    restore = cast(dict[str, Any], record["restore"])
    now = _utc_now()
    restore["status"] = "committed"
    restore["updated_at"] = now
    restore["completed_at"] = now
    record["state"] = "rolled_back"
    record["termination_reason"] = "restore_completed"
    record["completed_sequences"] = []
    cast(dict[str, Any], record["retention"])["protected"] = False
    outcomes = [
        str(item["restore_outcome"] or "restored")
        for item in record["operations"]
        if item["status"] not in {"skipped", "planned"}
    ]
    for operation in cast(list[dict[str, Any]], record["operations"]):
        if operation["status"] not in {"skipped", "planned"}:
            operation["status"] = "undone"
    restore["partial_result"] = {
        "restored": outcomes.count("restored"),
        "skipped": outcomes.count("skipped"),
        "alternate_name": outcomes.count("alternate_name"),
        "protected_then_replaced": outcomes.count("protected_then_replaced"),
        "conflicts": len(cast(list[object], restore["decisions"])),
        "warning": str(record["coverage"]["warning"])[:512],
    }

def _receipt(record: Mapping[str, Any], *, only: set[str] | None = None) -> dict[str, object]:
    restore = cast(Mapping[str, Any], record["restore"])
    decisions = cast(list[dict[str, Any]], restore["decisions"])
    decision_by_id = {item["inverse_step_id"]: item for item in decisions}
    restored: list[dict[str, object]] = []
    skipped: list[dict[str, object]] = []
    renamed: list[dict[str, object]] = []
    root = Path(cast(str, record["workspace"]["real_path"]))
    for item in _inverse_plan(record):
        step = cast(dict[str, Any], item["step"])
        step_id = step["step_id"]
        if only is not None and step_id not in only:
            continue
        relative = step["to_relative_path"] or step["from_relative_path"]
        decision = decision_by_id.get(step_id)
        parent_cleanup_skipped = (
            step["kind"] == "remove_empty_parent"
            and _signature(_safe_path(root, cast(str, relative))).kind != "missing"
        )
        if parent_cleanup_skipped or (decision and decision["outcome"] == "skip"):
            skipped.append({"inverse_step_id": step_id, "relative_path": relative})
        elif decision and decision["outcome"] == "alternate_name":
            renamed.append(
                {
                    "inverse_step_id": step_id,
                    "relative_path": relative,
                    "restored_relative_path": decision["alternate_relative_path"],
                }
            )
        else:
            restored.append({"inverse_step_id": step_id, "relative_path": relative})
    protected = [
        {
            "object_id": item["object_id"],
            "workspace_relative_path": item["workspace_relative_path"],
            "signature": copy.deepcopy(item["signature"]),
        }
        for item in cast(list[dict[str, Any]], restore["protected_occupants"])
    ]
    return {
        "change_set_id": record["change_set_id"],
        "status": restore["status"],
        "restored": restored,
        "skipped": skipped,
        "renamed_to": renamed,
        "protected": protected,
        "outside_undo_set": _outside_undo_set(record),
    }

def _find_trash_recovery(
    store: WorkspaceMutationJournalStore, root: Path, name: str
) -> tuple[dict[str, Any], str] | None:
    """The newest change set recording ``name`` in the trash decides; one load per set until then."""
    identity = _identity(root)
    prefix = f".jenny/trash/{name}/"
    exact = f".jenny/trash/{name}"
    for change_set_id in _newest_change_set_ids(store, identity.workspace_id):
        loaded = store.load(identity.workspace_id, change_set_id)
        if not loaded.ok or loaded.record is None:
            continue
        matches: list[tuple[dict[str, Any], str]] = []
        for operation in cast(list[dict[str, Any]], loaded.record["operations"]):
            for recovery in cast(list[dict[str, Any]], operation["recovery_objects"]):
                path = cast(str, recovery["workspace_relative_path"])
                if recovery["store_kind"] != "trash" or not (path == exact or path.startswith(prefix)):
                    continue
                for step in cast(list[dict[str, Any]], operation["inverse_steps"]):
                    if step["recovery_object_id"] == recovery["object_id"] and step["to_relative_path"]:
                        matches.append((recovery, cast(str, step["to_relative_path"])))
        if len(matches) > 1:
            raise WorkspaceRestoreError("trash_entry_ambiguous", "Trash entry maps to multiple original paths.")
        if matches:
            return matches[0]
    return None

def _decision_map(record: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        cast(str, item["inverse_step_id"]): item
        for item in cast(list[dict[str, Any]], record["restore"]["decisions"])
    }

def _recovery_signature(record: Mapping[str, Any], object_id: str) -> Mapping[str, object]:
    for operation in cast(list[dict[str, Any]], record["operations"]):
        for recovery in cast(list[dict[str, Any]], operation["recovery_objects"]):
            if recovery["object_id"] == object_id:
                return cast(Mapping[str, object], recovery["signature"])
    raise WorkspaceRestoreError("recovery_object_missing", "Restore recovery object is not declared.")

def _alternate_relative_path(root: Path, relative: str, change_set_id: str) -> str:
    path = Path(relative)
    short = change_set_id.replace("-", "")[:8]
    for index in range(1, 10_001):
        name = f"{path.stem}.jenny-restored-{short}-{index}{path.suffix}"
        candidate = path.with_name(name).as_posix()
        if _signature(_safe_path(root, candidate)).kind == "missing":
            return candidate
    raise WorkspaceRestoreError("alternate_name_exhausted", "No available alternate restore name was found.")

def _safe_path(root: Path, relative: str) -> Path:
    validation = validate_relative_path(relative)
    if not validation.ok:
        raise WorkspaceRestoreError("journal_path_invalid", "Recovery path is invalid.")
    candidate = root.joinpath(*relative.split("/"))
    try:
        resolved = candidate.resolve(strict=False)
        resolved.relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise _failure("journal_path_escaped", "Recovery path escaped the workspace.", error) from error
    current = root
    for part in Path(relative).parts[:-1]:
        current /= part
        if current.exists() and (current.is_symlink() or _is_junction(current)):
            raise WorkspaceRestoreError("journal_path_unsafe", "Recovery path contains an unsafe link.")
    return candidate

def _signature(path: Path) -> PathSignature:
    result = signature_for_path(path)
    if not result.ok or result.signature is None:
        raise WorkspaceRestoreError("signature_failed", "Workspace signature could not be completed.")
    return result.signature

def _assert_signature(path: Path, expected: Mapping[str, object], reason: str) -> None:
    if _signature(path) != PathSignature.from_mapping(expected):
        raise WorkspaceRestoreError(reason, "Recovery object signature verification failed.")

def _virtual_signature(
    root: Path, virtual: dict[str, PathSignature], relative: str
) -> PathSignature:
    if relative not in virtual:
        virtual[relative] = _signature(_safe_path(root, relative))
    return virtual[relative]

def _sync_retention(record: dict[str, Any]) -> None:
    objects: dict[str, dict[str, Any]] = {}
    for operation in cast(list[dict[str, Any]], record["operations"]):
        for recovery in cast(list[dict[str, Any]], operation["recovery_objects"]):
            objects[cast(str, recovery["object_id"])] = recovery
    for recovery in cast(list[dict[str, Any]], record["restore"]["protected_occupants"]):
        objects[cast(str, recovery["object_id"])] = recovery
    retention = cast(dict[str, Any], record["retention"])
    retention["referenced_object_ids"] = sorted(objects)
    retention["reserved_entries"] = len(objects)
    retention["reserved_bytes"] = sum(cast(int, item["signature"]["byte_size"]) for item in objects.values())

def _write_required(
    store: WorkspaceMutationJournalStore, root: Path, record: Mapping[str, Any]
) -> None:
    result = store.write_transition(record, workspace_root=root)
    if not result.ok:
        reason = result.failure.reason if result.failure else "journal_write_failed"
        message = result.failure.message if result.failure else "Workspace journal write failed."
        raise WorkspaceRestoreError(reason, message)

def _partial_result(conflicts: int, record: Mapping[str, Any]) -> dict[str, object]:
    return {
        "restored": 0,
        "skipped": 0,
        "alternate_name": 0,
        "protected_then_replaced": 0,
        "conflicts": conflicts,
        "warning": str(record["coverage"]["warning"])[:512],
    }

def _outside_undo_set(record: Mapping[str, Any] | None) -> dict[str, object]:
    events = [] if record is None else list(record["coverage"]["known_unjournaled_events"])
    warning = (
        "Approved shell mutations and Explorer renames may be outside this recovery set."
        if record is None
        else str(record["coverage"]["warning"])
    )
    return {
        "shell_mutations": "not_journaled_approval_gated",
        "explorer_rename": "not_journaled_until_wo_27_item_2",
        "known_unjournaled_events": events,
        "warning": warning[:512],
    }

def _change_set_summary(record: Mapping[str, Any]) -> dict[str, object]:
    return {
        "change_set_id": record["change_set_id"],
        "state": record["state"],
        "session_id": record["session_id"], "turn_id": record["turn_id"],  # a suggested-change apply's id
        "restore_status": record["restore"]["status"],
        "operation_count": record["operation_count"],
        "updated_at": record["wall_time"]["updated_at"],
        # When the undo finished; retention touches move updated_at.
        "restore_completed_at": record["restore"]["completed_at"],
        "partially_undoable": record["coverage"]["partially_undoable"],
        "warning": record["coverage"]["warning"],
    }

def _public_step(item: Mapping[str, Any]) -> dict[str, object]:
    step = cast(Mapping[str, Any], item["step"])
    return {
        "sequence": item["sequence"],
        "inverse_step_id": step["step_id"],
        "kind": step["kind"],
        "from_relative_path": step["from_relative_path"],
        "to_relative_path": step["to_relative_path"],
        "expected_current_signature": copy.deepcopy(step["expected_current_signature"]),
    }

def _relative(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()

def _is_junction(path: Path) -> bool:
    checker = getattr(os_path, "isjunction", None)
    return bool(checker(path)) if checker is not None else False

def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def _failure(reason: str, message: str, error: BaseException) -> WorkspaceRestoreError:
    return WorkspaceRestoreError(reason, message, details={"error_type": type(error).__name__})

__all__ = ["ALLOWED_OUTCOMES", "WorkspaceRestoreError", "abandon_restore",
           "list_change_sets", "preflight_undo", "restore_trash_entry", "undo_change_set"]
