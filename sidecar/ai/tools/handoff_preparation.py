"""Handoff-only preparation turn: the trusted request field and its enforcement.

Electron submits a session handoff preparation as an application turn on the
SOURCE session with ``chat.send params.handoff_preparation =
{proposal_id, attempt_id}`` (closed, trusted, never reachable from the renderer).
The sidecar then:

* offers exactly ``complete_session_handoff`` -- every other entry, including
  ``tool_search`` and the always-available tools, is unavailable and refused by
  the pre-dispatch filter;
* permits at most ``MAX_PREPARATION_GENERATIONS`` model generations (the first
  call plus one correction);

and WITHOUT the field ``complete_session_handoff`` is never offered or
dispatched, so an ordinary turn cannot create a child session.

This module is pure: it imports no router or runtime code.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any

from sidecar.ai.error_codes import CMP_LOOP_MAX_ITERATIONS
from sidecar.ai.tools.contracts import ToolExecutionFailure

HANDOFF_TOOL_NAME = "complete_session_handoff"
MAX_PREPARATION_GENERATIONS = 2
PREPARATION_ONLY_REASON = "only complete_session_handoff is available in a handoff preparation turn"
PREPARATION_REQUIRED_REASON = "available only in a handoff preparation turn"
SUB_AGENT_REASON = "session proposals are unavailable to sub-agents"
SESSION_MESSAGE_TOOL_NAME = "session_message"
SESSION_MESSAGE_UNAVAILABLE_REASON = (
    "chat messages need a bound chat and the negotiated session_messages capability"
)
# Tools whose result can end the turn at a session boundary: a sub-agent's boundary would never
# reach its parent's chat.done, so a delegate child is never offered them.
_BOUNDARY_TOOLS = frozenset({"propose_session", HANDOFF_TOOL_NAME})
_PROPOSAL_ID = re.compile(r"proposal_[0-9a-f]{64}")
_ATTEMPT_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_FIELD_KEYS = frozenset({"proposal_id", "attempt_id"})
_GENERATION_COUNT_ATTR = "handoff_preparation_generations"


@dataclass(frozen=True)
class HandoffPreparation:
    proposal_id: str
    attempt_id: str


def handoff_preparation_from_params(params: Any) -> HandoffPreparation | None:
    """Validate ``params.handoff_preparation``; absent (or null) means an ordinary turn."""
    value = params.get("handoff_preparation") if isinstance(params, dict) else None
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or set(value) != _FIELD_KEYS
        or not isinstance(value["proposal_id"], str)
        or _PROPOSAL_ID.fullmatch(value["proposal_id"]) is None
        or not isinstance(value["attempt_id"], str)
        or _ATTEMPT_ID.fullmatch(value["attempt_id"]) is None
    ):
        raise ValueError(
            "chat.send params.handoff_preparation must be exactly "
            "{proposal_id: proposal_<64 hex>, attempt_id: uuid}"
        )
    return HandoffPreparation(proposal_id=value["proposal_id"], attempt_id=value["attempt_id"])


def is_handoff_preparation(request_context: Any) -> bool:
    return isinstance(getattr(request_context, "handoff_preparation", None), HandoffPreparation)


def refuses_in_preparation(request_context: Any, tool_name: str) -> bool:
    """Deny by default: a preparation turn dispatches nothing but ``complete_session_handoff``,
    whether or not the name has a contract entry (``tool_search``, a bare MCP name)."""
    return is_handoff_preparation(request_context) and tool_name != HANDOFF_TOOL_NAME


def _session_message_offerable(request_context: Any, sub_agent: bool) -> bool:
    """``session_message`` is offered only to a main-surface turn of a bound chat whose sidecar
    negotiated ``session_messages`` (Electron's executor fails closed on its own as well)."""
    return (
        not sub_agent
        and getattr(request_context, "session_messages_enabled", False) is True
        and bool(getattr(request_context, "session_id", None))
    )


def apply_handoff_preparation(contract: Any, request_context: Any) -> Any:
    """Restrict an assembled tool contract to the request's handoff posture."""
    preparing = is_handoff_preparation(request_context)
    sub_agent = str(getattr(request_context, "agent_surface", "") or "").lower() == "sub_agent"
    entries = []
    for entry in contract.entries:
        name = entry.descriptor.name
        withheld = name == SESSION_MESSAGE_TOOL_NAME and not preparing
        if withheld and not _session_message_offerable(request_context, sub_agent):
            entries.append(replace(
                entry, available=False, deferred=False, prompt_schema=None,
                reason=SESSION_MESSAGE_UNAVAILABLE_REASON,
            ))
            continue
        if sub_agent and name in _BOUNDARY_TOOLS:
            entries.append(replace(
                entry, available=False, deferred=False, prompt_schema=None, reason=SUB_AGENT_REASON
            ))
            continue
        if (name == HANDOFF_TOOL_NAME) == preparing:
            entries.append(entry)
            continue
        entries.append(
            replace(
                entry,
                available=False,
                deferred=False,
                prompt_schema=None,
                reason=PREPARATION_ONLY_REASON if preparing else PREPARATION_REQUIRED_REASON,
            )
        )
    return replace(contract, entries=tuple(entries))


def charge_preparation_generation(runtime: Any) -> None:
    """Count one model generation of a preparation turn; refuse the third.

    Called from the single generation choke point, so the tool loop and every
    recovery ladder (wind-down, checkpoint continuation) share one budget.
    """
    request_context = getattr(runtime, "request_context", None)
    if not is_handoff_preparation(request_context):
        return
    used = getattr(runtime, _GENERATION_COUNT_ATTR, 0)
    if used >= MAX_PREPARATION_GENERATIONS:
        raise ToolExecutionFailure(
            code=CMP_LOOP_MAX_ITERATIONS,
            message="The handoff preparation turn used its model generations without completing.",
            retryable=False,
        )
    setattr(runtime, _GENERATION_COUNT_ATTR, used + 1)


__all__ = [
    "HANDOFF_TOOL_NAME",
    "MAX_PREPARATION_GENERATIONS",
    "PREPARATION_ONLY_REASON",
    "HandoffPreparation",
    "apply_handoff_preparation",
    "charge_preparation_generation",
    "handoff_preparation_from_params",
    "is_handoff_preparation",
    "refuses_in_preparation",
]
