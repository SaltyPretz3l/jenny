"""Schema migration logic for the memory SQLite database."""

from __future__ import annotations

import hashlib
import json
import sqlite3

from sidecar.ai.error_codes import CMP_MEMORY_FAILED, CMP_MEMORY_SCHEMA_MIGRATION
from sidecar.ai.memory.contracts import (
    CONTENT_DIGEST_CHARS,
    MAX_CATEGORY_CHARS,
    MAX_FAMILY_KEY_CHARS,
    MAX_LESSON_TEXT_CHARS,
    MAX_PROVENANCE_CHARS,
    MAX_QUARANTINE_PAYLOAD_CHARS,
    MAX_QUARANTINE_ROWS,
    MAX_REQUEST_ID_CHARS,
    MAX_SESSION_ID_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    MAX_TITLE_CHARS,
    build_content_digest,
    normalize_spaces,
    require_finite_confidence,
)
from sidecar.ai.memory.store_shared import _transaction
from sidecar.exceptions import MemoryStoreError

SCHEMA_VERSION = 7

# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def configure_connection(connection: sqlite3.Connection) -> str:
    """Set WAL journal mode and pragmas. Return the active journal mode."""
    try:
        # Enable incremental auto-vacuum so the purge_old_* sweeps can reclaim
        # freed pages via ``PRAGMA incremental_vacuum``. auto_vacuum is a header
        # setting that only takes effect on a fresh database (before any table is
        # created); this runs before run_migrations, so new databases pick it up
        # while existing ones keep their current mode until a full VACUUM.
        connection.execute("PRAGMA auto_vacuum=INCREMENTAL")
        journal_mode_row = connection.execute("PRAGMA journal_mode=WAL").fetchone()
        journal_mode = journal_mode_row[0] if journal_mode_row else None
        active_mode = str(journal_mode).lower() if journal_mode else "delete"
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA wal_autocheckpoint=1000")
        connection.execute("PRAGMA journal_size_limit=16777216")
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(
            CMP_MEMORY_FAILED,
            "failed to configure memory database",
        ) from error
    return active_mode


def run_migrations(connection: sqlite3.Connection) -> bool:
    """Bring *connection* up to ``SCHEMA_VERSION`` and report whether it changed."""
    try:
        current_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(
            CMP_MEMORY_FAILED,
            "failed to read memory schema version",
        ) from error

    if current_version < 1 or current_version > SCHEMA_VERSION:
        if current_version == 0:
            pass
        else:
            raise MemoryStoreError(
                CMP_MEMORY_SCHEMA_MIGRATION,
                f"unsupported memory schema version {current_version}; expected {SCHEMA_VERSION}",
            )

    initial_version = current_version
    if current_version == SCHEMA_VERSION:
        return False

    migrations = {
        1: _migrate_v1_to_v3,
        2: _migrate_v2_to_v3,
        3: _migrate_v3_to_v4,
        4: _migrate_v4_to_v5,
        5: _migrate_v5_to_v6,
        6: _migrate_v6_to_v7,
    }
    try:
        with _transaction(connection):
            if current_version == 0:
                _migrate_from_empty(connection)
                return True
            while current_version < SCHEMA_VERSION:
                previous_version = current_version
                migration = migrations.get(current_version)
                if migration is None:
                    raise MemoryStoreError(
                        CMP_MEMORY_SCHEMA_MIGRATION,
                        f"unsupported memory schema version {current_version}; expected {SCHEMA_VERSION}",
                    )
                migration(connection)
                current_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
                if current_version <= previous_version:
                    raise MemoryStoreError(
                        CMP_MEMORY_SCHEMA_MIGRATION,
                        f"memory schema migration stalled at version {current_version}",
                    )
        return True
    except BaseException as error:
        rollback_verified = False
        try:
            rollback_verified = (
                not connection.in_transaction
                and int(connection.execute("PRAGMA user_version").fetchone()[0])
                == initial_version
            )
        except sqlite3.DatabaseError:
            rollback_verified = False
        if isinstance(error, MemoryStoreError):
            error.preserved = rollback_verified
        raise
# ---------------------------------------------------------------------------
# Schema DDL
# ---------------------------------------------------------------------------


