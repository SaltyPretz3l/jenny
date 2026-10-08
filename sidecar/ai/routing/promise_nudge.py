"""One "do it now" nudge for a final reply that only promises the work.

Dogfood (Relay Drift, 2026-10-05): a build turn read the brief, listed the
folder, then ended on "I'll create the game first..." with nothing written; the
user had to say "go". When a main-agent turn that can still change the
workspace ends on a first-person promise of an action, has changed nothing,
asks nothing and names no blocker, the loop asks once to do it now or say what
blocks it. The reply stays in the model's history; the user's view of it is
discarded by the stream reset, like the Plan Mode prose nudge.
``JENNY_ENABLE_PROMISE_NUDGE=0`` disables it.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from sidecar.ai.config import read_environment_value
from sidecar.ai.routing.loop_event_emit import emit_stream_reset_for_retry
from sidecar.ai.routing.write_progress import _is_write
from sidecar.ai.tools.sanitization import sanitize_assistant_output
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

__all__ = ("PROMISE_NUDGE", "PROMISE_NUDGE_FLAG", "final_promise_nudge", "looks_like_promise")

PROMISE_NUDGE_FLAG = "JENNY_ENABLE_PROMISE_NUDGE"
PROMISE_NUDGE = (
    "Your last reply said what you will do next, but no tool ran to do it and nothing "
    "in the workspace has changed this turn. Do it now with a tool call. If something "
    "blocks you, say exactly what it is instead."
)
_MAX_REPLY_CHARS = 16_000

# "I'll create", "Let me now write", "I'm going to build", "Next, I will add".
_PROMISE = re.compile(
    r"\b(?:i'll|i will|i'm going to|i am going to|let me|next,? i(?:'ll| will)?)"
    r"\s+(?:now\s+|first\s+|start\s+by\s+|go\s+ahead\s+and\s+)?"
    r"(?:create|write|build|implement|add|fix|update|make|edit|generate|scaffold|"
    r"set\s+up|put|save|apply|refactor|wire|run|start)\b"
)
# Quoted or code text is an example, not the model's own plan.
_QUOTED = re.compile(r'```.*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”', re.DOTALL)
# Offers and blockers (anywhere in the reply) are answers, not stalls.
_NOT_A_STALL = re.compile(
    r"\b(?:if you|would you|do you want|want me to|should i|let me know|"
    r"can't|cannot|unable|blocked|blocker|need you|waiting for|permission|approve)\b"
)


def _enabled() -> bool:
    return read_environment_value(PROMISE_NUDGE_FLAG, "1") != "0"


def looks_like_promise(reply: str) -> bool:
    """The last paragraph promises an action; no question, offer or blocker anywhere."""
    text = _QUOTED.sub(" ", reply.strip()).lower().replace("’", "'")
    paragraphs = [block.strip() for block in re.split(r"\n\s*\n", text) if block.strip()]
    if not paragraphs or "?" in text or _NOT_A_STALL.search(text):
        return False
    return bool(_PROMISE.search(paragraphs[-1]))


def _nudged_this_turn(loop: Any) -> bool:
    """Seen on this loop, or in this turn's rows (an approval resume is a new loop)."""
    if getattr(loop, "_promise_nudged", False):
        return True
    latest = str(getattr(loop, "latest_user_content", "") or "")
    for message in reversed(loop.working_messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if content == PROMISE_NUDGE:
            return True
        if latest and content == latest:
            return False
    return False


def _changed_workspace(outcomes: list[Any]) -> bool:
    return any(
        getattr(outcome, "success", False)
        and _is_write(outcome, str(getattr(outcome, "tool_name", "") or ""))
        for outcome in outcomes
    )


def final_promise_nudge(loop: Any, result: Any, iteration: int) -> bool:
    """Ask once for the promised action. True when the loop should generate again."""
    if not _enabled() or _nudged_this_turn(loop):
        return False
    if (
        loop.plan_mode
        or loop.read_only
        or loop.is_sub_agent_request
        or not getattr(loop.mode_policy, "allow_side_effecting_tools", False)
        or not loop.tool_contract.available_names
        or loop.runtime.remaining_tool_calls <= 0
    ):
        return False
    finish_reason = str(getattr(result, "finish_reason", "") or "").strip().lower()
    if (
        finish_reason not in {"", "stop"}
        or result.inband_tool_call_parse_failed
        or loop._is_continuable_checkpoint(result)
        or iteration >= loop.iteration_total + loop.loop_cap.pending_extension()
        or _changed_workspace(loop.outcomes)
    ):
        return False
    reply = sanitize_assistant_output(str(result.content or ""), max_chars=_MAX_REPLY_CHARS)
    if not looks_like_promise(reply):
        return False
    loop._promise_nudged = True
    # nudge_retry, not post_tool_restart: the draft promised a tool it never
    # called, so the fold reads "it skipped a tool it needed" (gate F5).
    emit_stream_reset_for_retry(loop.runtime, loop.streamed_event_types, reason="nudge_retry")
    loop.working_messages.append({"role": "assistant", "content": reply.strip()})
    loop.working_messages.append({"role": "user", "content": PROMISE_NUDGE})
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.promise_nudge",
        message="Asked the model to act on the work its final reply only promised.",
        status="nudged",
        data={"iteration": iteration, "reply_chars": len(reply)},
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    return True
