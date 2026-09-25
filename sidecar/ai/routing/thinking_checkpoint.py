"""Thinking-budget checkpoint classification and prompt shaping."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from sidecar.ai.context.token_budget import resolve_effective_context_window
from sidecar.ai.thinking_guard import (
    ThinkingRepetitionGuard,
    thinking_budget_continuation_enabled,
)
from sidecar.ai.tools.sanitization import sanitize_assistant_output

logger = logging.getLogger(__name__)

__all__ = (
    "CHECKPOINT_CARRY_CHARS",
    "CHECKPOINT_ELISION_NOTE",
    "MAX_THINKING_BUDGET_CHECKPOINTS",
    "build_checkpoint_messages",
    "build_reasoning_summary_messages",
    "checkpoint_carry_similarity",
    "checkpoint_no_progress",
    "checkpoint_phase_summary",
    "is_context_window_exhausted",
    "is_thinking_budget_checkpoint",
    "max_thinking_budget_checkpoints",
    "resolve_checkpoint_context_window",
    "resolve_checkpoint_limit",
    "thinking_budget_continuation_enabled",
    "thinking_budget_exhausted_wind_down",
)

MAX_THINKING_BUDGET_CHECKPOINTS = 3
CHECKPOINT_CARRY_CHARS = 12_000
CHECKPOINT_ELISION_NOTE = "[... earlier reasoning elided at a thinking-budget checkpoint ...]"
_CONTEXT_WINDOW_MARGIN_TOKENS = 64

_CHECKPOINT_FRAME = "(my reasoning so far, continued after a thinking-budget checkpoint)"
_CHECKPOINT_NUDGE = (
    "You hit a thinking-budget checkpoint. Your reasoning so far is preserved above. "
    "Act now - emit your tool calls or your final answer. Be decisive; do not restart "
    "your analysis."
)
_TRUNCATED_TOOL_CALL_NOTE = (
    "Your last tool call was cut off at the output-token limit before its arguments "
    "finished, so it did not run and nothing was written. Do not resend it whole; "
    "split the content across several smaller tool calls."
)
_CHECKPOINT_NO_PROGRESS_SIMILARITY = 0.7
_REASONING_SUMMARY_PROMPT = (
    "Summarise reasoning-in-progress into a compact progress note: decisions made, "
    "facts established, dead ends, remaining steps. Plain prose, at most 300 words, "
    "no preamble."
)


def max_thinking_budget_checkpoints(context_window: int | None) -> int:
    """Scale checkpoint continuations to the configured context window."""

    if context_window is None:
        return MAX_THINKING_BUDGET_CHECKPOINTS
    return min(8, max(MAX_THINKING_BUDGET_CHECKPOINTS, context_window // 16_384))


def resolve_checkpoint_context_window(engine: Any, config: Any) -> int | None:
    """The configured (not native) context window a checkpoint must fit in."""

    return resolve_effective_context_window(engine, config)


def resolve_checkpoint_limit(engine: Any, config: Any) -> int:
    """Checkpoint limit for the configured (not native) context window."""

    return max_thinking_budget_checkpoints(resolve_effective_context_window(engine, config))


def is_context_window_exhausted(
    result: Any,
    *,
    context_window: int | None,
) -> bool:
    """Return whether a length stop consumed the provider's context window."""

    finish_reason = str(getattr(result, "finish_reason", None) or "").strip().lower()
    if finish_reason != "length" or not context_window:
        return False
    usage = getattr(result, "usage", None)
    if usage is None:
        return False
    try:
        input_tokens = max(
            int(
                getattr(usage, "last_request_input_tokens", 0)
                or getattr(usage, "input_tokens", 0)
                or 0
            ),
            0,
        )
        output_tokens = max(int(getattr(usage, "output_tokens", 0) or 0), 0)
    except (TypeError, ValueError):
        return False
    return input_tokens + output_tokens >= max(
        int(context_window) - _CONTEXT_WINDOW_MARGIN_TOKENS,
        1,
    )


