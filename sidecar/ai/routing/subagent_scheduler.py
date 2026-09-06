"""Engine-aware scheduling for the model-facing delegation facade."""

from __future__ import annotations

import math
import time
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, replace
from typing import Any, Callable

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_SUBAGENT_BUDGET_EXCEEDED,
)
from sidecar.ai.routing.delegate_contracts import DelegateRequest, DelegateTask
from sidecar.ai.routing.iteration_limits import (
    AGENT_SURFACE_SUB_AGENT,
    effective_max_loop_wall_seconds,
    loop_profile_name,
    max_iterations_for_agent_surface,
)
from sidecar.ai.routing.sub_agent_invocation import (
    DELEGATE_OPERATION,
    SUBAGENT_CAPACITY_UNAVAILABLE_MESSAGE,
    SUBAGENT_DEADLINE_EXCEEDED_MESSAGE,
    SubAgentIdentity,
    SubAgentInvocationResult,
    build_sub_agent_identity,
    invoke_sub_agent,
)
from sidecar.ai.routing.subagent_finalization import SUB_AGENT_REPORT_MODE_PLAIN_TEXT
from sidecar.ai.routing.subagent_run import (
    DEFAULT_ALLOWED_TOOL_FAMILIES,
    build_subagent_tool_preferences,
)
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.subagent_slots import (
    SubAgentSlotLimitExceededError,
    SubAgentSlotPerParentLimitExceededError,
)
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED

PARENT_SYNTHESIS_RESERVE_MS = 60_000


@dataclass(frozen=True)
class ScheduledInvocation:
    task: DelegateTask
    identity: SubAgentIdentity
    result: SubAgentInvocationResult
    elapsed_ms: int
    max_steps: int
    max_runtime_ms: int
    started: bool


@dataclass(frozen=True)
class DelegateSchedule:
    execution: str
    invocations: tuple[ScheduledInvocation, ...]
    effective_max_total_runtime_ms: int
    parent_synthesis_reserve_ms: int
    capacity_rejected: bool = False
    task_iteration_limit: int = 10


TaskSettledCallback = Callable[[ScheduledInvocation], None]
TaskStartedCallback = Callable[[DelegateTask, SubAgentIdentity], None]


def schedule_delegate_tasks(  # noqa: PLR0913 - the scheduler boundary is explicit.
    *,
    router: Any,
    parent_context: Any,
    runtime: Any,
    request: DelegateRequest,
    parent_request_id: str,
    call_id: str,
    parent_agent_id: str,
    on_task_started: TaskStartedCallback | None = None,
    on_task_settled: TaskSettledCallback | None = None,
) -> DelegateSchedule:
    valid_tasks = request.valid_tasks
    execution = execution_for_request(router, request)
    task_iteration_limit = max_iterations_for_agent_surface(
        getattr(router, "_config", None),
        mode=str(getattr(parent_context, "mode", "assist") or "assist"),
        agent_surface=AGENT_SURFACE_SUB_AGENT,
    )
    effective_runtime_ms, reserve_ms, delegate_deadline = _effective_runtime_budget(
        runtime=runtime,
        fallback_ms=max(
            1,
            int(effective_max_loop_wall_seconds(getattr(router, "_config", None)) * 1_000),
        ),
    )
    if not valid_tasks:
        return DelegateSchedule(
            execution,
            (),
            effective_runtime_ms,
            reserve_ms,
            task_iteration_limit=task_iteration_limit,
        )
    identities = {
        task.ordinal: build_sub_agent_identity(
            parent_request_id=parent_request_id,
            canonical_call_id=call_id,
            parent_agent_id=parent_agent_id,
            ordinal=task.ordinal,
            operation=DELEGATE_OPERATION,
        )
        for task in valid_tasks
    }
    if effective_runtime_ms <= 0:
        invocations = _deadline_invocations(
            tasks=valid_tasks,
            identities=identities,
            task_iteration_limit=task_iteration_limit,
            on_task_settled=on_task_settled,
        )
        return DelegateSchedule(
            execution,
            invocations,
            effective_runtime_ms,
            reserve_ms,
            task_iteration_limit=task_iteration_limit,
        )
    if execution == "parallel":
        _prewarm_shared_state(router)
        effective_runtime_ms = _remaining_runtime_ms(delegate_deadline)
        if effective_runtime_ms <= 0:
            invocations = _deadline_invocations(
                tasks=valid_tasks,
                identities=identities,
                task_iteration_limit=task_iteration_limit,
                on_task_settled=on_task_settled,
            )
            return DelegateSchedule(
                execution,
                invocations,
                effective_runtime_ms,
                reserve_ms,
                task_iteration_limit=task_iteration_limit,
            )
        invocations, capacity_rejected = _run_parallel(
            router=router,
            parent_context=parent_context,
            runtime=runtime,
            tasks=valid_tasks,
            identities=identities,
            effective_runtime_ms=effective_runtime_ms,
            delegate_deadline=delegate_deadline,
            task_iteration_limit=task_iteration_limit,
            on_task_started=on_task_started,
            on_task_settled=on_task_settled,
        )
        return DelegateSchedule(
            execution,
            invocations,
            effective_runtime_ms,
            reserve_ms,
            capacity_rejected=capacity_rejected,
            task_iteration_limit=task_iteration_limit,
        )
    invocations = _run_sequential(
        router=router,
        parent_context=parent_context,
        runtime=runtime,
        tasks=valid_tasks,
        identities=identities,
        delegate_deadline=delegate_deadline,
        task_iteration_limit=task_iteration_limit,
        on_task_started=on_task_started,
        on_task_settled=on_task_settled,
    )
    return DelegateSchedule(
        execution,
        invocations,
        effective_runtime_ms,
        reserve_ms,
        task_iteration_limit=task_iteration_limit,
    )


