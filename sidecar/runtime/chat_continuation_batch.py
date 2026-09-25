"""Whole-batch live checks for a before-tool continuation resume."""

from __future__ import annotations

from typing import Any, NoReturn

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.routing import tool_loop as _tool_loop
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.route_policy_runtime import apply_route_policy_pre_dispatch
from sidecar.ai.routing.tool_call_execution import pre_filter_tool_calls
from sidecar.ai.routing.tool_execution_snapshots import split_visible_execution_arguments
from sidecar.ai.tools.contracts import ToolExecutionFailure, validate_tool_arguments
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.turn_state import current_live_run_mode_state


def attention(reason: str) -> NoReturn:
    raise ToolExecutionFailure(
        code=CMP_TOOL_EXECUTION_FAILED,
        message=f"Continuation resume requires attention: {reason}",
        retryable=False,
        error_details={"failed_phase": reason},
    )


def preflight_pending_batch(
    run: Any,
    result: GenerationResult,
    *,
    approvals: list[Any] | None = None,
) -> tuple[list[tuple[Any, int]], dict[str, dict[str, object]], str]:
    """Recheck the complete saved batch before any producer may start."""

    if not run.mode_policy.allow_tools or not run.kernel._config.tools_enabled:
        attention("tools_disabled")
    shadow = LoopRuntime(request_id=run.request_id, current_iteration=1)
    scratch_outcomes: list[Any] = []
    route, _index = apply_route_policy_pre_dispatch(
        kernel=run.kernel,
        runtime=shadow,
        result=result,
        request_id=run.request_id,
        outcome_index=0,
        outcomes=scratch_outcomes,
        working_messages=[],
        streamed_event_types=set(),
        emit_tool_executing=lambda *_args, **_kwargs: "",
        emit_tool_result=lambda *_args, **_kwargs: None,
        tool_payload=run.tool_payload,
        tool_contract=run.tool_contract,
    )
    if route.blocked or route.result is not result or scratch_outcomes:
        attention("route_policy_changed")
    valid, unknown = _tool_loop._partition_unknown_tool_calls(
        run.kernel,
        result.tool_calls,
        tool_resolution_context=run.tool_resolution_context,
        tool_contract=run.tool_contract,
        request_disabled_tools=run.request_disabled_tools,
    )
    if unknown or tuple(valid) != result.tool_calls:
        attention("tool_contract_changed")
    if run.quota_registry is not None:
        try:
            run.quota_registry.validate_pending_admissions(
                result.tool_calls, tool_contract=run.tool_contract)
        except ValueError:
            attention("tool_quota_changed")
    execution = getattr(run.request_context, "execution_context", None)
    policy = run.kernel._filter_tool_calls_by_policy(
        result.tool_calls,
        mode=run.mode_policy.mode,
        mode_allows_side_effecting=run.mode_policy.allow_side_effecting_tools,
        resolution_context=run.tool_resolution_context,
        tool_contract=run.tool_contract,
        plan_mode=run.plan_mode,
        read_only=run.read_only,
        request_disabled_tools=run.request_disabled_tools,
        policy_snapshot=getattr(execution, "tool_policy_snapshot", None),
    )
    if policy.denied or tuple(policy.allowed) != result.tool_calls:
        attention("tool_policy_changed")
    _check_approval(run, result, policy, approvals)
    scratch_messages: list[dict[str, object]] = []
    scratch_calls: list[Any] = []
    scratch_outcomes = []
    remaining, outcome_index = pre_filter_tool_calls(
        result.tool_calls,
        kernel=run.kernel,
        runtime=shadow,
        result=result,
        request_id=run.request_id,
        tool_resolution_context=run.tool_resolution_context,
        tool_contract=run.tool_contract,
        plan_mode=run.plan_mode,
        read_only=run.read_only,
        request_disabled_tools=run.request_disabled_tools,
        session_id=run.session_id,
        outcomes=scratch_outcomes,
        working_messages=scratch_messages,
        iteration_calls=scratch_calls,
        streamed_event_types=set(),
        outcome_index=0,
    )
    if (
        scratch_outcomes
        or scratch_messages
        or scratch_calls
        or len(remaining) != len(result.tool_calls)
        or any(pair[0] is not call for pair, call in zip(remaining, result.tool_calls, strict=True))
    ):
        attention("tool_prefilter_changed")
    for call in result.tool_calls:
        entry = run.tool_contract.entry(call.tool_id)
        descriptor = (
            entry.descriptor
            if entry is not None
            else (run.kernel._mcp_client.tool_descriptor(call.tool_id))
        )
        if descriptor is None:
            attention("tool_schema_changed")
        try:
            visible_arguments, _attribution = split_visible_execution_arguments(call)
            validate_tool_arguments(
                tool_name=call.tool_id,
                arguments=visible_arguments,
                input_schema=descriptor.input_schema,
            )
        except ToolExecutionFailure:
            attention("tool_schema_changed")
    live_mode = current_live_run_mode_state()
    scan_mode = (
        live_mode.snapshot()[0]
        if live_mode is not None
        else str(getattr(run.request_context, "approval_mode", "prompt"))
    )
    return remaining, policy.audit_metadata_by_call, scan_mode


__all__ = ["attention", "preflight_pending_batch"]


def _check_approval(run: Any, result: Any, policy: Any, approvals: list[Any] | None) -> None:
    before_outcomes = tuple(run.outcomes)
    before_messages = [dict(item) for item in run.working_messages]
    approval, approved = _tool_loop.tool_loop_recovery.approval_with_recovery(
        run, result, policy_decisions_by_call=policy.decisions_by_call
    )
    if (
        approved.tool_calls != result.tool_calls
        or tuple(run.outcomes) != before_outcomes
        or run.working_messages != before_messages
        or (approval is not None and approvals is None)
    ):
        attention("current_approval_required")
    if approvals is not None:
        approvals.append(approval)
