"""Context-budget preflight and pre-generation compaction for a chat turn.

Split from ``chat_decision.py`` (which stays the entry point and re-exports
``_BudgetPreflightContext``, ``_BudgetPreflightResult`` and
``_prepare_context_budget``). Runs once per budgeted turn before the tool loop:
counts the request, publishes the preflight context reading, compacts when the
window is under pressure and returns a terminal decision when nothing fits.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sidecar.ai.context import compaction_diagnostics as _compaction_diag
from sidecar.ai.context.context_count import (
    ContextCalibration,
    publish_request_token_scale,
    resolve_token_scale,
)
from sidecar.ai.routing import context_usage_events as _context_usage_events
from sidecar.ai.routing import loop_events as _loop_events
from sidecar.ai.routing import tool_budget_filter as _tool_budget_filter
from sidecar.protocol import CHAT_THINKING_KIND_STATUS
from sidecar.runtime.chat_decision_support import (
    CMP_CTX_BUDGET_EXHAUSTED,
    FEATURE_CONTEXT_COMPACTION,
    FEATURE_TOKEN_BUDGET,
    BudgetTracker,
    LoopRuntime,
    apply_budget_check,
    check_budget,
    compact_context,
    compaction_policy,
    estimate_messages_tokens,
    estimate_tool_schema_tokens,
    is_feature_flag_enabled,
    resolve_compaction_prompt,
    resolve_effective_max_tokens,
)
from sidecar.runtime.diagnostics import log_event

# The preflight logs under the chat-decision logger it was split from.
logger = logging.getLogger("sidecar.ai.routing.chat_decision")

ContextCompactionStartedEvent = _loop_events.ContextCompactionStartedEvent
ContextCompactedEvent = _loop_events.ContextCompactedEvent
count_full_tool_schemas = _tool_budget_filter.count_full_tool_schemas


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
    # Last turn's provider-vs-estimate reading (count-source ladder, context_count.py),
    # and the ladder result the tool-budget probe already resolved this turn.
    context_calibration: ContextCalibration | None = None
    count_scale: tuple[float | None, str] | None = None


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
    # Count-source ladder: an engine's exact count, else last turn's calibration,
    # else the plain estimate. The scaled backend it yields counts the status,
    # the compaction and (via the tracker) the tool loop in one set of units.
    token_scale, scale_source = context.count_scale or resolve_token_scale(
        engine=kernel._engine,
        config=kernel._config,
        messages=working_messages,
        tool_payload=context.tool_payload if kernel._config.tools_enabled else (),
        calibration=context.context_calibration,
        extra_tokens=vision_token_surcharge,
    )
    publish_request_token_scale(kernel._engine, token_scale)
    working_messages, budget, budget_tracker = apply_budget_check(
        working_messages,
        kernel._config,
        kernel._engine,
        num_tools=num_tools,
        reasoning_effort=context.reasoning_effort,
        tool_schema_tokens=estimate_tool_schema_tokens(context.tool_payload) if num_tools else None,
        token_scale=token_scale,
        scale_source=scale_source,
    )
    if budget is None:
        return _BudgetPreflightResult(working_messages, budget_tracker)
    if budget_tracker is not None:
        budget_tracker.charge_tool_schemas(context.tool_payload, num_tools)

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
        context, budget_tracker=budget_tracker, tokens_used=status.tokens_used
    )
    should_run_compaction = status.should_compact and is_feature_flag_enabled(
        context.feature_flags, FEATURE_CONTEXT_COMPACTION
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
    if context.runtime is not None:
        context.runtime.emit_safe(
            ContextCompactionStartedEvent(
                "preflight", int(compaction.status.tokens_used or 0), len(compaction_messages)
            )
        )
    compaction_result = compact_context(
        compaction_messages,
        compaction_budget,
        budget_backend,
        num_tools=compaction.num_tools,
        system_context=context.system_prompt_text,
        base_prompt=resolve_compaction_prompt(kernel._config),
        circuit_breaker=kernel._compaction_breakers.for_key(context.session_id),
        policy=compaction_policy(getattr(kernel._config, "feature_flags", None)),
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
    _compaction_diag.log_preflight_compaction_result(
        logger, compaction_result, request_id=context.request_id
    )
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
                **_compaction_diag.compacted_event_extras(compaction_result),
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
    from sidecar.ai.routing import chat_decision as _chat_decision

    return _chat_decision._build_chat_decision(
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