def execution_for_request(router: Any, request: DelegateRequest) -> str:
    if len(request.tasks) == 1:
        return "single"
    if (
        len(request.valid_tasks) > 1
        and loop_profile_name(getattr(router, "_config", None)) == "cloud"
    ):
        return "parallel"
    return "sequential"


def _run_sequential(  # noqa: PLR0913
    *,
    router: Any,
    parent_context: Any,
    runtime: Any,
    tasks: tuple[DelegateTask, ...],
    identities: dict[int, SubAgentIdentity],
    delegate_deadline: float,
    task_iteration_limit: int,
    on_task_started: TaskStartedCallback | None,
    on_task_settled: TaskSettledCallback | None,
) -> tuple[ScheduledInvocation, ...]:
    settled: list[ScheduledInvocation] = []
    for index, task in enumerate(tasks):
        remaining_ms = max(0, int((delegate_deadline - time.monotonic()) * 1_000))
        if remaining_ms <= 0:
            invocation = _unstarted_invocation(
                task,
                identities[task.ordinal],
                max_steps=task_iteration_limit,
                max_runtime_ms=0,
                error_code=CMP_TOOL_SUBAGENT_BUDGET_EXCEEDED,
                error_message=SUBAGENT_DEADLINE_EXCEEDED_MESSAGE,
                completion_reason="deadline_exceeded",
            )
        else:
            invocation = _invoke_task(
                router=router,
                parent_context=parent_context,
                runtime=runtime,
                task=task,
                identity=identities[task.ordinal],
                max_steps=task_iteration_limit,
                max_runtime_ms=remaining_ms,
                absolute_deadline=delegate_deadline,
                on_task_started=on_task_started,
            )
        settled.append(invocation)
        if on_task_settled is not None:
            on_task_settled(invocation)
        if invocation.result.status == "cancelled":
            for remaining_task in tasks[index + 1 :]:
                cancelled = _cancelled_invocation(
                    remaining_task,
                    identities[remaining_task.ordinal],
                    max_steps=task_iteration_limit,
                    max_runtime_ms=max(
                        0,
                        int((delegate_deadline - time.monotonic()) * 1_000),
                    ),
                )
                settled.append(cancelled)
                if on_task_settled is not None:
                    on_task_settled(cancelled)
            break
    return tuple(settled)


