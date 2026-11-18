# new-test-file: a new surface (row 180 agent steering admission); mail and job notices each have their own multiplexer test file.
"""Agent steering: ``session.user_steer_arrived`` / ``_withdrawn`` park and unpark items on the live turn."""

from __future__ import annotations

import logging
import queue
from typing import Any

import pytest

from sidecar.runtime.multiplexer import StdioTransportMultiplexer
from sidecar.runtime.turn_steers import (
    MAX_STEER_CONTENT_BYTES,
    MAX_STEER_ITEMS,
    PendingSteerQueue,
    SteerItem,
    bind_pending_steers,
    current_pending_steers,
)

_LOGGER = "tests.multiplexer.user_steer"
_SESSION = "session-steer"
_REQUEST = "req-steer"


def _reader(items: "queue.Queue[dict[str, object]]"):
    def _read() -> dict[str, object]:
        return items.get(timeout=1.0)

    return _read


def item(
    n: int | str, content: str | None = None, images: list[Any] | None = None
) -> dict[str, Any]:
    return {
        "item_id": f"outbox_{n}",
        "content": content if content is not None else f"steer text {n}",
        "images": [] if images is None else images,
    }


def _image(name: str) -> dict[str, Any]:
    return {
        "kind": "image",
        "asset_path": f"/managed/{name}.png",
        "display_name": name,
        "mime_type": "image/png",
    }


@pytest.fixture
def transport():
    incoming: queue.Queue[dict[str, object]] = queue.Queue()
    multiplexer = StdioTransportMultiplexer(
        reader=_reader(incoming),
        write_message=lambda _message: None,
        logger=logging.getLogger(_LOGGER),
    )
    handle = multiplexer.register_turn(request_id=_REQUEST, trace_id=None, session_id=_SESSION)
    counter = {"next_id": 900}

    def deliver(method: str, params: object) -> None:
        counter["next_id"] += 1
        incoming.put({"jsonrpc": "2.0", "method": method, "params": params})
        incoming.put(
            {"jsonrpc": "2.0", "id": counter["next_id"], "method": "initialize", "params": {}}
        )
        routed = multiplexer.read_request()
        assert routed["method"] == "initialize", "the notification is consumed, never dispatched"

    def arrive(items: object, **overrides: Any) -> None:
        params = {"session_id": _SESSION, "request_id": _REQUEST, "items": items, **overrides}
        deliver("session.user_steer_arrived", params)

    def withdraw(item_ids: object, **overrides: Any) -> None:
        params = {"session_id": _SESSION, "request_id": _REQUEST, "item_ids": item_ids, **overrides}
        deliver("session.user_steer_withdrawn", params)

    try:
        yield handle, arrive, withdraw, deliver
    finally:
        multiplexer.close()


def _ids(drained: list[Any]) -> list[str]:
    return [steer.item_id for steer in drained]


