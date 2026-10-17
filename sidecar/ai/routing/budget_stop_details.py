"""Copy and diagnostic details for resumable tool-loop budget stops."""

from typing import Any

# Mirrors token_budget._DIMINISHING_RETURNS_WINDOW; pinned by the tests.
_NO_PROGRESS_WINDOW = 3


def budget_stop_details(
    loop: Any, reason: str, *, output_capped: bool = False, clean_answer: bool = False,
) -> tuple[str, str, dict[str, int | str]]:
    tool_calls_used = int(loop.runtime.tool_calls_consumed)
    if reason == "tool_cap":
        limit = int(loop.runtime.tool_call_limit or 0)
        # F25: after the cap the model is told to answer without more tools, so
        # a prose reply with no attempt to continue reads as finished, not cut
        # short; Resume stays the way to let it go on.
        footer = (
            f"Reached this turn's tool limit ({limit}); the reply above was written without "
            "further tool calls. Reply 'resume' if you want it to keep going."
            if clean_answer
            else f"Reached this turn's tool limit ({limit}). Reply 'resume' to continue."
        )
        return (
            footer,
            "ai.router.tool_cap_reached",
            {"limit": limit, "tool_calls_used": tool_calls_used},
        )
    if reason == "diminishing_returns":
        window_size = _NO_PROGRESS_WINDOW
        footer = (
            f"Stopped after {window_size} tool calls in a row made no progress. "
            "Reply 'resume' to continue."
        )
        return (
            footer,
            "ai.router.diminishing_returns_stop",
            {
                "consecutive_no_progress_window_size": window_size,
                "tool_calls_used": tool_calls_used,
            },
        )
    if reason == "context_budget":
        tracker = getattr(loop, "budget_tracker", None)
        footer = (
            "Stopped: the reply was cut off and this turn's context budget is used up. "
            "Reply 'resume' to continue."
            if output_capped
            else "Stopped: this turn's context budget is used up. Reply 'resume' to continue."
        )
        return (
            footer,
            "ai.router.context_budget_stop",
            {
                "context_tokens": int(getattr(tracker, "current_context_tokens", 0) or 0),
                "tool_calls_used": tool_calls_used,
                "cause": "length" if output_capped else "context_budget",
            },
        )
    raise ValueError(f"unsupported budget wind-down reason: {reason}")


def fallback_sentence(reason: str, *, output_capped: bool = False) -> str:
    if reason == "context_budget" and output_capped:
        return "I stopped because my reply was cut off and this turn's context budget is used up."
    return {
        "tool_cap": "I reached this turn's tool limit before I could finish.",
        "context_budget": "I stopped because this turn's context budget is used up.",
    }.get(reason, "I stopped because further tool calls were not making progress.")
