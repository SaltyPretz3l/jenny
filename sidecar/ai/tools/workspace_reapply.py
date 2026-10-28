"""Redo for workspace recovery: re-arm an undone change set on mutation journal v1.

Split out of workspace_restore.py at its size cap; it reuses that module's
record, plan and write helpers, as workspace_restore_staging does.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from sidecar.ai.tools.workspace_mutation_journal_contract import PathSignature
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_restore import (
    MAX_LISTED_CHANGE_SETS,
    WorkspaceRestoreError,
    _apply_virtual_inverse,
    _assert_no_other_active_set,
    _change_set_summary,
    _inverse_plan,
    _load_record,
    _plan_staging,
    _preflight_conflicts,
    _safe_path,
    _signature,
    _sync_retention,
    _utc_now,
    _verify_recovery_objects,
    _virtual_signature,
    _write_required,
)


def reapply_change_set(
    store: WorkspaceMutationJournalStore, workspace_root: str | Path, change_set_id: str
) -> dict[str, object]:
    """Re-arm an undone change set whose post-apply bytes are back on disk.

    The Changes view's Redo writes the bytes back from its own safety copy;
    this only records that, after verifying every touched path matches the
    change set's post-apply content, so a later undo runs from the journal.
    Any failed check refuses and writes nothing.
    """
    root, record = _load_record(store, workspace_root, change_set_id)
    restore = cast(dict[str, Any], record["restore"])
    if record["state"] != "rolled_back" or restore["status"] != "committed":
        raise WorkspaceRestoreError(
            "change_set_not_reapplicable",
            "Only an undone workspace change set can be re-applied.",
        )
    _assert_no_other_active_set(store, root, change_set_id)
    # Re-arming drops the copies this undo kept of what it replaced, so each
    # protected file must already be back on disk (the Redo safety copy).
    protected = _protected_paths(root, record)
    if protected is None:
        raise WorkspaceRestoreError(
            "reapply_protected_occupants",
            "This undo protected files it replaced, so it cannot be re-applied.",
        )
    rearmed = copy.deepcopy(record)
    now = _utc_now()
    for operation in cast(list[dict[str, Any]], rearmed["operations"]):
        if operation["status"] == "undone":
            operation["status"] = "applied"
            operation["restore_outcome"] = None
    rearmed["state"] = "committed"
    rearmed["completed_sequences"] = sorted(
        cast(int, operation["sequence"])
        for operation in cast(list[dict[str, Any]], rearmed["operations"])
        if operation["status"] == "applied"
    )
    # The journal schema has no reapplied_at field: a not_requested restore
    # with updated_at set records when it was re-applied.
    rearmed["restore"] = {
        "status": "not_requested",
        "requested_at": None,
        "updated_at": now,
        "completed_at": None,
        "completed_inverse_step_ids": [],
        "decisions": [],
        "staging_entries": [],
        "protected_occupants": [],
        "partial_result": None,
    }
    cast(dict[str, Any], rearmed["retention"])["protected"] = True
    cast(dict[str, Any], rearmed["wall_time"])["updated_at"] = now
    _verify_recovery_objects(root, rearmed)
    plan = _inverse_plan(rearmed)
    mismatched = _reapply_mismatches(root, plan, _plan_staging(root, rearmed, plan), set(protected))
    if mismatched:
        raise WorkspaceRestoreError(
            "reapply_state_mismatch",
            "Workspace files no longer match this change set, so it was not re-applied.",
            details={"relative_paths": mismatched[:MAX_LISTED_CHANGE_SETS]},
        )
    _sync_retention(rearmed)
    _write_required(store, root, rearmed)
    return _change_set_summary(rearmed)


def _protected_paths(root: Path, record: Mapping[str, Any]) -> dict[str, PathSignature] | None:
    """Each protected occupant's path, when it holds that occupant's bytes again; else None."""
    steps = [cast(Mapping[str, Any], item["step"]) for item in _inverse_plan(record)]
    paths: dict[str, PathSignature] = {}
    for occupant in cast(list[dict[str, Any]], record["restore"]["protected_occupants"]):
        object_id = str(occupant["object_id"])
        step = next(
            (item for item in steps if f"-{str(item['step_id']).replace('.', '-')}-" in object_id),
            None,
        )
        if step is None:
            return None
        relative = cast(str, step["to_relative_path"] or step["from_relative_path"])
        expected = PathSignature.from_mapping(occupant["signature"])
        if _signature(_safe_path(root, relative)) != expected:
            return None
        paths[relative] = expected
    return paths


def _reapply_mismatches(
    root: Path,
    plan: Sequence[Mapping[str, Any]],
    staging: Sequence[Mapping[str, Any]],
    protected: set[str],
) -> list[str]:
    """Paths where the disk is not the change set's post-apply state.

    Stricter than the undo preflight: a restore_object target must hold the
    exact post-apply signature, where undo accepts a missing target. A
    ``protected`` path holds the occupant the undo replaced (checked by the
    caller): re-armed, it reads as that same conflict again.
    """
    paths = {
        cast(str, conflict["relative_path"])
        for conflict in _preflight_conflicts(root, plan, staging)
    } - protected
    virtual: dict[str, PathSignature] = {}
    for item in plan:
        step = cast(Mapping[str, Any], item["step"])
        if step["kind"] == "restore_object":
            destination = cast(str, step["to_relative_path"] or "")
            expected = PathSignature.from_mapping(step["expected_current_signature"])
            current = _virtual_signature(root, virtual, destination)
            if destination not in protected and current != expected:
                paths.add(destination)
        _apply_virtual_inverse(root, virtual, step)
    return sorted(paths)


__all__ = ["reapply_change_set"]
