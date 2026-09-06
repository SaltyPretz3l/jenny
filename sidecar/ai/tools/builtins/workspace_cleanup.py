"""Bounded cleanup for guarded workspace-local generated state."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, WorkspaceStoreKind
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

TOOL_RESULTS_MAX_AGE_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class CleanupResult:
    tool_results_removed: int = 0
    artifact_sessions_found: int = 0


def cleanup_workspace_artifacts(
    workspace: Path | GuardedWorkspaceStore | None,
) -> CleanupResult:
    """Prune stale generated state without following workspace link objects."""

    if workspace is None:
        return CleanupResult()
    try:
        store = (
            workspace
            if isinstance(workspace, GuardedWorkspaceStore)
            else GuardedWorkspaceStore(workspace)
        )
    except ToolExecutionFailure as error:
        _log_cleanup_failure("store_open", error)
        return CleanupResult()
    try:
        tool_results_removed = _prune_stale_tool_results(store)
    except ToolExecutionFailure as error:
        _log_cleanup_failure("tool_results", error)
        tool_results_removed = 0
    try:
        artifact_sessions_found = _report_artifact_sessions(store)
    except ToolExecutionFailure as error:
        _log_cleanup_failure("artifacts", error)
        artifact_sessions_found = 0
    return CleanupResult(
        tool_results_removed=tool_results_removed,
        artifact_sessions_found=artifact_sessions_found,
    )


def _prune_stale_tool_results(
    store: GuardedWorkspaceStore,
    *,
    now: float | None = None,
) -> int:
    """Remove tool-result entries older than the configured max age."""

    parent = store.resolve(WorkspaceStoreKind.TOOL_RESULTS)
    cutoff = (time.time() if now is None else now) - TOOL_RESULTS_MAX_AGE_SECONDS
    removed = 0
    for entry in store.list_entries(parent):
        try:
            status = (
                store.stat(store.child(entry.ref, "status.json"))
                if entry.is_directory
                else None
            )
        except ToolExecutionFailure as error:
            _log_cleanup_failure("tool_result_status", error)
            continue
        mtime_ns = status.mtime_ns if status is not None else entry.mtime_ns
        if (mtime_ns / 1_000_000_000) >= cutoff:
            continue
        try:
            outcome = store.delete(entry.ref, recursive=entry.is_directory)
        except ToolExecutionFailure:
            logger.warning(
                "failed to prune a stale workspace tool-result entry",
                exc_info=True,
            )
            continue
        if outcome.removed:
            removed += 1
    if removed:
        logger.debug("Pruned %d stale workspace tool-result entries", removed)
    return removed


def _log_cleanup_failure(stage: str, error: ToolExecutionFailure) -> None:
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.workspace_cleanup",
        event="ai.tools.workspace_cleanup.stage_failed",
        message="A guarded workspace cleanup stage was skipped",
        status="degraded",
        data={"stage": stage, "error_code": error.code},
    )


def _report_artifact_sessions(store: GuardedWorkspaceStore) -> int:
    """Report artifact session directories as telemetry.

    Electron owns generated-artifact references. The sidecar cannot prove a
    directory is unreferenced and therefore must not delete it.
    """

    parent = store.resolve(WorkspaceStoreKind.ARTIFACTS)
    found = sum(1 for entry in store.list_entries(parent) if entry.is_directory)
    if found:
        log_event(
            logger,
            logging.DEBUG,
            component="ai.tools.workspace_cleanup",
            event="ai.tools.workspace_cleanup.artifact_sessions_reported",
            message="Artifact session directories counted; retention is Electron-owned",
            status="ok",
            data={"artifact_sessions_found": found},
        )
    return found


__all__ = [
    "CleanupResult",
    "TOOL_RESULTS_MAX_AGE_SECONDS",
    "cleanup_workspace_artifacts",
]
