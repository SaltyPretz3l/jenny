"""Background stdin message reader for sidecar runtime loops."""

from __future__ import annotations

import queue
import threading
from dataclasses import dataclass
from typing import Any, Callable

from sidecar.runtime.framing import RecoverablePayloadError

_QUEUE_MAXSIZE = 128
_QUEUE_PUT_TIMEOUT_SECONDS = 0.05


@dataclass(frozen=True)
class ReaderDrainResult:
    """Bounded shutdown proof for the sidecar stdin reader."""

    drained: bool
    worker_alive: bool


class BackgroundMessageReader:
    """Read framed messages on a background thread and expose queued reads."""

    _SENTINEL = object()

    def __init__(
        self,
        reader: Callable[[], dict[str, Any]],
    ) -> None:
        self._reader = reader
        # A buffered stdin object must never be closed from this thread while
        # the pump may hold its internal read lock. The parent owns the pipe's
        # write half and closing that half is what unblocks the read safely.
        self._queue: queue.Queue[object] = queue.Queue(maxsize=_QUEUE_MAXSIZE)
        self._terminal_error: BaseException | None = None
        self._started = False
        self._closed = False
        self._exhausted = False
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def _start_if_needed(self) -> None:
        with self._lock:
            if self._started:
                return
            thread = threading.Thread(
                target=self._pump,
                name="sidecar-stdin-reader",
                daemon=True,
            )
            thread.start()
            self._thread = thread
            self._started = True

    def _pump(self) -> None:
        while True:
            try:
                message = self._reader()
            except RecoverablePayloadError as error:
                if not self._put_with_shutdown_awareness(error):
                    break
                continue
            except BaseException as error:  # noqa: BLE001
                self._terminal_error = error
                self._put_with_shutdown_awareness(self._SENTINEL)
                break
            if not self._put_with_shutdown_awareness(message):
                break

    def _put_with_shutdown_awareness(self, item: object) -> bool:
        while True:
            with self._lock:
                if self._closed:
                    return False
            try:
                self._queue.put(item, timeout=_QUEUE_PUT_TIMEOUT_SECONDS)
                return True
            except queue.Full:
                continue

    def read(self, timeout_seconds: float | None = None) -> dict[str, Any]:
        with self._lock:
            if self._closed:
                raise EOFError("sidecar input reader closed")
            if self._exhausted:
                if self._terminal_error is not None:
                    raise self._terminal_error
                raise EOFError("sidecar input reader stopped")
        self._start_if_needed()
        try:
            item = self._queue.get(timeout=timeout_seconds)
        except queue.Empty as error:
            raise TimeoutError("timed out waiting for sidecar input message") from error

        if item is self._SENTINEL:
            with self._lock:
                self._exhausted = True
            if self._terminal_error is not None:
                raise self._terminal_error
            raise EOFError("sidecar input reader stopped")

        if isinstance(item, RecoverablePayloadError):
            raise item

        if not isinstance(item, dict):
            raise ValueError("sidecar input reader received non-object payload")
        return item

    def close(self, join_timeout_seconds: float = 1.0) -> ReaderDrainResult:
        thread: threading.Thread | None
        with self._lock:
            self._closed = True
            thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=max(0.0, join_timeout_seconds))
        worker_alive = bool(thread is not None and thread.is_alive())
        return ReaderDrainResult(
            drained=not worker_alive,
            worker_alive=worker_alive,
        )