def v6_schema_script() -> str:
    """Return the full v6 schema DDL (used for fresh databases)."""
    return """
                CREATE TABLE IF NOT EXISTS memory_entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    request_id TEXT NOT NULL,
                    user_content TEXT NOT NULL,
                    assistant_content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_memory_entries_created_at
                  ON memory_entries(created_at DESC);

                CREATE INDEX IF NOT EXISTS idx_memory_entries_retention
                  ON memory_entries(created_at ASC, id ASC);

                CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    lesson_text TEXT NOT NULL,
                    lesson_kind TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    source_excerpt TEXT NOT NULL DEFAULT '',
                    content_fingerprint TEXT NOT NULL,
                    family_key TEXT NOT NULL DEFAULT '',
                    provenance TEXT NOT NULL DEFAULT 'unknown_legacy',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_fingerprint
                  ON memories(content_fingerprint);

                CREATE INDEX IF NOT EXISTS idx_memories_updated_at
                  ON memories(updated_at DESC);

                CREATE INDEX IF NOT EXISTS idx_memories_updated_id
                  ON memories(updated_at DESC, id DESC);

                CREATE INDEX IF NOT EXISTS idx_memories_kind_updated
                  ON memories(lesson_kind, updated_at DESC, id DESC);

                CREATE INDEX IF NOT EXISTS idx_memories_session_updated
                  ON memories(session_id, updated_at DESC, id DESC);

                CREATE TABLE IF NOT EXISTS memory_extraction_runs (
                    session_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (session_id, request_id)
                );

                CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_created
                  ON memory_extraction_runs(created_at ASC, session_id, request_id);

                CREATE TABLE IF NOT EXISTS pending_memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    source_request_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    lesson_text TEXT NOT NULL,
                    lesson_kind TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    source_excerpt TEXT NOT NULL DEFAULT '',
                    content_fingerprint TEXT NOT NULL,
                    family_key TEXT NOT NULL DEFAULT '',
                    category TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_memory_session_fingerprint
                  ON pending_memory_candidates(session_id, content_fingerprint);

                CREATE INDEX IF NOT EXISTS idx_pending_memory_session_updated
                  ON pending_memory_candidates(session_id, updated_at DESC);

                CREATE INDEX IF NOT EXISTS idx_pending_memory_updated_id
                  ON pending_memory_candidates(updated_at DESC, id DESC);
                """


