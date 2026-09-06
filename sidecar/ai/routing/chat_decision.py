"""Chat-decision orchestration extracted from router.py.

Contains ``build_chat_decision`` (the main entry point for a full chat turn)
and its helper ``_build_chat_decision``.  Both operate on an AgentKernel
instance passed as *kernel*.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, replace
from typing import Any

from sidecar.ai.config_models import uses_minimal_system_prompt
from sidecar.ai.context import prompt_modes as _prompt_modes
from sidecar.ai.context import runtime_overlays as _runtime_overlays
from sidecar.ai.context.history_reframe import reframe_tool_history_messages
from sidecar.ai.context.messages import (
    build_context_block_system_messages,
    compact_semantic_messages_with_report,
    resolve_personality_rendered,
)
from sidecar.ai.context.prompt_cache import resolve_current_date
from sidecar.ai.routing import context_usage_events as _context_usage_events
from sidecar.ai.routing import loop_events as _loop_events
from sidecar.ai.routing import system_messages as _system_messages
from sidecar.ai.routing import tool_budget_filter as _tool_budget_filter
from sidecar.ai.routing import tool_runtime_liveness as _tool_runtime_liveness
from sidecar.protocol import CHAT_THINKING_KIND_STATUS
from sidecar.runtime.approval_plan import build_message_history_hash
from sidecar.runtime.chat_decision_support import (
    CMP_CTX_BUDGET_EXHAUSTED,
    FEATURE_CONTEXT_COMPACTION,
    FEATURE_PROMPT_CACHE,
    FEATURE_TOKEN_BUDGET,
    FEATURE_TOOL_SEARCH,
    BudgetTracker,
    GenerationUsage,
    LearnedLesson,
    LoopRuntime,
    StructuredSystemPrompt,
    ToolResolutionContext,
    apply_budget_check,
    build_search_index,
    check_budget,
    compact_context,
    compute_deferral_set,
    estimate_messages_tokens,
    is_feature_flag_enabled,
    normalize_deferral_mode,
    policy_for_mode,
    resolve_compaction_prompt,
    resolve_effective_max_tokens,
    run_tool_loop,
    scan_history_for_undeferrals,
)
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

RuntimeOverlayLogContext = _runtime_overlays.RuntimeOverlayLogContext
append_plan_mode_runtime_system_message = _prompt_modes.append_plan_mode_runtime_overlay
append_approved_plan_runtime_system_message = _prompt_modes.append_approved_plan_runtime_overlay
build_prompt_memory_recall_system_message = (
    _runtime_overlays.build_prompt_memory_recall_system_message
)
append_repository_delta_runtime_system_message = (
    _runtime_overlays.append_repository_delta_runtime_system_message
)
append_model_identity_runtime_system_message = (
    _runtime_overlays.append_model_identity_runtime_system_message
)
append_session_environment_runtime_system_message = (
    _runtime_overlays.append_session_environment_runtime_system_message
)
append_interrupted_turn_receipts_runtime_system_message = (
    _runtime_overlays.append_interrupted_turn_receipts_runtime_system_message
)
ContextCompactedEvent = _loop_events.ContextCompactedEvent
build_request_system_messages = _system_messages.build_request_system_messages
ToolBudgetFilterInput = _tool_budget_filter.ToolBudgetFilterInput
apply_budget_aware_tool_filter = _tool_budget_filter.apply_budget_aware_tool_filter
build_system_prompt_for_statuses = _tool_budget_filter.build_system_prompt_for_statuses
count_full_tool_schemas = _tool_budget_filter.count_full_tool_schemas


def _build_chat_decision(
    kernel: Any,
    *,
    working_messages: list[dict[str, object]],
    thinking_text: str | None,
    response_text: str,
    approval_request: Any | None,
    tool_results: tuple[Any, ...],
    approval_plan: Any | None = None,
    thinking_kind: str = CHAT_THINKING_KIND_STATUS,
    persist_thinking: bool = False,
    usage: GenerationUsage | None = None,
    message_count: int | None = None,
    tool_schema_count: int | None = None,
    streamed_event_types: frozenset[str] | None = None,
    completion_source: str = "model",
    resumable_stop: str | None = None,
    terminal_error_code: str | None = None,
    terminal_subcode: str | None = None,
    terminal_error_retryable: bool = False,
    budget_tracker: BudgetTracker | None = None,
) -> Any:
    from sidecar.ai.routing import router as _router

    return _router.ChatDecision(
        thinking_text=thinking_text,
        thinking_kind=thinking_kind,
        persist_thinking=persist_thinking,
        response_text=response_text,
        approval_request=approval_request,
        approval_plan=approval_plan,
        tool_results=tool_results,
        usage=usage,
        context_tokens_estimate=kernel._context_tokens_estimate(working_messages),
        message_count=message_count if message_count is not None else len(working_messages),
        tool_schema_count=tool_schema_count,
        streamed_event_types=streamed_event_types or frozenset(),
        completion_source=str(completion_source or "model"),
        resumable_stop=str(resumable_stop or "").strip() or None,
        terminal_error_code=str(terminal_error_code or "").strip() or None,
        terminal_subcode=str(terminal_subcode or "").strip() or None,
        terminal_error_retryable=bool(terminal_error_retryable),
        compact_threshold_tokens=_budget_compact_threshold(budget_tracker),
    )


def _budget_compact_threshold(budget_tracker: BudgetTracker | None) -> int | None:
    """Exact compaction trigger for the request's budget (None when unbudgeted)."""
    if budget_tracker is None or budget_tracker.budget is None:
        return None
    try:
        threshold = int(
            budget_tracker.budget.auto_compact_threshold(int(budget_tracker.num_tools or 0))
        )
    except Exception:  # noqa: BLE001 — meter hint must never break a turn
        return None
    return threshold if threshold > 0 else None


