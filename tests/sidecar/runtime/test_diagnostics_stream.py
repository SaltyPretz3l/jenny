from __future__ import annotations

import io
import logging

from sidecar.runtime.diagnostics_stream import DiagnosticsFanoutHandler, DiagnosticsStreamHandler


def test_stream_handler_writes_one_line_and_contains_failures() -> None:
    stream = io.StringIO()
    handler = DiagnosticsStreamHandler(logging.Formatter("%(message)s"), stream)
    record = logging.LogRecord("test", logging.INFO, "", 0, "hello", (), None)
    handler.handle(record)
    assert stream.getvalue() == "hello\n"

    class BrokenStream:
        def write(self, _value: str) -> None:
            raise OSError("closed")

        def flush(self) -> None:
            raise OSError("closed")

    broken = DiagnosticsStreamHandler(logging.Formatter("%(message)s"), BrokenStream())
    broken.handle(record)
    assert broken.failure_count == 1


def test_stream_handler_preserves_an_explicit_falsey_stream() -> None:
    class FalseyStream(io.StringIO):
        def __bool__(self) -> bool:
            return False

    stream = FalseyStream()
    handler = DiagnosticsStreamHandler(logging.Formatter("%(message)s"), stream)
    handler.handle(logging.LogRecord("test", logging.INFO, "", 0, "kept", (), None))
    assert stream.getvalue() == "kept\n"


def test_fanout_keeps_later_sink_alive_when_one_sink_throws() -> None:
    seen: list[str] = []

    class BrokenHandler(logging.Handler):
        def emit(self, _record: logging.LogRecord) -> None:
            raise RuntimeError("broken")

    class HealthyHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            seen.append(record.getMessage())

    fanout = DiagnosticsFanoutHandler(BrokenHandler(), HealthyHandler())
    fanout.handle(logging.LogRecord("test", logging.INFO, "", 0, "safe", (), None))
    assert seen == ["safe"]
