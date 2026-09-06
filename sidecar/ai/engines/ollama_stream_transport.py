"""Bounded, cancellation-aware record framing for Ollama streams."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Any

from sidecar.ai.engines.http_utils import register_cancel_callback
from sidecar.runtime.bounded_io import BoundedIOError, iter_bounded_byte_lines

logger = logging.getLogger(__name__)

MAX_PROVIDER_STREAM_LINE_BYTES = 1024 * 1024
MAX_PROVIDER_STREAM_TOTAL_BYTES = 32 * 1024 * 1024
PROVIDER_STREAM_READ_CHUNK_BYTES = 64 * 1024


def raise_if_cancelled(cancel_handle: Any) -> None:
    if cancel_handle is None:
        return
    raise_method = getattr(cancel_handle, "raise_if_cancelled", None)
    if callable(raise_method):
        raise_method()


def register_response_cancel_callback(cancel_handle: Any, response: Any) -> Any:
    def close_response() -> None:
        close = getattr(response, "close", None)
        if callable(close):
            close()

    return register_cancel_callback(cancel_handle, close_response)


def iter_bounded_response_lines(response: Any) -> Iterator[bytes]:
    # HTTPResponse.read(amt) aggregates chunked-transfer frames until ``amt``
    # bytes or EOF. Ollama's progress records are much smaller than our 64 KiB
    # transport chunk, so using read() can hide otherwise timely NDJSON updates
    # behind minutes of buffering. read1() performs at most one underlying read
    # and therefore preserves the provider's streaming cadence while the shared
    # byte/line bounds below still fail closed.
    read = getattr(response, "read1", None)
    if not callable(read):
        read = getattr(response, "read", None)
    if callable(read):

        def chunks() -> Iterator[bytes]:
            while True:
                chunk = read(PROVIDER_STREAM_READ_CHUNK_BYTES)
                if not chunk:
                    return
                yield chunk

        byte_chunks = chunks()
    else:
        byte_chunks = (
            raw_line if raw_line.endswith(b"\n") else raw_line + b"\n"
            for raw_line in response
        )
    try:
        yield from iter_bounded_byte_lines(
            byte_chunks,
            max_line_bytes=MAX_PROVIDER_STREAM_LINE_BYTES,
            max_total_bytes=MAX_PROVIDER_STREAM_TOTAL_BYTES,
        )
    except BoundedIOError:
        logger.warning(
            "Ollama stream exceeded its bounded transport contract.",
            extra={
                "event": "ai.engines.ollama.stream_bounded",
                "max_line_bytes": MAX_PROVIDER_STREAM_LINE_BYTES,
                "max_total_bytes": MAX_PROVIDER_STREAM_TOTAL_BYTES,
            },
        )
        raise


def iter_cancel_aware_response_lines(
    response: Any,
    cancel_handle: Any,
) -> Iterator[bytes]:
    unregister_cancel = register_response_cancel_callback(cancel_handle, response)
    try:
        raise_if_cancelled(cancel_handle)
        for line in iter_bounded_response_lines(response):
            raise_if_cancelled(cancel_handle)
            yield line
    finally:
        unregister_cancel()


__all__ = [
    "iter_bounded_response_lines",
    "iter_cancel_aware_response_lines",
    "raise_if_cancelled",
    "register_response_cancel_callback",
]
