"""Live output tail for background ``run_command`` jobs (row 138).

A background job's stdout and stderr reach ``status.json`` only at its terminal state, so the
Background tasks panel would show nothing while it runs. ``LiveOutputTap`` receives the raw pipe
chunks on the owned-process reader threads, keeps a bounded tail of both streams in arrival order
and mirrors it into ``live-output.json`` beside ``status.json`` at most once per interval, through
the job's ``GuardedWorkspaceStore``. The text runs the same redaction pipeline as the terminal
status (``sanitize_tool_output_no_truncate`` with the ``run_command_background`` tool name).

A job has one ``progress_tap`` slot, so ``CompositeBackgroundTap`` carries the optional row 96
test-progress tap and the live tap together; ``shell.py`` creates it through
``background_tap_for``. Default on; ``background_live_output`` off restores the bare
test-progress tap (no live file).
"""

from __future__ import annotations

import codecs
import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sidecar.ai.tools.builtins import shell_test_progress as _test_progress
from sidecar.ai.tools.builtins.shell_settings import default_on_feature_enabled
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate

if TYPE_CHECKING:
    from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, StoreRef

logger = logging.getLogger(__name__)

LIVE_OUTPUT_FLAG = "background_live_output"
LIVE_OUTPUT_FILE = "live-output.json"
LIVE_OUTPUT_MAX_CHARS = 16_000
LIVE_OUTPUT_FILE_MAX_BYTES = 96 * 1024
LIVE_OUTPUT_WRITE_INTERVAL_SECONDS = 1.0
# Redaction runs on a little more than the written tail, so a secret that straddles the front
# cut is still whole when the redaction patterns see it; only the last MAX chars are written.
_REDACTION_MARGIN_CHARS = 512
_BUFFER_MAX_CHARS = LIVE_OUTPUT_MAX_CHARS + _REDACTION_MARGIN_CHARS
_TOOL_NAME = "run_command_background"

TimerFactory = Callable[[float, Callable[[], None]], Any]


def _keep_tail(text: str, limit: int) -> tuple[str, bool]:
    return (text, False) if len(text) <= limit else (text[-limit:], True)


