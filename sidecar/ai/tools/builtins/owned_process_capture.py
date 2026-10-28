"""Bounded output capture for owned tool subprocesses.

Each stream gets a drain thread that counts every byte it reads but retains at
most its share of the aggregate capture budget; the captured bytes become one
immutable :class:`CapturedProcessOutput` once the drains have ended.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import IO, Callable

PIPE_READ_CHUNK_BYTES = 64 * 1024

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CapturedProcessOutput:
    stdout: str
    stderr: str
    stdout_bytes: int
    stderr_bytes: int
    stdout_captured_bytes: int
    stderr_captured_bytes: int

    @property
    def captured_bytes(self) -> int:
        return self.stdout_captured_bytes + self.stderr_captured_bytes

    @property
    def total_bytes(self) -> int:
        return self.stdout_bytes + self.stderr_bytes

    @property
    def discarded_bytes(self) -> int:
        return max(0, self.total_bytes - self.captured_bytes)

    @property
    def truncated(self) -> bool:
        return self.discarded_bytes > 0

    def counters(self) -> dict[str, int]:
        return {
            "stdout_bytes": self.stdout_bytes,
            "stderr_bytes": self.stderr_bytes,
            "captured_bytes": self.captured_bytes,
            "discarded_bytes": self.discarded_bytes,
        }


@dataclass
class StreamCapture:
    limit_bytes: int
    data: bytearray = field(default_factory=bytearray)
    total_bytes: int = 0
    read_error: str = ""

    def append(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        remaining = max(0, self.limit_bytes - len(self.data))
        if remaining:
            self.data.extend(chunk[:remaining])


def captured_output_with_diagnostics(
    *,
    already_incomplete: bool,
    stdout_capture: StreamCapture,
    stderr_capture: StreamCapture,
) -> tuple[CapturedProcessOutput, bool, dict[str, str]]:
    read_error_types = {
        stream_name: capture.read_error
        for stream_name, capture in (
            ("stdout", stdout_capture),
            ("stderr", stderr_capture),
        )
        if capture.read_error
    }
    output = CapturedProcessOutput(
        stdout=bytes(stdout_capture.data).decode("utf-8", errors="replace"),
        stderr=bytes(stderr_capture.data).decode("utf-8", errors="replace"),
        stdout_bytes=stdout_capture.total_bytes,
        stderr_bytes=stderr_capture.total_bytes,
        stdout_captured_bytes=len(stdout_capture.data),
        stderr_captured_bytes=len(stderr_capture.data),
    )
    return output, already_incomplete or bool(read_error_types), read_error_types


def start_output_reader(
    pipe: IO[bytes],
    capture: StreamCapture,
    stream_name: str,
    *,
    on_chunk: Callable[[str, bytes], None] | None = None,
) -> threading.Thread:
    def _read() -> None:
        try:
            while True:
                chunk = pipe.read(PIPE_READ_CHUNK_BYTES)
                if not chunk:
                    return
                capture.append(chunk)
                if on_chunk is not None:
                    # Live-output tap (W2-1). The callback owns batching,
                    # throttling, and drops — it must never block or raise;
                    # a broken tap must not stall or kill the drain.
                    try:
                        on_chunk(stream_name, chunk)
                    except Exception:  # noqa: BLE001
                        logger.debug(
                            "owned process output tap failed",
                            extra={"stream": stream_name},
                        )
        except (OSError, ValueError) as error:
            capture.read_error = type(error).__name__
            logger.debug(
                "owned process pipe drain ended after pipe closure",
                extra={"stream": stream_name, "error_type": type(error).__name__},
            )

    thread = threading.Thread(
        target=_read,
        daemon=True,
        name=f"owned-process-{stream_name}",
    )
    thread.start()
    return thread


__all__ = [
    "PIPE_READ_CHUNK_BYTES",
    "CapturedProcessOutput",
    "StreamCapture",
    "captured_output_with_diagnostics",
    "start_output_reader",
]
