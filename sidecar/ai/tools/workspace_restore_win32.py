"""Handle-relative directory creation for Windows restore I/O (w2f5-R1).

``os.mkdir`` takes no ``dir_fd`` on Windows, so a pathname create follows an
ancestor swapped for a junction after the last check. These primitives hold
the parent open, verify through that handle that it is the directory the
caller ``lstat``-ed, create one child relative to it (``NtCreateFile`` with
``RootDirectory``), and remove exactly the node a handle names. Every call is
Windows only.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from sidecar.ai.tools.workspace_path_identity import NodeIdentity

_FILE_ATTRIBUTE_DIRECTORY = 0x10
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400
_FILE_LIST_DIRECTORY = 0x0001
_FILE_WRITE_ATTRIBUTES = 0x0100
_DELETE = 0x00010000
_SYNCHRONIZE = 0x00100000
_SHARE_ALL = 0x1 | 0x2 | 0x4  # read, write, delete: renames of the held directory stay possible
_OPEN_EXISTING = 3
_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
_FILE_ATTRIBUTE_NORMAL = 0x80
_FILE_CREATE = 2
_FILE_DIRECTORY_FILE = 0x00000001
_FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020
_FILE_OPEN_REPARSE_POINT = 0x00200000
_OBJ_CASE_INSENSITIVE = 0x40
_FILE_DISPOSITION_INFO_CLASS = 4
_DUPLICATE_SAME_ACCESS = 0x2
STATUS_OBJECT_NAME_COLLISION = 0xC0000035
_WINDOWS_ONLY = "handle-relative restore is Windows only"
_NOT_ONE_COMPONENT = frozenset("\\/:\x00")


class HandleIdentityMismatch(OSError):
    """A held directory handle does not name the directory the caller validated."""


if sys.platform == "win32":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class _UnicodeString(ctypes.Structure):
        _fields_ = [
            ("Length", wintypes.USHORT),
            ("MaximumLength", wintypes.USHORT),
            ("Buffer", wintypes.LPWSTR),
        ]

    class _ObjectAttributes(ctypes.Structure):
        _fields_ = [
            ("Length", wintypes.ULONG),
            ("RootDirectory", wintypes.HANDLE),
            ("ObjectName", ctypes.POINTER(_UnicodeString)),
            ("Attributes", wintypes.ULONG),
            ("SecurityDescriptor", wintypes.LPVOID),
            ("SecurityQualityOfService", wintypes.LPVOID),
        ]

    class _IoStatusBlock(ctypes.Structure):
        # The Status/Pointer union is pointer-sized.
        _fields_ = [("Status", ctypes.c_void_p), ("Information", ctypes.c_size_t)]

    class _FileDispositionInfo(ctypes.Structure):
        _fields_ = [("DeleteFile", wintypes.BOOLEAN)]

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _ntdll = ctypes.WinDLL("ntdll")

    _CreateFileW = _kernel32.CreateFileW
    _CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    _CreateFileW.restype = wintypes.HANDLE
    _CloseHandle = _kernel32.CloseHandle
    _CloseHandle.argtypes = [wintypes.HANDLE]
    _CloseHandle.restype = wintypes.BOOL
    _GetCurrentProcess = _kernel32.GetCurrentProcess
    _GetCurrentProcess.argtypes = []
    _GetCurrentProcess.restype = wintypes.HANDLE
    _DuplicateHandle = _kernel32.DuplicateHandle
    _DuplicateHandle.argtypes = [
        wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.HANDLE),
        wintypes.DWORD, wintypes.BOOL, wintypes.DWORD,
    ]
    _DuplicateHandle.restype = wintypes.BOOL
    _SetFileInformationByHandle = _kernel32.SetFileInformationByHandle
    _SetFileInformationByHandle.argtypes = [
        wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
    ]
    _SetFileInformationByHandle.restype = wintypes.BOOL
    _NtCreateFile = _ntdll.NtCreateFile
    _NtCreateFile.argtypes = [
        ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, ctypes.POINTER(_ObjectAttributes),
        ctypes.POINTER(_IoStatusBlock), wintypes.LPVOID, wintypes.ULONG, wintypes.ULONG,
        wintypes.ULONG, wintypes.ULONG, wintypes.LPVOID, wintypes.ULONG,
    ]
    _NtCreateFile.restype = ctypes.c_long
    _INVALID_HANDLE = wintypes.HANDLE(-1).value


def open_directory_handle(path: Path, expected: NodeIdentity) -> int:
    """Open ``path`` itself (never a link's target) and prove it is ``expected``.

    The proof reads through the handle: a directory, not a reparse point, and
    the same volume serial and file index ``os.lstat`` reported.
    """
    if sys.platform == "win32":
        handle = _CreateFileW(
            str(path), _FILE_LIST_DIRECTORY | _SYNCHRONIZE, _SHARE_ALL, None, _OPEN_EXISTING,
            _FILE_FLAG_BACKUP_SEMANTICS | _FILE_FLAG_OPEN_REPARSE_POINT, None,
        )
        if handle is None or handle == _INVALID_HANDLE:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            opened = _handle_stat(handle)
            attributes = int(getattr(opened, "st_file_attributes", 0))
            if (
                not attributes & _FILE_ATTRIBUTE_DIRECTORY
                or attributes & _FILE_ATTRIBUTE_REPARSE_POINT
                or not NodeIdentity.from_stat(opened).same_object(expected)
            ):
                raise HandleIdentityMismatch("the handle does not name the validated parent")
        except BaseException:
            close_handle(handle)
            raise
        return int(handle)
    raise OSError(_WINDOWS_ONLY)


def handle_identity(handle: int) -> NodeIdentity:
    """The identity of the object ``handle`` names, read through the handle."""
    if sys.platform == "win32":
        return NodeIdentity.from_stat(_handle_stat(handle))
    raise OSError(_WINDOWS_ONLY)


def create_directory_relative(parent_handle: int, name: str) -> int:
    """Create the directory ``name`` inside the held parent; return its handle."""
    if sys.platform == "win32":
        if name in {"", ".", ".."} or any(character in _NOT_ONE_COMPONENT for character in name):
            raise ValueError("a handle-relative create takes one path component")
        length = len(name.encode("utf-16-le"))
        buffer = ctypes.create_unicode_buffer(name)
        object_name = _UnicodeString(length, length + 2, ctypes.cast(buffer, wintypes.LPWSTR))
        attributes = _ObjectAttributes(
            ctypes.sizeof(_ObjectAttributes), parent_handle, ctypes.pointer(object_name),
            _OBJ_CASE_INSENSITIVE, None, None,
        )
        created = wintypes.HANDLE()
        status_block = _IoStatusBlock()
        status = _NtCreateFile(
            ctypes.byref(created),
            _FILE_LIST_DIRECTORY | _DELETE | _FILE_WRITE_ATTRIBUTES | _SYNCHRONIZE,
            ctypes.byref(attributes), ctypes.byref(status_block), None, _FILE_ATTRIBUTE_NORMAL,
            _SHARE_ALL, _FILE_CREATE,
            _FILE_DIRECTORY_FILE | _FILE_OPEN_REPARSE_POINT | _FILE_SYNCHRONOUS_IO_NONALERT,
            None, 0,
        ) & 0xFFFFFFFF
        if status == STATUS_OBJECT_NAME_COLLISION:
            raise FileExistsError(f"{name} already exists (NTSTATUS 0x{status:08X})")
        if status & 0x80000000 or not created.value:
            raise OSError(f"NtCreateFile failed for {name} (NTSTATUS 0x{status:08X})")
        return int(created.value)
    raise OSError(_WINDOWS_ONLY)


def delete_by_handle(handle: int) -> None:
    """Mark the node ``handle`` names for deletion; it goes once the handle closes."""
    if sys.platform == "win32":
        info = _FileDispositionInfo(True)
        if not _SetFileInformationByHandle(
            handle, _FILE_DISPOSITION_INFO_CLASS, ctypes.byref(info), ctypes.sizeof(info)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        return
    raise OSError(_WINDOWS_ONLY)


def close_handle(handle: int) -> None:
    if sys.platform == "win32":
        _CloseHandle(handle)
        return
    raise OSError(_WINDOWS_ONLY)


def _handle_stat(handle: int) -> os.stat_result:
    """``os.fstat`` of a duplicate of ``handle``.

    CPython derives ``st_dev``/``st_ino`` from the handle exactly as ``lstat``
    does (volume serial and file index; FILE_ID_INFO from 3.12), so the two
    identities stay comparable on every supported version.
    """
    if sys.platform == "win32":
        process = _GetCurrentProcess()
        duplicate = wintypes.HANDLE()
        if not _DuplicateHandle(
            process, handle, process, ctypes.byref(duplicate), 0, False, _DUPLICATE_SAME_ACCESS
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            descriptor = msvcrt.open_osfhandle(int(duplicate.value or 0), os.O_RDONLY)
        except BaseException:
            _CloseHandle(duplicate)
            raise
        try:  # the descriptor owns the duplicate from here
            return os.fstat(descriptor)
        finally:
            os.close(descriptor)
    raise OSError(_WINDOWS_ONLY)


__all__ = [
    "HandleIdentityMismatch", "STATUS_OBJECT_NAME_COLLISION", "close_handle",
    "create_directory_relative", "delete_by_handle", "handle_identity", "open_directory_handle",
]
