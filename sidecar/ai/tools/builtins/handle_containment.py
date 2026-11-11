"""Open-time workspace containment for an already-opened file handle.

The handle's final path is fully resolved, so it is compared against the
workspace root's final form: a workspace that itself sits under a junction,
symlink or substituted drive is not refused. A scan of many files resolves the
root once (``FinalRoot``) and checks each handle against it; the Windows API
binding is built once per process.
"""

from __future__ import annotations

import functools
import os
from pathlib import Path
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_OUTSIDE_WORKSPACE
from sidecar.ai.tools.contracts import ToolExecutionFailure


class FinalRoot:
    """A workspace root resolved to its final form, reusable across many handles."""

    __slots__ = ("_folded_parts", "_parts", "path")

    def __init__(self, authorized_root: Path) -> None:
        self.path = Path(os.path.realpath(authorized_root))
        self._parts = Path(os.path.normpath(self.path)).parts
        self._folded_parts = tuple(part.casefold() for part in self._parts)

    def contains(self, candidate: Path, *, casefold: bool = False) -> bool:
        parts = Path(os.path.normpath(candidate)).parts
        root_parts = self._parts
        if casefold:
            parts = tuple(part.casefold() for part in parts)
            root_parts = self._folded_parts
        return len(parts) >= len(root_parts) and parts[: len(root_parts)] == root_parts


def resolve_final_root(authorized_root: Path) -> FinalRoot | None:
    """The root's final form, or None when it cannot be resolved (every check then fails)."""
    try:
        return FinalRoot(authorized_root)
    except Exception:  # noqa: BLE001 - an unresolvable root fails closed at each check.
        return None


def verify_handle_within(handle: Any, resolved: Path, root: FinalRoot | None) -> None:
    """Raise the outside-workspace failure unless the opened handle sits under ``root``."""
    if root is None:
        raise _workspace_containment_failure()
    try:
        if os.name == "nt":
            final_path = _windows_final_path(handle.fileno())
            matches = root.contains(final_path, casefold=True)
        elif Path("/proc/self/fd").is_dir():
            descriptor_path = f"/proc/self/fd/{handle.fileno()}"
            if not os.path.lexists(descriptor_path):
                raise OSError("opened file descriptor is unavailable through /proc")
            final_path = Path(os.path.realpath(descriptor_path))
            matches = root.contains(final_path)
        else:
            handle_stat = os.fstat(handle.fileno())
            final_path = Path(os.path.realpath(resolved))
            final_stat = os.stat(final_path)
            matches = root.contains(final_path) and (
                (final_stat.st_dev, final_stat.st_ino) == (handle_stat.st_dev, handle_stat.st_ino)
            )
    except ToolExecutionFailure:
        raise
    except Exception as error:
        raise _workspace_containment_failure() from error
    if not matches:
        raise _workspace_containment_failure()


def _workspace_containment_failure() -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_OUTSIDE_WORKSPACE,
        message="resolved path escapes tools workspace root",
        retryable=False,
    )


@functools.cache
def _get_final_path_function() -> Any:
    import ctypes  # unavailable Windows APIs are loaded only on Windows.
    from ctypes import wintypes  # Windows-only definitions.

    function = ctypes.WinDLL("kernel32", use_last_error=True).GetFinalPathNameByHandleW
    function.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    function.restype = wintypes.DWORD
    return function


def _windows_final_path(fd: int) -> Path:
    import ctypes
    import msvcrt  # unavailable on POSIX.
    from ctypes import wintypes

    get_final_path = _get_final_path_function()
    os_handle = wintypes.HANDLE(msvcrt.get_osfhandle(fd))
    capacity = 1024
    while True:
        buffer = ctypes.create_unicode_buffer(capacity)
        length = get_final_path(os_handle, buffer, capacity, 0)
        if length == 0:
            error_code = ctypes.get_last_error()
            raise OSError(error_code, ctypes.FormatError(error_code))
        if length < capacity:
            return Path(strip_windows_device_prefix(buffer.value))
        capacity = length + 1


def strip_windows_device_prefix(path: str) -> str:
    if path.casefold().startswith("\\\\?\\unc\\"):
        return "\\\\" + path[8:]
    if path.casefold().startswith("\\\\?\\"):
        return path[4:]
    return path
