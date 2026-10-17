"""Chat-workspace capability negotiation for ``initialize``.

Electron sends the chat-workspace capabilities it wants to use in the top-level
``chat_workspace_capabilities`` initialize parameter; the sidecar answers with
the intersection of that request and what it has implemented and qualified.
A malformed, missing or hosted request negotiates the empty form, so a missing
capability disables new producer/context paths without any fallback to user
text or system overlays.

This module is pure: no Electron, renderer or container imports.
"""

from __future__ import annotations

from typing import Any

CHAT_WORKSPACE_VERSION = 1
# Stage flags advertise only implemented, qualified operations.
SUPPORTED_PRODUCER_TOOLS: tuple[str, ...] = ("propose_session", "complete_session_handoff")
# session_message_receipt is never a wire kind.
SUPPORTED_CONTEXT_KINDS: tuple[str, ...] = ("session_message", "session_handoff")
SESSION_MESSAGE_CONTEXT_KIND = "session_message"
SESSION_HANDOFF_CONTEXT_KIND = "session_handoff"

_REQUEST_KEYS = frozenset({"schema_version", "producer_tools", "context_kinds", "session_messages"})


def empty_chat_workspace_capabilities() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "producer_tools": [],
        "context_kinds": [],
        "session_messages": False,
    }


def _string_list(value: Any) -> list[str] | None:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return None
    return value


def negotiate(requested: Any, *, hosted: bool) -> dict[str, Any]:
    """Return the closed acknowledgment: the request intersected with support."""
    if hosted or not isinstance(requested, dict) or set(requested) != _REQUEST_KEYS:
        return empty_chat_workspace_capabilities()
    version = requested.get("schema_version")
    producer_tools = _string_list(requested.get("producer_tools"))
    context_kinds = _string_list(requested.get("context_kinds"))
    session_messages = requested.get("session_messages")
    if (
        isinstance(version, bool)
        or version != 1
        or producer_tools is None
        or context_kinds is None
        or not isinstance(session_messages, bool)
    ):
        return empty_chat_workspace_capabilities()
    negotiated_tools = [tool for tool in SUPPORTED_PRODUCER_TOOLS if tool in producer_tools]
    negotiated_kinds = [kind for kind in SUPPORTED_CONTEXT_KINDS if kind in context_kinds]
    return {
        "schema_version": 1,
        "producer_tools": negotiated_tools,
        "context_kinds": negotiated_kinds,
        "session_messages": session_messages and SESSION_MESSAGE_CONTEXT_KIND in negotiated_kinds,
    }


def latch_session_messages(brain_container: Any, enabled: bool) -> None:
    """Record the grant on the container when it supports latching (re-initialize resets)."""
    latch = getattr(brain_container, "latch_chat_workspace_session_messages", None)
    if callable(latch):
        latch(enabled)


def latch_session_handoff(brain_container: Any, enabled: bool) -> None:
    """Record the handoff-context grant (separate from the session-message latch)."""
    latch = getattr(brain_container, "latch_chat_workspace_session_handoff", None)
    if callable(latch):
        latch(enabled)


def negotiate_and_latch(brain_container: Any, params: Any, *, hosted: bool) -> dict[str, Any]:
    """Negotiate the initialize request and latch the session-message and handoff grants."""
    requested = params.get("chat_workspace_capabilities") if isinstance(params, dict) else None
    negotiated = negotiate(requested, hosted=hosted)
    latch_session_messages(brain_container, session_messages_negotiated(negotiated))
    latch_session_handoff(brain_container, session_handoff_negotiated(negotiated))
    return negotiated


def session_messages_negotiated(capabilities: Any) -> bool:
    """True when an acknowledgment lets context rows ride ``chat.send``."""
    return (
        isinstance(capabilities, dict)
        and capabilities.get("session_messages") is True
        and SESSION_MESSAGE_CONTEXT_KIND in (capabilities.get("context_kinds") or [])
    )


def session_handoff_negotiated(capabilities: Any) -> bool:
    """True when an acknowledgment lets ``session_handoff`` context rows ride ``chat.send``."""
    return isinstance(capabilities, dict) and SESSION_HANDOFF_CONTEXT_KIND in (
        capabilities.get("context_kinds") or []
    )
