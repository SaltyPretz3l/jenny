"""Windows backend for hosted file IO: a client of `jenny_file_access.dll`.

The path below the root crosses to the library as a list of segments; this
module never judges a name and never joins a path below the root. It is
imported only on `win32`. It must not import Electron or renderer code.
"""

from __future__ import annotations

import ctypes
import errno
import importlib
import logging
import os
import struct
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, NamedTuple

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools import hosted_file_io_win32_library as library
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.hosted_file_io import (
    PLATFORM_UNSUPPORTED,
    HostedEntry,
    HostedPin,
    path_failure,
)

_S = library.STATUS
_OK = _S["ok"]
FIRST_LISTING_CAPACITY = 64 * 1024
MAX_LISTING_BYTES = library.LIMITS["max_listing_buffer_bytes"]
_U32_MAX = 2**32 - 1
_U64_MAX = 2**64 - 1
_ACCESS_DENIED = frozenset({5, 0xC0000022})  # ERROR_ACCESS_DENIED, STATUS_ACCESS_DENIED
_KNOWN_LISTING_FLAGS = sum(1 << bit for bit in library.LISTING_FLAG_BITS.values())
_DIRECTORY = 1 << library.LISTING_FLAG_BITS["directory"]
_REPARSE = 1 << library.LISTING_FLAG_BITS["reparse_point"]
_SIZE_KNOWN = 1 << library.LISTING_FLAG_BITS["size_known"]
_log = logging.getLogger(__name__)

SELFCHECK_FAILED = "file_access_selfcheck_failed"
ROOT_INVALID = "file_access_root_invalid"
ROOT_IDENTITY = "file_access_root_identity"
_START_REASONS = {
    _S["path_refused"]: ROOT_INVALID,
    _S["not_found"]: ROOT_INVALID,
    _S["platform_unsupported"]: PLATFORM_UNSUPPORTED,
    _S["api_missing"]: "file_access_api_missing",
    _S["elevated"]: "file_access_elevated",
    _S["backup_privilege"]: "file_access_backup_privilege",
    _S["volume_unsupported"]: "file_access_volume_unsupported",
    _S["root_invalid"]: ROOT_INVALID,
    _S["root_identity"]: ROOT_IDENTITY,
    _S["selfcheck_failed"]: SELFCHECK_FAILED,
}
_REMEDIATION = {
    library.DETAIL_REASONS["target_read_only"]:
        "The file is read-only. Clear its read-only attribute to change it.",
    library.DETAIL_REASONS["reparse_point"]:
        ("This file is a cloud or compressed placeholder. "
         "Keep shared projects outside synced folders."),
}


@dataclass(frozen=True)
class Availability:
    """A reason from the spec's failure table, with its detail where it has one."""

    reason: str
    detail: str | None = None


@dataclass
class Win32Pin:
    """A pin token in the library's table. Closed once; a latched library keeps it."""

    token: int
    lib: library.FileAccessLibrary = field(repr=False)
    _closed: bool = field(default=False, repr=False)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self.lib.call("jfa_pin_close", self.token) != _OK:
            _log.warning("hosted_file.library_pin_close_failed")

    def __del__(self) -> None:
        # A pin dropped unclosed (an asynchronous exception between `open_root`
        # and its owner's `finally`) is closed when its last reference goes, so
        # its table slot comes back (W14 review, finding 4). A token is checked
        # by generation, so a close that loses a race answers a refusal, never
        # another pin.
        if not self._closed:
            self._closed = True
            with suppress(Exception):
                self.lib.call("jfa_pin_close", self.token)


class _EntryStat(NamedTuple):
    st_size: int


@dataclass(frozen=True)
class Win32Entry:
    name: str
    directory: bool
    size: int | None

    def is_dir(self, *, follow_symlinks: bool = True) -> bool:
        return self.directory

    def stat(self, *, follow_symlinks: bool = True) -> _EntryStat:
        if self.size is None:
            raise OSError(errno.EIO, "Hosted listing size unknown.")
        return _EntryStat(self.size)


def _detail(raw: Any) -> tuple[int, int]:
    return int(raw[0]), int(raw[1])


def _durability_uncertain() -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_IO_FAILED,
        message=("File replacement applied; durability could not be confirmed. "
                 "Re-read before retrying."),
        retryable=False, error_details={"effects": "applied_durability_uncertain"},
    )


