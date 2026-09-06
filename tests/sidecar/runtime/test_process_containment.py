"""The real containment objects, where the fakes stop being evidence.

``test_subprocess_containment.py`` proves the *policy* with an injected fake on
any platform. This file proves the two implementations underneath it: the POSIX
process-group logic against a monkeypatched ``os``, and the Win32 Job Object
against the actual kernel. The split exists because a stubbed containment will
cheerfully agree that a truncated 64-bit HANDLE produced a working job.
"""

from __future__ import annotations

import os
from ctypes import wintypes
from types import SimpleNamespace

import pytest

from sidecar.runtime.process_containment import (
    _POSIX_SIGKILL,
    PosixProcessGroupContainment,
    process_exists,
)
from sidecar.runtime.subprocess_manager import SubprocessManager

# ---------------------------------------------------------------------------
# The real containment objects (the part the fakes cannot vouch for)
# ---------------------------------------------------------------------------


class _FakeWinFunction:
    def __init__(self, result: int, calls: list[tuple[object, ...]]) -> None:
        self.argtypes: list[object] | None = None
        self.restype: object | None = None
        self._result = result
        self._calls = calls

    def __call__(self, *args: object) -> int:
        self._calls.append(args)
        return self._result


def test_process_exists_pins_win32_handle_abi_before_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    open_calls: list[tuple[object, ...]] = []
    close_calls: list[tuple[object, ...]] = []
    handle = 0x1_0000_0042
    open_process = _FakeWinFunction(handle, open_calls)
    close_handle = _FakeWinFunction(1, close_calls)
    kernel32 = SimpleNamespace(OpenProcess=open_process, CloseHandle=close_handle)
    monkeypatch.setattr("sidecar.runtime.process_containment.os.name", "nt")
    monkeypatch.setattr(
        "sidecar.runtime.process_containment.ctypes.windll",
        SimpleNamespace(kernel32=kernel32),
        raising=False,
    )

    assert process_exists(5150) is True
    assert open_process.argtypes == [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    assert open_process.restype is wintypes.HANDLE
    assert close_handle.argtypes == [wintypes.HANDLE]
    assert close_handle.restype is wintypes.BOOL
    assert open_calls == [(0x1000, False, 5150)]
    assert close_calls == [(handle,)]


def test_posix_containment_verifies_group_leadership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    containment = PosixProcessGroupContainment()
    containment.assign(5150)

    monkeypatch.setattr(os, "getpgid", lambda pid: pid, raising=False)
    assert containment.verify() is True

    # The child exists but leads someone else's group: setsid did not take, so
    # signalling "its" group would hit unrelated processes.
    monkeypatch.setattr(os, "getpgid", lambda _pid: 1, raising=False)
    assert containment.verify() is False


def test_posix_containment_treats_a_vanished_child_as_unverified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail closed: a process we cannot locate is not a group we own."""
    def gone(_pid: int) -> int:
        raise ProcessLookupError("no such process")

    monkeypatch.setattr(os, "getpgid", gone, raising=False)
    containment = PosixProcessGroupContainment()
    containment.assign(5151)
    assert containment.verify() is False


def test_posix_containment_kill_tree_signals_the_whole_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signals: list[tuple[int, int]] = []
    monkeypatch.setattr(
        os, "killpg", lambda pid, sig: signals.append((pid, sig)), raising=False
    )
    containment = PosixProcessGroupContainment()
    containment.assign(5152)
    containment.kill_tree()

    assert signals == [(5152, _POSIX_SIGKILL)]


@pytest.mark.skipif(os.name != "nt", reason="Win32 Job Object interrogation")
def test_windows_job_object_reports_and_reaps_a_real_child() -> None:
    """End-to-end proof of the receipt against the actual kernel.

    Everything above this line runs against a fake, which can confirm the policy
    but not the Win32 ABI. This is the case that would catch an unpinned
    ``restype`` truncating a 64-bit HANDLE - a job that reports success and
    contains nothing - because it asks the job which pids it holds and then
    requires that list to be empty before calling the tree terminated.
    """
    manager = SubprocessManager()
    try:
        process = manager.spawn_module(
            "http.server",
            args=["0"],
            task_key="win:real-tree",
        )
        containment = manager._children["win:real-tree"].containment  # noqa: SLF001
        assert containment is not None
        assert containment.kind == "windows_job_object"
        assert containment.verify() is True, "IsProcessInJob must confirm membership"
        assert process.pid in containment.surviving_pids()
        assert containment.is_empty() is False

        receipt = manager.terminate_task("win:real-tree", timeout_seconds=10.0)

        assert receipt.contained is True
        assert receipt.reaped is True
        assert receipt.tree_empty is True, "QueryInformationJobObject must go empty"
        assert receipt.terminated is True
        assert receipt.surviving_pids == ()
    finally:
        manager.close(timeout_seconds=5.0)
