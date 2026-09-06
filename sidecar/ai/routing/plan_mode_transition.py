"""Request-local transition after a resolved ``exit_plan_mode`` outcome."""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Any, Iterable, Sequence

from sidecar.ai.context.builder_shared import RuntimeToolStatus
from sidecar.ai.context.prompt_modes import build_approved_plan_overlay
from sidecar.ai.context.runtime_message_markers import (
    PLAN_MODE_OVERLAY_HEADING,
    RESTORED_TOOL_CONTRACT_HEADING,
)
from sidecar.ai.tools.preconditions import PRECONDITION_RENDER
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)


def _safe_log_value(value: Any) -> Any:
    try:
        if value is None or isinstance(value, int | float | str):
            return value
        return str(value)[:120]
    except Exception:  # noqa: BLE001 - diagnostics must never alter the transition.
        return "<unavailable>"


def _decline_data(outcome: Any, metadata: Any, guard: str) -> dict[str, Any]:
    try:
        decision = metadata.get("plan_decision") if isinstance(metadata, dict) else None
        cleared = metadata.get("plan_mode_cleared") if isinstance(metadata, dict) else None
        success = getattr(outcome, "success", None)
    except Exception:  # noqa: BLE001 - untrusted outcome diagnostics are best effort.
        decision, cleared, success = None, None, None
    return {
        "declined_guard": guard,
        "decision": _safe_log_value(decision),
        "plan_mode_cleared": _safe_log_value(cleared),
        "success": _safe_log_value(success),
    }


def _log_transition(
    level: int, event: str, message: str, data: dict[str, Any], *, status: str
) -> None:
    try:
        log_event(
            logger,
            level,
            component="ai.router.plan_mode",
            event=event,
            message=message,
            status=status,
            data=data,
        )
    except Exception:  # noqa: BLE001 - logging must never affect tool restoration.
        return


def build_restored_tool_contract_overlay(
    *, tool_statuses: Sequence[RuntimeToolStatus]
) -> str:
    """Render the execution contract that supersedes the stale plan-mode digest."""
    available = [
        status
        for status in tool_statuses
        if status.available is True and status.applicable is True
    ]
    blocked = [
        status
        for status in tool_statuses
        if status.available is True and status.applicable is False
    ]
    lines = [
        RESTORED_TOOL_CONTRACT_HEADING,
        "Plan mode has ended in this turn. The `## Executable Tools` block in the "
        "system prompt was rendered while read-only mode was active and is now stale. "
        "This block supersedes it; tools listed below as available may be called now "
        "under the normal approval policy, and questions about available tools or "
        "capabilities are answered from this block.",
        "Available now:",
    ]
    for status in available:
        description = status.description.strip() if status.description else ""
        suffix = f": {description}" if description else ""
        lines.append(f"- `{status.name}`{suffix}")
    if not available:
        lines.append("- (none)")
    if blocked:
        lines.append("Available, but will fail until fixed:")
        for status in blocked:
            # Same precondition rendering as the ``## Executable Tools`` digest:
            # ``available`` statuses never carry ``reason``; the block reason
            # lives in ``unmet_preconditions``.
            pairs = [
                PRECONDITION_RENDER.get(precondition_id, (precondition_id, precondition_id))
                for precondition_id in (status.unmet_preconditions or ("unknown",))
            ]
            reason = " ".join(pair[0] for pair in pairs)
            fix = " ".join(pair[1] for pair in pairs)
            lines.append(f"- `{status.name}` — {reason} Fix: {fix}")
    return "\n".join(line.rstrip() for line in lines)