def v7_schema_script() -> str:
    """Return the full v7 schema DDL for a new memory database."""

    return f"""
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND {MAX_TITLE_CHARS}),
            lesson_text TEXT NOT NULL CHECK(length(lesson_text) BETWEEN 1 AND {MAX_LESSON_TEXT_CHARS}),
            lesson_kind TEXT NOT NULL CHECK(length(lesson_kind) BETWEEN 1 AND {MAX_CATEGORY_CHARS}),
            confidence REAL NOT NULL CHECK(typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0.0 AND 1.0),
            source_excerpt TEXT NOT NULL DEFAULT '' CHECK(length(source_excerpt) <= {MAX_SOURCE_EXCERPT_CHARS}),
            content_fingerprint TEXT NOT NULL UNIQUE CHECK(
                length(content_fingerprint) = {CONTENT_DIGEST_CHARS}
                AND substr(content_fingerprint, 1, 7) = 'sha256:'
                AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
            ),
            family_key TEXT NOT NULL DEFAULT '' CHECK(length(family_key) <= {MAX_FAMILY_KEY_CHARS}),
            provenance TEXT NOT NULL DEFAULT 'unknown_legacy' CHECK(length(provenance) BETWEEN 1 AND {MAX_PROVENANCE_CHARS}),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX idx_memories_updated_at ON memories(updated_at DESC);
        CREATE INDEX idx_memories_updated_id ON memories(updated_at DESC, id DESC);
        CREATE INDEX idx_memories_kind_updated ON memories(lesson_kind, updated_at DESC, id DESC);
        CREATE INDEX idx_memories_session_updated ON memories(session_id, updated_at DESC, id DESC);

        CREATE TABLE memory_extraction_runs (
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
            request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND {MAX_REQUEST_ID_CHARS}),
            status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('in_progress', 'completed', 'failed')),
            attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count BETWEEN 0 AND 3),
            started_at TEXT,
            completed_at TEXT,
            failure_code TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, request_id)
        );
        CREATE INDEX idx_memory_extraction_runs_created
          ON memory_extraction_runs(created_at ASC, session_id, request_id);

        CREATE TABLE pending_memory_candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
            source_request_id TEXT NOT NULL CHECK(length(source_request_id) BETWEEN 1 AND {MAX_REQUEST_ID_CHARS}),
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND {MAX_TITLE_CHARS}),
            lesson_text TEXT NOT NULL CHECK(length(lesson_text) BETWEEN 1 AND {MAX_LESSON_TEXT_CHARS}),
            lesson_kind TEXT NOT NULL CHECK(length(lesson_kind) BETWEEN 1 AND {MAX_CATEGORY_CHARS}),
            confidence REAL NOT NULL CHECK(typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0.0 AND 1.0),
            source_excerpt TEXT NOT NULL DEFAULT '' CHECK(length(source_excerpt) <= {MAX_SOURCE_EXCERPT_CHARS}),
            content_fingerprint TEXT NOT NULL CHECK(
                length(content_fingerprint) = {CONTENT_DIGEST_CHARS}
                AND substr(content_fingerprint, 1, 7) = 'sha256:'
                AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
            ),
            family_key TEXT NOT NULL DEFAULT '' CHECK(length(family_key) <= {MAX_FAMILY_KEY_CHARS}),
            category TEXT NOT NULL DEFAULT '' CHECK(length(category) <= {MAX_CATEGORY_CHARS}),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(session_id, content_fingerprint)
        );
        CREATE INDEX idx_pending_memory_session_updated
          ON pending_memory_candidates(session_id, updated_at DESC);
        CREATE INDEX idx_pending_memory_updated_id
          ON pending_memory_candidates(updated_at DESC, id DESC);

        CREATE TABLE memory_suppressions (
            content_fingerprint TEXT PRIMARY KEY CHECK(
                length(content_fingerprint) = {CONTENT_DIGEST_CHARS}
                AND substr(content_fingerprint, 1, 7) = 'sha256:'
                AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
            ),
            reason TEXT NOT NULL CHECK(reason IN ('forgotten', 'dismissed')),
            created_at TEXT NOT NULL
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


# ---------------------------------------------------------------------------
# Family-key migration helper (v2 -> v3)
# ---------------------------------------------------------------------------


def migrate_v2_family_key(
    *,
    lesson_kind: str,
    title: str,
    lesson_text: str,
    content_fingerprint: str,
) -> str:
    """Derive a ``family_key`` for a pre-v3 memory row."""
    normalized_kind = str(lesson_kind or "").strip().lower()
    normalized_title = str(title or "").strip().lower()
    normalized_lesson_text = str(lesson_text or "").strip().lower()
    normalized_fingerprint = str(content_fingerprint or "").strip().lower()

    if normalized_kind == "tool_strategy":
        fingerprint_map = {
            "tool_strategy:for-repository-text-search-tasks-prefer-rg-ripgrep-when-it-is-available": "ripgrep",
            "tool_strategy:prefer-apply-patch-for-small-manual-file-edits-when-practical": "apply_patch",
            "tool_strategy:do-not-run-tests-unless-the-user-explicitly-asks-for-them": "skip_tests",
            "tool_strategy:keep-changes-small-and-reviewable": "small_diffs",
            "tool_strategy:plan-the-approach-before-implementing-non-trivial-work": "plan_first",
        }
        return fingerprint_map.get(normalized_fingerprint, "")

    if normalized_kind == "working_preference":
        working_text_map = {
            "diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.": "diagnose_root_cause_first",
            "keep external api calls behind a service layer so retries, caching, and provider swaps stay localized.": "service_layer_external_apis",
            "treat schema changes as migrations with explicit upgrade intent.": "schema_changes_are_migrations",
            "prioritize observability with structured logs, request ids, and appropriate log levels.": "prioritize_observability",
            "clarify ambiguous scope before implementation; ask clarifying questions only when the answer materially changes the outcome.": "clarify_scope_first",
            "when following a plan document, update it after the task or batch is completed.": "update_plan_docs_after_completion",
        }
        return working_text_map.get(normalized_lesson_text, "")

    if normalized_kind == "project_context":
        project_text_map = {
            "this workspace has no .git metadata, so branch and status information are unavailable.": "workspace_has_no_git_metadata",
            "electron owns canonical conversation history and persistence.": "electron_owns_canonical_history",
            "the sidecar is stateless per request.": "sidecar_stateless_per_request",
            "approved memories are stored canonically in the sidecar sqlite database only.": "approved_memories_sidecar_sqlite_only",
            "do not introduce a vector database for memory; keep recall deterministic and cheap.": "no_vector_db",
            "tools remain blocked until a workspace root is explicitly configured.": "tools_require_workspace_root",
            "do not reopen feature f unless it is required for the current task.": "do_not_reopen_feature_f",
        }
        if normalized_lesson_text in project_text_map:
            return project_text_map[normalized_lesson_text]
        if normalized_title == "project context: electron owns canonical history":
            return "electron_owns_canonical_history"
        if normalized_title == "project context: approved memories live in sidecar sqlite":
            return "approved_memories_sidecar_sqlite_only"
        return ""

    return ""


# ---------------------------------------------------------------------------
# Internal step functions
# ---------------------------------------------------------------------------


def _migrate_from_empty(connection: sqlite3.Connection) -> None:
    try:
        _execute_schema_script(connection, v7_schema_script(), version=SCHEMA_VERSION)
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to migrate memory database") from error


def _migration_checkpoint(_stage: str) -> None:
    """Fault-injection seam for proving v7's transaction is all-or-nothing."""


