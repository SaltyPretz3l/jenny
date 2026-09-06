from __future__ import annotations

import io
import json
from types import SimpleNamespace

import pytest

from sidecar import server
from sidecar.protocol import API_VERSION
from sidecar.runtime.framing import TransportDesynchronizedError
from sidecar.runtime.multiplexer import TransportBackpressureError
from sidecar.runtime.outcomes import ProcessOutcome


def _drained_subprocess_result() -> SimpleNamespace:
    return SimpleNamespace(
        drained=True,
        child_count=0,
        reservation_count=0,
        unreaped_count=0,
        manager_count=1,
    )


def _frame(payload: dict[str, object]) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
    return header + body


def test_read_message_parses_content_length_frame(monkeypatch) -> None:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"accept_version": API_VERSION},
    }
    stdin = SimpleNamespace(buffer=io.BytesIO(_frame(payload)))
    monkeypatch.setattr(server.sys, "stdin", stdin)

    parsed = server.read_message()

    assert parsed == payload


def test_read_message_rejects_oversized_payload(monkeypatch) -> None:
    oversized = server.MAX_CONTENT_LENGTH_BYTES + 1
    raw = f"Content-Length: {oversized}\r\n\r\n".encode("utf-8")
    stdin = SimpleNamespace(buffer=io.BytesIO(raw))
    monkeypatch.setattr(server.sys, "stdin", stdin)

    with pytest.raises(ValueError, match="Content-Length out of range"):
        server.read_message()


def test_write_message_writes_content_length_frame(monkeypatch) -> None:
    stdout = SimpleNamespace(buffer=io.BytesIO())
    monkeypatch.setattr(server.sys, "stdout", stdout)

    server.write_message({"jsonrpc": "2.0", "id": 5, "result": {"ok": True}})

    raw = stdout.buffer.getvalue()
    header, body = raw.split(b"\r\n\r\n", 1)
    assert header.startswith(b"Content-Length: ")
    assert json.loads(body.decode("utf-8"))["id"] == 5


def test_main_terminates_transport_after_framing_desynchronization(monkeypatch) -> None:
    reads = 0
    dispatched: list[dict[str, object]] = []

    def read_once() -> dict[str, object]:
        nonlocal reads
        reads += 1
        if reads == 1:
            raise TransportDesynchronizedError("oversized frame")
        return {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "shutdown",
            "params": {"accept_version": API_VERSION},
        }

    monkeypatch.setattr(server, "configure_logging", lambda: None)
    monkeypatch.setattr(server, "emit_startup_audit_mark", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "start_parent_death_watchdog", lambda **_kwargs: None)
    monkeypatch.setattr(server, "read_message", read_once)
    monkeypatch.setattr(server, "process_message", lambda message, _initialized: dispatched.append(message))
    monkeypatch.setattr(server, "_cancel_and_join_live_chat_workers", lambda **_kwargs: None)
    monkeypatch.setattr(
        server,
        "_SUBPROCESS_MANAGER",
        SimpleNamespace(close=lambda **_kwargs: _drained_subprocess_result()),
    )
    monkeypatch.setattr(type(server._BRAIN_CONTAINER), "close", lambda _self: None)  # noqa: SLF001
    monkeypatch.setattr(server, "shutdown_sidecar_logging", lambda **_kwargs: None)

    server.main()

    assert reads == 1
    assert dispatched == []


def test_main_rejects_invalid_envelope_before_dispatch_and_continues(monkeypatch) -> None:
    messages = iter(
        [
            {"jsonrpc": "1.0", "id": 1, "method": "initialize", "params": {}},
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "shutdown",
                "params": {"accept_version": API_VERSION},
            },
        ]
    )
    dispatched: list[dict[str, object]] = []
    written: list[dict[str, object]] = []

    def dispatch(message: dict[str, object], initialized: bool) -> ProcessOutcome:
        dispatched.append(message)
        return ProcessOutcome(initialized, True, None, [])

    monkeypatch.setattr(server, "configure_logging", lambda: None)
    monkeypatch.setattr(server, "emit_startup_audit_mark", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "start_parent_death_watchdog", lambda **_kwargs: None)
    monkeypatch.setattr(server, "read_message", lambda: next(messages))
    monkeypatch.setattr(server, "process_message", dispatch)
    monkeypatch.setattr(server, "write_message", written.append)
    monkeypatch.setattr(server, "_cancel_and_join_live_chat_workers", lambda **_kwargs: None)
    monkeypatch.setattr(
        server,
        "_SUBPROCESS_MANAGER",
        SimpleNamespace(close=lambda **_kwargs: _drained_subprocess_result()),
    )
    monkeypatch.setattr(type(server._BRAIN_CONTAINER), "close", lambda _self: None)  # noqa: SLF001
    monkeypatch.setattr(server, "shutdown_sidecar_logging", lambda **_kwargs: None)

    server.main()

    assert [message["id"] for message in dispatched] == [2]
    assert written[0]["id"] == 1
    assert written[0]["error"]["code"] == -32600