@dataclass(frozen=True)
class _BudgetPreflightContext:
    kernel: Any
    feature_flags: dict[str, Any]
    tool_payload: list[dict[str, Any]]
    prompt_cache_enabled: bool
    request_id: str
    session_id: str | None
    system_prompt_text: str
    runtime: LoopRuntime | None
    cache_break_detector: Any | None
    cache_source_key: str
    reasoning_effort: str | None
    input_complete: bool


@dataclass(frozen=True)
class _CompactionInput:
    working_messages: list[dict[str, object]]
    runtime_system_messages: list[str]
    budget: Any
    budget_tracker: BudgetTracker | None
    num_tools: int
    status: Any
    vision_token_surcharge: int = 0


@dataclass(frozen=True)
class _BudgetPreflightResult:
    working_messages: list[dict[str, object]]
    budget_tracker: BudgetTracker | None
    terminal_decision: Any | None = None


def _emit_preflight_context_usage(
    context: _BudgetPreflightContext,
    *,
    budget_tracker: BudgetTracker | None,
    tokens_used: Any,
) -> None:
    """Publish the preflight context reading to the composer ring (ephemeral).

    Called twice per budgeted turn: once with the pre-compaction count and once
    with the post-compaction ``final_status`` count, so a compaction that frees
    context corrects the ring DOWNWARD instead of leaving it pinned high for
    the rest of the turn. The helper's request-scoped memo drops the second
    emission when compaction did not move the number.
    """
    _context_usage_events.emit_context_usage(
        context.runtime,
        phase=_context_usage_events.PHASE_PREFLIGHT,
        iteration=int(getattr(context.runtime, "current_iteration", 0) or 0),
        budget_tracker=budget_tracker,
        feature_flags=context.feature_flags,
        config=context.kernel._config,
        engine=context.kernel._engine,
        context_tokens_estimate=tokens_used,
    )


