"""Mid-turn context compaction after tool results expand the request."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any

from sidecar.ai.config import resolve_effective_max_tokens
from sidecar.ai.context.compaction import (
    MICRO_FIRST_CODE,
    MICRO_TARGET,
    compact_context,
    compaction_policy,
    trim_browser_outlines,
)
from sidecar.ai.context.compaction_diagnostics import (
    compaction_window_shape,
    record_compaction_cost,
)
from sidecar.ai.context.compaction_prompts import resolve_compaction_prompt
from sidecar.ai.context.token_budget import (
    estimate_messages_tokens,
    estimate_tool_schema_tokens,
    provider_compact_threshold,
    resolve_tokenizer_backend,
)
from sidecar.ai.feature_flags import (
    FEATURE_CONTEXT_COMPACTION,
    is_feature_flag_enabled,
)
from sidecar.ai.routing.loop_events import ContextCompactedEvent, ContextCompactionStartedEvent
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger("sidecar.ai.routing.tool_loop")


@dataclass(frozen=True)
class RequestMeasurement:
    """The provider's whole-prompt count for the last model request, with the
    messages that request carried (by identity) and their estimate then."""

    provider_tokens: int
    messages: tuple[Any, ...]
    estimate: int
    # The same messages counted with the inner (unscaled) estimator, so the
    # calibration reading stays exact while the window only grows (0: not taken).
    inner_estimate: int = 0


def _calibration_backend(
    loop: Any, tracker: Any, tool_payload: Any, usage: Any = None
) -> Any | None:
    """The inner (unscaled) estimator to calibrate against, or None to skip.

    The next turn's count ladder divides the provider's count by the inner
    estimate of the request's messages plus tool schemas
    (``context_count._exact_scale``). Only an engine whose input count is the
    whole prompt can calibrate (Ollama counts the uncached tail). A request
    carrying an image (attached or a tool preview) is skipped: its tiles are a
    separate unscaled surcharge. So is a reply from a fallback model, whose
    count says nothing about the configured one.
    """
    engine = getattr(getattr(loop, "kernel", None), "_engine", None)
    full_prompt = getattr(engine, "reports_full_prompt_input_tokens", False) is True
    if tool_payload is None or not full_prompt:
        return None
    context = getattr(loop, "request_context", None)
    if getattr(context, "vision_images", None) or getattr(context, "vision_token_surcharge", 0):
        return None
    if getattr(getattr(loop, "runtime", None), "preview_images", None):
        return None
    usage_model = str(getattr(usage, "model", "") or "")
    engine_model = str(getattr(engine, "model_name", "") or "")
    if usage_model and engine_model and usage_model != engine_model:
        return None
    backend = getattr(tracker, "backend", None)
    if backend is None:
        backend = resolve_tokenizer_backend(loop.kernel._config)
    return getattr(backend, "inner", backend)


def _inner_messages_estimate(loop: Any, inner: Any) -> int:
    """The window counted with the inner estimator, re-tokenizing only the rows
    appended since the last measurement (a per-message sum, like the estimate)."""
    previous = _appended_since_measurement(loop)
    if previous is None or previous.inner_estimate <= 0:
        return estimate_messages_tokens(loop.working_messages, inner)
    tail = loop.working_messages[len(previous.messages):]
    return previous.inner_estimate + estimate_messages_tokens(tail, inner)


def note_request_measurement(loop: Any, usage: Any, tool_payload: Any = None) -> None:
    """Remember the provider's prompt count for the request just made.

    The char estimator carries 30% headroom, which compacted a 32k llama-server
    window at ~11k estimated tokens (gate 2026-10-14 F16); the provider's own
    count needs none. Cleared when the engine reports no count.

    ``tool_payload`` is the request's tool schemas. With it the tracker also keeps
    ``calibration_reading``, the provider-vs-estimate pair the terminal usage block
    carries to the next turn (the last request wins; ``None`` when unusable).
    """
    tracker = getattr(loop, "budget_tracker", None)
    try:
        provider_tokens = int(getattr(usage, "last_request_input_tokens", 0) or 0)
    except (TypeError, ValueError):
        provider_tokens = 0
    if tracker is None or provider_tokens <= 0:
        loop.request_measurement = None
        if tracker is not None:
            tracker.calibration_reading = None
            tracker.provider_counted = False
        return
    estimate = _estimate_window(loop, getattr(tracker, "backend", None))
    inner = _calibration_backend(loop, tracker, tool_payload, usage)
    inner_messages = _inner_messages_estimate(loop, inner) if inner is not None else 0
    tracker.calibration_reading = None
    if inner is not None:
        inner_total = inner_messages + estimate_tool_schema_tokens(tool_payload, inner)
        if inner_total > 0:
            config = loop.kernel._config
            tracker.calibration_reading = {
                "provider_tokens": provider_tokens,
                "estimate_tokens": inner_total,
                "estimator": type(inner).__name__,
                "engine": str(getattr(config, "engine_type", "")),
                "model": str(getattr(config, "model", "")),
            }
    # The meter shows the provider's count when it is at least the whole-prompt estimate
    # (context_usage_events); only then does its threshold follow the provider trigger.
    meter_tools = getattr(tracker, "meter_tool_tokens", None)
    tool_tokens = int(meter_tools()) if callable(meter_tools) else 0
    tracker.provider_counted = provider_tokens >= estimate + tool_tokens
    loop.request_measurement = RequestMeasurement(
        provider_tokens=provider_tokens,
        messages=tuple(loop.working_messages),
        estimate=estimate,
        inner_estimate=inner_messages,
    )


def _appended_since_measurement(loop: Any) -> RequestMeasurement | None:
    """The last measurement when the window only grew since, else None.

    Only an append-only history keeps a measurement meaningful: any rewrite
    (compaction, a re-pinned row, trimming) falls back to a full estimate.
    """
    measurement = getattr(loop, "request_measurement", None)
    if not isinstance(measurement, RequestMeasurement):
        return None
    sent = measurement.messages
    current = loop.working_messages
    if len(current) < len(sent) or any(a is not b for a, b in zip(sent, current, strict=False)):
        return None
    return measurement


def _estimate_window(loop: Any, backend: Any) -> int:
    """Estimate the window, re-tokenizing only rows appended since the last
    measurement (the estimate is a per-message sum, so the prefix carries)."""
    measurement = _appended_since_measurement(loop)
    if measurement is None:
        return estimate_messages_tokens(loop.working_messages, backend)
    tail = loop.working_messages[len(measurement.messages):]
    return measurement.estimate + estimate_messages_tokens(tail, backend)


def _measured_context(
    loop: Any, tokens_now: int, num_tools: int, estimate_threshold: int
) -> tuple[int, bool, float] | None:
    """The provider's count read in the estimate's units, or None when it cannot be
    trusted for this history: (tokens now, over the trigger, threshold scale).

    The scale is what a forced pass multiplies its estimate threshold and micro target
    by so it aims where the provider's count puts the prompt: in one turn the estimate
    read 108k of its 146k threshold while the provider read 242k of 238k, so a pass
    aimed at the estimate's target freed 48k and repeated 13 calls later, each time
    re-sending ~170k uncached tokens.
    """
    tracker = loop.budget_tracker
    measurement = _appended_since_measurement(loop)
    if measurement is None or tracker is None:
        return None
    total = measurement.provider_tokens + max(0, int(tokens_now) - measurement.estimate)
    threshold = provider_compact_threshold(
        getattr(tracker, "budget", None), getattr(tracker, "raw_context_window", 0), num_tools
    )
    if threshold <= 0:
        return None
    current = int(total * estimate_threshold / threshold)
    if total <= threshold or estimate_threshold <= 0:
        return current, total > threshold, 1.0
    # Only the messages shrink: the system prompt and tool schemas ride along unchanged, so
    # they come out of the target before it is read in the estimate's units (row 183 W3).
    # The pass then lands the provider's count at two-thirds of its trigger, not above it.
    fixed = _fixed_prompt_tokens(loop, tracker)
    target = threshold * MICRO_TARGET * (tokens_now + fixed) / total - fixed
    scale = min(1.0, max(0.0, target / (estimate_threshold * MICRO_TARGET)))
    return current, True, scale


def _fixed_prompt_tokens(loop: Any, tracker: Any) -> int:
    """Prompt tokens outside the message estimate that no compaction frees, in the tracker's
    units: the tool schemas, and the system prompt when no leading system row carries it (a
    turn's working messages start with it, so it is usually already in the estimate)."""
    meter_tools = getattr(tracker, "meter_tool_tokens", None)
    fixed = int(meter_tools()) if callable(meter_tools) else 0
    rows = loop.working_messages
    system = str(getattr(loop, "system_prompt", "") or "")
    if system and not (rows and isinstance(rows[0], dict) and rows[0].get("role") == "system"):
        row = {"role": "system", "content": system}
        fixed += estimate_messages_tokens([row], getattr(tracker, "backend", None))
    return fixed


def _mid_turn_policy(loop: Any, budget: Any, measured: Any) -> Any:
    """The micro-first policy, held to one micro pass on a provider-counted route (row 183
    D3): a second stub-only pass mid-turn only defers the summary and re-sends the prompt
    uncached again."""
    policy = compaction_policy(getattr(loop.kernel._config, "feature_flags", None))
    if policy is None or not (measured is not None or getattr(budget, "provider_units", False)):
        return policy
    return replace(policy, max_micro_passes=min(policy.max_micro_passes, 1))


def _browser_outline_budget_chars(tracker: Any, num_tools: int) -> int:
    """Live browser outlines may hold ~30% of the compaction threshold before older ones stub."""
    budget = getattr(tracker, "budget", None)
    if budget is None:
        return 40_000
    return max(12_000, int(budget.auto_compact_threshold(num_tools) * 0.30 * 3.5))


def _trim_browser_outlines(loop: Any, tracker: Any, num_tools: int) -> None:
    """Batch-stub old browser outlines; a failure here never breaks the loop."""
    try:
        policy = compaction_policy(getattr(loop.kernel._config, "feature_flags", None))
        stubbed = trim_browser_outlines(
            loop.working_messages,
            budget_chars=_browser_outline_budget_chars(tracker, num_tools),
            recall_hint=bool(policy and policy.recall_hint),
        )
        if stubbed:
            # Rows changed in place, so the provider measurement's prefix estimate is stale.
            loop.request_measurement = None
    except Exception:  # noqa: BLE001 - outline trimming must never break the tool loop
        logger.warning("Browser outline trimming failed; continuing.", exc_info=True)


def compact_tool_loop_context(
    loop: Any,
    *,
    num_tools: int,
    force: bool = False,
) -> int:
    """Compact an expanded tool-loop history and return its current token count."""
    tracker = loop.budget_tracker
    _trim_browser_outlines(loop, tracker, num_tools)
    preview_tokens = loop.runtime._preview_context_tokens(loop.working_messages)
    budget = getattr(tracker, "budget", None)
    backend = getattr(tracker, "backend", None)
    if budget is not None and preview_tokens:
        budget = budget.with_reserved_tokens(preview_tokens)
    tokens_before = _estimate_window(loop, backend)
    # The meter's message estimate, the way context.preview counts it: never the
    # provider-measured rescale below, which only steers the compaction decision.
    loop.meter_estimate_tokens = tokens_before
    if budget is None or not is_feature_flag_enabled(
        loop.feature_flags,
        FEATURE_CONTEXT_COMPACTION,
    ):
        return tokens_before
    measured = None if force else _measured_context(
        loop, tokens_before, num_tools, budget.auto_compact_threshold(num_tools)
    )
    # The figure the loop's stop rule reads, in the estimate's units.
    current_tokens = tokens_before
    threshold_scale = 1.0
    if measured is not None:
        current_tokens, over, threshold_scale = measured
        if not over:
            return current_tokens
    elif not force and tokens_before <= budget.auto_compact_threshold(num_tools):
        return tokens_before
    if getattr(loop, "compaction_stalled", False):
        if current_tokens < budget.error_threshold(num_tools) or getattr(
            loop, "compaction_last_ditch_used", False
        ):
            return current_tokens
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
    loop.runtime.emit_safe(
        ContextCompactionStartedEvent(
            phase="tool_loop",
            tokens_before=int(tokens_before),
            message_count=len(loop.working_messages),
        )
    )
    # A trailing turn-context row (turn_context.py) sits out compaction: the
    # summary never absorbs it, its tokens are reserved, and the loop's
    # _after_context_compaction hook puts it back.
    hold_row = getattr(loop, "_hold_turn_context_row", None)
    held_row = hold_row() if callable(hold_row) else None
    held_tokens = estimate_messages_tokens([held_row], backend) if held_row is not None else 0
    result = compact_context(
        [message for message in loop.working_messages if message is not held_row],
        budget.with_reserved_tokens(held_tokens) if held_tokens else budget,
        backend,
        num_tools=num_tools,
        system_context=str(loop.system_prompt),
        base_prompt=resolve_compaction_prompt(loop.kernel._config),
        circuit_breaker=loop.kernel._compaction_breakers.for_key(loop.session_id),
        policy=_mid_turn_policy(loop, budget, measured),
        # Request-local: the router keeps no per-session state (row 60 S6).
        micro_passes_used=int(getattr(loop, "micro_first_passes", 0)),
        # The provider's count is over the line even if the padded estimate is not.
        force=force or measured is not None,
        threshold_scale=threshold_scale,
        mode="mid_turn",
        task_content=str(getattr(loop, "latest_user_content", "") or "") or None,
        plan_approved_in_turn=bool(
            getattr(getattr(loop, "request_context", None), "plan_approved_in_turn", False)
        ),
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

    if result.summary_failure_code == MICRO_FIRST_CODE:
        loop.micro_first_passes = int(getattr(loop, "micro_first_passes", 0)) + 1
    # A compaction that freed tokens ends the stall so the turn may compact again.
    loop.compaction_stalled = False
    loop.compaction_last_ditch_used = False
    loop.working_messages[:] = list(result.messages)
    loop.request_measurement = None
    after_compaction = getattr(loop, "_after_context_compaction", None)
    if callable(after_compaction):
        after_compaction()  # re-pins per-turn instructions the window dropped
    loop.runtime._preview_context_tokens(loop.working_messages)
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
    record_compaction_cost(loop.kernel._engine, loop.request_id, "tool_loop", result)
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
            summary_source_dropped_messages=max(
                0, int(result.summary_input_dropped_messages or 0)
            ),
            # After the re-pin above: the window the next model call reads.
            window_shape=compaction_window_shape(loop.working_messages),
        )
    )
    loop.meter_estimate_tokens = max(0, int(result.tokens_after)) + int(held_tokens)
    return loop.meter_estimate_tokens


