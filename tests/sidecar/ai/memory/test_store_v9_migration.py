"""The atomic v8 -> v9 rebuild: kinds, origins, text-only digests, lifecycle."""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path

import pytest

from sidecar.ai.memory import store_migrations
from sidecar.ai.memory.contracts import (
    GENERAL_PROJECT_ID,
    build_text_digest,
    legacy_kind_digest,
)
from sidecar.ai.memory.store import SCHEMA_VERSION, MemoryStore
from sidecar.ai.memory.store_project_migration import v8_schema_script
from sidecar.exceptions import MemoryStoreError

STAMP = "2026-10-01T00:00:00+00:00"
_APPROVED = (
    # id, lesson_text, kind, provenance, project
    (3, "Prefers tea over coffee.", "preference", "user_approved", GENERAL_PROJECT_ID),
    (5, "prefers TEA over coffee.", "profile", "automatic", GENERAL_PROJECT_ID),
    (7, "Use concise answers.", "response_style", "user_approved", GENERAL_PROJECT_ID),
    (9, "Search with ripgrep first.", "tool_strategy", "automatic", "project_alpha"),
    (11, "Alice reviews every release.", "important_person", "unknown_legacy", "project_alpha"),
    (12, "Wants the dashboard by Friday.", "goal", "automatic", "project_alpha"),
    (13, "Something odd.", "mystery_kind", "automatic", "project_alpha"),
)


def _build_v8_database(path: Path) -> None:
    connection = sqlite3.connect(str(path), isolation_level=None)
    try:
        store_migrations._execute_schema_script(
            connection, v8_schema_script(), version=8
        )
        for memory_id, text, kind, provenance, project_id in _APPROVED:
            connection.execute(
                """
                INSERT INTO memories (
                    id, session_id, title, lesson_text, lesson_kind, confidence,
                    source_excerpt, content_fingerprint, family_key, provenance,
                    created_at, updated_at, project_id
                ) VALUES (?, 'session-v8', ?, ?, ?, 0.9, 'excerpt', ?, 'legacy_family', ?, ?, ?, ?)
                """,
                (
                    memory_id, f"Title {memory_id}", text, kind,
                    legacy_kind_digest(kind, text), provenance, STAMP, STAMP, project_id,
                ),
            )
        connection.execute("UPDATE sqlite_sequence SET seq = 40 WHERE name = 'memories'")
        connection.execute(
            """
            INSERT INTO pending_memory_candidates (
                id, session_id, source_request_id, title, lesson_text, lesson_kind,
                confidence, source_excerpt, content_fingerprint, family_key, category,
                created_at, updated_at, project_id
            ) VALUES (4, 'session-v8', 'request-v8', 'Pending', 'Likes jazz.', 'preference',
                      0.7, '', ?, 'jazz', 'music', ?, ?, ?)
            """,
            (legacy_kind_digest("preference", "Likes jazz."), STAMP, STAMP, GENERAL_PROJECT_ID),
        )
        connection.execute(
            """
            INSERT INTO memory_suppressions (project_id, content_fingerprint, reason, created_at)
            VALUES (?, ?, 'forgotten', ?)
            """,
            (GENERAL_PROJECT_ID, legacy_kind_digest("preference", "Old secret."), STAMP),
        )
        connection.execute(
            """
            INSERT INTO memory_extraction_runs (
                session_id, request_id, status, attempt_count, created_at, updated_at, project_id
            ) VALUES ('session-v8', 'request-v8', 'completed', 1, ?, ?, ?)
            """,
            (STAMP, STAMP, GENERAL_PROJECT_ID),
        )
    finally:
        connection.close()


def _rows(path: Path, sql: str) -> list[tuple]:
    connection = sqlite3.connect(str(path))
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


