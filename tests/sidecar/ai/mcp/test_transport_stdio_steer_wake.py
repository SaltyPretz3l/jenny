# new-test-file: a new surface (row 180 steer wake); test_transport_stdio.py is far past the 600-line cap.
"""Agent steering: the stdio client wakes the first-party builtin server's in-flight tools/call."""

from __future__ import annotations

import time
from typing import Any

from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.turn_steers import SteerItem

from .test_transport_stdio import _cooperative_stub_transport, _stub_transport

_WAKE_METHOD = "notifications/jenny_wake"


def _item(n: int) -> SteerItem:
    return SteerItem(item_id=f"outbox_{n}", content=f"steer {n}", images=())


def _wire(
    transport: Any, steps: list[Any], written: list[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    written = [] if written is None else written
    transport._write_line = lambda payload, **_kwargs: written.append(payload)
    transport._raise_for_error = lambda response: None
    remaining = iter(steps)

    def _read(
        *, deadline: float, cancel_handle: Any = None, should_stop: Any = None
    ) -> dict[str, Any]:
        step = next(remaining)
        return step() if callable(step) else step

    transport._read_response_line = _read
    return written


def _wake_lines(written: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [payload for payload in written if payload.get("method") == _WAKE_METHOD]


def _wait_for_wake(written: list[dict[str, Any]], count: int = 1) -> None:
    deadline = time.monotonic() + 3.0
    while len(_wake_lines(written)) < count and time.monotonic() < deadline:
        time.sleep(0.01)


_OK = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}


def test_an_item_already_parked_wakes_the_call_as_it_starts() -> None:
    transport = _cooperative_stub_transport()
    handle = TurnCancellationHandle(request_id="turn-1")
    handle.pending_steers.push([_item(1)])
    written = _wire(transport, [_OK])

    transport._send_request("tools/call", {"name": "check_background_job"}, cancel_handle=handle)

    assert [payload.get("method") for payload in written] == ["tools/call", _WAKE_METHOD]
    assert written[1] == {
        "jsonrpc": "2.0",
        "method": _WAKE_METHOD,
        "params": {"requestId": written[0]["id"]},
    }
    assert "id" not in written[1], "the wake is an id-less notification"


def test_an_item_parked_while_the_call_is_in_flight_wakes_it() -> None:
    transport = _cooperative_stub_transport()
    handle = TurnCancellationHandle(request_id="turn-2")
    written: list[dict[str, Any]] = []
    seen: dict[str, Any] = {}

    def _park_then_wait_for_the_wake() -> dict[str, Any]:
        handle.pending_steers.push([_item(1)])
        _wait_for_wake(written)
        seen["wakes_before_response"] = len(_wake_lines(written))
        return _OK

    _wire(transport, [_park_then_wait_for_the_wake], written)

    transport._send_request("tools/call", {"name": "check_background_job"}, cancel_handle=handle)

    assert seen["wakes_before_response"] == 1
    [wake] = _wake_lines(written)
    assert wake["params"]["requestId"] == written[0]["id"]


def test_nothing_parked_sends_no_wake() -> None:
    transport = _cooperative_stub_transport()
    handle = TurnCancellationHandle(request_id="turn-3")
    written = _wire(transport, [_OK])

    transport._send_request("tools/call", {"name": "run_command"}, cancel_handle=handle)

    assert [payload.get("method") for payload in written] == ["tools/call"]


def test_a_third_party_server_is_never_woken() -> None:
    transport = _stub_transport()  # stub_server: not cooperative
    assert transport._config.cooperative_cancel is False
    handle = TurnCancellationHandle(request_id="turn-4")
    handle.pending_steers.push([_item(1)])
    written = _wire(transport, [_OK])

    transport._send_request("tools/call", {"name": "any_tool"}, cancel_handle=handle)
    handle.pending_steers.push([_item(2)])
    time.sleep(0.1)

    assert [payload.get("method") for payload in written] == ["tools/call"]


def test_only_tool_calls_are_woken() -> None:
    transport = _cooperative_stub_transport()
    handle = TurnCancellationHandle(request_id="turn-5")
    handle.pending_steers.push([_item(1)])
    written = _wire(transport, [_OK])

    transport._send_request("tools/list", {}, cancel_handle=handle)

    assert [payload.get("method") for payload in written] == ["tools/list"]


def test_the_listener_is_removed_when_the_call_finishes() -> None:
    transport = _cooperative_stub_transport()
    handle = TurnCancellationHandle(request_id="turn-6")
    written = _wire(transport, [_OK])

    transport._send_request("tools/call", {"name": "run_command"}, cancel_handle=handle)
    handle.pending_steers.push([_item(1)])
    time.sleep(0.1)

    assert _wake_lines(written) == []


def test_a_call_without_a_turn_handle_works_unchanged() -> None:
    transport = _cooperative_stub_transport()
    written = _wire(transport, [_OK])

    transport._send_request("tools/call", {"name": "run_command"})

    assert [payload.get("method") for payload in written] == ["tools/call"]
