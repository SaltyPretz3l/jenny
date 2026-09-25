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
from typing import TextIO

from sidecar.ai.tools.builtins import cancellation
from sidecar.runtime.pipe_stdin import GatedPipeReader, gated_stdin

CANCEL_NOTIFICATION_METHOD = "notifications/cancelled"
INITIALIZED_NOTIFICATION_METHOD = "notifications/initialized"

_PROTOCOL_STDOUT: TextIO | None = None
_CONFIGURED_STDOUT: TextIO | None = None


def _fileno(stream: object) -> int | None:
    try:
        value = stream.fileno()  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        return None
    return value if isinstance(value, int) and value >= 0 else None


def configure_stdio() -> None:
    """Pin UTF-8 and reserve the original stdout exclusively for protocol frames."""
    global _CONFIGURED_STDOUT, _PROTOCOL_STDOUT  # noqa: PLW0603

    for stream, errors in ((sys.stdin, "strict"), (sys.stdout, "strict"),
                           (sys.stderr, "backslashreplace")):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors=errors)

    if sys.stdout is _CONFIGURED_STDOUT:
        return
    _PROTOCOL_STDOUT = sys.stdout
    stdin_fd = _fileno(sys.stdin)
    stdout_fd = _fileno(sys.stdout)
    stderr_fd = _fileno(sys.stderr)
    if stdin_fd is None or stdout_fd is None or stderr_fd is None or stdout_fd == stderr_fd:
        _CONFIGURED_STDOUT = sys.stdout
        return

    sys.stdout.flush()
    sys.stderr.flush()
    protocol_fd = os.dup(stdout_fd)
    os.set_inheritable(protocol_fd, False)
    _PROTOCOL_STDOUT = os.fdopen(
        protocol_fd,
        "w",
        buffering=1,
        encoding="utf-8",
        errors="strict",
        newline="\n",
    )
    os.dup2(stderr_fd, stdout_fd)
    _CONFIGURED_STDOUT = sys.stdout


def write_protocol_line(line: str) -> None:
    wire = sys.stdout
    if _PROTOCOL_STDOUT is not None and sys.stdout is _CONFIGURED_STDOUT:
        wire = _PROTOCOL_STDOUT
    wire.write(line)
    wire.flush()


def start_stdin_pump() -> "queue.Queue[str | None]":
    """Drain stdin on a reader thread so cancellation notifications are seen
    while the dispatch thread is blocked inside a tool handler.

    Only ``notifications/cancelled`` is intercepted (id-less, no response per
    JSON-RPC); every other line is forwarded verbatim so the dispatch loop's
    parse/error behavior stays byte-identical. EOF forwards a ``None`` sentinel.
    """
    inbox: "queue.Queue[str | None]" = queue.Queue()
    # On a Windows pipe, read through the gate so the idle wait never leaves a
    # ReadFile pending on stdin: numpy's OpenBLAS queries that handle while it
    # loads and would otherwise block until the next request line arrived.
    gated = gated_stdin(getattr(sys.stdin, "buffer", None))
    reader = gated if isinstance(gated, GatedPipeReader) else None

    def _pump() -> None:
        # The sentinel is delivered on every exit, including a reader error:
        # a dead pump must end the dispatch loop, not leave it waiting forever.
        try:
            _pump_lines()
        except Exception as error:  # noqa: BLE001 - reported, then the loop ends.
            sys.stderr.write(f"builtin stdin pump failed: {type(error).__name__}\n")
        finally:
            inbox.put(None)

    def _pump_lines() -> None:
        while True:
            if reader is None:
                line = sys.stdin.readline()
            else:
                line = reader.readline().decode("utf-8")
            if not line:
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
    except (json.JSONDecodeError, RecursionError):
        # Not a cancellation; the dispatch loop answers malformed input.
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