def _migrate_v1_to_v3(connection: sqlite3.Connection) -> None:
    try:
        _execute_schema_script(
            connection,
            """
                CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    lesson_text TEXT NOT NULL,
                    lesson_kind TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    source_excerpt TEXT NOT NULL DEFAULT '',
                    content_fingerprint TEXT NOT NULL,
                    family_key TEXT NOT NULL DEFAULT '',
                    provenance TEXT NOT NULL DEFAULT 'unknown_legacy',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_fingerprint
                  ON memories(content_fingerprint);

                CREATE INDEX IF NOT EXISTS idx_memories_updated_at
                  ON memories(updated_at DESC);
            """,
            version=3,
        )
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to migrate memory database") from error


def _migrate_v2_to_v3(connection: sqlite3.Connection) -> None:
    try:
        with _transaction(connection):
            existing_columns = [
                row[1] for row in connection.execute("PRAGMA table_info(memories)").fetchall()
            ]
            if "family_key" not in existing_columns:
                connection.execute(
                    "ALTER TABLE memories ADD COLUMN family_key TEXT NOT NULL DEFAULT ''"
                )
            if "provenance" not in existing_columns:
                connection.execute(
                    "ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'unknown_legacy'"
                )
            rows = connection.execute(
                """
                SELECT id, lesson_kind, title, lesson_text, content_fingerprint
                FROM memories
                """
            ).fetchall()
            for row in rows:
                family_key = migrate_v2_family_key(
                    lesson_kind=str(row[1]),
                    title=str(row[2]),
                    lesson_text=str(row[3]),
                    content_fingerprint=str(row[4]),
                )
                connection.execute(
                    "UPDATE memories SET family_key = ? WHERE id = ?",
                    (family_key, int(row[0])),
                )
            connection.execute("PRAGMA user_version=3")
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to migrate memory database") from error


