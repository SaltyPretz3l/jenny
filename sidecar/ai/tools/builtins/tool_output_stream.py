"""Live tool-output streaming tap for run_command.

Generalizes the monitor manager's output batching (sanitize -> clip -> batch
-> timed flush -> bounded drops) for the in-flight ``run_command`` call. The
owned-process reader threads feed raw pipe chunks into
:meth:`ToolOutputStreamer.on_chunk`; the streamer emits bounded, sanitized
``tool/output_chunk`` notification payloads through the writer registered by
the builtin server for the active call.

Contracts:
- Chunks are EPHEMERAL: never journaled, never part of the canonical turn
  record; the final tool_result snapshot stays authoritative.
- Emission is batched (size or flush-interval trigger, <= ~10Hz) and every
  batch is capped at MAX_STREAM_BATCH_LINES — an oversized pipe read emits
  MULTIPLE capped batches, never one oversized batch.
- Backpressure is drop-OLDEST-pending with a running ``dropped_lines``
  counter; the stream stays a live tail (newest output always flows) instead
  of freezing after a fixed total budget.
- A partial line (no newline yet — prompts, ``\\r`` progress bars) is
  surfaced as a ``partial`` snapshot on each batch and flushed by the timer
  when it changes, so long-running progress is visible before exit.
- Bytes are decoded with a per-stream INCREMENTAL UTF-8 decoder so a
  multibyte character split across pipe reads is not corrupted.
- ``\\r`` progress rewrites collapse to last-line-wins; ANSI escapes are
  stripped (v1); every emitted line passes ``sanitize_tool_output``.
- Pending lines are queued raw (clipped); ANSI stripping and redaction run
  only on the lines a batch actually emits, so lines dropped by backpressure
  never pay for the redaction pipeline on the pipe-reader thread.
- ``on_chunk`` never blocks the pipe drain and never raises.
"""

from __future__ import annotations

import codecs
import re
import threading
import time
from typing import Callable

from sidecar.ai.tools.sanitization import sanitize_tool_output

# Renderer-facing line budget per emitted event and per batch. The stream is a
# live tail, not an archive: keep events small and frequent-but-bounded.
MAX_STREAM_LINE_CHARS = 2_000
MAX_STREAM_BATCH_LINES = 20
STREAM_FLUSH_INTERVAL_SECONDS = 0.15
# Burst buffer: pending-but-unemitted lines beyond this are dropped OLDEST
# first (counted). Together with the flush cadence this bounds throughput and
# memory without ever freezing the tail.
MAX_STREAM_PENDING_LINES = 200
# A partial line (no trailing newline yet) is held back and surfaced as a
# snapshot; cap what we hold to one event's budget.
_MAX_PARTIAL_CHARS = MAX_STREAM_LINE_CHARS
# Raw pending lines are clipped before rendering. The headroom over the
# emitted budget leaves room for ANSI escapes that rendering strips and keeps
# the sanitizer's own truncation marker on a genuinely long line.
_MAX_RAW_LINE_CHARS = 2 * MAX_STREAM_LINE_CHARS

_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def _strip_ansi(text: str) -> str:
    return _ANSI_ESCAPE_RE.sub("", text)


def _collapse_carriage_returns(line: str) -> str:
    """Progress-bar rewrites: keep only the text after the last ``\\r``."""
    if "\r" in line:
        return line.rsplit("\r", 1)[-1]
    return line


