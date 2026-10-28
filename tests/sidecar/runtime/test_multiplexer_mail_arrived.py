"""Mid-turn mail (row 70 W2a): ``session.mail_arrived`` parks rows on the live turn."""

from __future__ import annotations

import hashlib
import logging
import queue
from typing import Any

import pytest

from sidecar.runtime.multiplexer import StdioTransportMultiplexer
from sidecar.runtime.turn_state import (
    MAX_PENDING_MAIL_ROWS,
    PendingMailQueue,
    bind_pending_mail,
    current_pending_mail,
)

_LOGGER = "tests.multiplexer.mail_arrived"


def _message_id(n: int) -> str:
    return f"{n:08d}-1111-4111-8111-111111111111"


def mail_row(n: int, body: str | None = None) -> dict[str, Any]:
    text = body if body is not None else f"mail body {n}"
    envelope = {
        "schema_version": 1,
        "message_id": _message_id(n),
        "source_session_id": "session-src",
        "source_session_incarnation": "inc-src",
        "source_project_id": None,
        "destination_session_id": "session-dst",
        "destination_session_incarnation": "inc-dst",
        "destination_project_id": None,
        "source_turn_id": None,
        "kind": "user_message",
        "created_at": "2026-10-20T12:00:00.000Z",
        "body": text,
        "body_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "report": None,
    }
    return {"role": "context", "kind": "session_message", "content": text, "session_message": envelope}


def _reader(items: "queue.Queue[dict[str, object]]"):
    def _read() -> dict[str, object]:
        return items.get(timeout=1.0)

    return _read


@pytest.fixture
def transport():
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger(_LOGGER),
    )
    handle = multiplexer.register_turn(
        request_id="req-mail", trace_id=None, session_id="session-dst"
    )

    def deliver(params: object, *, next_id: int = 900) -> None:
        incoming.put({"jsonrpc": "2.0", "method": "session.mail_arrived", "params": params})
        incoming.put({"jsonrpc": "2.0", "id": next_id, "method": "initialize", "params": {}})
        routed = multiplexer.read_request()
        assert routed["method"] == "initialize", "the notification is consumed, never dispatched"

    try:
        yield handle, deliver
    finally:
        multiplexer.close()


def _events(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [getattr(record, "event", "") for record in caplog.records if record.name == _LOGGER]


def test_valid_notification_parks_rows_on_the_registered_turn(transport, caplog) -> None:
    handle, deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    deliver({"session_id": "session-dst", "request_id": "req-mail", "rows": [mail_row(1), mail_row(2)]})

    drained = handle.pending_mail.drain()
    assert [row["session_message"]["message_id"] for row in drained] == [_message_id(1), _message_id(2)]
    assert handle.pending_mail.drain() == []
    assert "sidecar.runtime.mail_arrived" in _events(caplog)
    assert all("mail body" not in record.getMessage() for record in caplog.records)


def test_stale_request_id_is_ignored(transport, caplog) -> None:
    handle, deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    deliver({"session_id": "session-dst", "request_id": "req-older", "rows": [mail_row(1)]})
    deliver({"session_id": "session-other", "request_id": "req-mail", "rows": [mail_row(2)]}, next_id=901)

    assert handle.pending_mail.drain() == []
    assert _events(caplog).count("sidecar.runtime.mail_arrived.stale") == 2


@pytest.mark.parametrize(
    "params",
    [
        {"request_id": "req-mail", "rows": []},
        {"session_id": "", "request_id": "req-mail", "rows": []},
        {"session_id": "session-dst", "request_id": 7, "rows": []},
        {"session_id": "session-dst", "request_id": "req-mail", "rows": "row"},
        {"session_id": "session-dst", "request_id": "req-mail"},
    ],
)
def test_malformed_params_are_ignored(transport, caplog, params) -> None:
    handle, deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    deliver(params)

    assert handle.pending_mail.drain() == []
    assert "sidecar.runtime.mail_arrived.invalid" in _events(caplog)


def test_invalid_row_is_dropped_and_a_valid_one_kept(transport, caplog) -> None:
    handle, deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    forged = mail_row(3)
    forged["content"] = "not the body"
    receipt = {**mail_row(4), "kind": "session_message_receipt"}
    deliver({"session_id": "session-dst", "request_id": "req-mail", "rows": [forged, mail_row(5), receipt, "x"]})

    assert [row["session_message"]["message_id"] for row in handle.pending_mail.drain()] == [_message_id(5)]
    invalid = [r for r in caplog.records if getattr(r, "event", "") == "sidecar.runtime.mail_arrived.invalid_rows"]
    assert len(invalid) == 1
    assert invalid[0].count == 3


def test_the_seventeenth_row_is_dropped_by_the_per_turn_bound(transport, caplog) -> None:
    handle, deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    deliver({"session_id": "session-dst", "request_id": "req-mail", "rows": [mail_row(n) for n in range(1, 11)]})
    assert len(handle.pending_mail.drain()) == 10  # a drain does not reset the per-turn bound
    deliver(
        {"session_id": "session-dst", "request_id": "req-mail", "rows": [mail_row(n) for n in range(11, 18)]},
        next_id=901,
    )

    kept = [row["session_message"]["message_id"] for row in handle.pending_mail.drain()]
    assert kept == [_message_id(n) for n in range(11, 17)]
    assert MAX_PENDING_MAIL_ROWS == 16
    dropped = [r for r in caplog.records if getattr(r, "event", "") == "sidecar.runtime.mail_arrived.dropped"]
    assert [r.count for r in dropped] == [1]


def test_queue_bounds_bytes_and_accepts_an_id_once() -> None:
    pending = PendingMailQueue()
    accepted, dropped = pending.push([mail_row(1), mail_row(1)])
    assert (accepted, dropped) == ([_message_id(1)], 1)
    big = mail_row(2, body="x" * (40 * 1024))
    assert pending.push([big, mail_row(3)]) == ([_message_id(3)], 1)
    assert [row["session_message"]["message_id"] for row in pending.drain()] == [_message_id(1), _message_id(3)]


def test_pending_mail_binding_is_scoped() -> None:
    pending = PendingMailQueue()
    assert current_pending_mail() is None
    with bind_pending_mail(pending):
        assert current_pending_mail() is pending
    assert current_pending_mail() is None
