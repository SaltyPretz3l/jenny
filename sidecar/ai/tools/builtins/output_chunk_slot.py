"""Cross-thread live-output writer slot for the builtin server's active call.

Companion to :mod:`cancellation` (same per-call ambient-slot pattern, same
bootstrap-cost constraint: stdlib only). The builtin server registers a
notification writer when a ``tools/call`` begins; streaming-capable handlers
(``run_command``) fetch it via :func:`current_writer` and feed it batched,
sanitized output payloads. The writer is ``None`` for nested/uninstrumented
contexts, in which case handlers simply do not stream (W2-1).
"""

from __future__ import annotations

import threading
from typing import Callable

_lock = threading.Lock()
_writer: Callable[[dict[str, object]], None] | None = None


def begin_tool_call(writer: Callable[[dict[str, object]], None] | None) -> None:
    """Register the live-output writer for the in-flight call."""
    global _writer
    with _lock:
        _writer = writer


def end_tool_call() -> None:
    """Clear the slot once the in-flight call has produced its response."""
    global _writer
    with _lock:
        _writer = None


def current_writer() -> Callable[[dict[str, object]], None] | None:
    """Live-output writer of the in-flight tool call, if any."""
    with _lock:
        return _writer


__all__ = ["begin_tool_call", "current_writer", "end_tool_call"]
