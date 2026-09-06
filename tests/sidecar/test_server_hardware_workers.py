from __future__ import annotations

import threading
import time
from typing import Any

from sidecar import server
from sidecar.protocol import HARDWARE_PROFILE_METHOD, SHUTDOWN_METHOD
from sidecar.runtime import server_auxiliary_workers, server_chat_workers
from sidecar.runtime.outcomes import ProcessOutcome


class _FakeTransport:
    def __init__(self) -> None:
        self.controls: list[dict[str, Any]] = []
        self.response_sent = threading.Event()

    def send_control(self, message: dict[str, Any]) -> None:
        self.controls.append(message)
        self.response_sent.set()


def test_hardware_profile_worker_keeps_unrelated_dispatch_responsive(
    monkeypatch,
) -> None:
    hardware_started = threading.Event()
    release_hardware = threading.Event()
    transport = _FakeTransport()
    worker_threads: set[Any] = set()

    def process_message(message: dict[str, Any], initialized: bool) -> ProcessOutcome:
        if message.get("method") == HARDWARE_PROFILE_METHOD:
            hardware_started.set()
            assert release_hardware.wait(2.0)
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response={
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": {"gpu": {"type": "cuda", "name": "accurate-result"}},
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
    assert server_auxiliary_workers.start_hardware_profile_worker_if_allowed(
        message={"jsonrpc": "2.0", "id": 41, "method": HARDWARE_PROFILE_METHOD},
        transport=transport,  # type: ignore[arg-type]
        worker_threads=worker_threads,
        request_runner=lambda m, i: server.process_message(m, i),
        outcome_sender=lambda outcome, **_kwargs: transport.send_control(outcome.response),
        logger=server.logger,
    )
    assert hardware_started.wait(1.0)

    unrelated = server.process_message(
        {"jsonrpc": "2.0", "id": 42, "method": SHUTDOWN_METHOD},
        initialized=True,
    )
    elapsed = time.monotonic() - started_at

    assert elapsed < 0.25
    assert unrelated.shutdown_requested is True
    assert transport.controls == []

    release_hardware.set()
    assert transport.response_sent.wait(1.0)
    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=worker_threads,
        timeout_seconds=1.0,
        logger=server.logger,
    )
    assert transport.controls[0]["result"]["gpu"] == {
        "type": "cuda",
        "name": "accurate-result",
    }


def test_hardware_profile_worker_cap_returns_bounded_error() -> None:
    class _LiveThread:
        def is_alive(self) -> bool:
            return True

    transport = _FakeTransport()
    worker_threads: set[Any] = {_LiveThread()}

    started = server_auxiliary_workers.start_hardware_profile_worker_if_allowed(
        message={"jsonrpc": "2.0", "id": 43, "method": HARDWARE_PROFILE_METHOD},
        transport=transport,  # type: ignore[arg-type]
        worker_threads=worker_threads,
        request_runner=lambda _m, _i: None,  # type: ignore[arg-type,return-value]
        outcome_sender=lambda _outcome, **_kwargs: None,
        logger=server.logger,
        max_active_workers=1,
    )

    assert started is False
    assert transport.controls[0]["id"] == 43
    assert transport.controls[0]["error"]["data"]["reason"] == (
        "too_many_hardware_profile_requests"
    )


def test_hardware_profile_notification_cap_does_not_send_null_id_response() -> None:
    class _LiveThread:
        def is_alive(self) -> bool:
            return True

    transport = _FakeTransport()
    worker_threads: set[Any] = {_LiveThread()}

    started = server_auxiliary_workers.start_hardware_profile_worker_if_allowed(
        message={"jsonrpc": "2.0", "method": HARDWARE_PROFILE_METHOD},
        transport=transport,  # type: ignore[arg-type]
        worker_threads=worker_threads,
        request_runner=lambda _m, _i: None,  # type: ignore[arg-type,return-value]
        outcome_sender=lambda _outcome, **_kwargs: None,
        logger=server.logger,
        max_active_workers=1,
    )

    assert started is False
    assert transport.controls == []


def test_hardware_profile_notification_fatal_error_does_not_send_null_id_response() -> None:
    transport = _FakeTransport()
    worker = server_auxiliary_workers._make_auxiliary_worker(  # noqa: SLF001
        method_label="hardware.profile",
        message={"jsonrpc": "2.0", "method": HARDWARE_PROFILE_METHOD},
        transport=transport,
        request_runner=lambda _message, _initialized: (_ for _ in ()).throw(
            RuntimeError("worker failed")
        ),
        outcome_sender=lambda _outcome, **_kwargs: None,
        logger=server.logger,
        shutdown_gate=server_auxiliary_workers.AuxiliaryWorkerGate(),
    )

    worker()

    assert transport.controls == []


