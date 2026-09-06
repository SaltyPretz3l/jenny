from __future__ import annotations

import logging
from types import SimpleNamespace

from sidecar import server
from sidecar.ai.error_codes import CMP_RESOURCE_EXCEEDED
from sidecar.runtime import request_dispatch, server_chat_workers


class _FakeTransport:
    def __init__(self) -> None:
        self.control_messages: list[dict[str, object]] = []

    def send_control(self, message: dict[str, object]) -> None:
        self.control_messages.append(message)


class _AliveThread:
    def __init__(self) -> None:
        self.join_calls = 0

    def is_alive(self) -> bool:
        return True

    def join(self, timeout: float | None = None) -> None:
        _ = timeout
        self.join_calls += 1


class _FinishedThread:
    def is_alive(self) -> bool:
        return False


class _FakeCancelHandle:
    def __init__(self) -> None:
        self.cancel_reasons: list[str] = []

    def cancel(self, *, reason: str = "chat_cancelled") -> bool:
        self.cancel_reasons.append(reason)
        return True


def test_start_chat_send_worker_rejects_when_worker_cap_is_reached() -> None:
    transport = _FakeTransport()
    live_threads = {_AliveThread() for _ in range(server.MAX_ACTIVE_CHAT_WORKERS)}
    active_cancel_handles = {thread: _FakeCancelHandle() for thread in live_threads}

    started = server._start_chat_send_worker_if_allowed(  # noqa: SLF001
        message={
            "jsonrpc": "2.0",
            "id": 101,
            "method": "chat.send",
            "params": {"request_id": "req-over-cap"},
        },
        transport=transport,
        worker_threads=live_threads,
        active_cancel_handles=active_cancel_handles,
    )

    assert started is False
    assert len(transport.control_messages) == 1
    error = transport.control_messages[0]["error"]
    assert error["data"]["code"] == CMP_RESOURCE_EXCEEDED
    assert error["data"]["reason"] == "too_many_active_turns"


def test_prune_finished_chat_workers_removes_cancel_handle() -> None:
    live = _AliveThread()
    finished = _FinishedThread()
    worker_threads = {live, finished}
    active_cancel_handles = {live: _FakeCancelHandle(), finished: _FakeCancelHandle()}

    server_chat_workers.prune_finished_chat_workers(worker_threads, active_cancel_handles)

    assert worker_threads == {live}
    assert list(active_cancel_handles) == [live]


def test_make_chat_send_worker_sends_control_error_when_worker_raises() -> None:
    sent: list[dict[str, object]] = []
    transport = SimpleNamespace(
        approval_reader_factory=lambda *_args, **_kwargs: None,
        send_control=sent.append,
        unregister_turn=lambda _request_id, expected_handle=None: None,
    )

    def _raise(*_args, **_kwargs):  # noqa: ANN002, ANN003
        raise RuntimeError("boom")

    worker = server_chat_workers.make_chat_send_worker(
        message={"jsonrpc": "2.0", "id": 102, "method": "chat.send", "params": {}},
        transport=transport,
        cancel_handle=object(),
        request_id="req-worker-error",
        chat_send_runner=_raise,
        logger=logging.getLogger("tests.server_chat_workers"),
    )

    worker()

    assert sent[0]["id"] == 102
    assert sent[0]["error"]["code"] == -32603
    assert sent[0]["error"]["message"] == "internal error: RuntimeError"


def test_chat_send_adapter_forwards_prepared_plugin_runtime_admission(monkeypatch) -> None:
    admission = object()
    expected_outcome = object()
    captured: dict[str, object] = {}

    def _capture(**kwargs):  # noqa: ANN003, ANN202
        captured.update(kwargs)
        return expected_outcome

    monkeypatch.setattr(server, "runtime_process_chat_send_request", _capture)

    outcome = server._run_chat_send_with_optional_approval(  # noqa: SLF001
        {"jsonrpc": "2.0", "id": 103, "method": "chat.send", "params": {}},
        plugin_runtime_admission=admission,
    )

    assert outcome is expected_outcome
    assert captured["plugin_runtime_admission"] is admission


def test_cancel_and_join_live_chat_workers_logs_abandoned(caplog) -> None:
    live = _AliveThread()
    handle = _FakeCancelHandle()

    with caplog.at_level(logging.WARNING):
        server._cancel_and_join_live_chat_workers(  # noqa: SLF001
            worker_threads={live},
            active_cancel_handles={live: handle},
            shutdown_worker_grace_seconds=0.0,
            logger=logging.getLogger("tests.server.dispatch"),
        )

    assert handle.cancel_reasons == ["sidecar_shutdown"]
    assert live.join_calls == 1
    assert any(
        getattr(record, "event", "") == "sidecar.shutdown.workers_abandoned"
        for record in caplog.records
    )

def test_unload_failure_category_types_a_timeout_through_the_cause_chain() -> None:
    """A timed-out eviction must reach Electron as category="timeout".

    Without it the failure arrives as a bare CMP-SIDECAR-0005/"rpc", the engine
    switch cannot tell "residency unknown" from "definitely nothing resident", and
    it starts llama-server on top of a still-resident Ollama runner. The engine
    wraps the socket timeout in GenerationError, hence the cause walk.
    """
    wrapped = None
    try:
        try:
            raise TimeoutError("timed out")
        except TimeoutError as exc:
            raise RuntimeError(f"Model unload failed: {exc}") from exc
    except RuntimeError as error:
        wrapped = error

    assert request_dispatch._unload_failure_category(wrapped) == "timeout"
    assert request_dispatch._unload_failure_category(RuntimeError("unload failed")) is None
    assert request_dispatch._unload_failure_category(ConnectionRefusedError("down")) is None


def test_unload_failure_category_terminates_on_a_cyclic_cause() -> None:
    first = RuntimeError("first")
    second = RuntimeError("second")
    first.__cause__ = second
    second.__cause__ = first

    assert request_dispatch._unload_failure_category(first) is None
