"""Win32 Job Object containment, shared by every sidecar that spawns a tree.

A dependency-free leaf: stdlib only, and it imports nothing from ``sidecar``.
That lets owned processes, LSP, and codex-cli share one implementation instead
of keeping private copies.

Why one copy matters here more than DRY usually does: handle widths, assignment
failures, last-error capture and cleanup ordering are exactly the details that
drift silently between duplicates. The ABI is pinned in
:func:`_configure_kernel32` precisely because an unpinned ``restype`` defaults to
C ``int`` and truncates a 64-bit ``HANDLE`` - a bug that produces a job which
looks created and contains nothing.

``KILL_ON_JOB_CLOSE`` is the reason this is a kernel-owned guarantee rather than
a best-effort cleanup: the last handle to the job closes when the owning process
dies *however* it dies, and Windows then terminates every process still in the
job. No ``finally`` block, watchdog or tree-walk can offer that.

This module deliberately does not spawn anything. Assigning a process to a job
*after* ``CreateProcess`` returns is racy - descendants created in that window
are not retroactively contained - so callers must pair it with a launch gate
that keeps the real command from starting until assignment has succeeded. See
``sidecar/_owned_process_bootstrap.py`` for the bootstrap that does exactly that.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
from typing import Protocol, cast

__all__ = [
    "WindowsJobObject",
    "windows_process_is_alive",
]

_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_TERMINATE = 0x0001
_PROCESS_ASSIGN_PROCESS = 0x0080
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3
_ERROR_ACCESS_DENIED = 5
_ERROR_MORE_DATA = 234
_STILL_ACTIVE = 259
# Starting room for the assigned-pid query. A generation tree (torch/inductor
# compile workers plus CUDA helpers) is dozens of processes at worst, so one
# call almost always suffices; the query grows and retries when it does not.
_PROCESS_ID_LIST_CAPACITY = 64
_PROCESS_ID_LIST_MAX_CAPACITY = 4096


class _WinFunction(Protocol):
    argtypes: list[object] | None
    restype: object | None

    def __call__(self, *args: object) -> int | None: ...


class _Kernel32(Protocol):
    CreateJobObjectW: _WinFunction
    SetInformationJobObject: _WinFunction
    QueryInformationJobObject: _WinFunction
    IsProcessInJob: _WinFunction
    TerminateJobObject: _WinFunction
    OpenProcess: _WinFunction
    AssignProcessToJobObject: _WinFunction
    CloseHandle: _WinFunction
    GetExitCodeProcess: _WinFunction
    GetLastError: _WinFunction


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _process_id_list_type(capacity: int) -> type[ctypes.Structure]:
    """JOBOBJECT_BASIC_PROCESS_ID_LIST sized for ``capacity`` pids.

    The Win32 struct declares ``ProcessIdList`` as a one-element trailing array
    that the caller is expected to over-allocate, so the type has to be built
    per query rather than declared once. ``ULONG_PTR`` is pointer-width, which
    is what ``c_size_t`` gives on both 32- and 64-bit Python - spelling it
    ``DWORD`` would silently halve the stride on win64 and return garbage pids.
    """

    class _ProcessIdList(ctypes.Structure):
        _fields_ = [
            ("NumberOfAssignedProcesses", wintypes.DWORD),
            ("NumberOfProcessIdsInList", wintypes.DWORD),
            ("ProcessIdList", ctypes.c_size_t * max(int(capacity), 1)),
        ]

    return _ProcessIdList


def _load_kernel32() -> _Kernel32:
    windll = getattr(ctypes, "windll", None)
    if windll is None:
        raise OSError("Win32 APIs are unavailable")
    return cast(_Kernel32, windll.kernel32)


def _pin_optional(
    kernel32: _Kernel32,
    name: str,
    argtypes: list[object],
    restype: object,
) -> _WinFunction | None:
    function = getattr(kernel32, name, None)
    if function is None:
        return None
    function.argtypes = argtypes
    function.restype = restype
    return cast(_WinFunction, function)


def _configure_kernel32(kernel32: _Kernel32) -> _Kernel32:
    """Pin every Win32 ABI so 64-bit HANDLE values cannot be truncated."""
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    # The interrogation trio is pinned through _pin_optional rather than
    # attribute assignment: a real kernel32 always exports all three, but the
    # hand-written _Kernel32 doubles in the existing test suite only implement
    # the calls they exercise, and an unconditional assignment would turn a
    # missing double attribute into an AttributeError at construction time.
    _pin_optional(
        kernel32,
        "QueryInformationJobObject",
        [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ],
        wintypes.BOOL,
    )
    _pin_optional(
        kernel32,
        "IsProcessInJob",
        [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)],
        wintypes.BOOL,
    )
    _pin_optional(
        kernel32,
        "TerminateJobObject",
        [wintypes.HANDLE, wintypes.UINT],
        wintypes.BOOL,
    )
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.GetExitCodeProcess.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.GetLastError.argtypes = []
    kernel32.GetLastError.restype = wintypes.DWORD
    return kernel32


class WindowsJobObject:
    """Windows Job Object with kill-on-close tree ownership."""

    def __init__(self, *, kernel32: _Kernel32 | None = None) -> None:
        self._kernel32 = _configure_kernel32(kernel32 or _load_kernel32())
        self._handle = self._kernel32.CreateJobObjectW(None, None)
        if not self._handle:
            raise OSError("CreateJobObjectW failed")
        info = _ExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = self._kernel32.SetInformationJobObject(
            self._handle,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            self.close()
            raise OSError("SetInformationJobObject failed")

    def assign_pid(self, pid: int) -> None:
        access = (
            _PROCESS_SET_QUOTA
            | _PROCESS_TERMINATE
            | _PROCESS_ASSIGN_PROCESS
            | _PROCESS_QUERY_LIMITED_INFORMATION
        )
        process_handle = self._kernel32.OpenProcess(access, False, int(pid))
        if not process_handle:
            raise OSError("OpenProcess failed while assigning process containment")
        try:
            if not self._kernel32.AssignProcessToJobObject(
                self._handle, process_handle
            ):
                raise OSError("AssignProcessToJobObject failed")
        finally:
            self._kernel32.CloseHandle(process_handle)

    def contains_pid(self, pid: int) -> bool:
        """Ask the kernel whether ``pid`` is actually inside this job.

        ``AssignProcessToJobObject`` returning TRUE is not proof of containment
        for the purpose we need it: the call can succeed against a process that
        is already terminating, and a caller that trusts the return code alone
        will report a contained tree it does not own. ``IsProcessInJob`` is the
        only statement the kernel makes about the membership itself, so
        assignment is always confirmed by re-asking rather than by inference.
        """
        if not getattr(self, "_handle", None) or int(pid) <= 0:
            return False
        query = getattr(self._kernel32, "IsProcessInJob", None)
        if query is None:
            return False
        process_handle = self._kernel32.OpenProcess(
            _PROCESS_QUERY_LIMITED_INFORMATION,
            False,
            int(pid),
        )
        if not process_handle:
            return False
        try:
            member = wintypes.BOOL()
            if not query(process_handle, self._handle, ctypes.byref(member)):
                return False
            return bool(member.value)
        finally:
            self._kernel32.CloseHandle(process_handle)

    def assigned_process_ids(self) -> tuple[int, ...]:
        """Every pid the kernel still counts as assigned to this job.

        This is the evidence half of a termination receipt. Polling the root
        process only proves the root is gone; a Windows tree can outlive its
        root (torch/inductor compile workers, CUDA helpers) and nothing short of
        asking the job which pids remain can distinguish "reaped" from
        "orphaned". An empty list is the only proof the tree is actually gone.
        """
        handle = getattr(self, "_handle", None)
        if not handle:
            return ()
        query = getattr(self._kernel32, "QueryInformationJobObject", None)
        if query is None:
            raise OSError("QueryInformationJobObject is unavailable")
        capacity = _PROCESS_ID_LIST_CAPACITY
        while capacity <= _PROCESS_ID_LIST_MAX_CAPACITY:
            info = _process_id_list_type(capacity)()
            returned = wintypes.DWORD(0)
            ok = query(
                handle,
                _JOB_OBJECT_BASIC_PROCESS_ID_LIST,
                ctypes.byref(info),
                ctypes.sizeof(info),
                ctypes.byref(returned),
            )
            assigned = int(info.NumberOfAssignedProcesses)
            listed = int(info.NumberOfProcessIdsInList)
            if not ok:
                # ERROR_MORE_DATA still fills NumberOfAssignedProcesses, which is
                # exactly the size hint needed for the retry.
                error_code = int(self._kernel32.GetLastError() or 0)
                if error_code != _ERROR_MORE_DATA:
                    raise OSError(
                        f"QueryInformationJobObject failed with error {error_code}"
                    )
                capacity = max(assigned, capacity * 2)
                continue
            if assigned > listed:
                capacity = max(assigned, capacity * 2)
                continue
            return tuple(int(info.ProcessIdList[index]) for index in range(listed))
        raise OSError("QueryInformationJobObject process-id capacity exhausted")

    def terminate_tree(self, exit_code: int = 1) -> bool:
        """Kill every process in the job while keeping the handle queryable.

        Deliberately not "close the handle and let KILL_ON_JOB_CLOSE do it":
        that works, but it destroys the only instrument that can prove the tree
        died, so the caller would be back to inferring termination. Closing
        remains the backstop for the process-death case (see :meth:`close`);
        this is the explicit-kill case, where the answer has to be verifiable.
        """
        handle = getattr(self, "_handle", None)
        if not handle:
            return False
        terminate = getattr(self._kernel32, "TerminateJobObject", None)
        if terminate is None:
            return False
        return bool(terminate(handle, int(exit_code)))

    def close(self) -> None:
        if getattr(self, "_handle", None):
            self._kernel32.CloseHandle(self._handle)
            self._handle = None


def windows_process_is_alive(pid: int, *, kernel32: _Kernel32 | None = None) -> bool:
    """Query liveness without using ``os.kill(pid, 0)`` on Windows.

    Python's Windows ``os.kill`` delegates ordinary signals to
    ``TerminateProcess``; a zero-signal probe is therefore not a safe
    cross-platform liveness check.
    """
    if pid <= 0:
        return False
    try:
        win_api = _configure_kernel32(kernel32 or _load_kernel32())
    except OSError:
        return False
    process_handle = win_api.OpenProcess(
        _PROCESS_QUERY_LIMITED_INFORMATION,
        False,
        int(pid),
    )
    if not process_handle:
        return int(win_api.GetLastError() or 0) == _ERROR_ACCESS_DENIED
    try:
        exit_code = wintypes.DWORD()
        if not win_api.GetExitCodeProcess(process_handle, ctypes.byref(exit_code)):
            return False
        return int(exit_code.value) == _STILL_ACTIVE
    finally:
        win_api.CloseHandle(process_handle)
