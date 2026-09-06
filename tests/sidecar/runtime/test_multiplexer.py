from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Iterator

import pytest

from sidecar.ai import engine_liveness
from sidecar.protocol import API_VERSION, CHAT_CANCEL_METHOD
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.framing import encode_framed_body
from sidecar.runtime.message_reader import ReaderDrainResult
from sidecar.runtime.multiplexer import (
    ActiveTurnLimitExceededError,
    ApprovalResponseCancelledError,
    DuplicateRequestIdError,
    DuplicateSessionTurnError,
    PrioritizedMessageWriter,
    StdioTransportMultiplexer,
    SubAgentSlotAllocator,
    SubAgentSlotLimitExceededError,
    SubAgentSlotPerParentLimitExceededError,
    TransportBackpressureError,
    TurnCancellationHandle,
    WriterDrainResult,
)


@pytest.fixture
def isolated_engine_liveness_state() -> Iterator[None]:
    with engine_liveness._state.lock:  # noqa: SLF001
        engine_liveness._state.last_activity_monotonic = None  # noqa: SLF001
        engine_liveness._state.active_generations = 0  # noqa: SLF001
    yield
    with engine_liveness._state.lock:  # noqa: SLF001
        engine_liveness._state.last_activity_monotonic = None  # noqa: SLF001
        engine_liveness._state.active_generations = 0  # noqa: SLF001


def _queued_reader(items: "queue.Queue[dict[str, object]]"):
    def _read() -> dict[str, object]:
        item = items.get(timeout=1.0)
        if isinstance(item, BaseException):
            raise item
        return item

    return _read


def test_chat_cancel_tombstone_replays_on_late_turn_registration() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    written: list[dict[str, object]] = []
    logger = logging.getLogger("tests.multiplexer")
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=written.append,
        logger=logger,
    )
    try:
        incoming.put(
            {
                "jsonrpc": "2.0",
                "id": 41,
                "method": "chat.cancel",
                "params": {
                    "accept_version": API_VERSION,
                    "request_id": "req_tombstone",
                    "trace_id": "trace_tombstone",
                },
            }
        )
        incoming.put(
            {
                "jsonrpc": "2.0",
                "id": 42,
                "method": "initialize",
                "params": {},
            }
        )

        message = multiplexer.read_request()

        assert message["method"] == "initialize"
        handle = multiplexer.register_turn(
            request_id="req_tombstone",
            trace_id="trace_tombstone",
            session_id=None,
        )
        assert handle.cancelled is True
        deadline = time.monotonic() + 1.0
        while not written and time.monotonic() < deadline:
            time.sleep(0.01)
        assert written
        assert written[0]["result"]["status"] == "cancel_queued"
        assert written[0]["result"]["tombstone_hit"] is False
    finally:
        multiplexer.close()


def test_approval_reader_factory_cancels_when_turn_is_cancelled() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        handle = multiplexer.register_turn(
            request_id="req_cancel_wait",
            trace_id="trace_cancel_wait",
            session_id=None,
        )
        reader = multiplexer.approval_reader_factory(1001, cancel_handle=handle)

        def _cancel() -> None:
            time.sleep(0.05)
            handle.cancel(reason="chat_cancel")

        thread = threading.Thread(target=_cancel, daemon=True)
        thread.start()
        with pytest.raises(ApprovalResponseCancelledError):
            reader(1.0)
        thread.join(timeout=1.0)
    finally:
        multiplexer.close()


def test_turn_cancellation_handle_runs_registered_close_callbacks_once() -> None:
    handle = TurnCancellationHandle(request_id="req_callbacks")
    calls: list[str] = []

    unregister_first = handle.register_cancel_callback(lambda _reason: calls.append("first"))
    handle.register_cancel_callback(lambda reason: calls.append(f"second:{reason}"))
    unregister_first()

    assert handle.cancel(reason="chat_cancel") is True
    assert handle.cancel(reason="chat_cancel") is False
    handle.register_cancel_callback(lambda reason: calls.append(f"late:{reason}"))

    assert calls == ["second:sidecar_cancel", "late:sidecar_cancel"]


