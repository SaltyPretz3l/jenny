"""ToolOutputStreamer <-> TestProgressTracker wiring (row 96 slice S2)."""

from __future__ import annotations

import time
from pathlib import Path

from sidecar.ai.tools.builtins.test_progress import TestProgressTracker
from sidecar.ai.tools.builtins.tool_output_stream import (
    MAX_STREAM_PENDING_LINES,
    PROGRESS_MIN_INTERVAL_SECONDS,
    ToolOutputStreamer,
)


class FakeProgress:
    """Deterministic progress source: the streamer only needs these three calls."""

    def __init__(self) -> None:
        self.lines: list[str] = []
        self.dirty = False
        self.waiting = False  # something will become due later (like a pending manifest)
        self.detected = True

    def feed_line(self, line: str) -> None:
        self.lines.append(line)
        self.dirty = True

    def has_update(self) -> bool:
        return self.dirty

    def wants_wake(self) -> bool:
        return self.dirty or self.waiting

    def snapshot(self, *, final: bool = False) -> dict[str, object] | None:
        if not self.detected:
            return None
        self.dirty = False
        return {"lines_seen": len(self.lines), "final": final}


class StepClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _wait_for(predicate, timeout_seconds: float = 3.0) -> bool:  # type: ignore[no-untyped-def]
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def _tracker() -> TestProgressTracker:
    return TestProgressTracker(
        command="pytest -n 4",
        cwd=Path.cwd(),
        workspace_root=Path.cwd(),
        start_manifest_thread=False,
    )


def test_tracker_sees_every_line_before_backpressure_drops_any() -> None:
    batches: list[dict[str, object]] = []
    tracker = _tracker()
    streamer = ToolOutputStreamer(emit=batches.append, progress=tracker)
    total = MAX_STREAM_PENDING_LINES * 5
    payload = "4 workers [%d items]\n" % total
    payload += "".join(
        f"[gw1] [ 50%] {'FAILED' if i % 100 == 0 else 'PASSED'} tests/a/test_x.py::t{i}\n"
        for i in range(total)
    )
    streamer.on_chunk("stdout", payload.encode())
    streamer.close()
    dropped = batches[-1]["dropped_lines"]
    assert isinstance(dropped, int) and dropped > 0  # the tail really was backpressured
    final = batches[-1]["test_progress"]
    assert isinstance(final, dict)
    assert final["tests"] == total
    assert final["failed"] == total // 100
    assert final["passed"] == total - total // 100
    assert final["final"] is True


def test_timer_emits_a_progress_only_batch_when_no_lines_are_pending() -> None:
    batches: list[dict[str, object]] = []
    progress = FakeProgress()
    progress.waiting = True
    streamer = ToolOutputStreamer(emit=batches.append, progress=progress)
    try:
        streamer.on_chunk("stdout", b"one line\n")
        assert _wait_for(lambda: len(batches) == 1)
        assert batches[0]["lines"] == [{"stream": "stdout", "text": "one line"}]
        assert batches[0]["test_progress"] == {"lines_seen": 1, "final": False}
        # The tracker changes without any new output (e.g. a running cell decaying).
        progress.dirty, progress.waiting = True, False
        assert _wait_for(lambda: len(batches) == 2)
        assert batches[1]["lines"] == []
        assert batches[1]["partial"] == ""
        assert batches[1]["test_progress"] == {"lines_seen": 1, "final": False}
        assert batches[1]["sequence"] == 2
    finally:
        streamer.close()


def test_progress_rides_batches_at_most_every_250ms() -> None:
    batches: list[dict[str, object]] = []
    clock = StepClock()
    progress = FakeProgress()
    streamer = ToolOutputStreamer(emit=batches.append, clock=clock, progress=progress)
    try:
        full = "".join(f"l{i}\n" for i in range(20)).encode()  # fills one capped batch
        streamer.on_chunk("stdout", full)
        clock.now += PROGRESS_MIN_INTERVAL_SECONDS / 2
        streamer.on_chunk("stdout", full)
        clock.now += PROGRESS_MIN_INTERVAL_SECONDS
        streamer.on_chunk("stdout", full)
        assert ["test_progress" in batch for batch in batches] == [True, False, True]
    finally:
        streamer.close()