def _run_parallel(  # noqa: PLR0913
    *,
    router: Any,
    parent_context: Any,
    runtime: Any,
    tasks: tuple[DelegateTask, ...],
    identities: dict[int, SubAgentIdentity],
    effective_runtime_ms: int,
    delegate_deadline: float,
    task_iteration_limit: int,
    on_task_started: TaskStartedCallback | None,
    on_task_settled: TaskSettledCallback | None,
) -> tuple[tuple[ScheduledInvocation, ...], bool]:
    allocator = getattr(runtime, "sub_agent_slot_allocator", None)
    if allocator is None:
        failed = tuple(
            _capacity_invocation(
                task,
                identities[task.ordinal],
                max_steps=task_iteration_limit,
                max_runtime_ms=effective_runtime_ms,
            )
            for task in tasks
        )
        _notify_settled(failed, on_task_settled)
        return failed, True
    try:
        leases = allocator.acquire_many(
            parent_agent_id=str(next(iter(identities.values())).parent_agent_id),
            agent_ids=(identities[task.ordinal].agent_id for task in tasks),
        )
    except (SubAgentSlotLimitExceededError, SubAgentSlotPerParentLimitExceededError):
        failed = tuple(
            _capacity_invocation(
                task,
                identities[task.ordinal],
                max_steps=task_iteration_limit,
                max_runtime_ms=effective_runtime_ms,
            )
            for task in tasks
        )
        _notify_settled(failed, on_task_settled)
        return failed, True

    futures: dict[Future[ScheduledInvocation], DelegateTask] = {}
    settled_by_ordinal: dict[int, ScheduledInvocation] = {}
    try:
        with ThreadPoolExecutor(
            max_workers=len(tasks),
            thread_name_prefix="jenny-delegate",
        ) as executor:
            for task, lease in zip(tasks, leases, strict=True):
                future = executor.submit(
                    _invoke_task,
                    router=router,
                    parent_context=parent_context,
                    runtime=runtime,
                    task=task,
                    identity=identities[task.ordinal],
                    max_steps=task_iteration_limit,
                    max_runtime_ms=effective_runtime_ms,
                    slot_lease=lease,
                    absolute_deadline=delegate_deadline,
                    on_task_started=on_task_started,
                )
                futures[future] = task
            for future in as_completed(futures):
                task = futures[future]
                try:
                    invocation = future.result()
                except TerminalChatStateError as error:
                    invocation = _cancelled_invocation(
                        task,
                        identities[task.ordinal],
                        max_steps=task_iteration_limit,
                        max_runtime_ms=effective_runtime_ms,
                        message=str(error),
                    )
                except Exception:  # noqa: BLE001 - isolate one provider/worker failure.
                    invocation = _unstarted_invocation(
                        task,
                        identities[task.ordinal],
                        max_steps=task_iteration_limit,
                        max_runtime_ms=effective_runtime_ms,
                        error_code=CMP_TOOL_EXECUTION_FAILED,
                        error_message="Sub-agent execution failed.",
                    )
                settled_by_ordinal[task.ordinal] = invocation
                if on_task_settled is not None:
                    on_task_settled(invocation)
    finally:
        for lease in leases:
            lease.release()
    return tuple(settled_by_ordinal[task.ordinal] for task in tasks), False


def _invoke_task(  # noqa: PLR0913
    *,
    router: Any,
    parent_context: Any,
    runtime: Any,
    task: DelegateTask,
    identity: SubAgentIdentity,
    max_steps: int,
    max_runtime_ms: int,
    slot_lease: Any | None = None,
    absolute_deadline: float | None = None,
    on_task_started: TaskStartedCallback | None = None,
) -> ScheduledInvocation:
    if on_task_started is not None:
        on_task_started(task, identity)
    started_at = time.monotonic()
    try:
        result = invoke_sub_agent(
            router=router,
            parent_context=parent_context,
            messages=[{"role": "user", "content": str(task.prompt or "")}],
            latest_user_content=str(task.prompt or ""),
            slot_allocator=getattr(runtime, "sub_agent_slot_allocator", None),
            runtime=runtime,
            cancel_handle=getattr(runtime, "cancel_handle", None),
            tool_preferences_override=build_subagent_tool_preferences(
                DEFAULT_ALLOWED_TOOL_FAMILIES
            ),
            iteration_budget_override=max_steps,
            max_runtime_ms=max_runtime_ms,
            identity=identity,
            slot_lease=slot_lease,
            report_mode=SUB_AGENT_REPORT_MODE_PLAIN_TEXT,
            absolute_deadline=absolute_deadline,
        )
    except TerminalChatStateError as error:
        if error.status != TURN_STATE_CANCELLED:
            raise
        result = SubAgentInvocationResult(
            status="cancelled",
            agent_id=identity.agent_id,
            parent_agent_id=identity.parent_agent_id,
            error_code=CMP_TOOL_EXECUTION_FAILED,
            error_message="Sub-agent cancelled by parent.",
            error_retryable=False,
            completion_reason="cancelled",
        )
    except Exception:  # noqa: BLE001 - settle one started child without leaking provider data.
        result = SubAgentInvocationResult(
            status="failed",
            agent_id=identity.agent_id,
            parent_agent_id=identity.parent_agent_id,
            error_code=CMP_TOOL_EXECUTION_FAILED,
            error_message="Sub-agent execution failed.",
            error_retryable=False,
        )
    return ScheduledInvocation(
        task=task,
        identity=identity,
        result=result,
        elapsed_ms=_elapsed_ms(started_at),
        max_steps=max_steps,
        max_runtime_ms=max_runtime_ms,
        started=True,
    )