def test_chat_cancel_reason_round_trips_to_handle_and_terminal_subcode() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        handle = multiplexer.register_turn(
            request_id="req_reason",
            trace_id="trace_reason",
            session_id="session_reason",
        )
        incoming.put(
            {
                "jsonrpc": "2.0",
                "id": 44,
                "method": "chat.cancel",
                "params": {
                    "accept_version": API_VERSION,
                    "request_id": "req_reason",
                    "trace_id": "trace_reason",
                    "session_id": "session_reason",
                    "cancel_reason": "user_cancel",
                },
            }
        )
        incoming.put({"jsonrpc": "2.0", "id": 45, "method": "shutdown", "params": {}})

        assert multiplexer.read_request()["method"] == "shutdown"
        assert handle.cancelled is True
        assert handle.reason == "user_cancel"
        with pytest.raises(TerminalChatStateError) as exc:
            handle.raise_if_cancelled()
        assert exc.value.terminal_subcode == "user_cancel"
    finally:
        multiplexer.close()


def test_duplicate_turn_registration_is_rejected_without_replacing_original() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        original = multiplexer.register_turn(
            request_id="req_duplicate",
            trace_id="trace_original",
            session_id="session_original",
        )

        with pytest.raises(DuplicateRequestIdError):
            multiplexer.register_turn(
                request_id="req_duplicate",
                trace_id="trace_second",
                session_id="session_second",
            )

        incoming.put(
            {
                "jsonrpc": "2.0",
                "id": 46,
                "method": "chat.cancel",
                "params": {
                    "accept_version": API_VERSION,
                    "request_id": "req_duplicate",
                    "cancel_reason": "user_cancel",
                },
            }
        )
        incoming.put({"jsonrpc": "2.0", "id": 47, "method": "shutdown", "params": {}})

        assert multiplexer.read_request()["method"] == "shutdown"
        assert original.cancelled is True
        assert original.reason == "user_cancel"
    finally:
        multiplexer.close()


def test_unregister_turn_preserves_newer_handle_when_expected_handle_differs() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        original = multiplexer.register_turn(
            request_id="req_identity",
            trace_id="trace_identity",
            session_id=None,
        )
        stale = TurnCancellationHandle(request_id="req_identity")

        multiplexer.unregister_turn("req_identity", expected_handle=stale)

        incoming.put(
            {
                "jsonrpc": "2.0",
                "id": 48,
                "method": "chat.cancel",
                "params": {
                    "accept_version": API_VERSION,
                    "request_id": "req_identity",
                    "cancel_reason": "user_cancel",
                },
            }
        )
        incoming.put({"jsonrpc": "2.0", "id": 49, "method": "shutdown", "params": {}})

        assert multiplexer.read_request()["method"] == "shutdown"
        assert original.cancelled is True
    finally:
        multiplexer.close()


def test_register_turn_enforces_active_turn_cap() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer"),
        max_active_turns=2,
    )
    try:
        multiplexer.register_turn(request_id="req_one", trace_id=None, session_id=None)
        multiplexer.register_turn(request_id="req_two", trace_id=None, session_id=None)

        with pytest.raises(ActiveTurnLimitExceededError):
            multiplexer.register_turn(request_id="req_three", trace_id=None, session_id=None)
    finally:
        multiplexer.close()


def test_sub_agent_slot_allocator_enforces_pool_and_per_parent_limits() -> None:
    allocator = SubAgentSlotAllocator(max_active_sub_agents=2, max_sub_agents_per_parent=1)

    parent_one = allocator.acquire(parent_agent_id="parent-1", agent_id="child-1")
    parent_two = allocator.acquire(parent_agent_id="parent-2", agent_id="child-2")

    with pytest.raises(SubAgentSlotPerParentLimitExceededError):
        allocator.acquire(parent_agent_id="parent-1", agent_id="child-3")
    with pytest.raises(SubAgentSlotLimitExceededError):
        allocator.acquire(parent_agent_id="parent-3", agent_id="child-4")

    parent_one.release()
    parent_three = allocator.acquire(parent_agent_id="parent-3", agent_id="child-4")

    assert allocator.snapshot()["active_sub_agents"] == 2
    parent_two.release()
    parent_three.release()
    assert allocator.snapshot()["active_sub_agents"] == 0


