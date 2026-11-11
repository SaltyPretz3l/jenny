"""Post-tool reply checks and deterministic fallback replies for the tool loop.

Detects a final reply that ignores the tool results it was given (a greeting
reset, an empty-chat menu, a "no context" claim) and builds the deterministic
summaries the loop answers with instead. The hub (``tool_loop``) re-exports these
names; siblings reach them as ``_tl_hub.NAME`` so tests can patch them there.
"""

from __future__ import annotations

import re
from typing import Any, Callable

from sidecar.ai.context.builder import looks_like_current_info_request
from sidecar.ai.tools.assembly import current_info_remediation
from sidecar.ai.tools.sanitization import sanitize_assistant_output
from sidecar.ai.tools.tool_families import saved_tool_output

# Engines whose tool calls arrive as <tool_call> text, so a model that narrates
# a tool instead of calling it can be re-prompted with the same text nudge.
_TEXT_TOOL_CALL_ENGINES = frozenset({"ollama", "codex-cli"})
TOOL_NUDGE_FALLBACK_RESPONSE = (
    "I wasn't able to complete that request because the model kept "
    "describing tool use instead of actually calling the tool. "
    "Please try again."
)
_GENERIC_GREETING_RE = re.compile(
    r"^\s*(hey|hi|hello|hiya|howdy)\b.{0,160}\b("
    r"i(?:['\u2019]m| am)\s+jenny|nice to meet you|how(?:['\u2019]s| is) your day|"
    r"how are you|good to see you"
    r")",
    re.IGNORECASE | re.DOTALL,
)
_POST_TOOL_READY_RESET_RE = re.compile(
    r"^\s*(?:i(?:['\u2019]m| am)\s+)?ready\s+to\s+help\b"
    r".{0,160}\bwhat(?:['\u2019]s| is)\s+on\s+your\s+mind\??\s*$",
    re.IGNORECASE | re.DOTALL,
)
_EMPTY_CHAT_MENU_RE = re.compile(
    r"\bhow can i help you today\?"
    r".{0,600}\bif you(?:['\u2019]re| are) not sure where to start\b"
    r".{0,600}\bjust let me know what(?:['\u2019]s| is) on your mind\b",
    re.IGNORECASE | re.DOTALL,
)
_POST_TOOL_CONTINUATION_NUDGE = (
    "Continue the user's current request using the tool results you just received. "
    "Do not greet the user or restart the conversation. Produce the requested deliverable."
)
# Names itself: template-based local engines relabel it as a ``user`` row
# (demote_non_leading_system_messages), and an unmarked copy reads as the user's.
_TOOL_FAILURE_CONTEXT_NUDGE = (
    "[Harness note, not a message from the user] Tool failure context: one or more "
    "tool calls failed. Treat the failed tool result messages as authoritative context; "
    "the user has not sent anything new. Do not claim that no context or no tool results "
    "were provided; explain the failure plainly and avoid fabricating successful tool output."
)
_NO_CONTEXT_AFTER_TOOL_RE = re.compile(
    r"\b("
    r"no\s+(?:previous\s+)?context|"
    r"(?:do\s+not|don't|cannot|can't)\s+have\s+(?:any\s+)?(?:previous\s+)?context|"
    r"no\s+tool\s+results?"
    r")\b",
    re.IGNORECASE,
)


def _looks_like_generic_greeting_only(response_text: str) -> bool:
    text = str(response_text or "").strip()
    if not text:
        return False
    if len(text) > 240:  # noqa: PLR2004 - a greeting-only reply is short
        return False
    return (
        _GENERIC_GREETING_RE.search(text) is not None
        or _POST_TOOL_READY_RESET_RE.search(text) is not None
    )


def _looks_like_post_tool_empty_chat_menu(response_text: str) -> bool:
    text = str(response_text or "").strip()
    if not text:
        return False
    return _EMPTY_CHAT_MENU_RE.search(text) is not None


def _post_tool_invalid_response_reason(*, response_text: str) -> str:
    if _looks_like_generic_greeting_only(response_text):
        return "generic_greeting"
    if _looks_like_post_tool_empty_chat_menu(response_text):
        return "empty_chat_menu"
    return ""