def _failure(status: int, detail: tuple[int, int]) -> BaseException:
    """What the facade raises today for a status other than `ok`."""
    reason, code = detail
    if status == _S["path_refused"] and reason in _REMEDIATION:
        return ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH, message=str(path_failure().message), retryable=False,
            error_details={"remediation": _REMEDIATION[reason]},
        )
    if status == _S["not_found"]:
        return FileNotFoundError(errno.ENOENT, "Hosted file not found.")
    if status in {_S["io_failed"], _S["busy"]}:
        text = f"Hosted file IO failed (system code 0x{code & _U32_MAX:08X})."
        if code in _ACCESS_DENIED:
            return PermissionError(errno.EACCES, text)
        return OSError(errno.EIO, text)
    if status == _S["durability_uncertain"]:
        return _durability_uncertain()
    if status == _S["invalid_argument"]:
        _log.warning("hosted_file.library_invalid_argument")
    return path_failure()  # internal (latched), a start-only status, or an unknown one


def _units(text: str) -> bytes:
    return text.encode("utf-16-le", "surrogatepass")


def _u16_array(encoded: bytes) -> tuple[Any, int]:
    """A `ctypes` array of the code units (never empty, so never a null pointer)."""
    count = len(encoded) // 2
    if count > _U32_MAX:
        raise path_failure()
    return (ctypes.c_uint16 * max(count, 1)).from_buffer_copy(encoded or b"\0\0"), count


def _segments(root: Path, path: Path) -> tuple[Any, int]:
    """The path below the root as the library's segment list; no name is judged."""
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        raise path_failure() from None
    if any("\x00" in part for part in parts):
        raise path_failure()  # U+0000 is the separator: the list cannot carry it
    return _u16_array(b"".join(_units(part) + b"\0\0" for part in parts))


def _identity(device: str | None, inode: str | None) -> tuple[int, int] | None:
    """The expected pair as two u64, (0, 0) when none is recorded, else None."""
    if device is None and inode is None:
        return 0, 0
    values = (device, inode)
    if not all(isinstance(v, str) and v.isascii() and v.isdigit() for v in values):
        return None
    pair = (int(str(device)), int(str(inode)))
    return pair if all(value <= _U64_MAX for value in pair) else None


def _open_pin(lib: library.FileAccessLibrary, root: Path, pair: tuple[int, int],
              out_pin: ctypes.c_uint64) -> int:
    """`jfa_root_open`'s status; the pin lands in the caller's `out_pin`, which
    the library zeroes first and writes only on success. The caller owns that
    holder from before the call, so a pin issued by a call that then raised,
    or followed by an asynchronous exception, is still the caller's to close
    (W14 review, finding 4)."""
    units, count = _u16_array(_units(str(root)))
    return lib.call("jfa_root_open", units, count, pair[0], pair[1], out_pin,
                    (ctypes.c_uint32 * 2)())


def _close_issued(lib: library.FileAccessLibrary, out_pin: ctypes.c_uint64) -> bool:
    """Close the pin in `out_pin`, if one was issued, and empty the holder. False
    when the close failed."""
    token = int(out_pin.value)
    if not token:
        return True
    out_pin.value = 0
    try:
        return lib.call("jfa_pin_close", token) == _OK
    except Exception:  # noqa: BLE001 - the first exception is the one to report.
        _log.warning("hosted_file.library_pin_close_failed")
        return False


def availability(root: Path | None = None, expected_device_id: str | None = None,
                 expected_inode: str | None = None) -> Availability | None:
    """W11, never raising: None when file tools may run. Without a root, the
    library alone is checked; with one, a pin is opened (the whole start
    decision) and closed."""
    try:
        lib = library.shared_library()
    except library.ComponentMissing as refusal:
        return Availability(library.COMPONENT_MISSING, refusal.detail)
    reason = None if root is None or lib.latched else _start_reason(
        lib, root, expected_device_id, expected_inode)
    if lib.latched:  # before the call, or set by it
        return Availability(library.COMPONENT_MISSING, "internal")
    return Availability(reason) if reason is not None else None


