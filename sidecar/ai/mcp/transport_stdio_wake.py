"""Agent steering (row 180): wake the first-party builtin server's in-flight ``tools/call``.

Split from ``transport_stdio_channel`` (size ratchet). When the person sends a message while a
builtin tool call runs, the turn's steer queue (``sidecar.runtime.turn_steers``) parks it and
calls the listener armed here, which sends the id-less ``notifications/jenny_wake`` notification
for that call. The builtin server sets a per-call wake event that background-job waits poll; the
call itself is never aborted. Only the first-party server (cooperative cancel) is woken, and only
for ``tools/call``: a third-party server may not know the notification.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

from sidecar.ai.mcp.exceptions import MCPError

logger = logging.getLogger("sidecar.ai.mcp.transport_stdio")

# Must stay in lockstep with builtin_server_io.WAKE_NOTIFICATION_METHOD.
WAKE_NOTIFICATION_METHOD = "notifications/jenny_wake"
MCP_WAKE_WRITE_SECONDS = 2.0


def arm_steer_wake(
    transport: Any, method: str, cancel_handle: Any, request_id: int
) -> list[Callable[[], None]]:
    """Wake a builtin ``tools/call`` when a steer parks; returns the remover to run at call end.

    Call with the transport's request lock held, right after the call's line was written. An
    item already parked wakes the call at once; later arrivals wake it from the admitting thread.
    """
    steers = getattr(cancel_handle, "pending_steers", None)
    add_listener = getattr(steers, "add_wake_listener", None)
    config = getattr(transport, "_config", None)
    if (
        method != "tools/call"
        or getattr(config, "cooperative_cancel", False) is not True
        or steers is None
        or not callable(add_listener)
    ):
        return []
    remove = add_listener(lambda: _wake_in_background(transport, request_id))
    if steers.has_pending():
        _write_wake(transport, request_id)
    return [remove]


def _write_wake(transport: Any, request_id: int) -> None:
    try:
        transport._write_line(
            {
                "jsonrpc": "2.0",
                "method": WAKE_NOTIFICATION_METHOD,
                "params": {"requestId": request_id},
            },
            deadline=time.monotonic() + MCP_WAKE_WRITE_SECONDS,
        )
    except MCPError:
        # Pipe already dead: the read loop surfaces the failure for the call itself.
        logger.warning("mcp wake notification write failed server=%s", transport.server_name)


def _wake_in_background(transport: Any, request_id: int) -> None:
    """Send the wake from a short-lived thread: the listener runs on the stdin reader."""

    def send() -> None:
        try:
            if not transport._request_lock.acquire(timeout=MCP_WAKE_WRITE_SECONDS):
                return
            try:
                with transport._pending_lock:
                    in_flight = request_id in transport._pending_responses
                if in_flight:
                    _write_wake(transport, request_id)
            finally:
                transport._request_lock.release()
        except Exception:  # noqa: BLE001 - a wake is best effort.
            logger.warning("mcp wake notification failed server=%s", transport.server_name)

    threading.Thread(target=send, name=f"mcp-wake-{transport.server_name}", daemon=True).start()
