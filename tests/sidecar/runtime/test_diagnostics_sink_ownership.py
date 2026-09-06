"""W2-31-F07: timed-out diagnostics shutdown must be single-owner.

While the listener thread is still draining, the main thread must not write
final stages through the listener's sink or close it out from under the
thread; the handler must reject post-close emits instead of lazily reopening
the stream (which leaked the reopened fd across reconfigures).
"""

from __future__ import annotations

import logging
import threading
import time

import pytest

import sidecar.runtime.diagnostics as _diag_module
from sidecar.runtime.diagnostics import (
    NdjsonRollingFileHandler,
    configure_sidecar_logging,
    shutdown_sidecar_logging,
)
from sidecar.runtime.diagnostics_queue import (
    BoundedDiagnosticsListener,
    BoundedDiagnosticsQueue,
)


def _record(message: str = "hello") -> logging.LogRecord:
    return logging.getLogger("tests.sidecar.sink_ownership").makeRecord(
        "tests.sidecar.sink_ownership",
        logging.INFO,
        __file__,
        0,
        message,
        (),
        None,
    )


def test_post_close_emit_is_rejected_not_reopened(tmp_path) -> None:
    handler = NdjsonRollingFileHandler(tmp_path / "sidecar.log")
    handler.emit(_record("before close"))
    handler.close()

    handler.emit(_record("after close"))

    assert handler._stream is None  # noqa: SLF001 - the leak under test
    lines = (tmp_path / "sidecar.log").read_text("utf-8").strip().splitlines()
    assert len(lines) == 1


def test_transfer_sink_close_hands_disposal_to_the_live_listener() -> None:
    inside_sink = threading.Event()
    release_sink = threading.Event()

    class BlockingSink(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            inside_sink.set()
            release_sink.wait(5.0)

    queue = BoundedDiagnosticsQueue()
    listener = BoundedDiagnosticsListener(queue, BlockingSink())
    listener.start()
    queue.enqueue(_record())
    assert inside_sink.wait(5.0)

    result = listener.stop(timeout_seconds=0.05)
    assert result["timed_out"] is True

    closes: list[int] = []
    assert listener.transfer_sink_close(lambda: closes.append(1)) is True

    release_sink.set()
    listener._thread.join(5.0)  # noqa: SLF001 - deterministic wait for the finally
    assert closes == [1]


def test_transfer_sink_close_refuses_when_the_listener_already_exited() -> None:
    queue = BoundedDiagnosticsQueue()
    listener = BoundedDiagnosticsListener(queue, logging.NullHandler())
    listener.start()
    listener.stop(timeout_seconds=5.0)

    assert listener.transfer_sink_close(lambda: None) is False


def test_timed_out_shutdown_reports_stages_to_stderr_not_the_contended_sink(
    tmp_path, monkeypatch, capsys
) -> None:
    configure_sidecar_logging(tmp_path / "logs" / "sidecar.log")
    state = _diag_module._STATE  # noqa: SLF001
    assert state is not None
    real_stop = state.listener.stop
    monkeypatch.setattr(
        state.listener,
        "stop",
        lambda timeout_seconds=2.0: {"drained": False, "timed_out": True, "discarded": 3},
    )
    sink_calls: list[logging.LogRecord] = []
    monkeypatch.setattr(state.sink_handler, "handle", sink_calls.append)

    shutdown_sidecar_logging(shutdown_started_at=time.perf_counter())

    assert sink_calls == []
    err = capsys.readouterr().err
    assert "diagnostics_flush" in err
    assert "total" in err
    real_stop(timeout_seconds=2.0)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
