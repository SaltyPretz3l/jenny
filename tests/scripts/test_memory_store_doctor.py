from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from scripts.dev.memory_store_doctor import (
    backup_store,
    export_quarantine,
    inspect_store,
    repair_store,
)
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.store_migrations import MAX_QUARANTINE_ROWS, SCHEMA_VERSION


def test_doctor_inspection_is_read_only_and_content_free(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    store = MemoryStore(db_path)
    try:
        store.save_memory(
            session_id="session",
            title="Secret title",
            lesson_text="The user prefers confidential tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="confidential",
        )
    finally:
        store.close()

    before = db_path.read_bytes()
    result = inspect_store(db_path)

    assert result["schema_version"] == SCHEMA_VERSION
    assert result["counts"]["approved"] == 1
    assert "confidential" not in json.dumps(result)
    assert db_path.read_bytes() == before


def test_doctor_repairs_require_and_create_backup(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    backup_path = tmp_path / "backup.db"
    store = MemoryStore(db_path)
    try:
        store._connection.execute(  # noqa: SLF001
            """
            INSERT INTO memory_quarantine (
                source_table, source_row_id, reason_code, raw_payload
            ) VALUES ('memories', '1', 'CMP-MEM-0008', '{"value_count": 1}')
            """
        )
        store._connection.commit()  # noqa: SLF001
    finally:
        store.close()

    result = repair_store(db_path, backup_path, delete_quarantine=True)

    assert result == {"backup_created": True, "restored": 0, "deleted": 1}
    assert backup_path.exists()
    backup = sqlite3.connect(backup_path)
    try:
        assert backup.execute("SELECT COUNT(*) FROM memory_quarantine").fetchone() == (1,)
    finally:
        backup.close()
    assert inspect_store(db_path)["counts"]["quarantined"] == 0


def test_doctor_export_restore_roundtrip_is_bounded_metadata(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    export_path = tmp_path / "quarantine.json"
    backup_path = tmp_path / "backup.db"
    store = MemoryStore(db_path)
    try:
        store._connection.execute(  # noqa: SLF001
            """
            INSERT INTO memory_quarantine (
                source_table, source_row_id, reason_code, raw_payload
            ) VALUES ('memories', '1', 'CMP-MEM-0008', '{"row_digest": "sha256:test"}')
            """
        )
        store._connection.commit()  # noqa: SLF001
    finally:
        store.close()

    assert export_quarantine(db_path, export_path) == 1
    repair_store(db_path, backup_path, restore_path=export_path)
    expected_quarantine_count = 2
    assert inspect_store(db_path)["counts"]["quarantined"] == expected_quarantine_count


def test_doctor_rejects_combined_restore_and_delete_without_mutation(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "memory.db"
    restore_path = tmp_path / "quarantine.json"
    backup_path = tmp_path / "backup.db"
    store = MemoryStore(db_path)
    try:
        store._connection.execute(  # noqa: SLF001
            """
            INSERT INTO memory_quarantine (
                source_table, source_row_id, reason_code, raw_payload
            ) VALUES ('memories', '1', 'CMP-MEM-0008', '{"value_count": 1}')
            """
        )
        store._connection.commit()  # noqa: SLF001
    finally:
        store.close()
    restore_path.write_text(
        json.dumps(
            [
                {
                    "source_table": "memories",
                    "source_row_id": "2",
                    "reason_code": "CMP-MEM-0008",
                    "raw_payload": '{"value_count": 1}',
                }
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="mutually exclusive"):
        repair_store(
            db_path,
            backup_path,
            restore_path=restore_path,
            delete_quarantine=True,
        )

    assert not backup_path.exists()
    assert inspect_store(db_path)["counts"]["quarantined"] == 1


def test_backup_refuses_to_overwrite_existing_file(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    MemoryStore(db_path).close()
    backup_path = tmp_path / "backup.db"
    backup_path.write_bytes(b"do not overwrite")

    with pytest.raises(ValueError, match="already exists"):
        backup_store(db_path, backup_path)

    assert backup_path.read_bytes() == b"do not overwrite"


def test_doctor_restore_refuses_rows_above_runtime_quarantine_cap(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    MemoryStore(db_path).close()
    restore_path = tmp_path / "quarantine.json"
    backup_path = tmp_path / "backup.db"
    restore_path.write_text(
        json.dumps([{}] * (MAX_QUARANTINE_ROWS + 1)),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="invalid or oversized"):
        repair_store(db_path, backup_path, restore_path=restore_path)