def is_thinking_budget_checkpoint(
    result: Any,
    *,
    context_window: int | None = None,
) -> bool:
    """Return whether *result* can continue from a thinking checkpoint."""

    finish_reason = str(getattr(result, "finish_reason", None) or "").strip().lower()
    if finish_reason == "thinking_budget":
        return True
    if finish_reason != "length" or getattr(result, "tool_calls", None):
        return False
    if is_context_window_exhausted(result, context_window=context_window):
        return False
    if getattr(result, "tool_call_truncated", False) is True:
        # A native tool call was cut at the output limit, so any preamble is not
        # an answer (gate B1, 2026-09-22).
        return True
    visible_content = sanitize_assistant_output(
        str(getattr(result, "content", None) or ""),
        max_chars=16_000,
    )
    return not visible_content.strip()


def build_checkpoint_messages(
    reasoning_text: str,
    *,
    summarize: Callable[[str], str] | None = None,
    carry_chars: int = CHECKPOINT_CARRY_CHARS,
    tool_call_truncated: bool = False,
) -> list[dict[str, object]]:
    """Build the bounded reasoning carry and decisive continuation nudge."""

    text = str(reasoning_text or "")
    messages: list[dict[str, object]] = []
    if text.strip():
        carry = text[-carry_chars:]
        if len(text) > carry_chars:
            prefix = CHECKPOINT_ELISION_NOTE
            if callable(summarize):
                try:
                    note = str(summarize(text[:-carry_chars]) or "").strip()
                except Exception:  # noqa: BLE001
                    logger.info(
                        "Reasoning checkpoint summary failed; using the elision note.",
                        exc_info=True,
                    )
                else:
                    if note:
                        prefix = f"[progress note from earlier reasoning]\n{note}"
                    else:
                        logger.info(
                            "Reasoning checkpoint summary was empty; using the elision note."
                        )
            carry = f"{prefix}\n{carry}"
        messages.append(
            {"role": "assistant", "content": f"{_CHECKPOINT_FRAME}\n{carry}"}
        )
    messages.append({"role": "system", "content": _CHECKPOINT_NUDGE})
    if tool_call_truncated:
        messages.append({"role": "system", "content": _TRUNCATED_TOOL_CALL_NOTE})
    return messages


def build_reasoning_summary_messages(elided_text: str) -> list[dict[str, object]]:
    """Build the bounded prompt used to summarize elided reasoning."""

    return [
        {"role": "system", "content": _REASONING_SUMMARY_PROMPT},
        {"role": "user", "content": str(elided_text or "")[-24_000:]},
    ]


def checkpoint_carry_similarity(previous_carry: str | None, current_carry: str) -> float:
    """Jaccard similarity of the bounded tails of two consecutive carries."""

    if previous_carry is None:
        return 0.0
    return ThinkingRepetitionGuard._jaccard_similarity(
        previous_carry[-CHECKPOINT_CARRY_CHARS:],
        current_carry[-CHECKPOINT_CARRY_CHARS:],
    )


def checkpoint_no_progress(previous_carry: str | None, current_carry: str) -> bool:
    """Return whether consecutive checkpoint carries are substantially identical."""

    if not current_carry.strip():
        return True
    return previous_carry is not None and (
        checkpoint_carry_similarity(previous_carry, current_carry)
        >= _CHECKPOINT_NO_PROGRESS_SIMILARITY
    )


def checkpoint_phase_summary(cycle: int) -> str:
    """Return the one-shot reasoning-phase summary for a checkpoint cycle."""

    return f"Continuing after thinking-budget checkpoint {cycle}"


def _thinking_budget_output_tokens(result: Any) -> int:
    """Output tokens the capped generation actually spent, or 0 when unknown."""
    usage = getattr(result, "usage", None)
    try:
        return max(int(getattr(usage, "output_tokens", 0) or 0), 0)
    except (TypeError, ValueError):
        return 0


