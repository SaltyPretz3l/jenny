"""JCA-004: manual ``chat.compact`` must never block the request-dispatch loop.

The manual compaction path runs a real model inference; dispatched inline it
parked Stop (chat.cancel) and every later control request behind the
summarization call for up to Electron's 120s RPC budget. These tests mirror the
hardware-profile worker responsiveness suite for the compact worker.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from sidecar import server
from sidecar.protocol import CHAT_COMPACT_METHOD, SHUTDOWN_METHOD
from sidecar.runtime import server_auxiliary_workers
from sidecar.runtime.outcomes import ProcessOutcome


class _FakeTransport:
    def __init__(self) -> None:
        self.controls: list[dict[str, Any]] = []
        self.response_sent = threading.Event()

    def send_control(self, message: dict[str, Any]) -> None:
        self.controls.append(message)
        self.response_sent.set()


def test_chat_compact_worker_keeps_control_dispatch_responsive(monkeypatch) -> None:
    """A blocked compactor must not delay an unrelated control request."""
    compact_started = threading.Event()
    release_compact = threading.Event()
    transport = _FakeTransport()
    worker_threads: set[Any] = set()

    def process_message(message: dict[str, Any], initialized: bool) -> ProcessOutcome:
        if message.get("method") == CHAT_COMPACT_METHOD:
            compact_started.set()
            assert release_compact.wait(2.0)
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response={
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": {"status": "ok", "compacted": True},
                },
                notifications=[],
            )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=True,
            response={
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "result": {"status": "shutting_down"},
            },
            notifications=[],
        )

    monkeypatch.setattr(server, "process_message", process_message)
    started_at = time.monotonic()
    # Production shape: the main loop hands chat.compact to the auxiliary
    # router, which picks the transport/outcome sender and starts the worker.
    assert server_auxiliary_workers.route_auxiliary_request(
        method=CHAT_COMPACT_METHOD,
        message={"jsonrpc": "2.0", "id": 61, "method": CHAT_COMPACT_METHOD},
        multiplexer=None,
        direct_transport=transport,  # type: ignore[arg-type]
        hardware_worker_threads=set(),
        compact_worker_threads=worker_threads,
        request_runner=lambda m, i: server.process_message(m, i),
        send_outcome=lambda outcome, **_kwargs: transport.send_control(outcome.response),
        write_outcome_direct=lambda outcome: transport.send_control(outcome.response),
        logger=server.logger,
    )
    assert compact_started.wait(1.0)

    # While the compactor is still blocked inside inference, an unrelated
    # control request is processed immediately on the main dispatch path.
    unrelated = server.process_message(
        {"jsonrpc": "2.0", "id": 62, "method": SHUTDOWN_METHOD},
        initialized=True,
    )
    elapsed = time.monotonic() - started_at

    assert elapsed < 0.25
    assert unrelated.shutdown_requested is True
    assert transport.controls == []

    release_compact.set()
    assert transport.response_sent.wait(1.0)
    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=worker_threads,
        timeout_seconds=1.0,
        logger=server.logger,
    )
    assert transport.controls[0]["result"] == {"status": "ok", "compacted": True}


def test_chat_compact_worker_cap_is_one_and_returns_bounded_error() -> None:
    class _LiveThread:
        def is_alive(self) -> bool:
            return True

    transport = _FakeTransport()
    worker_threads: set[Any] = {_LiveThread()}

    started = server_auxiliary_workers.start_compact_worker_if_allowed(
        message={"jsonrpc": "2.0", "id": 63, "method": CHAT_COMPACT_METHOD},
        transport=transport,  # type: ignore[arg-type]
        worker_threads=worker_threads,
        request_runner=lambda _m, _i: None,  # type: ignore[arg-type,return-value]
        outcome_sender=lambda _outcome, **_kwargs: None,
        logger=server.logger,
    )

    assert server.MAX_ACTIVE_COMPACT_WORKERS == 1
    assert started is False
    assert transport.controls[0]["id"] == 63
    assert transport.controls[0]["error"]["data"]["reason"] == (
        "too_many_chat_compact_requests"
    )


def test_route_rejects_compaction_for_a_session_with_a_live_turn() -> None:
    """JCA-004 active-session guard: chat.compact for a session whose turn is
    live gets a structured session_busy result and starts no worker."""

    class _GuardedMultiplexer(_FakeTransport):
        def has_active_session_turn(self, session_id: str | None) -> bool:
            return str(session_id or "") == "sess-live"

    multiplexer = _GuardedMultiplexer()
    worker_threads: set[Any] = set()

    started = server_auxiliary_workers.route_auxiliary_request(
        method=CHAT_COMPACT_METHOD,
        message={
            "jsonrpc": "2.0",
            "id": 65,
            "method": CHAT_COMPACT_METHOD,
            "params": {"session_id": "sess-live"},
        },
        multiplexer=multiplexer,
        direct_transport=_FakeTransport(),  # type: ignore[arg-type]
        hardware_worker_threads=set(),
        compact_worker_threads=worker_threads,
        request_runner=lambda _m, _i: None,  # type: ignore[arg-type,return-value]
        send_outcome=lambda _outcome, **_kwargs: None,
        write_outcome_direct=lambda _outcome: None,
        logger=server.logger,
    )

    assert started is False
    assert worker_threads == set(), 'no compact worker starts for a busy session'
    assert multiplexer.controls[0]["id"] == 65
    assert multiplexer.controls[0]["result"]["status"] == "error"
    assert multiplexer.controls[0]["result"]["reason"] == "session_busy"

    # A different session with no live turn routes through to a worker start.
    other_threads: set[Any] = set()
    assert server_auxiliary_workers.route_auxiliary_request(
        method=CHAT_COMPACT_METHOD,
        message={
            "jsonrpc": "2.0",
            "id": 66,
            "method": CHAT_COMPACT_METHOD,
            "params": {"session_id": "sess-idle"},
        },
        multiplexer=multiplexer,
        direct_transport=_FakeTransport(),  # type: ignore[arg-type]
        hardware_worker_threads=set(),
        compact_worker_threads=other_threads,
        request_runner=lambda _m, i: ProcessOutcome(
            initialized=i, shutdown_requested=False,
            response={"jsonrpc": "2.0", "id": 66, "result": {"status": "ok"}},
            notifications=[],
        ),
        send_outcome=lambda outcome, **_kwargs: multiplexer.send_control(outcome.response),
        write_outcome_direct=lambda _outcome: None,
        logger=server.logger,
    )
    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=other_threads,
        timeout_seconds=1.0,
        logger=server.logger,
    )


def test_chat_compact_worker_shutdown_gate_suppresses_late_outcome() -> None:
    compact_started = threading.Event()
    release_compact = threading.Event()
    worker_threads: set[Any] = set()
    transport = _FakeTransport()
    shutdown_gate = server_auxiliary_workers.AuxiliaryWorkerGate()

    def request_runner(_message: dict[str, Any], initialized: bool) -> ProcessOutcome:
        compact_started.set()
        assert release_compact.wait(1.0)
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response={"jsonrpc": "2.0", "id": 64, "result": {"status": "ok"}},
            notifications=[],
        )

    assert server_auxiliary_workers.start_compact_worker_if_allowed(
        message={"jsonrpc": "2.0", "id": 64, "method": CHAT_COMPACT_METHOD},
        transport=transport,
        worker_threads=worker_threads,
        request_runner=request_runner,
        outcome_sender=lambda outcome, **_kwargs: transport.send_control(outcome.response),
        logger=server.logger,
        shutdown_gate=shutdown_gate,
    )
    assert compact_started.wait(1.0)

    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=worker_threads,
        timeout_seconds=0.01,
        logger=server.logger,
        shutdown_gate=shutdown_gate,
    )
    release_compact.set()
    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=worker_threads,
        timeout_seconds=1.0,
        logger=server.logger,
    )

    assert transport.controls == []


def test_has_active_session_turn_guards_only_the_live_session() -> None:
    """JCA-004 active-session guard probe: true only while the session's turn
    is registered, never for other sessions or a blank session id."""
    import logging
    import queue

    from sidecar.runtime.multiplexer import StdioTransportMultiplexer

    incoming: "queue.Queue[dict[str, Any]]" = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=lambda: incoming.get(timeout=1.0),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.compact_workers"),
    )
    try:
        assert multiplexer.has_active_session_turn("sess-a") is False
        handle = multiplexer.register_turn(
            request_id="req-a",
            trace_id=None,
            session_id="sess-a",
        )
        assert multiplexer.has_active_session_turn("sess-a") is True
        assert multiplexer.has_active_session_turn("sess-b") is False
        assert multiplexer.has_active_session_turn("") is False
        assert multiplexer.has_active_session_turn(None) is False
        multiplexer.unregister_turn("req-a", expected_handle=handle)
        assert multiplexer.has_active_session_turn("sess-a") is False
    finally:
        multiplexer.close()