def _prepare_context_budget(
    context: _BudgetPreflightContext,
    *,
    working_messages: list[dict[str, object]],
    runtime_system_messages: list[str],
    vision_token_surcharge: int = 0,
) -> _BudgetPreflightResult:
    if not is_feature_flag_enabled(context.feature_flags, FEATURE_TOKEN_BUDGET):
        return _BudgetPreflightResult(working_messages, None)

    kernel = context.kernel
    num_tools = count_full_tool_schemas(context.tool_payload) if kernel._config.tools_enabled else 0
    working_messages, budget, budget_tracker = apply_budget_check(
        working_messages,
        kernel._config,
        kernel._engine,
        num_tools=num_tools,
        reasoning_effort=context.reasoning_effort,
    )
    if budget is None:
        return _BudgetPreflightResult(working_messages, budget_tracker)

    # Count with the backend apply_budget_check already built, NOT the chars//4
    # default: the window this status is compared against was already reduced by
    # that backend's headroom_factor, so estimating with a different one makes
    # the haircut a pure loss.
    status = check_budget(
        estimate_messages_tokens(
            working_messages,
            budget_tracker.backend if budget_tracker is not None else None,
        ) + vision_token_surcharge,
        budget,
        num_tools=num_tools,
    )
    # E1: the ring's first honest reading of THIS turn, published before the
    # model call so a long agentic turn stops showing the previous turn's size.
    _emit_preflight_context_usage(
        context,
        budget_tracker=budget_tracker,
        tokens_used=status.tokens_used,
    )
    should_run_compaction = status.should_compact and is_feature_flag_enabled(
        context.feature_flags,
        FEATURE_CONTEXT_COMPACTION,
    )
    advisory = kernel._context_builder.build_context_pressure_advisory(status)
    if advisory:
        runtime_system_messages.append(advisory)
        if not should_run_compaction:
            working_messages = kernel._context_builder.insert_runtime_system_messages(
                working_messages,
                runtime_system_messages,
            )
    if not should_run_compaction:
        return _BudgetPreflightResult(working_messages, budget_tracker)

    return _run_context_compaction(
        context,
        _CompactionInput(
            working_messages=working_messages,
            runtime_system_messages=runtime_system_messages,
            budget=budget,
            budget_tracker=budget_tracker,
            num_tools=num_tools,
            status=status,
            vision_token_surcharge=vision_token_surcharge,
        ),
    )


def _run_context_compaction(
    context: _BudgetPreflightContext,
    compaction: _CompactionInput,
) -> _BudgetPreflightResult:
    kernel = context.kernel
    compaction_messages = kernel._context_builder.insert_runtime_system_messages(
        compaction.working_messages,
        [],
    )
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.compaction_triggered",
        message="Context compaction triggered before generation.",
        status="start",
        data={
            "tokens_used": compaction.status.tokens_used,
            "tokens_available": compaction.status.tokens_available,
            "utilization_pct": compaction.status.utilization_pct,
            "num_tools": compaction.num_tools,
        },
        request_id=context.request_id,
    )
    tracker = compaction.budget_tracker
    budget_backend = tracker.backend if tracker is not None else None
    # The compactor re-estimates from text alone; hand it a window that already
    # holds the image tokens or it can judge "nothing to compact" and leave the
    # post-compaction check (below, surcharge included) to reject the turn.
    compaction_budget = (
        compaction.budget.with_reserved_tokens(compaction.vision_token_surcharge)
        if compaction.vision_token_surcharge
        else compaction.budget
    )
    compaction_result = compact_context(
        compaction_messages,
        compaction_budget,
        budget_backend,
        num_tools=compaction.num_tools,
        system_context=context.system_prompt_text,
        base_prompt=resolve_compaction_prompt(kernel._config),
        circuit_breaker=kernel._compaction_breakers.for_key(context.session_id),
        generate_fn=kernel._build_compaction_generate_fn(
            request_id=context.request_id,
            max_tokens=min(
                compaction.budget.reserved_for_summary,
                resolve_effective_max_tokens(
                    kernel._config.max_tokens,
                    kernel._engine.get_model_max_output_tokens(),
                    user_override=getattr(kernel._config, "resolved_user_max_output_tokens", None),
                ),
            ),
            prompt_cache_enabled=context.prompt_cache_enabled,
            runtime=context.runtime,
        ),
    )
    _log_compaction_result(context, compaction_result)
    if context.runtime is not None:
        context.runtime.emit_safe(
            ContextCompactedEvent(
                strategy=compaction_result.strategy or "micro",
                tokens_before=compaction_result.tokens_before or 0,
                tokens_after=compaction_result.tokens_after or 0,
                phase="preflight",
                summary_status=compaction_result.summary_status,
                reason_code=compaction_result.summary_failure_code,
                input_complete=context.input_complete,
                summary_message=compaction_result.summary_message,
            )
        )
    if compaction_result.error is not None:
        return _terminal_compaction_result(context, compaction, compaction_result)

    working_messages = kernel._context_builder.insert_runtime_system_messages(
        list(compaction_result.messages),
        compaction.runtime_system_messages,
    )
    final_status = check_budget(
        estimate_messages_tokens(working_messages, budget_backend)
        + compaction.vision_token_surcharge,
        compaction.budget,
        num_tools=compaction.num_tools,
    )
    # E2: compaction just freed context — correct the ring downward now rather
    # than leaving the pre-compaction reading up until the turn's terminal.
    _emit_preflight_context_usage(
        context,
        budget_tracker=compaction.budget_tracker,
        tokens_used=final_status.tokens_used,
    )
    if final_status.level == "error":
        return _terminal_runtime_overlay_budget_result(
            context,
            compaction,
            working_messages=working_messages,
            final_status=final_status,
        )
    if context.cache_break_detector is not None:
        context.cache_break_detector.reset_baseline(
            context.cache_source_key,
            reason="compaction",
        )
    return _BudgetPreflightResult(working_messages, compaction.budget_tracker)


