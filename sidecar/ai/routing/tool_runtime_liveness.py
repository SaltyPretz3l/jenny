"""Request-time liveness snapshot for status-tool schema selection."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sidecar.ai.mcp.builtin_server_ledger import current_operation_ledger
from sidecar.ai.tools.builtins.shell_background import active_job_ids
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ToolRuntimeLiveness:
    has_active_background_jobs: bool = False
    has_active_monitors: bool = False
    has_pending_operations: bool = False


def snapshot_tool_runtime_liveness(kernel: Any) -> ToolRuntimeLiveness:
    """Capture bounded runtime state without coupling the budget filter to the kernel."""

    try:
        background_jobs = bool(active_job_ids())
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
