"""chat.cancel reaches auxiliary inference requests (row 58 W2 preemption)."""

from __future__ import annotations

import logging
import queue
import threading
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar import server
from sidecar.protocol import (
    API_VERSION,
    CHAT_CANCEL_METHOD,
    COMMIT_GENERATE_MESSAGE_METHOD,
    SUGGESTIONS_GENERATE_METHOD,
)
from sidecar.runtime import server_auxiliary_workers
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import StdioTransportMultiplexer, TurnCancellationHandle
from sidecar.runtime.outcomes import ProcessOutcome

LOG = logging.getLogger("test.auxiliary_cancellation")


class _Harness:
    """A real multiplexer fed from a queue, recording every written frame."""

    def __init__(self, *, max_active_turns: int = 16) -> None:
        self.incoming: queue.Queue[dict[str, Any]] = queue.Queue()
        self.written: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._written_event = threading.Condition(self._lock)
        self.mux = StdioTransportMultiplexer(
            reader=lambda: self.incoming.get(timeout=2.0),
            write_message=self._write,
            logger=LOG,
            max_active_turns=max_active_turns,
        )
        self._sentinel = 9000

    def _write(self, message: dict[str, Any]) -> None:
        with self._written_event:
            self.written.append(message)
            self._written_event.notify_all()

    def wait_for_id(self, message_id: Any, timeout: float = 3.0) -> dict[str, Any]:
        with self._written_event:
            found = self._written_event.wait_for(
                lambda: any(item.get("id") == message_id for item in self.written),
                timeout=timeout,
            )
            assert found, self.written
            return next(item for item in self.written if item.get("id") == message_id)

    def deliver_cancel(
        self, request_id: str, *, message_id: int, cancel_reason: str = "preempted"
    ) -> dict[str, Any]:
        """Route a real chat.cancel frame through read_request, then return its ack."""
        self.incoming.put({
            "jsonrpc": "2.0",
            "id": message_id,
            "method": CHAT_CANCEL_METHOD,
            "params": {
                "accept_version": API_VERSION,
                "request_id": request_id,
                "cancel_reason": cancel_reason,
            },
        })
        self._sentinel += 1
        self.incoming.put(
            {"jsonrpc": "2.0", "id": self._sentinel, "method": "shutdown", "params": {}}
        )
        assert self.mux.read_request(timeout_seconds=2.0)["id"] == self._sentinel
        return self.wait_for_id(message_id)

    def deliver_frame(self, frame: dict[str, Any]) -> None:
        """Route one inbound frame (e.g. a runtime.operation answer) through read_request."""
        self.incoming.put(frame)
        self._sentinel += 1
        self.incoming.put(
            {"jsonrpc": "2.0", "id": self._sentinel, "method": "shutdown", "params": {}}
        )
        assert self.mux.read_request(timeout_seconds=2.0)["id"] == self._sentinel

    def wait_for_operation(self, phase: str, timeout: float = 3.0) -> dict[str, Any]:
        def match(item: dict[str, Any]) -> bool:
            return item.get("method") == "runtime.operation" and item["params"]["phase"] == phase

        with self._written_event:
            assert self._written_event.wait_for(
                lambda: any(match(item) for item in self.written), timeout=timeout
            ), self.written
            return next(item for item in self.written if match(item))

    def answer_operation(self, request: dict[str, Any], status: str) -> None:
        self.deliver_frame({"jsonrpc": "2.0", "id": request["id"], "result": {
            "schema_version": 1, "operation_id": request["params"]["operation_id"],
            "status": status,
        }})

    def worker(self, message: dict[str, Any], runner: Any) -> threading.Thread:
        target = server_auxiliary_workers._make_auxiliary_worker(
            method_label=str(message["method"]),
            message=message,
            transport=self.mux,
            request_runner=runner,
            outcome_sender=lambda outcome, **_kw: self.mux.send_control(outcome.response),
            logger=LOG,
            shutdown_gate=server_auxiliary_workers.AuxiliaryWorkerGate(),
        )
        return threading.Thread(target=target, daemon=True)


def _aux_message(message_id: int, request_id: str, method: str = SUGGESTIONS_GENERATE_METHOD):
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "method": method,
        "params": {"accept_version": API_VERSION, "request_id": request_id},
    }


def _assert_cancelled_response(response: dict[str, Any]) -> None:
    assert response["error"]["code"] == -32000
    assert response["error"]["message"] == "auxiliary request cancelled"
    assert response["error"]["data"]["reason"] == "auxiliary_cancelled"