class ToolOutputStreamer:
    """Batch and emit sanitized live output lines for one tool call."""

    def __init__(
        self,
        *,
        emit: Callable[[dict[str, object]], None],
        tool_name: str = "run_command",
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._emit = emit
        self._tool_name = tool_name
        self._clock = clock
        self._lock = threading.Lock()
        self._pending: list[dict[str, str]] = []
        self._partial: dict[str, str] = {"stdout": "", "stderr": ""}
        self._decoders = {
            "stdout": codecs.getincrementaldecoder("utf-8")("replace"),
            "stderr": codecs.getincrementaldecoder("utf-8")("replace"),
        }
        self._last_partial_snapshot = ""
        # (raw stdout partial, raw stderr partial) -> rendered snapshot.
        self._partial_cache: tuple[tuple[str, str], str] = (("", ""), "")
        self._flush_timer: threading.Timer | None = None
        self._sequence = 0
        self._emitted_lines = 0
        self._dropped_lines = 0
        self._closed = False
        self._started_at = clock()

    # ── ingest ────────────────────────────────────────────────────────

    def on_chunk(self, stream: str, data: bytes) -> None:
        """Owned-process reader-thread tap. Never blocks, never raises."""
        batches: list[dict[str, object]] = []
        try:
            with self._lock:
                if self._closed:
                    return
                decoder = self._decoders.get(stream)
                text = decoder.decode(data) if decoder is not None else data.decode(
                    "utf-8", errors="replace"
                )
                buffered = self._partial.get(stream, "") + text
                *complete, tail = buffered.split("\n")
                self._partial[stream] = tail[-_MAX_PARTIAL_CHARS:]
                for raw_line in complete:
                    self._append_line_locked(stream, raw_line)
                while len(self._pending) >= MAX_STREAM_BATCH_LINES:
                    batch = self._take_batch_locked()
                    if batch is None:
                        break
                    batches.append(batch)
                self._ensure_flush_timer_locked()
        except Exception:  # noqa: BLE001 - a broken tap must not kill the drain
            return
        for batch in batches:
            self._safe_emit(batch)

    def _append_line_locked(self, stream: str, raw_line: str) -> None:
        # CRLF: after the \n split each Windows line still ends in \r — strip
        # it BEFORE the progress-bar collapse, which keeps only the text after
        # the last \r (a trailing \r would blank every line). Both are cheap
        # string ops; the collapse runs before the clip so a long progress
        # line keeps its final state.
        line = _collapse_carriage_returns(raw_line.rstrip("\r")).rstrip()
        if not line:
            return
        self._pending.append({"stream": stream, "text": line[:_MAX_RAW_LINE_CHARS]})
        # Backpressure: keep the tail live — drop the OLDEST pending lines.
        while len(self._pending) > MAX_STREAM_PENDING_LINES:
            self._pending.pop(0)
            self._dropped_lines += 1

    def _render_line(self, raw_line: str) -> str:
        """ANSI-strip and sanitize one raw line for emission ("" drops it)."""
        line = _collapse_carriage_returns(_strip_ansi(raw_line)).rstrip()
        if not line:
            return ""
        return sanitize_tool_output(
            line, max_chars=MAX_STREAM_LINE_CHARS, tool_name=self._tool_name
        )

    def _partial_snapshot_locked(self) -> str:
        key = (self._partial.get("stdout", ""), self._partial.get("stderr", ""))
        cached_key, cached_snapshot = self._partial_cache
        if key == cached_key:
            return cached_snapshot
        snapshot = ""
        for raw in key:
            if raw and (snapshot := self._render_line(raw)):
                break
        self._partial_cache = (key, snapshot)
        return snapshot

    def _ensure_flush_timer_locked(self) -> None:
        if self._flush_timer is not None:
            return
        # Schedule when there are pending lines OR the partial snapshot moved
        # (progress bars rewrite one line and never emit a newline).
        if not self._pending and self._partial_snapshot_locked() == self._last_partial_snapshot:
            return
        timer = threading.Timer(STREAM_FLUSH_INTERVAL_SECONDS, self._flush_pending)
        timer.daemon = True
        self._flush_timer = timer
        timer.start()

    # ── flush / close ─────────────────────────────────────────────────

    def _take_batch_locked(self) -> dict[str, object] | None:
        if self._flush_timer is not None:
            self._flush_timer.cancel()
            self._flush_timer = None
        partial = self._partial_snapshot_locked()
        if not self._pending and partial == self._last_partial_snapshot:
            return None
        taken = self._pending[:MAX_STREAM_BATCH_LINES]
        self._pending = self._pending[MAX_STREAM_BATCH_LINES:]
        lines = [
            {"stream": entry["stream"], "text": text}
            for entry in taken
            if (text := self._render_line(entry["text"]))
        ]
        self._emitted_lines += len(lines)
        self._last_partial_snapshot = partial
        self._sequence += 1
        return {
            "sequence": self._sequence,
            "lines": lines,
            "partial": partial,
            "emitted_lines": self._emitted_lines,
            "dropped_lines": self._dropped_lines,
            "elapsed_ms": max(0, int((self._clock() - self._started_at) * 1000)),
        }

    def _flush_pending(self) -> None:
        with self._lock:
            if self._closed:
                return
            batch = self._take_batch_locked()
            # Re-arm for anything still pending after the capped take.
            self._ensure_flush_timer_locked()
        if batch is not None:
            self._safe_emit(batch)

    def close(self) -> None:
        """Flush the tail (incl. any partial line) and drop later chunks."""
        batches: list[dict[str, object]] = []
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._flush_timer is not None:
                self._flush_timer.cancel()
                self._flush_timer = None
            for stream in ("stdout", "stderr"):
                decoder = self._decoders.get(stream)
                flushed = decoder.decode(b"", final=True) if decoder is not None else ""
                partial = self._partial.get(stream, "") + flushed
                if partial:
                    self._append_line_locked(stream, partial)
                    self._partial[stream] = ""
            while True:
                batch = self._take_batch_locked()
                if batch is None:
                    break
                batches.append(batch)
        for batch in batches:
            self._safe_emit(batch)

    def _safe_emit(self, batch: dict[str, object]) -> None:
        try:
            self._emit(batch)
        except Exception:  # noqa: BLE001 - a dead sink must not stall the tool
            with self._lock:
                self._closed = True


__all__ = [
    "MAX_STREAM_BATCH_LINES",
    "MAX_STREAM_LINE_CHARS",
    "MAX_STREAM_PENDING_LINES",
    "STREAM_FLUSH_INTERVAL_SECONDS",
    "ToolOutputStreamer",
]
