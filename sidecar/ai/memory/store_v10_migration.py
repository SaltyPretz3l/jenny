"""Memory schema v10: derived memory vectors and salted recap digests (row 58 W4).

v10 is additive. ``memory_vectors`` holds one embedding per memory row for the
hybrid recall leg; it is derived data the indexer (``memory.embed_step``)
rebuilds at any time. Two triggers keep it honest in the same transaction as
the write that changes a row:

* ``memory_vectors_invalidate`` drops the vector when the row leaves
  ``active`` or its embedded text (title, lesson text, digest) changes;
* ``memory_vectors_delete`` drops it when the row is deleted. The foreign key
  cascades too while ``foreign_keys`` is on (every store connection sets it);
  the trigger covers connections that do not, such as offline tools.

The step also re-keys existing reflection recap rows to the salted recap
digest, so a chat note and its recap with the same text stop colliding on the
active-digest index.
"""

from __future__ import annotations

import logging
import sqlite3
from collections.abc import Callable

from sidecar.ai.error_codes import CMP_MEMORY_SCHEMA_MIGRATION
from sidecar.ai.memory.contracts import recap_text_digest
from sidecar.ai.memory.store_shared import RECAP_PROVENANCE, _transaction
from sidecar.ai.memory.store_v9_migration import v9_schema_script
from sidecar.exceptions import MemoryStoreError

logger = logging.getLogger(__name__)

V10_TABLES = ("memory_vectors",)
V10_TRIGGERS = ("memory_vectors_invalidate", "memory_vectors_delete")


def v10_additions_script() -> str:
    """The v10 DDL on top of a v9 schema."""

    return """
        CREATE TABLE memory_vectors (
            memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
            content_fingerprint TEXT NOT NULL,
            model_key TEXT NOT NULL,
            dim INTEGER NOT NULL,
            norm REAL NOT NULL,
            blob BLOB NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TRIGGER memory_vectors_invalidate
        AFTER UPDATE OF title, lesson_text, status, content_fingerprint ON memories
        WHEN new.status <> 'active'
          OR new.content_fingerprint IS NOT old.content_fingerprint
          OR new.lesson_text IS NOT old.lesson_text
          OR new.title IS NOT old.title
        BEGIN
            DELETE FROM memory_vectors WHERE memory_id = old.id;
        END;
        CREATE TRIGGER memory_vectors_delete
        AFTER DELETE ON memories
        BEGIN
            DELETE FROM memory_vectors WHERE memory_id = old.id;
        END;
    """


def v10_schema_script() -> str:
    """The complete v10 schema for a fresh database."""

    return v9_schema_script() + v10_additions_script()


def _salt_recap_digests(connection: sqlite3.Connection) -> int:
    rows = connection.execute(
        "SELECT id, lesson_text FROM memories WHERE provenance = ?", (RECAP_PROVENANCE,)
    ).fetchall()
    for memory_id, lesson_text in rows:
        connection.execute(
            "UPDATE memories SET content_fingerprint = ? WHERE id = ?",
            (recap_text_digest(lesson_text), int(memory_id)),
        )
    return len(rows)


def migrate_v9_to_v10(
    connection: sqlite3.Connection,
    *,
    checkpoint: Callable[[str], None],
    execute_schema_script: Callable[..., None],
) -> None:
    """Add the vector table and triggers and salt recap digests, atomically."""

    try:
        with _transaction(connection):
            salted = _salt_recap_digests(connection)
            checkpoint("v10_recaps_salted")
            execute_schema_script(connection, v10_additions_script(), version=10)
            checkpoint("v10_schema_created")
    except sqlite3.DatabaseError as error:
        raise MemoryStoreError(
            CMP_MEMORY_SCHEMA_MIGRATION,
            "failed to migrate memory database to schema v10",
        ) from error
    logger.info("memory_v10_migration_completed recaps_salted=%d", salted)


__all__ = [
    "V10_TABLES",
    "V10_TRIGGERS",
    "migrate_v9_to_v10",
    "v10_additions_script",
    "v10_schema_script",
]
