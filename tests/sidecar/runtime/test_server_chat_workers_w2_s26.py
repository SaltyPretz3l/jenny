from __future__ import annotations

import logging
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_CHAT_STREAM_FAILED
from sidecar.protocol import API_VERSION
from sidecar.runtime import server_chat_workers as workers
from sidecar.runtime.outcomes import ProcessOutcome


class _Transport:
    def __init__(self) -> None:
        self.send_control_calls: list[dict[str, Any]] = []
        self.unregister_turn_calls: list[tuple[str, Any]] = []

    def approval_reader_factory(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def send_control(self, message: dict[str, Any]) -> None:
        self.send_control_calls.append(message)

    def unregister_turn(self, request_id: str, *, expected_handle: Any) -> None:
        self.unregister_turn_calls.append((request_id, expected_handle))


def test_chat_worker_exception_emits_canonical_semantic_error() -> None:
    transport = _Transport()
    cancel_handle = object()

    class SpecificError(RuntimeError):
        pass

    def _runner(_message: dict[str, Any], **_kwargs: Any) -> ProcessOutcome:
        raise SpecificError("boom")

    worker = workers.make_chat_send_worker(
        message={"jsonrpc": "2.0", "id": "err-req"},
        transport=transport,  # type: ignore[arg-type]
        cancel_handle=cancel_handle,
        request_id="err-req",
        chat_send_runner=_runner,
        logger=logging.getLogger(__name__),
    )

    worker()

    assert transport.send_control_calls == [
        {
            "jsonrpc": "2.0",
            "api_version": API_VERSION,
            "id": "err-req",
            "error": {
                "code": -32603,
                "message": "internal error: SpecificError",
                "data": {
                    "code": CMP_CHAT_STREAM_FAILED,
                    "reason": "chat_worker_failed",
                    "retryable": False,
                    "api_version": API_VERSION,
                },
            },
        }
    ]


class _LiveThread:
    def __init__(self) -> None:
        self.join_timeouts: list[float | None] = []

    def is_alive(self) -> bool:
        return True

    def join(self, timeout: float | None = None) -> None:
        self.join_timeouts.append(timeout)


def test_zero_shutdown_budget_has_no_per_worker_grace_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(workers.time, "monotonic", lambda: 100.0)
    threads = [_LiveThread() for _index in range(16)]

    workers.cancel_and_join_live_chat_workers(
        worker_threads=set(threads),
        active_cancel_handles={},
        shutdown_worker_grace_seconds=0,
        logger=logging.getLogger(__name__),
    )

    assert [timeout for thread in threads for timeout in thread.join_timeouts] == [0.0] * 16
