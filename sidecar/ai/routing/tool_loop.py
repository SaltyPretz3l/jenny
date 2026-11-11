"""Extracted tool-loop orchestrator.

Owns the iteration loop that was previously inline in
``AgentKernel.build_chat_decision()``.  This module is an orchestrator
only -- scheduling, stop policies, and message preparation live in
helpers (``loop_events``, ``loop_stop``, ``loop_runtime``).
"""

from __future__ import annotations

import logging
import math
from dataclasses import replace
from typing import Any

# NOTE: many symbols below are load-bearing *hub attributes* -- the carved-out
# sibling modules (tool_loop_run/tool_loop_calls/tool_loop_finalize) reach them
# via ``import sidecar.ai.routing.tool_loop as _tl_hub`` + ``_tl_hub.NAME`` to
# stay within the per-module import-fanout budget. Those have zero call sites in
# this file and carry a per-import noqa (F401) so ruff keeps them; do not remove.
from sidecar.ai.config import resolve_effective_max_tokens  # noqa: F401
from sidecar.ai.context import turn_context  # noqa: F401
from sidecar.ai.context.messages import (
    build_generation_messages,  # noqa: F401
    normalize_history_for_loop,  # noqa: F401
)
from sidecar.ai.context.token_budget import BudgetTracker
from sidecar.ai.error_codes import (
    CMP_LOOP_ENGINE_STALLED,  # noqa: F401
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_LOOP_TOOL_INTERRUPTED,  # noqa: F401
)
from sidecar.ai.feature_flags import (
    FEATURE_LOOP_RESULT_AWARE_SIGNATURE,  # noqa: F401
    FEATURE_PHASE_EVENTS,  # noqa: F401
    is_default_on_flag_enabled,  # noqa: F401
    is_feature_flag_enabled,  # noqa: F401
    is_resource_discipline_enabled,  # noqa: F401
)
from sidecar.ai.routing import (  # noqa: F401
    background_job_notices,
    heuristic_fires,
    loop_event_emit,
    mutation_change_set_lifecycle,
    pending_todos,
    plan_presentation,
    promise_nudge,
    propose_presentation,
    thinking_checkpoint,
    tool_loop_compaction,
    tool_loop_cycle_recovery,
    tool_loop_recovery,
    tool_loop_text_tool_calls,
    verify_after_write,
    write_progress,
)
from sidecar.ai.routing.auto_checkpoint import maybe_create_auto_checkpoint  # noqa: F401
from sidecar.ai.routing.loop_events import (
    BackgroundJobNoticeConsumedEvent,  # noqa: F401
    IterationStartEvent,  # noqa: F401
    MailConsumedEvent,  # noqa: F401
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.loop_stop import (
    LoopState,  # noqa: F401
    StopController,  # noqa: F401
    StopDecision,  # noqa: F401
    StopReason,  # noqa: F401
    advance_cycle_history,  # noqa: F401
)
from sidecar.ai.routing.route_policy_runtime import (
    apply_route_policy_pre_dispatch,  # noqa: F401
)
from sidecar.ai.routing.tool_budget_filter import count_full_tool_schemas  # noqa: F401
from sidecar.ai.routing.tool_call_canonicalization import (
    canonicalize_tool_call_arguments,  # noqa: F401
    canonicalize_tool_calls,  # noqa: F401
    repair_web_search_query_arguments,  # noqa: F401
    validate_provider_tool_call_limits,  # noqa: F401
)
from sidecar.ai.routing.tool_loop_replies import (  # noqa: F401
    _POST_TOOL_CONTINUATION_NUDGE,
    _TOOL_FAILURE_CONTEXT_NUDGE,
    TOOL_NUDGE_FALLBACK_RESPONSE,
    _current_info_unavailability_context,
    _current_info_unavailability_response,
    _empty_post_tool_context_response,
    _failed_tool_context_response,
    _looks_like_generic_greeting_only,
    _looks_like_post_tool_empty_chat_menu,
    _post_tool_invalid_log_data,
    _post_tool_invalid_response_reason,
    _quota_block_guidance,
    _should_issue_tool_nudge,
    _successful_tool_context_response,
    _summarize_failed_tool_outcomes,
    _summarize_successful_tool_outcomes,
    _web_search_unavailability_reason,
)
from sidecar.ai.routing.tool_loop_result import (  # noqa: F401
    CANCEL_REASON_LOOP_ABORTED,
    GUARDRAIL_FOOTER,
    ToolLoopResult,
    _build_stopped_response_text,
    _build_stopped_tool_loop_result,
    _drain_unflushed_buffer,
    _emit_deterministic_response_tokens,
    _emit_pending_tool_cancellations,
    _mark_buffer_flushed,
    flush_unflushed_terminal_output,
)
from sidecar.ai.routing.tool_loop_run import _ToolLoopRun
from sidecar.ai.routing.tool_observation import (
    KIND_MODEL_TOOL_REQUESTED,  # noqa: F401
    KIND_TURN_COMPLETED,  # noqa: F401
    KIND_TURN_FAILED,  # noqa: F401
    KIND_USER_APPROVAL_REQUESTED,  # noqa: F401
)
from sidecar.ai.routing.turn_boundary import (
    ends_turn_at_next_step,  # noqa: F401
    finish_loop_at_boundary,  # noqa: F401
    finish_loop_at_next_step,  # noqa: F401
)
from sidecar.ai.routing.visible_reply import finalize_visible_reply  # noqa: F401
from sidecar.ai.tools import text_tool_calls  # noqa: F401
from sidecar.ai.tools.catalog import builtin_tool_names
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import GenerationUsage, ToolCallRequest
from sidecar.ai.tools.policy import tool_policy_call_key
from sidecar.ai.tools.sanitization import sanitize_assistant_output  # noqa: F401
from sidecar.ai.utils.coercion import coerce_positive_finite_float
from sidecar.protocol import (
    CHAT_THINKING_KIND_REASONING,  # noqa: F401
    CHAT_THINKING_KIND_STATUS,  # noqa: F401
)
from sidecar.runtime.approval_plan import (
    build_approval_plan as _build_approval_plan,
)
from sidecar.runtime.approval_plan import (
    build_message_history_hash,  # noqa: F401
)
from sidecar.runtime.chat_models import TerminalChatStateError  # noqa: F401
from sidecar.runtime.diagnostics import log_event  # noqa: F401

logger = logging.getLogger(__name__)
_SYNTHETIC_TOOL_IDS = frozenset({"tool_search"})
_UNKNOWN_TOOL_LOG_PREVIEW_LIMIT = 20
_TOOL_BURST_SUMMARY_THRESHOLD = 4
_TOOL_BURST_CALL_ID_PREVIEW_LIMIT = 8


def build_approval_plan(**kwargs: Any) -> Any:
    from sidecar.ai.routing.mutation_change_set_lifecycle import (
        current_run_change_set_id,
    )

    return _build_approval_plan(change_set_id=current_run_change_set_id(), **kwargs)


def _is_unknown_tool_call(
    kernel: Any,
    call: ToolCallRequest,
    *,
    tool_resolution_context: Any | None,
    tool_contract: Any | None,
    request_disabled_tools: frozenset[str],
) -> str | None:
    try:
        kernel._assert_valid_tool_call(call)
    except ToolExecutionFailure as exc:
        if exc.code == CMP_LOOP_INVALID_TOOL_CALL:
            return exc.message
        raise
    if call.tool_id in _SYNTHETIC_TOOL_IDS:
        return None
    if call.tool_id in request_disabled_tools:
        return None
    if kernel._is_direct_deferred_tool_call(call, tool_resolution_context):
        return None
    entry = tool_contract.entry(call.tool_id) if tool_contract is not None else None
    if entry is not None:
        return None
    descriptor = kernel._mcp_client.tool_descriptor(call.tool_id)
    if descriptor is not None:
        return None
    if call.tool_id == "run_command" and not kernel._config.tools_shell_enabled:
        return None
    if call.tool_id in builtin_tool_names():
        # A real Jenny tool this configuration did not offer (e.g. the command sandbox).
        return f"tool '{call.tool_id}' is not available in this chat right now"
    return f"model requested unknown tool '{call.tool_id}'"


def _partition_unknown_tool_calls(
    kernel: Any,
    tool_calls: tuple[ToolCallRequest, ...],
    *,
    tool_resolution_context: Any | None,
    tool_contract: Any | None,
    request_disabled_tools: frozenset[str],
) -> tuple[tuple[ToolCallRequest, ...], tuple[tuple[ToolCallRequest, str], ...]]:
    valid_calls: list[ToolCallRequest] = []
    unknown_calls: list[tuple[ToolCallRequest, str]] = []
    for call in tool_calls:
        message = _is_unknown_tool_call(
            kernel,
            call,
            tool_resolution_context=tool_resolution_context,
            tool_contract=tool_contract,
            request_disabled_tools=request_disabled_tools,
        )
        if message:
            unknown_calls.append((call, message))
        else:
            valid_calls.append(call)
    return tuple(valid_calls), tuple(unknown_calls)


def _available_tool_names(tool_contract: Any | None) -> tuple[str, ...]:
    if tool_contract is None:
        return ()
    names: set[str] = set()
    for entry in getattr(tool_contract, "entries", ()) or ():
        descriptor = getattr(entry, "descriptor", None)
        name = str(getattr(descriptor, "name", "") or "").strip()
        if name and getattr(entry, "available", False):
            names.add(name)
    return tuple(sorted(names))


def _invalid_tool_output(message: str, tool_contract: Any | None = None) -> str:
    # Name the valid tools inline: small local models hallucinate near-miss
    # tool names (write_to_file for write_file) and will not re-derive the
    # right one from the system prompt's tool block -- without the list here
    # they conclude the capability is missing and tell the user so.
    base = (
        f"Error: {message}. Please check the available tools and try again "
        "with a valid tool name."
    )
    names = _available_tool_names(tool_contract)
    if not names:
        return base
    return f"{base} Available tools: {', '.join(names)}."


def _visible_tool_input(call: ToolCallRequest) -> dict[str, Any]:
    return (
        {str(k): v for k, v in call.arguments.items()}
        if isinstance(call.arguments, dict)
        else {}
    )


def _tool_id_log_preview(
    calls: tuple[ToolCallRequest, ...] | tuple[tuple[ToolCallRequest, str], ...],
) -> tuple[list[str], int]:
    preview: list[str] = []
    for item in calls[:_UNKNOWN_TOOL_LOG_PREVIEW_LIMIT]:
        call = item[0] if isinstance(item, tuple) else item
        preview.append(str(call.tool_id))
    omitted = max(0, len(calls) - _UNKNOWN_TOOL_LOG_PREVIEW_LIMIT)
    return preview, omitted


def _call_id_preview(calls: list[ToolCallRequest]) -> tuple[list[str], int]:
    preview = [
        str(call.call_id or "").strip()
        for call in calls[:_TOOL_BURST_CALL_ID_PREVIEW_LIMIT]
        if str(call.call_id or "").strip()
    ]
    omitted = max(0, len(calls) - _TOOL_BURST_CALL_ID_PREVIEW_LIMIT)
    return preview, omitted


def _quota_burst_key(blocked_call: Any) -> tuple[str, str]:
    metadata = dict(getattr(blocked_call, "metadata", {}) or {})
    quota_scope = str(metadata.get("quota_scope") or blocked_call.reason or "").strip()
    return (str(blocked_call.call.tool_id or "").strip(), quota_scope)


def _quota_blocked_groups(blocked_calls: tuple[Any, ...]) -> list[list[Any]]:
    groups: list[list[Any]] = []
    for blocked in blocked_calls:
        if not groups or _quota_burst_key(groups[-1][-1]) != _quota_burst_key(blocked):
            groups.append([blocked])
            continue
        groups[-1].append(blocked)
    return groups


def _policy_denied_matched_rule_ids(denied_calls: tuple[Any, ...]) -> list[str]:
    matched_rule_ids: set[str] = set()
    for denied in denied_calls:
        policy_metadata = dict(denied.metadata.get("policy_decision") or {})
        matched_rule_id = str(policy_metadata.get("matched_rule_id") or "").strip()
        if matched_rule_id:
            matched_rule_ids.add(matched_rule_id)
    return sorted(matched_rule_ids)


def _bind_missing_approval_call_id(
    tool_calls: tuple[ToolCallRequest, ...],
    approval_call_id: str | None,
) -> tuple[ToolCallRequest, ...]:
    normalized_approval_id = str(approval_call_id or "").strip()
    if not normalized_approval_id:
        return tool_calls

    bound = any(
        str(call.call_id or "").strip() == normalized_approval_id for call in tool_calls
    )
    if bound:
        return tool_calls

    rebound_calls: list[ToolCallRequest] = []
    for call in tool_calls:
        if not bound and not str(call.call_id or "").strip():
            if tool_policy_call_key(call) == normalized_approval_id:
                rebound_calls.append(replace(call, call_id=normalized_approval_id))
                bound = True
                continue
        rebound_calls.append(call)
    return tuple(rebound_calls)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Bounds tool output and sub-agent reports that re-enter the model's context.
# The user-visible final reply uses visible_reply.MAX_VISIBLE_REPLY_CHARS.
MAX_RESPONSE_CHARS = 16_000


def _merge_generation_usage(
    current: GenerationUsage | None,
    next_usage: GenerationUsage | None,
) -> GenerationUsage | None:
    if next_usage is None:
        return current
    if current is None:
        return next_usage
    # last_request_input_tokens is OVERWRITE-not-add: the merged record keeps
    # the latest iteration's request size (falling back to that iteration's
    # input_tokens) so the context meter reads "current request", not the
    # cross-iteration sum that input_tokens/total_tokens accumulate.
    next_last_request = max(int(next_usage.last_request_input_tokens), 0) or max(
        int(next_usage.input_tokens), 0
    )
    return GenerationUsage(
        input_tokens=max(int(current.input_tokens), 0) + max(int(next_usage.input_tokens), 0),
        output_tokens=max(int(current.output_tokens), 0) + max(int(next_usage.output_tokens), 0),
        total_tokens=max(int(current.total_tokens), 0) + max(int(next_usage.total_tokens), 0),
        provider=str(next_usage.provider or current.provider),
        model=str(next_usage.model or current.model),
        provider_cost_usd=_merge_provider_cost(
            current.provider_cost_usd,
            next_usage.provider_cost_usd,
        ),
        raw_usage=dict(next_usage.raw_usage or current.raw_usage),
        last_request_input_tokens=(
            next_last_request or max(int(current.last_request_input_tokens), 0)
        ),
        generation_tokens=(
            max(int(current.generation_tokens), 0)
            + max(int(next_usage.generation_tokens), 0)
        ),
        generation_duration_ms=(
            coerce_positive_finite_float(current.generation_duration_ms)
            + coerce_positive_finite_float(next_usage.generation_duration_ms)
        ),
        prompt_eval_duration_ms=(
            coerce_positive_finite_float(current.prompt_eval_duration_ms)
            + coerce_positive_finite_float(next_usage.prompt_eval_duration_ms)
        ),
        load_duration_ms=(
            coerce_positive_finite_float(current.load_duration_ms)
            + coerce_positive_finite_float(next_usage.load_duration_ms)
        ),
        time_to_first_token_ms=(
            coerce_positive_finite_float(current.time_to_first_token_ms)
            or coerce_positive_finite_float(next_usage.time_to_first_token_ms)
        ),
    )


def _merge_provider_cost(current: object, next_cost: object) -> float | None:
    if isinstance(current, bool) or isinstance(next_cost, bool):
        return None
    if not isinstance(current, (int, float, str)) or not isinstance(
        next_cost, (int, float, str)
    ):
        return None
    try:
        current_value = float(current)
        next_value = float(next_cost)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(current_value) or not math.isfinite(next_value):
        return None
    if current_value < 0.0 or next_value < 0.0:
        return None
    return current_value + next_value


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run_tool_loop(
    *,
    runtime: LoopRuntime,
    kernel: Any,
    request_context: Any | None,
    working_messages: list[dict[str, object]],
    tool_contract: Any,
    tool_payload: list[dict[str, Any]],
    tool_resolution_context: Any | None,
    tool_preferences: dict[str, tuple[str, ...]] | None,
    mode_policy: Any,
    plan_mode: bool,
    read_only: bool,
    approvals_pre_granted: bool,
    request_id: str,
    session_id: str | None,
    latest_user_content: str,
    reasoning_effort: str | None,
    prompt_cache_enabled: bool,
    cache_source_key: str,
    system_prompt: Any,
    cache_break_detector: Any | None,
    budget_tracker: BudgetTracker | None,
    read_snapshot_cache: dict[str, Any],
    tool_statuses: Any,
    initial_thinking_text: str | None,
    initial_outcomes: tuple[Any, ...] = (),
    initial_usage_totals: GenerationUsage | None = None,
    initial_streamed_event_types: frozenset[str] | set[str] = frozenset(),
    request_messages_hash: str = "",
    initial_change_set_id: str | None = None,
) -> ToolLoopResult:
    """Run the agent tool loop, emitting typed events via *runtime*.

    This is a pure extraction of the loop body that was previously inline
    in ``AgentKernel.build_chat_decision()``. The ``kernel`` parameter is the
    ``AgentKernel`` instance, used to call its existing helper methods
    (``_generate_step``, ``_execute_tool``, etc.) without duplicating them.
    """
    run = _ToolLoopRun(
        runtime=runtime,
        kernel=kernel,
        request_context=request_context,
        working_messages=working_messages,
        tool_contract=tool_contract,
        tool_payload=tool_payload,
        tool_resolution_context=tool_resolution_context,
        tool_preferences=tool_preferences,
        mode_policy=mode_policy,
        plan_mode=plan_mode,
        read_only=read_only,
        approvals_pre_granted=approvals_pre_granted,
        request_id=request_id,
        session_id=session_id,
        latest_user_content=latest_user_content,
        reasoning_effort=reasoning_effort,
        prompt_cache_enabled=prompt_cache_enabled,
        cache_source_key=cache_source_key,
        system_prompt=system_prompt,
        cache_break_detector=cache_break_detector,
        budget_tracker=budget_tracker,
        read_snapshot_cache=read_snapshot_cache,
        tool_statuses=tool_statuses,
        initial_thinking_text=initial_thinking_text,
        initial_outcomes=initial_outcomes,
        initial_usage_totals=initial_usage_totals,
        initial_streamed_event_types=initial_streamed_event_types,
        request_messages_hash=request_messages_hash,
        initial_change_set_id=initial_change_set_id,
    )
    try:
        # execute() settles the change set itself on every exit, raising ones included.
        return run.execute()
    finally:
        runtime.preview_images.clear()