def test_chat_cancel_cancels_a_registered_auxiliary_request(
    caplog: pytest.LogCaptureFixture,
) -> None:
    harness = _Harness(max_active_turns=1)
    started = threading.Event()
    seen: dict[str, Any] = {}

    def runner(_message: dict[str, Any], _initialized: bool, **kwargs: Any) -> ProcessOutcome:
        handle = kwargs["cancel_handle"]
        seen["handle"] = handle
        seen["registered"] = harness.mux._auxiliary_handles.get("aux_live") is handle
        started.set()
        seen["observed_cancel"] = handle.wait(3.0)
        handle.raise_if_cancelled()
        return ProcessOutcome(True, False, {"jsonrpc": "2.0", "id": 11, "result": {}}, [])

    thread = harness.worker(_aux_message(11, "aux_live"), runner)
    try:
        with caplog.at_level(logging.INFO, logger=LOG.name):
            thread.start()
            assert started.wait(2.0)
            assert seen["registered"] is True
            # Aux handles never occupy the chat-turn table, the turn cap or a session.
            assert "aux_live" not in harness.mux._active_turns
            turn = harness.mux.register_turn(
                request_id="chat_1", trace_id=None, session_id="session_1"
            )
            harness.mux.unregister_turn("chat_1", expected_handle=turn)

            ack = harness.deliver_cancel("aux_live", message_id=12)
            thread.join(timeout=3.0)
        assert not thread.is_alive()
        assert ack["result"]["status"] == "cancel_requested"
        assert seen["observed_cancel"] is True
        assert seen["handle"].reason == "preempted"
        assert ack["result"]["cancel_reason"] == "preempted"
        _assert_cancelled_response(harness.wait_for_id(11))
        assert "aux_live" not in harness.mux._auxiliary_handles
        events = [r for r in caplog.records if getattr(r, "event", "") ==
                  "sidecar.runtime.auxiliary_cancelled"]
        assert len(events) == 1
        assert events[0].request_id == "aux_live"
        assert events[0].method == SUGGESTIONS_GENERATE_METHOD
        assert isinstance(events[0].elapsed_ms, int)
    finally:
        harness.mux.close()


def test_a_cancel_that_arrives_first_cancels_at_registration() -> None:
    harness = _Harness()
    observed: dict[str, Any] = {}

    def runner(_message: dict[str, Any], _initialized: bool, **kwargs: Any) -> ProcessOutcome:
        observed["runner_called"] = True
        return ProcessOutcome(True, False, {"jsonrpc": "2.0", "id": 21, "result": {}}, [])

    try:
        ack = harness.deliver_cancel("aux_early", message_id=22)
        assert ack["result"]["status"] == "cancel_queued"
        assert "aux_early" in harness.mux._cancel_tombstones
        thread = harness.worker(
            _aux_message(21, "aux_early", COMMIT_GENERATE_MESSAGE_METHOD), runner
        )
        thread.start()
        thread.join(timeout=3.0)
        assert not thread.is_alive()
        # The replayed tombstone cancels at registration: no dispatch, no admission.
        assert observed == {}
        _assert_cancelled_response(harness.wait_for_id(21))
        assert "aux_early" not in harness.mux._cancel_tombstones
        assert "aux_early" not in harness.mux._auxiliary_handles
    finally:
        harness.mux.close()


def test_a_completed_auxiliary_request_unregisters_its_handle() -> None:
    harness = _Harness()

    def runner(_message: dict[str, Any], _initialized: bool, **kwargs: Any) -> ProcessOutcome:
        assert isinstance(kwargs["cancel_handle"], TurnCancellationHandle)
        return ProcessOutcome(True, False, {"jsonrpc": "2.0", "id": 31, "result": {"ok": 1}}, [])

    try:
        thread = harness.worker(_aux_message(31, "aux_done"), runner)
        thread.start()
        thread.join(timeout=3.0)
        assert harness.wait_for_id(31)["result"] == {"ok": 1}
        assert harness.mux._auxiliary_handles == {}
        # A late cancel for a finished request is only a short-lived tombstone.
        assert harness.deliver_cancel("aux_done", message_id=32)["result"]["status"] == (
            "cancel_queued"
        )
    finally:
        harness.mux.close()


