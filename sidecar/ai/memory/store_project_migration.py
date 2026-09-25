"""Project-isolation schema and the atomic memory v7-to-v8 rebuild."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable

from sidecar.ai.error_codes import CMP_MEMORY_SCHEMA_MIGRATION
from sidecar.ai.memory.contracts import (
    CONTENT_DIGEST_CHARS,
    GENERAL_PROJECT_ID,
    MAX_CATEGORY_CHARS,
    MAX_FAMILY_KEY_CHARS,
    MAX_LESSON_TEXT_CHARS,
    MAX_PROJECT_ID_CHARS,
    MAX_PROVENANCE_CHARS,
    MAX_QUARANTINE_PAYLOAD_CHARS,
    MAX_REQUEST_ID_CHARS,
    MAX_SESSION_ID_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    MAX_TITLE_CHARS,
)
from sidecar.ai.memory.store_shared import _transaction
from sidecar.exceptions import MemoryStoreError


def _project_check(column: str = "project_id") -> str:
    return f"""
        length({column}) BETWEEN 9 AND {MAX_PROJECT_ID_CHARS}
        AND substr({column}, 1, 8) = 'project_'
        AND substr({column}, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    """


def v8_schema_script() -> str:
    """Return the complete project-scoped v8 schema for an empty database."""

    return f"""
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND {MAX_TITLE_CHARS}),
            lesson_text TEXT NOT NULL
              CHECK(length(lesson_text) BETWEEN 1 AND {MAX_LESSON_TEXT_CHARS}),
            lesson_kind TEXT NOT NULL CHECK(length(lesson_kind) BETWEEN 1 AND {MAX_CATEGORY_CHARS}),
            confidence REAL NOT NULL
              CHECK(typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0.0 AND 1.0),
            source_excerpt TEXT NOT NULL DEFAULT ''
              CHECK(length(source_excerpt) <= {MAX_SOURCE_EXCERPT_CHARS}),
            content_fingerprint TEXT NOT NULL CHECK(
                length(content_fingerprint) = {CONTENT_DIGEST_CHARS}
                AND substr(content_fingerprint, 1, 7) = 'sha256:'
                AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
            ),
            family_key TEXT NOT NULL DEFAULT '' CHECK(length(family_key) <= {MAX_FAMILY_KEY_CHARS}),
            provenance TEXT NOT NULL DEFAULT 'unknown_legacy'
              CHECK(length(provenance) BETWEEN 1 AND {MAX_PROVENANCE_CHARS}),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT '{GENERAL_PROJECT_ID}' CHECK({_project_check()}),
            UNIQUE(project_id, content_fingerprint)
        );
        CREATE INDEX idx_memories_project_updated
          ON memories(project_id, updated_at DESC, id DESC);
        CREATE INDEX idx_memories_project_kind_updated
          ON memories(project_id, lesson_kind, updated_at DESC, id DESC);
        CREATE INDEX idx_memories_project_session_updated
          ON memories(project_id, session_id, updated_at DESC, id DESC);

        CREATE TABLE memory_extraction_runs (
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
            request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND {MAX_REQUEST_ID_CHARS}),
            status TEXT NOT NULL DEFAULT 'completed'
              CHECK(status IN ('in_progress', 'completed', 'failed')),
            attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count BETWEEN 0 AND 3),
            started_at TEXT,
            completed_at TEXT,
            failure_code TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT '{GENERAL_PROJECT_ID}' CHECK({_project_check()}),
            PRIMARY KEY (project_id, session_id, request_id)
        );
        CREATE INDEX idx_memory_extraction_project_created
          ON memory_extraction_runs(project_id, created_at ASC, session_id, request_id);

        CREATE TABLE pending_memory_candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
            source_request_id TEXT NOT NULL
              CHECK(length(source_request_id) BETWEEN 1 AND {MAX_REQUEST_ID_CHARS}),
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND {MAX_TITLE_CHARS}),
            lesson_text TEXT NOT NULL
              CHECK(length(lesson_text) BETWEEN 1 AND {MAX_LESSON_TEXT_CHARS}),
            lesson_kind TEXT NOT NULL CHECK(length(lesson_kind) BETWEEN 1 AND {MAX_CATEGORY_CHARS}),
            confidence REAL NOT NULL
              CHECK(typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0.0 AND 1.0),
            source_excerpt TEXT NOT NULL DEFAULT ''
              CHECK(length(source_excerpt) <= {MAX_SOURCE_EXCERPT_CHARS}),
            content_fingerprint TEXT NOT NULL CHECK(
                length(content_fingerprint) = {CONTENT_DIGEST_CHARS}
                AND substr(content_fingerprint, 1, 7) = 'sha256:'
                AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
            ),
            family_key TEXT NOT NULL DEFAULT '' CHECK(length(family_key) <= {MAX_FAMILY_KEY_CHARS}),
            category TEXT NOT NULL DEFAULT '' CHECK(length(category) <= {MAX_CATEGORY_CHARS}),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT '{GENERAL_PROJECT_ID}' CHECK({_project_check()}),
            UNIQUE(project_id, session_id, content_fingerprint)
        );
        CREATE INDEX idx_pending_memory_project_session_updated
          ON pending_memory_candidates(project_id, session_id, updated_at DESC, id DESC);
        CREATE INDEX idx_pending_memory_project_updated
          ON pending_memory_candidates(project_id, updated_at DESC, id DESC);

        CREATE TABLE memory_suppressions (
            project_id TEXT NOT NULL DEFAULT '{GENERAL_PROJECT_ID}' CHECK({_project_check()}),
            content_fingerprint TEXT NOT NULL CHECK(
                length(content_fingerprint) = {CONTENT_DIGEST_CHARS}
                AND substr(content_fingerprint, 1, 7) = 'sha256:'
                AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
            ),
            reason TEXT NOT NULL CHECK(reason IN ('forgotten', 'dismissed')),
            created_at TEXT NOT NULL,
            PRIMARY KEY(project_id, content_fingerprint)
        );

        CREATE TABLE memory_quarantine (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table TEXT NOT NULL CHECK(length(source_table) BETWEEN 1 AND 64),
            source_row_id TEXT NOT NULL DEFAULT '' CHECK(length(source_row_id) <= 64),
            reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
            raw_payload TEXT NOT NULL CHECK(length(raw_payload) <= {MAX_QUARANTINE_PAYLOAD_CHARS}),
            quarantined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX idx_memory_quarantine_created
          ON memory_quarantine(quarantined_at DESC, id DESC);
    """


def _sequence_highwater(connection: sqlite3.Connection, table: str) -> int:
    row = connection.execute(
        "SELECT seq FROM sqlite_sequence WHERE name = ?",
        (table,),
    ).fetchone()
    sequence = int(row[0] if row else 0)
    maximum = connection.execute(f"SELECT COALESCE(MAX(id), 0) FROM {table}").fetchone()
    return max(sequence, int(maximum[0] if maximum else 0))


def _restore_sequence(connection: sqlite3.Connection, table: str, value: int) -> None:
    cursor = connection.execute(
        "UPDATE sqlite_sequence SET seq = ? WHERE name = ?",
        (value, table),
    )
    if int(cursor.rowcount or 0) == 0:
        connection.execute(
            "INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)",
            (table, value),
        )


def migrate_v7_to_v8(
    connection: sqlite3.Connection,
    *,
    checkpoint: Callable[[str], None],
    execute_schema_script: Callable[..., None],
) -> None:
    """Atomically rebuild v7 user data under the canonical General project."""

    try:
        with _transaction(connection):
            highwaters = {
                table: _sequence_highwater(connection, table)
                for table in ("memories", "pending_memory_candidates", "memory_quarantine")
            }
            for trigger in ("memory_fts_insert", "memory_fts_delete", "memory_fts_update"):
                connection.execute(f"DROP TRIGGER IF EXISTS {trigger}")
            connection.execute("DROP TABLE IF EXISTS memory_fts")
            checkpoint("v8_fts_dropped")
            for index in (
                "idx_memories_updated_at",
                "idx_memories_updated_id",
                "idx_memories_kind_updated",
                "idx_memories_session_updated",
                "idx_pending_memory_session_updated",
                "idx_pending_memory_updated_id",
                "idx_memory_extraction_runs_created",
                "idx_memory_quarantine_created",
            ):
                connection.execute(f"DROP INDEX IF EXISTS {index}")
            for table in (
                "memories",
                "memory_extraction_runs",
                "pending_memory_candidates",
                "memory_suppressions",
                "memory_quarantine",
            ):
                connection.execute(f"ALTER TABLE {table} RENAME TO {table}_v7_source")
            execute_schema_script(connection, v8_schema_script(), version=7)
            checkpoint("v8_schema_created")

            connection.execute(
                """
                INSERT INTO memories (
                    id, session_id, title, lesson_text, lesson_kind, confidence,
                    source_excerpt, content_fingerprint, family_key, provenance,
                    created_at, updated_at, project_id
                )
                SELECT id, session_id, title, lesson_text, lesson_kind, confidence,
                       source_excerpt, content_fingerprint, family_key, provenance,
                       created_at, updated_at, ?
                FROM memories_v7_source
                """,
                (GENERAL_PROJECT_ID,),
            )
            connection.execute(
                """
                INSERT INTO pending_memory_candidates (
                    id, session_id, source_request_id, title, lesson_text, lesson_kind,
                    confidence, source_excerpt, content_fingerprint, family_key,
                    category, created_at, updated_at, project_id
                )
                SELECT id, session_id, source_request_id, title, lesson_text, lesson_kind,
                       confidence, source_excerpt, content_fingerprint, family_key,
                       category, created_at, updated_at, ?
                FROM pending_memory_candidates_v7_source
                """,
                (GENERAL_PROJECT_ID,),
            )
            connection.execute(
                """
                INSERT INTO memory_suppressions (
                    project_id, content_fingerprint, reason, created_at
                )
                SELECT ?, content_fingerprint, reason, created_at
                FROM memory_suppressions_v7_source
                """,
                (GENERAL_PROJECT_ID,),
            )
            connection.execute(
                """
                INSERT INTO memory_extraction_runs (
                    session_id, request_id, status, attempt_count, started_at,
                    completed_at, failure_code, created_at, updated_at, project_id
                )
                SELECT session_id, request_id, status, attempt_count, started_at,
                       completed_at, failure_code, created_at, updated_at, ?
                FROM memory_extraction_runs_v7_source
                """,
                (GENERAL_PROJECT_ID,),
            )
            connection.execute(
                """
                INSERT INTO memory_quarantine (
                    id, source_table, source_row_id, reason_code, raw_payload, quarantined_at
                )
                SELECT id, source_table, source_row_id, reason_code, raw_payload, quarantined_at
                FROM memory_quarantine_v7_source
                """
            )
            checkpoint("v8_rows_copied")
            for table in (
                "memories",
                "memory_extraction_runs",
                "pending_memory_candidates",
                "memory_suppressions",
                "memory_quarantine",
            ):
                connection.execute(f"DROP TABLE {table}_v7_source")
            for table, highwater in highwaters.items():
                _restore_sequence(connection, table, highwater)
            connection.execute("PRAGMA user_version=8")
            checkpoint("v8_committed")
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(
            CMP_MEMORY_SCHEMA_MIGRATION,
            "failed to migrate memory database to schema v8",
        ) from error
