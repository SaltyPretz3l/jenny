"""Schema migrations for the tool-output omission SQLite store.

Mirrors ``sidecar/ai/memory/store_migrations.py``: pragmas are applied by
``configure_connection`` *before* ``run_migrations`` (auto_vacuum is a header
setting that only takes on a fresh database), and version dispatch is a
branching ``if version == N`` chain, not a ``while`` loop. v1 is the only schema
so far.
"""

from __future__ import annotations

import sqlite3

SCHEMA_VERSION = 1


def configure_connection(connection: sqlite3.Connection) -> str:
    """Set WAL journal mode and durability pragmas. Return the active mode.

    Runs before ``run_migrations`` so a fresh database picks up
    ``auto_vacuum=INCREMENTAL`` (a header setting) before any table exists.
    """
    connection.execute("PRAGMA auto_vacuum=INCREMENTAL")
    journal_mode_row = connection.execute("PRAGMA journal_mode=WAL").fetchone()
    journal_mode = journal_mode_row[0] if journal_mode_row else None
    active_mode = str(journal_mode).lower() if journal_mode else "delete"
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA synchronous=NORMAL")
    return active_mode


def run_migrations(connection: sqlite3.Connection) -> None:
    """Bring *connection* up to ``SCHEMA_VERSION`` (branching dispatch)."""
    current_version = int(connection.execute("PRAGMA user_version").fetchone()[0])

    if current_version == 0:
        _migrate_to_v1_from_empty(connection)
        return

    if current_version != SCHEMA_VERSION:
        raise RuntimeError(
            f"unsupported omission store schema version {current_version}; "
            f"expected {SCHEMA_VERSION}"
        )


def _migrate_to_v1_from_empty(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS omissions (
            ref TEXT PRIMARY KEY,
            content BLOB NOT NULL,
            source TEXT NOT NULL,
            created_at REAL NOT NULL,
            original_tokens INTEGER,
            kept_tokens INTEGER,
            access_count INTEGER DEFAULT 0
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_omissions_created ON omissions(created_at)"
    )
    connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    connection.commit()
