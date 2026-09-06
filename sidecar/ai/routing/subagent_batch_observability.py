"""Best-effort progress and diagnostics for sequential sub-agent batches."""

from __future__ import annotations

import logging
import time
from typing import Any

from sidecar.ai.routing.sub_agent_invocation import SubAgentIdentity
from sidecar.ai.routing.subagent_contracts import (
    SUBAGENT_BATCH_TOOL_NAME,
    SubagentBatchRequest,
    safe_batch_text,
)
from sidecar.ai.routing.subagent_telemetry import selected_route as _selected_route
from sidecar.protocol import AGENT_PROGRESS_METHOD
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.rpc import notification

logger = logging.getLogger("sidecar.ai.routing.subagent_batch")


def selected_route(router: Any | None) -> dict[str, str]:
    """Expose advisory route identity through the existing batch support seam."""

    return _selected_route(router)


def elapsed_ms(started_at: float) -> int:
    """Return a non-negative monotonic duration in milliseconds."""

    return max(0, int((time.monotonic() - started_at) * 1_000))


def task_percent(ordinal: int, total: int, *, settled: bool) -> int:
    """Map deterministic task position to the coordinator's progress band."""

    completed = ordinal if settled else ordinal - 1
    return max(10, min(90, 10 + int(80 * completed / max(1, total))))


def emit_progress(  # noqa: PLR0913 - agent.progress payload is fixed.
    runtime: Any,
    identity: SubAgentIdentity,
    *,
    stage: str,
    status: str,
    percent: int,
    summary: str,
    terminal: bool = False,
    success: bool = False,
    tool_call_id: str = "",
    child_identity: SubAgentIdentity | None = None,
    child_ordinal: int | None = None,
    child_count: int | None = None,
    child_label: str = "",
    child_terminal: bool = False,
    child_success: bool = False,
    route: dict[str, str] | None = None,
    usage: dict[str, Any] | None = None,
    terminal_reason: str | None = None,
    source: str = SUBAGENT_BATCH_TOOL_NAME,
) -> None:
    """Write a bounded progress notification without affecting tool truth."""

    writer = getattr(runtime, "notification_writer", None)
    if not callable(writer):
        return
    text = safe_batch_text(summary, max_chars=160)
    try:
        payload: dict[str, Any] = {
            "request_id": str(getattr(runtime, "request_id", "") or "").strip(),
            "trace_id": str(getattr(runtime, "trace_id", "") or "").strip(),
            "session_id": str(getattr(runtime, "session_id", "") or "").strip(),
            "task_id": identity.invocation_id,
            "task_type": "sub_agent",
            "source": safe_batch_text(source, max_chars=64) or SUBAGENT_BATCH_TOOL_NAME,
            "status": status,
            "stage": stage,
            "percent": max(0, min(100, int(percent))),
            "summary": text,
            "message": text,
            "terminal": bool(terminal),
            "success": bool(success),
            "agent_id": identity.agent_id,
            "parent_agent_id": identity.parent_agent_id,
            "tool_call_id": str(tool_call_id or "").strip() or None,
        }
        if child_identity is not None:
            payload.update(
                {
                    "child_task_id": child_identity.task_id,
                    "child_agent_id": child_identity.agent_id,
                    "child_ordinal": max(1, int(child_ordinal or 1)),
                    "child_count": max(1, int(child_count or 1)),
                    "child_label": safe_batch_text(child_label, max_chars=80),
                    "child_terminal": bool(child_terminal),
                    "child_success": bool(child_success),
                }
            )
        for key in ("model", "provider"):
            value = str((route or {}).get(key) or "").strip()
            if value:
                payload[key] = value
        if usage:
            payload["usage"] = usage
            for key in ("model", "provider"):
                value = str(usage.get(key) or "").strip()
                if value:
                    payload[key] = value
        if terminal_reason:
            payload["terminal_reason"] = terminal_reason
        writer(
            notification(
                AGENT_PROGRESS_METHOD,
                payload,
            )
        )
    except Exception:  # noqa: BLE001 - progress is advisory.
        log_batch_event(
            runtime,
            identity,
            event="ai.router.subagent_batch_progress_write_failed",
            level=logging.WARNING,
            status="degraded",
            request=None,
            started_at=time.monotonic(),
        )