def _thinking_budget_fallback_response(result: Any, *, reason: str) -> str:
    """Name the cause and the remedy when no wind-down text could be generated.

    The generic "I could not produce a valid response" told the user nothing
    they could act on; every branch here states what was spent and which knob
    changes the outcome.
    """
    remedy = (
        "Try a larger output limit, a lower reasoning effort, or turning thinking "
        "off for this turn."
    )
    if reason == "no_progress":
        return (
            "The model kept repeating the same reasoning at each thinking-budget "
            f"checkpoint without reaching an answer. {remedy}"
        )
    tokens = _thinking_budget_output_tokens(result)
    budget = f"its entire {tokens:,}-token output budget" if tokens else "its entire output budget"
    return (
        f"The model spent {budget} on reasoning without reaching an answer, and "
        f"had no continuation budget left to try again. {remedy}"
    )


_THINKING_BUDGET_WIND_DOWN = (
    "System note, not a message from the user: you ran out of thinking budget and "
    "there is no budget left to continue. Do not think further and do not call any "
    "tools. Reply to the user now with your best answer from the reasoning above, "
    "or say plainly what you worked out and what is still open. Do not mention "
    "this note."
)


def thinking_budget_exhausted_wind_down(loop: Any, result: Any, *, reason: str) -> Any:
    """Finish a thinking-budget turn whose continuation budget is spent.

    Reached when the checkpoint ladder cannot run another cycle: the checkpoint
    limit is used up, or the no-progress detector stopped a loop that was
    rewriting the same reasoning. One tools-stripped generation runs with
    thinking off so the model states its own progress; the deterministic
    fallback names the cause and the remedy instead of the canned "I could not
    produce a valid response for that request."
    """
    reasoning_text = str(getattr(result, "thinking_text", "") or "").strip()
    import sidecar.ai.routing.tool_loop as _tl_hub  # noqa: PLC0415
    from sidecar.ai.routing.tool_loop_recovery import (  # noqa: PLC0415
        WindDownSpec,
        wind_down_response,
    )

    response_text, completion_source = wind_down_response(
        loop,
        WindDownSpec(
            system_message=_THINKING_BUDGET_WIND_DOWN,
            event="ai.router.thinking_budget_winddown",
            message=(
                "Thinking-budget continuation was exhausted; winding down with a summary."
            ),
            fallback_response=lambda: _thinking_budget_fallback_response(
                result, reason=reason
            ),
            log_data={
                "reason": reason,
                "checkpoints": getattr(loop, "thinking_budget_checkpoints", 0),
                "finish_reason": str(getattr(result, "finish_reason", "") or ""),
                "output_tokens": _thinking_budget_output_tokens(result),
            },
            # Thinking is what exhausted the budget; another thinking pass would
            # only repeat the failure.
            reasoning_effort="none",
        ),
    )
    loop.runtime.audit(
        _tl_hub.KIND_TURN_COMPLETED,
        summary=(
            f"turn_completed thinking_budget_winddown reason={reason} "
            f"checkpoints={getattr(loop, 'thinking_budget_checkpoints', 0)}"
        ),
    )
    return loop._finish(
        _tl_hub.ToolLoopResult(
            thinking_text=(
                reasoning_text or "Thinking budget exhausted; summarizing progress."
            ),
            thinking_kind=(
                _tl_hub.CHAT_THINKING_KIND_REASONING
                if reasoning_text
                else _tl_hub.CHAT_THINKING_KIND_STATUS
            ),
            persist_thinking=bool(reasoning_text),
            response_text=response_text,
            approval_request=None,
            approval_plan=None,
            outcomes=loop.outcomes,
            usage_totals=loop.usage_totals,
            streamed_event_types=loop.streamed_event_types,
            completion_source=completion_source,
        ),
        reason="thinking_budget_winddown",
    )
