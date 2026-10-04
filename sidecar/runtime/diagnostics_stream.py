"""Best-effort managed-sidecar diagnostics mirroring to stderr."""

from __future__ import annotations

import logging
import sys
import threading
from typing import TextIO


class DiagnosticsStreamHandler(logging.Handler):
    """Write already-formatted NDJSON without ever failing the file sink."""

    def __init__(self, formatter: logging.Formatter, stream: TextIO | None = None) -> None:
        super().__init__()
        self.setFormatter(formatter)
        self._stream = stream if stream is not None else sys.stderr
        self._lock = threading.Lock()
        self._failure_count = 0

    @property
    def failure_count(self) -> int:
        with self._lock:
            return self._failure_count

    def emit(self, record: logging.LogRecord) -> None:
        try:
            line = f"{self.format(record)}\n"
            with self._lock:
                self._stream.write(line)
                self._stream.flush()
        except Exception:  # noqa: BLE001 - diagnostics transport is optional.
            with self._lock:
                self._failure_count += 1


class DiagnosticsFanoutHandler(logging.Handler):
    """Deliver to independent sinks so an optional mirror cannot block logging."""

    def __init__(self, *handlers: logging.Handler) -> None:
        super().__init__()
        self.handlers = tuple(handler for handler in handlers if handler is not None)
        # Configuration supplies file first, then the optional stderr mirror.
        self._failure_lock = threading.Lock()
        self._thrown_failures = [0 for _handler in self.handlers]
        self._reported_failures = [0 for _handler in self.handlers]

    def emit(self, record: logging.LogRecord) -> None:
        for index, handler in enumerate(self.handlers):
            try:
                handler.handle(record)
            except Exception:  # noqa: BLE001 - each sink degrades independently.
                with self._failure_lock:
                    self._thrown_failures[index] += 1

    def take_failure_deltas(self) -> dict[str, int]:
        """Collect newly failed deliveries, including errors absorbed by sinks."""
        deltas: dict[str, int] = {}
        with self._failure_lock:
            for index, (name, handler) in enumerate(
                zip(("file", "mirror"), self.handlers, strict=False)
            ):
                total = getattr(handler, "failure_count", 0) + self._thrown_failures[index]
                delta = total - self._reported_failures[index]
                self._reported_failures[index] = total
                if delta > 0:
                    deltas[name] = delta
        return deltas
