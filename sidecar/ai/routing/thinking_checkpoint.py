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
    "is_thinking_budget_checkpoint",
    "max_thinking_budget_checkpoints",
    "resolve_checkpoint_limit",
    "thinking_budget_continuation_enabled",
)

MAX_THINKING_BUDGET_CHECKPOINTS = 3
CHECKPOINT_CARRY_CHARS = 12_000
CHECKPOINT_ELISION_NOTE = "[... earlier reasoning elided at a thinking-budget checkpoint ...]"

_CHECKPOINT_FRAME = "(my reasoning so far, continued after a thinking-budget checkpoint)"
_CHECKPOINT_NUDGE = (
    "You hit a thinking-budget checkpoint. Your reasoning so far is preserved above. "
    "Act now - emit your tool calls or your final answer. Be decisive; do not restart "
    "your analysis."
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


def resolve_checkpoint_limit(engine: Any, config: Any) -> int:
    """Checkpoint limit for the configured (not native) context window."""

    return max_thinking_budget_checkpoints(resolve_effective_context_window(engine, config))


def is_thinking_budget_checkpoint(result: Any) -> bool:
    """Return whether *result* can continue from a thinking checkpoint."""

    finish_reason = str(getattr(result, "finish_reason", None) or "").strip().lower()
    if finish_reason == "thinking_budget":
        return True
    if finish_reason != "length":
        return False
    visible_content = sanitize_assistant_output(
        str(getattr(result, "content", None) or ""),
        max_chars=16_000,
    )
    return not visible_content.strip() and not getattr(result, "tool_calls", None)


def build_checkpoint_messages(
    reasoning_text: str,
    *,
    summarize: Callable[[str], str] | None = None,
    carry_chars: int = CHECKPOINT_CARRY_CHARS,
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