def _events(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [getattr(record, "event", "") for record in caplog.records if record.name == _LOGGER]


def test_valid_notification_parks_items_in_arrival_order(transport, caplog) -> None:
    handle, arrive, _withdraw, _deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    arrive([item(1), item(2, images=[_image("shot")])])

    assert handle.pending_steers.has_pending() is True
    drained = handle.pending_steers.drain()
    assert _ids(drained) == ["outbox_1", "outbox_2"]
    assert drained[0].content == "steer text 1"
    assert drained[1].images == (_image("shot"),)
    assert handle.pending_steers.has_pending() is False
    assert handle.pending_steers.drain() == []
    assert "sidecar.runtime.user_steer_arrived" in _events(caplog)
    assert all("steer text" not in record.getMessage() for record in caplog.records)


def test_stale_request_id_or_session_is_dropped(transport, caplog) -> None:
    handle, arrive, _withdraw, _deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    arrive([item(1)], request_id="req-older")
    arrive([item(2)], session_id="session-other")

    assert handle.pending_steers.drain() == []
    assert _events(caplog).count("sidecar.runtime.user_steer_arrived.stale") == 2


@pytest.mark.parametrize(
    "params",
    [
        None,
        "text",
        {"request_id": _REQUEST, "items": []},
        {"session_id": "", "request_id": _REQUEST, "items": []},
        {"session_id": _SESSION, "request_id": 7, "items": []},
        {"session_id": _SESSION, "request_id": _REQUEST, "items": "item"},
        {"session_id": _SESSION, "request_id": _REQUEST},
    ],
)
def test_malformed_params_never_raise_or_park(transport, params) -> None:
    handle, _arrive, _withdraw, deliver = transport
    deliver("session.user_steer_arrived", params)
    deliver("session.user_steer_withdrawn", params)

    assert handle.pending_steers.drain() == []


@pytest.mark.parametrize(
    "bad",
    [
        None,
        "outbox_1",
        {"item_id": "outbox_x"},
        {"item_id": "x_1", "content": "text", "images": []},
        {"item_id": "outbox_UPPER", "content": "text", "images": []},
        {"item_id": "outbox_" + "a" * 81, "content": "text", "images": []},
        {"item_id": 4, "content": "text", "images": []},
        {"item_id": "outbox_1", "content": "", "images": []},
        {"item_id": "outbox_1", "content": "   ", "images": []},
        {"item_id": "outbox_1", "content": 5, "images": []},
        {"item_id": "outbox_1", "content": "text", "images": "img"},
        {"item_id": "outbox_1", "content": "text", "images": ["not-an-object"]},
    ],
)
def test_invalid_items_are_dropped_and_valid_siblings_kept(transport, bad) -> None:
    handle, arrive, _withdraw, _deliver = transport
    arrive([bad, item(2)])

    assert _ids(handle.pending_steers.drain()) == ["outbox_2"]


def test_missing_images_key_means_no_images(transport) -> None:
    handle, arrive, _withdraw, _deliver = transport
    arrive([{"item_id": "outbox_1", "content": "text"}])

    drained = handle.pending_steers.drain()
    assert _ids(drained) == ["outbox_1"] and drained[0].images == ()


def test_at_most_eight_items_per_turn_the_earliest_kept(transport, caplog) -> None:
    handle, arrive, _withdraw, _deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    arrive([item(n) for n in range(1, 7)])
    arrive([item(n) for n in range(7, 12)])

    assert _ids(handle.pending_steers.drain()) == [
        f"outbox_{n}" for n in range(1, MAX_STEER_ITEMS + 1)
    ]
    arrive([item(99)])
    assert handle.pending_steers.drain() == [], "the bound is per turn, not per drain"
    assert "sidecar.runtime.user_steer_arrived.dropped" in _events(caplog)


def test_content_is_bounded_to_32_kib_utf8_per_turn(transport) -> None:
    handle, arrive, _withdraw, _deliver = transport
    assert MAX_STEER_CONTENT_BYTES == 32 * 1024
    # Three bytes per character: a character count under the cap can still be over in bytes.
    big = "\u20ac" * (MAX_STEER_CONTENT_BYTES // 3 + 1)
    assert len(big) < MAX_STEER_CONTENT_BYTES < len(big.encode("utf-8"))
    just_fits = "\u20ac" * (MAX_STEER_CONTENT_BYTES // 3)  # 32766 bytes
    arrive([item(1, big), item(2, just_fits), item(3, "xxx"), item(4, "tiny")])

    assert _ids(handle.pending_steers.drain()) == ["outbox_2"], (
        "items 3 and 4 would pass 32768 bytes"
    )


def test_a_single_oversized_item_is_dropped_and_a_small_one_still_fits(transport) -> None:
    handle, arrive, _withdraw, _deliver = transport
    arrive([item(1, "x" * (MAX_STEER_CONTENT_BYTES + 1)), item(2, "small")])

    assert _ids(handle.pending_steers.drain()) == ["outbox_2"]


def test_at_most_four_images_per_item(transport) -> None:
    handle, arrive, _withdraw, _deliver = transport
    arrive(
        [
            item(1, images=[_image(f"i{n}") for n in range(5)]),
            item(2, images=[_image(f"i{n}") for n in range(4)]),
        ]
    )

    drained = handle.pending_steers.drain()
    assert _ids(drained) == ["outbox_2"] and len(drained[0].images) == 4


def test_at_most_eight_images_per_turn_charged_once(transport) -> None:
    """Row 180 review: decoded images ride every later generation, so the turn's total is bounded."""
    handle, arrive, withdraw, _deliver = transport
    arrive(
        [
            item(1, images=[_image(f"a{n}") for n in range(4)]),
            item(2, images=[_image(f"b{n}") for n in range(4)]),
        ]
    )
    withdraw(["outbox_2"])
    arrive([item(3, images=[_image("c0")]), item(4, content="text only")])

    assert _ids(handle.pending_steers.drain()) == ["outbox_1", "outbox_4"], (
        "a withdrawal refunds no images"
    )


def test_a_lone_surrogate_in_content_drops_only_that_item(transport) -> None:
    handle, arrive, _withdraw, _deliver = transport
    arrive([item(1), item(2, content="bad \ud800 text"), item(3)])

    assert _ids(handle.pending_steers.drain()) == ["outbox_1", "outbox_3"]


def test_duplicate_item_id_is_ignored_even_after_a_drain(transport) -> None:
    handle, arrive, _withdraw, _deliver = transport
    arrive([item(1, "first"), item(1, "second")])
    drained = handle.pending_steers.drain()
    assert [(s.item_id, s.content) for s in drained] == [("outbox_1", "first")]

    arrive([item(1, "third")])
    assert handle.pending_steers.drain() == []


def test_withdraw_removes_a_parked_item_and_ignores_a_drained_one(transport, caplog) -> None:
    handle, arrive, withdraw, _deliver = transport
    caplog.set_level(logging.INFO, logger=_LOGGER)
    arrive([item(1), item(2), item(3)])
    withdraw(["outbox_2", "outbox_unknown", 5])

    assert _ids(handle.pending_steers.drain()) == ["outbox_1", "outbox_3"]
    withdraw(["outbox_1"])  # already drained: ignored
    assert handle.pending_steers.drain() == []
    assert "sidecar.runtime.user_steer_withdrawn" in _events(caplog)


def test_withdrawn_item_id_cannot_re_enter_and_frees_its_bounds(transport) -> None:
    handle, arrive, withdraw, _deliver = transport
    arrive([item(n) for n in range(1, 9)])
    withdraw(["outbox_8"])
    arrive([item(8), item(9)])

    assert _ids(handle.pending_steers.drain()) == [f"outbox_{n}" for n in range(1, 8)] + [
        "outbox_9"
    ]


def test_withdraw_for_a_stale_turn_is_ignored(transport) -> None:
    handle, arrive, withdraw, _deliver = transport
    arrive([item(1)])
    withdraw(["outbox_1"], request_id="req-older")

    assert _ids(handle.pending_steers.drain()) == ["outbox_1"]


def test_wake_listeners_fire_on_a_push_and_stop_when_removed() -> None:
    steers = PendingSteerQueue()
    woken: list[int] = []
    remove = steers.add_wake_listener(lambda: woken.append(1))
    steers.push([])
    assert woken == []

    steers.push([SteerItem(item_id="outbox_1", content="hello", images=())])
    assert woken == [1]
    remove()
    steers.push([SteerItem(item_id="outbox_2", content="again", images=())])
    assert woken == [1]


def test_a_raising_wake_listener_never_breaks_a_push() -> None:
    def boom() -> None:
        raise RuntimeError("boom")

    steers = PendingSteerQueue()
    steers.add_wake_listener(boom)
    accepted, dropped = steers.push([SteerItem(item_id="outbox_1", content="hello", images=())])

    assert (accepted, dropped) == (["outbox_1"], 0)


def test_the_queue_binds_through_a_contextvar() -> None:
    steers = PendingSteerQueue()
    assert current_pending_steers() is None
    with bind_pending_steers(steers):
        assert current_pending_steers() is steers
    assert current_pending_steers() is None
