"""Propose mode "record your suggestion" nudge (Plan Plus C2).

In Propose mode the only reviewable change is a ``propose_change`` call. A local
model can instead describe its changes in prose, which ends the turn with
nothing for the user to accept (the 2026-10-05 spike: the nudge recovered every
such run). When a main-agent Propose turn ends on prose with no suggestion
recorded, the loop asks once for the calls. It never turns prose into a
suggestion. A sibling of ``plan_presentation``: the same
``JENNY_ENABLE_PLAN_PRESENTATION_ASSIST=0`` kill switch disables it.
"""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.config import read_environment_value
from sidecar.ai.routing.loop_event_emit import emit_stream_reset_for_retry
from sidecar.ai.routing.plan_presentation import ASSIST_FLAG
from sidecar.ai.tools.sanitization import sanitize_assistant_output
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

__all__ = ("PROPOSE_NUDGE", "final_propose_nudge", "suggestion_pending")

PROPOSE_NUDGE = (
    "No suggested change was recorded. Call propose_change for each change you described, "
    "with old_string copied exactly from the current file; nothing is applied until the user "
    "accepts. If no change is needed, say so in one sentence instead."
)
_PROPOSE_TOOL = "propose_change"
_MAX_REPLY_CHARS = 16_000


def _assist_enabled() -> bool:
    return read_environment_value(ASSIST_FLAG, "1") != "0"


def _recorded_suggestion(outcomes: list[Any]) -> bool:
    return any(
        getattr(outcome, "tool_name", "") == _PROPOSE_TOOL
        and getattr(outcome, "success", False) is True
        for outcome in outcomes
    )


def _nudged_this_turn(loop: Any) -> bool:
    """Seen on this loop, or in this turn's rows (an approval resume is a new loop)."""
    if getattr(loop, "_propose_nudged", False):
        return True
    latest = str(getattr(loop, "latest_user_content", "") or "")
    for message in reversed(loop.working_messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if content == PROPOSE_NUDGE:
            return True
        if latest and content == latest:
            return False
    return False


def suggestion_pending(loop: Any) -> bool:
    """A main-agent Propose run that has not recorded a suggestion and still can."""
    if not getattr(loop.request_context, "propose_mode", False) or loop.is_sub_agent_request:
        return False
    if _PROPOSE_TOOL not in loop.tool_contract.available_names:
        return False
    if loop.runtime.remaining_tool_calls <= 0:
        return False
    return not _recorded_suggestion(loop.outcomes)


def final_propose_nudge(loop: Any, result: Any, iteration: int) -> bool:
    """Ask once for propose_change calls. True when the loop should generate again.

    A reply that asks the user a question stays as it is: the user answers first.
    """
    if not _assist_enabled() or _nudged_this_turn(loop) or not suggestion_pending(loop):
        return False
    finish_reason = str(getattr(result, "finish_reason", "") or "").strip().lower()
    if (
        finish_reason not in {"", "stop"}
        or result.inband_tool_call_parse_failed
        or loop._is_continuable_checkpoint(result)
        or iteration >= loop.iteration_total + loop.loop_cap.pending_extension()
    ):
        return False
    reply = sanitize_assistant_output(str(result.content or ""), max_chars=_MAX_REPLY_CHARS)
    if not reply.strip() or "?" in reply:
        return False
    loop._propose_nudged = True
    # nudge_retry, not post_tool_restart: the draft described its changes as
    # prose instead of calling propose_change, so the fold reads "it skipped a
    # tool it needed" (2026-10-05 recheck, same cause as gate F5).
    emit_stream_reset_for_retry(loop.runtime, loop.streamed_event_types, reason="nudge_retry")
    loop.working_messages.append({"role": "assistant", "content": reply.strip()})
    loop.working_messages.append({"role": "user", "content": PROPOSE_NUDGE})
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.propose_nudge",
        message="Asked the model to record its described changes through propose_change.",
        status="nudged",
        data={"iteration": iteration, "reply_chars": len(reply)},
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    return True
