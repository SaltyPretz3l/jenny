"""ToolOutputStreamer + output_chunk_slot + owned-process tap (W2-1)."""

from __future__ import annotations

import sys
import time
from contextlib import contextmanager
from pathlib import Path

from sidecar.ai.tools.builtins import output_chunk_slot
from sidecar.ai.tools.builtins.owned_process import OwnedProcessService
from sidecar.ai.tools.builtins.tool_output_stream import (
    MAX_STREAM_BATCH_LINES,
    MAX_STREAM_PENDING_LINES,
    ToolOutputStreamer,
)


@contextmanager
def _closing_streamer(**kwargs):
    """Always close the streamer, even when an assertion fails first.

    ToolOutputStreamer._flush_pending re-arms its own timer, so a streamer left
    open by a failed assertion keeps rescheduling and emitting into a list the
    dead test still owns. Timer threads are daemons, so nothing crashes -- the
    noise just lands in whichever test runs next.
    """
    streamer = ToolOutputStreamer(**kwargs)
    try:
        yield streamer
    finally:
        streamer.close()


def _wait_for(predicate, timeout_seconds=3.0):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


class TestToolOutputStreamer:
    def test_size_trigger_emits_full_batch(self) -> None:
        batches: list[dict] = []
        streamer = ToolOutputStreamer(emit=batches.append)
        payload = "".join(f"line-{i}\n" for i in range(MAX_STREAM_BATCH_LINES))
        streamer.on_chunk("stdout", payload.encode())
        assert len(batches) == 1
        batch = batches[0]
        assert batch["sequence"] == 1
        assert [line["text"] for line in batch["lines"]] == [
            f"line-{i}" for i in range(MAX_STREAM_BATCH_LINES)
        ]
        assert all(line["stream"] == "stdout" for line in batch["lines"])
        assert batch["dropped_lines"] == 0

    def test_timer_flush_emits_partial_batch(self) -> None:
        batches: list[dict] = []
        with _closing_streamer(emit=batches.append) as streamer:
            streamer.on_chunk("stderr", b"only-line\n")
            assert batches == []  # below the size trigger: waits for the timer
            assert _wait_for(lambda: len(batches) == 1)
            assert batches[0]["lines"] == [{"stream": "stderr", "text": "only-line"}]

    def test_crlf_lines_keep_their_text(self) -> None:
        """Windows CRLF: the trailing \\r must not blank the line (found live)."""
        batches: list[dict] = []
        streamer = ToolOutputStreamer(emit=batches.append)
        streamer.on_chunk("stdout", b"win-line-1\r\nwin-line-2\r\n")
        streamer.close()
        assert [line["text"] for line in batches[0]["lines"]] == [
            "win-line-1",
            "win-line-2",
        ]

    def test_carriage_return_collapses_to_last_rewrite(self) -> None:
        batches: list[dict] = []
        streamer = ToolOutputStreamer(emit=batches.append)
        streamer.on_chunk("stdout", b"progress 10%\rprogress 60%\rprogress 100%\n")
        streamer.close()
        assert len(batches) == 1
        assert batches[0]["lines"] == [{"stream": "stdout", "text": "progress 100%"}]

    def test_ansi_escapes_are_stripped(self) -> None:
        batches: list[dict] = []
        streamer = ToolOutputStreamer(emit=batches.append)
        streamer.on_chunk("stdout", b"\x1b[31mred text\x1b[0m\n")
        streamer.close()
        assert batches[0]["lines"] == [{"stream": "stdout", "text": "red text"}]

    def test_partial_line_is_flushed_on_close(self) -> None:
        batches: list[dict] = []
        streamer = ToolOutputStreamer(emit=batches.append)
        streamer.on_chunk("stdout", b"no newline yet")
        streamer.close()
        assert len(batches) == 1
        assert batches[0]["lines"] == [{"stream": "stdout", "text": "no newline yet"}]

    def test_every_batch_is_capped_even_for_one_giant_read(self) -> None:
        """An oversized pipe read must emit MULTIPLE capped
        batches, never one batch above MAX_STREAM_BATCH_LINES."""
        batches: list[dict] = []
        streamer = ToolOutputStreamer(emit=batches.append)
        payload = "".join(f"line-{i}\n" for i in range(MAX_STREAM_BATCH_LINES * 3))
        streamer.on_chunk("stdout", payload.encode())
        streamer.close()
        assert len(batches) >= 3
        for batch in batches:
            assert len(batch["lines"]) <= MAX_STREAM_BATCH_LINES
        emitted = sum(len(batch["lines"]) for batch in batches)
        assert emitted == MAX_STREAM_BATCH_LINES * 3

    def test_backpressure_drops_oldest_and_keeps_the_tail_live(self) -> None:
        """The stream stays a live TAIL — overflow drops the
        OLDEST pending lines (counted), never freezes on the earliest output."""
        batches: list[dict] = []
        streamer = ToolOutputStreamer(emit=batches.append)
        overflow = 25
        total = MAX_STREAM_PENDING_LINES + overflow
        payload = "".join(f"line-{i}\n" for i in range(total))
        streamer.on_chunk("stdout", payload.encode())
        streamer.close()
        texts = [line["text"] for batch in batches for line in batch["lines"]]
        assert texts[-1] == f"line-{total - 1}", "the newest line must survive"
        assert batches[-1]["dropped_lines"] > 0
        assert len(texts) + batches[-1]["dropped_lines"] == total

    def test_partial_line_snapshot_flushes_via_timer(self) -> None:
        """A \\r progress bar with no newline must surface as
        a `partial` snapshot before the command exits."""
        batches: list[dict] = []
        with _closing_streamer(emit=batches.append) as streamer:
            streamer.on_chunk("stdout", b"progress 10%\rprogress 42%")
            assert _wait_for(lambda: len(batches) >= 1)
            assert batches[0]["lines"] == []
            assert batches[0]["partial"] == "progress 42%"

    def test_utf8_character_split_across_reads_survives(self) -> None:
        """A multibyte character split across pipe reads must
        decode intact (incremental decoder), not into replacement chars."""
        batches: list[dict] = []
        streamer = ToolOutputStreamer(emit=batches.append)
        encoded = "héllo wörld\n".encode()
        split_at = encoded.index("é".encode()) + 1  # mid-character
        streamer.on_chunk("stdout", encoded[:split_at])
        streamer.on_chunk("stdout", encoded[split_at:])
        streamer.close()
        texts = [line["text"] for batch in batches for line in batch["lines"]]
        assert texts == ["héllo wörld"]

    def test_chunks_after_close_are_ignored(self) -> None:
        batches: list[dict] = []
        streamer = ToolOutputStreamer(emit=batches.append)
        streamer.close()
        streamer.on_chunk("stdout", b"late line\n")
        assert batches == []

    def test_broken_sink_closes_the_streamer_without_raising(self) -> None:
        def _broken(_batch: dict) -> None:
            raise RuntimeError("sink died")

        streamer = ToolOutputStreamer(emit=_broken)
        payload = "".join(f"line-{i}\n" for i in range(MAX_STREAM_BATCH_LINES))
        streamer.on_chunk("stdout", payload.encode())  # must not raise
        # Closed after the sink failure: nothing further is buffered.
        streamer.on_chunk("stdout", b"after failure\n")
        streamer.close()

    def test_sequence_increments_per_batch(self) -> None:
        batches: list[dict] = []
        streamer = ToolOutputStreamer(emit=batches.append)
        full = "".join(f"a-{i}\n" for i in range(MAX_STREAM_BATCH_LINES))
        streamer.on_chunk("stdout", full.encode())
        streamer.on_chunk("stdout", full.encode())
        streamer.close()
        assert [batch["sequence"] for batch in batches] == [1, 2]