def test_v8_rebuild_maps_kinds_collapses_duplicates_and_drops_legacy_state(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    db_path = tmp_path / "memory.db"
    _build_v8_database(db_path)

    with caplog.at_level(logging.INFO, logger="sidecar.ai.memory.store_v9_migration"):
        store = MemoryStore(db_path)
    try:
        # The v9 rebuild chains straight into the additive v10 step on open.
        assert SCHEMA_VERSION == 10
        assert _rows(db_path, "PRAGMA user_version") == [(10,)]
        rows = {
            row[0]: row[1:]
            for row in _rows(
                db_path,
                """
                SELECT id, lesson_kind, origin, status, revision, scope_session_id,
                       protected, always_on, source_message_ids, content_fingerprint
                FROM memories
                """,
            )
        }
        assert sorted(rows) == [3, 7, 9, 11, 12, 13]
        assert {memory_id: row[0] for memory_id, row in rows.items()} == {
            3: "preference",
            7: "preference",
            9: "lesson",
            11: "person",
            12: "fact",
            13: "fact",
        }
        assert rows[3][1] == "user" and rows[9][1] == "legacy" and rows[11][1] == "legacy"
        for row in rows.values():
            assert row[2:8] == ("active", 1, "", 0, 0, "[]")
        assert rows[3][8] == build_text_digest("Prefers tea over coffee.")
        assert _rows(db_path, "SELECT seq FROM sqlite_sequence WHERE name = 'memories'") == [(40,)]

        quarantine = _rows(
            db_path,
            "SELECT source_row_id, reason_code, raw_payload FROM memory_quarantine",
        )
        assert [(row[0], row[1]) for row in quarantine] == [("5", "v9_duplicate_collapsed")]
        assert json.loads(quarantine[0][2])["lesson_text"] == "prefers TEA over coffee."

        assert _rows(db_path, "SELECT COUNT(*) FROM memory_suppressions") == [(0,)]
        tables = {row[0] for row in _rows(db_path, "SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert "memory_extraction_runs" not in tables
        assert {
            "memory_operations",
            "memory_reflection_cursor",
            "memory_project_state",
            "memory_session_markers",
        } <= tables
        pending_columns = {row[1] for row in _rows(db_path, "PRAGMA table_info(pending_memory_candidates)")}
        assert "family_key" not in pending_columns and "origin" in pending_columns
        assert _rows(
            db_path,
            "SELECT id, lesson_kind, origin, content_fingerprint FROM pending_memory_candidates",
        ) == [(4, "preference", "legacy", build_text_digest("Likes jazz."))]
        memory_columns = {row[1] for row in _rows(db_path, "PRAGMA table_info(memories)")}
        assert "family_key" not in memory_columns

        recalled = store.recall_memories("ripgrep", limit=3, project_id="project_alpha")
        assert [memory.id for memory in recalled] == [9]
        assert store.status_snapshot()["schema_version"] == 10
        messages = " ".join(record.getMessage() for record in caplog.records)
        assert "suppressions_dropped=1" in messages
        assert "collapsed=1" in messages
        assert "tea" not in messages.lower()
    finally:
        store.close()


@pytest.mark.parametrize(
    "stage",
    ["v9_fts_dropped", "v9_schema_created", "v9_rows_copied", "v9_committed"],
)
def test_v9_rebuild_fault_rolls_back_to_an_intact_v8(
    stage: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "memory.db"
    _build_v8_database(db_path)

    def _fail(current: str) -> None:
        if current == stage:
            raise RuntimeError(f"injected v9 failure at {stage}")

    monkeypatch.setattr(store_migrations, "_migration_checkpoint", _fail)
    with pytest.raises((RuntimeError, MemoryStoreError)):
        MemoryStore(db_path)

    assert _rows(db_path, "PRAGMA user_version") == [(8,)]
    assert _rows(db_path, "SELECT COUNT(*) FROM memories") == [(len(_APPROVED),)]
    assert _rows(db_path, "SELECT COUNT(*) FROM memory_extraction_runs") == [(1,)]
    assert _rows(db_path, "SELECT COUNT(*) FROM memory_suppressions") == [(1,)]


def test_fresh_database_is_created_at_the_current_schema(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        assert _rows(tmp_path / "memory.db", "PRAGMA user_version") == [(SCHEMA_VERSION,)]
        indexes = {
            row[0]
            for row in _rows(tmp_path / "memory.db", "SELECT name FROM sqlite_master WHERE type = 'index'")
        }
        assert "idx_memories_active_digest" in indexes
        triggers = {
            row[0]
            for row in _rows(tmp_path / "memory.db", "SELECT name FROM sqlite_master WHERE type = 'trigger'")
        }
        assert triggers == {
            "memory_fts_insert", "memory_fts_delete", "memory_fts_update",
            "memory_vectors_invalidate", "memory_vectors_delete",
        }
    finally:
        store.close()
