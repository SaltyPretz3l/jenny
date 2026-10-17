"""Kind dispatch for ``role:"context"`` history rows.

Two context kinds can ride ``chat.send.messages``: ``session_message`` (an
attributed message from another chat) and ``session_handoff`` (assistant-prepared
background a linked chat starts from). Every call site that handles a context row
-- request validation, semantic sanitizing, provider rendering, token estimation,
history hashing and compaction -- goes through this module so a new kind cannot be
admitted in one place and forgotten in another. Any other kind is invalid.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sidecar.ai.context import session_handoff as _handoff
from sidecar.ai.context import session_messages as _messages

CONTEXT_ROLE = _messages.CONTEXT_ROLE
SESSION_MESSAGE_KIND = _messages.SESSION_MESSAGE_KIND
SESSION_HANDOFF_KIND = _handoff.SESSION_HANDOFF_KIND
WIRE_CONTEXT_KINDS = frozenset({SESSION_MESSAGE_KIND, SESSION_HANDOFF_KIND})
# The envelope key each kind carries (also the history-hash field name).
ENVELOPE_FIELD_BY_KIND = {
    SESSION_MESSAGE_KIND: "session_message",
    SESSION_HANDOFF_KIND: "session_handoff",
}


def _kind(row: Any) -> str | None:
    return row.get("kind") if isinstance(row, Mapping) else None


def context_row_error(row: Any) -> str | None:
    """Why *row* is not a valid wire context row of its kind, else ``None``."""
    if _kind(row) == SESSION_HANDOFF_KIND:
        return _handoff.session_handoff_row_error(row)
    return _messages.session_message_row_error(row)


def sanitize_context_row(row: Any) -> dict[str, object] | None:
    if _kind(row) == SESSION_HANDOFF_KIND:
        return _handoff.sanitize_session_handoff_row(row)
    return _messages.sanitize_session_message_row(row)


def render_context_content(row: Mapping[str, Any]) -> str | None:
    """Model-facing text of an admitted row (preamble + JSON), ``None`` without an envelope."""
    if _kind(row) == SESSION_HANDOFF_KIND:
        return _handoff.render_session_handoff_content(row)
    return _messages.render_session_message_content(row)


def render_context_entries(row: Mapping[str, Any]) -> list[dict[str, str]]:
    """``[user entry]`` for a valid row, ``[]`` for an invalid one (never forwarded raw)."""
    if _kind(row) == SESSION_HANDOFF_KIND:
        return _handoff.render_session_handoff_entries(row)
    return _messages.render_session_message_entries(row)


def context_hash_projection(row: Mapping[str, Any]) -> dict[str, Any] | None:
    """Stable identity of a row for history hashing, never the whole envelope."""
    if _kind(row) == SESSION_HANDOFF_KIND:
        return _handoff.session_handoff_hash_projection(row)
    return _messages.session_message_hash_projection(row)


def format_context_row_for_compaction(row: Mapping[str, Any]) -> tuple[str, str] | None:
    if _kind(row) == SESSION_HANDOFF_KIND:
        return _handoff.format_session_handoff_for_compaction(row)
    return _messages.format_session_message_for_compaction(row)


__all__ = [
    "CONTEXT_ROLE",
    "ENVELOPE_FIELD_BY_KIND",
    "SESSION_HANDOFF_KIND",
    "SESSION_MESSAGE_KIND",
    "WIRE_CONTEXT_KINDS",
    "context_hash_projection",
    "context_row_error",
    "format_context_row_for_compaction",
    "render_context_content",
    "render_context_entries",
    "sanitize_context_row",
]
