"""Thinking-budget checkpoint classification and prompt shaping."""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from typing import Any

from sidecar.ai.context.token_budget import resolve_effective_context_window
from sidecar.ai.routing.provider_tool_limits import (
    MAX_PROVIDER_TOOL_CALLS,
    MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES,
    MAX_TOOL_CALL_ARGUMENT_BYTES,
    PATH_ONLY_TOOL_ARGUMENT_BYTES,
)
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
    "dropped_tool_call_error",
    "is_context_window_exhausted",
    "is_thinking_budget_checkpoint",
    "max_thinking_budget_checkpoints",
    "reasoning_only_stop_wind_down",
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
# TR-018: the generation spent its whole output on reasoning the engine did not
# keep (a thinking model the engine does not recognise). No carry exists, so the
# nudge must not claim one.
_HIDDEN_REASONING_NUDGE = (
    "You hit a thinking-budget checkpoint: this step's whole output budget went to "
    "reasoning and none of it was kept. Do not restart your analysis. Keep any further "
    "thinking to a few sentences, then emit your next tool call or your final answer now."
)
# TR-015: reasoning is never replayed between steps, so a checkpoint whose
# carry already holds a code draft should save it instead of re-deriving it.
_CHECKPOINT_DRAFT_NUDGE = (
    "Your reasoning above already drafts code. Do not re-derive it: write it to disk "
    "now with write_file/edit_file in pieces of at most ~150 lines, then continue."
)
_CODE_FENCE = "```"
_MIN_DRAFT_DEF_LINES = 2
_DEF_OR_CLASS_LINE_RE = re.compile(r"^\s*(?:def|class)\s+\w+", re.MULTILINE)
_TRUNCATED_TOOL_CALL_NOTE = (
    "Your last tool call was cut off at the output-token limit before its arguments "
    "finished, so it did not run and nothing was written. Do not resend it whole; "
    "split the content across several smaller tool calls."
)
# Sweep W3-B1: a call rejected at a provider cap is dropped even when the model
# finished it cleanly, so the note names the cap that dropped it, by value.
_REJECTED_TOOL_CALL_NOTES = {
    "argument_bytes": (
        "Your last tool call was rejected because its arguments went past the "
        f"{MAX_TOOL_CALL_ARGUMENT_BYTES:,}-byte per-call argument limit or the "
        f"{MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES:,}-byte limit across all calls in "
        "one response, so it did not run and nothing was written. Do not resend it "
        "whole; split the content across several smaller tool calls, each well "
        "under the limit."
    ),
    "tool_argument_bytes": (
        "Your last tool call was rejected because its arguments went past the "
        f"{PATH_ONLY_TOOL_ARGUMENT_BYTES:,}-byte limit for that tool, so it did not run "
        "and nothing changed. This tool takes only a short path, pattern or id, "
        "never file content. Call it again with short arguments, one target per call."
    ),
    "tool_call_count": (
        f"Your last response asked for more than {MAX_PROVIDER_TOOL_CALLS} tool calls "
        "at once, over the per-response limit, so none of them ran. Do not resend "
        "them all together; send fewer calls per response and continue in batches."
    ),
}
_DROPPED_TOOL_CALL_ERROR = (
    "The model's tool call was over Jenny's per-call size or count limit, so it "
    "did not run and the turn stopped before an answer. Retry, or ask for the "
    "work in smaller pieces."
)
# Clean terminals under which a dropped tool call leaves only a preamble.
_DROPPED_CALL_CONTINUABLE_FINISHES = frozenset({"stop", "tool_calls"})
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
    if getattr(result, "tool_calls", None):
        return False
    dropped_call = getattr(result, "tool_call_truncated", False) is True
    if finish_reason != "length":
        # A call rejected at a provider cap under a clean finish left only its
        # preamble (sweep W3-B1); an incomplete/error stream keeps its cut-off path.
        return dropped_call and finish_reason in _DROPPED_CALL_CONTINUABLE_FINISHES
    if is_context_window_exhausted(result, context_window=context_window):
        return False
    if dropped_call:
        # A native tool call was cut at the output limit, so any preamble is not
        # an answer (gate B1, 2026-09-22).
        return True
    visible_content = sanitize_assistant_output(
        str(getattr(result, "content", None) or ""),
        max_chars=16_000,
    )
    return not visible_content.strip()


def _carries_code_draft(reasoning: str) -> bool:
    if _CODE_FENCE in reasoning:
        return True
    return len(_DEF_OR_CLASS_LINE_RE.findall(reasoning)) >= _MIN_DRAFT_DEF_LINES