def _log_compaction_result(context: _BudgetPreflightContext, compaction_result: Any) -> None:
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.compaction_completed",
        message="Context compaction completed.",
        status="success" if compaction_result.error is None else "degraded",
        data={
            "strategy": compaction_result.strategy,
            "tokens_before": compaction_result.tokens_before,
            "tokens_after": compaction_result.tokens_after,
            "error": compaction_result.error,
        },
        request_id=context.request_id,
    )
    if compaction_result.strategy != "micro":
        return
    log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.compaction_micro_fallback",
        message=(
            "Context compaction used microcompaction after "
            "full compaction was unavailable or failed."
        ),
        status="degraded",
        data={
            "tokens_before": compaction_result.tokens_before,
            "tokens_after": compaction_result.tokens_after,
        },
        request_id=context.request_id,
    )


def _terminal_compaction_result(
    context: _BudgetPreflightContext,
    compaction: _CompactionInput,
    compaction_result: Any,
) -> _BudgetPreflightResult:
    working_messages = context.kernel._context_builder.insert_runtime_system_messages(
        list(compaction_result.messages),
        compaction.runtime_system_messages,
    )
    soft_overrun = _soft_overrun_preflight_result(
        context,
        compaction,
        working_messages=working_messages,
    )
    if soft_overrun is not None:
        return soft_overrun
    _reset_cache_baseline(context, reason="compaction_terminal")
    log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.compaction_terminal_failure",
        message="Context remained too large after compaction.",
        status="failure",
        data={"error": compaction_result.error},
        request_id=context.request_id,
    )
    return _BudgetPreflightResult(
        working_messages=working_messages,
        budget_tracker=compaction.budget_tracker,
        terminal_decision=_build_context_budget_terminal_decision(
            context,
            working_messages=working_messages,
            response_text=compaction_result.error,
        ),
    )


def _terminal_runtime_overlay_budget_result(
    context: _BudgetPreflightContext,
    compaction: _CompactionInput,
    *,
    working_messages: list[dict[str, object]],
    final_status: Any,
) -> _BudgetPreflightResult:
    soft_overrun = _soft_overrun_preflight_result(
        context,
        compaction,
        working_messages=working_messages,
    )
    if soft_overrun is not None:
        return soft_overrun
    _reset_cache_baseline(context, reason="compaction_runtime_overlays_terminal")
    response_text = (
        "Context remained too large after compaction and runtime prompt "
        "overlays. Please start a new thread or reduce the active context."
    )
    log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.compaction_runtime_overlays_terminal",
        message="Context remained too large after runtime overlays were reinserted.",
        status="failure",
        data={
            "tokens_used": final_status.tokens_used,
            "tokens_available": final_status.tokens_available,
            "utilization_pct": final_status.utilization_pct,
        },
        request_id=context.request_id,
    )
    return _BudgetPreflightResult(
        working_messages=working_messages,
        budget_tracker=compaction.budget_tracker,
        terminal_decision=_build_context_budget_terminal_decision(
            context,
            working_messages=working_messages,
            response_text=response_text,
        ),
    )


def _soft_overrun_preflight_result(
    context: _BudgetPreflightContext,
    compaction: _CompactionInput,
    *,
    working_messages: list[dict[str, object]],
) -> _BudgetPreflightResult | None:
    tracker = compaction.budget_tracker
    tokens_used = estimate_messages_tokens(
        working_messages,
        tracker.backend if tracker is not None else None,
    )
    hard_limit = compaction.budget.hard_prompt_limit()
    if tokens_used >= hard_limit:
        return None
    log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.compaction_soft_overrun_proceeding",
        message="Context exceeded planning reservations but fits the physical prompt window.",
        status="degraded",
        data={
            "tokens_used": tokens_used,
            "hard_limit": hard_limit,
            "num_tools": compaction.num_tools,
        },
        request_id=context.request_id,
    )
    # Compaction still rewrote the message prefix on this path, so the prompt
    # cache baseline resets exactly as it does on the success and terminal exits.
    _reset_cache_baseline(context, reason="compaction_soft_overrun")
    return _BudgetPreflightResult(working_messages, compaction.budget_tracker)


