"""Row 184 W4 (owner decision D2, 2026-11-21): what Auto runs without a card.

Python (``python_execute``, or a temp script in Python) runs without a card when the
turn has a project folder and the script's working directory is inside it.
``delete_file`` runs without a card when this turn's workspace journal created or
edited that file and the file still holds what the turn wrote, so the turn's own
change set can put it back (the delete itself also goes to ``.jenny/trash``).
Everything else keeps its card: no project folder, a directory, a link, a path
outside the folder, a file the turn did not write or that changed since by other
means, or a journal that cannot be read. Paranoid safety and strict auto are decided
by the caller (``tool_execution.approval_if_needed``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from sidecar.ai.routing.mutation_change_set_lifecycle import (
    _CURRENT_RUN,
    current_run_change_set_id,
)
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_contract import (
    PathSignature,
    signature_for_path,
    workspace_identity,
)
from sidecar.ai.tools.workspace_mutation_live_owner import run_journal_owner
from sidecar.ai.tools.workspace_path_identity import resolve_workspace_leaf

_PYTHON_TOOLS = frozenset({"python_execute", "run_temp_script"})
_WRITTEN_KINDS = frozenset({"create", "modify"})


def auto_runs_without_card(
    tool_name: str, arguments: Mapping[str, Any], execution_context: Any,
) -> bool:
    """Whether Auto may run this Python or delete call without its mandatory card."""
    try:
        if tool_name in _PYTHON_TOOLS:
            return _python_in_workspace(tool_name, arguments, execution_context)
        if tool_name == "delete_file":
            return _delete_restorable_by_turn(arguments, execution_context)
    except Exception:  # noqa: BLE001 - any doubt keeps the card.
        return False
    return False


def _bound_root(execution_context: Any) -> Path | None:
    raw = getattr(execution_context, "root_path", None)
    if not isinstance(raw, str) or not raw.strip():
        return None
    root = Path(raw)
    return root if root.is_dir() else None


def _python_in_workspace(
    tool_name: str, arguments: Mapping[str, Any], execution_context: Any,
) -> bool:
    root = _bound_root(execution_context)
    if root is None:
        return False
    cwd = arguments.get("cwd") if tool_name == "run_temp_script" else None
    if cwd is None:
        return True  # python_execute and a temp script without cwd run in the project root
    if not isinstance(cwd, str) or not cwd.strip():
        return False
    WorkspaceGuard(str(root)).resolve_list_path(cwd)  # raises outside the root or when missing
    return True


def _delete_restorable_by_turn(arguments: Mapping[str, Any], execution_context: Any) -> bool:
    raw_path = arguments.get("path", arguments.get("file_path"))
    root = _bound_root(execution_context)
    if root is None or arguments.get("recursive") is True:
        return False
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False
    leaf = resolve_workspace_leaf(root, raw_path)
    if leaf.is_directory or leaf.is_link_object:
        return False
    record = _turn_change_set(root)
    written = _last_written_signature(record, leaf.relative_path) if record else None
    if written is None:
        return False
    actual = signature_for_path(leaf.leaf_path)
    return actual.ok and actual.signature == written


def _turn_change_set(root: Path) -> Mapping[str, Any] | None:
    context = _CURRENT_RUN.get()
    change_set_id = current_run_change_set_id()
    if context is None or not change_set_id:
        return None
    owner = run_journal_owner(context.run)
    if owner is None:
        return None
    store, owner_root = owner
    if Path(owner_root).resolve() != root.resolve():
        return None
    loaded = store.load(workspace_identity(owner_root).workspace_id, change_set_id)
    record = loaded.record if loaded.ok else None
    if not isinstance(record, Mapping):
        return None
    if record.get("session_id") != context.session_id or record.get("turn_id") != context.turn_id:
        return None
    return record


def _last_written_signature(record: Mapping[str, Any], relative_path: str) -> PathSignature | None:
    """What the turn last wrote at ``relative_path``, or None once it moved or deleted it."""
    written: PathSignature | None = None
    for operation in record.get("operations") or ():
        if not isinstance(operation, Mapping) or operation.get("status") != "applied":
            continue
        for endpoint_name in ("source", "destination"):
            endpoint = operation.get(endpoint_name)
            if not isinstance(endpoint, Mapping) or endpoint.get("relative_path") != relative_path:
                continue
            if endpoint_name == "destination" and operation.get("kind") in _WRITTEN_KINDS:
                written = PathSignature.from_mapping(endpoint["post_signature"])
            else:
                written = None
    return written


__all__ = ["auto_runs_without_card"]