def _post_tool_invalid_log_data(
    *,
    iteration: int,
    response_text: str,
    invalid_reason: str,
    successful_outcome_count: int,
    outcome_count: int | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "iteration": iteration,
        "response_length": len(response_text),
        "invalid_reason": invalid_reason,
        "successful_outcome_count": successful_outcome_count,
    }
    if outcome_count is not None:
        data["outcome_count"] = outcome_count
    return data


def _web_search_unavailability_reason(tool_statuses: Any) -> str | None:
    for status in tool_statuses or ():
        if str(getattr(status, "name", "")).strip() != "web_search":
            continue
        if getattr(status, "available", None) is True:
            return None
        reason = str(getattr(status, "reason", "") or "runtime/backend unavailable").strip()
        return reason or "runtime/backend unavailable"
    return None


def _current_info_unavailability_response(
    *,
    latest_user_content: str,
    tool_statuses: Any,
) -> str | None:
    if not looks_like_current_info_request(latest_user_content):
        return None
    reason = _web_search_unavailability_reason(tool_statuses)
    if not reason:
        return None
    response = (
        "This request likely needs up-to-date external information, but "
        f"web_search is unavailable for this request: {reason}. "
        "I can't perform a live web lookup in this request."
    )
    remedy = current_info_remediation(reason)
    if remedy:
        response += f" {remedy}"
    return response


def _current_info_unavailability_context(
    *,
    latest_user_content: str,
    tool_statuses: Any,
) -> str | None:
    response = _current_info_unavailability_response(
        latest_user_content=latest_user_content,
        tool_statuses=tool_statuses,
    )
    if not response:
        return None
    return (
        "Tool availability context: "
        f"{response} If the user requested a live lookup, explain this limitation "
        "instead of implying that no tool context was provided."
    )


def _summarize_tool_outcomes(
    outcomes: list[Any],
    *,
    include_outcome: Callable[[Any], bool],
    build_label: Callable[[Any], str],
    empty_detail: str,
    omitted_label: str,
) -> str:
    selected = [outcome for outcome in outcomes if include_outcome(outcome)]
    if not selected:
        return ""
    lines = []
    for outcome in selected[:3]:
        # This text becomes the saved reply, so it follows the rule for saved tool output.
        saved = saved_tool_output(
            str(getattr(outcome, "tool_name", "") or ""),
            str(getattr(outcome, "output", "") or ""),
            getattr(outcome, "metadata", None),
        )
        output = sanitize_assistant_output(saved.strip())
        if len(output) > 500:  # noqa: PLR2004 - per-outcome summary cap
            output = f"{output[:497].rstrip()}..."
        lines.append(f"- {build_label(outcome)}: {output or empty_detail}")
    extra = len(selected) - len(lines)
    if extra > 0:
        lines.append(f"- {extra} additional {omitted_label} omitted.")
    return "\n".join(lines)


def _summarize_failed_tool_outcomes(outcomes: list[Any]) -> str:
    def build_failed_label(outcome: Any) -> str:
        tool_name = str(getattr(outcome, "tool_name", "") or "tool").strip()
        error_code = str(getattr(outcome, "error_code", "") or "").strip()
        return f"{tool_name} [{error_code}]" if error_code else tool_name

    return _summarize_tool_outcomes(
        outcomes,
        include_outcome=lambda outcome: not getattr(outcome, "success", False),
        build_label=build_failed_label,
        empty_detail="failed without a model-visible detail",
        omitted_label="tool failure(s)",
    )


