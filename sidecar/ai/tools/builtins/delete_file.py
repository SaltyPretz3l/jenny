"""Reversible workspace file deletion.

Deletes are *soft*: the target is moved into ``.jenny/trash/<timestamp>/`` rather
than unlinked, so a mistaken delete by a small model is always recoverable. This
is deliberately safer than ``apply_patch``'s hard unlink or a shell ``rm``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.builtins.filesystem import failure_result
from sidecar.ai.tools.builtins.trash_maintenance import apply_trash_retention_best_effort
from sidecar.ai.tools.contracts import (
    ToolExecutionFailure,
    ToolHandlerResult,
    canonicalize_tool_arguments,
)
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_path_identity import resolve_workspace_leaf

_JENNY_DIR = ".jenny"


def delete_file_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
    normalized_arguments, _aliases = canonicalize_tool_arguments(
        tool_name="delete_file",
        arguments=arguments,
    )
    raw_path = normalized_arguments.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'path' must be a non-empty string",
            retryable=False,
        )
    recursive = normalized_arguments.get("recursive") is True

    root = workspace.require_root()
    leaf = resolve_workspace_leaf(root, raw_path)
    relative = leaf.relative_path

    if relative == _JENNY_DIR or relative.startswith(f"{_JENNY_DIR}/"):
        return failure_result(
            message=(
                f"Refusing to delete {relative}: the .jenny directory holds Jenny's "
                "backups and trash."
            ),
            metadata={"path": relative},
        )
    if leaf.is_directory and not recursive:
        return failure_result(
            message=(
                f"{relative} is a directory. Pass recursive: true to delete it and its "
                "contents."
            ),
            metadata={"path": relative},
        )

    try:
        if not leaf.is_link_object:
            workspace.ensure_safe_mutation_path(leaf.leaf_path)
    except ToolExecutionFailure as error:
        return failure_result(
            message=f"Could not delete {relative}: {error.message}",
            error_code=error.code,
            metadata={"path": relative},
        )

    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S_%f")
    # Use internal_store() and the string kind to stay under the import fan-out cap.
    store = workspace.internal_store()
    destination = store.resolve(
        "trash",
        (stamp, *Path(relative).parts),
    )
    trashed_relative = f".jenny/trash/{stamp}/{relative}"
    journal = workspace.mutation_journal
    prepared = (
        journal.prepare_delete(
            normalized_arguments,
            target=leaf.leaf_path,
            relative_path=relative,
            trash_relative_path=trashed_relative,
        )
        if journal is not None
        else None
    )
    try:
        moved = store.move_workspace_leaf_atomic(leaf, destination)
    except ToolExecutionFailure as error:
        failure_metadata: dict[str, object] = {"path": relative}
        if prepared is not None and journal is not None:
            failure_metadata["workspace_change_set"] = journal.mark_failed_sequence(
                prepared, prepared.sequences[0]
            )
        return failure_result(
            message=f"Could not delete {relative}: {error.message}",
            error_code=error.code,
            metadata=failure_metadata,
        )

    workspace_change_set = (
        journal.mark_applied(prepared) if prepared is not None and journal is not None else None
    )

    # Retention is best-effort: maintenance failure must not turn a successful
    # reversible delete into a tool failure. The newest entry is never evicted.
    apply_trash_retention_best_effort(store, is_entry_pinned=workspace.is_trash_entry_pinned)

    trashed_relative = moved.display_path
    kind = "directory" if leaf.is_directory else "file"
    return ToolHandlerResult(
        output=(
            f"Deleted {relative} (moved to {trashed_relative}). "
            "This is reversible — move it back from there to restore."
        ),
        success=True,
        metadata={
            "path": relative,
            "trashed_path": trashed_relative,
            "kind": kind,
            "recursive": recursive,
            **(
                {"workspace_change_set": workspace_change_set}
                if workspace_change_set is not None
                else {}
            ),
        },
    )