def _apply_context_pressure(  # noqa: PLR0913
    loop: Any,
    result: Any,
    *,
    iteration: int,
    force: bool,
    num_tools: int,
    wind_down: Callable[..., Any],
) -> tuple[bool, Any | None]:
    """Run the shared mid-turn budget check for a no-tool iteration."""
    tracker = loop.budget_tracker
    if tracker is None or iteration >= loop.iteration_total:
        return False, None
    messages_before = list(loop.working_messages)
    current_context_tokens = compact_tool_loop_context(loop, num_tools=num_tools, force=force)
    tracker.record_iteration(
        result.usage.output_tokens if result.usage is not None else None,
        current_context_tokens,
    )
    loop._emit_iteration_context_usage(
        iteration=iteration,
        result=result,
        current_context_tokens=current_context_tokens,
    )
    compacted = loop.working_messages != messages_before
    if tracker.check_should_continue():
        return compacted, None
    return compacted, wind_down(loop, result, reason=tracker.stop_reason() or "context_budget")


def check_checkpoint_context(
    loop: Any,
    result: Any,
    *,
    iteration: int,
    num_tools: int,
    wind_down: Callable[..., Any],
) -> Any | None:
    """Apply context pressure after checkpoint messages expand the prompt."""
    _compacted, terminal = _apply_context_pressure(
        loop, result, iteration=iteration, force=False, num_tools=num_tools, wind_down=wind_down,
    )
    return terminal