def _migrate_v3_to_v4(connection: sqlite3.Connection) -> None:
    try:
        with _transaction(connection):
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS memory_extraction_runs (
                    session_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (session_id, request_id)
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS pending_memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    source_request_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    lesson_text TEXT NOT NULL,
                    lesson_kind TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    source_excerpt TEXT NOT NULL DEFAULT '',
                    content_fingerprint TEXT NOT NULL,
                    family_key TEXT NOT NULL DEFAULT '',
                    category TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_memory_session_fingerprint
                ON pending_memory_candidates(session_id, content_fingerprint)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_pending_memory_session_updated
                ON pending_memory_candidates(session_id, updated_at DESC)
                """
            )
            existing_columns = [
                row[1] for row in connection.execute("PRAGMA table_info(memories)").fetchall()
            ]
            if "provenance" not in existing_columns:
                connection.execute(
                    "ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'unknown_legacy'"
                )
            connection.execute("PRAGMA user_version=4")
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to migrate memory database") from error


def _migrate_v4_to_v5(connection: sqlite3.Connection) -> None:
    try:
        with _transaction(connection):
            existing_columns = [
                row[1] for row in connection.execute("PRAGMA table_info(memories)").fetchall()
            ]
            if "provenance" not in existing_columns:
                connection.execute(
                    "ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'unknown_legacy'"
                )
            connection.execute(
                """
                UPDATE memories
                SET provenance = 'unknown_legacy'
                WHERE provenance IS NULL OR TRIM(provenance) = ''
                """
            )
            connection.execute("PRAGMA user_version=5")
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to migrate memory database") from error


def _migrate_v5_to_v6(connection: sqlite3.Connection) -> None:
    try:
        _execute_schema_script(connection, v6_schema_script(), version=6)
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to migrate memory database") from error


def _execute_schema_script(
    connection: sqlite3.Connection,
    script: str,
    *,
    version: int,
) -> None:
    """Execute complete SQL statements without ``executescript``'s implicit commit."""

    with _transaction(connection):
        statement_lines: list[str] = []
        for line in script.splitlines():
            statement_lines.append(line)
            candidate = "\n".join(statement_lines).strip()
            if not candidate or not sqlite3.complete_statement(candidate):
                continue
            connection.execute(candidate)
            statement_lines.clear()
        if "\n".join(statement_lines).strip():
            raise sqlite3.OperationalError("incomplete memory migration statement")
        connection.execute(f"PRAGMA user_version={int(version)}")


def _quarantine_row(
    connection: sqlite3.Connection,
    *,
    source_table: str,
    row: sqlite3.Row | tuple[object, ...],
    reason_code: str,
) -> None:
    values = list(row)
    source_row_id = str(values[0]) if values else ""
    row_digest = hashlib.sha256(
        json.dumps(values, ensure_ascii=False, default=str).encode("utf-8", errors="replace")
    ).hexdigest()
    raw_payload = json.dumps(
        {
            "row_digest": f"sha256:{row_digest}",
            "value_count": len(values),
            "value_types": [type(value).__name__ for value in values[:32]],
        },
        ensure_ascii=False,
        allow_nan=False,
    )[:MAX_QUARANTINE_PAYLOAD_CHARS]
    connection.execute(
        """
        INSERT INTO memory_quarantine (
            source_table, source_row_id, reason_code, raw_payload
        ) VALUES (?, ?, ?, ?)
        """,
        (source_table[:64], source_row_id[:64], reason_code[:64], raw_payload),
    )
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


def _migrate_v6_to_v7(  # noqa: C901, PLR0912, PLR0915 - one atomic rebuild.
    connection: sqlite3.Connection,
) -> None:
    """Rebuild user-facing rows with bounded contracts and hashed identities."""

    try:
        with _transaction(connection):
            connection.execute(
                f"""
                CREATE TABLE memory_quarantine (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_table TEXT NOT NULL
                        CHECK(length(source_table) BETWEEN 1 AND 64),
                    source_row_id TEXT NOT NULL DEFAULT ''
                        CHECK(length(source_row_id) <= 64),
                    reason_code TEXT NOT NULL
                        CHECK(length(reason_code) BETWEEN 1 AND 64),
                    raw_payload TEXT NOT NULL
                        CHECK(length(raw_payload) <= {MAX_QUARANTINE_PAYLOAD_CHARS}),
                    quarantined_at TEXT NOT NULL DEFAULT (
                        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    )
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX idx_memory_quarantine_created
                ON memory_quarantine(quarantined_at DESC, id DESC)
                """
            )
            _migration_checkpoint("quarantine_schema")
            connection.execute(
                f"""
                CREATE TABLE memories_v7 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL
                        CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
                    title TEXT NOT NULL
                        CHECK(length(title) BETWEEN 1 AND {MAX_TITLE_CHARS}),
                    lesson_text TEXT NOT NULL
                        CHECK(length(lesson_text) BETWEEN 1 AND {MAX_LESSON_TEXT_CHARS}),
                    lesson_kind TEXT NOT NULL
                        CHECK(length(lesson_kind) BETWEEN 1 AND {MAX_CATEGORY_CHARS}),
                    confidence REAL NOT NULL
                        CHECK(typeof(confidence) IN ('real', 'integer')
                              AND confidence BETWEEN 0.0 AND 1.0),
                    source_excerpt TEXT NOT NULL DEFAULT ''
                        CHECK(length(source_excerpt) <= {MAX_SOURCE_EXCERPT_CHARS}),
                    content_fingerprint TEXT NOT NULL UNIQUE CHECK(
                        length(content_fingerprint) = {CONTENT_DIGEST_CHARS}
                        AND substr(content_fingerprint, 1, 7) = 'sha256:'
                        AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
                    ),
                    family_key TEXT NOT NULL DEFAULT ''
                        CHECK(length(family_key) <= {MAX_FAMILY_KEY_CHARS}),
                    provenance TEXT NOT NULL DEFAULT 'unknown_legacy'
                        CHECK(length(provenance) BETWEEN 1 AND {MAX_PROVENANCE_CHARS}),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            approved_rows = connection.execute(
                """
                SELECT id, session_id, title, lesson_text, lesson_kind, confidence,
                       source_excerpt, content_fingerprint, family_key, provenance,
                       created_at, updated_at
                FROM memories
                ORDER BY updated_at DESC, id DESC
                """
            ).fetchall()
            for row in approved_rows:
                try:
                    confidence = require_finite_confidence(row[5])
                    session_id = normalize_spaces(row[1])
                    title = normalize_spaces(row[2])
                    lesson_text = normalize_spaces(row[3])
                    lesson_kind = normalize_spaces(row[4]).lower()
                    source_excerpt = normalize_spaces(row[6])
                    family_key = normalize_spaces(row[8])
                    provenance = normalize_spaces(row[9]) or "unknown_legacy"
                    if not session_id or len(session_id) > MAX_SESSION_ID_CHARS:
                        raise ValueError("invalid session_id")
                    if not title or len(title) > MAX_TITLE_CHARS:
                        raise ValueError("invalid title")
                    if not lesson_text or len(lesson_text) > MAX_LESSON_TEXT_CHARS:
                        raise ValueError("invalid lesson_text")
                    if not lesson_kind or len(lesson_kind) > MAX_CATEGORY_CHARS:
                        raise ValueError("invalid lesson_kind")
                    if len(source_excerpt) > MAX_SOURCE_EXCERPT_CHARS:
                        raise ValueError("invalid source_excerpt")
                    if len(family_key) > MAX_FAMILY_KEY_CHARS:
                        raise ValueError("invalid family_key")
                    if len(provenance) > MAX_PROVENANCE_CHARS:
                        raise ValueError("invalid provenance")
                    digest = build_content_digest(lesson_kind, lesson_text)
                    connection.execute(
                        """
                        INSERT INTO memories_v7 (
                            id, session_id, title, lesson_text, lesson_kind,
                            confidence, source_excerpt, content_fingerprint,
                            family_key, provenance, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            int(row[0]), session_id, title, lesson_text, lesson_kind,
                            confidence, source_excerpt, digest, family_key, provenance,
                            str(row[10]), str(row[11]),
                        ),
                    )
                except (ValueError, TypeError, sqlite3.IntegrityError):
                    _quarantine_row(
                        connection,
                        source_table="memories",
                        row=row,
                        reason_code="invalid_or_duplicate_v7_row",
                    )

            _migration_checkpoint("approved_rows")
            connection.execute(
                f"""
                CREATE TABLE pending_memory_candidates_v7 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL
                        CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
                    source_request_id TEXT NOT NULL
                        CHECK(length(source_request_id) BETWEEN 1 AND {MAX_REQUEST_ID_CHARS}),
                    title TEXT NOT NULL
                        CHECK(length(title) BETWEEN 1 AND {MAX_TITLE_CHARS}),
                    lesson_text TEXT NOT NULL
                        CHECK(length(lesson_text) BETWEEN 1 AND {MAX_LESSON_TEXT_CHARS}),
                    lesson_kind TEXT NOT NULL
                        CHECK(length(lesson_kind) BETWEEN 1 AND {MAX_CATEGORY_CHARS}),
                    confidence REAL NOT NULL
                        CHECK(typeof(confidence) IN ('real', 'integer')
                              AND confidence BETWEEN 0.0 AND 1.0),
                    source_excerpt TEXT NOT NULL DEFAULT ''
                        CHECK(length(source_excerpt) <= {MAX_SOURCE_EXCERPT_CHARS}),
                    content_fingerprint TEXT NOT NULL CHECK(
                        length(content_fingerprint) = {CONTENT_DIGEST_CHARS}
                        AND substr(content_fingerprint, 1, 7) = 'sha256:'
                        AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
                    ),
                    family_key TEXT NOT NULL DEFAULT ''
                        CHECK(length(family_key) <= {MAX_FAMILY_KEY_CHARS}),
                    category TEXT NOT NULL DEFAULT ''
                        CHECK(length(category) <= {MAX_CATEGORY_CHARS}),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(session_id, content_fingerprint)
                )
                """
            )
            pending_rows = connection.execute(
                """
                SELECT id, session_id, source_request_id, title, lesson_text,
                       lesson_kind, confidence, source_excerpt, content_fingerprint,
                       family_key, category, created_at, updated_at
                FROM pending_memory_candidates
                ORDER BY updated_at DESC, id DESC
                """
            ).fetchall()
            for row in pending_rows:
                try:
                    confidence = require_finite_confidence(row[6])
                    session_id = normalize_spaces(row[1])
                    request_id = normalize_spaces(row[2])
                    title = normalize_spaces(row[3])
                    lesson_text = normalize_spaces(row[4])
                    lesson_kind = normalize_spaces(row[5]).lower()
                    source_excerpt = normalize_spaces(row[7])
                    family_key = normalize_spaces(row[9])
                    category = normalize_spaces(row[10])
                    if not session_id or len(session_id) > MAX_SESSION_ID_CHARS:
                        raise ValueError("invalid session_id")
                    if not request_id or len(request_id) > MAX_REQUEST_ID_CHARS:
                        raise ValueError("invalid source_request_id")
                    if not title or len(title) > MAX_TITLE_CHARS:
                        raise ValueError("invalid title")
                    if not lesson_text or len(lesson_text) > MAX_LESSON_TEXT_CHARS:
                        raise ValueError("invalid lesson_text")
                    if not lesson_kind or len(lesson_kind) > MAX_CATEGORY_CHARS:
                        raise ValueError("invalid lesson_kind")
                    if len(source_excerpt) > MAX_SOURCE_EXCERPT_CHARS:
                        raise ValueError("invalid source_excerpt")
                    if len(family_key) > MAX_FAMILY_KEY_CHARS:
                        raise ValueError("invalid family_key")
                    if len(category) > MAX_CATEGORY_CHARS:
                        raise ValueError("invalid category")
                    digest = build_content_digest(lesson_kind, lesson_text)
                    connection.execute(
                        """
                        INSERT INTO pending_memory_candidates_v7 (
                            id, session_id, source_request_id, title, lesson_text,
                            lesson_kind, confidence, source_excerpt,
                            content_fingerprint, family_key, category,
                            created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            int(row[0]), session_id, request_id, title, lesson_text,
                            lesson_kind, confidence, source_excerpt, digest,
                            family_key, category, str(row[11]), str(row[12]),
                        ),
                    )
                except (ValueError, TypeError, sqlite3.IntegrityError):
                    _quarantine_row(
                        connection,
                        source_table="pending_memory_candidates",
                        row=row,
                        reason_code="invalid_or_duplicate_v7_row",
                    )

            _migration_checkpoint("pending_rows")
            connection.execute("DROP TABLE memories")
            connection.execute("ALTER TABLE memories_v7 RENAME TO memories")
            connection.execute("DROP TABLE pending_memory_candidates")
            connection.execute(
                "ALTER TABLE pending_memory_candidates_v7 RENAME TO pending_memory_candidates"
            )
            connection.execute(
                "CREATE INDEX idx_memories_updated_at ON memories(updated_at DESC)"
            )
            connection.execute(
                "CREATE INDEX idx_memories_updated_id ON memories(updated_at DESC, id DESC)"
            )
            connection.execute(
                """
                CREATE INDEX idx_memories_kind_updated
                ON memories(lesson_kind, updated_at DESC, id DESC)
                """
            )
            connection.execute(
                """
                CREATE INDEX idx_memories_session_updated
                ON memories(session_id, updated_at DESC, id DESC)
                """
            )
            connection.execute(
                """
                CREATE INDEX idx_pending_memory_session_updated
                ON pending_memory_candidates(session_id, updated_at DESC)
                """
            )
            connection.execute(
                """
                CREATE INDEX idx_pending_memory_updated_id
                ON pending_memory_candidates(updated_at DESC, id DESC)
                """
            )
            _migration_checkpoint("bounded_tables")
            connection.execute(
                f"""
                CREATE TABLE memory_suppressions (
                    content_fingerprint TEXT PRIMARY KEY CHECK(
                        length(content_fingerprint) = {CONTENT_DIGEST_CHARS}
                        AND substr(content_fingerprint, 1, 7) = 'sha256:'
                        AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
                    ),
                    reason TEXT NOT NULL CHECK(reason IN ('forgotten', 'dismissed')),
                    created_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                f"""
                CREATE TABLE memory_extraction_runs_v7 (
                    session_id TEXT NOT NULL
                        CHECK(length(session_id) BETWEEN 1 AND {MAX_SESSION_ID_CHARS}),
                    request_id TEXT NOT NULL
                        CHECK(length(request_id) BETWEEN 1 AND {MAX_REQUEST_ID_CHARS}),
                    status TEXT NOT NULL DEFAULT 'completed'
                        CHECK(status IN ('in_progress', 'completed', 'failed')),
                    attempt_count INTEGER NOT NULL DEFAULT 1
                        CHECK(attempt_count BETWEEN 0 AND 3),
                    started_at TEXT,
                    completed_at TEXT,
                    failure_code TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (session_id, request_id)
                )
                """
            )
            _migration_checkpoint("suppressions")
            extraction_rows = connection.execute(
                """
                SELECT session_id, request_id, created_at
                FROM memory_extraction_runs
                """
            ).fetchall()
            for row in extraction_rows:
                session_id = normalize_spaces(row[0])
                request_id = normalize_spaces(row[1])
                created_at = str(row[2])
                if (
                    not session_id
                    or len(session_id) > MAX_SESSION_ID_CHARS
                    or not request_id
                    or len(request_id) > MAX_REQUEST_ID_CHARS
                ):
                    _quarantine_row(
                        connection,
                        source_table="memory_extraction_runs",
                        row=row,
                        reason_code="invalid_v7_identity",
                    )
                    continue
                connection.execute(
                    """
                    INSERT INTO memory_extraction_runs_v7 (
                        session_id, request_id, status, attempt_count,
                        started_at, completed_at, failure_code,
                        created_at, updated_at
                    ) VALUES (?, ?, 'completed', 1, ?, ?, '', ?, ?)
                    """,
                    (
                        session_id,
                        request_id,
                        created_at,
                        created_at,
                        created_at,
                        created_at,
                    ),
                )
            connection.execute("DROP TABLE memory_extraction_runs")
            connection.execute(
                "ALTER TABLE memory_extraction_runs_v7 RENAME TO memory_extraction_runs"
            )
            connection.execute(
                """
                CREATE INDEX idx_memory_extraction_runs_created
                ON memory_extraction_runs(created_at ASC, session_id, request_id)
                """
            )
            _migration_checkpoint("extraction_leases")
            connection.execute("DROP TABLE IF EXISTS memory_entries")
            _migration_checkpoint("raw_exchange_purge")
            connection.execute("PRAGMA user_version=7")
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(
            CMP_MEMORY_SCHEMA_MIGRATION,
            "failed to migrate memory database to schema v7",
        ) from error
