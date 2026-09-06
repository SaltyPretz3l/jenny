"""Stdin pump and termination handling for the builtin MCP server loop.

Split from ``builtin_server`` so the dispatch module stays within the
production size ratchet. Everything here is stdlib + the cancellation slot:
this module sits on the builtin server's bootstrap import path, where every
extra import is charged to subprocess spawn cost.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import sys
import threading

from sidecar.ai.tools.builtins import cancellation

CANCEL_NOTIFICATION_METHOD = "notifications/cancelled"
INITIALIZED_NOTIFICATION_METHOD = "notifications/initialized"


def start_stdin_pump() -> "queue.Queue[str | None]":
    """Drain stdin on a reader thread so cancellation notifications are seen
    while the dispatch thread is blocked inside a tool handler.

    Only ``notifications/cancelled`` is intercepted (id-less, no response per
    JSON-RPC); every other line is forwarded verbatim so the dispatch loop's
    parse/error behavior stays byte-identical. EOF forwards a ``None`` sentinel.
    """
    inbox: "queue.Queue[str | None]" = queue.Queue()

    def _pump() -> None:
        while True:
            line = sys.stdin.readline()
            if not line:
                inbox.put(None)
                return
            stripped = line.strip()
            if not stripped:
                continue
            if _intercept_cancellation(stripped):
                continue
            inbox.put(stripped)

    threading.Thread(target=_pump, name="builtin-stdin-pump", daemon=True).start()
    return inbox


def _intercept_cancellation(stripped: str) -> bool:
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict) or "id" in payload:
        return False
    method = payload.get("method")
    if method == INITIALIZED_NOTIFICATION_METHOD:
        return True
    if method != CANCEL_NOTIFICATION_METHOD:
        return False
    params = payload.get("params")
    request_id = params.get("requestId") if isinstance(params, dict) else None
    cancellation.cancel_request(request_id)
    return True


def install_termination_handler() -> None:
    # POSIX: owned commands run in their own sessions, so the transport's
    # group-level SIGTERM cannot reach them. Exiting via SystemExit lets the
    # owned-process service's atexit shutdown terminate every owned tree.
    # Windows delivers no SIGTERM (job close is an instant kill); the nested
    # job objects plus the taskkill backstop cover that path instead.
    if os.name == "nt":
        return
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