def _unstarted_invocation(  # noqa: PLR0913 - fixed settlement envelope.
    task: DelegateTask,
    identity: SubAgentIdentity,
    *,
    max_steps: int,
    max_runtime_ms: int,
    error_code: str,
    error_message: str,
    completion_reason: str | None = None,
) -> ScheduledInvocation:
    return ScheduledInvocation(
        task=task,
        identity=identity,
        result=SubAgentInvocationResult(
            status="failed",
            agent_id=identity.agent_id,
            parent_agent_id=identity.parent_agent_id,
            error_code=error_code,
            error_message=error_message,
            error_retryable=completion_reason == "capacity_unavailable",
            completion_reason=completion_reason,
        ),
        elapsed_ms=0,
        max_steps=max_steps,
        max_runtime_ms=max_runtime_ms,
        started=False,
    )


def _capacity_invocation(
    task: DelegateTask,
    identity: SubAgentIdentity,
    *,
    max_steps: int,
    max_runtime_ms: int,
) -> ScheduledInvocation:
    return _unstarted_invocation(
        task,
        identity,
        max_steps=max_steps,
        max_runtime_ms=max_runtime_ms,
        error_code=CMP_TOOL_EXECUTION_FAILED,
        error_message=SUBAGENT_CAPACITY_UNAVAILABLE_MESSAGE,
        completion_reason="capacity_unavailable",
    )


def _cancelled_invocation(
    task: DelegateTask,
    identity: SubAgentIdentity,
    *,
    max_steps: int,
    max_runtime_ms: int,
    message: str = "Sub-agent cancelled by parent.",
) -> ScheduledInvocation:
    invocation = _unstarted_invocation(
        task,
        identity,
        max_steps=max_steps,
        max_runtime_ms=max_runtime_ms,
        error_code=CMP_TOOL_EXECUTION_FAILED,
        error_message=message or "Sub-agent cancelled by parent.",
        completion_reason="cancelled",
    )
    return replace(invocation, result=replace(invocation.result, status="cancelled"))


def _effective_runtime_budget(
    *,
    runtime: Any,
    fallback_ms: int,
) -> tuple[int, int, float]:
    now = time.monotonic()
    parent_deadline = getattr(runtime, "wall_clock_deadline", None)
    if isinstance(parent_deadline, (int, float)) and math.isfinite(float(parent_deadline)):
        remaining_ms = max(0, int((float(parent_deadline) - now) * 1_000))
    else:
        remaining_ms = max(0, int(fallback_ms))
    reserve_ms = min(PARENT_SYNTHESIS_RESERVE_MS, remaining_ms)
    effective_runtime_ms = max(0, remaining_ms - reserve_ms)
    return effective_runtime_ms, reserve_ms, now + (effective_runtime_ms / 1_000.0)


def _remaining_runtime_ms(deadline: float) -> int:
    return max(0, int((deadline - time.monotonic()) * 1_000))


def _deadline_invocations(
    *,
    tasks: tuple[DelegateTask, ...],
    identities: dict[int, SubAgentIdentity],
    task_iteration_limit: int,
    on_task_settled: TaskSettledCallback | None,
) -> tuple[ScheduledInvocation, ...]:
    invocations = tuple(
        _unstarted_invocation(
            task,
            identities[task.ordinal],
            max_steps=task_iteration_limit,
            max_runtime_ms=0,
            error_code=CMP_TOOL_SUBAGENT_BUDGET_EXCEEDED,
            error_message=SUBAGENT_DEADLINE_EXCEEDED_MESSAGE,
            completion_reason="deadline_exceeded",
        )
        for task in tasks
    )
    _notify_settled(invocations, on_task_settled)
    return invocations


def _prewarm_shared_state(router: Any) -> None:
    """Resolve lazy shared caches before child worker threads can contend on them."""

    tokenizer = getattr(router, "_tokenizer_backend", None)
    if callable(tokenizer):
        tokenizer()
    builder = getattr(router, "_context_builder", None)
    for name in (
        "_load_bootstrap_blocks",
        "_load_workspace_instruction_block",
        "_load_skills",
    ):
        loader = getattr(builder, name, None)
        if callable(loader):
            loader()


def _notify_settled(
    invocations: tuple[ScheduledInvocation, ...],
    callback: TaskSettledCallback | None,
) -> None:
    if callback is None:
        return
    for invocation in invocations:
        callback(invocation)


def _elapsed_ms(started_at: float) -> int:
    return max(0, int((time.monotonic() - started_at) * 1_000))


__all__ = [
    "DelegateSchedule",
    "ScheduledInvocation",
    "execution_for_request",
    "schedule_delegate_tasks",
]
