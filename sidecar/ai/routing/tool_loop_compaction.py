"""Mid-turn context compaction after tool results expand the request."""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.config import resolve_effective_max_tokens
from sidecar.ai.context.compaction import compact_context
from sidecar.ai.context.compaction_prompts import resolve_compaction_prompt
from sidecar.ai.context.token_budget import estimate_messages_tokens
from sidecar.ai.feature_flags import (
    FEATURE_CONTEXT_COMPACTION,
    is_feature_flag_enabled,
)
from sidecar.ai.routing.loop_events import ContextCompactedEvent
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger("sidecar.ai.routing.tool_loop")


def compact_tool_loop_context(loop: Any, *, num_tools: int) -> int:
    """Compact an expanded tool-loop history and return its current token count."""
    tracker = loop.budget_tracker
    budget = getattr(tracker, "budget", None)
    backend = getattr(tracker, "backend", None)
    tokens_before = estimate_messages_tokens(loop.working_messages, backend)
    if budget is None or not is_feature_flag_enabled(
        loop.feature_flags,
        FEATURE_CONTEXT_COMPACTION,
    ):
        return tokens_before
    if tokens_before <= budget.auto_compact_threshold(num_tools):
        return tokens_before
    if getattr(loop, "compaction_stalled", False):
        if tokens_before < budget.error_threshold(num_tools):
            return tokens_before
        if getattr(loop, "compaction_last_ditch_used", False):
            return tokens_before
        loop.compaction_last_ditch_used = True

    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.compaction_triggered",
        message="Context compaction triggered after tool results expanded the request.",
        status="start",
        data={"tokens_used": tokens_before, "num_tools": num_tools, "phase": "tool_loop"},
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    result = compact_context(
        loop.working_messages,
        budget,
        backend,
        num_tools=num_tools,
        system_context=str(loop.system_prompt),
        base_prompt=resolve_compaction_prompt(loop.kernel._config),
        circuit_breaker=loop.kernel._compaction_breakers.for_key(loop.session_id),
        mode="mid_turn",
        task_content=str(getattr(loop, "latest_user_content", "") or "") or None,
        generate_fn=loop.kernel._build_compaction_generate_fn(
            request_id=loop.request_id,
            max_tokens=min(
                budget.reserved_for_summary,
                resolve_effective_max_tokens(
                    loop.kernel._config.max_tokens,
                    loop.kernel._engine.get_model_max_output_tokens(),
                    user_override=getattr(
                        loop.kernel._config,
                        "resolved_user_max_output_tokens",
                        None,
                    ),
                ),
            ),
            prompt_cache_enabled=loop.prompt_cache_enabled,
            runtime=loop.runtime,
        ),
    )
    freed = int(result.tokens_before) - int(result.tokens_after)
    if freed <= 0:
        loop.compaction_stalled = True
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.compaction_stalled",
            message="Context compaction freed no tokens during the tool loop.",
            status="degraded",
            data={
                "tokens": tokens_before,
                "reason_code": result.summary_failure_code,
                "phase": "tool_loop",
            },
            request_id=loop.request_id,
            session_id=loop.session_id,
        )
        return tokens_before

    loop.working_messages[:] = list(result.messages)
    log_event(
        logger,
        logging.INFO if result.error is None else logging.WARNING,
        component="ai.router",
        event="ai.router.compaction_completed",
        message="Context compaction completed during the tool loop.",
        status="success" if result.error is None else "degraded",
        data={
            "strategy": result.strategy,
            "tokens_before": result.tokens_before,
            "tokens_after": result.tokens_after,
            "phase": "tool_loop",
        },
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    if loop.cache_break_detector is not None:
        loop.cache_break_detector.reset_baseline(
            loop.cache_source_key,
            reason="compaction" if result.error is None else "compaction_terminal",
        )
    loop.runtime.emit_safe(
        ContextCompactedEvent(
            strategy=result.strategy or "micro",
            tokens_before=result.tokens_before or 0,
            tokens_after=result.tokens_after or 0,
            phase="tool_loop",
            summary_status=result.summary_status,
            reason_code=result.summary_failure_code,
            # The tool-loop summary covers live tool output; Electron persists it
            # only at a successful stream terminal, keyed by
            # covered_through_tool_call_id, never on input_complete.
            summary_message=result.summary_message,
            covered_through_tool_call_id=result.covered_through_tool_call_id,
            input_complete=False,
        )
    )
    return max(0, int(result.tokens_after))