def _build_context_budget_terminal_decision(
    context: _BudgetPreflightContext,
    *,
    working_messages: list[dict[str, object]],
    response_text: str,
) -> Any:
    return _build_chat_decision(
        context.kernel,
        working_messages=working_messages,
        thinking_text="Context budget exhausted after compaction.",
        thinking_kind=CHAT_THINKING_KIND_STATUS,
        persist_thinking=False,
        response_text=response_text,
        approval_request=None,
        approval_plan=None,
        tool_results=(),
        usage=None,
        tool_schema_count=len(context.tool_payload),
        completion_source="context_budget_terminal",
        terminal_error_code=CMP_CTX_BUDGET_EXHAUSTED,
        terminal_error_retryable=False,
    )


def _reset_cache_baseline(context: _BudgetPreflightContext, *, reason: str) -> None:
    if context.cache_break_detector is None:
        return
    context.cache_break_detector.reset_baseline(
        context.cache_source_key,
        reason=reason,
    )


def _build_runtime_overlay_messages(
    kernel: Any,
    request_context: ChatRequestContext,
    *,
    tool_payload: list[dict[str, Any]],
    latest_user_content: str,
    request_id: str,
    session_id: str | None,
) -> list[str]:
    runtime_system_messages: list[str] = []
    append_plan_mode_runtime_system_message(
        runtime_system_messages,
        plan_mode_active=bool(getattr(request_context, "plan_mode", False)),
    )
    if not bool(getattr(request_context, "plan_mode", False)):
        append_approved_plan_runtime_system_message(
            runtime_system_messages,
            approved_plan=getattr(request_context, "approved_plan", None),
        )
    memory_message = build_prompt_memory_recall_system_message(
        context_builder=kernel._context_builder,
        memory_store=getattr(kernel, "_memory_store", None),
        latest_user_content=latest_user_content,
        memory_policy=getattr(request_context, "memory_policy", None),
        log_context=RuntimeOverlayLogContext(
            logger=logger,
            component="ai.router",
            event="ai.router.memory_prompt_recall_failed",
            request_id=request_id,
            session_id=session_id,
        ),
    )
    if memory_message:
        runtime_system_messages.append(memory_message)
    # Model-identity overlay: every turn (including sub-agents), since the
    # active engine/model can change turn-to-turn and each depth's request
    # may be served by a different engine. Flag-gated, fail-closed inside the
    # helper -- see append_model_identity_runtime_system_message.
    append_model_identity_runtime_system_message(
        runtime_system_messages,
        config=kernel._config,
        log_context=RuntimeOverlayLogContext(
            logger=logger,
            component="ai.router",
            event="ai.router.model_identity_overlay_failed",
            request_id=request_id,
            session_id=session_id,
        ),
    )
    append_session_environment_runtime_system_message(
        runtime_system_messages,
        config=kernel._config,
        context_builder=kernel._context_builder,
        tool_schemas=tool_payload,
        session_id=session_id,
        log_context=RuntimeOverlayLogContext(
            logger=logger,
            component="ai.router",
            event="ai.router.session_environment_overlay_failed",
            request_id=request_id,
            session_id=session_id,
        ),
    )
    # Repo-delta orientation overlay: depth-0 turns only (a per-session repo
    # signal would be noise repeated for every sub-agent), and only when a
    # session_id is present. Fail-closed inside the helper.
    if session_id and int(getattr(request_context, "agent_depth", 0) or 0) == 0:
        append_repository_delta_runtime_system_message(
            runtime_system_messages,
            config=kernel._config,
            context_builder=kernel._context_builder,
            session_id=session_id,
            log_context=RuntimeOverlayLogContext(
                logger=logger,
                component="ai.router",
                event="ai.router.repository_delta_overlay_failed",
                request_id=request_id,
                session_id=session_id,
            ),
        )
        # Interrupted-turn receipts overlay: depth-0 turns only (a per-session
        # resume signal). Electron only forwards receipts for a hard-interrupted
        # prior turn -- None on every clean or approval-paused turn -- so the
        # helper returns before rendering on the common path. Dead-generation
        # ledger pendings surface even when Electron journaled nothing. Fail-closed.
        append_interrupted_turn_receipts_runtime_system_message(
            runtime_system_messages,
            config=kernel._config,
            receipts=getattr(request_context, "interrupted_turn_receipts", None),
            log_context=RuntimeOverlayLogContext(
                logger=logger,
                component="ai.router",
                event="ai.router.interrupted_turn_receipts_overlay_failed",
                request_id=request_id,
                session_id=session_id,
            ),
            mcp_client=kernel._mcp_client,
        )
    return runtime_system_messages


