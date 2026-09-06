from __future__ import annotations

import logging
import queue

from sidecar.runtime.multiplexer import StdioTransportMultiplexer


def _queued_reader(items: "queue.Queue[dict[str, object]]"):
    def _read() -> dict[str, object]:
        return items.get(timeout=1.0)

    return _read


def test_live_run_mode_notification_updates_turn_without_resolving_pending_approval() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer.run_mode"),
    )
    try:
        handle = multiplexer.register_turn(
            request_id="req-live-mode",
            trace_id="trace-live-mode",
            session_id="session-live-mode",
            approval_mode="prompt",
            read_only=False,
        )
        approval_reader = multiplexer.approval_reader_factory(1901, cancel_handle=handle)
        incoming.put({
            "jsonrpc": "2.0",
            "method": "session.run_mode_updated",
            "params": {
                "session_id": "session-live-mode",
                "approval_mode": "auto_run",
                "read_only": False,
            },
        })
        incoming.put({"jsonrpc": "2.0", "id": 1901, "result": {"approved": True}})
        incoming.put({
            "jsonrpc": "2.0",
            "id": 77,
            "method": "initialize",
            "params": {},
        })

        routed = multiplexer.read_request()

        assert routed["method"] == "initialize"
        assert handle.live_run_mode.snapshot() == ("auto_run", False)
        assert approval_reader(0.1) == {
            "jsonrpc": "2.0",
            "id": 1901,
            "result": {"approved": True},
        }
    finally:
        multiplexer.close()


def test_live_run_mode_notification_never_tightens_read_only_mid_turn() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer.run_mode"),
    )
    try:
        handle = multiplexer.register_turn(
            request_id="req-plan-next-send",
            trace_id=None,
            session_id="session-plan-next-send",
            approval_mode="auto_run",
            read_only=False,
        )
        incoming.put({
            "jsonrpc": "2.0",
            "method": "session.run_mode_updated",
            "params": {
                "session_id": "session-plan-next-send",
                "approval_mode": "prompt",
                "read_only": True,
            },
        })
        incoming.put({
            "jsonrpc": "2.0",
            "id": 78,
            "method": "initialize",
            "params": {},
        })

        multiplexer.read_request()

        assert handle.live_run_mode.snapshot() == ("prompt", False)
    finally:
        multiplexer.close()


def test_live_run_mode_notification_applies_plan_exit_read_only_relaxation() -> None:
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_queued_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger("tests.multiplexer.run_mode"),
    )
    try:
        handle = multiplexer.register_turn(
            request_id="req-plan-exit",
            trace_id=None,
            session_id="session-plan-exit",
            approval_mode="prompt",
            read_only=True,
        )
        incoming.put({
            "jsonrpc": "2.0",
            "method": "session.run_mode_updated",
            "params": {
                "session_id": "session-plan-exit",
                "approval_mode": "auto_run",
                "read_only": False,
            },
        })
        incoming.put({
            "jsonrpc": "2.0",
            "id": 79,
            "method": "initialize",
            "params": {},
        })

        multiplexer.read_request()

        assert handle.live_run_mode.snapshot() == ("auto_run", False)
    finally:
        multiplexer.close()
