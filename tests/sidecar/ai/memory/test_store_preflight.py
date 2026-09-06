from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from sidecar.ai.context.runtime_overlays import (
    RuntimeOverlayLogContext,
    build_prompt_memory_recall_system_message,
)
from sidecar.ai.memory.store import SCHEMA_VERSION, MemoryStore
from sidecar.ai.memory.store_preflight import _validate_wal_file, validate_memory_store_files
from sidecar.ai.memory.unavailable import UnavailableMemoryStore, open_memory_store
from sidecar.exceptions import MemoryStoreError


def _sqlite_db(path: Path, *, user_version: int = 0) -> None:
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY)")
    connection.execute(f"PRAGMA user_version={user_version}")
    connection.commit()
    connection.close()


def _wal_checksum(
    data: bytes, *, initial: tuple[int, int] = (0, 0)
) -> tuple[int, int]:
    first, second = initial
    for offset in range(0, len(data), 8):
        first = (
            first + int.from_bytes(data[offset : offset + 4], "little") + second
        ) & 0xFFFFFFFF
        second = (
            second + int.from_bytes(data[offset + 4 : offset + 8], "little") + first
        ) & 0xFFFFFFFF
    return first, second


def _wal_bytes(
    *,
    format_version: int = 3_007_000,
    page_size: int = 512,
    include_frame: bool = False,
    corrupt_header_checksum: bool = False,
    corrupt_frame_checksum: bool = False,
) -> bytes:
    header = bytearray(32)
    header[0:4] = (0x377F0682).to_bytes(4, "big")
    header[4:8] = format_version.to_bytes(4, "big")
    header[8:12] = page_size.to_bytes(4, "big")
    header[16:24] = b"test-slt"
    checksum = _wal_checksum(bytes(header[:24]))
    header[24:28] = checksum[0].to_bytes(4, "big")
    header[28:32] = checksum[1].to_bytes(4, "big")
    if corrupt_header_checksum:
        header[31] ^= 0x01
    if not include_frame:
        return bytes(header)

    page = bytearray(page_size)
    page[:16] = b"SQLite format 3\x00"
    page[60:64] = SCHEMA_VERSION.to_bytes(4, "big")
    frame = bytearray(24)
    frame[0:4] = (1).to_bytes(4, "big")
    frame[4:8] = (1).to_bytes(4, "big")
    frame[8:16] = header[16:24]
    frame_checksum = _wal_checksum(bytes(frame[:8]) + bytes(page), initial=checksum)
    frame[16:20] = frame_checksum[0].to_bytes(4, "big")
    frame[20:24] = frame_checksum[1].to_bytes(4, "big")
    if corrupt_frame_checksum:
        frame[23] ^= 0x01
    return bytes(header + frame + page)


def test_future_memory_database_is_preserved_and_degrades_to_unavailable(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    _sqlite_db(db_path, user_version=SCHEMA_VERSION + 1)
    original = db_path.read_bytes()

    store = open_memory_store(db_path)

    assert isinstance(store, UnavailableMemoryStore)
    assert store.reason_code == "CMP-MEM-0005"
    assert store.status_payload()["repair_required"] is True
    assert store.status_payload()["preserved"] is True
    assert db_path.read_bytes() == original
    with pytest.raises(MemoryStoreError, match="explicit repair"):
        store.get_all_memories()

    class _ContextBuilder:
        def build_memory_recall_system_message(self, memories: list[object]) -> str:
            assert memories == []
            return ""

    assert (
        build_prompt_memory_recall_system_message(
            context_builder=_ContextBuilder(),  # type: ignore[arg-type]
            memory_store=store,
            latest_user_content="ordinary chat still works",
            log_context=RuntimeOverlayLogContext(
                logger=logging.getLogger(__name__),
                component="test.memory",
                event="test.memory.recall",
                request_id="req-memory-unavailable",
                session_id=None,
            ),
        )
        == ""
    )


def test_corrupt_memory_database_is_preserved_without_recovery_mutation(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    original = b"not-a-sqlite-database\x00with-user-bytes"
    db_path.write_bytes(original)

    store = open_memory_store(db_path)

    assert isinstance(store, UnavailableMemoryStore)
    assert store.preserved is True
    assert db_path.read_bytes() == original


def test_unverified_factory_failure_does_not_claim_database_preservation(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "memory.db"

    def _fail(_path: Path) -> MemoryStore:
        raise RuntimeError("injected constructor failure")

    store = open_memory_store(db_path, store_factory=_fail)

    assert isinstance(store, UnavailableMemoryStore)
    assert store.preserved is False


def test_truncated_wal_is_rejected_read_only_and_preserved(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    _sqlite_db(db_path)
    wal_path = Path(f"{db_path}-wal")
    wal_bytes = b"truncated-wal"
    wal_path.write_bytes(wal_bytes)
    db_bytes = db_path.read_bytes()

    with pytest.raises(MemoryStoreError, match="write-ahead log"):
        validate_memory_store_files(db_path, schema_version=SCHEMA_VERSION)

    assert db_path.read_bytes() == db_bytes
    assert wal_path.read_bytes() == wal_bytes


@pytest.mark.parametrize(
    "wal_bytes",
    [
        _wal_bytes(format_version=0),
        _wal_bytes(page_size=513),
        _wal_bytes(corrupt_header_checksum=True),
    ],
)
def test_wal_with_invalid_header_fields_or_checksum_is_rejected(
    tmp_path: Path, wal_bytes: bytes
) -> None:
    wal_path = tmp_path / "memory.db-wal"
    wal_path.write_bytes(wal_bytes)

    with pytest.raises(MemoryStoreError, match="write-ahead log"):
        _validate_wal_file(wal_path)


def test_wal_with_invalid_cumulative_frame_checksum_is_rejected(tmp_path: Path) -> None:
    wal_path = tmp_path / "memory.db-wal"
    wal_path.write_bytes(_wal_bytes(include_frame=True, corrupt_frame_checksum=True))

    with pytest.raises(MemoryStoreError, match="write-ahead log"):
        _validate_wal_file(wal_path)


def test_future_schema_in_committed_wal_is_rejected_without_mutation(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    _sqlite_db(db_path, user_version=SCHEMA_VERSION)
    connection = sqlite3.connect(db_path)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute(f"PRAGMA user_version={SCHEMA_VERSION + 1}")
        connection.commit()

        wal_path = Path(f"{db_path}-wal")
        shm_path = Path(f"{db_path}-shm")
        before = {
            path: path.read_bytes()
            for path in (db_path, wal_path, shm_path)
            if path.exists()
        }

        with pytest.raises(MemoryStoreError, match="unsupported memory schema"):
            validate_memory_store_files(db_path, schema_version=SCHEMA_VERSION)

        assert {
            path: path.read_bytes()
            for path in (db_path, wal_path, shm_path)
            if path.exists()
        } == before
    finally:
        connection.close()
