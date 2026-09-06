"""Phase 12B / A.B.6: Python memory-store release-gate compatibility test.

Each fixture is a SQL script under ``tests/release-compat/fixtures/memory-v<N>/``
that materializes a legacy memory database at a specific schema version.
The test materializes the script into a temp DB, opens a :class:`MemoryStore`
(which triggers the migration cascade in
``sidecar/ai/memory/store_migrations.py``), and asserts:

* PRAGMA user_version is bumped to :data:`SCHEMA_VERSION` (currently 7)
* legacy data survives the migration
* version-specific invariants hold (e.g. v2 → v3 fingerprint -> family_key
  mapping fires; v4 → v5 normalizes empty provenance to ``unknown_legacy``)

The fixtures share the format documented in
``tests/release-compat/README.md``. To add a new schema version, drop a
``memory-v<N>/sidecar-memory.sql`` script under ``fixtures/`` and add a
test function below.

Run with::

    pytest tests/release-compat/test_memory_store_compat.py -v
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from sidecar.ai.memory import store_migrations
from sidecar.ai.memory.contracts import build_content_digest
from sidecar.ai.memory.store import SCHEMA_VERSION, MemoryStore

FIXTURES_ROOT = Path(__file__).resolve().parent / "fixtures"


def _materialize_db(fixture_dir: str, db_path: Path) -> None:
    sql_path = FIXTURES_ROOT / fixture_dir / "sidecar-memory.sql"
    assert sql_path.exists(), f"fixture script missing: {sql_path}"
    script = sql_path.read_text(encoding="utf-8")
    connection = sqlite3.connect(str(db_path))
    try:
        connection.executescript(script)
        connection.commit()
    finally:
        connection.close()


def _read_user_version(db_path: Path) -> int:
    connection = sqlite3.connect(str(db_path))
    try:
        return int(connection.execute("PRAGMA user_version").fetchone()[0])
    finally:
        connection.close()


def _table_columns(db_path: Path, table: str) -> set[str]:
    connection = sqlite3.connect(str(db_path))
    try:
        return {row[1] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
    finally:
        connection.close()


def _index_names(db_path: Path) -> set[str]:
    connection = sqlite3.connect(str(db_path))
    try:
        return {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }
    finally:
        connection.close()


def test_memory_compat_empty_database_initializes_to_v7(tmp_path: Path) -> None:
    """A bare DB at user_version=0 migrates to the full v7 schema."""
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-empty", db_path)
    assert _read_user_version(db_path) == 0

    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
        for table in (
            "memories",
            "memory_extraction_runs",
            "pending_memory_candidates",
            "memory_suppressions",
            "memory_quarantine",
        ):
            cols = _table_columns(db_path, table)
            assert cols, f"table '{table}' missing after empty -> v6 migration"
        assert store.get_all_memories() == []
    finally:
        store.close()


def test_memory_compat_v1_purges_raw_entries_and_creates_v7_tables(
    tmp_path: Path,
) -> None:
    """v1 -> v7: legacy raw exchanges are purged and approved schema lands."""
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v1", db_path)
    assert _read_user_version(db_path) == 1

    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
        assert not _table_columns(db_path, "memory_entries")

        memories_columns = _table_columns(db_path, "memories")
        assert {
            "session_id",
            "title",
            "content_fingerprint",
            "family_key",
            "provenance",
        } <= memories_columns
    finally:
        store.close()


def test_memory_compat_v2_projects_canonical_family_key_for_known_fingerprint(
    tmp_path: Path,
) -> None:
    """v2 -> v6: migrate_v2_family_key resolves the canonical fingerprint mapping."""
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v2", db_path)
    assert _read_user_version(db_path) == 2  # noqa: PLR2004  # asserting the fixture's pinned pre-migration version.

    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
        memories = store.get_all_memories()
        assert len(memories) == 1
        memory = memories[0]
        # The seeded fingerprint is the canonical "prefer ripgrep" lesson;
        # migrate_v2_family_key projects it to family_key='ripgrep'.
        assert memory.family_key == "ripgrep"
        assert memory.lesson_kind == "tool_strategy"
        # provenance defaults to 'unknown_legacy' when the column was added
        # by the migration (no value was set in the v2 fixture).
        assert memory.provenance == "unknown_legacy"
    finally:
        store.close()


def test_memory_compat_v3_creates_v4_tables(tmp_path: Path) -> None:
    """v3 -> v6: the v4-introduced tables (extraction runs, pending candidates) appear."""
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v3", db_path)
    assert _read_user_version(db_path) == 3  # noqa: PLR2004  # asserting the fixture's pinned pre-migration version.

    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
        for table in ("memory_extraction_runs", "pending_memory_candidates"):
            cols = _table_columns(db_path, table)
            assert cols, f"table '{table}' missing after v3 -> v6 migration"
        memories = store.get_all_memories()
        assert len(memories) == 1
        # The v3 fixture row had provenance='structured_user_pin'; the v3->v4
        # migration must not clobber a non-empty provenance.
        assert memories[0].provenance == "structured_user_pin"
        assert memories[0].family_key == "diagnose_root_cause_first"
    finally:
        store.close()


def test_memory_compat_v4_normalizes_empty_provenance(tmp_path: Path) -> None:
    """v4 -> v5: rows with empty/NULL provenance get the 'unknown_legacy' default."""
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v4", db_path)
    assert _read_user_version(db_path) == 4  # noqa: PLR2004  # asserting the fixture's pinned pre-migration version.

    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
        memories = store.get_all_memories()
        assert len(memories) == 1
        # The v4 fixture pinned provenance=''; v4->v5 normalizes that to
        # 'unknown_legacy' so downstream consumers always see a populated
        # provenance value.
        assert memories[0].provenance == "unknown_legacy"
        assert memories[0].family_key == "electron_owns_canonical_history"
    finally:
        store.close()


def test_memory_compat_v5_adds_retention_indexes_without_dropping_rows(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v5", db_path)
    assert _read_user_version(db_path) == 5  # noqa: PLR2004

    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
        memories = store.get_all_memories()
        assert [memory.content_fingerprint for memory in memories] == [
            build_content_digest("preference", "The user prefers concise answers.")
        ]
        assert {
            "idx_memories_updated_id",
            "idx_memories_kind_updated",
            "idx_memories_session_updated",
            "idx_memory_extraction_runs_created",
            "idx_pending_memory_updated_id",
        } <= _index_names(db_path)
    finally:
        store.close()


def test_memory_compat_v6_hashes_identities_quarantines_collision_and_purges_raw(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v6", db_path)

    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
        assert not _table_columns(db_path, "memory_entries")
        memories = store.get_all_memories()
        assert len(memories) == 1
        assert memories[0].content_fingerprint == build_content_digest(
            "response_style", "Use concise answers."
        )
        status = store.status_snapshot()
        assert status["counts"]["quarantined"] == 1
        assert store._connection.execute(  # noqa: SLF001
            """
            SELECT status FROM memory_extraction_runs
            WHERE session_id = ? AND request_id = ?
            """,
            ("session-v6", "request-v6"),
        ).fetchone() == ("completed",)
    finally:
        store.close()


@pytest.mark.parametrize(
    "stage",
    [
        "quarantine_schema",
        "approved_rows",
        "pending_rows",
        "bounded_tables",
        "suppressions",
        "extraction_leases",
        "raw_exchange_purge",
    ],
)
def test_v7_migration_fault_rolls_back_to_intact_v6(
    stage: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v6", db_path)

    def _fail_at_stage(current: str) -> None:
        if current == stage:
            raise RuntimeError(f"injected migration failure at {stage}")

    monkeypatch.setattr(store_migrations, "_migration_checkpoint", _fail_at_stage)
    with pytest.raises(RuntimeError, match="injected migration failure"):
        MemoryStore(db_path)

    assert _read_user_version(db_path) == 6  # noqa: PLR2004
    connection = sqlite3.connect(str(db_path))
    try:
        assert connection.execute("SELECT COUNT(*) FROM memories").fetchone()[0] == 2  # noqa: PLR2004
        assert connection.execute("SELECT COUNT(*) FROM memory_entries").fetchone()[0] == 1
        assert connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'memory_quarantine'"
        ).fetchone() is None
    finally:
        connection.close()


def test_multi_version_migration_fault_rolls_back_to_original_v5(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v5", db_path)

    def _fail_at_v7(current: str) -> None:
        if current == "quarantine_schema":
            raise RuntimeError("injected migration failure after v6")

    monkeypatch.setattr(store_migrations, "_migration_checkpoint", _fail_at_v7)
    with pytest.raises(RuntimeError, match="injected migration failure after v6"):
        MemoryStore(db_path)

    assert _read_user_version(db_path) == 5  # noqa: PLR2004
    connection = sqlite3.connect(str(db_path))
    try:
        assert connection.execute("SELECT COUNT(*) FROM memories").fetchone()[0] == 1
        assert connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'memory_quarantine'"
        ).fetchone() is None
        assert "idx_memories_updated_id" not in _index_names(db_path)
    finally:
        connection.close()


@pytest.mark.parametrize(
    "fixture_dir",
    [
        "memory-empty",
        "memory-v1",
        "memory-v2",
        "memory-v3",
        "memory-v4",
        "memory-v5",
        "memory-v6",
    ],
)
def test_memory_compat_every_fixture_lands_at_current_schema(
    fixture_dir: str, tmp_path: Path
) -> None:
    """Backstop assertion: every fixture, regardless of starting version, ends at v7."""
    db_path = tmp_path / f"memory-{fixture_dir}.db"
    _materialize_db(fixture_dir, db_path)
    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
    finally:
        store.close()
