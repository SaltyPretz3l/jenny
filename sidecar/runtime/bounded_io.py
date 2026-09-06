"""Small bounded-I/O primitives for long-lived transport seams.

The helpers in this module enforce limits while bytes arrive.  Callers remain
responsible for closing their response or owned process when a limit is hit so
a stalled producer cannot retain a pipe indefinitely.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from typing import BinaryIO

DEFAULT_READ_CHUNK_BYTES = 64 * 1024


class BoundedIOError(RuntimeError):
    """Raised before a transport would exceed its declared byte budget."""


class BoundedBinaryReader:
    """Incrementally frame lines and exact bodies without unbounded reads."""

    def __init__(
        self,
        stream: BinaryIO,
        *,
        read_chunk_bytes: int = DEFAULT_READ_CHUNK_BYTES,
    ) -> None:
        self._stream = stream
        self._read_chunk_bytes = max(1, int(read_chunk_bytes))
        self._buffer = bytearray()

    def read_line(self, *, max_bytes: int) -> bytes:
        limit = max(1, int(max_bytes))
        while True:
            newline_at = self._buffer.find(b"\n")
            if newline_at >= 0:
                line_size = newline_at + 1
                if line_size > limit:
                    raise BoundedIOError("stream line exceeds configured byte limit")
                line = bytes(self._buffer[:line_size])
                del self._buffer[:line_size]
                return line
            if len(self._buffer) > limit:
                raise BoundedIOError("stream line exceeds configured byte limit")
            read_available = getattr(self._stream, "read1", self._stream.read)
            chunk = read_available(
                min(self._read_chunk_bytes, limit + 1 - len(self._buffer))
            )
            if not chunk:
                if not self._buffer:
                    return b""
                line = bytes(self._buffer)
                self._buffer.clear()
                return line
            if not isinstance(chunk, bytes):
                raise BoundedIOError("binary stream returned non-byte data")
            self._buffer.extend(chunk)

    def read_exact(self, size: int) -> bytes:
        expected = max(0, int(size))
        chunks = bytearray()
        if self._buffer:
            take = min(expected, len(self._buffer))
            chunks.extend(self._buffer[:take])
            del self._buffer[:take]
        while len(chunks) < expected:
            chunk = self._stream.read(
                min(self._read_chunk_bytes, expected - len(chunks))
            )
            if not chunk:
                break
            if not isinstance(chunk, bytes):
                raise BoundedIOError("binary stream returned non-byte data")
            chunks.extend(chunk)
        return bytes(chunks)


def iter_bounded_byte_lines(
    chunks: Iterable[bytes],
    *,
    max_line_bytes: int,
    max_total_bytes: int,
) -> Iterator[bytes]:
    """Yield newline-delimited records while enforcing line and total caps."""

    line_limit = max(1, int(max_line_bytes))
    total_limit = max(1, int(max_total_bytes))
    pending = bytearray()
    total = 0
    for chunk in chunks:
        if not isinstance(chunk, bytes):
            raise BoundedIOError("stream chunk was not bytes")
        total += len(chunk)
        if total > total_limit:
            raise BoundedIOError("stream exceeds configured total byte limit")
        pending.extend(chunk)
        while True:
            newline_at = pending.find(b"\n")
            if newline_at < 0:
                if len(pending) > line_limit:
                    raise BoundedIOError("stream line exceeds configured byte limit")
                break
            line_size = newline_at + 1
            if line_size > line_limit:
                raise BoundedIOError("stream line exceeds configured byte limit")
            yield bytes(pending[:line_size])
            del pending[:line_size]
    if pending:
        if len(pending) > line_limit:
            raise BoundedIOError("stream line exceeds configured byte limit")
        yield bytes(pending)


def read_bounded_bytes(
    stream: BinaryIO,
    *,
    max_bytes: int,
    read_chunk_bytes: int = DEFAULT_READ_CHUNK_BYTES,
) -> bytes:
    """Read at most ``max_bytes`` and reject one additional producer byte."""

    limit = max(1, int(max_bytes))
    chunk_size = max(1, int(read_chunk_bytes))
    chunks: list[bytes] = []
    total = 0
    while total <= limit:
        chunk = stream.read(min(chunk_size, limit + 1 - total))
        if not chunk:
            break
        if not isinstance(chunk, bytes):
            raise BoundedIOError("binary stream returned non-byte data")
        chunks.append(chunk)
        total += len(chunk)
    if total > limit:
        raise BoundedIOError("stream exceeds configured byte limit")
    return b"".join(chunks)


__all__ = [
    "BoundedBinaryReader",
    "BoundedIOError",
    "DEFAULT_READ_CHUNK_BYTES",
    "iter_bounded_byte_lines",
    "read_bounded_bytes",
]
