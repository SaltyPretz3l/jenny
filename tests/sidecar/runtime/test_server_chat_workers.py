"""Behavioral unit tests for sidecar.runtime.server_chat_workers."""

from __future__ import annotations

import logging
import threading
from typing import Any

from sidecar.ai.error_codes import (
    CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT,
    CMP_PROTO_DUPLICATE_REQUEST_ID,
    CMP_RESOURCE_EXCEEDED,
)
from sidecar.runtime import server_chat_workers as chat_workers_module
from sidecar.runtime.multiplexer import (
    ActiveTurnLimitExceededError,
    DuplicateRequestIdError,
    DuplicateSessionTurnError,
    StdioTransportMultiplexer,
)
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.server_chat_workers import (
    cancel_and_join_live_chat_workers,
    make_chat_send_worker,
    prune_finished_chat_workers,
    runtime_frame_writer,
    send_outcome,
    start_chat_send_worker_if_allowed,
    write_outcome_direct,
)

# ---------------------------------------------------------------------------
# Fake helpers
# ---------------------------------------------------------------------------


class FakeCancelHandle:
    """Records cancel() calls."""

    def __init__(self) -> None:
        self.cancel_calls: list[dict[str, Any]] = []

    def cancel(self, *, reason: str = "chat_cancelled") -> None:
        self.cancel_calls.append({"reason": reason})


class FakeTransport:
    """Full-featured fake transport recording every send/register/unregister call."""

    def __init__(self, *, cancel_handle: FakeCancelHandle | None = None) -> None:
        self._cancel_handle = cancel_handle or FakeCancelHandle()
        self.send_data_calls: list[Any] = []
        self.send_control_calls: list[Any] = []
        self.send_terminal_result_calls: list[tuple[Any, Any]] = []
        self.register_turn_calls: list[dict[str, Any]] = []
        self.unregister_turn_calls: list[dict[str, Any]] = []
        self.approval_reader_factory_calls: list[Any] = []

    def send_data(self, message: Any) -> None:
        self.send_data_calls.append(message)

    def send_control(self, message: Any) -> None:
        self.send_control_calls.append(message)

    def send_terminal_result(self, notifications: Any, response: Any) -> None:
        self.send_terminal_result_calls.append((notifications, response))

    def register_turn(
        self,
        *,
        request_id: str,
        trace_id: Any,
        session_id: Any,
        generation: Any = None,
    ) -> FakeCancelHandle:
        self.register_turn_calls.append(
            {
                "request_id": request_id,
                "trace_id": trace_id,
                "session_id": session_id,
                "generation": generation,
            }
        )
        return self._cancel_handle

    def unregister_turn(self, request_id: str, *, expected_handle: Any) -> None:
        self.unregister_turn_calls.append(
            {"request_id": request_id, "expected_handle": expected_handle}
        )

    def approval_reader_factory(self, *args: Any, **kwargs: Any) -> None:
        self.approval_reader_factory_calls.append((args, kwargs))


def _make_outcome(
    notifications: list[dict[str, Any]] | None = None,
    response: dict[str, Any] | None = None,
) -> ProcessOutcome:
    return ProcessOutcome(
        initialized=True,
        shutdown_requested=False,
        response=response,
        notifications=notifications or [],
    )