def build_checkpoint_messages(  # noqa: PLR0913 - explicit checkpoint inputs.
    reasoning_text: str,
    *,
    summarize: Callable[[str], str] | None = None,
    carry_chars: int = CHECKPOINT_CARRY_CHARS,
    tool_call_truncated: bool = False,
    tool_call_rejected_reason: str = "",
    allow_write_draft: bool = False,
) -> list[dict[str, object]]:
    """Build the bounded reasoning carry and decisive continuation nudge.

    ``allow_write_draft`` is set only by an authorized build turn with write
    tools available; a plan, review or tool-less chat that quotes code must
    never be told to write it to disk.
    """

    text = str(reasoning_text or "")
    messages: list[dict[str, object]] = []
    nudge = _CHECKPOINT_NUDGE
    if text.strip():
        carry = text[-carry_chars:]
        if allow_write_draft and _carries_code_draft(carry):
            nudge = _CHECKPOINT_DRAFT_NUDGE
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
    elif not tool_call_truncated and not tool_call_rejected_reason:
        nudge = _HIDDEN_REASONING_NUDGE
    messages.append({"role": "system", "content": nudge})
    rejected_note = _REJECTED_TOOL_CALL_NOTES.get(tool_call_rejected_reason)
    if rejected_note is not None:
        messages.append({"role": "system", "content": rejected_note})
    elif tool_call_truncated:
        messages.append({"role": "system", "content": _TRUNCATED_TOOL_CALL_NOTE})
    return messages


def dropped_tool_call_error(result: Any) -> str | None:
    """The user-facing error for a clean finish whose only tool call was dropped.

    ``None`` unless *result* carries no runnable call, was flagged, and ended
    ``stop``/``tool_calls``: the loop fails it retryably when no checkpoint
    continuation can run, instead of completing on the preamble.
    """
    finish_reason = str(getattr(result, "finish_reason", None) or "").strip().lower()
    if (
        finish_reason in _DROPPED_CALL_CONTINUABLE_FINISHES
        and getattr(result, "tool_call_truncated", False) is True
        and not getattr(result, "tool_calls", None)
    ):
        return _DROPPED_TOOL_CALL_ERROR
    return None


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


def checkpoint_stalled(loop: Any, previous_carry: str | None, carry: str, result: Any) -> bool:
    """Return whether the tool loop's checkpoint ladder should stop at this stop.

    A repeat of the previous carry stalls. An empty carry stalls too, with two
    exceptions: a dropped tool call (its note says what to change), and the
    first empty carry of a run that still offers tools (TR-018: the reasoning
    was hidden, so there is nothing to compare yet). The caller then stores
    ``""`` as the last carry, so a second empty stop is a stall: one extra
    leg per run, inside the ladder limit.
    """

    if carry.strip():
        return checkpoint_no_progress(previous_carry, carry)
    if getattr(result, "tool_call_truncated", False) is True:
        return False
    if previous_carry is not None or not getattr(loop, "tool_payload", None):
        return True
    from sidecar.ai.routing.tool_loop_recovery import _tool_cap_spent

    return _tool_cap_spent(loop)


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
    if reason == "reasoning_only":
        return (
            "The model finished its turn while still reasoning and never wrote an "
            "answer. Try sending the message again, a lower reasoning effort, or "
            "turning thinking off for this turn."
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

_REASONING_ONLY_WIND_DOWN = (
    "System note, not a message from the user: you ended your turn while still "
    "reasoning, without writing an answer. Do not think further and do not call any "
    "tools. Reply to the user now with your best answer from the reasoning above, "
    "or say plainly what you worked out and what is still open. Do not mention "
    "this note."
)
_REASONING_ONLY_FRAME = "(my reasoning so far, before I stopped without an answer)"


def reasoning_only_stop_wind_down(loop: Any, result: Any) -> Any:
    """Finish a turn whose model stopped cleanly inside its reasoning.

    Small thinking models sometimes emit end-of-sequence before the answer
    ("stop" with reasoning and no visible text). The reasoning is carried in as
    a bounded assistant note so the tools-stripped, thinking-off wind-down can
    answer from it instead of the canned "I could not produce a valid response
    for that request."
    """
    reasoning_text = str(getattr(result, "thinking_text", "") or "").strip()
    loop.working_messages.append(
        {
            "role": "assistant",
            "content": (
                f"{_REASONING_ONLY_FRAME}\n{reasoning_text[-CHECKPOINT_CARRY_CHARS:]}"
            ),
        }
    )
    return thinking_budget_exhausted_wind_down(loop, result, reason="reasoning_only")


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
    import sidecar.ai.routing.tool_loop as _tl_hub
    from sidecar.ai.routing.tool_loop_recovery import (
        WindDownSpec,
        wind_down_response,
    )

    response_text, completion_source = wind_down_response(
        loop,
        WindDownSpec(
            system_message=(
                _REASONING_ONLY_WIND_DOWN
                if reason == "reasoning_only"
                else _THINKING_BUDGET_WIND_DOWN
            ),
            event=(
                "ai.router.reasoning_only_winddown"
                if reason == "reasoning_only"
                else "ai.router.thinking_budget_winddown"
            ),
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
