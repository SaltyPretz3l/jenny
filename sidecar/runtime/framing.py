"""Content-Length framing helpers for stdin/stdout JSON-RPC messages."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any, BinaryIO

DEFAULT_MAX_HEADER_LINE_BYTES = 8 * 1024
DEFAULT_MAX_HEADER_COUNT = 32
DEFAULT_MAX_TOTAL_HEADER_BYTES = 64 * 1024


class TransportDesynchronizedError(ValueError):
    """Framing failed before the declared body was consumed; transport is terminal."""


class RecoverablePayloadError(ValueError):
    """A complete frame body was consumed but its JSON payload was invalid."""


class _NonFiniteJsonConstantError(ValueError):
    pass


@dataclass(frozen=True)
class _HeaderReadLimits:
    line_bytes: int
    count: int
    total_bytes: int


def _header_read_limits(
    *,
    max_header_line_bytes: int,
    max_header_count: int,
    max_total_header_bytes: int,
) -> _HeaderReadLimits:
    return _HeaderReadLimits(
        line_bytes=max(int(max_header_line_bytes), 1),
        count=max(int(max_header_count), 1),
        total_bytes=max(int(max_total_header_bytes), 1),
    )


def _read_header_line(stdin_buffer: BinaryIO, limits: _HeaderReadLimits) -> bytes:
    line = stdin_buffer.readline(limits.line_bytes + 1)
    if not line:
        raise EOFError("stdin closed")
    if len(line) > limits.line_bytes or not line.endswith(b"\n"):
        raise TransportDesynchronizedError(
            f"header line too large (max={limits.line_bytes} bytes)"
        )
    return line


def _decode_header_line(line: bytes) -> str:
    try:
        return line.decode("utf-8").rstrip("\r\n")
    except UnicodeDecodeError as error:
        raise TransportDesynchronizedError("header line contains invalid UTF-8") from error


def _read_headers(stdin_buffer: BinaryIO, limits: _HeaderReadLimits) -> dict[str, str]:
    headers: dict[str, str] = {}
    header_count = 0
    total_header_bytes = 0
    while True:
        line = _read_header_line(stdin_buffer, limits)
        total_header_bytes += len(line)
        if total_header_bytes > limits.total_bytes:
            raise TransportDesynchronizedError(
                f"headers too large (max={limits.total_bytes} bytes)"
            )
        decoded = _decode_header_line(line)
        if not decoded:
            return headers
        header_count += 1
        if header_count > limits.count:
            raise TransportDesynchronizedError(f"too many headers (max={limits.count})")
        key, _, value = decoded.partition(": ")
        headers[key] = value


def read_framed_message(  # noqa: PLR0913 - keyword caps keep the framing API explicit.
    *,
    stdin_buffer: BinaryIO,
    content_length_header: str,
    max_content_length_bytes: int,
    max_header_line_bytes: int = DEFAULT_MAX_HEADER_LINE_BYTES,
    max_header_count: int = DEFAULT_MAX_HEADER_COUNT,
    max_total_header_bytes: int = DEFAULT_MAX_TOTAL_HEADER_BYTES,
) -> dict[str, Any]:
    headers = _read_headers(
        stdin_buffer,
        _header_read_limits(
            max_header_line_bytes=max_header_line_bytes,
            max_header_count=max_header_count,
            max_total_header_bytes=max_total_header_bytes,
        ),
    )

    if content_length_header not in headers:
        raise TransportDesynchronizedError("missing Content-Length header")

    try:
        length = int(headers[content_length_header])
    except (ValueError, TypeError) as error:
        raise TransportDesynchronizedError("invalid Content-Length header") from error

    if length < 0 or length > max_content_length_bytes:
        raise TransportDesynchronizedError(
            f"Content-Length out of range: {length} (max={max_content_length_bytes})"
        )

    payload_bytes = stdin_buffer.read(length)
    if len(payload_bytes) != length:
        raise EOFError(f"incomplete payload body: expected {length}, got {len(payload_bytes)}")

    try:
        payload = payload_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RecoverablePayloadError("payload body contains invalid UTF-8") from error

    try:
        message = json.loads(payload, parse_constant=_reject_nonfinite_constant)
    except json.JSONDecodeError as error:
        raise RecoverablePayloadError(
            f"payload is not valid JSON: {error.msg} at position {error.pos}"
        ) from error
    except _NonFiniteJsonConstantError as error:
        raise RecoverablePayloadError(str(error)) from error
    except RecursionError as error:
        # Nesting deeper than the interpreter's recursion budget. RecursionError
        # derives from RuntimeError, not ValueError, so it needs its own arm.
        raise RecoverablePayloadError("payload nesting is too deep to decode") from error
    except ValueError as error:
        # Everything else json.loads rejects that is NOT a JSONDecodeError —
        # notably int_max_str_digits on an absurd integer literal. MUST stay
        # last: JSONDecodeError and _NonFiniteJsonConstantError are both
        # ValueError subclasses and carry better messages above.
        #
        # The body is fully consumed by this point, so EVERY decode failure is
        # recoverable by construction: the stream is still frame-aligned and the
        # next frame parses. Letting one escape raw would instead reach
        # message_reader._pump's `except BaseException`, which caches it as
        # _terminal_error and kills the stdin pump for the life of the process.
        raise RecoverablePayloadError(f"payload could not be decoded: {error}") from error

    if not isinstance(message, dict):
        raise RecoverablePayloadError(f"expected JSON object, got {type(message).__name__}")
    return message


def _reject_nonfinite_constant(value: str) -> None:
    raise _NonFiniteJsonConstantError(f"payload contains non-finite JSON number: {value}")


def _repair_nonfinite(value: Any) -> Any:
    """Recursively replace non-finite floats with None (bool-safe: bool is an
    int subclass and is returned unchanged, never mistaken for a float)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        # Keys too: json.dumps(allow_nan=False) also rejects a non-finite
        # FLOAT key, which would escape encode_framed_body as an uncaught
        # ValueError after this repair pass. None serializes as "null".
        return {
            _repair_nonfinite(key) if isinstance(key, float) else key: _repair_nonfinite(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_repair_nonfinite(item) for item in value]
    return value


def encode_framed_body(message: dict[str, Any]) -> bytes:
    """Encode the exact wire body bytes for a framed message.

    Single source of truth for the on-wire encoding so backpressure accounting
    (multiplexer.enqueue) can measure the real frame size instead of a different
    encoding that over-counts non-ASCII payloads.
    """
    # CTL-011: the boundary must never emit NaN/Infinity/-Infinity tokens —
    # JavaScript's JSON.parse rejects them. Try strict first (the common
    # case pays no extra cost); repair only the rare non-finite payload.
    try:
        raw = json.dumps(message, ensure_ascii=False, allow_nan=False)
    except ValueError:
        raw = json.dumps(_repair_nonfinite(message), ensure_ascii=False, allow_nan=False)
    # Two-step encode: surrogatepass avoids the crash, then round-trip
    # through replace guarantees the result is valid UTF-8.
    body = raw.encode("utf-8", errors="surrogatepass")
    return body.decode("utf-8", errors="replace").encode("utf-8")


def write_framed_body(
    *,
    stdout_buffer: BinaryIO,
    content_length_header: str,
    body: bytes,
) -> None:
    """Write one pre-encoded frame as a single header+body write."""
    header = f"{content_length_header}: {len(body)}\r\n\r\n".encode("utf-8")
    stdout_buffer.write(header + body)
    stdout_buffer.flush()


def write_framed_message(
    *,
    stdout_buffer: BinaryIO,
    content_length_header: str,
    message: dict[str, Any],
) -> None:
    write_framed_body(
        stdout_buffer=stdout_buffer,
        content_length_header=content_length_header,
        body=encode_framed_body(message),
    )
