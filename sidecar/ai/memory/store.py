"""SQLite memory store for sidecar request-scoped recall."""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

from sidecar.ai.error_codes import (
    CMP_MEMORY_CAPACITY_EXCEEDED,
    CMP_MEMORY_FAILED,
    CMP_MEMORY_ROW_QUARANTINED,
)
from sidecar.ai.memory.contracts import (
    MAX_QUARANTINE_PAYLOAD_CHARS,
    MAX_QUARANTINE_ROWS,
)
from sidecar.ai.memory.store_approved import _ApprovedMemoriesMixin
from sidecar.ai.memory.store_bootstrap import (
    SCHEMA_VERSION as SCHEMA_VERSION,
)
from sidecar.ai.memory.store_bootstrap import (
    configure_connection,
    run_migrations,
    validate_memory_store_files,
)
from sidecar.ai.memory.store_pending import _PendingCandidatesMixin
from sidecar.ai.memory.store_shared import (
    MEMORY_MAINTENANCE_MUTATION_INTERVAL,
    MEMORY_MAINTENANCE_SECONDS,
    MEMORY_RETENTION_DELETE_BATCH,
    MEMORY_RETENTION_MAX_AGE_DAYS,
    MEMORY_RETENTION_MAX_DB_BYTES,
    MEMORY_RETENTION_MAX_ROWS_PER_TABLE,
    _locked,
    _transaction,
)
from sidecar.ai.memory.store_shared import (
    ApprovedMemory as ApprovedMemory,
)
from sidecar.ai.memory.store_shared import (
    PendingMemoryCandidate as PendingMemoryCandidate,
)
from sidecar.exceptions import MemoryStoreError

logger = logging.getLogger(__name__)

_RETENTION_TABLES = (
    ("memory_extraction_runs", "created_at"),
    ("pending_memory_candidates", "updated_at"),
)

