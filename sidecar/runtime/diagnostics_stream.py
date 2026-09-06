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
        self.failure_count = 0

    def emit(self, record: logging.LogRecord) -> None:
        try:
            line = f"{self.format(record)}\n"
            with self._lock:
                self._stream.write(line)
                self._stream.flush()
        except Exception:  # noqa: BLE001 - diagnostics transport is optional.
            self.failure_count += 1


class DiagnosticsFanoutHandler(logging.Handler):
    """Deliver to independent sinks so an optional mirror cannot block logging."""

    def __init__(self, *handlers: logging.Handler) -> None:
        super().__init__()
        self.handlers = tuple(handler for handler in handlers if handler is not None)

    def emit(self, record: logging.LogRecord) -> None:
        for handler in self.handlers:
            try:
                handler.handle(record)
            except Exception:  # noqa: BLE001 - each sink degrades independently.
                continue