class TestOutputChunkSlot:
    def test_begin_current_end_round_trip(self) -> None:
        seen: list[dict] = []
        try:
            assert output_chunk_slot.current_writer() is None
            output_chunk_slot.begin_tool_call(seen.append)
            writer = output_chunk_slot.current_writer()
            assert writer is not None
            writer({"sequence": 1})
            assert seen == [{"sequence": 1}]
        finally:
            output_chunk_slot.end_tool_call()
        assert output_chunk_slot.current_writer() is None


class TestOwnedProcessTap:
    def test_run_streams_chunks_and_result_stays_authoritative(self, tmp_path: Path) -> None:
        service = OwnedProcessService()
        chunks: list[tuple[str, bytes]] = []
        result = service.run(
            [
                sys.executable,
                "-c",
                "import sys; print('tap-out'); print('tap-err', file=sys.stderr)",
            ],
            cwd=tmp_path,
            timeout_seconds=30.0,
            on_output_chunk=lambda stream, data: chunks.append((stream, data)),
        )
        assert result.returncode == 0
        assert "tap-out" in result.stdout
        assert "tap-err" in result.stderr
        streamed = b"".join(data for _, data in chunks)
        assert b"tap-out" in streamed
        assert b"tap-err" in streamed

    def test_broken_tap_does_not_break_capture(self, tmp_path: Path) -> None:
        service = OwnedProcessService()

        def _broken(_stream: str, _data: bytes) -> None:
            raise RuntimeError("tap died")

        result = service.run(
            [sys.executable, "-c", "print('still captured')"],
            cwd=tmp_path,
            timeout_seconds=30.0,
            on_output_chunk=_broken,
        )
        assert result.returncode == 0
        assert "still captured" in result.stdout
