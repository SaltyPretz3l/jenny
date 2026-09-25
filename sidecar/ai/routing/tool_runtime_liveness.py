"""Request-time liveness snapshot for status-tool schema selection."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sidecar.ai.mcp.builtin_server_ledger import current_operation_ledger
from sidecar.ai.tools.builtins.shell_background import active_job_ids
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ToolRuntimeLiveness:
    has_active_background_jobs: bool = False
    has_active_monitors: bool = False
    has_pending_operations: bool = False


def _workspace_store_key(kernel: Any, request_context: Any | None) -> str | None:
    """Identity of the request's workspace store, or None without a workspace."""
    execution = getattr(request_context, "execution_context", None)
    root = getattr(execution, "root_path", None) if execution is not None else None
    if not root:
        root = getattr(getattr(kernel, "_config", None), "tools_workspace_root", None)
    if not str(root or "").strip():
        return None
    try:
        return GuardedWorkspaceStore(str(root)).cache_key
    except ToolExecutionFailure:
        return None


def snapshot_tool_runtime_liveness(
    kernel: Any, request_context: Any | None = None
) -> ToolRuntimeLiveness:
    """Capture bounded runtime state without coupling the budget filter to the kernel."""

    try:
        # Jobs are registered per workspace store (B3S-4): another workspace's
        # job must not keep the status tools in this turn's schema.
        store_key = _workspace_store_key(kernel, request_context)
        background_jobs = bool(active_job_ids(store_key=store_key)) if store_key else False
        monitor_manager = getattr(kernel, "_monitor_manager", None)
        monitor_probe = getattr(monitor_manager, "has_active_monitors", None)
        active_monitors = bool(monitor_probe()) if callable(monitor_probe) else False
        ledger = current_operation_ledger()
        receipts, corrupt_count = ledger.pending_receipts() if ledger is not None else ([], 0)
        return ToolRuntimeLiveness(
            has_active_background_jobs=background_jobs,
            has_active_monitors=active_monitors,
            has_pending_operations=bool(receipts) or corrupt_count > 0,
        )
    except (OSError, RuntimeError, TypeError, ValueError) as error:
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.tool_runtime_liveness_probe_failed",
            message="Runtime operation liveness could not be determined.",
            status="degraded",
            data={"exception_type": type(error).__name__},
        )
        return ToolRuntimeLiveness()
