"""Bounded stdout line reading and the reader-queue budget for stdio MCP transports."""

from __future__ import annotations

import sys
import threading
from typing import Any

from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME

# One JSON-RPC reply is one stdout line. The builtin server rides typed
# attachments inline (up to TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES decoded, ~4/3
# that once base64-encoded) next to the 16K-char model-visible output, so the
# reader's cap must stay above that or a three-page PDF read kills the server
# (2026-09-20: 3 x ~290KB page renders ended the transport with CMP-MCP-0004).
MCP_MAX_STDOUT_LINE_CHARS_BUILTIN = 4 * 1024 * 1024
# Third-party servers answer in one line too, and rea admits replies up to
# 10,484,736 B with no lower budget (row 53, owner decision 8).
MCP_MAX_STDOUT_LINE_CHARS_EXTERNAL = 16 * 1024 * 1024
# The reader queue holds 32 lines; without an aggregate bound, 16 MiB lines
# could park ~512 MiB in the sidecar, outside the child's memory limit. The
# budget is charged in bytes of Python string storage (``sys.getsizeof``), so
# non-BMP text costs its real four bytes per character, not one.
MCP_READER_QUEUE_MAX_BYTES = 32 * 1024 * 1024


def max_stdout_line_chars(server_name: str) -> int:
    if server_name == BUILTIN_MCP_SERVER_NAME:
        return MCP_MAX_STDOUT_LINE_CHARS_BUILTIN
    return MCP_MAX_STDOUT_LINE_CHARS_EXTERNAL


def _read_bounded_text_line(stream: Any, *, max_chars: int) -> str:
    """Read one text line without allowing ``TextIOWrapper`` to grow forever."""

    limit = max(1, int(max_chars))
    line = stream.readline(limit + 1)
    if not isinstance(line, str):
        raise RuntimeError("mcp stdio stream returned non-text data")
    if len(line) > limit or (len(line) == limit and not line.endswith("\n")):
        raise RuntimeError("mcp stdio line exceeded its configured limit")
    return line


class ReaderBudget:
    """Bytes of stdout text (string storage) queued for consumers but not yet taken.

    ``reserve`` waits while the line would push the total past the budget, so
    the reader stops draining the pipe and the server feels backpressure. A
    line larger than the whole budget is admitted only into an empty queue,
    which keeps a cap above the budget from wedging the reader.
    """

    def __init__(self, max_bytes: int) -> None:
        self._max_bytes = max(1, int(max_bytes))
        self._queued = 0
        self.peak = 0
        self._changed = threading.Condition()

    @staticmethod
    def cost(item: object) -> int:
        return sys.getsizeof(item) if isinstance(item, str) else 0

    def reserve(self, size: int, *, timeout: float) -> bool:
        with self._changed:
            if not self._changed.wait_for(
                lambda: self._queued == 0 or self._queued + size <= self._max_bytes,
                timeout=timeout,
            ):
                return False
            self._queued += size
            self.peak = max(self.peak, self._queued)
            return True

    def release(self, size: int) -> None:
        with self._changed:
            # Clamped: a line queued without a reservation must not go negative.
            self._queued = max(0, self._queued - size)
            self._changed.notify_all()

    def release_item(self, item: object) -> None:
        """Release a dequeued item's reservation; only text lines hold one."""
        if isinstance(item, str):
            self.release(self.cost(item))
