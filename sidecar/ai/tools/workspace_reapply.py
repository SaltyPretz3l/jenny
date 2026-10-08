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
    _change_set_summary,
    _inverse_plan,
    _load_record,
    _plan_staging,
    _preflight_conflicts,
    _sync_retention,
    _utc_now,
    _verify_recovery_objects,
    _virtual_signature,
    _write_required,
    list_change_sets,
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
    busy_sets = cast(list[dict[str, object]], list_change_sets(store, root)["change_sets"])
    if any(
        item["change_set_id"] != change_set_id
        and item["state"] in {"prepared", "in_progress"}
        for item in busy_sets
    ):
        raise WorkspaceRestoreError(
            "restore_workspace_busy",
            "Workspace recovery is blocked while another change set is active.",
            details={"status": "busy"},
        )
    if restore["protected_occupants"]:
        # Re-arming would drop the copies this undo kept of what it replaced.
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
    mismatched = _reapply_mismatches(root, plan, _plan_staging(root, rearmed, plan))
    if mismatched:
        raise WorkspaceRestoreError(
            "reapply_state_mismatch",
            "Workspace files no longer match this change set, so it was not re-applied.",
            details={"relative_paths": mismatched[:MAX_LISTED_CHANGE_SETS]},
        )
    _sync_retention(rearmed)
    _write_required(store, root, rearmed)
    return _change_set_summary(rearmed)


def _reapply_mismatches(
    root: Path, plan: Sequence[Mapping[str, Any]], staging: Sequence[Mapping[str, Any]]
) -> list[str]:
    """Paths where the disk is not the change set's post-apply state.

    Stricter than the undo preflight: a restore_object target must hold the
    exact post-apply signature, where undo accepts a missing target.
    """
    paths = {
        cast(str, conflict["relative_path"])
        for conflict in _preflight_conflicts(root, plan, staging)
    }
    virtual: dict[str, PathSignature] = {}
    for item in plan:
        step = cast(Mapping[str, Any], item["step"])
        if step["kind"] == "restore_object":
            destination = cast(str, step["to_relative_path"] or "")
            expected = PathSignature.from_mapping(step["expected_current_signature"])
            if _virtual_signature(root, virtual, destination) != expected:
                paths.add(destination)
        _apply_virtual_inverse(root, virtual, step)
    return sorted(paths)


__all__ = ["reapply_change_set"]