def _start_reason(lib: library.FileAccessLibrary, root: Path, expected_device_id: str | None,
                  expected_inode: str | None) -> str | None:
    pair = _identity(expected_device_id, expected_inode)
    if pair is None:
        return ROOT_IDENTITY
    out_pin = ctypes.c_uint64()
    try:
        status = _open_pin(lib, root, pair, out_pin)
        if status != _OK:
            return _START_REASONS.get(status, SELFCHECK_FAILED)
        return None if _close_issued(lib, out_pin) else SELFCHECK_FAILED
    except ToolExecutionFailure:
        return ROOT_INVALID  # the root path cannot be encoded
    except Exception:  # noqa: BLE001 - a check that cannot tell refuses.
        return SELFCHECK_FAILED
    finally:
        _close_issued(lib, out_pin)  # a no-op unless a pin is still held: any early exit


def unavailable_reason(root: Path | None = None, expected_device_id: str | None = None,
                       expected_inode: str | None = None) -> str | None:
    found = availability(root, expected_device_id, expected_inode)
    return found.reason if found is not None else None


def open_root(root: Path, expected_device_id: str | None,
              expected_inode: str | None) -> Win32Pin:
    """Pin `root` through `jfa_root_open`, which runs the whole start decision."""
    try:
        lib = library.shared_library()
    except library.ComponentMissing:
        raise path_failure() from None
    pair = _identity(expected_device_id, expected_inode)
    if pair is None:
        raise path_failure()
    out_pin = ctypes.c_uint64()
    try:
        if _open_pin(lib, root, pair, out_pin) != _OK:
            raise path_failure()
        pin = Win32Pin(int(out_pin.value), lib)
        out_pin.value = 0  # from here the Win32Pin owns it (closed by its owner, else when dropped)
        return pin
    finally:
        _close_issued(lib, out_pin)  # a no-op unless the call issued a pin no Win32Pin took


def _pinned(pin: HostedPin) -> tuple[library.FileAccessLibrary, int]:
    if not isinstance(pin, Win32Pin) or pin._closed:
        raise path_failure()
    return pin.lib, pin.token


def _open_osfhandle(handle: int) -> int:
    """Wrap the taken handle in a C runtime descriptor, which then owns it."""
    msvcrt = importlib.import_module("msvcrt")
    return int(msvcrt.open_osfhandle(handle, os.O_RDONLY))


@contextmanager
def open_file(pin: HostedPin, root: Path, path: Path, mode: str, **kwargs: Any) -> Iterator[Any]:
    if mode not in {"r", "rb"}:
        raise path_failure()
    lib, pin_token = _pinned(pin)
    segments, count = _segments(root, path)
    # The token's holder exists before the call and the `finally` covers the call
    # itself: the library zeroes `out_token` first and writes it only on success,
    # so a token followed by an asynchronous exception is still closed (W14 review,
    # finding 3).
    out_token, detail = ctypes.c_uint64(), (ctypes.c_uint32 * 2)()
    reclaim = 0
    fd = -1
    try:
        status = lib.call("jfa_open_file", pin_token, segments, count, out_token, detail)
        if status != _OK:
            raise _failure(status, _detail(detail))
        token = int(out_token.value)
        out_handle = ctypes.c_size_t()
        status = lib.call("jfa_file_take", token, out_handle)
        if status != _OK:
            raise _failure(status, (0, 0))
        try:
            fd = _open_osfhandle(int(out_handle.value))
        except Exception:
            # The wrap failed, so no descriptor owns the taken handle and the
            # library closes it. An asynchronous exception (a BaseException that
            # is not an Exception, such as KeyboardInterrupt) is never read as
            # that: the descriptor may already own the handle, and a handle left
            # open until the worker exits is safe where a second close is not
            # (W14 review, finding 2).
            reclaim = 1
            raise
        with os.fdopen(fd, mode, closefd=False, **kwargs) as handle:
            yield handle
            status = lib.call("jfa_file_check", token)
            if status != _OK:
                raise _failure(status, (0, 0))
    finally:
        try:
            if fd >= 0:
                os.close(fd)
        finally:
            if out_token.value and lib.call("jfa_file_close", int(out_token.value), reclaim) != _OK:
                _log.warning("hosted_file.library_file_close_failed")


