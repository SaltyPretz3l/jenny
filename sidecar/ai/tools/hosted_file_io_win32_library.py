"""Find, load and check the Windows file access library, `jenny_file_access.dll`.

The library is loaded from one place only: beside `sidecar.exe` in a packaged
build, `build/sidecar/` in a source checkout; never `PATH`, the current
directory, the workspace or an environment variable. It must be a regular file,
is loaded by its full path, and its own imports are looked for in System32 only.
Imported only on `win32`. It must not import Electron or renderer code.
"""

from __future__ import annotations

import ctypes
import os
import stat
import sys
import threading
from pathlib import Path
from typing import Any, Callable, NamedTuple

from sidecar.ai.tools.hosted_file_io import COMPONENT_MISSING

LIBRARY_FILE_NAME = "jenny_file_access.dll"
ABI_VERSION = 1
TEST_EXPORT = "jfa_test_set_token_state"
# LoadLibraryExW: the named file's own imports are looked for in System32 only.
LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800

STATUS = {
    "ok": 0, "path_refused": 1, "not_found": 2, "io_failed": 3, "busy": 4,
    "durability_uncertain": 5, "buffer_too_small": 6, "invalid_argument": 7,
    "internal": 8, "platform_unsupported": 9, "api_missing": 20, "elevated": 21,
    "backup_privilege": 22, "volume_unsupported": 23, "root_invalid": 24,
    "root_identity": 25, "selfcheck_failed": 26,
}
DETAIL_REASONS = {
    "none": 0, "name_invalid": 1, "reparse_point": 2, "not_regular": 3,
    "alias_mismatch": 4, "missing_directory": 5, "too_deep": 6, "target_read_only": 7,
    "root_changed": 8,
}
EXPECTATION_KINDS = {"must_not_exist": 0, "no_expectation": 1, "bytes": 2}
WRITE_OUTCOMES = {"not_matched": 0, "replaced": 1}
LISTING_FLAG_BITS = {"directory": 0, "reparse_point": 1, "size_known": 2}
LISTING_HEADER_BYTES = 14
LIMITS = {
    "pin_table_entries": 32, "file_table_entries": 256,
    "max_write_bytes": 2147483647, "max_listing_buffer_bytes": 16777216,
}


class Signature(NamedTuple):
    name: str
    returns: str  # "u32", or "status" (an i32)
    args: tuple[tuple[str, str], ...]
    test_seams_only: bool = False


_SEGMENTS = (("segments", "ptr_utf16"), ("segments_units", "u32"))
_DETAIL = ("out_detail", "out_detail")
SIGNATURES: tuple[Signature, ...] = (
    Signature("jfa_abi_version", "u32", ()),
    Signature("jfa_build_flags", "u32", ()),
    Signature("jfa_root_open", "status", (
        ("root", "ptr_utf16"), ("root_units", "u32"), ("expected_device", "u64"),
        ("expected_inode", "u64"), ("out_pin", "out_u64"), _DETAIL)),
    Signature("jfa_pin_identity", "status", (
        ("pin", "u64"), ("out_device", "out_u64"), ("out_inode", "out_u64"))),
    Signature("jfa_pin_close", "status", (("pin", "u64"),)),
    Signature("jfa_open_file", "status", (
        ("pin", "u64"), *_SEGMENTS, ("out_token", "out_u64"), _DETAIL)),
    Signature("jfa_file_take", "status", (("token", "u64"), ("out_handle", "out_handle"))),
    Signature("jfa_file_check", "status", (("token", "u64"),)),
    Signature("jfa_file_close", "status", (("token", "u64"), ("reclaim", "u32"))),
    Signature("jfa_list", "status", (
        ("pin", "u64"), *_SEGMENTS, ("max_entries", "u32"), ("buffer", "ptr_bytes_mut"),
        ("capacity", "u32"), ("out_bytes_used", "out_u32"), ("out_entry_count", "out_u32"),
        _DETAIL)),
    Signature("jfa_write_atomic", "status", (
        ("pin", "u64"), *_SEGMENTS, ("content", "ptr_bytes"), ("content_len", "usize"),
        ("expectation_kind", "u32"), ("expected", "ptr_bytes"), ("expected_len", "usize"),
        ("out_outcome", "out_u32"), _DETAIL)),
    Signature(TEST_EXPORT, "status", (("state", "u32"),), test_seams_only=True),
)


def ctypes_type(kind: str) -> Any:
    """The `ctypes` type for one `abi.json` argument kind (or "status" / "u32" result)."""
    pointer = ctypes.POINTER
    return {
        "u32": ctypes.c_uint32, "u64": ctypes.c_uint64, "usize": ctypes.c_size_t,
        "status": ctypes.c_int32,
        "ptr_utf16": pointer(ctypes.c_uint16), "ptr_bytes": ctypes.c_char_p,
        "ptr_bytes_mut": pointer(ctypes.c_ubyte),
        "out_u32": pointer(ctypes.c_uint32), "out_u64": pointer(ctypes.c_uint64),
        "out_handle": pointer(ctypes.c_size_t), "out_detail": pointer(ctypes.c_uint32),
    }[kind]


