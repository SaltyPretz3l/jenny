"""Sequential, bounded ``subagent_batch`` coordination."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field, replace
from typing import Any, cast

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.routing.sub_agent_invocation import (
    COMPLETION_REASON_CAPACITY_UNAVAILABLE,
    INVOCATION_KIND_RESEARCH,
    SUBAGENT_BATCH_OPERATION,
    SubAgentIdentity,
    build_sub_agent_identity,
    invoke_sub_agent,
)
from sidecar.ai.routing.subagent_batch_observability import elapsed_ms as _elapsed_ms
from sidecar.ai.routing.subagent_batch_observability import emit_progress as _emit_progress
from sidecar.ai.routing.subagent_batch_observability import log_batch_event as _log_batch
from sidecar.ai.routing.subagent_batch_observability import (
    log_batch_task_issue as _log_task_issue,
)
from sidecar.ai.routing.subagent_batch_observability import selected_route
from sidecar.ai.routing.subagent_batch_observability import task_percent as _task_percent
from sidecar.ai.routing.subagent_contracts import (
    SUBAGENT_BATCH_TOOL_NAME,
    SubagentBatchRequest,
    SubagentBatchTask,
    budget_exhausted_error,
    build_batch_settlement,
    build_settled_task_report,
    build_unstarted_task_report,
    cancelled_error,
    capacity_unavailable_error,
    runtime_unavailable_error,
    validate_subagent_batch_arguments,
)
from sidecar.ai.routing.subagent_run import (
    SubagentRunRequest,
    build_subagent_tool_preferences,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED

PARENT_SYNTHESIS_RESERVE_MS = 60_000


@dataclass
class _BatchState:
    reports: list[dict[str, Any]] = field(default_factory=list)
    tasks_started: int = 0
    tasks_completed: int = 0
    iterations_used: int = 0
    tool_results_used: int = 0
    capacity_error: dict[str, Any] | None = None


@dataclass(frozen=True)
class _BatchContext:
    router: Any
    runtime: Any
    outcome_type: Any
    arguments: dict[str, Any]
    visible_tool_arguments: dict[str, object] | None
    call_id: str
    parent_context: Any
    parent_request_id: str
    identity: SubAgentIdentity
    request: SubagentBatchRequest
    started_at: float
    effective_runtime_budget_ms: int
    parent_synthesis_reserve_ms: int


def execute_subagent_batch_tool(  # noqa: PLR0913 - synthetic boundary mirrors router inputs.
    *,
    router: Any,
    arguments: dict[str, Any],
    runtime: Any,
    outcome_type: Any,
    visible_tool_arguments: dict[str, object] | None = None,
    call_id: str = "",
) -> Any:
    """Run one to three valid research tasks in deterministic input order."""

    canonical_call_id = str(call_id or "").strip()
    if not canonical_call_id:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="subagent_batch canonical call id is unavailable",
            retryable=False,
        )
    parent_context = getattr(runtime, "request_context", None)
    parent_request_id = str(
        getattr(parent_context, "request_id", "") or getattr(runtime, "request_id", "") or ""
    ).strip()
    if not parent_request_id:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="subagent_batch parent request id is unavailable",
            retryable=False,
        )
    batch_identity = build_sub_agent_identity(
        parent_request_id=parent_request_id,
        canonical_call_id=canonical_call_id,
        parent_agent_id=getattr(parent_context, "agent_id", None),
        operation=SUBAGENT_BATCH_OPERATION,
    )
    request = validate_subagent_batch_arguments(
        arguments,
        parent_agent_depth=int(getattr(parent_context, "agent_depth", 0) or 0),
    )
    started_at = time.monotonic()
    effective_runtime_budget_ms, parent_synthesis_reserve_ms = _effective_batch_runtime_budget(
        runtime=runtime,
        requested_ms=request.max_total_runtime_ms,
        started_at=started_at,
    )
    context = _BatchContext(
        router=router,
        runtime=runtime,
        outcome_type=outcome_type,
        arguments=arguments,
        visible_tool_arguments=visible_tool_arguments,
        call_id=canonical_call_id,
        parent_context=parent_context,
        parent_request_id=parent_request_id,
        identity=batch_identity,
        request=request,
        started_at=started_at,
        effective_runtime_budget_ms=effective_runtime_budget_ms,
        parent_synthesis_reserve_ms=parent_synthesis_reserve_ms,
    )
    return _execute_validated_batch(context, _BatchState())


def _execute_validated_batch(context: _BatchContext, state: _BatchState) -> Any:
    _emit_queued_children(context)
    cancelled = _cancelled_outcome_if_interrupted(context, state, start_ordinal=1)
    if cancelled is not None:
        return cancelled
    if context.parent_context is None or getattr(
        context.runtime, "sub_agent_slot_allocator", None
    ) is None:
        for task in context.request.tasks:
            _settle_unstarted_task(
                context,
                state,
                task,
                _task_identity_for_context(context, task.ordinal),
                status="rejected" if task.error else "failed",
                error=task.error or runtime_unavailable_error(),
            )
        return _settle_batch(context, state)

    _log_batch(
        context.runtime,
        context.identity,
        event="ai.router.subagent_batch_started",
        level=logging.INFO,
        status="running",
        request=context.request,
        started_at=context.started_at,
    )
    _emit_progress(
        context.runtime,
        context.identity,
        stage="start",
        status="running",
        percent=5,
        summary=f"Starting read-only batch with {len(context.request.tasks)} task(s).",
        tool_call_id=context.call_id,
        route=selected_route(context.router),
    )

    for task in context.request.tasks:
        terminal = _execute_batch_task(context, state, task)
        if terminal is not None:
            return terminal
    return _settle_batch(context, state)


def _emit_queued_children(context: _BatchContext) -> None:
    task_count = len(context.request.tasks)
    route = selected_route(context.router)
    for task in context.request.tasks:
        _emit_progress(
            context.runtime,
            context.identity,
            stage=f"task_{task.ordinal}_queued",
            status="queued",
            percent=_task_percent(task.ordinal, task_count, settled=False),
            summary=f"Task {task.ordinal}/{task_count} queued.",
            tool_call_id=context.call_id,
            child_identity=_task_identity_for_context(context, task.ordinal),
            child_ordinal=task.ordinal,
            child_count=task_count,
            child_label=task.label,
            route=route,
        )


def _execute_batch_task(
    context: _BatchContext,
    state: _BatchState,
    task: SubagentBatchTask,
) -> Any | None:
    cancelled = _cancelled_outcome_if_interrupted(
        context,
        state,
        start_ordinal=task.ordinal,
    )
    if cancelled is not None:
        return cancelled
    task_identity = _task_identity_for_context(context, task.ordinal)
    if task.error:
        _settle_unstarted_task(
            context,
            state,
            task,
            task_identity,
            status="rejected",
            error=task.error,
        )
        _log_task_state(context, state, task_identity, status="rejected", error=task.error)
        return None
    if state.capacity_error:
        _settle_unstarted_task(
            context,
            state,
            task,
            task_identity,
            status="failed",
            error=state.capacity_error,
        )
        return None
    remaining_steps = context.request.max_total_steps - state.iterations_used
    remaining_ms = context.effective_runtime_budget_ms - _elapsed_ms(context.started_at)
    if remaining_steps <= 0 or remaining_ms <= 0:
        _settle_unstarted_task(
            context,
            state,
            task,
            task_identity,
            status="skipped_budget",
            error=budget_exhausted_error(),
        )
        return None
    return _execute_runnable_task(
        context,
        state,
        task,
        task_identity,
        remaining_steps=remaining_steps,
        remaining_ms=remaining_ms,
    )


def _execute_runnable_task(  # noqa: PLR0913 - explicit budget inputs aid review.
    context: _BatchContext,
    state: _BatchState,
    task: SubagentBatchTask,
    task_identity: SubAgentIdentity,
    *,
    remaining_steps: int,
    remaining_ms: int,
) -> Any | None:
    task_request = cast(SubagentRunRequest, task.request)
    remaining_task_count = _remaining_runnable_task_count(
        context.request,
        start_ordinal=task.ordinal,
    )
    effective_request = replace(
        task_request,
        max_steps=min(
            task_request.max_steps,
            max(1, remaining_steps // remaining_task_count),
        ),
        max_runtime_ms=min(
            task_request.max_runtime_ms,
            max(1, remaining_ms // remaining_task_count),
        ),
    )
    state.tasks_started += 1
    try:
        result, report, invalid_report = _invoke_batch_task(
            router=context.router,
            parent_context=context.parent_context,
            runtime=context.runtime,
            batch_identity=context.identity,
            task=task,
            task_identity=task_identity,
            task_count=len(context.request.tasks),
            effective_request=effective_request,
            tool_call_id=context.call_id,
        )
    except TerminalChatStateError as error:
        if error.status != TURN_STATE_CANCELLED:
            raise
        return _settle_cancelled_batch(context, state, start_ordinal=task.ordinal)
    state.reports.append(report)
    state.iterations_used = min(
        context.request.max_total_steps,
        state.iterations_used + int(report["budget"]["iterations_used"]),
    )
    state.tool_results_used += max(0, int(report["budget"]["tool_results_used"]))
    if report["status"] == "completed":
        state.tasks_completed += 1
    if result.completion_reason == COMPLETION_REASON_CAPACITY_UNAVAILABLE:
        state.tasks_started = max(0, state.tasks_started - 1)
        state.capacity_error = dict(report["error"] or capacity_unavailable_error())
    if invalid_report or report["status"] != "completed":
        _log_task_state(
            context,
            state,
            task_identity,
            status=str(report["status"]),
            error=report["error"],
            event=(
                "ai.router.subagent_batch_invalid_report"
                if invalid_report
                else "ai.router.subagent_batch_task_failed"
            ),
        )
    _emit_task_settled(
        context,
        task,
        task_identity,
        report=report,
        status=str(report["status"]),
    )
    return None


def _settle_unstarted_task(  # noqa: PLR0913 - explicit report settlement fields.
    context: _BatchContext,
    state: _BatchState,
    task: SubagentBatchTask,
    identity: SubAgentIdentity,
    *,
    status: str,
    error: dict[str, Any],
) -> None:
    report = build_unstarted_task_report(
        task=task,
        identity=identity,
        status=status,
        error=error,
    )
    state.reports.append(report)
    _emit_task_settled(context, task, identity, report=report, status=status)


def _emit_task_settled(
    context: _BatchContext,
    task: SubagentBatchTask,
    task_identity: SubAgentIdentity,
    *,
    report: dict[str, Any],
    status: str,
) -> None:
    _emit_progress(
        context.runtime,
        context.identity,
        stage=f"task_{task.ordinal}_{status}",
        status=status,
        percent=_task_percent(task.ordinal, len(context.request.tasks), settled=True),
        summary=f"Task {task.ordinal}/{len(context.request.tasks)} settled as {status}.",
        success=status == "completed",
        tool_call_id=context.call_id,
        child_identity=task_identity,
        child_ordinal=task.ordinal,
        child_count=len(context.request.tasks),
        child_label=task.label,
        child_terminal=True,
        child_success=status == "completed",
        usage=report.get("usage"),
        terminal_reason=report.get("terminal_reason"),
    )


def _invoke_batch_task(  # noqa: PLR0913 - explicit task execution dependencies.
    *,
    router: Any,
    parent_context: Any,
    runtime: Any,
    batch_identity: SubAgentIdentity,
    task: Any,
    task_identity: SubAgentIdentity,
    task_count: int,
    effective_request: SubagentRunRequest,
    tool_call_id: str,
) -> tuple[Any, dict[str, Any], bool]:
    _emit_progress(
        runtime,
        batch_identity,
        stage=f"task_{task.ordinal}_running",
        status="running",
        percent=_task_percent(task.ordinal, task_count, settled=False),
        summary=f"Running task {task.ordinal}/{task_count}.",
        tool_call_id=tool_call_id,
        child_identity=task_identity,
        child_ordinal=task.ordinal,
        child_count=task_count,
        child_label=task.label,
        route=selected_route(router),
    )
    task_started_at = time.monotonic()
    result = invoke_sub_agent(
        router=router,
        parent_context=parent_context,
        messages=[{"role": "user", "content": effective_request.prompt}],
        latest_user_content=effective_request.prompt,
        slot_allocator=runtime.sub_agent_slot_allocator,
        runtime=runtime,
        cancel_handle=getattr(runtime, "cancel_handle", None),
        tool_preferences_override=build_subagent_tool_preferences(
            effective_request.allowed_tool_families
        ),
        iteration_budget_override=effective_request.max_steps,
        max_runtime_ms=effective_request.max_runtime_ms,
        identity=task_identity,
    )
    _raise_runtime_interrupted(runtime)
    report, invalid_report = build_settled_task_report(
        task=task,
        request=effective_request,
        identity=task_identity,
        result=result,
        elapsed_ms=_elapsed_ms(task_started_at),
    )
    return result, report, invalid_report


def _cancelled_outcome_if_interrupted(
    context: _BatchContext,
    state: _BatchState,
    *,
    start_ordinal: int,
) -> Any | None:
    try:
        _raise_runtime_interrupted(context.runtime)
    except TerminalChatStateError as error:
        if error.status != TURN_STATE_CANCELLED:
            raise
        return _settle_cancelled_batch(context, state, start_ordinal=start_ordinal)
    return None


def _settle_cancelled_batch(
    context: _BatchContext,
    state: _BatchState,
    *,
    start_ordinal: int,
) -> Any:
    for task in context.request.tasks[start_ordinal - 1 :]:
        _settle_unstarted_task(
            context,
            state,
            task,
            _task_identity_for_context(context, task.ordinal),
            status="cancelled",
            error=cancelled_error(),
        )
    return _settle_batch(context, state)


def _settle_batch(context: _BatchContext, state: _BatchState) -> Any:
    elapsed_ms = _elapsed_ms(context.started_at)
    settlement = build_batch_settlement(
        request=context.request,
        batch_id=context.identity.invocation_id,
        task_reports=state.reports,
        tasks_started=state.tasks_started,
        tasks_completed=state.tasks_completed,
        iterations_used=state.iterations_used,
        tool_results_used=state.tool_results_used,
        elapsed_ms=elapsed_ms,
        effective_max_total_runtime_ms=context.effective_runtime_budget_ms,
        parent_synthesis_reserve_ms=context.parent_synthesis_reserve_ms,
    )
    _emit_progress(
        context.runtime,
        context.identity,
        stage=settlement.status,
        status=settlement.status,
        percent=100,
        summary=f"Read-only subagent batch settled as {settlement.status}.",
        terminal=True,
        success=settlement.success,
        tool_call_id=context.call_id,
        usage=settlement.report.get("usage"),
    )
    _log_batch(
        context.runtime,
        context.identity,
        event="ai.router.subagent_batch_terminal",
        level=logging.INFO if settlement.status == "completed" else logging.WARNING,
        status=settlement.status,
        request=context.request,
        started_at=context.started_at,
        tasks_started=state.tasks_started,
        tasks_completed=state.tasks_completed,
        iterations_used=state.iterations_used,
        tool_results_used=state.tool_results_used,
        error_code=settlement.error_code,
    )
    return context.outcome_type(
        tool_name=SUBAGENT_BATCH_TOOL_NAME,
        output=settlement.output,
        success=settlement.success,
        tool_input=context.visible_tool_arguments or dict(context.arguments),
        content_type="application/json",
        error_code=settlement.error_code,
        metadata={
            "result_kind": "subagent_batch_report",
            "subagent_batch_report": settlement.report,
            "invocation_kind": INVOCATION_KIND_RESEARCH,
        },
        call_id=context.call_id,
    )


def _task_identity_for_context(
    context: _BatchContext,
    ordinal: int,
) -> SubAgentIdentity:
    return _task_identity(
        context.parent_request_id,
        context.call_id,
        context.identity.parent_agent_id,
        ordinal,
    )


def _remaining_runnable_task_count(
    request: SubagentBatchRequest,
    *,
    start_ordinal: int,
) -> int:
    return max(
        1,
        sum(
            1
            for task in request.tasks[start_ordinal - 1 :]
            if task.error is None
        ),
    )


def _effective_batch_runtime_budget(
    *,
    runtime: Any,
    requested_ms: int,
    started_at: float,
) -> tuple[int, int]:
    parent_deadline = getattr(runtime, "wall_clock_deadline", None)
    if not isinstance(parent_deadline, (int, float)):
        return max(0, int(requested_ms)), 0
    parent_remaining_ms = max(0, int((float(parent_deadline) - started_at) * 1000))
    reserve_ms = min(PARENT_SYNTHESIS_RESERVE_MS, parent_remaining_ms)
    child_available_ms = max(0, parent_remaining_ms - reserve_ms)
    return min(max(0, int(requested_ms)), child_available_ms), reserve_ms


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
        operation=SUBAGENT_BATCH_OPERATION,
    )


def _raise_runtime_interrupted(runtime: Any) -> None:
    raise_if_interrupted = getattr(runtime, "raise_if_interrupted", None)
    if callable(raise_if_interrupted):
        raise_if_interrupted(message="subagent batch deadline exceeded")
    elif getattr(runtime, "cancel_handle", None) is not None:
        runtime.cancel_handle.raise_if_cancelled()


def _log_task_state(  # noqa: PLR0913 - fixed diagnostic inputs.
    context: _BatchContext,
    state: _BatchState,
    task_identity: SubAgentIdentity,
    *,
    status: str,
    error: dict[str, Any] | None,
    event: str = "ai.router.subagent_batch_task_failed",
) -> None:
    _log_task_issue(
        context.runtime,
        context.identity,
        task_identity,
        request=context.request,
        started_at=context.started_at,
        status=status,
        error=error,
        tasks_started=state.tasks_started,
        tasks_completed=state.tasks_completed,
        iterations_used=state.iterations_used,
        tool_results_used=state.tool_results_used,
        event=event,
    )


__all__ = ["execute_subagent_batch_tool", "validate_subagent_batch_arguments"]
