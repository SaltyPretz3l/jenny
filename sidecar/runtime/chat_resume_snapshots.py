"""Captured-root read-snapshot rebuilding for approval resume."""

from __future__ import annotations

from typing import Any

from sidecar.runtime.approval_plan import ApprovalPlan


def rebuild_approval_resume_read_snapshot_cache(
    plan: ApprovalPlan,
    *,
    kernel: Any,
    canonical_session_messages: Any,
) -> dict[str, dict[str, object]]:
    execution_context = plan.request_context.execution_context
    cache = kernel._rebuild_read_snapshot_cache(
        canonical_session_messages if isinstance(canonical_session_messages, list) else None,
        execution_context=execution_context,
    )
    for outcome in plan.outcomes:
        metadata = getattr(outcome, "metadata", None)
        kernel._update_read_snapshot_cache(
            cache,
            tool_name=str(getattr(outcome, "tool_name", "") or "").strip(),
            success=bool(getattr(outcome, "success", False)),
            metadata=metadata if isinstance(metadata, dict) else {},
            execution_context=execution_context,
        )
    return cache


__all__ = ["rebuild_approval_resume_read_snapshot_cache"]
