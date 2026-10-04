from __future__ import annotations

import io
import json
import logging
from pathlib import Path

import pytest

from sidecar.runtime import diagnostics
from sidecar.runtime.diagnostics import (
    ContextQueueHandler,
    NdjsonRollingFileHandler,
    StructuredLogFormatter,
    log_tool_execution,
)
from sidecar.runtime.diagnostics_queue import BoundedDiagnosticsListener, BoundedDiagnosticsQueue
from sidecar.runtime.diagnostics_stream import DiagnosticsFanoutHandler, DiagnosticsStreamHandler


def _record(message="accepted"):
    return logging.LogRecord("test", logging.INFO, "", 0, message, (), None)


def _fail(*_args):
    raise OSError("sink unavailable")


@pytest.mark.parametrize("failure_point", ["format", "mkdir", "open", "write", "flush", "rotation"])
def test_file_failure_never_prints_original_record(tmp_path, monkeypatch, capsys, failure_point):
    assert logging.raiseExceptions is True
    handler = NdjsonRollingFileHandler(tmp_path / "sidecar.log")
    if failure_point == "format":
        monkeypatch.setattr(handler._formatter, "format", _fail)
    elif failure_point == "mkdir":
        monkeypatch.setattr(Path, "mkdir", _fail)
    elif failure_point == "open":
        monkeypatch.setattr(handler, "_ensure_stream", _fail)
    elif failure_point == "rotation":
        monkeypatch.setattr(handler, "_rotate_if_needed", _fail)
    else:
        stream = io.StringIO()
        monkeypatch.setattr(stream, failure_point, _fail)
        monkeypatch.setattr(handler, "_ensure_stream", lambda: stream)
    try:
        handler.emit(_record("token=sk-test-SYNTHETIC123"))
        stderr = capsys.readouterr().err
        assert "sk-test-SYNTHETIC123" not in stderr
        assert stderr == ""
        assert handler.failure_count == 1
    finally:
        monkeypatch.undo()
        handler.close()


def test_blocked_rotation_retries_by_time_at_ceiling(tmp_path, monkeypatch):
    path = tmp_path / "sidecar.log"
    monkeypatch.setattr(diagnostics, "SEGMENT_MAX_BYTES", 1024)
    monkeypatch.setattr(diagnostics, "ROTATION_RETRY_BYTES", 100_000)
    now = [0.0]
    handler = NdjsonRollingFileHandler(path)
    # Assign the injectable clock after construction so RED exercises the old lifecycle.
    handler._clock = lambda: now[0]
    rename = Path.rename
    attempts = []

    def blocked_rename(source, target):
        attempts.append(source)
        raise PermissionError("blocked")

    monkeypatch.setattr(Path, "rename", blocked_rename)
    try:
        for _ in range(30):
            handler.emit(_record("before"))
        assert len(attempts) == 1
        size = path.stat().st_size
        handler.emit(_record("dropped"))
        assert path.stat().st_size == size
        assert size <= 1024 * diagnostics.BLOCKED_ROTATION_SEGMENT_MULTIPLE
        monkeypatch.setattr(Path, "rename", rename)
        now[0] += 6.0
        handler.emit(_record("recovered"))
        assert path.with_name("sidecar.log.1").exists()
        active = [json.loads(line) for line in path.read_text("utf-8").splitlines()]
        assert [entry["message"] for entry in active] == ["recovered"]
        assert handler.failure_count > 0
        assert handler._rotation_retry_bytes == 0
    finally:
        handler.close()