@pytest.mark.parametrize("method", [SUGGESTIONS_GENERATE_METHOD, COMMIT_GENERATE_MESSAGE_METHOD])
def test_cancel_reaches_the_engine_through_the_real_dispatch_chain(
    monkeypatch: pytest.MonkeyPatch, method: str
) -> None:
    harness = _Harness()
    entered = threading.Event()
    engine_kwargs: dict[str, Any] = {}

    def generate(**kwargs: Any) -> str:
        engine_kwargs.update(kwargs)
        handle = kwargs["cancel_handle"]
        entered.set()
        handle.wait(3.0)
        handle.raise_if_cancelled()
        return "unreachable"

    monkeypatch.setattr(server, "_BRAIN_CONTAINER", SimpleNamespace(stack=SimpleNamespace(
        engine=SimpleNamespace(generate=generate),
        config=SimpleNamespace(engine_type="ollama", model="m", feature_flags={}),
    )))
    message = _aux_message(41, "aux_chain", method)
    message["params"]["diff"] = "diff --git a/a b/a"
    thread = harness.worker(message, server.process_message)
    try:
        thread.start()
        assert entered.wait(3.0)
        assert engine_kwargs["cancel_handle"] is harness.mux._auxiliary_handles["aux_chain"]
        assert harness.deliver_cancel("aux_chain", message_id=42)["result"]["status"] == (
            "cancel_requested"
        )
        thread.join(timeout=3.0)
        assert not thread.is_alive()
        _assert_cancelled_response(harness.wait_for_id(41))
        assert harness.mux._auxiliary_handles == {}
    finally:
        harness.mux.close()


def test_requests_without_a_request_id_or_outside_the_inference_family_get_no_handle() -> None:
    harness = _Harness()
    captured: list[dict[str, Any]] = []

    def runner(message: dict[str, Any], _initialized: bool, **kwargs: Any) -> ProcessOutcome:
        captured.append(kwargs)
        return ProcessOutcome(True, False, {"jsonrpc": "2.0", "id": message["id"], "result": {}}, [])

    try:
        no_id = _aux_message(51, "")
        other_family = {"jsonrpc": "2.0", "id": 52, "method": "models.list",
                        "params": {"request_id": "aux_models"}}
        for message in (no_id, other_family):
            thread = harness.worker(message, runner)
            thread.start()
            thread.join(timeout=3.0)
        assert captured == [{}, {}]
        assert harness.mux._auxiliary_handles == {}
    finally:
        harness.mux.close()


def test_a_cancel_during_admission_answers_cancelled_not_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _Harness()
    engine_called = threading.Event()
    monkeypatch.setattr(server, "_BRAIN_CONTAINER", SimpleNamespace(stack=SimpleNamespace(
        engine=SimpleNamespace(generate=lambda **_kw: engine_called.set() or "[]"),
        config=SimpleNamespace(engine_type="ollama", model="m", feature_flags={}),
    )))
    message = _aux_message(61, "aux_admit")
    message["params"]["inference_context"] = {
        "schema_version": 1,
        "request_id": "aux_admit",
        "session_id": None,
        "authority_revision": "authority_1",
        "engine_type": "ollama",
    }
    thread = harness.worker(message, server.process_message)
    try:
        thread.start()
        # The cancel lands while the admit exchange is in flight; Electron then
        # grants it. The grant must be settled, never left holding capacity.
        admit = harness.wait_for_operation("admit")
        assert harness.deliver_cancel("aux_admit", message_id=62)["result"]["status"] == (
            "cancel_requested"
        )
        harness.answer_operation(admit, "granted")
        settle = harness.wait_for_operation("settle")
        assert settle["params"]["operation_id"] == admit["params"]["operation_id"]
        assert (settle["params"]["status"], settle["params"]["cleanup"]) == (
            "cancelled", "confirmed"
        )
        harness.answer_operation(settle, "settled")
        thread.join(timeout=3.0)
        assert not thread.is_alive()
        _assert_cancelled_response(harness.wait_for_id(61))
        assert not engine_called.is_set()
        assert harness.mux._auxiliary_handles == {}
    finally:
        harness.mux.close()


def test_preempted_is_kept_for_aux_handles_but_chat_turns_still_normalize_it() -> None:
    harness = _Harness()
    try:
        turn = harness.mux.register_turn(request_id="chat_p", trace_id=None, session_id="s_p")
        assert harness.deliver_cancel("chat_p", message_id=71)["result"]["status"] == (
            "cancel_requested"
        )
        assert turn.reason == "sidecar_cancel"
        harness.mux.unregister_turn("chat_p", expected_handle=turn)

        # A tombstoned "preempted" replays as-is to an aux handle only.
        harness.deliver_cancel("aux_p", message_id=72)
        aux = harness.mux.register_auxiliary_handle("aux_p")
        assert aux.cancelled and aux.reason == "preempted"
        harness.mux.unregister_auxiliary_handle(aux)
        harness.deliver_cancel("chat_q", message_id=73)
        replayed = harness.mux.register_turn(request_id="chat_q", trace_id=None, session_id="s_q")
        assert replayed.cancelled and replayed.reason == "sidecar_cancel"
        with pytest.raises(TerminalChatStateError) as raised:
            aux.raise_if_cancelled()
        assert raised.value.terminal_subcode == "preempted"
    finally:
        harness.mux.close()
