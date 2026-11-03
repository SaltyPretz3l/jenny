"""Copy and diagnostic details for resumable tool-loop budget stops."""

import re
from typing import Any

# Mirrors token_budget._DIMINISHING_RETURNS_WINDOW; pinned by the tests.
_NO_PROGRESS_WINDOW = 3
# The named refusal is user-visible footer text: one line, bounded.
_SHARED_FAILURE_MESSAGE_CHARS = 120
# tool_call_execution wraps a ToolExecutionFailure message in this frame.
_FAILURE_PREFIX_RE = re.compile(r"^Tool '[^'\n]{0,200}' (?:failed|was not executed):\s*")
_FAILURE_SUFFIX = " Review the error and retry"


def _failure_message(output: object) -> str:
    text = str(output or "").strip()
    text = _FAILURE_PREFIX_RE.sub("", text, count=1).split(_FAILURE_SUFFIX, 1)[0]
    text = " ".join(text.splitlines()[0].split()) if text.strip() else ""
    if len(text) > _SHARED_FAILURE_MESSAGE_CHARS:
        text = f"{text[: _SHARED_FAILURE_MESSAGE_CHARS - 3].rstrip()}..."
    return text


def _shared_failure(loop: Any) -> tuple[str, str] | None:
    """``(code, message)`` when the last window's calls all failed with one code.

    A run of harness refusals (CMP-TOOL-0039 policy, CMP-TOOL-0008 cleanup) is
    not the model making no progress; the footer names the refusal instead.
    """
    window = list(getattr(loop, "outcomes", None) or ())[-_NO_PROGRESS_WINDOW:]
    if len(window) < _NO_PROGRESS_WINDOW or any(
        getattr(outcome, "success", False) for outcome in window
    ):
        return None
    codes = {str(getattr(outcome, "error_code", "") or "").strip() for outcome in window}
    if len(codes) != 1 or "" in codes:
        return None
    return codes.pop(), _failure_message(getattr(window[-1], "output", ""))


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
        data: dict[str, int | str] = {
            "consecutive_no_progress_window_size": window_size,
            "tool_calls_used": tool_calls_used,
        }
        shared = _shared_failure(loop)
        if shared is None:
            cause = "made no progress"
        else:
            code, message = shared
            cause = f"failed with {code}" + (f" ({message})" if message else "")
            data["error_code"] = code
        footer = (
            f"Stopped after {window_size} tool calls in a row {cause}. "
            "Reply 'resume' to continue."
        )
        return footer, "ai.router.diminishing_returns_stop", data
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
