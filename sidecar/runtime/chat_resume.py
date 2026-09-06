"""Approval-resume + live-context validation cluster for the chat runtime hub.

Owns the resume-after-approval entry point
(``resume_chat_send_response_from_approval_plan``) and its supporting
live-context recomputation/validation helpers.  Import direction: this module
imports shared leaf helpers from ``chat_response_builders`` and the decision
serializer from ``chat_decision_render``.

Several helpers here are monkeypatched by tests on the ``sidecar.runtime.chat``
module object (``_validate_approval_plan_live_context``,
``_build_live_approval_system_prompt``, ``_build_live_dynamic_system_messages``,
``build_dynamic_system_messages``, ``describe_approval_plan_changes``).  Every
call to one of those names is resolved late through ``_chat_hub`` so a patch on
``chat.NAME`` is honored regardless of which sibling the caller lives in.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from sidecar.ai.config import resolve_effective_max_tokens
from sidecar.ai.container import BrainContainer
from sidecar.ai.context.builder import ContextBuilder, normalize_learned_lessons
from sidecar.ai.context.prompt_cache import resolve_current_date
from sidecar.ai.feature_flags import (
    FEATURE_CANONICAL_TURN_EVENTS,
    is_feature_flag_enabled,
)
from sidecar.ai.routing.iteration_limits import (
    effective_chunk_inactivity_seconds,
    effective_max_loop_wall_seconds,
    effective_max_tools_per_turn,
)
from sidecar.ai.routing.mutation_change_set_lifecycle import (
    bind_run_context,
    finish_run_change_set,
)
from sidecar.ai.routing.plan_mode_transition import (
    apply_restored_tool_contract,
    transition_after_exit_outcome,
)
from sidecar.ai.routing.router import ChatDecision
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.plan_artifact_policy import PLAN_ARTIFACT_WRITE_ARG
from sidecar.ai.tools.tool_actions import effective_side_effecting
from sidecar.runtime.approval_plan import (
    ApprovalPlan,
    build_effective_args_fingerprint,
    build_execution_context_fingerprint,
    build_message_history_hash,
    build_model_identity_fingerprint,
    build_sampling_params_hash,
    build_tool_contract_hash,
    stable_hash,
)
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_helpers import notification_context
from sidecar.runtime.chat_models import (
    ChatRequestError,
    ChatResponse,
    TerminalChatStateError,
)
from sidecar.runtime.chat_response_builders import (
    _terminal_chat_response,
    _tool_failure_error_data,
)
from sidecar.runtime.chat_resume_prefix import (  # noqa: F401 - re-exported by chat.py
    _build_live_approval_working_messages,
    _is_live_dynamic_system_message,
    personality_row_is_replaceable,
    plan_personality_block_present,
)
from sidecar.runtime.chat_resume_prompt_normalization import (
    normalize_volatile_system_prompt_text as _normalize_volatile_system_prompt_text,
)
from sidecar.runtime.chat_serialization import _serialize_loop_event, _serialize_turn_event
from sidecar.runtime.chat_tool_observations import chat_response_with_tool_observations
from sidecar.runtime.ipc_payloads import IpcPayloadExternalizer
from sidecar.runtime.local_engine.request_context import scoped_chat_request_context
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.turn_retry import (
    MAX_INNER_TURN_RETRIES,
    InnerRetryableTurnError,
    execute_with_inner_turn_retry,
)
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
    TURN_STATE_PREEMPTED,
)

_APPROVAL_PLAN_DRIFT_DIAGNOSTIC_COMPONENTS = frozenset(
    {
        "approved_call",
        "effective_args",
        "execution_context",
        "message_history",
        "model_identity",
        "request_messages",
        "sampling_params",
        "system_prompt",
        "tool_budget",
        "tool_contract",
    }
)




def _approval_resume_deadline(plan: Any, *, max_loop_wall_seconds: float) -> float:
    existing = getattr(plan, "wall_clock_deadline", None)
    if existing is not None:
        return float(existing)
    return time.monotonic() + max(0.0, float(max_loop_wall_seconds))


def _approval_resume_exhausted_factory(
    plan: ApprovalPlan,
):
    def _handle_exhausted(
        error: InnerRetryableTurnError,
        attempts: int,
    ) -> ChatResponse:
        normalized_subcode = str(error.terminal_subcode or "").strip().lower()
        if "plan_drift" in normalized_subcode:
            from . import chat as _chat_hub

            mismatch_components = sorted(
                _APPROVAL_PLAN_DRIFT_DIAGNOSTIC_COMPONENTS.intersection(
                    str(component or "").strip()
                    for component in error.diagnostic_components
                )
            )
            _chat_hub.log_event(
                _chat_hub.logger,
                logging.WARNING,
                component="runtime.chat_resume",
                event="sidecar.runtime.chat_send.approval_plan_drift",
                message="Approval plan drifted after resume retries were exhausted.",
                status=TURN_STATE_PREEMPTED,
                trace_id=plan.trace_id,
                request_id=plan.request_id,
                session_id=plan.session_id,
                data={
                    "terminal_subcode": TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
                    "attempt_count": attempts,
                    "mismatch_components": mismatch_components,
                },
            )
            return _terminal_chat_response(
                request_id=plan.request_id,
                status=TURN_STATE_PREEMPTED,
                terminal_subcode=TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
            )
        raise error

    return _handle_exhausted


def _approval_audit_metadata_map(
    plan: ApprovalPlan,
    *,
    call_ids: frozenset[str] | None = None,
) -> dict[str, dict[str, object]]:
    metadata_by_call: dict[str, dict[str, object]] = {}
    for frozen_input in plan.frozen_inputs:
        if call_ids is not None and frozen_input.call_id not in call_ids:
            continue
        audit_injected_arg_keys = [
            key
            for key in frozen_input.injected_arg_keys
            if key != PLAN_ARTIFACT_WRITE_ARG
        ]
        metadata_by_call[frozen_input.call_id] = {
            "approval_plan_hash": plan.approval_plan_hash,
            "approval_effective_args_fingerprint": frozen_input.effective_args_fingerprint,
            "approval_execution_context_fingerprint": plan.execution_context_fingerprint,
            "approval_model_identity_fingerprint": plan.model_identity_fingerprint,
            "approval_system_prompt_hash": plan.system_prompt_hash,
            "approval_sampling_params_hash": plan.sampling_params_hash,
            "approval_message_history_hash": plan.message_history_hash,
            "approval_tool_contract_hash": plan.tool_contract_hash,
            "approval_parent_approval_plan_hash": plan.parent_approval_plan_hash,
            "approval_injected_arg_keys": audit_injected_arg_keys,
        }
    return metadata_by_call


def _approval_resume_descriptor(
    *,
    kernel: Any,
    tool_contract: Any | None,
    call: Any,
) -> Any | None:
    entry_lookup = getattr(tool_contract, "entry", None)
    entry = entry_lookup(call.tool_id) if callable(entry_lookup) else None
    if entry is not None:
        return entry.descriptor
    mcp_client = getattr(kernel, "_mcp_client", None)
    descriptor_lookup = getattr(mcp_client, "tool_descriptor", None)
    if callable(descriptor_lookup):
        return descriptor_lookup(call.tool_id)
    return None


def _approval_resume_call_window(
    plan: ApprovalPlan,
    *,
    kernel: Any,
    tool_contract: Any | None,
) -> tuple[tuple[Any, ...], tuple[Any, ...]]:
    """Return ``(selected, dropped)`` calls for the approved execution window.

    ``dropped`` carries every plan call that this resume will NOT execute even
    though the whole batch was already reserved against the turn tool budget:
    earlier side-effecting calls, earlier calls with no descriptor, and every
    call after the approved one. Callers must settle them explicitly -- a silent
    discard leaves the budget debited for work that never ran.
    """

    approved_call_id = str(plan.approved_call_id or plan.call_id or "").strip()
    selected: list[Any] = []
    dropped: list[Any] = []
    for index, call in enumerate(plan.tool_calls):
        call_id = str(getattr(call, "call_id", "") or "").strip()
        if approved_call_id and call_id == approved_call_id:
            selected.append(call)
            dropped.extend(plan.tool_calls[index + 1 :])
            return tuple(selected), tuple(dropped)
        descriptor = _approval_resume_descriptor(
            kernel=kernel,
            tool_contract=tool_contract,
            call=call,
        )
        if descriptor is not None and not bool(
            effective_side_effecting(descriptor, getattr(call, "arguments", {}) or {})
        ):
            selected.append(call)
        else:
            dropped.append(call)

    raise InnerRetryableTurnError(
        reason="Approved tool call is missing from the cached approval plan.",
        retry_prompt=(
            "The approved tool call is no longer present in the frozen tool plan. "
            "Re-evaluate the request and emit a fresh tool plan."
        ),
        terminal_subcode="approval_plan_drift",
        diagnostic_components=("approved_call",),
    )


def _approval_resume_tool_budget(
    plan: ApprovalPlan,
    *,
    configured_limit: int,
) -> tuple[int, int, bool]:
    """Return ``(limit, remaining, valid)`` for approval-resume continuity.

    Plans created before the budget fields existed carry zero defaults; those
    remain compatible by starting from the current configured limit.  New plans
    must match that limit and contain an in-range remaining count.
    """

    current_limit = max(int(configured_limit), 1)
    try:
        plan_limit = int(getattr(plan, "tool_call_limit", 0) or 0)
        plan_remaining = int(getattr(plan, "remaining_tool_calls", 0) or 0)
    except (TypeError, ValueError):
        return current_limit, 0, False
    if plan_limit == 0:
        return current_limit, current_limit, True
    valid = (
        plan_limit == current_limit
        and plan_limit > 0
        and 0 <= plan_remaining <= plan_limit
    )
    return plan_limit, min(max(plan_remaining, 0), max(plan_limit, 0)), valid


def _build_live_approval_system_prompt(
    plan: ApprovalPlan,
    *,
    brain_container: BrainContainer,
    live_params: dict[str, Any] | None,
    tool_statuses: Any,
) -> Any:
    stack = brain_container.stack
    learned_lessons = normalize_learned_lessons(
        live_params.get("learning_context") if isinstance(live_params, dict) else None
    )
    session_start_date = str(
        plan.request_context.session_start_date or stack.config.session_start_date or ""
    ).strip()
    pinned_current_date = str(
        plan.request_context.current_date or resolve_current_date()
    ).strip()
    if plan.prompt_cache_enabled:
        return stack.router._context_builder.build_system_prompt(
            stack.config.system_prompt,
            learned_lessons=learned_lessons,
            cache_aware=True,
            session_start_date=session_start_date,
            current_date=pinned_current_date,
            tool_statuses=list(tool_statuses),
            latest_user_content=plan.latest_user_content,
            engine_type=stack.config.engine_type,
            include_skills=False,
            workspace_manifest_enabled=getattr(
                stack.config, "tools_workspace_manifest_enabled", False
            ),
            task_capsule_enabled=getattr(
                stack.config, "tools_task_capsule_enabled", False
            ),
        )
    return stack.router._context_builder.build_system_prompt(
        stack.config.system_prompt,
        learned_lessons=learned_lessons,
        session_start_date=session_start_date,
        current_date=pinned_current_date,
        tool_statuses=list(tool_statuses),
        latest_user_content=plan.latest_user_content,
        engine_type=stack.config.engine_type,
        include_skills=False,
        workspace_manifest_enabled=getattr(
            stack.config, "tools_workspace_manifest_enabled", False
        ),
        task_capsule_enabled=getattr(
            stack.config, "tools_task_capsule_enabled", False
        ),
    )


def _build_live_dynamic_system_messages(
    *,
    brain_container: BrainContainer,
    tool_statuses: Any,
    plan: ApprovalPlan | None = None,
) -> list[dict[str, Any]]:
    from . import chat as _chat_hub

    stack = brain_container.stack
    config = stack.config
    messages = _chat_hub.build_dynamic_system_messages(
        context_builder=stack.router._context_builder,
        config=config,
        tool_statuses=tool_statuses,
        # A plan whose request carried a personality block already holds that
        # ``## Personality`` row; a second bare one would read as drift here.
        personality_rendered=plan_personality_block_present(plan),
    )
    if plan is not None:
        for item in plan.working_messages[1:]:
            if str(item.get("role") or "") != "system":
                break
            content = item.get("content")
            if ContextBuilder.is_runtime_system_message(content):
                messages.append({"role": "system", "content": str(content)})
    return messages


def _rebuild_approval_resume_read_snapshot_cache(
    plan: ApprovalPlan,
    *,
    kernel: Any,
    canonical_session_messages: Any,
) -> dict[str, dict[str, object]]:
    cache = kernel._rebuild_read_snapshot_cache(
        canonical_session_messages if isinstance(canonical_session_messages, list) else None
    )
    for outcome in plan.outcomes:
        metadata = getattr(outcome, "metadata", None)
        kernel._update_read_snapshot_cache(
            cache,
            tool_name=str(getattr(outcome, "tool_name", "") or "").strip(),
            success=bool(getattr(outcome, "success", False)),
            metadata=metadata if isinstance(metadata, dict) else {},
        )
    return cache


def _validate_approval_plan_live_context(
    plan: ApprovalPlan,
    *,
    brain_container: BrainContainer,
    live_params: dict[str, Any] | None,
    canonical_session_messages: Any,
) -> None:
    from . import chat as _chat_hub

    stack = brain_container.stack
    kernel = stack.router
    current_tool_contract = kernel._assemble_tool_contract(
        request_context=plan.request_context,
        resolution_context=plan.tool_resolution_context,
    )
    live_read_snapshot_cache = _rebuild_approval_resume_read_snapshot_cache(
        plan,
        kernel=kernel,
        canonical_session_messages=canonical_session_messages,
    )
    resume_tool_calls, _dropped_tool_calls = _approval_resume_call_window(
        plan,
        kernel=kernel,
        tool_contract=current_tool_contract,
    )

    def _frozen_plan_artifact_write(call: Any) -> bool:
        frozen_input = plan.frozen_input_for_call(
            str(getattr(call, "call_id", "") or "").strip()
        )
        return bool(
            frozen_input is not None
            and frozen_input.effective_tool_arguments.get(PLAN_ARTIFACT_WRITE_ARG) is True
        )

    current_frozen_inputs = tuple(
        kernel._freeze_effective_execution_inputs(
            call,
            session_id=plan.session_id,
            read_snapshot_cache=live_read_snapshot_cache,
            tool_contract=current_tool_contract,
            plan_mode=plan.request_context.plan_mode,
            read_only=plan.request_context.read_only,
            trusted_plan_artifact_write=_frozen_plan_artifact_write(call),
        )
        for call in resume_tool_calls
    )
    expected_frozen_inputs = tuple(
        frozen_input
        for frozen_input in (
            plan.frozen_input_for_call(str(getattr(call, "call_id", "") or "").strip())
            for call in resume_tool_calls
        )
        if frozen_input is not None
    )
    current_system_prompt = _chat_hub._build_live_approval_system_prompt(
        plan,
        brain_container=brain_container,
        live_params=live_params,
        tool_statuses=current_tool_contract.status_entries,
    )
    current_dynamic_system_messages = _chat_hub._build_live_dynamic_system_messages(
        brain_container=brain_container,
        tool_statuses=current_tool_contract.status_entries,
        plan=plan,
    )
    current_request_messages = (
        live_params.get("messages") if isinstance(live_params, dict) else None
    )
    current_tool_contract_hash = build_tool_contract_hash(current_tool_contract)
    current_effective_args_fingerprint = build_effective_args_fingerprint(
        current_frozen_inputs
    )
    expected_effective_args_fingerprint = build_effective_args_fingerprint(
        expected_frozen_inputs
    )
    current_execution_context_fingerprint = build_execution_context_fingerprint(
        current_frozen_inputs
    )
    expected_execution_context_fingerprint = build_execution_context_fingerprint(
        expected_frozen_inputs
    )
    current_model_identity_fingerprint = build_model_identity_fingerprint(
        config=stack.config,
        engine=stack.engine,
    )
    # Compare prompts with volatile lines (workspace-manifest ``Generated:``)
    # neutralized on BOTH sides. The frozen plan carries the full prompt, so
    # the normalized frozen hash is recomputed here; ``plan.system_prompt_hash``
    # stays raw for audit metadata and the plan fingerprint.
    normalized_current_prompt_text = _normalize_volatile_system_prompt_text(
        str(current_system_prompt)
    )
    normalized_frozen_prompt_text = _normalize_volatile_system_prompt_text(
        str(plan.system_prompt)
    )
    current_system_prompt_hash = stable_hash(str(current_system_prompt))
    system_prompt_mismatch = normalized_current_prompt_text != normalized_frozen_prompt_text
    current_sampling_params_hash = build_sampling_params_hash(
        config=stack.config,
        request_context=plan.request_context,
        resolved_max_tokens=resolve_effective_max_tokens(
            stack.config.max_tokens,
            stack.engine.get_model_max_output_tokens(),
            user_override=getattr(stack.config, "resolved_user_max_output_tokens", None),
        ),
        prompt_cache_enabled=plan.prompt_cache_enabled,
    )
    current_request_messages_hash = (
        build_message_history_hash(current_request_messages)
        if isinstance(current_request_messages, list)
        else None
    )
    # The working-message comparison embeds the system prompt as slot 0, so it
    # gets the same volatile-line normalization on both sides.
    current_working_messages = _build_live_approval_working_messages(
        plan,
        live_system_prompt=normalized_current_prompt_text,
        dynamic_system_messages=current_dynamic_system_messages,
        personality_row_replaceable=personality_row_is_replaceable(plan, stack.config),
    )
    expected_working_messages = [dict(item) for item in plan.working_messages]
    if (
        expected_working_messages
        and str(expected_working_messages[0].get("role") or "") == "system"
    ):
        expected_working_messages[0]["content"] = normalized_frozen_prompt_text
    current_message_history_hash = build_message_history_hash(current_working_messages)
    expected_message_history_hash = build_message_history_hash(expected_working_messages)
    current_tool_call_limit = max(effective_max_tools_per_turn(stack.config), 1)
    _plan_tool_call_limit, plan_remaining_tool_calls, budget_valid = (
        _approval_resume_tool_budget(
            plan,
            configured_limit=current_tool_call_limit,
        )
    )
    mismatches: list[str] = []
    if current_tool_contract_hash != plan.tool_contract_hash:
        mismatches.append("tool_contract")
    if len(expected_frozen_inputs) != len(current_frozen_inputs):
        mismatches.append("effective_args")
    elif current_effective_args_fingerprint != expected_effective_args_fingerprint:
        mismatches.append("effective_args")
    if len(expected_frozen_inputs) != len(current_frozen_inputs):
        mismatches.append("execution_context")
    elif current_execution_context_fingerprint != expected_execution_context_fingerprint:
        mismatches.append("execution_context")
    if current_model_identity_fingerprint != plan.model_identity_fingerprint:
        mismatches.append("model_identity")
    if system_prompt_mismatch:
        mismatches.append("system_prompt")
    if current_sampling_params_hash != plan.sampling_params_hash:
        mismatches.append("sampling_params")
    if (
        current_request_messages_hash is not None
        and current_request_messages_hash != plan.request_messages_hash
    ):
        mismatches.append("request_messages")
    message_history_mismatch = (
        current_message_history_hash != expected_message_history_hash
    )
    if message_history_mismatch:
        mismatches.append("message_history")
    if not budget_valid:
        mismatches.append("tool_budget")
    if mismatches:
        mismatch_text = ", ".join(mismatches)
        # The summary helper compares against the plan's RAW stored hashes, so
        # components that passed the normalized comparison pass the stored
        # value (guaranteed equal) to keep the user-facing summary truthful.
        change_summary = _chat_hub.describe_approval_plan_changes(
            plan,
            tool_contract_hash=current_tool_contract_hash,
            effective_args_fingerprint=current_effective_args_fingerprint,
            execution_context_fingerprint=current_execution_context_fingerprint,
            model_identity_fingerprint=current_model_identity_fingerprint,
            system_prompt_hash=(
                current_system_prompt_hash
                if system_prompt_mismatch
                else plan.system_prompt_hash
            ),
            sampling_params_hash=current_sampling_params_hash,
            message_history_hash=(
                current_message_history_hash
                if message_history_mismatch
                else plan.message_history_hash
            ),
            request_messages_hash=current_request_messages_hash,
            remaining_iterations=plan.remaining_iterations,
            tool_call_limit=current_tool_call_limit,
            remaining_tool_calls=plan_remaining_tool_calls,
        )
        summary_parts: list[str] = []
        for item in change_summary:
            label = str(item.get("label") or "").strip()
            components = item.get("components")
            if isinstance(components, (list, tuple, set, frozenset)):
                component_text = ", ".join(str(value) for value in components)
            else:
                component_text = str(components or "").strip()
            if label and component_text:
                summary_parts.append(f"{label}: {component_text}")
        summary_text = "; ".join(summary_parts)
        retry_prompt = (
            "The approved tool plan no longer matches the live execution context. "
            "Re-evaluate the request and emit a fresh tool plan."
        )
        if summary_text:
            retry_prompt = f"{retry_prompt} Approval change summary: {summary_text}."
        raise InnerRetryableTurnError(
            reason=f"Approval plan drifted before execution ({mismatch_text}).",
            retry_prompt=retry_prompt,
            terminal_subcode="approval_plan_drift",
            diagnostic_components=tuple(mismatches),
        )


def resume_chat_send_response_from_approval_plan(
    approval_plan: ApprovalPlan,
    *,
    brain_container: BrainContainer,
    stream_notifications: bool = False,
    notification_writer: Any | None = None,
    electron_tool_reader: Any | None = None,
    electron_tool_reader_factory: Any | None = None,
    electron_tool_writer: Any | None = None,
    cancel_handle: TurnCancellationHandle | None = None,
    live_params: dict[str, Any] | None = None,
    canonical_session_messages: Any = None,
    session_title: str = "",
    canonical_seq_state: dict[str, int] | None = None,
) -> ChatResponse:
    from sidecar.ai.mode_policy import policy_for_mode
    from sidecar.ai.routing.loop_event_emit import (
        build_interrupted_tool_outcome,
        emit_interrupted_results_for_pending_calls,
    )
    from sidecar.ai.routing.loop_runtime import LoopRuntime
    from sidecar.ai.routing.tool_call_execution import (
        execute_tool_calls_sequentially,
        pre_filter_tool_calls,
        settle_dropped_tool_calls,
    )
    from sidecar.ai.routing.tool_loop import run_tool_loop

    from . import chat as _chat_hub

    plan = approval_plan
    stack = brain_container.stack
    kernel = stack.router
    # Compute once outside the semantic-retry closure. Current plans preserve
    # the original request deadline; the fallback supports pre-field plans.
    resume_deadline = _approval_resume_deadline(
        plan,
        max_loop_wall_seconds=effective_max_loop_wall_seconds(stack.config),
    )

    def _execute_resume(_attempt_live_params: dict[str, Any]) -> ChatResponse:
        _chat_hub._validate_approval_plan_live_context(
            plan,
            brain_container=brain_container,
            live_params=_attempt_live_params,
            canonical_session_messages=canonical_session_messages,
        )

        effective_runtime: LoopRuntime | None = None
        remaining_iterations = max(int(plan.remaining_iterations or 0), 0)
        # Continue the paused turn's iteration numbering: the approved calls
        # still belong to the paused iteration (``current_iteration``), and the
        # resumed loop numbers onward from it (``iteration_base``) so streamed
        # thinking/phase ids never reuse a pre-approval iteration identity.
        resume_iteration_base = max(int(getattr(plan, "completed_iterations", 0) or 0), 0)
        tool_call_limit, remaining_tool_calls, _budget_valid = _approval_resume_tool_budget(
            plan,
            configured_limit=effective_max_tools_per_turn(stack.config),
        )
        consumed_tool_calls = tool_call_limit - remaining_tool_calls
        # One request-owned counter (W2-30-F07): continue the dispatcher's
        # sequence across the approval pause instead of restarting at zero,
        # which duplicated seq values (and derived event ids) within one turn.
        seq_state = canonical_seq_state if canonical_seq_state is not None else {"seq": 0}
        if stream_notifications and callable(notification_writer):
            canonical_turn_events_enabled = is_feature_flag_enabled(
                stack.config.feature_flags or {},
                FEATURE_CANONICAL_TURN_EVENTS,
            )

            def _serialize_and_write(event: Any) -> None:
                msg = _serialize_loop_event(
                    event,
                    plan.request_id,
                    trace_id=plan.trace_id,
                    session_id=plan.session_id,
                    payload_externalizer=IpcPayloadExternalizer.from_config(stack.config),
                )
                if msg is not None:
                    notification_writer(msg)
                if canonical_turn_events_enabled:
                    next_seq = int(seq_state.get("seq", 0)) + 1
                    canonical_msg = _serialize_turn_event(
                        event,
                        plan.request_id,
                        trace_id=plan.trace_id,
                        session_id=plan.session_id,
                        seq=next_seq,
                    )
                    if canonical_msg is not None:
                        seq_state["seq"] = next_seq
                        notification_writer(canonical_msg)

            effective_runtime = LoopRuntime(
                emit=_serialize_and_write,
                request_id=plan.request_id,
                trace_id=plan.trace_id or "",
                session_id=plan.session_id or "",
                notification_writer=notification_writer,
                electron_tool_writer=electron_tool_writer,
                electron_tool_reader=electron_tool_reader,
                electron_tool_reader_factory=electron_tool_reader_factory,
                max_iterations=remaining_iterations,
                iteration_base=resume_iteration_base,
                current_iteration=resume_iteration_base,
                wall_clock_deadline=resume_deadline,
                chunk_inactivity_seconds=effective_chunk_inactivity_seconds(stack.config),
                model_load_grace_seconds=stack.config.model_load_grace_seconds,
                streaming=True,
                cancel_handle=cancel_handle,
                observation_store=getattr(stack, "tool_observations", None),
                request_context=plan.request_context,
                sub_agent_slot_allocator=getattr(stack, "sub_agent_slot_allocator", None),
                tool_call_limit=tool_call_limit,
                tool_calls_consumed=consumed_tool_calls,
            )
        else:
            effective_runtime = LoopRuntime(
                request_id=plan.request_id,
                trace_id=plan.trace_id or "",
                session_id=plan.session_id or "",
                electron_tool_writer=electron_tool_writer,
                electron_tool_reader=electron_tool_reader,
                electron_tool_reader_factory=electron_tool_reader_factory,
                max_iterations=remaining_iterations,
                iteration_base=resume_iteration_base,
                current_iteration=resume_iteration_base,
                wall_clock_deadline=resume_deadline,
                chunk_inactivity_seconds=effective_chunk_inactivity_seconds(stack.config),
                model_load_grace_seconds=stack.config.model_load_grace_seconds,
                cancel_handle=cancel_handle,
                observation_store=getattr(stack, "tool_observations", None),
                request_context=plan.request_context,
                sub_agent_slot_allocator=getattr(stack, "sub_agent_slot_allocator", None),
                tool_call_limit=tool_call_limit,
                tool_calls_consumed=consumed_tool_calls,
            )

        # Continue the paused turn's tool-call id namespace: the resumed loop
        # must not re-mint an id the pre-approval iterations already used.
        for _plan_call in plan.tool_calls:
            _plan_call_id = str(getattr(_plan_call, "call_id", "") or "").strip()
            if _plan_call_id:
                effective_runtime.turn_call_ids.add(_plan_call_id)

        working_messages = [dict(item) for item in plan.working_messages]
        outcomes = list(plan.outcomes)
        streamed_event_types = set(plan.streamed_event_types)
        tool_payload = [dict(item) for item in plan.tool_payload]
        tool_statuses = tuple(plan.tool_statuses)
        iteration_calls: list[Any] = []
        resumed_request_context = plan.request_context
        tool_contract = kernel._assemble_tool_contract(
            request_context=resumed_request_context,
            resolution_context=plan.tool_resolution_context,
        )
        request_disabled_tools = kernel._request_tool_set(
            resumed_request_context.tool_preferences,
            "disabled_tools",
        )
        resume_tool_calls, dropped_tool_calls = _approval_resume_call_window(
            plan,
            kernel=kernel,
            tool_contract=tool_contract,
        )
        settle_dropped_tool_calls(
            kernel=kernel,
            runtime=effective_runtime,
            result=plan.generation_result,
            request_id=plan.request_id,
            session_id=plan.session_id,
            dropped_calls=dropped_tool_calls,
            outcomes=outcomes,
            working_messages=working_messages,
            iteration_calls=iteration_calls,
            streamed_event_types=streamed_event_types,
        )
        approved_call_id = str(plan.approved_call_id or plan.call_id or "").strip()
        audit_metadata_by_call = _approval_audit_metadata_map(
            plan,
            call_ids=frozenset({approved_call_id}) if approved_call_id else frozenset(),
        )
        trusted_plan_artifact_write_call_ids = frozenset(
            frozen_input.call_id
            for frozen_input in plan.frozen_inputs
            if frozen_input.effective_tool_arguments.get(PLAN_ARTIFACT_WRITE_ARG) is True
        )
        remaining_calls, _outcome_index = pre_filter_tool_calls(
            resume_tool_calls,
            kernel=kernel,
            runtime=effective_runtime,
            result=plan.generation_result,
            request_id=plan.request_id,
            tool_resolution_context=plan.tool_resolution_context,
            tool_contract=tool_contract,
            plan_mode=resumed_request_context.plan_mode,
            read_only=resumed_request_context.read_only,
            request_disabled_tools=request_disabled_tools,
            session_id=plan.session_id,
            outcomes=outcomes,
            working_messages=working_messages,
            iteration_calls=iteration_calls,
            streamed_event_types=streamed_event_types,
            outcome_index=len(outcomes),
        )
        resumed_change_set_id = str(getattr(plan, "change_set_id", "") or "").strip() or next(
            (value for item in plan.frozen_inputs if (value := str(
                item.effective_tool_arguments.get("_jenny_change_set_id") or ""
            ).strip())), ""
        )
        effective_runtime.__dict__["_jenny_change_set_id"] = resumed_change_set_id
        bind_run_context(effective_runtime)
        try:
            if remaining_calls:
                try:
                    execute_tool_calls_sequentially(
                        indexed_calls=remaining_calls,
                        runtime=effective_runtime,
                        kernel=kernel,
                        result=plan.generation_result,
                        request_id=plan.request_id,
                        session_id=plan.session_id,
                        tool_resolution_context=plan.tool_resolution_context,
                        tool_contract=tool_contract,
                        read_snapshot_cache=plan.read_snapshot_cache,
                        outcomes=outcomes,
                        working_messages=working_messages,
                        iteration_calls=iteration_calls,
                        streamed_event_types=streamed_event_types,
                        tool_payload_ref=tool_payload,
                        tool_preferences=resumed_request_context.tool_preferences,
                        request_context=resumed_request_context,
                        trusted_plan_artifact_write_call_ids=(
                            trusted_plan_artifact_write_call_ids
                        ),
                        audit_metadata_by_call=audit_metadata_by_call,
                    )
                except Exception:  # noqa: BLE001 - pair pre-dispatch rows first
                    # Mirrors the live loop's orphan settler: any emitted
                    # ``tool.executing`` without a ``tool.result`` gets an
                    # explicit interrupted outcome before the error propagates.
                    emit_interrupted_results_for_pending_calls(
                        runtime=effective_runtime,
                        outcomes=outcomes,
                        streamed_event_types=streamed_event_types,
                        outcome_factory=build_interrupted_tool_outcome,
                    )
                    raise

            was_plan_mode = resumed_request_context.plan_mode
            resumed_request_context = transition_after_exit_outcome(
                request_context=resumed_request_context,
                outcomes=outcomes,
                working_messages=working_messages,
            )
            effective_runtime.request_context = resumed_request_context
            refreshed_tool_contract = kernel._assemble_tool_contract(
                request_context=resumed_request_context,
                resolution_context=plan.tool_resolution_context,
            )
            if was_plan_mode and not resumed_request_context.plan_mode:
                apply_restored_tool_contract(
                    working_messages=working_messages,
                    tool_statuses=refreshed_tool_contract.status_entries,
                )
            resumed = run_tool_loop(
                runtime=effective_runtime,
                kernel=kernel,
                request_context=resumed_request_context,
                working_messages=working_messages,
                tool_contract=refreshed_tool_contract,
                tool_payload=(
                    list(refreshed_tool_contract.prompt_schemas)
                    if effective_runtime.remaining_tool_calls > 0
                    else []
                ),
                tool_resolution_context=plan.tool_resolution_context,
                tool_preferences=resumed_request_context.tool_preferences,
                mode_policy=policy_for_mode(resumed_request_context.mode),
                plan_mode=resumed_request_context.plan_mode,
                read_only=resumed_request_context.read_only,
                approvals_pre_granted=False,
                request_id=plan.request_id,
                session_id=plan.session_id,
                latest_user_content=plan.latest_user_content,
                reasoning_effort=resumed_request_context.reasoning_effort,
                prompt_cache_enabled=plan.prompt_cache_enabled,
                cache_source_key=plan.cache_source_key,
                system_prompt=plan.system_prompt,
                cache_break_detector=kernel._cache_break_detector
                if plan.prompt_cache_enabled
                else None,
                budget_tracker=None,
                read_snapshot_cache=plan.read_snapshot_cache,
                tool_statuses=refreshed_tool_contract.status_entries,
                initial_thinking_text=None,
                initial_outcomes=tuple(outcomes),
                initial_usage_totals=plan.usage_totals,
                initial_streamed_event_types=frozenset(streamed_event_types),
                request_messages_hash=plan.request_messages_hash,
                initial_change_set_id=resumed_change_set_id,
            )
        except TerminalChatStateError as error:
            if effective_runtime is not None:
                from sidecar.ai.routing.tool_loop import flush_unflushed_terminal_output

                flush_unflushed_terminal_output(effective_runtime, kernel)
            return _terminal_chat_response(
                request_id=plan.request_id,
                status=error.status,
                terminal_subcode=error.terminal_subcode,
                tool_observation_stack=stack,
            )
        except ToolExecutionFailure as error:
            # Phase 6 Q19: mirror ``build_chat_send_response``'s rewrap so
            # tool-execution failures during resume-after-approval ship
            # accumulated ``tool_observations`` to Electron alongside the
            # error. Without this, a denied resume with prior tool runs
            # silently drops Q19 promotion data.
            raise ChatRequestError(
                request_id=plan.request_id,
                trace_id=plan.trace_id,
                session_id=plan.session_id,
                code=error.code,
                message=error.message,
                rpc_code=-32000,
                retryable=error.retryable,
                data=_tool_failure_error_data(
                    error,
                    stack,
                    request_id=plan.request_id,
                ),
            ) from error
        finally:
            finish_run_change_set(
                effective_runtime, approval_paused=True, reason="approval_resume_dispatch"
            )
        # A resumed turn can need approval again. Without this branch the
        # request was copied onto the ChatDecision and then dropped by
        # ``_chat_response_from_decision`` (which never reads it), settling the
        # turn as a silent success carrying the approval path's empty text.
        if (
            resumed.approval_request is not None
            and not resumed_request_context.approvals_pre_granted
        ):
            return chat_response_with_tool_observations(
                ChatResponse(
                    request_id=plan.request_id,
                    result={"request_id": plan.request_id, "status": "awaiting_approval"},
                    notifications=[],
                    approval_request={
                        **notification_context(
                            plan.request_id,
                            trace_id=plan.trace_id,
                            session_id=plan.session_id,
                        ),
                        **resumed.approval_request.to_payload(),
                    },
                    approval_plan=resumed.approval_plan,
                ),
                stack,
            )
        decision = ChatDecision(
            thinking_text=resumed.thinking_text,
            response_text=resumed.response_text,
            approval_request=resumed.approval_request,
            tool_results=tuple(resumed.outcomes),
            approval_plan=resumed.approval_plan,
            thinking_kind=resumed.thinking_kind,
            persist_thinking=resumed.persist_thinking,
            usage=resumed.usage_totals,
            context_tokens_estimate=stack.router._context_tokens_estimate(working_messages),
            message_count=len(working_messages),
            tool_schema_count=len(tuple(refreshed_tool_contract.prompt_schemas)),
            streamed_event_types=frozenset(resumed.streamed_event_types),
            completion_source=str(
                getattr(resumed, "completion_source", "model") or "model"
            ),
            resumable_stop=getattr(resumed, "resumable_stop", None),
        )
        return _chat_response_from_decision(
            request_context=resumed_request_context,
            latest_user_content=plan.latest_user_content,
            canonical_session_messages=canonical_session_messages,
            session_title=session_title,
            brain_container=brain_container,
            decision=decision,
            progress_notifications=[],
            budget_messages=working_messages,
            stream_notifications=stream_notifications,
            notification_writer=notification_writer,
            canonical_seq_state=seq_state,
        )

    with scoped_chat_request_context(
        stack.engine,
        request_context=plan.request_context,
        runtime_config=stack.config,
        diagnostics_store=getattr(stack, "turn_diagnostics", None),
    ):
        return execute_with_inner_turn_retry(
            params=(
                live_params
                if isinstance(live_params, dict)
                else {
                    "messages": [
                        dict(item) for item in getattr(plan, "request_messages", [])
                    ]
                }
            ),
            execute_attempt=_execute_resume,
            max_inner_retries=MAX_INNER_TURN_RETRIES,
            exhausted_factory=_approval_resume_exhausted_factory(plan),
        )