def test_sub_agent_slot_allocator_defaults_to_one_active_child() -> None:
    allocator = SubAgentSlotAllocator()
    first = allocator.acquire(parent_agent_id="parent-1", agent_id="child-1")

    with pytest.raises(SubAgentSlotLimitExceededError):
        allocator.acquire(parent_agent_id="parent-2", agent_id="child-2")

    first.release()
    assert allocator.snapshot() == {
        "active_sub_agents": 0,
        "max_active_sub_agents": 1,
        "max_sub_agents_per_parent": 1,
        "active_parent_count": 0,
    }


def test_sub_agent_slot_allocator_reserves_multiple_slots_atomically() -> None:
    allocator = SubAgentSlotAllocator(max_active_sub_agents=3, max_sub_agents_per_parent=3)

    leases = allocator.acquire_many(
        parent_agent_id="parent-1",
        agent_ids=("child-1", "child-2", "child-3"),
    )

    assert allocator.snapshot()["active_sub_agents"] == 3
    for lease in leases:
        lease.release()
        lease.release()
    assert allocator.snapshot()["active_sub_agents"] == 0


def test_sub_agent_multi_slot_failure_leaves_allocator_unchanged() -> None:
    allocator = SubAgentSlotAllocator(max_active_sub_agents=2, max_sub_agents_per_parent=2)
    existing = allocator.acquire(parent_agent_id="parent-1", agent_id="child-1")
    before = allocator.snapshot()

    with pytest.raises(SubAgentSlotLimitExceededError):
        allocator.acquire_many(
            parent_agent_id="parent-2",
            agent_ids=("child-2", "child-3"),
        )

    assert allocator.snapshot() == before
    existing.release()


def test_parent_cancellation_handle_cancels_child_handles() -> None:
    parent = TurnCancellationHandle(request_id="req_parent")
    child = parent.create_child(request_id="req_child")

    parent.cancel(reason="user_cancel")

    assert child.cancelled is True
    assert child.reason == "user_cancel"


def test_cancel_tombstones_are_capped_and_warn_when_oldest_is_evicted(caplog) -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer"),
        max_cancel_tombstones=3,
    )
    try:
        with caplog.at_level(logging.WARNING):
            for index in range(4):
                incoming.put(
                    {
                        "jsonrpc": "2.0",
                        "method": "chat.cancel",
                        "params": {
                            "accept_version": API_VERSION,
                            "request_id": f"missing-{index}",
                        },
                    }
                )
            incoming.put({"jsonrpc": "2.0", "id": 50, "method": "shutdown", "params": {}})
            assert multiplexer.read_request()["method"] == "shutdown"

        assert len(multiplexer._cancel_tombstones) == 3  # noqa: SLF001
        assert "missing-0" not in multiplexer._cancel_tombstones  # noqa: SLF001
        assert any(
            getattr(record, "event", "") == "sidecar.runtime.cancel_tombstone_evicted"
            for record in caplog.records
        )
    finally:
        multiplexer.close()


def test_duplicate_approval_response_logs_unmatched_after_waiter_clears(caplog) -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        reader = multiplexer.approval_reader_factory(1002)
        incoming.put({"jsonrpc": "2.0", "id": 1002, "result": {"approved": True}})
        incoming.put({"jsonrpc": "2.0", "id": 1002, "result": {"approved": True}})
        incoming.put({"jsonrpc": "2.0", "id": 43, "method": "initialize", "params": {}})

        assert multiplexer.read_request()["method"] == "initialize"
        assert reader(0.2)["result"]["approved"] is True

        with caplog.at_level(logging.WARNING):
            incoming.put({"jsonrpc": "2.0", "id": 1002, "result": {"approved": True}})
            incoming.put({"jsonrpc": "2.0", "id": 44, "method": "shutdown", "params": {}})
            assert multiplexer.read_request()["method"] == "shutdown"

        assert any(
            getattr(record, "event", "") == "sidecar.runtime.transport.unmatched_response"
            for record in caplog.records
        )
    finally:
        multiplexer.close()