def test_main_absorbs_transport_backpressure_from_request_routing_without_exiting(
    monkeypatch, caplog
) -> None:
    # SP-14 escalation defense-in-depth (server.py half): a
    # TransportBackpressureError raised anywhere while routing an inbound
    # request must not fall through to the generic "fatal error in sidecar
    # main loop" catch-all, which logs fatal and BREAKS the loop -- killing
    # the whole sidecar over a frame that merely couldn't be buffered right
    # now. Pre-fix, this test's loop exits after the first read (reads == 1)
    # instead of continuing on to process the shutdown request.
    reads = 0
    dispatched: list[dict[str, object]] = []

    def read_with_one_backpressure_blip() -> dict[str, object]:
        nonlocal reads
        reads += 1
        if reads == 1:
            raise TransportBackpressureError(
                "sidecar transport_backpressure: outbound frame queue "
                "exceeded the high-water mark"
            )
        return {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "shutdown",
            "params": {"accept_version": API_VERSION},
        }

    def dispatch(message: dict[str, object], initialized: bool) -> ProcessOutcome:
        dispatched.append(message)
        return ProcessOutcome(initialized, True, None, [])

    monkeypatch.setattr(server, "configure_logging", lambda: None)
    monkeypatch.setattr(server, "emit_startup_audit_mark", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "start_parent_death_watchdog", lambda **_kwargs: None)
    monkeypatch.setattr(server, "read_message", read_with_one_backpressure_blip)
    monkeypatch.setattr(server, "process_message", dispatch)
    monkeypatch.setattr(server, "write_message", lambda _message: None)
    monkeypatch.setattr(server, "_cancel_and_join_live_chat_workers", lambda **_kwargs: None)
    monkeypatch.setattr(
        server,
        "_SUBPROCESS_MANAGER",
        SimpleNamespace(close=lambda **_kwargs: _drained_subprocess_result()),
    )
    monkeypatch.setattr(type(server._BRAIN_CONTAINER), "close", lambda _self: None)  # noqa: SLF001
    monkeypatch.setattr(server, "shutdown_sidecar_logging", lambda **_kwargs: None)

    with caplog.at_level("WARNING"):
        server.main()

    assert reads == 2
    assert [message["id"] for message in dispatched] == [3]
    assert any(
        getattr(record, "event", "") == "sidecar.runtime.transport.main_loop_backpressure_absorbed"
        for record in caplog.records
    )


def test_main_exits_when_shutdown_acknowledgement_hits_backpressure(monkeypatch, caplog) -> None:
    shutdown_message = {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "shutdown",
        "params": {"accept_version": API_VERSION},
    }
    multiplexer_reads = 0
    dispatched: list[str] = []
    shutdown_calls = 0

    class FakeMultiplexer:
        def read_request(self) -> dict[str, object]:
            nonlocal multiplexer_reads
            multiplexer_reads += 1
            if multiplexer_reads > 1:
                raise EOFError
            return shutdown_message

    def dispatch(message: dict[str, object], _initialized: bool) -> ProcessOutcome:
        method = str(message["method"])
        dispatched.append(method)
        return ProcessOutcome(method == "initialize", method == "shutdown", None, [])

    def reject_shutdown_acknowledgement(
        outcome: ProcessOutcome, *, multiplexer: FakeMultiplexer
    ) -> None:
        assert outcome.shutdown_requested is True
        raise TransportBackpressureError("terminal lane full")

    def record_shutdown(_context) -> None:
        nonlocal shutdown_calls
        shutdown_calls += 1

    monkeypatch.setattr(server, "configure_logging", lambda: None)
    monkeypatch.setattr(server, "emit_startup_audit_mark", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "start_parent_death_watchdog", lambda **_kwargs: None)
    monkeypatch.setattr(
        server,
        "read_message",
        lambda: {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"accept_version": API_VERSION},
        },
    )
    monkeypatch.setattr(server, "process_message", dispatch)
    monkeypatch.setattr(server, "_write_outcome_direct", lambda _outcome: None)
    monkeypatch.setattr(server, "_batch4_transport_enabled", lambda: True)
    monkeypatch.setattr(server, "StdioTransportMultiplexer", lambda **_kwargs: FakeMultiplexer())
    monkeypatch.setattr(server, "_send_outcome", reject_shutdown_acknowledgement)
    monkeypatch.setattr(server, "shutdown_server_runtime", record_shutdown)

    with caplog.at_level("WARNING"):
        server.main()

    assert multiplexer_reads == 1
    assert dispatched == ["initialize", "shutdown"]
    assert shutdown_calls == 1
    assert any(
        getattr(record, "event", "")
        == "sidecar.runtime.transport.shutdown_acknowledgement_rejected"
        for record in caplog.records
    )
