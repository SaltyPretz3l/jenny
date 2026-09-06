"""Terminal-lane backpressure budget regression coverage.

Split out of test_multiplexer.py to keep that file under the repo's
1015-raw-line file-size ceiling (scripts/checks/check_file_size.py).

Covers the fix that stops chat.token/chat.done + the resolving response for
a COMPLETED turn (sent via StdioTransportMultiplexer.send_terminal_result,
lane="terminal") from being budgeted against the reduced data high-water
mark (data_high_water = high_water - control reserve). Terminal frames must
now be admitted against the full high-water mark, like control frames.
"""
from __future__ import annotations

import logging
import threading

import pytest

from sidecar.runtime.framing import encode_framed_body
from sidecar.runtime.multiplexer import (
    PrioritizedMessageWriter,
    TransportBackpressureError,
)


def _sized_message(target_bytes: int, *, request_id: str) -> dict[str, object]:
    """Build a chat.token-shaped frame padded to ~target_bytes on the wire."""
    message: dict[str, object] = {
        "jsonrpc": "2.0",
        "method": "chat.token",
        "params": {"request_id": request_id, "delta": ""},
    }
    base_size = len(encode_framed_body(message))
    pad_len = max(target_bytes - base_size, 0)
    message["params"]["delta"] = "x" * pad_len  # type: ignore[index]
    return message


def test_terminal_lane_admitted_between_data_and_full_high_water_mark() -> None:
    """Terminal frames must clear admission where a same-size data frame is rejected.

    Once buffered bytes sit strictly between the data high-water mark and
    the full high-water mark, a data-lane frame must still be rejected but
    an identical-sized terminal-lane frame must be admitted, because
    terminal is now budgeted like control against the full mark.
    """
    entered = threading.Event()
    release = threading.Event()

    def _blocking_write(_message: dict[str, object]) -> None:
        entered.set()
        release.wait(timeout=2.0)

    writer = PrioritizedMessageWriter(
        write_message=_blocking_write,
        logger=logging.getLogger("tests.multiplexer.terminal_lane"),
        high_water_mark_bytes=4096,
        control_reserve_bytes=1024,
    )
    try:
        # Wedge the pump on a tiny control frame so nothing drains while the
        # backlog below is built up.
        writer.enqueue({"jsonrpc": "2.0", "id": 1, "result": {}}, control=True)
        assert entered.wait(timeout=1.0)

        stats = writer.stats()
        data_high_water = stats["data_high_water_mark_bytes"]
        high_water = stats["high_water_mark_bytes"]
        assert data_high_water < high_water

        # Pad the backlog through the control lane (not under test here)
        # until buffered bytes sit strictly between the data high-water
        # mark and the full high-water mark.
        target_buffered = data_high_water + (high_water - data_high_water) // 2
        pad_size = max(target_buffered - stats["buffered_bytes"], 0)
        padding = _sized_message(pad_size, request_id="req_pad")
        writer.enqueue_batch([padding], lane="control")

        buffered_before = writer.stats()["buffered_bytes"]
        assert data_high_water < buffered_before < high_water

        probe_frame = _sized_message(200, request_id="req_probe")
        probe_size = len(encode_framed_body(probe_frame))
        assert buffered_before + probe_size <= high_water

        with pytest.raises(TransportBackpressureError):
            writer.enqueue_batch([probe_frame], lane="data")

        # Same frame, admitted against the full high-water mark instead of
        # the reduced data budget: must be accepted.
        writer.enqueue_batch([probe_frame], lane="terminal")

        after = writer.stats()
        assert after["buffered_bytes"] == buffered_before + probe_size
        assert after["terminal_buffered_bytes"] == probe_size
    finally:
        release.set()
        writer.close(join_timeout_seconds=1.0)