def build_chat_decision(
    kernel: Any,
    *,
    request_context: ChatRequestContext | None = None,
    request_id: str,
    messages: list[dict[str, object]],
    latest_user_content: str,
    mode: str,
    approvals_pre_granted: bool,
    session_id: str | None = None,
    learned_lessons: list[LearnedLesson] | None = None,
    reasoning_effort: str | None = None,
    session_start_date: str | None = None,
    canonical_session_messages: list[dict[str, object]] | None = None,
    runtime: LoopRuntime | None = None,
    plan_mode: bool = False,
    tool_preferences: dict[str, tuple[str, ...]] | None = None,
) -> Any:
    if request_context is None:
        from sidecar.ai.routing import tool_quotas as _tool_quotas

        request_context = ChatRequestContext(
            request_id=request_id,
            trace_id=None,
            session_id=session_id,
            mode=mode,
            approvals_pre_granted=approvals_pre_granted,
            reasoning_effort=reasoning_effort,
            session_start_date=session_start_date,
            plan_mode=plan_mode,
            read_only=plan_mode,
            tool_preferences=tool_preferences,
            workspace_root_present=kernel._tool_has_workspace(),
            session_tool_call_count=_tool_quotas.count_session_tool_results(
                canonical_session_messages
            ),
        )
    pinned_current_date = str(request_context.current_date or "").strip()
    if not pinned_current_date:
        pinned_current_date = resolve_current_date()
        request_context = replace(request_context, current_date=pinned_current_date)
    request_id = request_context.request_id
    session_id = request_context.session_id
    mode = request_context.mode
    approvals_pre_granted = request_context.approvals_pre_granted
    reasoning_effort = request_context.reasoning_effort
    session_start_date = request_context.session_start_date
    plan_mode = request_context.plan_mode
    read_only = request_context.read_only
    tool_preferences = request_context.tool_preferences
    mode_policy = policy_for_mode(mode)
    # Tool-history preparation runs BEFORE admission so byte/token budgeting
    # counts the same representation the model will receive (flag on: framed;
    # flag off: pre-W1 bytes with the W1 wire fields stripped).
    semantic_admission = compact_semantic_messages_with_report(
        reframe_tool_history_messages(messages, config=kernel._config)
        if isinstance(messages, list)
        else messages
    )
    semantic_history = semantic_admission.messages
    if not semantic_admission.input_complete:
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.semantic_history_narrowed",
            message="Semantic history exceeded the bounded admission ceiling.",
            status="degraded",
            data={
                "reason_code": "semantic_history_limit",
                "dropped_messages": semantic_admission.dropped_messages,
                "dropped_bytes": semantic_admission.dropped_bytes,
            },
            request_id=request_id,
            session_id=session_id,
        )
        if runtime is not None:
            runtime.emit_safe(
                ContextCompactedEvent(
                    strategy="narrowed",
                    tokens_before=0,
                    tokens_after=0,
                    summary_status="not_created",
                    reason_code="semantic_history_limit",
                    input_complete=False,
                    dropped_messages=semantic_admission.dropped_messages,
                    dropped_bytes=semantic_admission.dropped_bytes,
                )
            )
    feature_flags = kernel._config.feature_flags or {}
    prompt_cache_enabled = is_feature_flag_enabled(feature_flags, FEATURE_PROMPT_CACHE)
    tool_search_enabled = (
        kernel._config.tools_enabled
        and (
            kernel._engine_supports_tool_calling() or kernel._engine_supports_inband_tool_calling()
        )
        and is_feature_flag_enabled(feature_flags, FEATURE_TOOL_SEARCH)
    )
    base_tool_contract = kernel._assemble_tool_contract(
        request_context=request_context,
        resolution_context=None,
        include_deferred_tools=False,
    )
    tool_resolution_context = None
    if tool_search_enabled:
        ordered_descriptors = base_tool_contract.filtered_descriptors
        deferral_mode = normalize_deferral_mode(kernel._config.tool_search_mode)
        history_for_undeferrals = canonical_session_messages or messages
        deferred_names = compute_deferral_set(
            deferral_mode,
            ordered_descriptors,
            frozenset(
                descriptor.name
                for descriptor in ordered_descriptors
                if descriptor.availability.defer_eligible is not True
            ),
            context_window=(
                kernel._config.context_length or kernel._engine.get_model_context_length() or 0
            ),
            tool_token_threshold_pct=kernel._config.tool_search_auto_threshold_pct,
        )
        tool_resolution_context = ToolResolutionContext(
            deferred_names=deferred_names,
            un_deferred_names=set(scan_history_for_undeferrals(history_for_undeferrals)),
            search_index=(
                build_search_index(deferred_names, ordered_descriptors) if deferred_names else None
            ),
        )
    tool_contract = kernel._assemble_tool_contract(
        request_context=request_context,
        resolution_context=tool_resolution_context,
    )
    tool_payload = list(tool_contract.prompt_schemas)
    tool_statuses = tool_contract.status_entries
    context_blocks = getattr(request_context, "context_blocks", ())
    include_personality_block = not uses_minimal_system_prompt(kernel._config)
    # Structural, not textual: the personality row is rendered EITHER from the
    # typed context block below OR by the runtime overlay builder, never both.
    # `resolve_personality_rendered` is the one expression; an approval plan
    # frozen on this turn records its answer for the resume path.
    personality_rendered = resolve_personality_rendered(kernel._config, context_blocks)
    context_block_messages = build_context_block_system_messages(
        context_blocks,
        include_personality=include_personality_block,
        agent_name=getattr(kernel._config, "assistant_name", None),
    )
    runtime_system_messages = _build_runtime_overlay_messages(
        kernel,
        request_context,
        tool_payload=tool_payload,
        latest_user_content=latest_user_content,
        request_id=request_id,
        session_id=session_id,
    )
    tool_runtime_liveness = _tool_runtime_liveness.snapshot_tool_runtime_liveness(kernel)
    budget_filter_context = ToolBudgetFilterInput(
        kernel=kernel,
        feature_flags=feature_flags,
        request_context=request_context,
        tool_resolution_context=tool_resolution_context,
        semantic_history=semantic_history,
        runtime_overlay_messages=runtime_system_messages,
        context_block_messages=context_block_messages,
        learned_lessons=learned_lessons,
        prompt_cache_enabled=prompt_cache_enabled,
        pinned_current_date=pinned_current_date,
        latest_user_content=latest_user_content,
        request_id=request_id,
        session_id=session_id,
        tool_search_enabled=tool_search_enabled,
        has_active_background_jobs=tool_runtime_liveness.has_active_background_jobs,
        has_active_monitors=tool_runtime_liveness.has_active_monitors,
        has_pending_operations=tool_runtime_liveness.has_pending_operations,
    )
    budget_filter_result = apply_budget_aware_tool_filter(
        budget_filter_context,
        tool_contract=tool_contract,
        tool_payload=tool_payload,
        tool_statuses=tool_statuses,
    )
    tool_contract = budget_filter_result.tool_contract
    # Rebuild the overlays only when the filter actually replaced the payload
    # (the unfiltered exits return the original list object): the
    # session-environment overlay must reflect the final tool payload, but the
    # common no-pressure path keeps every overlay builder at one invocation per
    # turn (memory recall and repo delta are not free).
    if budget_filter_result.tool_payload is not tool_payload:
        runtime_system_messages = _build_runtime_overlay_messages(
            kernel,
            request_context,
            tool_payload=budget_filter_result.tool_payload,
            latest_user_content=latest_user_content,
            request_id=request_id,
            session_id=session_id,
        )
    tool_payload = budget_filter_result.tool_payload
    tool_statuses = budget_filter_result.tool_statuses
    kernel._log_request_tool_preferences(
        request_id=request_id,
        session_id=session_id,
        tool_preferences=tool_preferences,
    )
    kernel._log_tool_contract(
        request_id=request_id,
        tool_statuses=tool_statuses,
        latest_user_content=latest_user_content,
    )
    system_prompt: str | StructuredSystemPrompt = (
        budget_filter_result.system_prompt
        if budget_filter_result.system_prompt is not None
        else build_system_prompt_for_statuses(
            budget_filter_context,
            tool_statuses,
        )
    )
    system_prompt_text = str(system_prompt)

    working_messages = build_request_system_messages(
        kernel,
        base_system_prompt=system_prompt_text,
        tool_statuses=tuple(tool_statuses),
        runtime_system_messages=runtime_system_messages,
        personality_rendered=personality_rendered,
        skill_invocation=request_context.skill_invocation,
    )
    # Electron's typed context overlays (active file / @-mentions, git,
    # personality, codebase, linked-session recall) join the TRUSTED
    # system tier here — after the prompt + runtime overlays and BEFORE semantic
    # history, so they sit ahead of any pinned compaction summary (derived,
    # untrusted). They cannot arrive via `messages`: compact_semantic_messages
    # rejects system rows on untrusted request history, which is exactly why the
    # old Electron-side splice was silently inert.
    working_messages.extend(context_block_messages)
    working_messages.extend(semantic_history)
    read_snapshot_cache = kernel._rebuild_read_snapshot_cache(canonical_session_messages)
    cache_break_detector = kernel._cache_break_detector if prompt_cache_enabled else None
    cache_source_key = kernel._cache_source_key(
        request_id=request_id,
        session_id=session_id,
        request_context=request_context,
    )

    # -- Budget check (feature-flag gated) ---------------------------------
    budget_result = _prepare_context_budget(
        _BudgetPreflightContext(
            kernel=kernel,
            feature_flags=feature_flags,
            tool_payload=tool_payload,
            prompt_cache_enabled=prompt_cache_enabled,
            request_id=request_id,
            session_id=session_id,
            system_prompt_text=system_prompt_text,
            runtime=runtime,
            cache_break_detector=cache_break_detector,
            cache_source_key=cache_source_key,
            reasoning_effort=reasoning_effort,
            input_complete=semantic_admission.input_complete,
        ),
        working_messages=working_messages,
        runtime_system_messages=runtime_system_messages,
        vision_token_surcharge=request_context.vision_token_surcharge,
    )
    working_messages = budget_result.working_messages
    budget_tracker = budget_result.budget_tracker
    if budget_result.terminal_decision is not None:
        return budget_result.terminal_decision

    # -- Delegate to extracted tool loop -----------------------------------
    from sidecar.ai.routing import iteration_limits as _iteration_limits

    effective_runtime = runtime or LoopRuntime(
        request_id=request_id,
        max_iterations=_iteration_limits.max_iterations_for_agent_surface(
            kernel._config,
            mode=mode,
            agent_surface=getattr(request_context, "agent_surface", "main"),
        ),
        wall_clock_deadline=(
            time.monotonic() + _iteration_limits.effective_max_loop_wall_seconds(kernel._config)
        ),
        chunk_inactivity_seconds=_iteration_limits.effective_chunk_inactivity_seconds(
            kernel._config
        ),
        model_load_grace_seconds=kernel._config.model_load_grace_seconds,
        observation_store=getattr(kernel._engine, "_tool_observation_store", None),
        request_context=request_context,
    )
    loop_result = run_tool_loop(
        runtime=effective_runtime,
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
        initial_thinking_text="Assembling semantic context and evaluating tool opportunities.",
        request_messages_hash=build_message_history_hash(messages),
    )
    return _build_chat_decision(
        kernel,
        working_messages=working_messages,
        thinking_text=loop_result.thinking_text,
        thinking_kind=loop_result.thinking_kind,
        persist_thinking=loop_result.persist_thinking,
        response_text=loop_result.response_text,
        approval_request=loop_result.approval_request,
        approval_plan=loop_result.approval_plan,
        tool_results=tuple(loop_result.outcomes),
        usage=loop_result.usage_totals,
        tool_schema_count=len(tool_payload),
        streamed_event_types=frozenset(loop_result.streamed_event_types),
        completion_source=str(getattr(loop_result, "completion_source", "model") or "model"),
        resumable_stop=getattr(loop_result, "resumable_stop", None),
        terminal_error_code=getattr(loop_result, "terminal_error_code", None),
        terminal_subcode=getattr(loop_result, "terminal_subcode", None),
        terminal_error_retryable=bool(
            getattr(loop_result, "terminal_error_retryable", False)
        ),
        budget_tracker=budget_tracker,
    )
