"""Close an owned process's pipes without blocking behind a stuck reader.

A process outside the owned tree (an escaped child, or anything a child handed
its stdout handle to) can hold the write end of an output pipe after the tree
is gone, so the drain thread stays blocked in a synchronous ``ReadFile``. On
Windows the I/O manager serializes a synchronous handle's operations, so
``CloseHandle`` on that pipe from another thread waits for the read too: the
drain, abort and cleanup paths would all hang until the holder exits (gate
finding F1, 2026-10-12). Here every blocked read is cancelled first
(``CancelSynchronousIo``) and a pipe is closed only once no reader is left in
it; a pipe whose reader still cannot be unblocked is left to close when its
holder exits rather than block the caller. POSIX closes as before.
"""

from __future__ import annotations

import ctypes
import functools
import os
import threading
import time
from typing import IO, Callable, Sequence

# Bound for unblocking the readers before the pipes are closed.
READER_CANCEL_SECONDS = 0.2
_THREAD_TERMINATE = 0x0001  # the access right CancelSynchronousIo requires


@functools.cache
def _kernel32() -> ctypes.WinDLL:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenThread.restype = ctypes.c_void_p
    kernel32.OpenThread.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.CancelSynchronousIo.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    return kernel32


def _cancel_synchronous_read(reader: threading.Thread) -> None:
    thread_id = reader.native_id
    if thread_id is None:
        return
    kernel32 = _kernel32()
    handle = kernel32.OpenThread(_THREAD_TERMINATE, 0, thread_id)
    if not handle:
        return
    try:
        # The handle pins the thread identity; a reader that exited between the
        # liveness check and the open may have had its native id reused by an
        # unrelated thread, whose I/O must not be cancelled.
        if reader.is_alive():
            # Fails with ERROR_NOT_FOUND between reads; the caller retries.
            kernel32.CancelSynchronousIo(handle)
    finally:
        kernel32.CloseHandle(handle)


def _unblock_readers(
    readers: Sequence[threading.Thread],
    *,
    timeout_seconds: float = READER_CANCEL_SECONDS,
) -> None:
    """Cancel the readers' pending synchronous reads until they exit or time runs out."""
    if os.name != "nt":
        return
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while True:
        alive = [reader for reader in readers if reader.is_alive()]
        if not alive or time.monotonic() >= deadline:
            return
        for reader in alive:
            _cancel_synchronous_read(reader)
        for reader in alive:
            reader.join(timeout=0.01)


def close_process_pipes(
    pipes: Sequence[IO[bytes] | None],
    readers: Sequence[threading.Thread],
    *,
    close_pipe: Callable[[IO[bytes]], None],
) -> None:
    """Close stdin, stdout and stderr; ``readers`` drain stdout and stderr in order.

    On Windows a pipe whose reader is still alive after cancellation is skipped:
    closing it would block until the outside holder exits.
    """
    _unblock_readers(readers)
    stuck_pipe_ids = {
        id(pipe)
        # Fewer readers than pipes when a start failed part-way.
        for pipe, reader in zip(pipes[1:], readers, strict=False)
        if os.name == "nt" and reader.is_alive()
    }
    for pipe in pipes:
        if pipe is not None and id(pipe) not in stuck_pipe_ids:
            close_pipe(pipe)


__all__ = ["READER_CANCEL_SECONDS", "close_process_pipes"]