def apply_restored_tool_contract(
    *,
    working_messages: list[dict[str, object]],
    tool_statuses: Sequence[RuntimeToolStatus],
) -> None:
    """Replace any prior restored-contract overlay while preserving list identity."""
    if not tool_statuses:
        return
    working_messages[:] = [
        message
        for message in working_messages
        if not (
            message.get("role") == "system"
            and str(message.get("content") or "").startswith(
                RESTORED_TOOL_CONTRACT_HEADING
            )
        )
    ]
    working_messages.append(
        {
            "role": "system",
            "content": build_restored_tool_contract_overlay(tool_statuses=tool_statuses),
        }
    )
    _log_transition(
        logging.INFO,
        "plan_mode.restored_tool_contract_applied",
        "Restored tool contract applied after Plan Mode exit.",
        {
            "available": sum(
                1
                for status in tool_statuses
                if status.available is True and status.applicable is True
            ),
            "blocked": sum(
                1
                for status in tool_statuses
                if status.available is True and status.applicable is False
            ),
        },
        status="success",
    )


def context_with_plan_decision(context: Any, decision: str, feedback: str = "") -> Any:
    normalized = str(decision or "").strip()
    return replace(
        context,
        plan_decision=normalized,
        plan_feedback=str(feedback or "").strip()[:800],
    )


def transition_after_exit_outcome(
    *,
    request_context: Any,
    outcomes: Iterable[Any],
    working_messages: list[dict[str, object]],
) -> Any:
    exit_outcome = next(
        (
            outcome
            for outcome in reversed(tuple(outcomes))
            if str(getattr(outcome, "tool_name", "") or "") == "exit_plan_mode"
        ),
        None,
    )
    if exit_outcome is None:
        return request_context
    metadata = getattr(exit_outcome, "metadata", None)
    decision = ""
    declined_guard = ""
    if getattr(exit_outcome, "success", False) is not True:
        declined_guard = "success_not_true"
    elif not isinstance(metadata, dict):
        declined_guard = "metadata_not_dict"
    else:
        decision = str(metadata.get("plan_decision") or "").strip()
        if decision not in {"approved", "approved_auto"}:
            declined_guard = "decision_not_approved"
        elif metadata.get("plan_mode_cleared") is not True:
            declined_guard = "plan_mode_not_cleared"

    if declined_guard:
        _log_transition(
            # A user rejecting the plan is an expected outcome, not a defect;
            # WARNING is reserved for the guards that indicate a broken exit.
            logging.INFO if decision == "rejected" else logging.WARNING,
            "plan_mode.exit_transition_declined",
            "Plan Mode exit transition declined.",
            _decline_data(exit_outcome, metadata, declined_guard),
            status="declined",
        )
        if decision == "rejected":
            return replace(
                request_context,
                approvals_pre_granted=False,
                plan_decision="",
                plan_feedback="",
            )
        return request_context
    if not isinstance(metadata, dict):
        # Unreachable: the guard chain above already declined non-dict
        # metadata. Kept as an explicit narrowing so mypy tracks the type.
        return request_context

    working_messages[:] = [
        message
        for message in working_messages
        if not (
            message.get("role") == "system"
            and str(message.get("content") or "").startswith(PLAN_MODE_OVERLAY_HEADING)
        )
    ]
    plan = metadata.get("plan") if isinstance(metadata.get("plan"), dict) else None
    working_messages.append({"role": "system", "content": build_approved_plan_overlay(plan)})
    approval_mode = "auto_run" if metadata.get("run_mode_restored") == "auto" else "prompt"
    _log_transition(
        logging.INFO,
        "plan_mode.exit_transition_applied",
        "Plan Mode exit transition applied.",
        {
            "decision": decision,
            "run_mode_restored": _safe_log_value(metadata.get("run_mode_restored")),
            "approval_mode": approval_mode,
        },
        status="success",
    )
    return replace(
        request_context,
        plan_mode=False,
        read_only=False,
        approvals_pre_granted=False,
        approval_mode=approval_mode,
        plan_decision="",
        plan_feedback="",
    )


__all__ = [
    "apply_restored_tool_contract",
    "build_restored_tool_contract_overlay",
    "context_with_plan_decision",
    "transition_after_exit_outcome",
]
