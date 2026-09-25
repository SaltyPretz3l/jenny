from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, build_content_digest
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.store_migrations import (
    _execute_schema_script,
    run_migrations,
    v7_schema_script,
)


def _create_v7_database(path: Path) -> None:
    connection = sqlite3.connect(str(path))
    try:
        _execute_schema_script(connection, v7_schema_script(), version=7)
        connection.execute(
            """
            INSERT INTO memories (
                id, session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, family_key, provenance,
                created_at, updated_at
            ) VALUES (7, 'session-1', 'Tea', 'The user prefers tea.',
                'preference', 0.9, 'I prefer tea', ?, '', 'user_approved',
                '2026-01-01T00:00:00+00:00', '2026-01-02T00:00:00+00:00')
            """,
            (build_content_digest("preference", "The user prefers tea."),),
        )
        connection.execute(
            """
            INSERT INTO pending_memory_candidates (
                id, session_id, source_request_id, title, lesson_text,
                lesson_kind, confidence, source_excerpt, content_fingerprint,
                family_key, category, created_at, updated_at
            ) VALUES (8, 'session-1', 'request-1', 'Coffee',
                'The user prefers coffee.', 'preference', 0.8, 'coffee', ?,
                '', 'user', '2026-01-03T00:00:00+00:00',
                '2026-01-04T00:00:00+00:00')
            """,
            (build_content_digest("preference", "The user prefers coffee."),),
        )
        connection.execute(
            """
            INSERT INTO memory_suppressions (
                content_fingerprint, reason, created_at
            ) VALUES (?, 'dismissed', '2026-01-05T00:00:00+00:00')
            """,
            (build_content_digest("preference", "The user prefers water."),),
        )
        connection.execute(
            """
            INSERT INTO memory_extraction_runs (
                session_id, request_id, status, attempt_count, started_at,
                completed_at, failure_code, created_at, updated_at
            ) VALUES ('session-1', 'request-1', 'completed', 2,
                '2026-01-01T00:00:00+00:00', '2026-01-01T00:01:00+00:00',
                '', '2026-01-01T00:00:00+00:00', '2026-01-01T00:01:00+00:00')
            """
        )
        connection.execute(
            """
            INSERT INTO memory_quarantine (
                id, source_table, source_row_id, reason_code, raw_payload,
                quarantined_at
            ) VALUES (9, 'memories', 'bad', 'malformed_runtime_row', '{}',
                '2026-01-06T00:00:00+00:00')
            """
        )
        connection.execute(
            """
            INSERT INTO memories (
                id, session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, family_key, provenance,
                created_at, updated_at
            ) VALUES (40, 'deleted-session', 'Deleted', 'Deleted memory.',
                'preference', 0.5, '', ?, '', 'unknown_legacy',
                '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')
            """,
            (build_content_digest("preference", "Deleted memory."),),
        )
        connection.execute(
            """
            INSERT INTO pending_memory_candidates (
                id, session_id, source_request_id, title, lesson_text,
                lesson_kind, confidence, source_excerpt, content_fingerprint,
                family_key, category, created_at, updated_at
            ) VALUES (50, 'deleted-session', 'deleted-request', 'Deleted',
                'Deleted candidate.', 'preference', 0.5, '', ?, '', '',
                '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')
            """,
            (build_content_digest("preference", "Deleted candidate."),),
        )
        connection.execute(
            """
            INSERT INTO memory_quarantine (
                id, source_table, source_row_id, reason_code, raw_payload,
                quarantined_at
            ) VALUES (60, 'memories', 'deleted', 'deleted_test', '{}',
                '2026-01-01T00:00:00+00:00')
            """
        )
        connection.execute("DELETE FROM memories WHERE id = 40")
        connection.execute("DELETE FROM pending_memory_candidates WHERE id = 50")
        connection.execute("DELETE FROM memory_quarantine WHERE id = 60")
        connection.execute(
            "CREATE VIRTUAL TABLE memory_fts USING fts5(title, lesson_text, source_excerpt)"
        )
        connection.commit()
    finally:
        connection.close()


def test_v7_migration_preserves_rows_scope_and_sequence_highwater(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    _create_v7_database(db_path)

    store = MemoryStore(db_path)
    try:
        assert store._connection.execute("PRAGMA user_version").fetchone()[0] == 8  # noqa: SLF001
        memory = store.get_memory_by_id(7)
        assert memory is not None
        assert memory.project_id == GENERAL_PROJECT_ID
        assert memory.provenance == "user_approved"
        pending = store.get_pending_candidates("session-1")
        assert [(row.id, row.project_id) for row in pending] == [
            (8, GENERAL_PROJECT_ID)
        ]
        assert store._connection.execute(  # noqa: SLF001
            "SELECT project_id, attempt_count FROM memory_extraction_runs"
        ).fetchone() == (GENERAL_PROJECT_ID, 2)
        assert store._connection.execute(  # noqa: SLF001
            "SELECT project_id, reason FROM memory_suppressions"
        ).fetchone()[0] == GENERAL_PROJECT_ID
        sequences = dict(
            store._connection.execute(  # noqa: SLF001
                "SELECT name, seq FROM sqlite_sequence"
            ).fetchall()
        )
        assert sequences["memories"] >= 40
        assert sequences["pending_memory_candidates"] >= 50
        assert sequences["memory_quarantine"] >= 60
    finally:
        store.close()

    reopened = MemoryStore(db_path)
    try:
        assert reopened.get_memory_by_id(7) is not None
        assert reopened._connection.execute("PRAGMA user_version").fetchone()[0] == 8  # noqa: SLF001
    finally:
        reopened.close()


def test_v7_migration_interruption_rolls_back_schema_and_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "memory.db"
    _create_v7_database(db_path)
    connection = sqlite3.connect(str(db_path))

    def interrupt(stage: str) -> None:
        if stage == "v8_rows_copied":
            raise RuntimeError("injected migration interruption")

    monkeypatch.setattr(
        "sidecar.ai.memory.store_migrations._migration_checkpoint", interrupt
    )
    try:
        with pytest.raises(RuntimeError, match="injected migration interruption"):
            run_migrations(connection)
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 7
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(memories)").fetchall()
        }
        assert "project_id" not in columns
        assert connection.execute("SELECT id FROM memories").fetchall() == [(7,)]
        assert connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'memory_fts'"
        ).fetchone() == (1,)
        assert connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'memories_v7_source'"
        ).fetchone() is None
    finally:
        connection.close()
