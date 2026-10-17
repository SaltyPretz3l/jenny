"""Bounded drain end when a process outside the owned tree holds an output pipe.

Gate finding F1 (2026-10-12): a test command handed its stdout handle to a
process outside the run's Job Object, exited, and the contained run then hung
until the holder exited: the reader thread stayed blocked in a synchronous
``ReadFile`` and closing that pipe from ``wait()`` blocked behind it. Here the
pytest process itself is the out-of-tree holder, so the held write end is
released deterministically in teardown.
"""

from __future__ import annotations

import ctypes
import os
import sys
import threading
import time
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.owned_process import (
    PIPE_DRAIN_GRACE_SECONDS,
    OwnedProcessService,
)
from sidecar.ai.tools.builtins.owned_process_drain import (
    READER_CANCEL_SECONDS,
    close_process_pipes,
)

pytestmark = pytest.mark.skipif(
    os.name != "nt", reason="Windows synchronous-pipe close semantics"
)

# Far longer than any bounded drain; the RED run ends here instead of hanging.
_HOLDER_RELEASE_SECONDS = 20.0
# Interpreter startups (bootstrap and target) plus termination and Job proof.
_STARTUP_AND_TEARDOWN_BOUND_SECONDS = 4.0

_ESCAPER = r'''
import ctypes, sys, time
from ctypes import wintypes
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.GetStdHandle.restype = wintypes.HANDLE
k32.GetStdHandle.argtypes = [wintypes.DWORD]
k32.GetCurrentProcess.restype = wintypes.HANDLE
k32.DuplicateHandle.argtypes = [
    wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE,
    ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, wintypes.BOOL, wintypes.DWORD,
]
holder = k32.OpenProcess(0x0040, False, int(sys.argv[1]))  # PROCESS_DUP_HANDLE
held = wintypes.HANDLE()
ok = k32.DuplicateHandle(
    k32.GetCurrentProcess(), k32.GetStdHandle(wintypes.DWORD(0xFFFFFFF5)),
    holder, ctypes.byref(held), 0, False, 2,  # STD_OUTPUT_HANDLE, SAME_ACCESS
)
print("escaped" if ok else "escape failed", flush=True)
with open(sys.argv[2] + ".tmp", "w", encoding="utf-8") as fh:
    fh.write(str(held.value or 0) if ok else "0")
import os
os.replace(sys.argv[2] + ".tmp", sys.argv[2])
time.sleep(float(sys.argv[3]))
'''


class _HeldPipe:
    """The write end the escaper duplicated into this (out-of-tree) process."""

    def __init__(self, handle_file: Path) -> None:
        self._handle_file = handle_file
        self._lock = threading.Lock()
        self._closed = False
        self._timer = threading.Timer(_HOLDER_RELEASE_SECONDS, self.release)
        self._timer.daemon = True
        self._timer.start()

    def wait_until_held(self, timeout_seconds: float) -> bool:
        deadline = time.monotonic() + timeout_seconds
        while not self._handle_file.exists():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.02)
        return int(self._handle_file.read_text(encoding="utf-8")) != 0

    def release(self) -> None:
        with self._lock:
            if self._closed or not self._handle_file.exists():
                return
            self._closed = True
            handle = int(self._handle_file.read_text(encoding="utf-8"))
        if handle:
            ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(handle))

    def close(self) -> None:
        self._timer.cancel()
        self.release()


def _escaper_argv(tmp_path: Path, handle_file: Path, sleep_seconds: float) -> list[str]:
    script = tmp_path / "escaper.py"
    script.write_text(_ESCAPER, encoding="utf-8")
    return [sys.executable, str(script), str(os.getpid()), str(handle_file), str(sleep_seconds)]


def test_wait_ends_drain_at_grace_when_outside_process_holds_stdout(tmp_path: Path) -> None:
    handle_file = tmp_path / "held-handle.txt"
    held = _HeldPipe(handle_file)
    service = OwnedProcessService(max_active=1, max_queued=0)
    try:
        started = time.monotonic()
        result = service.run(
            _escaper_argv(tmp_path, handle_file, 0.0),
            cwd=tmp_path,
            timeout_seconds=_HOLDER_RELEASE_SECONDS * 2,
        )
        elapsed = time.monotonic() - started
        assert held.wait_until_held(0) is True
    finally:
        held.close()

    assert elapsed < PIPE_DRAIN_GRACE_SECONDS + _STARTUP_AND_TEARDOWN_BOUND_SECONDS
    assert result.returncode == 0
    assert result.timed_out is False
    assert result.drain_incomplete is True
    assert "escaped" in result.stdout
    assert result.cleanup_verdict.cleanup == "confirmed"
    assert result.cleanup_verdict.output_readers_terminated is True
    assert service.snapshot().active == 0


def test_abort_returns_promptly_when_outside_process_holds_stdout(tmp_path: Path) -> None:
    handle_file = tmp_path / "held-handle.txt"
    held = _HeldPipe(handle_file)
    service = OwnedProcessService(max_active=1, max_queued=0)
    abort_event = threading.Event()
    aborted_at: list[float] = []

    def _abort_once_held() -> None:
        if held.wait_until_held(10.0):
            aborted_at.append(time.monotonic())
            abort_event.set()

    trigger = threading.Thread(target=_abort_once_held, daemon=True)
    trigger.start()
    try:
        result = service.run(
            _escaper_argv(tmp_path, handle_file, 30.0),
            cwd=tmp_path,
            timeout_seconds=_HOLDER_RELEASE_SECONDS * 2,
            abort_event=abort_event,
        )
        returned_at = time.monotonic()
    finally:
        held.close()
        trigger.join(timeout=1)

    assert aborted_at, "the escaper never handed its stdout to the holder"
    assert returned_at - aborted_at[0] < (
        PIPE_DRAIN_GRACE_SECONDS + _STARTUP_AND_TEARDOWN_BOUND_SECONDS
    )
    assert result.aborted is True
    assert result.drain_incomplete is True
    assert "escaped" in result.stdout
    assert result.cleanup_verdict.cleanup == "confirmed"
    assert service.snapshot().active == 0


def test_close_process_pipes_cancels_a_blocked_read_before_closing() -> None:
    read_fd, write_fd = os.pipe()
    pipe = open(read_fd, "rb", buffering=0)
    errors: list[str] = []

    def _read() -> None:
        try:
            pipe.read(16)
        except OSError as error:
            errors.append(type(error).__name__)

    reader = threading.Thread(target=_read, daemon=True)
    reader.start()
    time.sleep(0.2)
    closed: list[object] = []
    started = time.monotonic()
    try:
        close_process_pipes(
            (None, pipe, None),
            (reader,),
            close_pipe=lambda item: (item.close(), closed.append(item)),
        )
        elapsed = time.monotonic() - started
    finally:
        os.close(write_fd)

    assert elapsed < READER_CANCEL_SECONDS + 0.5
    assert reader.is_alive() is False
    assert errors == ["OSError"]
    assert closed == [pipe]
    assert pipe.closed is True