def test_hardware_profile_notification_start_failure_does_not_send_null_id_response(
    monkeypatch,
) -> None:
    class _FailingThread:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def is_alive(self) -> bool:
            return False

        def start(self) -> None:
            raise RuntimeError("thread start failed")

    monkeypatch.setattr(server_auxiliary_workers.threading, "Thread", _FailingThread)
    transport = _FakeTransport()
    worker_threads: set[Any] = set()

    started = server_auxiliary_workers.start_hardware_profile_worker_if_allowed(
        message={"jsonrpc": "2.0", "method": HARDWARE_PROFILE_METHOD},
        transport=transport,
        worker_threads=worker_threads,
        request_runner=lambda _message, initialized: ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
        ),
        outcome_sender=lambda _outcome, **_kwargs: None,
        logger=server.logger,
    )

    assert started is False
    assert transport.controls == []


def test_direct_transport_hardware_worker_keeps_dispatch_responsive(
    monkeypatch,
) -> None:
    hardware_started = threading.Event()
    release_hardware = threading.Event()
    written: list[dict[str, Any]] = []
    worker_threads: set[Any] = set()

    def process_message(message: dict[str, Any], initialized: bool) -> ProcessOutcome:
        if message.get("method") != HARDWARE_PROFILE_METHOD:
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
        hardware_started.set()
        assert release_hardware.wait(1.0)
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response={
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "result": {"gpu": {"name": "direct-accurate"}},
            },
            notifications=[],
        )

    monkeypatch.setattr(server, "process_message", process_message)
    monkeypatch.setattr(server, "write_message", written.append)
    direct_transport = server_auxiliary_workers.DirectOutcomeTransport(written.append)
    # Production shape: a direct (no-multiplexer) transport routes through
    # route_auxiliary_request, which selects the direct outcome sender.
    assert server_auxiliary_workers.route_auxiliary_request(
        method=HARDWARE_PROFILE_METHOD,
        message={"jsonrpc": "2.0", "id": 44, "method": HARDWARE_PROFILE_METHOD},
        multiplexer=None,
        direct_transport=direct_transport,
        hardware_worker_threads=worker_threads,
        compact_worker_threads=set(),
        request_runner=lambda m, i: server.process_message(m, i),
        send_outcome=server_chat_workers.send_outcome,
        write_outcome_direct=lambda outcome: server._write_outcome_direct(outcome),  # noqa: SLF001
        logger=server.logger,
    )
    assert hardware_started.wait(1.0)

    started_at = time.monotonic()
    unrelated = server.process_message(
        {"jsonrpc": "2.0", "id": 45, "method": SHUTDOWN_METHOD},
        initialized=True,
    )
    assert time.monotonic() - started_at < 0.05
    assert unrelated.shutdown_requested is True

    release_hardware.set()
    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=worker_threads,
        timeout_seconds=1.0,
        logger=server.logger,
    )
    assert written[0]["result"]["gpu"]["name"] == "direct-accurate"


def test_hardware_worker_shutdown_gate_suppresses_late_outcome() -> None:
    hardware_started = threading.Event()
    release_hardware = threading.Event()
    worker_threads: set[Any] = set()
    transport = _FakeTransport()
    shutdown_gate = server_auxiliary_workers.AuxiliaryWorkerGate()

    def request_runner(_message: dict[str, Any], initialized: bool) -> ProcessOutcome:
        hardware_started.set()
        assert release_hardware.wait(1.0)
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response={"jsonrpc": "2.0", "id": 46, "result": {"gpu": {}}},
            notifications=[],
        )

    assert server_auxiliary_workers.start_hardware_profile_worker_if_allowed(
        message={"jsonrpc": "2.0", "id": 46, "method": HARDWARE_PROFILE_METHOD},
        transport=transport,
        worker_threads=worker_threads,
        request_runner=request_runner,
        outcome_sender=lambda outcome, **_kwargs: transport.send_control(outcome.response),
        logger=server.logger,
        shutdown_gate=shutdown_gate,
    )
    assert hardware_started.wait(1.0)

    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=worker_threads,
        timeout_seconds=0.01,
        logger=server.logger,
        shutdown_gate=shutdown_gate,
    )
    release_hardware.set()
    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=worker_threads,
        timeout_seconds=1.0,
        logger=server.logger,
    )

    assert transport.controls == []


def test_auxiliary_worker_gate_close_never_waits_for_claimed_delivery() -> None:
    gate = server_auxiliary_workers.AuxiliaryWorkerGate()
    delivery_started = threading.Event()
    release_delivery = threading.Event()

    def deliver() -> None:
        delivery_started.set()
        assert release_delivery.wait(1.0)

    worker = threading.Thread(target=lambda: gate.deliver(deliver), daemon=True)
    worker.start()
    assert delivery_started.wait(1.0)

    started_at = time.monotonic()
    inflight = gate.close()
    elapsed = time.monotonic() - started_at

    assert elapsed < 0.05
    assert inflight == 1
    release_delivery.set()
    worker.join(timeout=1.0)
    assert worker.is_alive() is False