def test_close_emits_one_final_progress_batch() -> None:
    batches: list[dict[str, object]] = []
    progress = FakeProgress()
    streamer = ToolOutputStreamer(emit=batches.append, progress=progress)
    streamer.on_chunk("stdout", b"tail without newline")
    streamer.close()
    finals = [b for b in batches if "test_progress" in b]
    assert len(finals) == 1
    assert finals[0] is batches[-1]
    assert finals[0]["test_progress"] == {"lines_seen": 1, "final": True}

    only: list[dict[str, object]] = []
    quiet = ToolOutputStreamer(emit=only.append, progress=FakeProgress())
    quiet.close()
    assert len(only) == 1
    assert only[0]["lines"] == []
    assert only[0]["test_progress"] == {"lines_seen": 0, "final": True}


def test_no_runner_means_no_progress_key_anywhere() -> None:
    batches: list[dict[str, object]] = []
    progress = FakeProgress()
    progress.detected = False
    streamer = ToolOutputStreamer(emit=batches.append, progress=progress)
    streamer.on_chunk("stdout", b"plain output\nmore\n")
    streamer.close()
    assert batches
    assert all("test_progress" not in batch for batch in batches)


def test_streamer_without_progress_is_unchanged() -> None:
    batches: list[dict[str, object]] = []
    streamer = ToolOutputStreamer(emit=batches.append)
    streamer.on_chunk("stdout", b"a\n")
    streamer.close()
    assert all("test_progress" not in batch for batch in batches)


def test_a_failing_progress_source_never_breaks_the_stream() -> None:
    class Broken(FakeProgress):
        def has_update(self) -> bool:
            raise RuntimeError("boom")

        def wants_wake(self) -> bool:
            raise RuntimeError("boom")

        def snapshot(self, *, final: bool = False) -> dict[str, object] | None:
            raise RuntimeError("boom")

    batches: list[dict[str, object]] = []
    streamer = ToolOutputStreamer(emit=batches.append, progress=Broken())
    streamer.on_chunk("stdout", b"line\n")
    streamer.close()
    assert batches[-1]["lines"] == [{"stream": "stdout", "text": "line"}]


def test_flush_timer_stops_re_arming_once_there_is_nothing_to_send() -> None:
    batches: list[dict[str, object]] = []
    progress = FakeProgress()
    streamer = ToolOutputStreamer(emit=batches.append, progress=progress)
    try:
        streamer.on_chunk("stdout", b"one line\n")
        assert _wait_for(lambda: len(batches) == 1)
        time.sleep(0.6)  # several timer periods with nothing to send
        assert len(batches) == 1
        assert streamer._flush_timer is None  # no idle polling for the rest of the command
    finally:
        streamer.close()


def test_running_cells_decay_is_delivered_during_a_silent_stretch() -> None:
    batches: list[dict[str, object]] = []
    # Run the tracker's clock 10x fast: the 2 s running-cell window elapses in ~200 ms.
    tracker = TestProgressTracker(
        command="pytest",
        cwd=Path.cwd(),
        workspace_root=Path.cwd(),
        clock=lambda: time.monotonic() * 10,
        start_manifest_thread=False,
    )
    tracker.set_manifest([f"tests/f{i:02d}.py" for i in range(12)])
    streamer = ToolOutputStreamer(emit=batches.append, progress=tracker)
    try:
        streamer.on_chunk("stdout", b"collected 50 items\ntests/f00.py .  [  2%]\n")

        def states() -> list[str]:
            return [
                str(b["test_progress"]["grid"]["states"])  # type: ignore[index]
                for b in batches
                if isinstance(b.get("test_progress"), dict) and b["test_progress"].get("grid")  # type: ignore[union-attr]
            ]

        assert _wait_for(lambda: bool(states()))
        assert states()[0].startswith("r")
        assert _wait_for(lambda: any(s.startswith("p") for s in states()))  # decayed, no output
        sent = len(batches)
        time.sleep(0.6)
        assert len(batches) == sent  # and then the timer goes quiet again
    finally:
        streamer.close()
