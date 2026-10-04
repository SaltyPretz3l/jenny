"""Opt a process tree out of Windows power throttling (EcoQoS).

Windows 11 treats windowless test processes as background work and parks them
on the efficiency cores at low clocks. Under the Node lane a 7.7 s jsdom file
took 45 s at ~30% total CPU and heavy files hit their per-file watchdogs;
opting the processes out cut the same contended run to 10.6 s (2026-10-03,
A/B/A). The opt-out is per-process and not inherited, so a keeper opts every
process in one tree out as it appears. It sets only these processes' QoS, never
a system power setting, and is a no-op off Windows. Windows reuses PIDs quickly
and a test run starts thousands of processes, so a handled process is
identified by PID plus creation time; a PID alone would leave a later process
that reuses it throttled.

`run_ci.py` runs the keeper as a thread over its own tree. The safe Node runner
starts this file as a helper process (`--root-pid <runner pid>`) so a direct
`npm test` run gets the same treatment; the helper exits when that root does.
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
from collections.abc import Callable

_PROCESS_POWER_THROTTLING = 4
_POWER_THROTTLING_CONTROL = 0x1 | 0x4  # EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION
_KEEPER_INTERVAL_SECONDS = 0.25
_WAIT_TIMEOUT = 0x102  # WaitForSingleObject: the process has not exited
# Set for child processes once a keeper covers the tree, so a nested safe-runner
# does not start a second one.
ACTIVE_ENV_VAR = "JENNY_POWER_KEEPER_ACTIVE"


def _descendant_pids(
    parent_by_pid: dict[int, int],
    root_pid: int,
    is_child: Callable[[int, int], bool] | None = None,
) -> set[int]:
    """Walk the tree under ``root_pid``.

    A snapshot's parent PID can be stale: when a parent exits, its PID may be
    reused by an unrelated later process, which then looks like the parent of
    the orphan. ``is_child(parent, child)`` lets the caller reject such an edge
    (the keeper requires the child to be no older than its parent).
    """
    children: dict[int, list[int]] = {}
    for pid, parent in parent_by_pid.items():
        if pid != parent:
            children.setdefault(parent, []).append(pid)
    found: set[int] = set()
    pending = [root_pid]
    while pending:
        parent = pending.pop()
        for child in children.get(parent, []):
            if child not in found and (is_child is None or is_child(parent, child)):
                found.add(child)
                pending.append(child)
    return found


class _PowerThrottlingKeeper:
    def __init__(self, root_pid: int | None = None) -> None:
        import ctypes
        from ctypes import wintypes

        class _State(ctypes.Structure):
            _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG),
                        ("StateMask", wintypes.ULONG)]

        class _Entry(ctypes.Structure):
            _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
                        ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.SetProcessInformation.restype = wintypes.BOOL
        kernel32.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                                   wintypes.DWORD]
        kernel32.GetProcessTimes.restype = wintypes.BOOL
        kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.c_void_p] * 4
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self._ctypes = ctypes
        self._kernel32 = kernel32
        self._state = _State(1, _POWER_THROTTLING_CONTROL, 0)
        self._entry_type = _Entry
        self._root_pid = os.getpid() if root_pid is None else root_pid
        # Held for the keeper's life: an open handle keeps the PID from being
        # reused, and its signalled state says the root exited even while another
        # process still holds the dead process object open.
        # SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
        self._root_handle = kernel32.OpenProcess(0x00100000 | 0x1000, False, self._root_pid)
        self._previous_marker: str | None = None
        self._owns_marker = False
        self._handled: dict[int, int] = {}  # pid -> creation time
        self.opted_out = 0
        self._sweep_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="ci-power-throttling", daemon=True)

    def _opt_out(self, handle: object) -> bool:
        ctypes = self._ctypes
        size = ctypes.sizeof(self._state)
        return bool(self._kernel32.SetProcessInformation(
            handle, _PROCESS_POWER_THROTTLING, ctypes.byref(self._state), size))

    def _creation_time(self, handle: object) -> int:
        times = (self._ctypes.c_ulonglong * 4)()
        refs = [self._ctypes.byref(times, 8 * index) for index in range(4)]
        if not self._kernel32.GetProcessTimes(handle, *refs):
            return 0
        return int(times[0])

    def _pid_creation_time(self, pid: int) -> int:
        handle = self._kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            return 0
        try:
            return self._creation_time(handle)
        finally:
            self._kernel32.CloseHandle(handle)

    def root_alive(self) -> bool:
        """False once the root process has exited (or could never be opened)."""
        if not self._root_handle:
            return False
        return bool(self._kernel32.WaitForSingleObject(self._root_handle, 0) == _WAIT_TIMEOUT)

    def _parent_by_pid(self) -> dict[int, int]:
        kernel32 = self._kernel32
        snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
        if not snapshot or snapshot == self._ctypes.c_void_p(-1).value:
            return {}
        try:
            entry = self._entry_type()
            entry.dwSize = self._ctypes.sizeof(entry)
            parents: dict[int, int] = {}
            ok = kernel32.Process32FirstW(snapshot, self._ctypes.byref(entry))
            while ok:
                parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
                ok = kernel32.Process32NextW(snapshot, self._ctypes.byref(entry))
            return parents
        finally:
            kernel32.CloseHandle(snapshot)

    def sweep(self) -> int:
        with self._sweep_lock:
            return self._sweep_locked()

    def _sweep_locked(self) -> int:
        opted = 0
        created_by_pid: dict[int, int] = {}

        def created_at(pid: int) -> int:
            if pid not in created_by_pid:
                created_by_pid[pid] = self._pid_creation_time(pid)
            return created_by_pid[pid]

        def is_child(parent: int, child: int) -> bool:
            # Unknown identities are rejected rather than trusted.
            return 0 < created_at(parent) <= created_at(child)

        tree = _descendant_pids(self._parent_by_pid(), self._root_pid, is_child) | {self._root_pid}
        for pid in self._handled.keys() - tree:
            del self._handled[pid]
        for pid in tree:
            # PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION
            handle = self._kernel32.OpenProcess(0x0200 | 0x1000, False, pid)
            if not handle:
                continue
            try:
                created = self._creation_time(handle)
                if created and self._handled.get(pid) == created:
                    continue
                if self._opt_out(handle):
                    self._handled[pid] = created
                    opted += 1
            finally:
                self._kernel32.CloseHandle(handle)
        self.opted_out += opted
        return opted

    def _run(self) -> None:
        while not self._stop.wait(_KEEPER_INTERVAL_SECONDS):
            try:
                self.sweep()
            except OSError:
                pass

    def start(self) -> None:
        self.sweep()
        self._previous_marker = os.environ.get(ACTIVE_ENV_VAR)
        os.environ[ACTIVE_ENV_VAR] = "1"
        self._owns_marker = True
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
        # The marker claims a live keeper; a stopped one must not leave it behind
        # for a runner started later from this process.
        if self._owns_marker:
            self._owns_marker = False
            if self._previous_marker is None:
                os.environ.pop(ACTIVE_ENV_VAR, None)
            else:
                os.environ[ACTIVE_ENV_VAR] = self._previous_marker


def _start_power_throttling_keeper() -> _PowerThrottlingKeeper | None:
    if not sys.platform.startswith("win"):
        return None
    try:
        keeper = _PowerThrottlingKeeper()
        keeper.start()
    except (AttributeError, OSError):
        return None
    return keeper


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root-pid", type=int, required=True,
                        help="Keep this process and its descendants opted out until it exits.")
    args = parser.parse_args()
    if not sys.platform.startswith("win"):
        return 0
    try:
        keeper = _PowerThrottlingKeeper(args.root_pid)
        while keeper.root_alive():
            keeper.sweep()
            if keeper._stop.wait(_KEEPER_INTERVAL_SECONDS):
                break
    except (AttributeError, OSError):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
