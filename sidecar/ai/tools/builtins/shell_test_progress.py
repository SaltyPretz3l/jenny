"""run_command glue for live test-run progress (row 96).

Keeps ``shell.py`` / ``shell_background.py`` to one-line delegations: tracker creation behind
the ``test_progress`` kill switch, the persisted ``test_summary``, and the background-job tap
that feeds a tracker from raw pipe chunks and mirrors it into ``progress.json``.
"""

from __future__ import annotations

import codecs
import contextvars
import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

from sidecar.ai.tools.builtins.shell_background import job_progress
from sidecar.ai.tools.builtins.shell_settings import default_on_feature_enabled
from sidecar.ai.tools.builtins.test_progress_stages import StagedTestProgress

if TYPE_CHECKING:
    from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, StoreRef

logger = logging.getLogger(__name__)

_ACTIVE: contextvars.ContextVar[StagedTestProgress | None] = contextvars.ContextVar(
    "run_command_test_progress", default=None
)
PROGRESS_FILE = "progress.json"
PROGRESS_WRITE_INTERVAL_SECONDS = 1.0
PROGRESS_FILE_MAX_BYTES = 16 * 1024
_MAX_PARTIAL_CHARS = 8_000


def activate(tracker: StagedTestProgress | None) -> None:
    """Hand this thread's tracker to ``shell._run_owned_process`` (test fakes keep their
    three-argument signature, so the tracker travels out of band)."""
    _ACTIVE.set(tracker)


def take_active() -> StagedTestProgress | None:
    tracker = _ACTIVE.get()
    _ACTIVE.set(None)
    return tracker


def discard_batch(batch: dict[str, object]) -> None:
    """No-op sink: lets a tracker be fed when no live-output writer is registered."""
    del batch


def tracker_for(command: str, cwd: Path, workspace_root: Path | None) -> StagedTestProgress | None:
    """A tracker for one run_command call, or ``None`` when the flag is off."""
    if not default_on_feature_enabled("test_progress"):
        return None
    try:
        return StagedTestProgress(command=command, cwd=cwd, workspace_root=workspace_root or cwd)
    except Exception:  # noqa: BLE001 - progress is strictly best-effort
        return None


def attach_job_progress(status: dict[str, object], job_id: str) -> None:
    """Add the in-memory ``progress`` block to a still-running job's status payload."""
    if status.get("state") != "running":
        return
    progress = job_progress(job_id)
    if progress is not None:
        status["progress"] = progress


def summary_for(tracker: StagedTestProgress | None) -> dict[str, object] | None:
    if tracker is None:
        return None
    try:
        return tracker.summary()
    except Exception:  # noqa: BLE001 - never fail the tool result over a summary
        return None


class _LineSplitter:
    """Per-stream incremental UTF-8 decode and newline split (CR-collapsed lines)."""

    def __init__(self) -> None:
        self._decoders = {
            "stdout": codecs.getincrementaldecoder("utf-8")("replace"),
            "stderr": codecs.getincrementaldecoder("utf-8")("replace"),
        }
        self._partial = {"stdout": "", "stderr": ""}

    def feed(self, stream: str, data: bytes) -> list[str]:
        key = stream if stream in self._partial else "stdout"
        buffered = self._partial[key] + self._decoders[key].decode(data)
        *complete, tail = buffered.split("\n")
        self._partial[key] = tail[-_MAX_PARTIAL_CHARS:]
        return [_collapse(raw) for raw in complete]

    def flush(self) -> list[str]:
        """The unterminated tail of each stream (the job ended without a final newline)."""
        tails = []
        for key, decoder in self._decoders.items():
            tail = self._partial[key] + decoder.decode(b"", final=True)
            self._partial[key] = ""
            if tail:
                tails.append(_collapse(tail))
        return tails


def _collapse(raw: str) -> str:
    line = raw.rstrip("\r")
    return line.rsplit("\r", 1)[-1] if "\r" in line else line


