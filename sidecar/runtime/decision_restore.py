"""Restore canonical decision outcomes and ask for fresh consent."""

from __future__ import annotations

from typing import Any

from sidecar.ai.routing import tool_loop
from sidecar.ai.routing.loop_events import ToolCallCompletedEvent
from sidecar.ai.routing.quota_runtime import freeze_runtime_quota
from sidecar.ai.routing.tool_execution_snapshots import (
    freeze_effective_execution_inputs,
    update_read_snapshot_cache,
)
from sidecar.runtime.approval_input_bundle import checkpoint_approval_input
from sidecar.runtime.chat_continuation_batch import attention
from sidecar.runtime.continuation_outcomes import (  # noqa: F401 - compatibility export
    decode_continuation_outcomes as decode_decision_outcomes,
)


def build_restored_approval_result(
    run: Any, *, hydrated: Any, checkpoint: dict, result: Any, approval: Any
) -> Any:
    if (
        checkpoint["decision"]["kind"] != "approval"
        or approval is None
        or approval.tool_call_id != checkpoint["decision"]["call_id"]
        or len(hydrated.restored_inputs()) != len(result.tool_calls)
    ):
        attention("decision_approval_changed")
    runtime = run.runtime
    execution = run.request_context.execution_context
    for outcome in run.outcomes:
        update_read_snapshot_cache(
            run.kernel,
            run.read_snapshot_cache,
            tool_name=outcome.tool_name,
            success=outcome.success,
            metadata=outcome.metadata,
            execution_context=execution,
        )
    rebound_inputs = []
    for call, saved in zip(result.tool_calls, hydrated.restored_inputs(), strict=True):
        rebound = saved.bind_for_attempt(
            call=call, session_id=run.session_id, logical_turn_id=runtime.logical_turn_id,
            execution_context=execution,
        )
        fresh = freeze_effective_execution_inputs(
            run.kernel, call, session_id=run.session_id,
            read_snapshot_cache=run.read_snapshot_cache, tool_contract=run.tool_contract,
            plan_mode=run.plan_mode, read_only=run.read_only,
            turn_id=runtime.logical_turn_id, execution_context=execution,
        )
        comparable = checkpoint_approval_input(fresh)
        if (comparable.effective_args_fingerprint != rebound.effective_args_fingerprint
                or comparable.execution_context_payload != rebound.execution_context_payload):
            attention("decision_frozen_input_changed")
        rebound_inputs.append(fresh)
    plan = tool_loop.build_approval_plan(
        quota_state_json=freeze_runtime_quota(runtime, run.kernel._config,
            outcomes=run.outcomes, tool_contract=run.tool_contract),
        approved_call_id=approval.tool_call_id,
        request_context=run.request_context,
        latest_user_content=run.latest_user_content,
        request_messages_hash=run.request_messages_hash,
        working_messages=run.working_messages,
        generation_result=result,
        tool_calls=result.tool_calls,
        frozen_inputs=tuple(rebound_inputs),
        tool_contract=run.tool_contract,
        tool_resolution_context=run.tool_resolution_context,
        read_snapshot_cache=run.read_snapshot_cache,
        outcomes=tuple(run.outcomes),
        usage_totals=run.usage_totals,
        streamed_event_types=frozenset(run.streamed_event_types),
        system_prompt=run.system_prompt,
        prompt_cache_enabled=run.prompt_cache_enabled,
        cache_source_key=run.cache_source_key,
        remaining_iterations=runtime.max_iterations,
        completed_iterations=runtime.current_iteration,
        wall_clock_deadline=runtime.wall_clock_deadline,
        tool_call_limit=runtime.tool_call_limit,
        remaining_tool_calls=runtime.remaining_tool_calls,
        tool_payload=run.tool_payload,
        tool_statuses=run.tool_statuses,
        parent_approval_plan_hash="",
        config=run.kernel._config,
        engine=run.kernel._engine,
        resolved_max_tokens=tool_loop.resolve_effective_max_tokens(
            run.kernel._config.max_tokens,
            run.kernel._engine.get_model_max_output_tokens(),
            user_override=getattr(run.kernel._config, "resolved_user_max_output_tokens", None),
        ),
    )
    for index, (call, rebound) in enumerate(zip(result.tool_calls, rebound_inputs, strict=True), 1):
        runtime.emit_safe(ToolCallCompletedEvent(
            call_id=call.call_id, tool_name=call.tool_id,
            arguments=dict(rebound.visible_tool_arguments), sequence=index,
        ))
    return tool_loop.ToolLoopResult(
        thinking_text=None,
        thinking_kind=tool_loop.CHAT_THINKING_KIND_STATUS,
        persist_thinking=False,
        response_text="",
        approval_request=approval,
        approval_plan=plan,
        outcomes=run.outcomes,
        usage_totals=run.usage_totals,
        streamed_event_types=run.streamed_event_types,
    )
