"""Model-facing ``delegate`` facade over the hidden read-only sub-agent runtime."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from sidecar.ai.routing.delegate_contracts import (
    DELEGATE_EXECUTION_FAILURE_CODE as CMP_TOOL_EXECUTION_FAILED,
)
from sidecar.ai.routing.delegate_contracts import (
    DELEGATE_TOOL_NAME,
    DelegateRequest,
    DelegateTask,
    ToolExecutionFailure,
    build_compact_delegate_settlement,
    extract_tool_observed_evidence,
    validate_delegate_arguments,
)
from sidecar.ai.routing.sub_agent_invocation import (
    DELEGATE_OPERATION,
    INVOCATION_KIND_RESEARCH,
    SubAgentIdentity,
    build_sub_agent_identity,
)
from sidecar.ai.routing.subagent_batch_observability import (
    emit_progress,
    selected_route,
    task_percent,
)
from sidecar.ai.routing.subagent_scheduler import (
    DelegateSchedule,
    ScheduledInvocation,
    schedule_delegate_tasks,
)
from sidecar.ai.routing.subagent_telemetry import (
    aggregate_usage,
    terminal_reason,
    usage_from_decision,
)
from sidecar.ai.tools.sanitization import sanitize_tool_output
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.tool_execution_support import CMP_LOOP_TOOL_INPUT_VALIDATION

logger = logging.getLogger(__name__)


def delegate_validation_outcome(  # noqa: PLR0913 - synthetic validation boundary.
    *,
    kernel: Any,
    call: Any,
    descriptor: Any | None,
    visible_tool_arguments: dict[str, object],
    request_id: str,
    outcome_type: Any,
    increment_counter: Any,
) -> Any | None:
    """Normalize documented aliases while preserving the existing repair seam."""

    try:
        validate_delegate_arguments(call.arguments, parent_agent_depth=0)
    except ToolExecutionFailure as error:
        schema = getattr(descriptor, "input_schema", None)
        required_keys = schema.get("required", []) if isinstance(schema, dict) else []
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.tool_call_input_validation_failed",
            message="Rejected delegate call with invalid arguments.",
            status="failure",
            data={
                "tool": call.tool_id,
                "code": CMP_LOOP_TOOL_INPUT_VALIDATION,
                "contract_error_code": str(error.code or "")[:64],
                "request_id": request_id,
            },
        )
        increment_counter(kernel, "validation_failure")
        return outcome_type(
            tool_name=call.tool_id,
            output=f"Tool 'delegate' rejected malformed arguments: {error.message}",
            success=False,
            tool_input=visible_tool_arguments,
            error_code=CMP_LOOP_TOOL_INPUT_VALIDATION,
            metadata={
                "validation_error": error.message,
                "required_keys": ["tasks"],
                "minimal_valid_arguments": {"tasks": ["Inspect the repository"]},
                "schema_required_keys": required_keys,
            },
            call_id=call.call_id,
        )
    return None


def execute_delegate_tool(  # noqa: PLR0913 - synthetic boundary mirrors router inputs.
    *,
    router: Any,
    arguments: dict[str, Any],
    runtime: Any,
    outcome_type: Any,
    visible_tool_arguments: dict[str, object] | None = None,
    call_id: str = "",
) -> Any:
    canonical_call_id = str(call_id or "").strip()
    if not canonical_call_id:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="delegate canonical call id is unavailable",
            retryable=False,
        )
    parent_context = getattr(runtime, "request_context", None)
    parent_request_id = str(
        getattr(parent_context, "request_id", "") or getattr(runtime, "request_id", "") or ""
    ).strip()
    if not parent_request_id:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="delegate parent request id is unavailable",
            retryable=False,
        )
    request = validate_delegate_arguments(
        arguments,
        parent_agent_depth=int(getattr(parent_context, "agent_depth", 0) or 0),
    )
    if parent_context is None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="delegate runtime is unavailable",
            retryable=False,
        )

    parent_agent_id = (
        str(getattr(parent_context, "agent_id", "") or "").strip() or f"main@{parent_request_id}"
    )
    identity = build_sub_agent_identity(
        parent_request_id=parent_request_id,
        canonical_call_id=canonical_call_id,
        parent_agent_id=parent_agent_id,
        operation=DELEGATE_OPERATION,
    )
    started_at = time.monotonic()
    _emit_delegate_start(
        runtime,
        router,
        identity,
        request,
        canonical_call_id,
        parent_request_id=parent_request_id,
    )
    settled_count = sum(1 for task in request.tasks if task.error is not None)
    progress_lock = threading.Lock()

    def on_task_started(task: DelegateTask, task_identity: SubAgentIdentity) -> None:
        with progress_lock:
            _emit_task_started(
                runtime,
                identity,
                task,
                task_identity,
                settled_count=settled_count,
                task_count=len(request.tasks),
                call_id=canonical_call_id,
                route=selected_route(router),
            )

    def on_task_settled(invocation: ScheduledInvocation) -> None:
        nonlocal settled_count
        with progress_lock:
            settled_count += 1
            _emit_task_settled(
                runtime,
                identity,
                invocation,
                settled_count=settled_count,
                task_count=len(request.tasks),
                call_id=canonical_call_id,
            )

    schedule = schedule_delegate_tasks(
        router=router,
        parent_context=parent_context,
        runtime=runtime,
        request=request,
        parent_request_id=parent_request_id,
        call_id=canonical_call_id,
        parent_agent_id=parent_agent_id,
        on_task_started=on_task_started,
        on_task_settled=on_task_settled,
    )
    _raise_runtime_interrupted(runtime)
    invocation_by_ordinal = {
        invocation.task.ordinal: invocation for invocation in schedule.invocations
    }
    task_reports = [
        _task_report(
            task,
            invocation_by_ordinal.get(task.ordinal),
            identity=_task_identity(
                parent_request_id,
                canonical_call_id,
                parent_agent_id,
                task.ordinal,
            ),
            default_steps=schedule.task_iteration_limit,
            default_runtime_ms=schedule.effective_max_total_runtime_ms,
        )
        for task in request.tasks
    ]
    compact = build_compact_delegate_settlement(
        execution=schedule.execution,
        task_reports=task_reports,
    )
    rich_report = _rich_report(
        identity=identity,
        request=request,
        schedule=schedule,
        task_reports=task_reports,
        status=compact.status,
        started_at=started_at,
    )
    error_code = None if compact.success else _first_error_code(task_reports)
    if schedule.capacity_rejected:
        _log_delegate(
            runtime,
            identity,
            event="ai.routing.delegate_capacity_rejected",
            status="failed",
            request=request,
            schedule=schedule,
            task_reports=task_reports,
            started_at=started_at,
            error_code=error_code,
        )
    _emit_delegate_terminal(
        runtime,
        identity,
        compact.status,
        compact.success,
        canonical_call_id,
        rich_report,
    )
    _log_delegate(
        runtime,
        identity,
        event="ai.routing.delegate_terminal",
        status=compact.status,
        request=request,
        schedule=schedule,
        task_reports=task_reports,
        started_at=started_at,
        error_code=error_code,
    )
    return outcome_type(
        tool_name=DELEGATE_TOOL_NAME,
        output=compact.output,
        success=compact.success,
        tool_input=visible_tool_arguments or dict(arguments),
        content_type="application/json",
        error_code=error_code,
        metadata={
            "result_kind": "subagent_batch_report",
            "subagent_batch_report": rich_report,
            "invocation_kind": INVOCATION_KIND_RESEARCH,
        },
        call_id=canonical_call_id,
    )


def _task_report(
    task: DelegateTask,
    invocation: ScheduledInvocation | None,
    *,
    identity: SubAgentIdentity,
    default_steps: int,
    default_runtime_ms: int,
) -> dict[str, Any]:
    if invocation is None:
        rejected_error = dict(task.error or {}) or {
            "code": CMP_TOOL_EXECUTION_FAILED,
            "message": "Sub-agent task did not start.",
            "retryable": False,
        }
        return {
            "task_id": identity.task_id,
            "ordinal": task.ordinal,
            "label": f"Task {task.ordinal}",
            "agent_id": identity.agent_id,
            "parent_agent_id": identity.parent_agent_id,
            "status": "failed",
            "summary": _safe_text(rejected_error.get("message"), 1_000),
            "evidence": [],
            "evidence_trust": "none",
            "tools_used": [],
            "uncertainties": [],
            "budget": {
                "max_steps": default_steps,
                "iterations_used": 0,
                "tool_results_used": 0,
                "max_runtime_ms": default_runtime_ms,
                "elapsed_ms": 0,
            },
            "usage": None,
            "terminal_reason": "rejected",
            "error": _safe_error(rejected_error),
        }

    result = invocation.result
    raw_status = str(result.status or "failed").strip().lower()
    status = (
        raw_status if raw_status in {"completed", "partial", "failed", "cancelled"} else "failed"
    )
    evidence = extract_tool_observed_evidence(result.decision)
    error: dict[str, Any] | None = None
    if status in {"failed", "cancelled"}:
        error = _safe_error(
            {
                "code": result.error_code or CMP_TOOL_EXECUTION_FAILED,
                "message": result.error_message or "Sub-agent execution failed.",
                "retryable": bool(result.error_retryable),
            }
        )
    answer = _safe_text(result.response_text, 1_000)
    if not answer and error:
        answer = str(error["message"])
    return {
        "task_id": identity.task_id,
        "ordinal": task.ordinal,
        "label": f"Task {task.ordinal}",
        "agent_id": result.agent_id or identity.agent_id,
        "parent_agent_id": result.parent_agent_id or identity.parent_agent_id,
        "status": status,
        "summary": answer,
        "evidence": evidence,
        "evidence_trust": "tool_observed" if evidence else "none",
        "tools_used": [_safe_text(name, 64) for name in result.observed_tool_names if name],
        "uncertainties": [],
        "budget": {
            "max_steps": invocation.max_steps,
            "iterations_used": min(max(0, result.iterations_used), invocation.max_steps),
            "tool_results_used": max(0, result.tool_results_used),
            "max_runtime_ms": invocation.max_runtime_ms,
            "elapsed_ms": max(0, invocation.elapsed_ms),
        },
        "usage": usage_from_decision(result.decision),
        "terminal_reason": terminal_reason(
            completion_reason=result.completion_reason,
            status=status,
            error_message=result.error_message,
        ),
        "error": error,
    }


def _rich_report(  # noqa: PLR0913 - explicit aggregate accounting.
    *,
    identity: SubAgentIdentity,
    request: DelegateRequest,
    schedule: DelegateSchedule,
    task_reports: list[dict[str, Any]],
    status: str,
    started_at: float,
) -> dict[str, Any]:
    invocations = schedule.invocations
    return {
        "result_kind": "subagent_batch_report",
        "batch_id": identity.invocation_id,
        "source_tool": DELEGATE_TOOL_NAME,
        "status": status,
        "execution": schedule.execution,
        "tasks": task_reports,
        "usage": aggregate_usage(task_reports),
        "budget": {
            "max_tasks": 3,
            "tasks_requested": len(request.tasks),
            "tasks_started": sum(1 for item in invocations if item.started),
            "tasks_completed": sum(1 for report in task_reports if report["status"] == "completed"),
            "tasks_partial": sum(1 for report in task_reports if report["status"] == "partial"),
            "max_total_steps": sum(max(0, item.max_steps) for item in invocations),
            "iterations_used": sum(
                max(0, int(item.result.iterations_used or 0)) for item in invocations
            ),
            "tool_results_used": sum(
                max(0, int(item.result.tool_results_used or 0)) for item in invocations
            ),
            "max_total_runtime_ms": schedule.effective_max_total_runtime_ms,
            "effective_max_total_runtime_ms": schedule.effective_max_total_runtime_ms,
            "parent_synthesis_reserve_ms": schedule.parent_synthesis_reserve_ms,
            "elapsed_ms": max(0, int((time.monotonic() - started_at) * 1_000)),
        },
    }


def _emit_delegate_start(  # noqa: PLR0913 - fixed progress-envelope fields.
    runtime: Any,
    router: Any,
    identity: SubAgentIdentity,
    request: DelegateRequest,
    call_id: str,
    *,
    parent_request_id: str,
) -> None:
    route = selected_route(router)
    emit_progress(
        runtime,
        identity,
        stage="start",
        status="running",
        percent=5,
        summary=f"Starting read-only delegation with {len(request.tasks)} task(s).",
        tool_call_id=call_id,
        route=route,
        source=DELEGATE_TOOL_NAME,
    )
    _emit_initial_task_states(
        runtime,
        identity,
        request,
        call_id,
        parent_request_id=parent_request_id,
        route=route,
    )
    _log_delegate(
        runtime,
        identity,
        event="ai.routing.delegate_started",
        status="running",
        request=request,
        schedule=None,
        task_reports=[],
        started_at=time.monotonic(),
        error_code=None,
    )


def _emit_initial_task_states(  # noqa: PLR0913 - fixed progress-envelope fields.
    runtime: Any,
    identity: SubAgentIdentity,
    request: DelegateRequest,
    call_id: str,
    *,
    parent_request_id: str,
    route: dict[str, str],
) -> None:
    task_count = len(request.tasks)
    initial_percent = task_percent(
        sum(1 for task in request.tasks if task.error is not None),
        task_count,
        settled=True,
    )
    for task in request.tasks:
        rejected = task.error is not None
        status = "failed" if rejected else "queued"
        emit_progress(
            runtime,
            identity,
            stage=f"task_{task.ordinal}_{status}",
            status=status,
            percent=initial_percent,
            summary=(
                f"Task {task.ordinal}/{task_count} rejected."
                if rejected
                else f"Task {task.ordinal}/{task_count} queued."
            ),
            tool_call_id=call_id,
            child_identity=_task_identity(
                parent_request_id,
                call_id,
                identity.parent_agent_id,
                task.ordinal,
            ),
            child_ordinal=task.ordinal,
            child_count=task_count,
            child_label=f"Task {task.ordinal}",
            child_terminal=rejected,
            terminal_reason="rejected" if rejected else None,
            route=route,
            source=DELEGATE_TOOL_NAME,
        )


def _emit_task_started(  # noqa: PLR0913 - fixed progress-envelope fields.
    runtime: Any,
    identity: SubAgentIdentity,
    task: DelegateTask,
    task_identity: SubAgentIdentity,
    *,
    settled_count: int,
    task_count: int,
    call_id: str,
    route: dict[str, str],
) -> None:
    emit_progress(
        runtime,
        identity,
        stage=f"task_{task.ordinal}_running",
        status="running",
        percent=task_percent(settled_count, task_count, settled=True),
        summary=f"Task {task.ordinal}/{task_count} running.",
        tool_call_id=call_id,
        child_identity=task_identity,
        child_ordinal=task.ordinal,
        child_count=task_count,
        child_label=f"Task {task.ordinal}",
        route=route,
        source=DELEGATE_TOOL_NAME,
    )


def _emit_task_settled(  # noqa: PLR0913 - fixed progress-envelope fields.
    runtime: Any,
    identity: SubAgentIdentity,
    invocation: ScheduledInvocation,
    *,
    settled_count: int,
    task_count: int,
    call_id: str,
) -> None:
    status = str(invocation.result.status or "failed")
    emit_progress(
        runtime,
        identity,
        stage=f"task_{invocation.task.ordinal}_{status}",
        status=status,
        percent=task_percent(settled_count, task_count, settled=True),
        summary=f"Task {invocation.task.ordinal}/{task_count} settled as {status}.",
        tool_call_id=call_id,
        child_identity=invocation.identity,
        child_ordinal=invocation.task.ordinal,
        child_count=task_count,
        child_label=f"Task {invocation.task.ordinal}",
        child_terminal=True,
        child_success=status in {"completed", "partial"},
        usage=usage_from_decision(invocation.result.decision),
        terminal_reason=terminal_reason(
            completion_reason=invocation.result.completion_reason,
            status=status,
            error_message=invocation.result.error_message,
        ),
        source=DELEGATE_TOOL_NAME,
    )
    log_event(
        logger,
        logging.INFO if status in {"completed", "partial"} else logging.WARNING,
        component="ai.routing.delegate",
        event="ai.routing.delegate_task_settled",
        message="Delegated task settled.",
        status=status,
        duration_ms=max(0, invocation.elapsed_ms),
        data={
            "batch_id": identity.invocation_id,
            "task_ordinal": invocation.task.ordinal,
            "task_count": task_count,
            "started": invocation.started,
            "error_code": invocation.result.error_code,
        },
        request_id=str(getattr(runtime, "request_id", "") or "").strip() or None,
        trace_id=str(getattr(runtime, "trace_id", "") or "").strip() or None,
        session_id=str(getattr(runtime, "session_id", "") or "").strip() or None,
    )


def _emit_delegate_terminal(  # noqa: PLR0913 - fixed progress-envelope fields.
    runtime: Any,
    identity: SubAgentIdentity,
    status: str,
    success: bool,
    call_id: str,
    report: dict[str, Any],
) -> None:
    emit_progress(
        runtime,
        identity,
        stage=status,
        status=status,
        percent=100,
        summary=f"Read-only delegation settled as {status}.",
        terminal=True,
        success=success,
        tool_call_id=call_id,
        usage=report.get("usage"),
        source=DELEGATE_TOOL_NAME,
    )


def _log_delegate(  # noqa: PLR0913 - fixed redacted lifecycle fields.
    runtime: Any,
    identity: SubAgentIdentity,
    *,
    event: str,
    status: str,
    request: DelegateRequest,
    schedule: DelegateSchedule | None,
    task_reports: list[dict[str, Any]],
    started_at: float,
    error_code: str | None,
) -> None:
    log_event(
        logger,
        logging.INFO if status in {"running", "completed"} else logging.WARNING,
        component="ai.routing.delegate",
        event=event,
        message="Delegation lifecycle update.",
        status=status,
        duration_ms=max(0, int((time.monotonic() - started_at) * 1_000)),
        data={
            "batch_id": identity.invocation_id,
            "task_count": len(request.tasks),
            "execution": schedule.execution if schedule else None,
            "tasks_started": (
                sum(1 for item in schedule.invocations if item.started) if schedule else 0
            ),
            "tasks_completed": sum(
                1 for report in task_reports if report.get("status") == "completed"
            ),
            "error_code": error_code,
            "capacity_rejected": bool(schedule and schedule.capacity_rejected),
        },
        request_id=str(getattr(runtime, "request_id", "") or "").strip() or None,
        trace_id=str(getattr(runtime, "trace_id", "") or "").strip() or None,
        session_id=str(getattr(runtime, "session_id", "") or "").strip() or None,
    )


def _task_identity(
    parent_request_id: str,
    call_id: str,
    parent_agent_id: str,
    ordinal: int,
) -> SubAgentIdentity:
    return build_sub_agent_identity(
        parent_request_id=parent_request_id,
        canonical_call_id=call_id,
        parent_agent_id=parent_agent_id,
        ordinal=ordinal,
        operation=DELEGATE_OPERATION,
    )


def _safe_error(error: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": _safe_text(error.get("code"), 64) or CMP_TOOL_EXECUTION_FAILED,
        "message": _safe_text(error.get("message"), 300) or "Sub-agent task failed.",
        "retryable": bool(error.get("retryable")),
    }


def _first_error_code(task_reports: list[dict[str, Any]]) -> str:
    for report in task_reports:
        error = report.get("error")
        if isinstance(error, dict) and str(error.get("code") or "").strip():
            return str(error["code"])
    return CMP_TOOL_EXECUTION_FAILED


def _safe_text(value: object, max_chars: int) -> str:
    return sanitize_tool_output(
        value,
        max_chars=max_chars,
        tool_name=DELEGATE_TOOL_NAME,
    ).strip()


def _raise_runtime_interrupted(runtime: Any) -> None:
    raise_if_interrupted = getattr(runtime, "raise_if_interrupted", None)
    if callable(raise_if_interrupted):
        raise_if_interrupted(message="delegate deadline exceeded")
        return
    cancel_handle = getattr(runtime, "cancel_handle", None)
    if cancel_handle is not None:
        cancel_handle.raise_if_cancelled()


__all__ = ["execute_delegate_tool"]