class LiveOutputTap:
    """Keeps a bounded tail of a background job's output and mirrors ``live-output.json``."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        min_interval_seconds: float = LIVE_OUTPUT_WRITE_INTERVAL_SECONDS,
        timer_factory: TimerFactory = threading.Timer,
    ) -> None:
        self._clock = clock
        self._interval = min_interval_seconds
        self._timer_factory = timer_factory
        self._decoders = {
            "stdout": codecs.getincrementaldecoder("utf-8")("replace"),
            "stderr": codecs.getincrementaldecoder("utf-8")("replace"),
        }
        self._buffer = ""
        self._dropped = False
        self._seen_output = False
        self._buffer_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._last_write: float | None = None
        self._timer: Any = None
        self._timer_lock = threading.Lock()
        self._closed = False
        self._job_id = ""
        self._store: GuardedWorkspaceStore | None = None
        self._job_ref: StoreRef | None = None

    def bind(self, job_id: str, store: GuardedWorkspaceStore, job_ref: StoreRef) -> None:
        """Attach the job's guarded store so the tail can be mirrored beside status.json."""
        self._job_id, self._store, self._job_ref = job_id, store, job_ref

    def on_chunk(self, stream: str, data: bytes) -> None:
        """Owned-process reader-thread tap. Never raises into the pipe drain."""
        try:
            key = stream if stream in self._decoders else "stdout"
            with self._buffer_lock:
                self._append(self._decoders[key].decode(data))
            self._maybe_write()
        except Exception:  # noqa: BLE001 - a broken tap must not kill the drain
            logger.debug("background live output tap failed", exc_info=True)

    def close(self) -> None:
        """Job ended: cancel the trailing write, flush the decoders, write once more."""
        try:
            with self._timer_lock:
                self._closed = True
                if self._timer is not None:
                    self._timer.cancel()
                    self._timer = None
            with self._buffer_lock:
                for decoder in self._decoders.values():
                    self._append(decoder.decode(b"", final=True))
            self._maybe_write(force=True)
        except Exception:  # noqa: BLE001 - never raise into the settle path
            logger.debug("background live output tap close failed", exc_info=True)

    def _append(self, text: str) -> None:
        """Caller holds ``_buffer_lock``. The cap holds after every chunk (``\\r`` rewrites too)."""
        if not text:
            return
        self._seen_output = True
        self._buffer, dropped = _keep_tail(self._buffer + text, _BUFFER_MAX_CHARS)
        self._dropped = self._dropped or dropped

    def _arm_trailing_write(self, delay: float) -> None:
        """A throttled write still lands once the quiet stretch passes (at most one timer)."""
        with self._timer_lock:
            if self._timer is not None or self._closed:
                return
            timer = self._timer_factory(max(0.01, delay), self._on_timer)
            timer.daemon = True
            self._timer = timer
            timer.start()

    def _on_timer(self) -> None:
        try:
            with self._timer_lock:
                self._timer = None
                if self._closed:
                    return
            self._maybe_write()
        except Exception:  # noqa: BLE001 - a timer thread must not die noisily
            logger.debug("background live output trailing write failed", exc_info=True)

    def _maybe_write(self, *, force: bool = False) -> None:
        store, job_ref = self._store, self._job_ref
        if store is None or job_ref is None:
            return
        now = self._clock()
        if not force and self._last_write is not None and now - self._last_write < self._interval:
            self._arm_trailing_write(self._interval - (now - self._last_write))
            return
        # close() waits for an in-flight timer write; a chunk that finds one defers to the timer.
        if not self._write_lock.acquire(blocking=force):
            self._arm_trailing_write(self._interval)
            return
        try:
            with self._buffer_lock:
                if not self._seen_output:
                    return
                raw, dropped = self._buffer, self._dropped
            self._last_write = now
            text, cut = _keep_tail(
                sanitize_tool_output_no_truncate(raw, tool_name=_TOOL_NAME), LIVE_OUTPUT_MAX_CHARS
            )
            body = {
                "schema_version": 1,
                "job_id": self._job_id,
                "text": text,
                "truncated": dropped or cut,
                "updated_at_ms": int(time.time() * 1000),
            }
            store.write_json_atomic(
                store.child(job_ref, LIVE_OUTPUT_FILE),
                body,
                max_bytes=LIVE_OUTPUT_FILE_MAX_BYTES,
            )
        except Exception:  # noqa: BLE001 - persistence must never stall the drain
            logger.debug("background live-output.json write failed", exc_info=True)
        finally:
            self._write_lock.release()


class CompositeBackgroundTap:
    """One ``progress_tap`` slot for the optional test-progress tap plus the live tap.

    Every call reaches each tap; one tap raising never stops the other. ``progress()`` and
    ``tracker`` belong to the test-progress tap (``None`` without one).
    """

    def __init__(self, progress_tap: Any, live_tap: LiveOutputTap) -> None:
        self.progress_tap = progress_tap
        self.live_tap = live_tap
        self._taps = tuple(tap for tap in (progress_tap, live_tap) if tap is not None)

    @property
    def tracker(self) -> Any:
        return getattr(self.progress_tap, "tracker", None)

    def bind(self, job_id: str, store: GuardedWorkspaceStore, job_ref: StoreRef) -> None:
        self._each("bind", job_id, store, job_ref)

    def on_chunk(self, stream: str, data: bytes) -> None:
        self._each("on_chunk", stream, data)

    def close(self) -> None:
        self._each("close")

    def progress(self) -> dict[str, object] | None:
        return self.progress_tap.progress() if self.progress_tap is not None else None

    def _each(self, method: str, *args: Any) -> None:
        for tap in self._taps:
            try:
                getattr(tap, method)(*args)
            except Exception:  # noqa: BLE001 - one broken tap must not stop the other
                logger.debug("background tap %s failed", method, exc_info=True)


def live_tap_for() -> LiveOutputTap | None:
    """A live tap for one background job, or ``None`` when the flag is off."""
    if not default_on_feature_enabled(LIVE_OUTPUT_FLAG):
        return None
    return LiveOutputTap()


def background_tap_for(command: str, cwd: Path, workspace_root: Path | None) -> Any:
    """The ``progress_tap`` for ``start_background_job``: flag off, exactly today's tap."""
    progress_tap = _test_progress.background_tap_for(command, cwd, workspace_root)
    live_tap = live_tap_for()
    if live_tap is None:
        return progress_tap
    return CompositeBackgroundTap(progress_tap, live_tap)
