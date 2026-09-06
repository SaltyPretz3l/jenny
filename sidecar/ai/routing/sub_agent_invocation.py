"""Request-scoped read-only sub-agent research boundary."""

from __future__ import annotations

import time
from contextlib import nullcontext
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_SUBAGENT_BUDGET_EXCEEDED,
)
from sidecar.ai.routing.delegation_contract import normalize_delegation_contract
from sidecar.ai.routing.iteration_limits import (
    AGENT_SURFACE_SUB_AGENT,
    SUB_AGENT_REPORT_MODE_PLAIN_TEXT,
    SUB_AGENT_REPORT_MODE_STRUCTURED,
    parse_sub_agent_report_object,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.tool_families import KNOWN_TOOL_FAMILIES
from sidecar.runtime.approval_plan import stable_hash
from sidecar.runtime.chat_models import (
    DISABLED_MEMORY_POLICY,
    ChatRequestContext,
    TerminalChatStateError,
)
from sidecar.runtime.local_engine.request_context import scoped_chat_request_context
from sidecar.runtime.multiplexer import (
    SubAgentSlotAllocator,
    SubAgentSlotLease,
    SubAgentSlotLimitExceededError,
    SubAgentSlotPerParentLimitExceededError,
    TurnCancellationHandle,
)
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED, TURN_STATE_TIMEOUT

if TYPE_CHECKING:
    from sidecar.ai.routing.router import ChatDecision

INVOCATION_KIND_RESEARCH = "research"
SUBAGENT_RUN_OPERATION = "subagent_run"
SUBAGENT_BATCH_OPERATION = "subagent_batch"
DELEGATE_OPERATION = "delegate"
SUBAGENT_OPERATIONS = frozenset(
    {SUBAGENT_RUN_OPERATION, SUBAGENT_BATCH_OPERATION, DELEGATE_OPERATION}
)
COMPLETION_REASON_CAPACITY_UNAVAILABLE = "capacity_unavailable"
SUBAGENT_RUNTIME_UNAVAILABLE_MESSAGE = "Sub-agent runtime is unavailable."
SUBAGENT_CAPACITY_UNAVAILABLE_MESSAGE = "Sub-agent capacity is unavailable."
SUBAGENT_EXECUTION_FAILED_MESSAGE = "Sub-agent execution failed."
SUBAGENT_BUDGET_EXCEEDED_MESSAGE = "Sub-agent exceeded its budget."
SUBAGENT_DEADLINE_EXCEEDED_MESSAGE = (
    "Sub-agent reached the parent turn deadline before producing an answer."
)
_BUDGET_COMPLETION_REASONS = frozenset({"budget_exhausted", "max_iterations_summary"})
_PREFERENCE_KEYS = frozenset({"enabled_tools", "disabled_tools", "disabled_tool_families"})
_DENY_ALL_ENABLED_TOOL_MARKER = "__subagent_no_tools__"


@dataclass(frozen=True)
class SubAgentIdentity:
    invocation_id: str
    task_id: str
    agent_id: str
    parent_agent_id: str


@dataclass(frozen=True)
class SubAgentInvocationResult:
    status: str
    agent_id: str | None = None
    parent_agent_id: str | None = None
    response_text: str = ""
    decision: ChatDecision | None = None
    cancel_handle: TurnCancellationHandle | None = None
    error_code: str | None = None
    error_message: str | None = None
    error_retryable: bool = False
    iterations_used: int = 0
    tool_results_used: int = 0
    observed_tool_names: tuple[str, ...] = ()
    completion_reason: str | None = None
    invocation_kind: str = INVOCATION_KIND_RESEARCH


def build_delegation_contract_payload(  # noqa: PLR0913
    *,
    goal: str,
    context: str,
    boundaries: tuple[str, ...] | list[str],
    tasks: tuple[str, ...] | list[str],
    verification: tuple[str, ...] | list[str],
    return_format: str,
) -> dict[str, Any]:
    normalized = normalize_delegation_contract(
        {
            "goal": goal,
            "context": context,
            "boundaries": boundaries,
            "tasks": tasks,
            "verification": verification,
            "return_format": return_format,
        }
    )
    if normalized is None:
        raise ValueError("research delegation requires goal, tasks, and return_format")
    return normalized


def _parent_agent_id(parent_context: ChatRequestContext) -> str:
    return (
        str(parent_context.agent_id or "").strip()
        or f"main@{str(parent_context.request_id or '').strip()}"
    )


def build_sub_agent_identity(
    *,
    parent_request_id: str,
    canonical_call_id: str,
    parent_agent_id: str | None = None,
    ordinal: int = 1,
    operation: str = SUBAGENT_RUN_OPERATION,
) -> SubAgentIdentity:
    """Build deterministic request-local identity from a canonical tool call."""

    normalized_request_id = str(parent_request_id or "").strip()
    normalized_call_id = str(canonical_call_id or "").strip()
    normalized_ordinal = int(ordinal)
    normalized_operation = str(operation or "").strip()
    if not normalized_request_id:
        raise ValueError("parent_request_id is required")
    if not normalized_call_id:
        raise ValueError("canonical_call_id is required")
    if normalized_ordinal < 1:
        raise ValueError("ordinal must be positive")
    if normalized_operation not in SUBAGENT_OPERATIONS:
        raise ValueError("operation must be a supported sub-agent tool")
    normalized_parent_agent_id = (
        str(parent_agent_id or "").strip() or f"main@{normalized_request_id}"
    )
    invocation_id = f"{normalized_operation}:{normalized_request_id}:{normalized_call_id}"
    return SubAgentIdentity(
        invocation_id=invocation_id,
        task_id=f"{invocation_id}:task:{normalized_ordinal}",
        agent_id=(
            f"{INVOCATION_KIND_RESEARCH}@{normalized_request_id}:"
            f"{normalized_call_id}:{normalized_ordinal}"
        ),
        parent_agent_id=normalized_parent_agent_id,
    )


def build_parent_invocation_hash(*, parent_context: ChatRequestContext) -> str:
    return stable_hash(
        {
            "request_id": parent_context.request_id,
            "session_id": parent_context.session_id,
            "agent_id": parent_context.agent_id,
            "mode": parent_context.mode,
            "invocation_kind": INVOCATION_KIND_RESEARCH,
            "agent_depth": parent_context.agent_depth,
        }
    )


def _preference_sets(
    preferences: dict[str, tuple[str, ...]] | None,
) -> dict[str, set[str]] | None:
    if not isinstance(preferences, dict) or any(
        str(key) not in _PREFERENCE_KEYS for key in preferences
    ):
        return None
    normalized: dict[str, set[str]] = {key: set() for key in _PREFERENCE_KEYS}
    for key, raw_value in preferences.items():
        if not isinstance(raw_value, (tuple, list)):
            return None
        for item in raw_value:
            if not isinstance(item, str) or not item.strip():
                return None
            token = item.strip()
            if key == "disabled_tool_families" and token not in KNOWN_TOOL_FAMILIES:
                return None
            normalized[str(key)].add(token)
    return normalized


def _deny_all_tool_preferences(
    *preference_sets: dict[str, set[str]] | None,
) -> dict[str, tuple[str, ...]]:
    disabled_tools: set[str] = set()
    for preferences in preference_sets:
        if preferences is not None:
            disabled_tools.update(preferences["disabled_tools"])
    return {
        "enabled_tools": (_DENY_ALL_ENABLED_TOOL_MARKER,),
        "disabled_tools": tuple(sorted(disabled_tools)),
        "disabled_tool_families": tuple(sorted(KNOWN_TOOL_FAMILIES)),
    }


def merge_sub_agent_tool_preferences(
    *,
    parent_preferences: dict[str, tuple[str, ...]] | None,
    child_preferences: dict[str, tuple[str, ...]] | None,
) -> dict[str, tuple[str, ...]] | None:
    """Return a monotonic parent/child restriction merge; malformed input denies all."""

    parent = _preference_sets(parent_preferences) if parent_preferences is not None else None
    child = _preference_sets(child_preferences) if child_preferences is not None else None
    if parent_preferences is not None and (parent is None or not any(parent.values())):
        return _deny_all_tool_preferences(parent, child)
    if child_preferences is not None and (child is None or not any(child.values())):
        return _deny_all_tool_preferences(parent, child)

    parent = parent or {key: set() for key in _PREFERENCE_KEYS}
    child = child or {key: set() for key in _PREFERENCE_KEYS}
    parent_enabled = parent["enabled_tools"]
    child_enabled = child["enabled_tools"]
    if parent_enabled and child_enabled:
        enabled_tools = parent_enabled & child_enabled
        if not enabled_tools:
            return _deny_all_tool_preferences(parent, child)
    else:
        enabled_tools = parent_enabled or child_enabled
    merged = {
        "enabled_tools": tuple(sorted(enabled_tools)),
        "disabled_tools": tuple(sorted(parent["disabled_tools"] | child["disabled_tools"])),
        "disabled_tool_families": tuple(
            sorted(parent["disabled_tool_families"] | child["disabled_tool_families"])
        ),
    }
    return merged if any(merged.values()) else None


def _child_request_context(
    *,
    parent_context: ChatRequestContext,
    identity: SubAgentIdentity,
    tool_preferences_override: dict[str, tuple[str, ...]] | None,
    iteration_budget_override: int | None,
    report_mode: str,
) -> ChatRequestContext:
    parent_hash = str(parent_context.parent_approval_plan_hash or "").strip()
    if not parent_hash:
        parent_hash = build_parent_invocation_hash(parent_context=parent_context)
    return ChatRequestContext(
        request_id=identity.task_id,
        trace_id=parent_context.trace_id,
        session_id=parent_context.session_id,
        mode=parent_context.mode,
        approvals_pre_granted=False,
        memory_policy=DISABLED_MEMORY_POLICY,
        reasoning_effort=parent_context.reasoning_effort,
        session_start_date=parent_context.session_start_date,
        current_date=parent_context.current_date,
        plan_mode=False,
        read_only=True,
        tool_preferences=merge_sub_agent_tool_preferences(
            parent_preferences=(
                {}
                if parent_context.sub_agent_tool_preferences_fail_closed
                else parent_context.tool_preferences
            ),
            child_preferences=tool_preferences_override,
        ),
        workspace_root_present=parent_context.workspace_root_present,
        workspace_instruction_present=parent_context.workspace_instruction_present,
        debug_options=parent_context.debug_options,
        session_tool_call_count=parent_context.session_tool_call_count,
        agent_id=identity.agent_id,
        parent_agent_id=identity.parent_agent_id,
        agent_depth=int(parent_context.agent_depth or 0) + 1,
        agent_surface=AGENT_SURFACE_SUB_AGENT,
        parent_approval_plan_hash=parent_hash,
        sub_agent_iteration_budget=(
            iteration_budget_override
            if iteration_budget_override is not None
            else parent_context.sub_agent_iteration_budget
        ),
        sub_agent_concurrency_budget=parent_context.sub_agent_concurrency_budget,
        sub_agent_report_mode=report_mode,
    )


def _delegation_contract_for_research(
    *,
    parent_context: ChatRequestContext,
    report_mode: str,
) -> dict[str, Any]:
    plain_text_mode = report_mode == SUB_AGENT_REPORT_MODE_PLAIN_TEXT
    return build_delegation_contract_payload(
        goal="Read-only research for the parent agent using bounded tool access.",
        context=(
            f"parent_request_id={parent_context.request_id}; "
            f"parent_agent_id={_parent_agent_id(parent_context)}; "
            f"mode={parent_context.mode}"
        ),
        boundaries=(
            "Read-only research; no file mutation, shell execution, browser control, or writes.",
            "Do not add renderer surfaces, JSON-RPC notifications, or persisted event kinds.",
            "Respect one-level sub-agent nesting and request-scoped ephemeral state.",
        ),
        tasks=(
            "Inspect only the explicitly delegated question.",
            "Use granted read-only tools for evidence when useful.",
            "Discover uncertain paths with list, glob, or grep before reading; do not guess paths.",
            "Stop tool use before the final iteration and reserve it for the required answer.",
            (
                "Return one concise plain-text answer without changing external state."
                if plain_text_mode
                else "Return a compact report without changing external state."
            ),
        ),
        verification=(
            (
                "Return a nonblank answer grounded only in the evidence gathered."
                if plain_text_mode
                else (
                    "Return status, summary, uncertainties, and evidence needed by the "
                    "parent agent."
                )
            ),
            "Fail closed when the request exceeds the delegated read-only boundary.",
        ),
        return_format=(
            "one concise, nonblank plain-text answer; do not return JSON"
            if plain_text_mode
            else (
                'one JSON object: {"status":"completed|partial",'
                '"summary":"nonblank","evidence":[],"uncertainties":[]}'
            )
        ),
    )


def _format_delegation_contract_message(contract: dict[str, Any]) -> dict[str, object]:
    return {
        "role": "system",
        "content": (
            "Sub-agent delegation contract\n"
            f"Goal: {contract.get('goal', '')}\n"
            f"Context: {contract.get('context', '')}\n"
            f"Boundaries: {list(contract.get('boundaries', ()))}\n"
            f"Tasks: {list(contract.get('tasks', ()))}\n"
            f"Verification: {list(contract.get('verification', ()))}\n"
            f"Return format: {contract.get('return_format', '')}"
        ),
    }


def _child_loop_runtime(
    *,
    parent_runtime: Any | None,
    child_context: ChatRequestContext,
    child_cancel: TurnCancellationHandle,
    max_runtime_ms: int | None,
    absolute_deadline: float | None = None,
) -> LoopRuntime:
    try:
        max_iterations = int(child_context.sub_agent_iteration_budget or 10)
    except (TypeError, ValueError):
        max_iterations = 10
    parent_deadline = getattr(parent_runtime, "wall_clock_deadline", None)
    deadline = parent_deadline
    if absolute_deadline is not None:
        deadline = (
            float(absolute_deadline)
            if deadline is None
            else min(float(deadline), float(absolute_deadline))
        )
    if max_runtime_ms is not None:
        requested_deadline = time.monotonic() + max(0.001, int(max_runtime_ms) / 1000.0)
        deadline = (
            requested_deadline if deadline is None else min(float(deadline), requested_deadline)
        )
    return LoopRuntime(
        request_id=child_context.request_id,
        trace_id=child_context.trace_id or "",
        session_id=child_context.session_id or "",
        max_iterations=max(1, max_iterations),
        wall_clock_deadline=deadline,
        chunk_inactivity_seconds=getattr(parent_runtime, "chunk_inactivity_seconds", 120.0),
        model_load_grace_seconds=getattr(parent_runtime, "model_load_grace_seconds", 300.0),
        cancel_handle=child_cancel,
        phase_events_enabled=bool(getattr(parent_runtime, "phase_events_enabled", False)),
        observation_store=getattr(parent_runtime, "observation_store", None),
        electron_tool_writer=getattr(parent_runtime, "electron_tool_writer", None),
        electron_tool_reader=getattr(parent_runtime, "electron_tool_reader", None),
        electron_tool_reader_factory=getattr(parent_runtime, "electron_tool_reader_factory", None),
        request_context=child_context,
    )


def _failure_result(  # noqa: PLR0913 - mirrors the fixed failure envelope.
    *,
    child_context: ChatRequestContext,
    child_cancel: TurnCancellationHandle,
    child_runtime: LoopRuntime,
    decision: ChatDecision | None,
    error_code: str,
    error_message: str,
    error_retryable: bool,
    completion_reason: str | None = None,
) -> SubAgentInvocationResult:
    return SubAgentInvocationResult(
        status="failed",
        agent_id=child_context.agent_id,
        parent_agent_id=child_context.parent_agent_id,
        cancel_handle=child_cancel,
        error_code=error_code,
        error_message=error_message,
        error_retryable=error_retryable,
        iterations_used=_bounded_iterations_used(child_runtime),
        tool_results_used=_observed_tool_results_used(child_runtime, decision),
        observed_tool_names=_observed_tool_names_used(decision),
        completion_reason=completion_reason,
    )


def _run_child_decision(  # noqa: PLR0913 - explicit child-runtime seam.
    *,
    router: Any,
    child_context: ChatRequestContext,
    child_runtime: LoopRuntime,
    child_cancel: TurnCancellationHandle,
    child_messages: list[dict[str, object]],
    latest_user_content: str,
    slot_allocator: SubAgentSlotAllocator | None,
    slot_lease: SubAgentSlotLease | None,
) -> tuple[ChatDecision | None, SubAgentInvocationResult | None]:
    decision: ChatDecision | None = None
    try:
        child_runtime.raise_if_interrupted(message="subagent deadline exceeded")
        lease_context = _lease_context(
            slot_allocator=slot_allocator,
            slot_lease=slot_lease,
            child_context=child_context,
        )
        with lease_context, _request_binding(router, child_context):
            child_runtime.raise_if_interrupted(message="subagent deadline exceeded")
            decision = router.build_chat_decision(
                request_context=child_context,
                request_id=child_context.request_id,
                messages=child_messages,
                latest_user_content=latest_user_content,
                mode=child_context.mode,
                approvals_pre_granted=False,
                session_id=child_context.session_id,
                runtime=child_runtime,
                tool_preferences=child_context.tool_preferences,
            )
            if decision is None or not hasattr(decision, "response_text"):
                raise TypeError("router returned no chat decision")
            child_runtime.raise_if_interrupted(message="subagent deadline exceeded")
    except TerminalChatStateError as error:
        if error.status == TURN_STATE_CANCELLED:
            raise
        deadline_exceeded = error.status == TURN_STATE_TIMEOUT
        return decision, _failure_result(
            child_context=child_context,
            child_cancel=child_cancel,
            child_runtime=child_runtime,
            decision=decision,
            error_code=(
                CMP_TOOL_SUBAGENT_BUDGET_EXCEEDED
                if deadline_exceeded
                else CMP_TOOL_EXECUTION_FAILED
            ),
            error_message=(
                SUBAGENT_DEADLINE_EXCEEDED_MESSAGE
                if deadline_exceeded
                else SUBAGENT_EXECUTION_FAILED_MESSAGE
            ),
            error_retryable=not deadline_exceeded,
            completion_reason="deadline_exceeded" if deadline_exceeded else None,
        )
    except (SubAgentSlotLimitExceededError, SubAgentSlotPerParentLimitExceededError):
        return decision, _failure_result(
            child_context=child_context,
            child_cancel=child_cancel,
            child_runtime=child_runtime,
            decision=decision,
            error_code=CMP_TOOL_EXECUTION_FAILED,
            error_message=SUBAGENT_CAPACITY_UNAVAILABLE_MESSAGE,
            error_retryable=True,
            completion_reason=COMPLETION_REASON_CAPACITY_UNAVAILABLE,
        )
    except Exception:  # noqa: BLE001 - converted at the synthetic tool boundary.
        return decision, _failure_result(
            child_context=child_context,
            child_cancel=child_cancel,
            child_runtime=child_runtime,
            decision=decision,
            error_code=CMP_TOOL_EXECUTION_FAILED,
            error_message=SUBAGENT_EXECUTION_FAILED_MESSAGE,
            error_retryable=True,
        )
    return decision, None


def _lease_context(
    *,
    slot_allocator: SubAgentSlotAllocator | None,
    slot_lease: SubAgentSlotLease | None,
    child_context: ChatRequestContext,
) -> SubAgentSlotLease:
    if slot_lease is not None:
        return slot_lease
    if slot_allocator is None:
        raise RuntimeError(SUBAGENT_RUNTIME_UNAVAILABLE_MESSAGE)
    return slot_allocator.acquire(
        parent_agent_id=str(child_context.parent_agent_id or ""),
        agent_id=str(child_context.agent_id or ""),
    )


def _request_binding(router: Any, child_context: ChatRequestContext) -> Any:
    engine = getattr(router, "_engine", None)
    if engine is None:
        return nullcontext()
    return scoped_chat_request_context(
        engine,
        request_context=child_context,
        runtime_config=getattr(router, "_config", None),
        diagnostics_store=getattr(router, "_diagnostics_store", None),
    )


def _release_child_state(router: Any, request_id: str) -> None:
    release_request_state = getattr(
        getattr(router, "_engine", None),
        "release_request_state",
        None,
    )
    if not callable(release_request_state):
        return
    try:
        release_request_state(request_id)
    except Exception:  # noqa: BLE001 - cleanup cannot replace child settlement.
        pass


def _completed_budget_report(
    *,
    completion_reason: str | None,
    response_text: str,
    plain_text_mode: bool,
) -> bool:
    if plain_text_mode:
        return completion_reason in _BUDGET_COMPLETION_REASONS and bool(response_text.strip())
    if completion_reason != "budget_exhausted":
        return False
    parsed_report = parse_sub_agent_report_object(response_text)
    return str(parsed_report.get("status") or "").strip().lower() == "completed"


def _settle_child_response(
    *,
    child_context: ChatRequestContext,
    child_cancel: TurnCancellationHandle,
    child_runtime: LoopRuntime,
    decision: ChatDecision | None,
) -> SubAgentInvocationResult:
    completion_reason = str(child_runtime.completion_reason or "").strip() or None
    response_text = str(getattr(decision, "response_text", "") or "")
    terminal_error_code = str(getattr(decision, "terminal_error_code", "") or "").strip()
    if terminal_error_code:
        return _failure_result(
            child_context=child_context,
            child_cancel=child_cancel,
            child_runtime=child_runtime,
            decision=decision,
            error_code=terminal_error_code,
            error_message=response_text.strip()[:512] or SUBAGENT_EXECUTION_FAILED_MESSAGE,
            error_retryable=bool(getattr(decision, "terminal_error_retryable", False)),
            completion_reason="terminal_error",
        )
    plain_text_mode = child_context.sub_agent_report_mode == SUB_AGENT_REPORT_MODE_PLAIN_TEXT
    base_result = SubAgentInvocationResult(
        status="completed",
        agent_id=child_context.agent_id,
        parent_agent_id=child_context.parent_agent_id,
        response_text=response_text,
        decision=decision,
        cancel_handle=child_cancel,
        iterations_used=_bounded_iterations_used(child_runtime),
        tool_results_used=_observed_tool_results_used(child_runtime, decision),
        observed_tool_names=_observed_tool_names_used(decision),
        completion_reason=completion_reason,
    )
    completed_budget_report = _completed_budget_report(
        completion_reason=completion_reason,
        response_text=response_text,
        plain_text_mode=plain_text_mode,
    )
    if completion_reason in _BUDGET_COMPLETION_REASONS and not completed_budget_report:
        return replace(
            base_result,
            status="failed",
            error_code=CMP_TOOL_SUBAGENT_BUDGET_EXCEEDED,
            error_message=SUBAGENT_BUDGET_EXCEEDED_MESSAGE,
            error_retryable=False,
        )
    if plain_text_mode and not response_text.strip():
        return replace(
            base_result,
            status="failed",
            response_text="",
            error_code=CMP_TOOL_EXECUTION_FAILED,
            error_message="Sub-agent returned a blank answer.",
            error_retryable=False,
        )
    status = (
        "partial"
        if plain_text_mode and completion_reason in _BUDGET_COMPLETION_REASONS
        else "completed"
    )
    return replace(base_result, status=status)


def invoke_sub_agent(  # noqa: PLR0913
    *,
    router: Any,
    parent_context: ChatRequestContext,
    messages: list[dict[str, object]],
    latest_user_content: str,
    slot_allocator: SubAgentSlotAllocator | None,
    runtime: Any | None = None,
    cancel_handle: TurnCancellationHandle | None = None,
    tool_preferences_override: dict[str, tuple[str, ...]] | None = None,
    iteration_budget_override: int | None = None,
    max_runtime_ms: int | None = None,
    identity: SubAgentIdentity | None = None,
    slot_lease: SubAgentSlotLease | None = None,
    report_mode: str = SUB_AGENT_REPORT_MODE_STRUCTURED,
    absolute_deadline: float | None = None,
) -> SubAgentInvocationResult:
    if int(parent_context.agent_depth or 0) >= 1:
        return SubAgentInvocationResult(
            status="rejected",
            agent_id=parent_context.agent_id,
            parent_agent_id=parent_context.parent_agent_id,
            error_code="sub_agent_depth_limit",
        )

    resolved_identity = identity or build_sub_agent_identity(
        parent_request_id=parent_context.request_id,
        canonical_call_id="direct",
        parent_agent_id=_parent_agent_id(parent_context),
    )
    if slot_allocator is None and slot_lease is None:
        return SubAgentInvocationResult(
            status="failed",
            agent_id=resolved_identity.agent_id,
            parent_agent_id=resolved_identity.parent_agent_id,
            error_code=CMP_TOOL_EXECUTION_FAILED,
            error_message=SUBAGENT_RUNTIME_UNAVAILABLE_MESSAGE,
            error_retryable=False,
        )
    child_context = _child_request_context(
        parent_context=parent_context,
        identity=resolved_identity,
        tool_preferences_override=tool_preferences_override,
        iteration_budget_override=iteration_budget_override,
        report_mode=(
            SUB_AGENT_REPORT_MODE_PLAIN_TEXT
            if report_mode == SUB_AGENT_REPORT_MODE_PLAIN_TEXT
            else SUB_AGENT_REPORT_MODE_STRUCTURED
        ),
    )
    child_cancel = (
        cancel_handle.create_child(request_id=child_context.request_id)
        if cancel_handle is not None
        else TurnCancellationHandle(
            request_id=child_context.request_id,
            trace_id=child_context.trace_id,
            session_id=child_context.session_id,
        )
    )
    delegation_contract = _delegation_contract_for_research(
        parent_context=parent_context,
        report_mode=child_context.sub_agent_report_mode,
    )
    child_runtime = _child_loop_runtime(
        parent_runtime=runtime,
        child_context=child_context,
        child_cancel=child_cancel,
        max_runtime_ms=max_runtime_ms,
        absolute_deadline=absolute_deadline,
    )
    child_messages = [_format_delegation_contract_message(delegation_contract), *messages]
    try:
        decision, failure_result = _run_child_decision(
            router=router,
            child_context=child_context,
            child_runtime=child_runtime,
            child_cancel=child_cancel,
            child_messages=child_messages,
            latest_user_content=latest_user_content,
            slot_allocator=slot_allocator,
            slot_lease=slot_lease,
        )
    finally:
        _release_child_state(router, child_context.request_id)
        if cancel_handle is not None:
            cancel_handle.detach_child(child_cancel)

    if failure_result is not None:
        return failure_result
    return _settle_child_response(
        child_context=child_context,
        child_cancel=child_cancel,
        child_runtime=child_runtime,
        decision=decision,
    )


def _bounded_iterations_used(runtime: LoopRuntime) -> int:
    return min(max(int(runtime.current_iteration or 0), 0), max(int(runtime.max_iterations), 1))


def _observed_tool_results_used(
    runtime: LoopRuntime,
    decision: ChatDecision | None,
) -> int:
    if decision is not None:
        return len(tuple(getattr(decision, "tool_results", ()) or ()))
    return len(runtime.tool_result_emitted_call_ids)


def _observed_tool_names_used(decision: ChatDecision | None) -> tuple[str, ...]:
    names: list[str] = []
    for outcome in tuple(getattr(decision, "tool_results", ()) or ()):
        name = str(getattr(outcome, "tool_name", "") or "").strip()
        if name and name not in names:
            names.append(name)
    return tuple(names)


__all__ = [
    "COMPLETION_REASON_CAPACITY_UNAVAILABLE",
    "DELEGATE_OPERATION",
    "INVOCATION_KIND_RESEARCH",
    "SUBAGENT_BATCH_OPERATION",
    "SUBAGENT_RUN_OPERATION",
    "SubAgentIdentity",
    "SubAgentInvocationResult",
    "build_sub_agent_identity",
    "build_delegation_contract_payload",
    "build_parent_invocation_hash",
    "invoke_sub_agent",
    "merge_sub_agent_tool_preferences",
]