class ComponentMissing(Exception):
    """`file_access_component_missing`; `detail` is missing, load_failed,
    version_mismatch or test_build."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"{COMPONENT_MISSING}: {detail}")
        self.detail = detail


class FileAccessLibrary:
    """The bound exports. A caught panic (status `internal`) latches it off for
    the process: every later call answers `internal` without reaching the library."""

    def __init__(self, functions: dict[str, Any]) -> None:
        self._functions = functions
        self._latched = False

    @property
    def latched(self) -> bool:
        return self._latched

    def latch(self) -> None:
        """Latch off because another process's copy latched (`latch_shared_library`)."""
        self._latched = True

    def call(self, name: str, *args: Any) -> int:
        if self._latched:
            return STATUS["internal"]
        status = int(self._functions[name](*args))
        if status == STATUS["internal"]:
            self._latched = True
        return status


def library_path() -> Path:
    """The one fixed place: beside the frozen executable, else `build/sidecar/`."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / LIBRARY_FILE_NAME
    return Path(__file__).resolve().parents[3] / "build" / "sidecar" / LIBRARY_FILE_NAME


def load_by_full_path(path: Path) -> Any:
    return ctypes.CDLL(str(path), winmode=LOAD_LIBRARY_SEARCH_SYSTEM32)


def _bind(raw: Any, *, test_seams: bool = False) -> dict[str, Any]:
    functions: dict[str, Any] = {}
    for signature in SIGNATURES:
        if signature.test_seams_only and not test_seams:
            continue
        try:
            function = getattr(raw, signature.name)
        except AttributeError:
            raise ComponentMissing("version_mismatch") from None
        function.restype = ctypes_type(signature.returns)
        function.argtypes = [ctypes_type(kind) for _, kind in signature.args]
        functions[signature.name] = function
    return functions


def load_library(
    *, lstat: Callable[[Path], Any] = os.lstat, loader: Callable[[Path], Any] = load_by_full_path,
    test_seams_path: Path | None = None,
) -> FileAccessLibrary:
    """Load and check the library, or raise `ComponentMissing` with its detail.

    `test_seams_path` is for tests only (Test seams): it loads a test-seams build
    from that explicit path and requires it to be one. No setting, flag or
    environment value reaches it; without it a test build is refused."""
    path = library_path() if test_seams_path is None else test_seams_path
    try:
        status = lstat(path)
    except OSError:
        raise ComponentMissing("missing") from None
    attributes = int(getattr(status, "st_file_attributes", 0) or 0)
    if not stat.S_ISREG(status.st_mode) or attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ComponentMissing("missing")  # a link, a reparse point or not a file
    try:
        raw = loader(path)
    except OSError:
        raise ComponentMissing("load_failed") from None
    seams = test_seams_path is not None
    functions = _bind(raw, test_seams=seams and hasattr(raw, TEST_EXPORT))
    if int(functions["jfa_abi_version"]()) != ABI_VERSION:
        raise ComponentMissing("version_mismatch")
    test_build = int(functions["jfa_build_flags"]()) != 0 or hasattr(raw, TEST_EXPORT)
    if test_build != seams:
        raise ComponentMissing("test_build" if test_build else "not_test_build")
    return FileAccessLibrary(functions)


_lock = threading.Lock()
_loaded: FileAccessLibrary | str | None = None  # the library, or a refusal's detail


def shared_library() -> FileAccessLibrary:
    """The process's library, loaded once; a refusal also stands for the process."""
    global _loaded  # noqa: PLW0603 - one library per worker process.
    with _lock:
        if _loaded is None:
            try:
                _loaded = load_library()
            except ComponentMissing as refusal:
                _loaded = refusal.detail
            except Exception:  # noqa: BLE001 - a check that cannot tell refuses.
                _loaded = "load_failed"
        if isinstance(_loaded, str):
            raise ComponentMissing(_loaded)
        return _loaded


def shared_library_latched() -> bool:
    """Whether this process's library is loaded and latched off. Never loads it."""
    with _lock:
        return isinstance(_loaded, FileAccessLibrary) and _loaded.latched


def latch_shared_library() -> None:
    """Latch this process's library off because a copy in a related process (a
    grep worker child, or its parent) latched: a latch then holds for the worker
    and every child it starts, not only the process where the fault happened
    (W14 review, finding 1). A library not loaded yet stays refused."""
    global _loaded  # noqa: PLW0603 - one library per worker process.
    with _lock:
        if isinstance(_loaded, FileAccessLibrary):
            _loaded.latch()
        elif _loaded is None:
            _loaded = "internal"


def reset_shared_library(replacement: FileAccessLibrary | None = None) -> None:
    """Forget the loaded library, or put a test-seams one in its place (tests only)."""
    global _loaded  # noqa: PLW0603
    with _lock:
        _loaded = replacement