def recover_context_window_exhaustion(
    loop: Any,
    result: Any,
    *,
    iteration: int,
    num_tools: int,
    wind_down: Callable[..., Any],
) -> Any | None:
    """Compact a full prompt before another call, or stop without generating."""
    compacted, terminal = _apply_context_pressure(
        loop, result, iteration=iteration, force=True, num_tools=num_tools, wind_down=wind_down,
    )
    if terminal is not None:
        return terminal
    if compacted:
        return None
    return wind_down(loop, result, reason="context_budget")


# A provider refused the prompt as too long for its window ("prompt is too long", or
# "input length and `max_tokens` exceed context limit" past what lowering max_tokens can fix).
_OVERFLOW_CLASSIFICATIONS = frozenset({"prompt_too_long", "context_overflow"})
# A refused status arrives before any output streams, so a resend shows nothing twice. An
# in-band overflow (ChatGPT's stream) can follow streamed text and keeps failing the turn.
_OVERFLOW_STATUSES = frozenset({400, 413})
MAX_OVERFLOW_RECOVERIES = 2


def _overflow_classification(error: BaseException) -> str:
    """The overflow class of a refused request, from the error or the provider error under it."""
    current: BaseException | None = error
    for _depth in range(5):
        if current is None:
            break
        classification = str(getattr(current, "classification", "") or "")
        if classification in _OVERFLOW_CLASSIFICATIONS and (
            getattr(current, "status_code", None) in _OVERFLOW_STATUSES
        ):
            return classification
        current = current.__cause__
    return ""