def test_fractional_approval_id_cannot_target_integer_waiter(caplog) -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    written: list[dict[str, object]] = []
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=written.append,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        reader = multiplexer.approval_reader_factory(1002)
        incoming.put({"jsonrpc": "2.0", "id": 1002.5, "result": {"approved": True}})
        incoming.put({"jsonrpc": "2.0", "id": 44, "method": "shutdown", "params": {}})

        with caplog.at_level(logging.WARNING):
            assert multiplexer.read_request()["method"] == "shutdown"

        with pytest.raises(TimeoutError):
            reader(0.05)
        deadline = time.monotonic() + 1.0
        while not written and time.monotonic() < deadline:
            time.sleep(0.01)
        assert written[0]["id"] is None
        assert written[0]["error"]["code"] == -32600
        assert any(
            getattr(record, "event", "") == "sidecar.runtime.transport.invalid_envelope"
            for record in caplog.records
        )
    finally:
        multiplexer.close()


def test_malformed_or_mismatched_cancel_is_rejected_before_side_effect() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    written: list[dict[str, object]] = []
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=written.append,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        handle = multiplexer.register_turn(
            request_id="req-protected", trace_id=None, session_id=None
        )
        incoming.put(
            {
                "jsonrpc": "1.0",
                "id": 70,
                "method": "chat.cancel",
                "params": {
                    "accept_version": API_VERSION,
                    "request_id": "req-protected",
                },
            }
        )
        incoming.put(
            {
                "jsonrpc": "2.0",
                "id": 71,
                "method": "chat.cancel",
                "params": {
                    "accept_version": "old",
                    "request_id": "req-protected",
                },
            }
        )
        incoming.put({"jsonrpc": "2.0", "id": 72, "method": "shutdown", "params": {}})

        assert multiplexer.read_request()["method"] == "shutdown"
        assert handle.cancelled is False
        deadline = time.monotonic() + 1.0
        while len(written) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert sorted(message["error"]["code"] for message in written) == [-32602, -32600]
    finally:
        multiplexer.close()


def test_outbound_writer_raises_transport_backpressure(caplog) -> None:
    writer = PrioritizedMessageWriter(
        write_message=lambda _message: time.sleep(0.2),
        logger=logging.getLogger("tests.multiplexer"),
        high_water_mark_bytes=1024,
    )
    try:
        with caplog.at_level(logging.WARNING), pytest.raises(TransportBackpressureError):
            writer.enqueue(
                {
                    "jsonrpc": "2.0",
                    "method": "chat.token",
                    "params": {"delta": "x" * 4096},
                },
                control=False,
            )
        assert any(
            getattr(record, "event", "") == (
                "sidecar.runtime.transport_backpressure_soft_warning"
            )
            for record in caplog.records
        )
    finally:
        writer.close()


def test_outbound_writer_warns_before_transport_backpressure(caplog) -> None:
    writer = PrioritizedMessageWriter(
        write_message=lambda _message: time.sleep(0.2),
        logger=logging.getLogger("tests.multiplexer"),
        high_water_mark_bytes=2048,
    )
    try:
        with caplog.at_level(logging.WARNING):
            writer.enqueue(
                {
                    "jsonrpc": "2.0",
                    "method": "chat.token",
                    "params": {"delta": "x" * 1300},
                },
                control=False,
            )

        warnings = [
            record
            for record in caplog.records
            if getattr(record, "event", "") == (
                "sidecar.runtime.transport_backpressure_soft_warning"
            )
        ]
        assert warnings
        assert getattr(warnings[0], "soft_water_mark_bytes", 0) > 0
        assert getattr(warnings[0], "high_water_mark_bytes", 0) == 2048
    finally:
        writer.close()