class Win32Directory:
    """One `jfa_list` snapshot. One `scan` call per directory scope."""

    def __init__(self, lib: library.FileAccessLibrary, pin_token: int, segments: Any,
                 count: int) -> None:
        self._lib, self._pin, self._segments, self._count = lib, pin_token, segments, count
        self._scanned = False

    def _list(self, max_entries: int, capacity: int) -> tuple[int, Any, int, int, Any]:
        buffer = (ctypes.c_ubyte * capacity)()
        used, entries, detail = ctypes.c_uint32(), ctypes.c_uint32(), (ctypes.c_uint32 * 2)()
        status = self._lib.call("jfa_list", self._pin, self._segments, self._count, max_entries,
                                buffer, capacity, used, entries, detail)
        return status, buffer, int(used.value), int(entries.value), detail

    def scan(self, limit: int) -> list[HostedEntry]:
        if self._scanned:
            raise path_failure()
        self._scanned = True
        max_entries = max(0, min(int(limit), _U32_MAX))
        capacity = min(FIRST_LISTING_CAPACITY, MAX_LISTING_BYTES)
        status, buffer, used, entries, detail = self._list(max_entries, capacity)
        if status == _S["buffer_too_small"]:
            if not capacity < used <= MAX_LISTING_BYTES:
                raise path_failure()
            capacity = used
            status, buffer, used, entries, detail = self._list(max_entries, capacity)
        if status == _S["not_found"]:
            raise path_failure()  # a missing directory, as the POSIX walk answers
        if status != _OK:
            raise _failure(status, _detail(detail))
        return _decode(buffer, used, entries, capacity, max_entries)


def _decode(buffer: Any, used: int, count: int, capacity: int,
            max_entries: int) -> list[HostedEntry]:
    """Read the records in place; any length that points past the bytes used is refused.
    Names keep their exact code units (a lone surrogate included), as they are sent."""
    if used > capacity or count > max_entries:
        raise path_failure()
    data = memoryview(buffer).cast("B")[:used]
    header = library.LISTING_HEADER_BYTES
    decoded: list[HostedEntry] = []
    offset = 0
    while offset < used:
        if used - offset < header:
            raise path_failure()
        flags, size, units = struct.unpack_from("<IQH", data, offset)
        end = offset + header + 2 * units
        if end > used or flags & ~_KNOWN_LISTING_FLAGS:
            raise path_failure()
        name = str(data[offset + header:end], "utf-16-le", "surrogatepass")
        reparse = bool(flags & _REPARSE)
        decoded.append(Win32Entry(
            name, bool(flags & _DIRECTORY) and not reparse,
            size if flags & _SIZE_KNOWN and not reparse else None))
        offset = end
    if len(decoded) != count:
        raise path_failure()
    return decoded


@contextmanager
def open_directory(pin: HostedPin, root: Path, path: Path) -> Iterator[Win32Directory]:
    lib, pin_token = _pinned(pin)
    segments, count = _segments(root, path)
    yield Win32Directory(lib, pin_token, segments, count)


def remove(pin: HostedPin, root: Path, path: Path) -> bool:
    """The library has no confined remove yet: refused, never done by path (R12-F01)."""
    _pinned(pin)
    raise path_failure()


def write_atomic(  # noqa: PLR0913
    pin: HostedPin, root: Path, path: Path, content: bytes, expected: bytes | None | object,
    no_expectation: object, mode: int | None,
) -> bool:
    """W7 in the library. `mode` is ignored: a new file takes the parent's access list."""
    kinds = library.EXPECTATION_KINDS
    lib, pin_token = _pinned(pin)
    if expected is None:
        kind, expected_bytes = kinds["must_not_exist"], b""
    elif expected is no_expectation:
        kind, expected_bytes = kinds["no_expectation"], b""
    elif isinstance(expected, bytes):
        kind, expected_bytes = kinds["bytes"], expected
    else:
        raise path_failure()
    segments, count = _segments(root, path)
    data = bytes(content)
    outcome, detail = ctypes.c_uint32(), (ctypes.c_uint32 * 2)()
    status = lib.call("jfa_write_atomic", pin_token, segments, count, data, len(data), kind,
                      expected_bytes, len(expected_bytes), outcome, detail)
    if status != _OK:
        raise _failure(status, _detail(detail))
    if outcome.value == library.WRITE_OUTCOMES["replaced"]:
        return True
    if outcome.value == library.WRITE_OUTCOMES["not_matched"]:
        return False
    raise _durability_uncertain()  # beside ok, an unknown outcome may mean it was replaced
