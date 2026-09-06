"""Windows Job Object management for python runtime subprocesses."""

from __future__ import annotations

import ctypes
import subprocess
import sys
from ctypes import wintypes

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    # type-ignores: ctypes only exposes the Win32 surface in win32 typeshed builds,
    # and mypy cannot narrow on the IS_WINDOWS variable (tests monkeypatch it).
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    ntdll = ctypes.WinDLL("ntdll", use_last_error=True)  # type: ignore[attr-defined]

    JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
    JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
    JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    RESUME_THREAD_FAILED = 0xFFFFFFFF
    JobObjectExtendedLimitInformation = 9

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = (
        wintypes.HANDLE,
        wintypes.INT,
        ctypes.c_void_p,
        wintypes.DWORD,
    )
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.ResumeThread.argtypes = (wintypes.HANDLE,)
    kernel32.ResumeThread.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    ntdll.NtResumeProcess.argtypes = (wintypes.HANDLE,)
    ntdll.NtResumeProcess.restype = ctypes.c_long


def _raise_last_error(message: str) -> None:
    error_code = ctypes.get_last_error()  # type: ignore[attr-defined]
    raise OSError(error_code, f"{message} (winerror={error_code})")


def _raise_ntstatus(message: str, status: int) -> None:
    raise OSError(f"{message} (ntstatus=0x{status & 0xFFFFFFFF:08x})")


class JobObject:
    def __init__(self, *, memory_limit_mb: int = 512, max_processes: int = 5) -> None:
        self._memory_limit_mb = max(1, int(memory_limit_mb))
        self._max_processes = max(1, int(max_processes))
        self._handle = None

    def __enter__(self) -> "JobObject":
        if not IS_WINDOWS:
            return self

        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            _raise_last_error("Failed to create Windows Job Object")

        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = (
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        info.BasicLimitInformation.ActiveProcessLimit = self._max_processes
        memory_limit_bytes = self._memory_limit_mb * 1024 * 1024
        info.ProcessMemoryLimit = memory_limit_bytes
        info.JobMemoryLimit = memory_limit_bytes
        if not kernel32.SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            kernel32.CloseHandle(handle)
            _raise_last_error("Failed to configure Windows Job Object")
        self._handle = handle
        return self

    def assign(self, proc: subprocess.Popen) -> None:
        if not IS_WINDOWS or self._handle is None:
            return
        process_handle = wintypes.HANDLE(int(proc._handle))  # type: ignore[attr-defined]
        if not kernel32.AssignProcessToJobObject(self._handle, process_handle):
            _raise_last_error("Failed to assign process to Windows Job Object")

    def resume(self, proc: subprocess.Popen) -> None:
        if not IS_WINDOWS or self._handle is None:
            return
        thread_handle = getattr(proc, "_thread", None)
        if thread_handle is not None:
            if kernel32.ResumeThread(wintypes.HANDLE(int(thread_handle))) == RESUME_THREAD_FAILED:
                _raise_last_error("Failed to resume Windows Job Object process")
            return
        process_handle = wintypes.HANDLE(int(proc._handle))  # type: ignore[attr-defined]
        status = int(ntdll.NtResumeProcess(process_handle))
        if status < 0:
            _raise_ntstatus("Failed to resume Windows Job Object process", status)

    def close(self) -> None:
        if not IS_WINDOWS or self._handle is None:
            return
        kernel32.CloseHandle(self._handle)
        self._handle = None

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()