def test_outbound_writer_stops_after_first_write_error_and_reports_abandoned(caplog) -> None:
    calls: list[dict[str, object]] = []

    def _raise_on_write(message: dict[str, object]) -> None:
        calls.append(message)
        raise BrokenPipeError("pipe closed")

    writer = PrioritizedMessageWriter(
        write_message=_raise_on_write,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        with caplog.at_level(logging.WARNING):
            for index in range(3):
                writer.enqueue(
                    {
                        "jsonrpc": "2.0",
                        "method": "chat.token",
                        "params": {"delta": str(index)},
                    },
                    control=False,
                )
            deadline = time.monotonic() + 1.0
            while writer._write_error is None and time.monotonic() < deadline:  # noqa: SLF001
                time.sleep(0.01)
            writer.close()

        assert len(calls) == 1
        abandoned_records = [
            record
            for record in caplog.records
            if getattr(record, "event", "") == "sidecar.runtime.transport.write_abandoned"
        ]
        assert abandoned_records
        assert getattr(abandoned_records[0], "abandoned_count", 0) >= 2
        with pytest.raises(BrokenPipeError):
            writer.enqueue(
                {
                    "jsonrpc": "2.0",
                    "method": "chat.token",
                    "params": {"delta": "after-failure"},
                },
                control=False,
            )
        assert writer._buffered_bytes == 0  # noqa: SLF001
    finally:
        writer.close()


def test_terminal_result_preserves_final_notifications_before_response() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    written: list[dict[str, object]] = []
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=written.append,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        token = {
            "jsonrpc": "2.0",
            "method": "chat.token",
            "params": {"request_id": "req_terminal", "delta": "Generation timed out"},
        }
        done = {
            "jsonrpc": "2.0",
            "method": "chat.done",
            "params": {"request_id": "req_terminal"},
        }
        response = {
            "jsonrpc": "2.0",
            "id": 55,
            "result": {"request_id": "req_terminal", "status": "completed"},
        }

        multiplexer.send_terminal_result([token, done], response)

        deadline = time.monotonic() + 1.0
        while len(written) < 3 and time.monotonic() < deadline:
            time.sleep(0.01)

        assert [item.get("method") for item in written[:2]] == ["chat.token", "chat.done"]
        assert written[2]["result"]["request_id"] == "req_terminal"
    finally:
        multiplexer.close()


def test_session_single_flight_rejects_non_superseding_generation() -> None:
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(queue.Queue()),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        original = multiplexer.register_turn(
            request_id="req_session_1",
            trace_id="trace_1",
            session_id="session_shared",
            generation=5,
        )

        with pytest.raises(DuplicateSessionTurnError):
            multiplexer.register_turn(
                request_id="req_session_2",
                trace_id="trace_2",
                session_id="session_shared",
                generation=5,
            )

        assert original.cancelled is False
    finally:
        multiplexer.close()


def test_session_single_flight_allows_newer_generation_and_preempts_old() -> None:
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(queue.Queue()),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        original = multiplexer.register_turn(
            request_id="req_session_old",
            trace_id="trace_old",
            session_id="session_shared",
            generation=5,
        )
        replacement = multiplexer.register_turn(
            request_id="req_session_new",
            trace_id="trace_new",
            session_id="session_shared",
            generation=6,
        )

        assert original.cancelled is True
        assert original.reason == "sidecar_cancel"
        assert replacement.cancelled is False
        multiplexer.unregister_turn("req_session_old", expected_handle=original)
        assert multiplexer._active_turns_by_session["session_shared"] is replacement  # noqa: SLF001
    finally:
        multiplexer.close()


def test_terminal_bundle_admission_is_all_or_none() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    written: list[dict[str, object]] = []
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=written.append,
        logger=logging.getLogger("tests.multiplexer"),
        high_water_mark_bytes=1024,
        control_reserve_bytes=256,
    )
    try:
        notifications = [
            {
                "jsonrpc": "2.0",
                "method": "chat.done",
                "params": {"request_id": "req_atomic", "summary": "x" * 700},
            }
        ]
        response = {
            "jsonrpc": "2.0",
            "id": 99,
            "result": {"request_id": "req_atomic", "summary": "y" * 700},
        }

        before = multiplexer._writer.stats()  # noqa: SLF001
        with pytest.raises(TransportBackpressureError):
            multiplexer.send_terminal_result(notifications, response)
        after = multiplexer._writer.stats()  # noqa: SLF001

        assert after["buffered_bytes"] == before["buffered_bytes"] == 0
        assert after["pending_frames"] == before["pending_frames"] == 0
        assert written == []
    finally:
        multiplexer.close()


