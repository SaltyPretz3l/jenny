"""End-of-turn boundaries raised by the two session-proposal tools.

An Electron tool result may carry metadata ``turn_boundary``. Only a SUCCESSFUL
outcome of exactly ``propose_session`` (``awaiting_proposal``) or
``complete_session_handoff`` (``session_handoff_completed``) that also carries a
canonical ``proposal_id`` ends the turn: the unstarted rest of the batch is
settled as not executed, no further model generation runs, and ``chat.done``
carries ``completion_reason`` + ``proposal_id``. The first boundary wins.

A batch that closes on a successful ``suggest_next_step`` also ends the turn
without another generation, but raises no boundary and adds nothing to ``chat.done``.

This module is pure (no router or runtime imports at module load); the batch
executor detects, the four batch callers finish.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

AWAITING_PROPOSAL = "awaiting_proposal"
SESSION_HANDOFF_COMPLETED = "session_handoff_completed"
# tool name -> the only turn_boundary value that tool may raise.
BOUNDARY_BY_TOOL: dict[str, str] = {
    "propose_session": AWAITING_PROPOSAL,
    "complete_session_handoff": SESSION_HANDOFF_COMPLETED,
}
COMPLETION_REASONS = frozenset(BOUNDARY_BY_TOOL.values())
# Ends the turn without a wire boundary (see ends_turn_at_next_step).
NEXT_STEP_TOOL = "suggest_next_step"
PROPOSAL_ID_RE = re.compile(r"proposal_[0-9a-f]{64}")
# Model-facing text for a call that never ran because the turn already ended.
NOT_EXECUTED_OUTPUT = (
    "Tool '{tool_id}' was not executed: this turn already ended at a session "
    "{what}. Nothing from this call happened."
)
_WHAT_BY_REASON = {
    AWAITING_PROPOSAL: "proposal that is waiting for the user's choice",
    SESSION_HANDOFF_COMPLETED: "handoff that is already complete",
}


@dataclass(frozen=True)
class TurnBoundary:
    """The wire pair carried by ``chat.done``: both fields or neither."""

    completion_reason: str
    proposal_id: str

    def done_params(self) -> dict[str, str]:
        return {"completion_reason": self.completion_reason, "proposal_id": self.proposal_id}

    def not_executed_output(self, tool_id: str) -> str:
        what = _WHAT_BY_REASON.get(self.completion_reason, "boundary")
        return NOT_EXECUTED_OUTPUT.format(tool_id=tool_id, what=what)


def detect_turn_boundary(outcome: Any) -> TurnBoundary | None:
    """The boundary a tool outcome raises, or ``None`` (anything but an exact match)."""
    expected = BOUNDARY_BY_TOOL.get(str(getattr(outcome, "tool_name", "") or ""))
    if expected is None or getattr(outcome, "success", False) is not True:
        return None
    metadata = getattr(outcome, "metadata", None)
    if not isinstance(metadata, dict) or metadata.get("turn_boundary") != expected:
        return None
    proposal_id = metadata.get("proposal_id")
    if not isinstance(proposal_id, str) or PROPOSAL_ID_RE.fullmatch(proposal_id) is None:
        return None
    return TurnBoundary(completion_reason=expected, proposal_id=proposal_id)


def ends_turn_at_next_step(outcomes: Any, calls: Any = None) -> bool:
    """True when the batch closed on a successful ``suggest_next_step``.

    The next-step card is drawn as the reply's last element, so another generation only
    adds a reasoning row and filler after it (owner live check 2026-11-01). Unlike the
    proposal boundaries it carries nothing on the wire: ``chat.done`` is an ordinary end.
    With *calls* (the model's batch, in model order) the card must be the last call: a
    refused call is recorded before the batch runs, so outcome order is not model order.
    """
    if not isinstance(outcomes, (list, tuple)) or not outcomes:
        return False
    last = outcomes[-1]
    if calls is not None:
        ordered = list(calls)
        if not ordered or str(getattr(ordered[-1], "tool_id", "") or "") != NEXT_STEP_TOOL:
            return False
        call_id = str(getattr(ordered[-1], "call_id", "") or "")
        last = next(
            (o for o in reversed(outcomes) if str(getattr(o, "call_id", "") or "") == call_id),
            None,
        )
    return (
        last is not None
        and str(getattr(last, "tool_name", "") or "") == NEXT_STEP_TOOL
        and getattr(last, "success", False) is True
    )


def finish_loop_at_next_step(loop: Any, *, raw_content: str = "") -> Any:
    """Finish a live loop after its next-step card; the text written with the call is kept.

    Streamed text already reached Electron, which stored it as a segment when the card's
    tool ran; repeating it in ``chat.done`` showed it twice (live check 2026-11-01).
    """
    import sidecar.ai.routing.tool_loop as _tl_hub

    streamed = bool(getattr(loop.runtime, "streaming", False)) and (
        "chat.token" in loop.streamed_event_types
    )
    response_text = _tl_hub.finalize_visible_reply(
        raw_content, request_id=loop.request_id, session_id=loop.session_id
    ) if raw_content.strip() and not streamed else ""
    loop.runtime.audit(
        _tl_hub.KIND_TURN_COMPLETED,
        summary=f"turn_completed next_step_card outcomes={len(loop.outcomes)}",
    )
    return loop._finish_text(response_text, reason="next_step_card")


def boundary_loop_result(  # noqa: PLR0913 -- the ToolLoopResult fields it carries.
    *,
    boundary: TurnBoundary,
    outcomes: list[Any],
    usage_totals: Any,
    streamed_event_types: set[str],
    response_text: str = "",
    thinking_text: str | None = None,
) -> Any:
    """A ``ToolLoopResult`` ending the turn at *boundary* (visible text may be empty)."""
    import sidecar.ai.routing.tool_loop as _tl_hub

    return _tl_hub.ToolLoopResult(
        thinking_text=thinking_text,
        thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
        persist_thinking=False,
        response_text=response_text,
        approval_request=None,
        approval_plan=None,
        outcomes=outcomes,
        usage_totals=usage_totals,
        streamed_event_types=streamed_event_types,
        turn_boundary=boundary,
    )


def finish_loop_at_boundary(loop: Any, boundary: TurnBoundary, *, raw_content: str = "") -> Any:
    """Finish a live loop (``_ToolLoopRun``) at *boundary*; the preamble text is kept."""
    import sidecar.ai.routing.tool_loop as _tl_hub

    response_text = _tl_hub.finalize_visible_reply(
        raw_content, request_id=loop.request_id, session_id=loop.session_id
    ) if raw_content.strip() else ""
    loop.runtime.audit(
        _tl_hub.KIND_TURN_COMPLETED,
        summary=(
            f"turn_completed turn_boundary={boundary.completion_reason} "
            f"outcomes={len(loop.outcomes)}"
        ),
    )
    return loop._finish(
        boundary_loop_result(
            boundary=boundary,
            outcomes=loop.outcomes,
            usage_totals=loop.usage_totals,
            streamed_event_types=loop.streamed_event_types,
            response_text=response_text,
            thinking_text=loop.thinking_text,
        ),
        reason="turn_boundary",
    )


__all__ = [
    "AWAITING_PROPOSAL",
    "BOUNDARY_BY_TOOL",
    "COMPLETION_REASONS",
    "NEXT_STEP_TOOL",
    "PROPOSAL_ID_RE",
    "SESSION_HANDOFF_COMPLETED",
    "TurnBoundary",
    "boundary_loop_result",
    "detect_turn_boundary",
    "ends_turn_at_next_step",
    "finish_loop_at_boundary",
    "finish_loop_at_next_step",
]