class MemoryStore(_PendingCandidatesMixin, _ApprovedMemoriesMixin):
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._lock = threading.RLock()
        self._successful_mutations = 0
        self._last_maintenance_monotonic = time.monotonic()
        try:
            validate_memory_store_files(db_path, schema_version=SCHEMA_VERSION)
        except MemoryStoreError as error:
            error.preserved = True
            raise
        db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            str(db_path),
            timeout=10.0,
            check_same_thread=False,
        )
        self._connection = connection
        try:
            self._journal_mode = configure_connection(connection)
            migrated = run_migrations(connection)
            self._recall_index_available = self._ensure_recall_index(rebuild=migrated)
            self._last_recall_partial = False
            self._run_due_maintenance(force=True, apply_age_retention=not migrated)
        except BaseException:
            try:
                connection.close()
            except sqlite3.DatabaseError:
                logger.warning("%s memory_initialization_cleanup_failed", CMP_MEMORY_FAILED)
            raise

    @property
    def db_path(self) -> Path:
        return self._db_path

    @property
    def journal_mode(self) -> str:
        return self._journal_mode

    def close(self) -> None:
        self._connection.close()

    @contextmanager
    def _write_transaction(self) -> Iterator[None]:
        with _transaction(self._connection):
            yield
        self._record_successful_mutation()

    def _record_successful_mutation(self) -> None:
        self._successful_mutations += 1
        self._run_due_maintenance()

    def _run_due_maintenance(
        self,
        *,
        force: bool = False,
        apply_age_retention: bool = True,
    ) -> None:
        now = time.monotonic()
        due = (
            force
            or self._successful_mutations >= MEMORY_MAINTENANCE_MUTATION_INTERVAL
            or now - self._last_maintenance_monotonic >= MEMORY_MAINTENANCE_SECONDS
        )
        if not due:
            return
        reason = (
            "startup"
            if force
            else "mutation_count"
            if self._successful_mutations >= MEMORY_MAINTENANCE_MUTATION_INTERVAL
            else "elapsed_time"
        )
        try:
            report = self._perform_maintenance(
                max_age_days=MEMORY_RETENTION_MAX_AGE_DAYS,
                max_rows_per_table=MEMORY_RETENTION_MAX_ROWS_PER_TABLE,
                max_db_bytes=MEMORY_RETENTION_MAX_DB_BYTES,
                apply_age_retention=apply_age_retention,
            )
        except (sqlite3.DatabaseError, MemoryStoreError) as error:
            logger.warning(
                "%s memory_maintenance_failed reason=%s error_type=%s",
                CMP_MEMORY_FAILED,
                reason,
                type(error).__name__,
            )
            return
        self._successful_mutations = 0
        self._last_maintenance_monotonic = now
        logger.info(
            "memory_maintenance_completed reason=%s removed=%s active_bytes=%d",
            reason,
            report["removed"],
            report["active_bytes"],
        )

    def _perform_maintenance(
        self,
        *,
        max_age_days: int,
        max_rows_per_table: int,
        max_db_bytes: int,
        apply_age_retention: bool,
    ) -> dict[str, object]:
        safe_age_days = max(1, int(max_age_days))
        safe_rows = max(1, int(max_rows_per_table))
        safe_db_bytes = max(1, int(max_db_bytes))
        cutoff = (datetime.now(timezone.utc) - timedelta(days=safe_age_days)).isoformat()
        removed = {table: 0 for table, _timestamp in _RETENTION_TABLES}
        try:
            with _transaction(self._connection):
                if apply_age_retention:
                    for table, timestamp_column in _RETENTION_TABLES:
                        cursor = self._connection.execute(
                            f"""
                            DELETE FROM {table}
                            WHERE rowid IN (
                                SELECT rowid FROM {table}
                                WHERE {timestamp_column} < ?
                                ORDER BY {timestamp_column} ASC, rowid ASC
                                LIMIT ?
                            )
                            """,
                            (cutoff, MEMORY_RETENTION_DELETE_BATCH),
                        )
                        removed[table] += max(0, int(cursor.rowcount or 0))

                for table, timestamp_column in _RETENTION_TABLES:
                    row = self._connection.execute(
                        f"SELECT COUNT(*) FROM {table}"
                    ).fetchone()
                    excess = min(
                        MEMORY_RETENTION_DELETE_BATCH,
                        max(0, int(row[0] if row else 0) - safe_rows),
                    )
                    if excess <= 0:
                        continue
                    cursor = self._connection.execute(
                        f"""
                        DELETE FROM {table}
                        WHERE rowid IN (
                            SELECT rowid
                            FROM {table}
                            ORDER BY {timestamp_column} ASC, rowid ASC
                            LIMIT ?
                        )
                        """,
                        (excess,),
                    )
                    removed[table] += max(0, int(cursor.rowcount or 0))

                if self._database_physical_bytes() > safe_db_bytes:
                    for table, timestamp_column in _RETENTION_TABLES:
                        cursor = self._connection.execute(
                            f"""
                            DELETE FROM {table}
                            WHERE rowid IN (
                                SELECT rowid
                                FROM {table}
                                ORDER BY {timestamp_column} ASC, rowid ASC
                                LIMIT ?
                            )
                            """,
                            (MEMORY_RETENTION_DELETE_BATCH,),
                        )
                        removed[table] += max(0, int(cursor.rowcount or 0))
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED,
                "failed to maintain memory database",
            ) from error

        self._checkpoint_and_vacuum()
        try:
            active_bytes = self._database_live_bytes()
            physical_bytes = self._database_physical_bytes()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED,
                "failed to inspect memory database after maintenance",
            ) from error
        return {
            "removed": removed,
            "active_bytes": active_bytes,
            "physical_bytes": physical_bytes,
        }

    def _database_physical_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(f"{self._db_path}{suffix}")
            try:
                total += candidate.stat().st_size
            except OSError:
                continue
        return total

    def _quarantine_malformed_row(
        self,
        *,
        source_table: str,
        row: sqlite3.Row | tuple[object, ...],
        reason_code: str,
    ) -> None:
        values = list(row)
        material = json.dumps(values, default=repr, ensure_ascii=False).encode(
            "utf-8", errors="replace"
        )
        metadata = json.dumps(
            {
                "payload_digest": f"sha256:{hashlib.sha256(material).hexdigest()}",
                "column_types": [type(value).__name__[:32] for value in values[:32]],
            },
            separators=(",", ":"),
        )[:MAX_QUARANTINE_PAYLOAD_CHARS]
        row_id = str(values[0] if values else "")[:64]

        def _insert() -> None:
            self._connection.execute(
                """
                INSERT INTO memory_quarantine (
                    source_table, source_row_id, reason_code, raw_payload
                ) VALUES (?, ?, ?, ?)
                """,
                (source_table[:64], row_id, reason_code[:64], metadata),
            )
            self._connection.execute(
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
            if source_table in {"memories", "pending_memory_candidates"}:
                self._connection.execute(
                    f"DELETE FROM {source_table} WHERE id = ?",  # noqa: S608
                    (row_id,),
                )

        try:
            if self._connection.in_transaction:
                _insert()
            else:
                with _transaction(self._connection):
                    _insert()
        except sqlite3.DatabaseError:
            logger.warning(
                "%s memory_row_quarantine_failed source_table=%s",
                CMP_MEMORY_ROW_QUARANTINED,
                source_table[:64],
            )
            return
        logger.warning(
            "%s memory_row_quarantined source_table=%s",
            CMP_MEMORY_ROW_QUARANTINED,
            source_table[:64],
        )

    def _assert_capacity_for_growth(self) -> None:
        if self._database_physical_bytes() <= MEMORY_RETENTION_MAX_DB_BYTES:
            return
        raise MemoryStoreError(
            CMP_MEMORY_CAPACITY_EXCEEDED,
            "memory storage capacity is exhausted; remove derived or approved memory first",
            retryable=True,
        )

    def _prepare_capacity_for_growth(self) -> None:
        """Run one bounded derived-data sweep before a pressured growth decision."""

        if self._database_physical_bytes() <= MEMORY_RETENTION_MAX_DB_BYTES:
            return
        try:
            report = self._perform_maintenance(
                max_age_days=MEMORY_RETENTION_MAX_AGE_DAYS,
                max_rows_per_table=MEMORY_RETENTION_MAX_ROWS_PER_TABLE,
                max_db_bytes=MEMORY_RETENTION_MAX_DB_BYTES,
                apply_age_retention=True,
            )
        except (sqlite3.DatabaseError, MemoryStoreError) as error:
            logger.warning(
                "%s memory_capacity_cleanup_failed error_type=%s",
                CMP_MEMORY_FAILED,
                type(error).__name__,
            )
            return
        self._successful_mutations = 0
        self._last_maintenance_monotonic = time.monotonic()
        logger.info(
            "memory_capacity_cleanup_completed removed=%s physical_bytes=%d",
            report["removed"],
            report["physical_bytes"],
        )

    def _ensure_recall_index(self, *, rebuild: bool) -> bool:
        try:
            existing_index = self._connection.execute(
                "SELECT 1 FROM sqlite_master WHERE name = 'memory_fts' LIMIT 1"
            ).fetchone()
            with _transaction(self._connection):
                self._connection.execute(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                        title,
                        lesson_text,
                        source_excerpt,
                        content='memories',
                        content_rowid='id'
                    )
                    """
                )
                self._connection.execute(
                    """
                    CREATE TRIGGER IF NOT EXISTS memory_fts_insert
                    AFTER INSERT ON memories BEGIN
                        INSERT INTO memory_fts(rowid, title, lesson_text, source_excerpt)
                        VALUES (new.id, new.title, new.lesson_text, new.source_excerpt);
                    END
                    """
                )
                self._connection.execute(
                    """
                    CREATE TRIGGER IF NOT EXISTS memory_fts_delete
                    AFTER DELETE ON memories BEGIN
                        INSERT INTO memory_fts(
                            memory_fts, rowid, title, lesson_text, source_excerpt
                        ) VALUES (
                            'delete', old.id, old.title, old.lesson_text, old.source_excerpt
                        );
                    END
                    """
                )
                self._connection.execute(
                    """
                    CREATE TRIGGER IF NOT EXISTS memory_fts_update
                    AFTER UPDATE ON memories BEGIN
                        INSERT INTO memory_fts(
                            memory_fts, rowid, title, lesson_text, source_excerpt
                        ) VALUES (
                            'delete', old.id, old.title, old.lesson_text, old.source_excerpt
                        );
                        INSERT INTO memory_fts(rowid, title, lesson_text, source_excerpt)
                        VALUES (new.id, new.title, new.lesson_text, new.source_excerpt);
                    END
                    """
                )
                if rebuild or existing_index is None:
                    self._connection.execute(
                        "INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')"
                    )
            return True
        except sqlite3.DatabaseError:
            if self._connection.in_transaction:
                self._connection.rollback()
            logger.warning("memory_recall_index_unavailable error_type=DatabaseError")
            return False

    def _database_live_bytes(self) -> int:
        page_size_row = self._connection.execute("PRAGMA page_size").fetchone()
        page_count_row = self._connection.execute("PRAGMA page_count").fetchone()
        free_count_row = self._connection.execute("PRAGMA freelist_count").fetchone()
        page_size = int(page_size_row[0] if page_size_row else 0)
        page_count = int(page_count_row[0] if page_count_row else 0)
        free_count = int(free_count_row[0] if free_count_row else 0)
        return max(0, page_count - free_count) * max(0, page_size)

    def _checkpoint_and_vacuum(self) -> None:
        try:
            checkpoint = self._connection.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
            if checkpoint and int(checkpoint[0] or 0) > 0:
                logger.warning("%s memory_checkpoint_busy", CMP_MEMORY_FAILED)
            self._connection.execute("PRAGMA incremental_vacuum")
        except sqlite3.DatabaseError:
            logger.warning("%s memory_reclamation_failed", CMP_MEMORY_FAILED)

    @_locked
    def status_snapshot(self) -> dict[str, object]:
        counts = {}
        for table, key in (
            ("memories", "approved"),
            ("pending_memory_candidates", "pending"),
            ("memory_suppressions", "suppressions"),
            ("memory_quarantine", "quarantined"),
        ):
            row = self._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
            counts[key] = int(row[0] if row else 0)
        physical_bytes = self._database_physical_bytes()
        return {
            "available": True,
            "schema_version": SCHEMA_VERSION,
            "recall_index": "fts5" if self._recall_index_available else "bounded_scan",
            "recall_partial": bool(self._last_recall_partial),
            "counts": counts,
            "storage": {
                "physical_bytes": physical_bytes,
                "capacity_bytes": MEMORY_RETENTION_MAX_DB_BYTES,
                "state": (
                    "blocked"
                    if physical_bytes > MEMORY_RETENTION_MAX_DB_BYTES
                    else "ok"
                ),
            },
            "maintenance": {
                "pending_mutations": self._successful_mutations,
                "seconds_since_last_run": round(
                    max(time.monotonic() - self._last_maintenance_monotonic, 0.0),
                    3,
                ),
            },
        }

    @_locked
    def is_memory_suppressed(self, content_fingerprint: str) -> bool:
        row = self._connection.execute(
            """
            SELECT 1 FROM memory_suppressions
            WHERE content_fingerprint = ? LIMIT 1
            """,
            (str(content_fingerprint or "").strip().lower(),),
        ).fetchone()
        return bool(row)
