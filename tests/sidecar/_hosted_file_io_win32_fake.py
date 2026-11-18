"""A fake `jenny_file_access.dll` for the Windows client tests. Runs on every OS.

Each export is a `FakeExport`: it takes the `argtypes` and `restype` the loader
sets, runs every argument through its argtype's `from_param` as a real ctypes
call does (so a wrong Python type for a slot fails here, not first on the real
library), and records the call. The client passes ctypes objects (arrays,
scalars written through `.value`, a byte buffer), so the fake reads and writes
them the way the real library would through its pointers. A status is scripted
per export: `fake.statuses[name]` is a list consumed one call at a time, then 0.
"""

from __future__ import annotations

import ctypes
import os
import stat
import struct
from types import SimpleNamespace
from typing import Any, Callable

FLAG_DIRECTORY = 1
FLAG_REPARSE = 2
FLAG_SIZE_KNOWN = 4
FAKE_HANDLE = 0x4242


def decode_units(units: list[int]) -> list[str]:
    """Split a segment list the way the library does: each segment ends with U+0000."""
    text = struct.pack(f"<{len(units)}H", *units).decode("utf-16-le", "surrogatepass")
    if not text:
        return []
    assert text.endswith("\x00"), "a segment list must end with its terminator"
    return text[:-1].split("\x00")


def record(  # noqa: PLR0913 - one knob per record field
    name: str, *, directory: bool = False, reparse: bool = False, size: int | None = None,
    flags: int | None = None, claimed_units: int | None = None,
) -> bytes:
    """One listing record as the library writes it (little-endian, unpadded)."""
    encoded = name.encode("utf-16-le", "surrogatepass")
    if flags is None:
        flags = ((FLAG_DIRECTORY if directory else 0) | (FLAG_REPARSE if reparse else 0)
                 | (FLAG_SIZE_KNOWN if size is not None else 0))
    units = len(encoded) // 2 if claimed_units is None else claimed_units
    return struct.pack("<IQH", flags, size or 0, units) + encoded


class FakeExport:
    def __init__(self, library: FakeLibrary, name: str, handler: Callable[..., int]) -> None:
        self.library = library
        self.name = name
        self.handler = handler
        self.argtypes: Any = None
        self.restype: Any = None

    def __call__(self, *args: Any) -> int:
        if self.argtypes is not None:
            if len(args) != len(self.argtypes):
                raise TypeError(f"{self.name} takes {len(self.argtypes)} arguments")
            for argtype, value in zip(self.argtypes, args, strict=True):
                argtype.from_param(value)  # raises on a type the real call would refuse
        self.library.calls.append(self.name)
        return self.handler(*args)


