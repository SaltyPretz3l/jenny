"""Keep managed NInfer's prompt cache anchored at the end of the conversation.

NInfer has no longest-common-prefix reuse: a request reuses a continuation of
the one before it or a prefix the client marked. The per-turn ``## Turn
Context`` row sits right before the latest user message and is gone from the
next turn's request, so the continuation never matches and a follow-up
re-prefills the whole conversation (0 of 88,656 tokens reused, 25 s to first
token, measured 2026-11-08). Marking the last history row before the current
turn gives the next turn a shared prefix there, and the mark also survives a
side request such as a chat title, which replaces the private continuation.

The mark is one ``prompt_cache_breakpoint`` on an existing text row: the
rendered prompt does not change. ``JENNY_ENABLE_NINFER_CACHE_BREAKPOINT=0``
turns it off.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.config import read_environment_value
from sidecar.ai.context.turn_context import TURN_CONTEXT_HEADER

_BREAKPOINT_FLAG = "JENNY_ENABLE_NINFER_CACHE_BREAKPOINT"
# ``system`` covers a first turn: the prompt block is the only stable row yet.
_MARKABLE_ROLES = frozenset({"system", "user", "assistant"})
# A boundary further back than this is a turn of tool calls with no text row
# near it; the next text row would save little and the search stays bounded.
_MAX_ROWS_BACK = 16


def _is_managed_ninfer_request(engine: Any) -> bool:
    try:
        options = (engine._current_request_context() or {}).get("inference_performance")
    except Exception:  # noqa: BLE001 - an unreadable context is an unknown provider.
        return False
    return isinstance(options, dict) and options.get("provider_kind") == "ninfer"


def _current_turn_start(messages: list[dict[str, Any]]) -> int | None:
    """Index of the row that opens the current turn."""
    latest_user: int | None = None
    for index in range(len(messages) - 1, -1, -1):
        content = messages[index].get("content")
        if isinstance(content, str) and content.startswith(TURN_CONTEXT_HEADER):
            return index
        if latest_user is None and messages[index].get("role") == "user":
            latest_user = index
    return latest_user


def _mark_target(messages: list[dict[str, Any]], turn_start: int) -> int | None:
    for index in range(turn_start - 1, max(turn_start - 1 - _MAX_ROWS_BACK, -1), -1):
        message = messages[index]
        content = message.get("content")
        if message.get("role") in _MARKABLE_ROLES and isinstance(content, str) and content.strip():
            return index
    return None


def mark_history_boundary(engine: Any, payload: dict[str, Any]) -> None:
    """Put one cache breakpoint on the last history row before the current turn."""
    if read_environment_value(_BREAKPOINT_FLAG, "1") == "0":
        return
    if not _is_managed_ninfer_request(engine):
        return
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return
    turn_start = _current_turn_start(messages)
    target = None if turn_start is None else _mark_target(messages, turn_start)
    if target is None:
        return
    messages[target]["content"] = [
        {
            "type": "text",
            "text": messages[target]["content"],
            "prompt_cache_breakpoint": {"mode": "explicit"},
        }
    ]


__all__ = ["mark_history_boundary"]