def test_writer_close_reports_drained_delivery() -> None:
    written: list[dict[str, object]] = []
    writer = PrioritizedMessageWriter(
        write_message=written.append,
        logger=logging.getLogger("tests.multiplexer"),
    )
    writer.enqueue({"jsonrpc": "2.0", "id": 1, "result": {}}, control=True)

    result = writer.close(join_timeout_seconds=1.0)

    assert result.drained is True
    assert result.pending_frames == 0
    assert result.pending_bytes == 0
    assert result.worker_alive is False
    assert result.write_error_type is None
    assert len(written) == 1


def test_writer_close_reports_undrained_inflight_frame() -> None:
    entered = threading.Event()
    release = threading.Event()

    def _blocking_write(_message: dict[str, object]) -> None:
        entered.set()
        release.wait(timeout=2.0)

    writer = PrioritizedMessageWriter(
        write_message=_blocking_write,
        logger=logging.getLogger("tests.multiplexer"),
    )
    writer.enqueue({"jsonrpc": "2.0", "id": 1, "result": {}}, control=True)
    assert entered.wait(timeout=1.0)

    result = writer.close(join_timeout_seconds=0.01)

    assert result.drained is False
    assert result.pending_frames == 1
    assert result.pending_bytes > 0
    assert result.worker_alive is True
    release.set()
    assert writer.close(join_timeout_seconds=1.0).drained is True


def test_transport_close_shares_one_deadline_between_reader_and_writer() -> None:
    reader_timeouts: list[float] = []
    writer_timeouts: list[float] = []

    class SlowReader:
        def __init__(self, _reader) -> None:
            pass

        def close(self, join_timeout_seconds: float) -> ReaderDrainResult:
            reader_timeouts.append(join_timeout_seconds)
            time.sleep(0.03)
            return ReaderDrainResult(drained=True, worker_alive=False)

    multiplexer = StdioTransportMultiplexer(
        reader=lambda: {"jsonrpc": "2.0", "method": "noop"},
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer.deadline"),
        message_reader_cls=SlowReader,
    )
    original_writer = multiplexer._writer  # noqa: SLF001
    original_writer.close(join_timeout_seconds=1.0)

    class RecordingWriter:
        def close(self, join_timeout_seconds: float) -> WriterDrainResult:
            writer_timeouts.append(join_timeout_seconds)
            return WriterDrainResult(True, 0, 0, False, None)

    multiplexer._writer = RecordingWriter()  # type: ignore[assignment] # noqa: SLF001
    result = multiplexer.close(timeout_seconds=0.05)

    assert result.drained is True
    assert reader_timeouts[0] <= 0.05 + 1e-9
    assert 0.0 <= writer_timeouts[0] < reader_timeouts[0]


def _sized_data_message(target_bytes: int, *, request_id: str) -> dict[str, object]:
    """Build a chat.token data-lane frame padded to ~target_bytes on the wire."""
    message: dict[str, object] = {
        "jsonrpc": "2.0",
        "method": "chat.token",
        "params": {"request_id": request_id, "delta": ""},
    }
    base_size = len(encode_framed_body(message))
    pad_len = max(target_bytes - base_size, 0)
    message["params"]["delta"] = "x" * pad_len  # type: ignore[index]
    return message