def generate_with_overflow_recovery(
    loop: Any,
    generate: Callable[..., Any],
    build_messages: Callable[[list[dict[str, Any]]], Any],
    **step_kwargs: Any,
) -> Any:
    """Run one generation; on a provider overflow, compact and retry it once (row 183 W1).

    Claude Code does the same. Before this the turn failed. The retry replays no tool effect:
    the refused request ran nothing, and the compaction only rewrites what is sent. An overflow
    on the retry, past ``MAX_OVERFLOW_RECOVERIES`` in the loop, or after a compaction that frees
    nothing raises the original failure. ``generate`` gets ``step_kwargs`` and
    ``working_messages``, rebuilt with ``build_messages`` for each attempt.
    """
    try:
        return generate(working_messages=build_messages(loop.working_messages), **step_kwargs)
    except Exception as error:
        classification = _overflow_classification(error)
        used = int(getattr(loop, "overflow_recoveries", 0) or 0)
        if not classification or used >= MAX_OVERFLOW_RECOVERIES:
            raise
        loop.overflow_recoveries = used + 1
        tracker = getattr(loop, "budget_tracker", None)
        backend = getattr(tracker, "backend", None)
        before = estimate_messages_tokens(loop.working_messages, backend)
        compact_tool_loop_context(
            loop, num_tools=int(getattr(tracker, "num_tools", 0) or 0), force=True
        )
        if estimate_messages_tokens(loop.working_messages, backend) >= before:
            raise
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.overflow_compacted",
            message="The provider refused the prompt as too long; compacted and retrying once.",
            status="retrying",
            data={"classification": classification, "phase": "tool_loop", "recovery": used + 1},
            request_id=getattr(loop, "request_id", None),
            session_id=getattr(loop, "session_id", None),
        )
        return generate(working_messages=build_messages(loop.working_messages), **step_kwargs)
