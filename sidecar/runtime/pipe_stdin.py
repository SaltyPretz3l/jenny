"""Keep the inherited stdin pipe free of a pending synchronous read while idle.

On Windows a blocking ``ReadFile`` on the process's standard-input pipe stalls
any DLL initializer that queries that handle until bytes arrive. numpy's
OpenBLAS does exactly that at load time, so a stdin reader thread plus a later
``import numpy`` on another thread (or in a child that inherited the handle)
hung ``read_file``'s RapidOCR path for the whole request timeout. The reader
below polls ``PeekNamedPipe`` and only issues the read once bytes are waiting.
Everything here is stdlib: it sits on the builtin server's bootstrap path.
"""
from __future__ import annotations

import sys
import time
from typing import Any, BinaryIO

_FILE_TYPE_PIPE = 0x0003
_READ_CHUNK_BYTES = 64 * 1024
_POLL_MIN_SECONDS = 0.001
_POLL_MAX_SECONDS = 0.02

if sys.platform == "win32":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.GetFileType.argtypes = [wintypes.HANDLE]
    _kernel32.GetFileType.restype = wintypes.DWORD
    _kernel32.PeekNamedPipe.argtypes = [
        wintypes.HANDLE,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD),
    ]
    _kernel32.PeekNamedPipe.restype = wintypes.BOOL


def pipe_handle(stream: Any) -> int | None:
    """The Win32 handle behind ``stream`` when it is a pipe, else ``None``."""
    if sys.platform != "win32":
        return None
    fileno = getattr(stream, "fileno", None)
    if not callable(fileno):
        return None
    try:
        handle = msvcrt.get_osfhandle(fileno())
    except (OSError, ValueError, TypeError):
        return None
    if _kernel32.GetFileType(handle) != _FILE_TYPE_PIPE:
        return None
    return int(handle)


def wait_for_pipe_bytes(handle: int) -> None:
    """Return once the pipe holds bytes or its writer is gone."""
    if sys.platform != "win32":
        return
    available = wintypes.DWORD()
    delay = _POLL_MIN_SECONDS
    while True:
        ok = _kernel32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None)
        if not ok or available.value:
            return
        time.sleep(delay)
        delay = min(delay * 2, _POLL_MAX_SECONDS)


class GatedPipeReader:
    """``BufferedReader``-compatible ``read``/``readline`` over a raw pipe.

    Reads are issued only after ``PeekNamedPipe`` reports bytes, so the pipe
    never carries a pending read while the process waits for its next message.
    """

    def __init__(self, raw: BinaryIO, handle: int) -> None:
        self.raw = raw
        self._handle = handle
        self._buffer = bytearray()
        self._eof = False

    def _fill(self) -> bool:
        if self._eof:
            return False
        wait_for_pipe_bytes(self._handle)
        chunk = self.raw.read(_READ_CHUNK_BYTES)
        if not chunk:
            self._eof = True
            return False
        self._buffer += chunk
        return True

    def _take(self, count: int) -> bytes:
        data = bytes(self._buffer[:count])
        del self._buffer[:count]
        return data

    def readline(self, size: int | None = -1) -> bytes:
        limit = None if size is None or size < 0 else int(size)
        while True:
            newline_at = self._buffer.find(b"\n")
            if newline_at >= 0:
                take = newline_at + 1
                return self._take(take if limit is None else min(take, limit))
            if limit is not None and len(self._buffer) >= limit:
                return self._take(limit)
            if not self._fill():
                return self._take(len(self._buffer))

    def read(self, size: int | None = -1) -> bytes:
        if size is None or size < 0:
            while self._fill():
                pass
            return self._take(len(self._buffer))
        while len(self._buffer) < size and self._fill():
            pass
        return self._take(min(size, len(self._buffer)))

    def fileno(self) -> int:
        return self.raw.fileno()


def gated_stdin(stream: BinaryIO | None) -> Any:
    """A gated reader when ``stream`` is a Windows pipe, else ``stream`` itself."""
    if stream is None:
        return None
    raw = getattr(stream, "raw", None)
    if raw is None:
        return stream
    handle = pipe_handle(raw)
    if handle is None:
        return stream
    return GatedPipeReader(raw, handle)


_shared_readers: list[GatedPipeReader] = []


def shared_gated_stdin(stream: BinaryIO | None) -> Any:
    """``gated_stdin`` with one reader per raw stream.

    The reader owns the bytes it buffers, so every read of a process's stdin
    must go through the same instance.
    """
    raw = getattr(stream, "raw", None)
    for reader in _shared_readers:
        if reader.raw is raw:
            return reader
    reader = gated_stdin(stream)
    _shared_readers.clear()
    if isinstance(reader, GatedPipeReader):
        _shared_readers.append(reader)
    return reader
