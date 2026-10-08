"""Plan Mode "present your plan" assist (MQ-001 / MQ-024).

In Plan Mode the only approvable plan is an ``exit_plan_mode`` call. A local
model can instead write the plan as prose, which finalizes as an ordinary reply
with no plan card, or keep investigating until the working-time deadline ends
the turn with nothing to approve. This module adds two one-shot nudges and a
one-step tool gate; it never turns prose into a plan card and never dispatches
a tool. ``JENNY_ENABLE_PLAN_PRESENTATION_ASSIST=0`` disables all of it.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from sidecar.ai.config import read_environment_value
from sidecar.ai.routing.iteration_limits import effective_max_loop_wall_seconds
from sidecar.ai.routing.loop_event_emit import emit_stream_reset_for_retry
from sidecar.ai.routing.write_progress import _schema_name
from sidecar.ai.tools.sanitization import sanitize_assistant_output
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

__all__ = (
    "ASSIST_FLAG",
    "PLAN_PROSE_NUDGE",
    "deadline_nudge_row",
    "final_prose_nudge",
    "gated_generation_payload",
    "looks_like_plan",
    "plan_pending",
)

ASSIST_FLAG = "JENNY_ENABLE_PLAN_PRESENTATION_ASSIST"
# The deadline nudge fires with this much working time left: ten minutes, or
# 15% of the turn's budget when that is longer, never more than half the budget
# (a short turn still gets to read before it is told to submit).
DEADLINE_FLOOR_SECONDS = 600.0
DEADLINE_SHARE = 0.15
DEADLINE_MAX_SHARE = 0.5
MIN_LIST_LINES = 3
_PLAN_TOOL = "exit_plan_mode"
_GATE_TOOLS = frozenset({_PLAN_TOOL, "ask_user"})
_MAX_REPLY_CHARS = 16_000

PLAN_PROSE_NUDGE = (
    "Plan Mode is still on and no plan has been submitted. Your last reply wrote the "
    "plan as prose, which the user cannot approve. Call `exit_plan_mode` now with a "
    "concise title, 1-20 flat steps, and optional notes and verification taken from "
    "that reply. Do not repeat the plan as text."
)
_DEADLINE_TEMPLATE = (
    "Plan Mode: this planning turn is close to its {limit} limit and no plan has been "
    "submitted. Stop investigating. Call `exit_plan_mode` now with the best plan you "
    "have; put unknowns and the checks that would settle them under notes and "
    "verification."
)

_LIST_LINE = re.compile(r"^\s*(?:[-*+\u2022]|\d+[.)])\s+\S", re.MULTILINE)
# "Plan:" or a bare "Plan" heading line; "Plan Mode is read-only..." is an answer.
_PLAN_LINE = re.compile(r"^[ \t]*(?:#{1,6}[ \t]*|\*\*)?Plan(?:\*\*)?[ \t]*(?::|$)", re.MULTILINE)


def _assist_enabled() -> bool:
    return read_environment_value(ASSIST_FLAG, "1") != "0"


def _no_plan_since_rejection(outcomes: list[Any]) -> bool:
    """No exit_plan_mode outcome, or the newest one was a Keep-planning rejection."""
    for outcome in reversed(outcomes):
        if getattr(outcome, "tool_name", "") == _PLAN_TOOL:
            metadata = getattr(outcome, "metadata", None)
            return isinstance(metadata, dict) and metadata.get("plan_decision") == "rejected"
    return True


def plan_pending(loop: Any) -> bool:
    """A main-agent Plan Mode run that still owes the user an approvable plan.

    After Keep planning the model may submit one revision, so a rejection makes
    the plan pending again. A spent tool budget means exit_plan_mode can no
    longer run, so nothing is pending that a nudge could rescue.
    """
    if not loop.plan_mode or loop.is_sub_agent_request:
        return False
    if _PLAN_TOOL not in loop.tool_contract.available_names:
        return False
    if loop.runtime.remaining_tool_calls <= 0:
        return False
    decision = str(getattr(loop.request_context, "plan_decision", "") or "").strip()
    return decision in {"", "rejected"} and _no_plan_since_rejection(loop.outcomes)


def looks_like_plan(reply: str) -> bool:
    """A "Plan" heading or at least three list lines, and no question in the reply.

    Any line ending in "?" keeps the reply as it is: a clarifying question
    followed by its options is a list too, and the user has to answer it first.
    """
    text = reply.strip()
    if not text or any(line.rstrip().endswith("?") for line in text.splitlines()):
        return False
    return bool(_PLAN_LINE.search(text)) or len(_LIST_LINE.findall(text)) >= MIN_LIST_LINES


def _steps_left(loop: Any, iteration: int) -> bool:
    return iteration < loop.iteration_total + loop.loop_cap.pending_extension()


def final_prose_nudge(loop: Any, result: Any, iteration: int) -> bool:
    """Ask once for an exit_plan_mode call when a final reply wrote the plan as prose.

    Returns True when the loop should run another generation. The prose stays
    in the model's history as its own reply, so the call can be built from it;
    the user's view of it is discarded by the stream reset.
    """
    if getattr(loop, "_plan_prose_nudged", False) or not _assist_enabled():
        return False
    if not plan_pending(loop):
        return False
    finish_reason = str(getattr(result, "finish_reason", "") or "").strip().lower()
    if (
        finish_reason not in {"", "stop"}
        or result.inband_tool_call_parse_failed
        or loop._is_continuable_checkpoint(result)
        or not _steps_left(loop, iteration)
    ):
        return False
    reply = sanitize_assistant_output(str(result.content or ""), max_chars=_MAX_REPLY_CHARS)
    if not looks_like_plan(reply):
        return False
    loop._plan_prose_nudged = True
    # nudge_retry, not post_tool_restart: the draft wrote the plan as prose
    # instead of calling exit_plan_mode, so the fold reads "it skipped a tool
    # it needed" rather than blaming tools that may never have run (2026-10-05
    # recheck, same cause as the promise nudge's gate F5).
    emit_stream_reset_for_retry(loop.runtime, loop.streamed_event_types, reason="nudge_retry")
    loop.working_messages.append({"role": "assistant", "content": reply.strip()})
    loop.working_messages.append({"role": "user", "content": PLAN_PROSE_NUDGE})
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.plan_prose_nudge",
        message="Asked the model to submit its prose plan through exit_plan_mode.",
        status="nudged",
        data={"iteration": iteration, "reply_chars": len(reply)},
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    return True


def deadline_nudge_row(loop: Any, iteration: int) -> dict[str, object] | None:
    """The one-shot "submit your plan now" row near the deadline or on the last step.

    Arms a one-generation tool gate (see ``gated_generation_payload``).
    """
    if getattr(loop, "_plan_deadline_nudged", False) or not _assist_enabled():
        return None
    if not plan_pending(loop):
        return None
    remaining = loop.runtime.remaining_wall_clock_seconds()
    wall_seconds = effective_max_loop_wall_seconds(loop.kernel._config)
    threshold = min(
        max(DEADLINE_FLOOR_SECONDS, DEADLINE_SHARE * wall_seconds),
        DEADLINE_MAX_SHARE * wall_seconds,
    )
    near_deadline = remaining is not None and remaining <= threshold
    if not near_deadline and _steps_left(loop, iteration):
        return None
    loop._plan_deadline_nudged = True
    loop._plan_gate_next_step = True
    limit = "working-time" if near_deadline else "step"
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.plan_deadline_nudge",
        message="Told the model to submit its plan before the turn limit.",
        status="nudged",
        data={
            "iteration": iteration,
            "limit": limit,
            "remaining_s": None if remaining is None else round(remaining, 1),
            "threshold_s": round(threshold, 1),
        },
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    return {"role": "system", "content": _DEADLINE_TEMPLATE.format(limit=limit)}


def gated_generation_payload(loop: Any, payload: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Consume an armed gate: one generation offered only exit_plan_mode and ask_user.

    The gate never empties the payload: without either schema the step keeps
    its ordinary tools.
    """
    if not getattr(loop, "_plan_gate_next_step", False):
        return payload
    loop._plan_gate_next_step = False
    gated = [schema for schema in payload if _schema_name(schema) in _GATE_TOOLS]
    if not gated:
        return payload
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.plan_presentation_tool_gate",
        message="Offered only the plan tools for one step near the turn limit.",
        status="gated",
        data={
            "offered": [_schema_name(schema) for schema in gated],
            "withheld": len(payload) - len(gated),
        },
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    return gated
