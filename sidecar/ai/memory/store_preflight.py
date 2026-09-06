"""Read-only validation before SQLite may mutate a memory database."""

from __future__ import annotations

from pathlib import Path
from typing import Literal, NamedTuple

from sidecar.ai.error_codes import CMP_MEMORY_FAILED, CMP_MEMORY_SCHEMA_MIGRATION
from sidecar.exceptions import MemoryStoreError

_SQLITE_HEADER = b"SQLite format 3\x00"
_SQLITE_HEADER_BYTES = 100
_WAL_HEADER_BYTES = 32
_WAL_FRAME_HEADER_BYTES = 24
_WAL_MAGIC_LITTLE_ENDIAN = 0x377F0682
_WAL_MAGIC_BIG_ENDIAN = 0x377F0683
_WAL_MAGIC = frozenset({_WAL_MAGIC_LITTLE_ENDIAN, _WAL_MAGIC_BIG_ENDIAN})
_WAL_FORMAT_VERSION = 3_007_000
_MIN_SQLITE_PAGE_SIZE = 512
_MAX_SQLITE_PAGE_SIZE = 65_536


class _WalFrameValidation(NamedTuple):
    expected_salts: bytes
    checksum: tuple[int, int]
    byteorder: Literal["little", "big"]


def validate_memory_store_files(db_path: Path, *, schema_version: int) -> None:
    """Reject corrupt/future state without opening SQLite in write mode."""

    if not db_path.exists():
        return
    try:
        with db_path.open("rb") as handle:
            header = handle.read(_SQLITE_HEADER_BYTES)
    except OSError as error:
        raise MemoryStoreError(
            CMP_MEMORY_FAILED,
            "memory database could not be read; explicit repair is required",
        ) from error
    if len(header) < _SQLITE_HEADER_BYTES or not header.startswith(_SQLITE_HEADER):
        raise MemoryStoreError(
            CMP_MEMORY_FAILED,
            "memory database header is invalid; explicit repair is required",
        )
    user_version = int.from_bytes(header[60:64], byteorder="big", signed=False)
    if user_version > schema_version:
        raise MemoryStoreError(
            CMP_MEMORY_SCHEMA_MIGRATION,
            (
                f"unsupported memory schema version {user_version}; "
                f"expected {schema_version}; explicit repair is required"
            ),
        )
    wal_user_version = _validate_wal_file(Path(f"{db_path}-wal"))
    if wal_user_version is not None and wal_user_version > schema_version:
        raise MemoryStoreError(
            CMP_MEMORY_SCHEMA_MIGRATION,
            (
                f"unsupported memory schema version {wal_user_version}; "
                f"expected {schema_version}; explicit repair is required"
            ),
        )


def _validate_wal_file(wal_path: Path) -> int | None:
    if not wal_path.exists():
        return None
    try:
        size = wal_path.stat().st_size
        if size == 0:
            return None
        with wal_path.open("rb") as handle:
            header = handle.read(_WAL_HEADER_BYTES)
    except OSError as error:
        raise MemoryStoreError(
            CMP_MEMORY_FAILED,
            "memory write-ahead log could not be read; explicit repair is required",
        ) from error
    if len(header) != _WAL_HEADER_BYTES:
        _raise_invalid_wal()
    magic = int.from_bytes(header[0:4], byteorder="big", signed=False)
    format_version = int.from_bytes(header[4:8], byteorder="big", signed=False)
    page_size = int.from_bytes(header[8:12], byteorder="big", signed=False)
    if (
        magic not in _WAL_MAGIC
        or format_version != _WAL_FORMAT_VERSION
        or page_size < _MIN_SQLITE_PAGE_SIZE
        or page_size > _MAX_SQLITE_PAGE_SIZE
        or page_size & (page_size - 1) != 0
    ):
        _raise_invalid_wal()
    checksum_byteorder: Literal["little", "big"] = (
        "little" if magic == _WAL_MAGIC_LITTLE_ENDIAN else "big"
    )
    header_checksum = _wal_checksum(header[:24], byteorder=checksum_byteorder)
    if header_checksum != (
        int.from_bytes(header[24:28], "big"),
        int.from_bytes(header[28:32], "big"),
    ):
        _raise_invalid_wal()
    frame_size = _WAL_FRAME_HEADER_BYTES + page_size
    if (size - _WAL_HEADER_BYTES) % frame_size != 0:
        _raise_invalid_wal()
    return _read_committed_wal_user_version(
        wal_path,
        page_size=page_size,
        frame_count=(size - _WAL_HEADER_BYTES) // frame_size,
        validation=_WalFrameValidation(
            expected_salts=header[16:24],
            checksum=header_checksum,
            byteorder=checksum_byteorder,
        ),
    )


def _read_committed_wal_user_version(
    wal_path: Path,
    *,
    page_size: int,
    frame_count: int,
    validation: _WalFrameValidation,
) -> int | None:
    frames: list[tuple[int, int, int | None]] = []
    checksum = validation.checksum
    try:
        with wal_path.open("rb") as handle:
            handle.seek(_WAL_HEADER_BYTES)
            for _ in range(frame_count):
                frame_header = handle.read(_WAL_FRAME_HEADER_BYTES)
                page = handle.read(page_size)
                if (
                    len(frame_header) != _WAL_FRAME_HEADER_BYTES
                    or len(page) != page_size
                    or frame_header[8:16] != validation.expected_salts
                ):
                    _raise_invalid_wal()
                checksum = _wal_checksum(
                    frame_header[:8] + page,
                    initial=checksum,
                    byteorder=validation.byteorder,
                )
                if checksum != (
                    int.from_bytes(frame_header[16:20], "big"),
                    int.from_bytes(frame_header[20:24], "big"),
                ):
                    _raise_invalid_wal()
                page_number = int.from_bytes(frame_header[0:4], "big")
                committed_pages = int.from_bytes(frame_header[4:8], "big")
                if page_number <= 0:
                    _raise_invalid_wal()
                version = None
                if page_number == 1:
                    if not page.startswith(_SQLITE_HEADER):
                        _raise_invalid_wal()
                    version = int.from_bytes(page[60:64], "big")
                frames.append((page_number, committed_pages, version))
    except OSError as error:
        raise MemoryStoreError(
            CMP_MEMORY_FAILED,
            "memory write-ahead log could not be read; explicit repair is required",
        ) from error

    last_commit = max(
        (index for index, (_, committed_pages, _) in enumerate(frames) if committed_pages),
        default=-1,
    )
    for page_number, _, version in reversed(frames[: last_commit + 1]):
        if page_number == 1:
            return version
    return None


def _wal_checksum(
    data: bytes,
    *,
    byteorder: Literal["little", "big"],
    initial: tuple[int, int] = (0, 0),
) -> tuple[int, int]:
    first, second = initial
    for offset in range(0, len(data), 8):
        first = (
            first + int.from_bytes(data[offset : offset + 4], byteorder) + second
        ) & 0xFFFFFFFF
        second = (
            second + int.from_bytes(data[offset + 4 : offset + 8], byteorder) + first
        ) & 0xFFFFFFFF
    return first, second


def _raise_invalid_wal() -> None:
    raise MemoryStoreError(
        CMP_MEMORY_FAILED,
        "memory write-ahead log is truncated or invalid; explicit repair is required",
    )
