"""JSON-RPC handlers for user-initiated workspace recovery."""
# ruff: noqa: E501, PLR0911, PLR0913

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH, CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_restore import (
    WorkspaceRestoreError,
    abandon_restore,
    list_change_sets,
    preflight_undo,
    restore_trash_entry,
    undo_change_set,
)
from sidecar.ai.tools.workspace_retention import (
    WorkspaceRetentionError,
    acknowledge_recovery_review,
    list_recovery_review,
)
from sidecar.protocol import (
    WORKSPACE_ABANDON_RESTORE_METHOD,
    WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD,
    WORKSPACE_LIST_CHANGE_SETS_METHOD,
    WORKSPACE_LIST_RECOVERY_REVIEW_METHOD,
    WORKSPACE_PREFLIGHT_UNDO_METHOD,
    WORKSPACE_RESTORE_TRASH_ENTRY_METHOD,
    WORKSPACE_UNDO_CHANGE_SET_METHOD,
)
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_method_version

INVALID_PARAMS_CODE = -32602
RECOVERY_ERROR_CODE = -32004
_METHODS = frozenset(
    {
        WORKSPACE_LIST_CHANGE_SETS_METHOD,
        WORKSPACE_PREFLIGHT_UNDO_METHOD,
        WORKSPACE_UNDO_CHANGE_SET_METHOD,
        WORKSPACE_RESTORE_TRASH_ENTRY_METHOD,
        WORKSPACE_LIST_RECOVERY_REVIEW_METHOD,
        WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD,
        WORKSPACE_ABANDON_RESTORE_METHOD,
    }
)


def process_workspace_recovery_method(
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: Any,
    logger: logging.Logger,
) -> ProcessOutcome | None:
    """Dispatch one known recovery request; unknown methods return ``None``."""

    if method not in _METHODS:
        return None
    version_error = validate_method_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=CMP_PROTO_VERSION_MISMATCH,
    )
    if version_error is not None:
        return _outcome(version_error, initialized)
    if message_id is None:
        return _outcome(None, initialized)
    if not isinstance(params, dict):
        return _invalid(message_id, initialized, "params must be an object")
    try:
        workspace_root, store = _recovery_context(brain_container)
        result = _invoke(method, params, workspace_root, store)
    except (WorkspaceRestoreError, WorkspaceRetentionError) as error:
        logger.warning(
            "workspace recovery request rejected",
            extra={
                "event": "sidecar.runtime.workspace_recovery.rejected",
                "method": method,
                "reason": error.reason,
            },
        )
        return _outcome(
            error_response(
                message_id,
                code=RECOVERY_ERROR_CODE,
                message=error.message,
                data={
                    "error_code": error.code,
                    "reason": error.reason,
                    **error.details,
                },
            ),
            initialized,
        )
    except (OSError, ValueError) as error:
        logger.exception(
            "workspace recovery request failed",
            extra={
                "event": "sidecar.runtime.workspace_recovery.failed",
                "method": method,
                "error_type": type(error).__name__,
            },
        )
        return _outcome(
            error_response(
                message_id,
                code=RECOVERY_ERROR_CODE,
                message="Workspace recovery failed.",
                data={"error_code": CMP_TOOL_EXECUTION_FAILED, "reason": "workspace_recovery_failed"},
            ),
            initialized,
        )
    return _outcome(result_response(message_id, result), initialized)


def _invoke(
    method: str,
    params: dict[str, Any],
    workspace_root: Path,
    store: WorkspaceMutationJournalStore,
) -> dict[str, object]:
    if method == WORKSPACE_LIST_CHANGE_SETS_METHOD:
        return list_change_sets(store, workspace_root)
    if method == WORKSPACE_LIST_RECOVERY_REVIEW_METHOD:
        return list_recovery_review(store, workspace_root)
    if method == WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD:
        return acknowledge_recovery_review(
            store, workspace_root, _required_text(params, "change_set_id")
        )
    if method == WORKSPACE_ABANDON_RESTORE_METHOD:
        return abandon_restore(
            store,
            workspace_root,
            _required_text(params, "workspace_id"),
            _required_text(params, "change_set_id"),
        )
    if method == WORKSPACE_PREFLIGHT_UNDO_METHOD:
        return preflight_undo(store, workspace_root, _required_text(params, "change_set_id"))
    if method == WORKSPACE_UNDO_CHANGE_SET_METHOD:
        decisions = params.get("decisions")
        if decisions is not None and not isinstance(decisions, (list, dict)):
            raise WorkspaceRestoreError("restore_decisions_invalid", "decisions must be an array or object.")
        return undo_change_set(
            store,
            workspace_root,
            _required_text(params, "change_set_id"),
            decisions,
        )
    decision = params.get("decision")
    if decision is not None and not isinstance(decision, (str, dict)):
        raise WorkspaceRestoreError("restore_decision_invalid", "decision must be a string or object.")
    return restore_trash_entry(
        store,
        workspace_root,
        _required_text(params, "name"),
        decision,
    )


def _recovery_context(brain_container: Any) -> tuple[Path, WorkspaceMutationJournalStore]:
    config = brain_container.stack.config
    workspace_text = str(getattr(config, "tools_workspace_root", "") or "").strip()
    state_text = str(getattr(config, "electron_state_root", "") or "").strip()
    if not workspace_text:
        raise WorkspaceRestoreError("workspace_root_missing", "Workspace root is not configured.")
    if not state_text:
        raise WorkspaceRestoreError("recovery_root_missing", "Workspace recovery storage is unavailable.")
    return Path(workspace_text), WorkspaceMutationJournalStore(Path(state_text) / "workspace-recovery")


def _required_text(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value.strip():
        raise WorkspaceRestoreError("invalid_params", f"params.{key} is required.")
    return value.strip()


def _invalid(message_id: Any, initialized: bool, detail: str) -> ProcessOutcome:
    return _outcome(
        error_response(
            message_id,
            code=INVALID_PARAMS_CODE,
            message="workspace recovery invalid params",
            data={"reason": "invalid_params", "detail": detail},
        ),
        initialized,
    )


def _outcome(response: Any, initialized: bool) -> ProcessOutcome:
    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=response,
        notifications=[],
    )


__all__ = ["process_workspace_recovery_method"]