class BackgroundProgressTap:
    """Feeds a tracker from a background job's pipe chunks and mirrors ``progress.json``."""

    def __init__(
        self,
        tracker: StagedTestProgress,
        *,
        clock: Callable[[], float] = time.monotonic,
        min_interval_seconds: float = PROGRESS_WRITE_INTERVAL_SECONDS,
    ) -> None:
        self.tracker = tracker
        self._clock = clock
        self._interval = min_interval_seconds
        self._splitter = _LineSplitter()
        self._split_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._last_write: float | None = None
        self._timer: threading.Timer | None = None
        self._timer_lock = threading.Lock()
        self._closed = False
        self._job_id = ""
        self._store: GuardedWorkspaceStore | None = None
        self._job_ref: StoreRef | None = None

    def bind(self, job_id: str, store: GuardedWorkspaceStore, job_ref: StoreRef) -> None:
        """Attach the job's guarded store so progress can be mirrored beside status.json."""
        self._job_id, self._store, self._job_ref = job_id, store, job_ref

    def on_chunk(self, stream: str, data: bytes) -> None:
        """Owned-process reader-thread tap. Never raises into the pipe drain."""
        try:
            with self._split_lock:
                lines = self._splitter.feed(stream, data)
            for line in lines:
                self.tracker.feed_line(line)
            self._maybe_write()
        except Exception:  # noqa: BLE001 - a broken tap must not kill the drain
            logger.debug("background progress tap failed", exc_info=True)

    def close(self) -> None:
        """Job ended: feed the unterminated tail, cancel the trailing write, write once more."""
        with self._timer_lock:
            self._closed = True
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        try:
            with self._split_lock:
                tails = self._splitter.flush()
            for line in tails:
                self.tracker.feed_line(line)
            self._maybe_write(force=True)
        except Exception:  # noqa: BLE001 - never raise into the settle path
            logger.debug("background progress tap close failed", exc_info=True)

    def progress(self) -> dict[str, object] | None:
        """The ``check_background_job`` progress block (None until a runner is detected)."""
        digest = self.tracker.background_progress()
        if digest is None:
            return None
        return {key: digest[key] for key in _STATUS_KEYS}

    def _arm_trailing_write(self, delay: float) -> None:
        """A throttled write still lands once the quiet stretch passes (at most one timer)."""
        with self._timer_lock:
            if self._timer is not None or self._closed:
                return
            timer = threading.Timer(max(0.01, delay), self._on_timer)
            timer.daemon = True
            self._timer = timer
            timer.start()

    def _on_timer(self) -> None:
        with self._timer_lock:
            self._timer = None
            if self._closed:
                return
        try:
            self._maybe_write()
        except Exception:  # noqa: BLE001 - a timer thread must not die noisily
            logger.debug("background progress trailing write failed", exc_info=True)

    def _maybe_write(self, *, force: bool = False) -> None:
        store, job_ref = self._store, self._job_ref
        if store is None or job_ref is None:
            return
        now = self._clock()
        if not force and self._last_write is not None and now - self._last_write < self._interval:
            self._arm_trailing_write(self._interval - (now - self._last_write))
            return
        if not self._write_lock.acquire(blocking=False):
            return
        try:
            digest = self.tracker.background_progress()
            if digest is None:
                return
            self._last_write = now
            body = {
                "schema_version": 1,
                "job_id": self._job_id,
                **digest,
                "updated_at_ms": int(time.time() * 1000),
            }
            store.write_json_atomic(
                store.child(job_ref, PROGRESS_FILE),
                body,
                max_bytes=PROGRESS_FILE_MAX_BYTES,
            )
        except Exception:  # noqa: BLE001 - persistence must never stall the drain
            logger.debug("background progress.json write failed", exc_info=True)
        finally:
            self._write_lock.release()


_STATUS_KEYS = ("runner", "percent", "done", "total", "total_unit", "failed", "skipped", "failures")


def background_tap_for(
    command: str, cwd: Path, workspace_root: Path | None
) -> BackgroundProgressTap | None:
    tracker = tracker_for(command, cwd, workspace_root)
    if tracker is None:
        return None
    return BackgroundProgressTap(tracker)