@pytest.mark.parametrize("backlog_lane", ["data", "terminal"])
def test_noncontrol_backlog_cannot_consume_reserved_cancel_ack_capacity(
    caplog,
    backlog_lane: str,
) -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    release_writer = threading.Event()

    def _blocking_write(_message: dict[str, object]) -> None:
        release_writer.wait(timeout=2.0)

    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=_blocking_write,
        logger=logging.getLogger("tests.multiplexer"),
        high_water_mark_bytes=1024,
    )
    try:
        handle = multiplexer.register_turn(
            request_id="req_backpressure_cancel",
            trace_id=None,
            session_id=None,
        )

        data_limit = multiplexer._writer.stats()["data_high_water_mark_bytes"]  # noqa: SLF001
        backlog = _sized_data_message(
            data_limit - 20,
            request_id="req_backpressure_cancel",
        )
        if backlog_lane == "data":
            multiplexer.send_data(backlog)
        else:
            multiplexer._writer.enqueue_batch([backlog], lane="terminal")  # noqa: SLF001

        incoming.put(
            {
                "jsonrpc": "2.0",
                "id": 90,
                "method": CHAT_CANCEL_METHOD,
                "params": {
                    "accept_version": API_VERSION,
                    "request_id": "req_backpressure_cancel",
                },
            }
        )
        incoming.put({"jsonrpc": "2.0", "id": 91, "method": "shutdown", "params": {}})

        with caplog.at_level(logging.WARNING):
            routed = multiplexer.read_request()

        assert routed["method"] == "shutdown"
        assert handle.cancelled is True
        rejected_records = [
            record
            for record in caplog.records
            if getattr(record, "event", "") == "sidecar.runtime.transport.control_frame_rejected"
        ]
        assert rejected_records == []
    finally:
        release_writer.set()
        multiplexer.close()


def test_approval_reader_close_removes_registered_waiter() -> None:
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(queue.Queue()),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        reader = multiplexer.approval_reader_factory(42)
        assert 42 in multiplexer._approval_waiters  # noqa: SLF001
        reader.close()  # type: ignore[attr-defined]
        assert 42 not in multiplexer._approval_waiters  # noqa: SLF001
    finally:
        multiplexer.close()


def test_control_frame_rejected_log_includes_control_lane_counters(caplog) -> None:
    # L1 diagnostics: the control_frame_rejected warn must carry the running
    # control_frames_sent/control_frames_rejected totals so the L7 reservation
    # work has a real signal to build on ahead of time.
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    release_writer = threading.Event()

    def _blocking_write(_message: dict[str, object]) -> None:
        release_writer.wait(timeout=2.0)

    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=_blocking_write,
        logger=logging.getLogger("tests.multiplexer"),
        high_water_mark_bytes=1024,
    )
    try:
        handle = multiplexer.register_turn(
            request_id="req_control_lane_stats",
            trace_id=None,
            session_id=None,
        )

        multiplexer._writer.enqueue_batch(  # noqa: SLF001
            [_sized_data_message(1024 - 40, request_id="req_control_lane_stats")],
            lane="control",
        )

        incoming.put(
            {
                "jsonrpc": "2.0",
                "id": 90,
                "method": CHAT_CANCEL_METHOD,
                "params": {
                    "accept_version": API_VERSION,
                    "request_id": "req_control_lane_stats",
                },
            }
        )
        incoming.put({"jsonrpc": "2.0", "id": 91, "method": "shutdown", "params": {}})

        with caplog.at_level(logging.WARNING):
            routed = multiplexer.read_request()

        assert routed["method"] == "shutdown"
        assert handle.cancelled is True

        rejected_records = [
            record
            for record in caplog.records
            if getattr(record, "event", "") == "sidecar.runtime.transport.control_frame_rejected"
        ]
        assert rejected_records
        assert getattr(rejected_records[0], "control_frames_sent", None) == 0
        assert getattr(rejected_records[0], "control_frames_rejected", None) == 1

    finally:
        release_writer.set()
        multiplexer.close()


def test_engine_activity_notification_stamps_liveness_and_is_never_dispatched(
    isolated_engine_liveness_state: None,
) -> None:
    # engine.activity is a fire-and-forget shell->sidecar notification: the
    # router must stamp the liveness clock, produce NO response frame, and keep
    # it out of the request dispatch path entirely.
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    written: list[dict[str, object]] = []
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=written.append,
        logger=logging.getLogger("tests.multiplexer"),
    )
    try:
        assert engine_liveness.seconds_since_engine_activity() is None
        incoming.put({"jsonrpc": "2.0", "method": "engine.activity", "params": {}})
        incoming.put({"jsonrpc": "2.0", "id": 7, "method": "initialize", "params": {}})

        message = multiplexer.read_request()

        # The notification was consumed by the router: the next dispatched
        # message is the initialize request, and the clock is freshly stamped.
        assert message["method"] == "initialize"
        age = engine_liveness.seconds_since_engine_activity()
        assert age is not None and age < 5.0
        assert written == []
    finally:
        multiplexer.close()