class RecordingLogger(logging.Logger):
    """Logger that records warning/debug calls."""

    def __init__(self) -> None:
        super().__init__("test", level=logging.DEBUG)
        self.warning_calls: list[dict[str, Any]] = []
        self.debug_calls: list[Any] = []
        self.exception_calls: list[Any] = []

    def warning(self, msg: Any, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        self.warning_calls.append({"msg": msg, "extra": kwargs.get("extra")})

    def debug(self, msg: Any, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        self.debug_calls.append(msg)

    def exception(self, msg: Any, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        self.exception_calls.append(msg)


# ---------------------------------------------------------------------------
# send_outcome — with send_terminal_result
# ---------------------------------------------------------------------------


class TestSendOutcomeWithTerminalResult:
    def test_send_terminal_result_called_with_notifications_and_response(self) -> None:
        transport = FakeTransport()
        notif = {"method": "chat.delta", "params": {"text": "hello"}}
        resp = {"jsonrpc": "2.0", "id": "1", "result": {}}
        outcome = _make_outcome(notifications=[notif], response=resp)

        send_outcome(outcome, multiplexer=transport)

        assert len(transport.send_terminal_result_calls) == 1
        sent_notifs, sent_resp = transport.send_terminal_result_calls[0]
        assert sent_notifs == [notif]
        assert sent_resp is resp

    def test_send_data_not_called_when_terminal_result_used(self) -> None:
        transport = FakeTransport()
        notif = {"method": "chat.delta", "params": {"text": "hi"}}
        outcome = _make_outcome(notifications=[notif], response=None)

        send_outcome(outcome, multiplexer=transport)

        assert transport.send_data_calls == []

    def test_send_control_not_called_when_terminal_result_used(self) -> None:
        transport = FakeTransport()
        notif = {"method": "chat.delta", "params": {}}
        resp = {"jsonrpc": "2.0", "id": "x"}
        outcome = _make_outcome(notifications=[notif], response=resp)

        send_outcome(outcome, multiplexer=transport)

        assert transport.send_control_calls == []

    def test_post_settlement_callback_runs_after_terminal_transport(self) -> None:
        order: list[str] = []

        class _OrderedTransport(FakeTransport):
            def send_terminal_result(
                self,
                notifications: list[dict[str, Any]],
                response: dict[str, Any] | None,
            ) -> None:
                super().send_terminal_result(notifications, response)
                order.append("terminal_enqueued")

        outcome = ProcessOutcome(
            initialized=True,
            shutdown_requested=False,
            response={"jsonrpc": "2.0", "id": "settled", "result": {}},
            notifications=[],
            post_settlement_callback=lambda: order.append("callback"),
        )

        send_outcome(outcome, multiplexer=_OrderedTransport())

        assert order == ["terminal_enqueued", "callback"]


# ---------------------------------------------------------------------------
# send_outcome — empty notifications with terminal_result transport
# ---------------------------------------------------------------------------


class TestSendOutcomeEmptyNotifications:
    def test_empty_notifications_still_resolves_through_terminal_lane(self) -> None:
        """F3: a live-streamed turn resolves on the ORDERED terminal lane.

        During live streaming ``emit()`` writes every chat.token/chat.done
        straight to the wire and leaves ``ProcessOutcome.notifications`` EMPTY.
        The old ``if outcome.notifications and ...`` gate therefore skipped the
        terminal bundle for exactly the turns that needed it and put the
        resolving response on the CONTROL lane, which the writer drains STRICTLY
        before data -- so the response overtook already-queued chat.token /
        chat.done frames. Electron drops the per-request notification handler on
        resolve, so those frames died as ``sidecar.unmatched_notification``:
        lost turnUsage, lost streamSawDone, truncated assistant text.
        """
        transport = FakeTransport()
        resp = {"jsonrpc": "2.0", "id": "x", "result": {}}
        outcome = _make_outcome(notifications=[], response=resp)

        send_outcome(outcome, multiplexer=transport)

        assert transport.send_terminal_result_calls == [([], resp)]
        assert transport.send_control_calls == []
        assert transport.send_data_calls == []

    def test_fully_empty_outcome_still_routes_through_terminal_lane(self) -> None:
        # ``enqueue_batch`` returns early on an empty frame tuple, so handing it
        # a no-notification/no-response outcome is a safe no-op rather than a
        # reason to keep the old control-lane branch alive.
        transport = FakeTransport()
        outcome = _make_outcome(notifications=[], response=None)

        send_outcome(outcome, multiplexer=transport)

        assert transport.send_terminal_result_calls == [([], None)]
        assert transport.send_control_calls == []


# ---------------------------------------------------------------------------
# F3 — end-to-end wire ordering against the REAL prioritized writer
# ---------------------------------------------------------------------------


def _eof_reader() -> dict[str, Any]:
    raise EOFError("no inbound frames in this test")


def test_live_stream_response_never_overtakes_already_queued_data_frames() -> None:
    """A blocked writer must still emit trailing data BEFORE the response.

    This is the F3 failure reproduced against the real
    ``PrioritizedMessageWriter``: the pump drains the control queue strictly
    before the data queue, so a response enqueued LATER on the control lane
    jumped ahead of chat.token/chat.done frames enqueued EARLIER on the data
    lane. Electron deletes a request's notification handler the moment the
    response resolves, so the overtaken frames were dropped.

    The live-streaming outcome carries NO notifications (``emit()`` already
    wrote them), which is precisely the shape the old
    ``if outcome.notifications`` gate excluded from the ordered terminal lane.
    """
    written: list[dict[str, Any]] = []
    entered = threading.Event()
    release = threading.Event()

    def _blocking_write(message: dict[str, Any]) -> None:
        if not entered.is_set():
            entered.set()
            release.wait(timeout=5.0)
        written.append(message)

    multiplexer = StdioTransportMultiplexer(
        reader=_eof_reader,
        write_message=_blocking_write,
        logger=logging.getLogger("tests.server_chat_workers.ordering"),
    )
    try:
        token = {
            "jsonrpc": "2.0",
            "method": "chat.token",
            "params": {"request_id": "req-order", "delta": "hi"},
        }
        done = {
            "jsonrpc": "2.0",
            "method": "chat.done",
            "params": {"request_id": "req-order", "usage": {"input_tokens": 7}},
        }
        response = {
            "jsonrpc": "2.0",
            "id": 42,
            "result": {"request_id": "req-order", "status": "completed"},
        }

        multiplexer.send_data(token)
        assert entered.wait(timeout=5.0), "writer thread should be blocked on frame 1"
        multiplexer.send_data(done)
        send_outcome(
            _make_outcome(notifications=[], response=response),
            multiplexer=multiplexer,
        )
        release.set()
        drain = multiplexer.close(timeout_seconds=5.0)
    finally:
        release.set()

    assert drain.writer.pending_frames == 0
    assert written == [token, done, response], (
        "the resolving response must land AFTER every already-queued data frame"
    )


# ---------------------------------------------------------------------------
# write_outcome_direct
# ---------------------------------------------------------------------------


class TestWriteOutcomeDirect:
    def test_notifications_then_response_written_in_order(self) -> None:
        written: list[Any] = []
        n1 = {"method": "chat.delta", "params": {"text": "x"}}
        n2 = {"method": "chat.done", "params": {}}
        resp = {"jsonrpc": "2.0", "id": "1", "result": {}}
        outcome = _make_outcome(notifications=[n1, n2], response=resp)

        write_outcome_direct(outcome, write_message=written.append)

        assert written == [n1, n2, resp]

    def test_no_response_means_only_notifications_written(self) -> None:
        written: list[Any] = []
        n1 = {"method": "chat.delta", "params": {}}
        outcome = _make_outcome(notifications=[n1], response=None)

        write_outcome_direct(outcome, write_message=written.append)

        assert written == [n1]

    def test_empty_outcome_writes_nothing(self) -> None:
        written: list[Any] = []
        outcome = _make_outcome(notifications=[], response=None)

        write_outcome_direct(outcome, write_message=written.append)

        assert written == []


# ---------------------------------------------------------------------------
# runtime_frame_writer
# ---------------------------------------------------------------------------


class TestRuntimeFrameWriter:
    def test_tool_request_approval_routed_to_send_control(self) -> None:
        transport = FakeTransport()
        write = runtime_frame_writer(transport)
        msg = {"method": "tool.request_approval", "params": {}}

        write(msg)

        assert transport.send_control_calls == [msg]
        assert transport.send_data_calls == []

    def test_other_method_routed_to_send_data(self) -> None:
        transport = FakeTransport()
        write = runtime_frame_writer(transport)
        msg = {"method": "chat.delta", "params": {"text": "hello"}}

        write(msg)

        assert transport.send_data_calls == [msg]
        assert transport.send_control_calls == []

    def test_non_dict_message_routed_to_send_control(self) -> None:
        transport = FakeTransport()
        write = runtime_frame_writer(transport)
        # A non-dict message has no 'method' key; falls through to send_control.
        msg = "raw string"

        write(msg)  # type: ignore[arg-type]

        assert transport.send_control_calls == [msg]
        assert transport.send_data_calls == []

    def test_dict_without_method_routed_to_send_control(self) -> None:
        transport = FakeTransport()
        write = runtime_frame_writer(transport)
        msg = {"jsonrpc": "2.0", "id": "5", "result": {}}

        write(msg)

        assert transport.send_control_calls == [msg]
        assert transport.send_data_calls == []

    def test_tool_request_approval_with_whitespace_routed_correctly(self) -> None:
        transport = FakeTransport()
        write = runtime_frame_writer(transport)
        msg = {"method": "  tool.request_approval  ", "params": {}}

        write(msg)

        assert transport.send_control_calls == [msg]
        assert transport.send_data_calls == []


# ---------------------------------------------------------------------------
# make_chat_send_worker — success path
# ---------------------------------------------------------------------------


class TestMakeChatSendWorkerSuccess:
    def test_send_outcome_called_and_unregister_turn_fires_in_finally(self) -> None:
        cancel_handle = FakeCancelHandle()
        transport = FakeTransport(cancel_handle=cancel_handle)
        logger = RecordingLogger()

        notif = {"method": "chat.delta", "params": {"text": "done"}}
        resp = {"jsonrpc": "2.0", "id": "req-1", "result": {}}
        outcome = _make_outcome(notifications=[notif], response=resp)

        def runner(msg: Any, *, write_frame: Any, approval_response_waiter_factory: Any, cancel_handle: Any) -> ProcessOutcome:
            return outcome

        worker = make_chat_send_worker(
            message={"jsonrpc": "2.0", "id": "req-1", "method": "chat.send", "params": {}},
            transport=transport,
            cancel_handle=cancel_handle,
            request_id="req-1",
            chat_send_runner=runner,
            logger=logger,
        )

        worker()

        # send_terminal_result should have been called (transport has the attr)
        assert len(transport.send_terminal_result_calls) == 1
        # unregister_turn must be called with correct args in finally
        assert len(transport.unregister_turn_calls) == 1
        call = transport.unregister_turn_calls[0]
        assert call["request_id"] == "req-1"
        assert call["expected_handle"] is cancel_handle

    def test_write_frame_routes_approval_to_send_control(self) -> None:
        cancel_handle = FakeCancelHandle()
        transport = FakeTransport(cancel_handle=cancel_handle)
        logger = RecordingLogger()

        outcome = _make_outcome(notifications=[], response=None)
        captured_write_frame = []

        def runner(msg: Any, *, write_frame: Any, approval_response_waiter_factory: Any, cancel_handle: Any) -> ProcessOutcome:
            captured_write_frame.append(write_frame)
            write_frame({"method": "tool.request_approval", "params": {}})
            return outcome

        worker = make_chat_send_worker(
            message={"id": "req-2"},
            transport=transport,
            cancel_handle=cancel_handle,
            request_id="req-2",
            chat_send_runner=runner,
            logger=logger,
        )
        worker()

        assert len(transport.send_control_calls) >= 1
        approval_calls = [c for c in transport.send_control_calls if isinstance(c, dict) and c.get("method") == "tool.request_approval"]
        assert len(approval_calls) == 1


# ---------------------------------------------------------------------------
# make_chat_send_worker — error path
# ---------------------------------------------------------------------------


class TestMakeChatSendWorkerError:
    def test_exception_triggers_send_control_with_error_code_minus32603(self) -> None:
        cancel_handle = FakeCancelHandle()
        transport = FakeTransport(cancel_handle=cancel_handle)
        logger = RecordingLogger()

        class SpecificError(RuntimeError):
            pass

        def runner(msg: Any, **kwargs: Any) -> ProcessOutcome:
            raise SpecificError("boom")

        worker = make_chat_send_worker(
            message={"jsonrpc": "2.0", "id": "err-req"},
            transport=transport,
            cancel_handle=cancel_handle,
            request_id="err-req",
            chat_send_runner=runner,
            logger=logger,
        )

        worker()

        assert len(transport.send_control_calls) == 1
        ctrl = transport.send_control_calls[0]
        assert ctrl["error"]["code"] == -32603
        assert "SpecificError" in ctrl["error"]["message"]
        assert ctrl["id"] == "err-req"

    def test_unregister_turn_still_called_after_exception(self) -> None:
        cancel_handle = FakeCancelHandle()
        transport = FakeTransport(cancel_handle=cancel_handle)
        logger = RecordingLogger()

        def runner(msg: Any, **kwargs: Any) -> ProcessOutcome:
            raise ValueError("worker exploded")

        worker = make_chat_send_worker(
            message={"id": "ex-req"},
            transport=transport,
            cancel_handle=cancel_handle,
            request_id="ex-req",
            chat_send_runner=runner,
            logger=logger,
        )

        worker()

        assert len(transport.unregister_turn_calls) == 1
        assert transport.unregister_turn_calls[0]["request_id"] == "ex-req"
        assert transport.unregister_turn_calls[0]["expected_handle"] is cancel_handle


# ---------------------------------------------------------------------------
# prune_finished_chat_workers
# ---------------------------------------------------------------------------


class FakeThread:
    def __init__(self, alive: bool) -> None:
        self._alive = alive

    def is_alive(self) -> bool:
        return self._alive


class TestPruneFinishedChatWorkers:
    def test_dead_thread_removed_from_set_and_handles_dict(self) -> None:
        dead = FakeThread(alive=False)
        live = FakeThread(alive=True)
        worker_threads: set[Any] = {dead, live}
        active_cancel_handles: dict[Any, Any] = {dead: FakeCancelHandle(), live: FakeCancelHandle()}

        prune_finished_chat_workers(worker_threads, active_cancel_handles)

        assert dead not in worker_threads
        assert dead not in active_cancel_handles
        assert live in worker_threads
        assert live in active_cancel_handles

    def test_live_thread_stays_in_set_and_handles_dict(self) -> None:
        live = FakeThread(alive=True)
        handle = FakeCancelHandle()
        worker_threads: set[Any] = {live}
        active_cancel_handles: dict[Any, Any] = {live: handle}

        prune_finished_chat_workers(worker_threads, active_cancel_handles)

        assert live in worker_threads
        assert active_cancel_handles[live] is handle

    def test_empty_set_is_a_noop(self) -> None:
        worker_threads: set[Any] = set()
        active_cancel_handles: dict[Any, Any] = {}

        prune_finished_chat_workers(worker_threads, active_cancel_handles)

        assert worker_threads == set()
        assert active_cancel_handles == {}


# ---------------------------------------------------------------------------
# start_chat_send_worker_if_allowed
# ---------------------------------------------------------------------------


def _base_message(request_id: str = "r1") -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "chat.send",
        "params": {"request_id": request_id},
    }


class TestStartChatSendWorkerIfAllowed:
    def test_plugin_authority_rejection_precedes_capacity_and_turn_registration(self) -> None:
        transport = FakeTransport()
        logger = RecordingLogger()

        class AuthorityConflict(RuntimeError):
            code = CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT
            reason_code = "plugin_authority_mismatch"
            retryable = True

        result = start_chat_send_worker_if_allowed(
            message=_base_message("stale-plugin-authority"),
            transport=transport,
            worker_threads={FakeThread(alive=True)},
            active_cancel_handles={},
            chat_send_runner=lambda *a, **kw: _make_outcome(),
            logger=logger,
            max_active_workers=1,
            plugin_admission_resolver=lambda _message: (_ for _ in ()).throw(
                AuthorityConflict("stale")
            ),
        )

        assert result is False
        assert transport.register_turn_calls == []
        assert transport.send_data_calls == []
        error_data = transport.send_control_calls[0]["error"]["data"]
        assert error_data["code"] == CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT
        assert error_data["reason"] == "plugin_authority_mismatch"

    def test_returns_false_and_send_control_when_at_capacity(self) -> None:
        transport = FakeTransport()
        logger = RecordingLogger()

        # Fill the worker set with 2 fake live threads up to capacity=2
        t1 = FakeThread(alive=True)
        t2 = FakeThread(alive=True)
        worker_threads: set[Any] = {t1, t2}
        active_cancel_handles: dict[Any, Any] = {t1: FakeCancelHandle(), t2: FakeCancelHandle()}

        result = start_chat_send_worker_if_allowed(
            message=_base_message(),
            transport=transport,
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            chat_send_runner=lambda *a, **kw: _make_outcome(),
            logger=logger,
            max_active_workers=2,
        )

        assert result is False
        assert len(transport.send_control_calls) == 1
        ctrl = transport.send_control_calls[0]
        assert ctrl["error"]["data"]["code"] == CMP_RESOURCE_EXCEEDED

    def test_capacity_rejection_releases_prepared_plugin_admission(self) -> None:
        transport = FakeTransport()
        logger = RecordingLogger()

        class Admission:
            released = False

            def release(self) -> None:
                self.released = True

        admission = Admission()
        result = start_chat_send_worker_if_allowed(
            message=_base_message("capacity-plugin"),
            transport=transport,
            worker_threads={FakeThread(alive=True)},
            active_cancel_handles={},
            chat_send_runner=lambda *a, **kw: _make_outcome(),
            logger=logger,
            max_active_workers=1,
            plugin_admission_resolver=lambda _message: admission,
        )

        assert result is False
        assert admission.released is True
        assert transport.register_turn_calls == []

    def test_returns_false_and_no_thread_when_at_capacity(self) -> None:
        transport = FakeTransport()
        logger = RecordingLogger()
        t1 = FakeThread(alive=True)
        worker_threads: set[Any] = {t1}
        active_cancel_handles: dict[Any, Any] = {t1: FakeCancelHandle()}

        result = start_chat_send_worker_if_allowed(
            message=_base_message(),
            transport=transport,
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            chat_send_runner=lambda *a, **kw: _make_outcome(),
            logger=logger,
            max_active_workers=1,
        )

        assert result is False
        # No new thread added
        assert len(worker_threads) == 1

    def test_duplicate_request_id_error_returns_false_with_dup_code(self) -> None:
        transport = FakeTransport()
        logger = RecordingLogger()
        worker_threads: set[Any] = set()
        active_cancel_handles: dict[Any, Any] = {}

        def bad_register(**kw: Any) -> None:
            raise DuplicateRequestIdError("dup")

        transport.register_turn = bad_register  # type: ignore[method-assign]

        result = start_chat_send_worker_if_allowed(
            message=_base_message("dup-req"),
            transport=transport,
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            chat_send_runner=lambda *a, **kw: _make_outcome(),
            logger=logger,
            max_active_workers=10,
        )

        assert result is False
        assert len(transport.send_control_calls) == 1
        ctrl = transport.send_control_calls[0]
        assert ctrl["error"]["data"]["code"] == CMP_PROTO_DUPLICATE_REQUEST_ID

    def test_active_turn_limit_exceeded_returns_false_with_resource_exceeded_code(self) -> None:
        transport = FakeTransport()
        logger = RecordingLogger()
        worker_threads: set[Any] = set()
        active_cancel_handles: dict[Any, Any] = {}

        def bad_register(**kw: Any) -> None:
            raise ActiveTurnLimitExceededError("limit")

        transport.register_turn = bad_register  # type: ignore[method-assign]

        result = start_chat_send_worker_if_allowed(
            message=_base_message("lim-req"),
            transport=transport,
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            chat_send_runner=lambda *a, **kw: _make_outcome(),
            logger=logger,
            max_active_workers=10,
        )

        assert result is False
        assert len(transport.send_control_calls) == 1
        ctrl = transport.send_control_calls[0]
        assert ctrl["error"]["data"]["code"] == CMP_RESOURCE_EXCEEDED

    def test_duplicate_session_turn_returns_structured_session_busy(self) -> None:
        transport = FakeTransport()
        logger = RecordingLogger()

        def busy_register(**kw: Any) -> None:
            raise DuplicateSessionTurnError("busy")

        transport.register_turn = busy_register  # type: ignore[method-assign]
        message = _base_message("busy-req")
        message["params"].update({"session_id": "session-1", "generation": 4})

        result = start_chat_send_worker_if_allowed(
            message=message,
            transport=transport,
            worker_threads=set(),
            active_cancel_handles={},
            chat_send_runner=lambda *a, **kw: _make_outcome(),
            logger=logger,
            max_active_workers=10,
        )

        assert result is False
        error_data = transport.send_control_calls[0]["error"]["data"]
        assert error_data["code"] == CMP_RESOURCE_EXCEEDED
        assert error_data["reason"] == "session_busy"
        assert error_data["session_id"] == "session-1"

    def test_success_returns_true_thread_added_to_workers(self) -> None:
        cancel_handle = FakeCancelHandle()
        transport = FakeTransport(cancel_handle=cancel_handle)
        logger = RecordingLogger()
        worker_threads: set[Any] = set()
        active_cancel_handles: dict[Any, Any] = {}

        done_event = threading.Event()

        def fast_runner(msg: Any, **kwargs: Any) -> ProcessOutcome:
            done_event.set()
            return _make_outcome()

        result = start_chat_send_worker_if_allowed(
            message=_base_message("ok-req"),
            transport=transport,
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            chat_send_runner=fast_runner,
            logger=logger,
            max_active_workers=5,
        )

        assert result is True
        assert len(worker_threads) == 1

        # Join the thread so we can safely assert unregister_turn fired
        spawned_thread = next(iter(worker_threads))
        spawned_thread.join(timeout=5.0)
        assert not spawned_thread.is_alive(), "worker thread should have finished"

        assert len(transport.unregister_turn_calls) == 1
        assert transport.unregister_turn_calls[0]["request_id"] == "ok-req"
        assert transport.unregister_turn_calls[0]["expected_handle"] is cancel_handle

    def test_success_active_cancel_handles_maps_thread_to_handle(self) -> None:
        cancel_handle = FakeCancelHandle()
        transport = FakeTransport(cancel_handle=cancel_handle)
        logger = RecordingLogger()
        worker_threads: set[Any] = set()
        active_cancel_handles: dict[Any, Any] = {}

        barrier = threading.Barrier(2)

        def slow_runner(msg: Any, **kwargs: Any) -> ProcessOutcome:
            barrier.wait(timeout=5.0)
            return _make_outcome()

        result = start_chat_send_worker_if_allowed(
            message=_base_message("handle-req"),
            transport=transport,
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            chat_send_runner=slow_runner,
            logger=logger,
            max_active_workers=5,
        )

        assert result is True
        spawned_thread = next(iter(worker_threads))
        # The handle must be in the map before the runner even returns
        assert active_cancel_handles.get(spawned_thread) is cancel_handle
        # Release the runner
        barrier.wait(timeout=5.0)
        spawned_thread.join(timeout=5.0)


# ---------------------------------------------------------------------------
# cancel_and_join_live_chat_workers
# ---------------------------------------------------------------------------


class FakeJoinableThread:
    """Thread-like object whose liveness can be controlled for tests."""

    def __init__(self, *, alive_sequence: list[bool]) -> None:
        # Each call to is_alive() pops from the front; last value is repeated.
        self._alive_sequence = list(alive_sequence)
        self.join_calls: list[dict[str, Any]] = []

    def is_alive(self) -> bool:
        if len(self._alive_sequence) > 1:
            return self._alive_sequence.pop(0)
        return self._alive_sequence[0]

    def join(self, timeout: float | None = None) -> None:
        self.join_calls.append({"timeout": timeout})


class TestCancelAndJoinLiveChatWorkers:
    def test_cancel_called_with_sidecar_shutdown_on_live_threads(self) -> None:
        handle1 = FakeCancelHandle()
        handle2 = FakeCancelHandle()
        t1 = FakeJoinableThread(alive_sequence=[True, False])
        t2 = FakeJoinableThread(alive_sequence=[True, False])
        worker_threads: set[Any] = {t1, t2}
        active_cancel_handles: dict[Any, Any] = {t1: handle1, t2: handle2}
        logger = RecordingLogger()

        cancel_and_join_live_chat_workers(
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            shutdown_worker_grace_seconds=1.0,
            logger=logger,
        )

        assert len(handle1.cancel_calls) == 1
        assert handle1.cancel_calls[0]["reason"] == "sidecar_shutdown"
        assert len(handle2.cancel_calls) == 1
        assert handle2.cancel_calls[0]["reason"] == "sidecar_shutdown"

    def test_join_called_on_live_threads(self) -> None:
        handle = FakeCancelHandle()
        t1 = FakeJoinableThread(alive_sequence=[True, False])
        worker_threads: set[Any] = {t1}
        active_cancel_handles: dict[Any, Any] = {t1: handle}
        logger = RecordingLogger()

        cancel_and_join_live_chat_workers(
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            shutdown_worker_grace_seconds=1.0,
            logger=logger,
        )

        assert len(t1.join_calls) == 1

    def test_dead_threads_not_cancelled(self) -> None:
        handle = FakeCancelHandle()
        dead = FakeJoinableThread(alive_sequence=[False])
        live = FakeJoinableThread(alive_sequence=[True, False])
        live_handle = FakeCancelHandle()
        worker_threads: set[Any] = {dead, live}
        active_cancel_handles: dict[Any, Any] = {dead: handle, live: live_handle}
        logger = RecordingLogger()

        cancel_and_join_live_chat_workers(
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            shutdown_worker_grace_seconds=1.0,
            logger=logger,
        )

        # Dead thread's handle must NOT be cancelled
        assert len(handle.cancel_calls) == 0
        # Live thread's handle must be cancelled
        assert len(live_handle.cancel_calls) == 1

    def test_abandoned_workers_trigger_warning_log(self) -> None:
        """If a thread stays alive past grace period, the warning fires."""
        handle = FakeCancelHandle()
        # always alive — never finishes
        always_alive = FakeJoinableThread(alive_sequence=[True, True, True])
        worker_threads: set[Any] = {always_alive}
        active_cancel_handles: dict[Any, Any] = {always_alive: handle}
        logger = RecordingLogger()

        cancel_and_join_live_chat_workers(
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            shutdown_worker_grace_seconds=0.01,
            logger=logger,
        )

        assert len(logger.warning_calls) >= 1
        warning = logger.warning_calls[-1]
        extra = warning.get("extra") or {}
        assert extra.get("event") == "sidecar.shutdown.workers_abandoned"
        assert extra.get("abandoned_count") == 1

    def test_no_warning_when_all_threads_finish(self) -> None:
        handle = FakeCancelHandle()
        t1 = FakeJoinableThread(alive_sequence=[True, False])
        worker_threads: set[Any] = {t1}
        active_cancel_handles: dict[Any, Any] = {t1: handle}
        logger = RecordingLogger()

        cancel_and_join_live_chat_workers(
            worker_threads=worker_threads,
            active_cancel_handles=active_cancel_handles,
            shutdown_worker_grace_seconds=1.0,
            logger=logger,
        )

        # No abandoned warning should have been logged
        abandoned_warnings = [
            w for w in logger.warning_calls
            if (w.get("extra") or {}).get("event") == "sidecar.shutdown.workers_abandoned"
        ]
        assert abandoned_warnings == []


# ---------------------------------------------------------------------------
# JCA-007: worker startup failure must not leak the registered turn
# ---------------------------------------------------------------------------


def test_worker_start_failure_releases_the_registered_turn(monkeypatch) -> None:
    """Thread construction/start raising after register_turn must unregister
    the turn and clear the local bookkeeping, or the session stays reserved in
    the multiplexer and every later same-session turn is rejected until
    restart (the worker body's ``finally`` is unreachable here)."""

    class _FailingThread:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def is_alive(self) -> bool:
            return False

        def start(self) -> None:
            raise RuntimeError("thread start failed")

    monkeypatch.setattr(chat_workers_module.threading, "Thread", _FailingThread)
    cancel_handle = FakeCancelHandle()
    transport = FakeTransport(cancel_handle=cancel_handle)
    worker_threads: set[Any] = set()
    active_cancel_handles: dict[Any, Any] = {}
    logger = RecordingLogger()

    started = start_chat_send_worker_if_allowed(
        message={
            "jsonrpc": "2.0",
            "id": 7,
            "method": "chat.send",
            "params": {"request_id": "req-7", "session_id": "sess-7"},
        },
        transport=transport,  # type: ignore[arg-type]
        worker_threads=worker_threads,
        active_cancel_handles=active_cancel_handles,
        chat_send_runner=lambda *_args, **_kwargs: _make_outcome(),
        logger=logger,
        max_active_workers=4,
    )

    assert started is False
    assert worker_threads == set(), "no dead thread left in the worker set"
    assert active_cancel_handles == {}, "no cancel handle left for a dead thread"
    assert transport.unregister_turn_calls == [
        {"request_id": "req-7", "expected_handle": cancel_handle}
    ], "the registered turn is released so the session is not wedged"
    error = transport.send_control_calls[-1]
    assert error["id"] == 7
    assert error["error"]["data"]["reason"] == "worker_start_failed"
