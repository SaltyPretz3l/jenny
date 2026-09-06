"""MCP inspection runs off-loop with a bounded cancellable worker."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from sidecar.protocol import MCP_INSPECT_METHOD
from sidecar.runtime import server_auxiliary_workers
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.request_dispatch_mcp import cancel_mcp_inspection


class _Transport:
    def __init__(self) -> None:
        self.controls: list[dict[str, Any]] = []

    def send_control(self, message: dict[str, Any]) -> None:
        self.controls.append(message)


def test_mcp_inspect_worker_is_nonblocking_bounded_and_cancellable() -> None:
    started = threading.Event()
    release = threading.Event()
    workers: set[Any] = set()
    transport = _Transport()

    def request_runner(message: dict[str, Any], initialized: bool) -> ProcessOutcome:
        started.set()
        assert release.wait(2.0)
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response={"jsonrpc": "2.0", "id": message["id"], "result": {"ok": False}},
            notifications=[],
        )

    began = time.monotonic()
    assert server_auxiliary_workers.route_auxiliary_request(
        method=MCP_INSPECT_METHOD,
        message={"jsonrpc": "2.0", "id": 71, "method": MCP_INSPECT_METHOD},
        multiplexer=None,
        direct_transport=transport,
        hardware_worker_threads=set(),
        compact_worker_threads=set(),
        mcp_worker_threads=workers,
        request_runner=request_runner,
        send_outcome=lambda outcome, **_kwargs: transport.send_control(outcome.response),
        write_outcome_direct=lambda outcome: transport.send_control(outcome.response),
        logger=logging.getLogger(__name__),
    )
    assert time.monotonic() - began < 0.25
    assert started.wait(1.0)
    assert server_auxiliary_workers.route_auxiliary_request(
        method=MCP_INSPECT_METHOD,
        message={"jsonrpc": "2.0", "id": 71, "method": MCP_INSPECT_METHOD},
        multiplexer=None,
        direct_transport=transport,
        hardware_worker_threads=set(),
        compact_worker_threads=set(),
        mcp_worker_threads=workers,
        request_runner=request_runner,
        send_outcome=lambda outcome, **_kwargs: transport.send_control(outcome.response),
        write_outcome_direct=lambda outcome: transport.send_control(outcome.response),
        logger=logging.getLogger(__name__),
    ) is False
    assert transport.controls[0]["error"]["code"] == -32600
    assert cancel_mcp_inspection(71) is True

    assert server_auxiliary_workers.route_auxiliary_request(
        method=MCP_INSPECT_METHOD,
        message={"jsonrpc": "2.0", "id": 72, "method": MCP_INSPECT_METHOD},
        multiplexer=None,
        direct_transport=transport,
        hardware_worker_threads=set(),
        compact_worker_threads=set(),
        mcp_worker_threads=workers,
        request_runner=request_runner,
        send_outcome=lambda outcome, **_kwargs: transport.send_control(outcome.response),
        write_outcome_direct=lambda outcome: transport.send_control(outcome.response),
        logger=logging.getLogger(__name__),
    ) is False
    assert transport.controls[1]["error"]["data"]["reason"] == "too_many_mcp_inspect_requests"

    release.set()
    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=workers,
        timeout_seconds=1.0,
        logger=logging.getLogger(__name__),
    )