class FakeLibrary:
    """Attributes named like the exports; anything else raises AttributeError."""

    def __init__(self, *, abi_version: int = 1, build_flags: int = 0,
                 test_export: bool = False, missing: tuple[str, ...] = ()) -> None:
        self.calls: list[str] = []
        self.statuses: dict[str, list[int]] = {}
        self.details: dict[str, tuple[int, int]] = {}
        self.root_opens: list[tuple[str, int, int]] = []
        self.segments: list[tuple[str, list[str], int]] = []
        self.open_pins: set[int] = set()
        self.closed_pins: list[int] = []
        self.open_files: set[int] = set()
        self.file_closes: list[tuple[int, int]] = []
        self.list_calls: list[SimpleNamespace] = []
        self.writes: list[SimpleNamespace] = []
        self.listing = b""
        self.listing_count: int | None = None
        self.listing_used: int | None = None
        self.write_outcome = 1
        self.root_open_raises: BaseException | None = None  # raised after the pin is issued
        self.open_file_raises: BaseException | None = None  # raised after the token is issued
        self._next_token = 100
        handlers: dict[str, Callable[..., int]] = {
            "jfa_abi_version": lambda: abi_version,
            "jfa_build_flags": lambda: build_flags,
            "jfa_root_open": self._root_open,
            "jfa_pin_identity": lambda pin, out_device, out_inode: 0,
            "jfa_pin_close": self._pin_close,
            "jfa_open_file": self._open_file,
            "jfa_file_take": self._file_take,
            "jfa_file_check": lambda token: self._status("jfa_file_check"),
            "jfa_file_close": self._file_close,
            "jfa_list": self._list,
            "jfa_write_atomic": self._write_atomic,
        }
        if test_export:
            handlers["jfa_test_set_token_state"] = lambda state: 0
        for name in missing:
            handlers.pop(name)
        for name, handler in handlers.items():
            setattr(self, name, FakeExport(self, name, handler))

    def _status(self, name: str) -> int:
        queued = self.statuses.get(name)
        return queued.pop(0) if queued else 0

    def _detail(self, name: str, out_detail: Any) -> None:
        out_detail[0], out_detail[1] = self.details.get(name, (0, 0))

    def _token(self) -> int:
        self._next_token += 1
        return self._next_token

    def _record_segments(self, name: str, segments: Any, units: int) -> None:
        self.segments.append((name, decode_units(list(segments[:units])), units))

    def _root_open(  # noqa: PLR0913 - the export's arity
        self, root: Any, units: int, device: int, inode: int, out_pin: Any, out_detail: Any,
    ) -> int:
        self.root_opens.append((decode_units([*root[:units], 0])[0], device, inode))
        status = self._status("jfa_root_open")
        self._detail("jfa_root_open", out_detail)
        if status == 0:
            out_pin.value = self._token()
            self.open_pins.add(out_pin.value)
        if self.root_open_raises is not None:
            raise self.root_open_raises
        return status

    def _pin_close(self, pin: int) -> int:
        self.closed_pins.append(pin)
        self.open_pins.discard(pin)
        return self._status("jfa_pin_close")

    def _open_file(self, pin: int, segments: Any, units: int, out_token: Any,
                   out_detail: Any) -> int:
        self._record_segments("jfa_open_file", segments, units)
        status = self._status("jfa_open_file")
        self._detail("jfa_open_file", out_detail)
        if status == 0:
            out_token.value = self._token()
            self.open_files.add(out_token.value)
        if self.open_file_raises is not None:
            raise self.open_file_raises
        return status

    def _file_take(self, token: int, out_handle: Any) -> int:
        status = self._status("jfa_file_take")
        if status == 0:
            out_handle.value = FAKE_HANDLE
        return status

    def _file_close(self, token: int, reclaim: int) -> int:
        self.file_closes.append((token, reclaim))
        self.open_files.discard(token)
        return self._status("jfa_file_close")

    def _list(  # noqa: PLR0913 - the export's arity
        self, pin: int, segments: Any, units: int, max_entries: int, buffer: Any,
        capacity: int, out_used: Any, out_count: Any, out_detail: Any,
    ) -> int:
        self._record_segments("jfa_list", segments, units)
        self.list_calls.append(SimpleNamespace(max_entries=max_entries, capacity=capacity))
        status = self._status("jfa_list")
        self._detail("jfa_list", out_detail)
        if status != 0:
            return status
        if len(self.listing) > capacity:
            out_used.value = len(self.listing)
            return 6
        ctypes.memmove(buffer, self.listing, len(self.listing))
        out_used.value = len(self.listing) if self.listing_used is None else self.listing_used
        out_count.value = (self.listing_count if self.listing_count is not None
                           else _count_records(self.listing))
        return 0

    def _write_atomic(  # noqa: PLR0913 - the export's arity
        self, pin: int, segments: Any, units: int, content: bytes, content_len: int,
        kind: int, expected: bytes, expected_len: int, out_outcome: Any, out_detail: Any,
    ) -> int:
        self._record_segments("jfa_write_atomic", segments, units)
        self.writes.append(SimpleNamespace(content=content[:content_len], kind=kind,
                                           expected=expected[:expected_len]))
        status = self._status("jfa_write_atomic")
        self._detail("jfa_write_atomic", out_detail)
        if status == 0:
            out_outcome.value = self.write_outcome
        return status


def _count_records(payload: bytes) -> int:
    count = offset = 0
    while offset < len(payload):
        units = struct.unpack_from("<H", payload, offset + 12)[0]
        offset += 14 + 2 * units
        count += 1
    return count


def regular_file_stat(path: Any) -> os.stat_result:
    """What `os.lstat` answers for a plain file (any OS)."""
    return os.stat_result((stat.S_IFREG | 0o644, 0, 0, 1, 0, 0, 4096, 0, 0, 0))