def test_file_failure_is_mirrored_and_reported_as_sink_loss(tmp_path, monkeypatch):
    file_sink = NdjsonRollingFileHandler(tmp_path / "sidecar.log")
    monkeypatch.setattr(file_sink, "_ensure_stream", _fail)
    stream = io.StringIO()
    mirror = DiagnosticsStreamHandler(StructuredLogFormatter(), stream)
    fanout = DiagnosticsFanoutHandler(file_sink, mirror)
    queue = BoundedDiagnosticsQueue()
    listener = BoundedDiagnosticsListener(queue, fanout)
    try:
        queue.enqueue(_record())
        listener.start()
        assert listener.stop(timeout_seconds=1)["drained"] is True
        entries = [json.loads(line) for line in stream.getvalue().splitlines()]
        assert entries[0]["message"] == "accepted"
        losses = [entry for entry in entries if entry["event"] == "sidecar.runtime.diagnostics_queue_dropped"]
        assert losses
        assert losses[0]["data"]["sink_failures"]["file"] >= 1
        assert losses[0]["data"]["dropped_count"] == 0
        assert losses[0]["data"]["dropped_by_level"] == {}
        # Failed loss writes are deferred to another snapshot, never recursively emitted.
        assert len(entries) <= 4
    finally:
        monkeypatch.undo()
        file_sink.close()


def test_mirror_failure_deltas_and_queue_losses_are_independent(tmp_path, monkeypatch):
    file_sink = NdjsonRollingFileHandler(tmp_path / "sidecar.log")
    mirror = DiagnosticsStreamHandler(StructuredLogFormatter(), io.StringIO())
    monkeypatch.setattr(mirror._stream, "write", _fail)
    fanout = DiagnosticsFanoutHandler(file_sink, mirror)
    queue = BoundedDiagnosticsQueue(capacity=2, severe_reserve=0)
    listener = BoundedDiagnosticsListener(queue, fanout)
    try:
        queue.enqueue(_record("one"))
        queue.enqueue(_record("two"))
        queue.enqueue(_record("queue drop"))
        record = queue.get()
        assert record is not None
        listener._handle_direct(record)
        assert listener.emit_pending_loss() is True
        entries = [json.loads(line) for line in (tmp_path / "sidecar.log").read_text("utf-8").splitlines()]
        assert entries[0]["message"] == "one"
        data = entries[1]["data"]
        assert data["sink_failures"] == {"mirror": 1}
        assert data["dropped_count"] == 1
        assert data["dropped_by_level"] == {"INFO": 1}
        assert mirror.failure_count == 2
        # The loss notice's own mirror failure is consumed, never re-reported as a lost record.
        assert fanout.take_failure_deltas() == {}
    finally:
        file_sink.close()


def test_permanent_sink_failure_reports_coalesced_loss_records(tmp_path, monkeypatch):
    file_sink = NdjsonRollingFileHandler(tmp_path / "sidecar.log")
    monkeypatch.setattr(file_sink, "_ensure_stream", lambda: (_ for _ in ()).throw(OSError("disk")))
    stream = io.StringIO()
    mirror = DiagnosticsStreamHandler(StructuredLogFormatter(), stream)
    queue = BoundedDiagnosticsQueue()
    listener = BoundedDiagnosticsListener(queue, DiagnosticsFanoutHandler(file_sink, mirror))
    try:
        for index in range(10):
            listener._handle_direct(_record(f"record {index}"))
            listener.emit_pending_loss()
        lines = [json.loads(line) for line in stream.getvalue().splitlines()]
        loss = [line for line in lines if line["event"] == "sidecar.runtime.diagnostics_queue_dropped"]
        assert len(lines) - len(loss) == 10
        assert len(loss) == 1
        assert loss[0]["data"]["sink_failures"] == {"file": 1}
        listener.emit_pending_loss(force=True)
        final = [json.loads(line) for line in stream.getvalue().splitlines()][-1]
        assert final["data"]["sink_failures"] == {"file": 9}
    finally:
        file_sink.close()