def _quota_block_guidance(reason: str, cap: int) -> str:
    """Model-facing guidance for a resource-discipline quota block, keyed by scope.

    The web budget gets explicit reassurance -- it is per-turn, resets on the next reply,
    and does NOT mean the network is unavailable -- because the model otherwise misreads
    "exhausted for this request" as a session-wide network outage and tells the user the
    network is down or that a quota must be reset manually.
    """
    if reason == "web_per_turn":
        return (
            f"this turn's web-tool budget ({cap} calls) is used up. This is a per-turn "
            "limit that resets on your next reply -- the network is still available. Do "
            "not tell the user the network is down or that a quota must be reset. Answer "
            "now with the results already gathered, or ask the user to continue if you "
            "need more web lookups."
        )
    if reason == "code_intelligence_per_turn":
        return (
            f"this turn's code-intelligence tool budget ({cap} calls) is used up. This is a "
            "per-turn limit that resets on your next reply. Continue with the "
            "information already gathered."
        )
    if reason == "session_tool_budget":
        return (
            f"this chat's tool budget ({cap} tool calls) is used up, so no more tools can "
            "run in this chat. Answer with what you already have, and tell the user that "
            "starting a new chat resets the budget."
        )
    if reason == "tool_cooldown":
        return (
            "it is in a brief cooldown after a prior block. Try a different approach or "
            "wait before retrying."
        )
    return f"resource discipline quota '{reason}' is exhausted for this request."


def _failed_tool_summary_response(failed_summary: str) -> str:
    return (
        "I did receive tool context, but the requested tool call failed or was unavailable:\n"
        f"{failed_summary}\n\n"
        "I can't treat that as a successful live result."
    )


def _failed_tool_context_response(outcomes: list[Any], response_text: str) -> str | None:
    if not outcomes or not _NO_CONTEXT_AFTER_TOOL_RE.search(str(response_text or "")):
        return None
    summary = _summarize_failed_tool_outcomes(outcomes)
    return _failed_tool_summary_response(summary) if summary else None


def _summarize_successful_tool_outcomes(outcomes: list[Any]) -> str:
    return _summarize_tool_outcomes(
        outcomes,
        include_outcome=lambda outcome: getattr(outcome, "success", False),
        build_label=lambda outcome: str(getattr(outcome, "tool_name", "") or "tool").strip(),
        empty_detail="completed successfully",
        omitted_label="successful tool result(s)",
    )


def _successful_tool_context_response(outcomes: list[Any]) -> str | None:
    summary = _summarize_successful_tool_outcomes(outcomes)
    if not summary:
        return None
    return (
        "I ran the requested tool call, but the model restarted the conversation "
        "instead of using the result. Tool result summary:\n"
        f"{summary}"
    )


def _empty_post_tool_context_response(
    outcomes: list[Any], *, lead: str | None = None
) -> str | None:
    """Summarize tool results when the model wrote no final reply.

    ``lead`` replaces the "model did not produce a visible final response"
    opening when the caller knows why the turn ended (a budget stop).
    """
    failed_summary = _summarize_failed_tool_outcomes(outcomes)
    successful_summary = _summarize_successful_tool_outcomes(outcomes)
    if lead is not None:
        sections = [
            f"{label}:\n{summary}"
            for label, summary in (
                ("Successful tool results", successful_summary),
                ("Failed tool results", failed_summary),
            )
            if summary
        ]
        return "\n\n".join([lead, *sections]) if sections else None
    if failed_summary and successful_summary:
        return (
            "I ran the requested tool calls, but the model did not produce a visible "
            "final response. Some tool calls succeeded and others failed.\n"
            f"Successful tool results:\n{successful_summary}\n\n"
            f"Failed tool results:\n{failed_summary}"
        )
    if failed_summary:
        return _failed_tool_summary_response(failed_summary)
    if successful_summary:
        return (
            "I ran the requested tool call, but the model did not produce a visible "
            "final response. Tool result summary:\n"
            f"{successful_summary}"
        )
    return None


def _should_issue_tool_nudge(
    *,
    kernel: Any,
    mode_policy: Any,
    outcomes: list[Any],
    response_looks_like_fake_tool_use: bool,
) -> bool:
    return (
        response_looks_like_fake_tool_use
        and str(kernel._config.engine_type or "").strip().lower() in _TEXT_TOOL_CALL_ENGINES
        and str(getattr(mode_policy, "mode", "") or "").strip().lower() == "assist"
        and not outcomes
    )