def log_batch_task_issue(  # noqa: PLR0913 - fixed diagnostic fields.
    runtime: Any,
    batch_identity: SubAgentIdentity,
    task_identity: SubAgentIdentity,
    *,
    request: SubagentBatchRequest,
    started_at: float,
    status: str,
    error: dict[str, Any] | None,
    tasks_started: int,
    tasks_completed: int,
    iterations_used: int,
    tool_results_used: int,
    event: str = "ai.router.subagent_batch_task_failed",
) -> None:
    """Emit a redacted task-scoped lifecycle diagnostic."""

    log_batch_event(
        runtime,
        batch_identity,
        event=event,
        level=logging.WARNING,
        status=status,
        request=request,
        started_at=started_at,
        task_id=task_identity.task_id,
        ordinal=int(task_identity.task_id.rsplit(":", 1)[-1]),
        tasks_started=tasks_started,
        tasks_completed=tasks_completed,
        iterations_used=iterations_used,
        tool_results_used=tool_results_used,
        error_code=str((error or {}).get("code") or "").strip() or None,
    )


def log_batch_event(  # noqa: PLR0913 - fixed diagnostic fields.
    runtime: Any,
    identity: SubAgentIdentity,
    *,
    event: str,
    level: int,
    status: str,
    request: SubagentBatchRequest | None,
    started_at: float,
    task_id: str | None = None,
    ordinal: int | None = None,
    tasks_started: int = 0,
    tasks_completed: int = 0,
    iterations_used: int = 0,
    tool_results_used: int = 0,
    error_code: str | None = None,
) -> None:
    """Emit bounded aggregate diagnostics with allocator state when available."""

    elapsed = elapsed_ms(started_at)
    log_event(
        logger,
        level,
        component="ai.routing.subagent_batch",
        event=event,
        message="Sub-agent batch lifecycle update.",
        status=status,
        duration_ms=elapsed,
        data={
            "batch_id": identity.invocation_id,
            "task_id": task_id,
            "ordinal": ordinal,
            "task_count": len(request.tasks) if request else 0,
            "tasks_started": max(0, tasks_started),
            "tasks_completed": max(0, tasks_completed),
            "iterations_used": max(0, iterations_used),
            "tool_results_used": max(0, tool_results_used),
            "remaining_steps": max(0, request.max_total_steps - iterations_used) if request else 0,
            "remaining_runtime_ms": (
                max(0, request.max_total_runtime_ms - elapsed) if request else 0
            ),
            "error_code": error_code,
            "allocator": _allocator_snapshot(runtime),
        },
        request_id=str(getattr(runtime, "request_id", "") or "").strip() or None,
        trace_id=str(getattr(runtime, "trace_id", "") or "").strip() or None,
        session_id=str(getattr(runtime, "session_id", "") or "").strip() or None,
    )


def _allocator_snapshot(runtime: Any) -> dict[str, int] | None:
    snapshot = getattr(getattr(runtime, "sub_agent_slot_allocator", None), "snapshot", None)
    if not callable(snapshot):
        return None
    try:
        raw = snapshot()
        if not isinstance(raw, dict):
            return None
        keys = (
            "active_sub_agents",
            "max_active_sub_agents",
            "max_sub_agents_per_parent",
            "active_parent_count",
        )
        return {key: max(0, int(raw.get(key, 0) or 0)) for key in keys}
    except Exception:  # noqa: BLE001 - diagnostics cannot affect tool truth.
        return None


__all__ = [
    "elapsed_ms",
    "emit_progress",
    "log_batch_event",
    "log_batch_task_issue",
    "task_percent",
]
