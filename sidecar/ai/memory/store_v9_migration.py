"""Memory schema v9 and the atomic v8-to-v9 rebuild.

v9 adds the memory lifecycle (active/archived, revision, origin, protection,
always-on, chat scope), text-only content digests, the operations ledger, the
reflection cursor, project-archive state and session purge markers. It drops
``family_key`` and ``memory_extraction_runs``. The rebuild mirrors v7 -> v8:
one transaction, row ids and AUTOINCREMENT high-waters preserved, FTS dropped
here and rebuilt by the store on open.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from collections.abc import Callable
from typing import Any

from sidecar.ai.error_codes import CMP_MEMORY_SCHEMA_MIGRATION
from sidecar.ai.memory.contracts import (
    CONTENT_DIGEST_CHARS,
    GENERAL_PROJECT_ID,
    MAX_CATEGORY_CHARS,
    MAX_LESSON_TEXT_CHARS,
    MAX_OPERATION_ID_CHARS,
    MAX_OPERATION_JSON_CHARS,
    MAX_PROVENANCE_CHARS,
    MAX_QUARANTINE_PAYLOAD_CHARS,
    MAX_QUARANTINE_ROWS,
    MAX_REQUEST_ID_CHARS,
    MAX_SESSION_ID_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    MAX_SOURCE_MESSAGE_IDS,
    MAX_TITLE_CHARS,
    MEMORY_KINDS,
    MEMORY_ORIGINS,
    build_text_digest,
    map_legacy_kind,
)
from sidecar.ai.memory.store_project_migration import (
    _project_check,
    _restore_sequence,
    _sequence_highwater,
)
from sidecar.ai.memory.store_shared import _transaction
from sidecar.exceptions import MemoryStoreError

logger = logging.getLogger(__name__)

_FTS_TRIGGERS = ("memory_fts_insert", "memory_fts_delete", "memory_fts_update")
_V8_INDEXES = (
    "idx_memories_project_updated",
    "idx_memories_project_kind_updated",
    "idx_memories_project_session_updated",
    "idx_memory_extraction_project_created",
    "idx_pending_memory_project_session_updated",
    "idx_pending_memory_project_updated",
)
_REBUILT_TABLES = ("memories", "pending_memory_candidates", "memory_suppressions")
_MAX_SOURCE_MESSAGE_IDS_JSON_CHARS = 4_096


def _in_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _digest_check(column: str = "content_fingerprint") -> str:
    return f"""
        length({column}) = {CONTENT_DIGEST_CHARS}
        AND substr({column}, 1, 7) = 'sha256:'
        AND substr({column}, 8) NOT GLOB '*[^0-9a-f]*'
    """


def v9_schema_script() -> str:
    """Return the complete v9 schema (fresh databases and the v8 rebuild)."""

    return f"""
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL DEFAULT '{GENERAL_PROJECT_ID}' CHECK({_project_check()}),
            scope_session_id TEXT NOT NULL DEFAULT ''
              CHECK(length(scope_session_id) <= {MAX_SESSION_ID_CHARS}),
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND {MAX_TITLE_CHARS}),
            lesson_text TEXT NOT NULL
              CHECK(length(lesson_text) BETWEEN 1 AND {MAX_LESSON_TEXT_CHARS}),
            lesson_kind TEXT NOT NULL CHECK(lesson_kind IN ({_in_list(MEMORY_KINDS)})),
            confidence REAL NOT NULL
              CHECK(typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0.0 AND 1.0),
            source_excerpt TEXT NOT NULL DEFAULT ''
              CHECK(length(source_excerpt) <= {MAX_SOURCE_EXCERPT_CHARS}),
            content_fingerprint TEXT NOT NULL CHECK({_digest_check()}),
            provenance TEXT NOT NULL DEFAULT 'unknown_legacy'
              CHECK(length(provenance) BETWEEN 1 AND {MAX_PROVENANCE_CHARS}),
            origin TEXT NOT NULL CHECK(origin IN ({_in_list(MEMORY_ORIGINS)})),
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
            archived_at TEXT,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            protected INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0, 1)),
            always_on INTEGER NOT NULL DEFAULT 0 CHECK(always_on IN (0, 1)),
            source_message_ids TEXT NOT NULL DEFAULT '[]' CHECK(
                length(source_message_ids) <= {_MAX_SOURCE_MESSAGE_IDS_JSON_CHARS}
                AND json_valid(source_message_ids)
                AND json_type(source_message_ids) = 'array'
                AND json_array_length(source_message_ids) <= {MAX_SOURCE_MESSAGE_IDS}
            ),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK((status = 'archived') = (archived_at IS NOT NULL))
        );
        CREATE UNIQUE INDEX idx_memories_active_digest
          ON memories(project_id, scope_session_id, content_fingerprint) WHERE status = 'active';
        CREATE INDEX idx_memories_project_status_updated
          ON memories(project_id, status, updated_at DESC, id DESC);
        CREATE INDEX idx_memories_project_status_kind_updated
          ON memories(project_id, status, lesson_kind, updated_at DESC, id DESC);
        CREATE INDEX idx_memories_project_scope_status
          ON memories(project_id, scope_session_id, status, id);
        CREATE INDEX idx_memories_project_status_always_on
          ON memories(project_id, status, always_on, id);

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
            content_fingerprint TEXT NOT NULL CHECK({_digest_check()}),
            category TEXT NOT NULL DEFAULT '' CHECK(length(category) <= {MAX_CATEGORY_CHARS}),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT '{GENERAL_PROJECT_ID}' CHECK({_project_check()}),
            origin TEXT NOT NULL DEFAULT 'legacy' CHECK(origin IN ({_in_list(MEMORY_ORIGINS)})),
            UNIQUE(project_id, session_id, content_fingerprint)
        );
        CREATE INDEX idx_pending_memory_project_session_updated
          ON pending_memory_candidates(project_id, session_id, updated_at DESC, id DESC);
        CREATE INDEX idx_pending_memory_project_updated
          ON pending_memory_candidates(project_id, updated_at DESC, id DESC);

        CREATE TABLE memory_suppressions (
            project_id TEXT NOT NULL DEFAULT '{GENERAL_PROJECT_ID}' CHECK({_project_check()}),
            content_fingerprint TEXT NOT NULL CHECK({_digest_check()}),
            reason TEXT NOT NULL CHECK(reason IN ('forgotten', 'dismissed')),
            created_at TEXT NOT NULL,
            PRIMARY KEY(project_id, content_fingerprint)
        );

        CREATE TABLE IF NOT EXISTS memory_quarantine (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table TEXT NOT NULL CHECK(length(source_table) BETWEEN 1 AND 64),
            source_row_id TEXT NOT NULL DEFAULT '' CHECK(length(source_row_id) <= 64),
            reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
            raw_payload TEXT NOT NULL CHECK(length(raw_payload) <= {MAX_QUARANTINE_PAYLOAD_CHARS}),
            quarantined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memory_quarantine_created
          ON memory_quarantine(quarantined_at DESC, id DESC);

        CREATE TABLE memory_operations (
            operation_id TEXT PRIMARY KEY
              CHECK(length(operation_id) BETWEEN 1 AND {MAX_OPERATION_ID_CHARS}),
            action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 32),
            scope_key TEXT NOT NULL CHECK(length(scope_key) <= 512),
            payload_digest TEXT NOT NULL CHECK({_digest_check("payload_digest")}),
            memory_id INTEGER,
            op TEXT NOT NULL CHECK(op IN ('remember', 'update', 'forget', 'restore', 'undo')),
            origin TEXT NOT NULL CHECK(origin IN ({_in_list(MEMORY_ORIGINS)})),
            prior_json TEXT NOT NULL DEFAULT ''
                CHECK(length(prior_json) <= {MAX_OPERATION_JSON_CHARS}),
            prior_suppression TEXT
                CHECK(prior_suppression IS NULL OR json_valid(prior_suppression)),
            result_revision INTEGER,
            response_json TEXT NOT NULL DEFAULT ''
              CHECK(length(response_json) <= {MAX_OPERATION_JSON_CHARS}),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            undone_at TEXT,
            stub INTEGER NOT NULL DEFAULT 0 CHECK(stub IN (0, 1))
        );
        CREATE INDEX idx_memory_operations_expires ON memory_operations(expires_at);
        CREATE INDEX idx_memory_operations_memory ON memory_operations(memory_id);

        CREATE TABLE memory_reflection_cursor (
            session_id TEXT PRIMARY KEY
              CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
            project_id TEXT NOT NULL CHECK({_project_check()}),
            message_count INTEGER NOT NULL,
            last_message_id TEXT NOT NULL,
            window_fingerprint TEXT NOT NULL,
            session_incarnation INTEGER NOT NULL,
            turn_generation INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE memory_project_state (
            project_id TEXT PRIMARY KEY CHECK({_project_check()}),
            archived_at TEXT NOT NULL
        );

        CREATE TABLE memory_session_markers (
            session_id TEXT PRIMARY KEY
              CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
            purged_at TEXT NOT NULL
        );
        CREATE INDEX idx_memory_session_markers_purged
          ON memory_session_markers(purged_at ASC, session_id);
    """


def _quarantine_payload(row: dict[str, Any]) -> str:
    """The row as JSON under the quarantine cap (the excerpt goes first if too long)."""

    payload = json.dumps(row, ensure_ascii=False, default=str)
    if len(payload) > MAX_QUARANTINE_PAYLOAD_CHARS:
        payload = json.dumps({**row, "source_excerpt": ""}, ensure_ascii=False, default=str)
    return payload[:MAX_QUARANTINE_PAYLOAD_CHARS]


def _quarantine(
    connection: sqlite3.Connection,
    *,
    source_table: str,
    row: dict[str, Any],
    reason_code: str,
) -> None:
    connection.execute(
        """
        INSERT INTO memory_quarantine (source_table, source_row_id, reason_code, raw_payload)
        VALUES (?, ?, ?, ?)
        """,
        (source_table, str(row.get("id", ""))[:64], reason_code, _quarantine_payload(row)),
    )


def _migrate_approved_rows(connection: sqlite3.Connection) -> tuple[int, int]:
    cursor = connection.execute(
        """
        SELECT id, session_id, title, lesson_text, lesson_kind, confidence,
               source_excerpt, provenance, created_at, updated_at, project_id
        FROM memories_v8_source
        ORDER BY id ASC
        """
    )
    columns = [description[0] for description in cursor.description]
    seen: set[tuple[str, str]] = set()
    migrated = collapsed = 0
    for values in cursor.fetchall():
        row = dict(zip(columns, values, strict=True))
        digest = build_text_digest(row["lesson_text"])
        key = (str(row["project_id"]), digest)
        if key in seen:
            _quarantine(
                connection,
                source_table="memories",
                row=row,
                reason_code="v9_duplicate_collapsed",
            )
            collapsed += 1
            continue
        try:
            connection.execute(
                """
                INSERT INTO memories (
                    id, project_id, scope_session_id, session_id, title, lesson_text,
                    lesson_kind, confidence, source_excerpt, content_fingerprint,
                    provenance, origin, status, revision, protected, always_on,
                    source_message_ids, created_at, updated_at
                ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 0, 0, '[]', ?, ?)
                """,
                (
                    row["id"], row["project_id"], row["session_id"], row["title"],
                    row["lesson_text"], map_legacy_kind(row["lesson_kind"]), row["confidence"],
                    row["source_excerpt"], digest, row["provenance"],
                    "user" if row["provenance"] == "user_approved" else "legacy",
                    row["created_at"], row["updated_at"],
                ),
            )
        except sqlite3.IntegrityError:
            _quarantine(
                connection, source_table="memories", row=row, reason_code="v9_invalid_row"
            )
            collapsed += 1
            continue
        seen.add(key)
        migrated += 1
    return migrated, collapsed


def _migrate_pending_rows(connection: sqlite3.Connection) -> int:
    cursor = connection.execute(
        """
        SELECT id, session_id, source_request_id, title, lesson_text, lesson_kind,
               confidence, source_excerpt, category, created_at, updated_at, project_id
        FROM pending_memory_candidates_v8_source
        ORDER BY id ASC
        """
    )
    columns = [description[0] for description in cursor.description]
    collapsed = 0
    for values in cursor.fetchall():
        row = dict(zip(columns, values, strict=True))
        try:
            connection.execute(
                """
                INSERT INTO pending_memory_candidates (
                    id, session_id, source_request_id, title, lesson_text, lesson_kind,
                    confidence, source_excerpt, content_fingerprint, category,
                    created_at, updated_at, project_id, origin
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy')
                """,
                (
                    row["id"], row["session_id"], row["source_request_id"], row["title"],
                    row["lesson_text"], map_legacy_kind(row["lesson_kind"]), row["confidence"],
                    row["source_excerpt"], build_text_digest(row["lesson_text"]),
                    row["category"], row["created_at"], row["updated_at"], row["project_id"],
                ),
            )
        except sqlite3.IntegrityError:
            _quarantine(
                connection,
                source_table="pending_memory_candidates",
                row=row,
                reason_code="v9_duplicate_collapsed",
            )
            collapsed += 1
    return collapsed


def migrate_v8_to_v9(
    connection: sqlite3.Connection,
    *,
    checkpoint: Callable[[str], None],
    execute_schema_script: Callable[..., None],
) -> None:
    """Atomically rebuild v8 memory state into the v9 lifecycle schema."""

    try:
        with _transaction(connection):
            highwaters = {
                table: _sequence_highwater(connection, table)
                for table in ("memories", "pending_memory_candidates")
            }
            for trigger in _FTS_TRIGGERS:
                connection.execute(f"DROP TRIGGER IF EXISTS {trigger}")
            connection.execute("DROP TABLE IF EXISTS memory_fts")
            checkpoint("v9_fts_dropped")
            for index in _V8_INDEXES:
                connection.execute(f"DROP INDEX IF EXISTS {index}")
            for table in _REBUILT_TABLES:
                connection.execute(f"ALTER TABLE {table} RENAME TO {table}_v8_source")
            execute_schema_script(connection, v9_schema_script(), version=8)
            checkpoint("v9_schema_created")

            migrated, collapsed = _migrate_approved_rows(connection)
            pending_collapsed = _migrate_pending_rows(connection)
            # v8 suppressions hashed kind + text and cannot be recomputed.
            dropped_row = connection.execute(
                "SELECT COUNT(*) FROM memory_suppressions_v8_source"
            ).fetchone()
            suppressions_dropped = int(dropped_row[0] if dropped_row else 0)
            connection.execute(
                """
                DELETE FROM memory_quarantine
                WHERE id NOT IN (
                    SELECT id FROM memory_quarantine
                    ORDER BY quarantined_at DESC, id DESC
                    LIMIT ?
                )
                """,
                (MAX_QUARANTINE_ROWS,),
            )
            checkpoint("v9_rows_copied")
            for table in _REBUILT_TABLES:
                connection.execute(f"DROP TABLE {table}_v8_source")
            connection.execute("DROP TABLE IF EXISTS memory_extraction_runs")
            for table, highwater in highwaters.items():
                _restore_sequence(connection, table, highwater)
            connection.execute("PRAGMA user_version=9")
            checkpoint("v9_committed")
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(
            CMP_MEMORY_SCHEMA_MIGRATION,
            "failed to migrate memory database to schema v9",
        ) from error
    logger.info(
        "memory_v9_migration_completed migrated=%d collapsed=%d pending_collapsed=%d "
        "suppressions_dropped=%d",
        migrated,
        collapsed,
        pending_collapsed,
        suppressions_dropped,
    )


__all__ = ["migrate_v8_to_v9", "v9_schema_script"]