@pytest.mark.parametrize("capture_mode", ["redacted", "sanitized_snippets"])
def test_tool_arguments_are_metadata_only(caplog, monkeypatch, capture_mode):
    monkeypatch.setattr(diagnostics, "_CAPTURE_MODE", capture_mode)
    arguments = {"command": "rm -rf SENTINEL_PRIVATE", "content": "SENTINEL_PRIVATE"}
    logger = logging.getLogger("tests.sidecar.tool_argument_projection")
    with caplog.at_level(logging.DEBUG, logger=logger.name):
        log_tool_execution(logger, tool_name="write_file", arguments=arguments)
    serialized = StructuredLogFormatter().format(caplog.records[-1])
    assert "SENTINEL_PRIVATE" not in serialized
    projection = json.loads(serialized)["data"]["arguments"]
    for key, value in arguments.items():
        assert projection[key] == {"type": "string", "size": len(value), "hash": diagnostics._hash_text(value)}


def test_queue_preparation_failure_never_uses_stdlib_stderr_fallback(monkeypatch, capsys):
    queue = BoundedDiagnosticsQueue()
    handler = ContextQueueHandler(queue, logging.NullHandler())
    monkeypatch.setattr(handler, "prepare", _fail)
    handler.handle(_record("token=sk-test-SYNTHETIC123"))
    assert capsys.readouterr().err == ""
    snapshot = queue.take_loss_snapshot(force=True)
    assert snapshot is not None and snapshot.dropped_count == 1


def test_formatter_drops_secret_shaped_correlation_and_status():
    record = _record()
    record.trace_id = "sk-syntheticsecret123"
    record.request_id = "request with spaces"
    record.session_id = "sess_ok-1"
    record.status = "tok_syntheticsecret123"
    payload = json.loads(StructuredLogFormatter().format(record))
    assert payload["trace_id"] is None
    assert payload["request_id"] is None
    assert payload["session_id"] == "sess_ok-1"
    assert payload["status"] == "unknown"
    assert "syntheticsecret" not in json.dumps(payload)


def test_rpc_correlation_params_drop_secret_shaped_ids():
    context = diagnostics.correlation_from_params({"trace_id": "sk-syntheticsecret123", "session_id": "sess-1"})
    assert context["trace_id"] is None
    assert context["session_id"] == "sess-1"


class _RecoveringSink(logging.Handler):
    """A file-only sink that absorbs failures (like the rolling file handler) until it recovers."""

    def __init__(self) -> None:
        super().__init__()
        self.available = False
        self.failure_count = 0
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        if self.available:
            self.records.append(record)
        else:
            self.failure_count += 1


def test_undelivered_loss_notice_is_retried_after_the_sink_recovers(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("sidecar.runtime.diagnostics_queue.monotonic", lambda: clock[0])
    sink = _RecoveringSink()
    queue = BoundedDiagnosticsQueue()
    listener = BoundedDiagnosticsListener(queue, sink)
    queue.record_external_drop(_record("lost under load"))
    listener._handle_direct(_record("user record"))
    assert listener.emit_pending_loss() is False
    sink.available = True
    listener._handle_direct(_record("after recovery"))
    assert listener.emit_pending_loss() is False, "retry waits for the bounded cadence"
    clock[0] += 2.0
    assert listener.emit_pending_loss() is True
    loss = [r for r in sink.records if getattr(r, "event", "") == "sidecar.runtime.diagnostics_queue_dropped"]
    assert len(loss) == 1
    assert loss[0].data["dropped_count"] == 1, "the failed notice is not counted as a lost record"
    assert loss[0].data["sink_failures"] == {"file": 1}


def test_tool_argument_projection_accepts_lone_surrogates(caplog):
    logger = logging.getLogger("tests.sidecar.tool_argument_surrogate")
    with caplog.at_level(logging.DEBUG, logger=logger.name):
        log_tool_execution(logger, tool_name="read_file", arguments={"path": "bad\ud800"}, success=False)
    projection = json.loads(StructuredLogFormatter().format(caplog.records[-1]))["data"]["arguments"]
    assert projection["path"]["type"] == "string"
    assert len(projection["path"]["hash"]) == 16
