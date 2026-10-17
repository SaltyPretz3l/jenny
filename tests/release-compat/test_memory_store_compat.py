"""Phase 12B / A.B.6: Python memory-store release-gate compatibility test.

Each fixture is a SQL script under ``tests/release-compat/fixtures/memory-v<N>/``
that materializes a legacy memory database at a specific schema version.
The test materializes the script into a temp DB, opens a :class:`MemoryStore`
(which triggers the migration cascade in
``sidecar/ai/memory/store_migrations.py``), and asserts:

* PRAGMA user_version is bumped to :data:`SCHEMA_VERSION` (currently 10)
* legacy data survives the migration
* version-specific invariants hold (e.g. v4 → v5 normalizes empty provenance
  to ``unknown_legacy``; v8 → v9 maps kinds, collapses text duplicates and
  drops ``family_key`` and the extraction-run table; v9 -> v10 adds the
  ``memory_vectors`` table and salts recap digests)

The fixtures share the format documented in
``tests/release-compat/README.md``. To add a new schema version, drop a
``memory-v<N>/sidecar-memory.sql`` script under ``fixtures/`` and add a
test function below.

Run with::

    pytest tests/release-compat/test_memory_store_compat.py -v
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import pytest

from sidecar.ai.memory import store_migrations
from sidecar.ai.memory.contracts import build_text_digest, recap_text_digest
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


def test_memory_compat_empty_database_initializes_to_v9(tmp_path: Path) -> None:
    """A bare DB at user_version=0 migrates to the full v9 schema."""
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-empty", db_path)
    assert _read_user_version(db_path) == 0

    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
        for table in (
            "memories",
            "pending_memory_candidates",
            "memory_suppressions",
            "memory_quarantine",
            "memory_operations",
            "memory_reflection_cursor",
            "memory_project_state",
            "memory_session_markers",
        ):
            cols = _table_columns(db_path, table)
            assert cols, f"table '{table}' missing after empty -> v9 migration"
            if table in ("memories", "pending_memory_candidates", "memory_suppressions"):
                assert "project_id" in cols
        assert not _table_columns(db_path, "memory_extraction_runs")
        assert store.get_all_memories() == []
    finally:
        store.close()


def test_memory_compat_v1_purges_raw_entries_and_creates_current_tables(
    tmp_path: Path,
) -> None:
    """v1 -> current: legacy raw exchanges are purged and approved schema lands."""
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
            "provenance",
            "origin",
            "status",
        } <= memories_columns
        assert "family_key" not in memories_columns
    finally:
        store.close()


def test_memory_compat_v2_projects_canonical_family_key_for_known_fingerprint(
    tmp_path: Path,
) -> None:
    """v2 -> v9: the v2 tool-strategy row survives as a v9 lesson (family_key is gone)."""
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v2", db_path)
    assert _read_user_version(db_path) == 2  # noqa: PLR2004  # asserting the fixture's pinned pre-migration version.

    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
        memories = store.get_all_memories()
        assert len(memories) == 1
        memory = memories[0]
        # v3 projected the canonical "prefer ripgrep" family; v9 dropped the
        # family column and maps tool_strategy to lesson.
        assert not hasattr(memory, "family_key")
        assert memory.lesson_kind == "lesson"
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
        for table in ("pending_memory_candidates", "memory_operations"):
            cols = _table_columns(db_path, table)
            assert cols, f"table '{table}' missing after v3 -> v9 migration"
        memories = store.get_all_memories()
        assert len(memories) == 1
        # The v3 fixture row had provenance='structured_user_pin'; the v3->v4
        # migration must not clobber a non-empty provenance.
        assert memories[0].provenance == "structured_user_pin"
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
            build_text_digest("The user prefers concise answers.")
        ]
        assert {
            "idx_memories_active_digest",
            "idx_memories_project_status_updated",
            "idx_memories_project_status_kind_updated",
            "idx_memories_project_scope_status",
            "idx_pending_memory_project_updated",
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
        assert memories[0].content_fingerprint == build_text_digest("Use concise answers.")
        status = store.status_snapshot()
        assert status["operational_counts"]["quarantined"] == 1
        # The v6 extraction run survived v7/v8; the v9 rebuild drops the table.
        assert not _table_columns(db_path, "memory_extraction_runs")
    finally:
        store.close()


def test_memory_compat_v8_maps_kinds_collapses_duplicates_and_drops_legacy_state(
    tmp_path: Path,
) -> None:
    """v8 -> v9: kinds map, text twins collapse, legacy suppressions and runs drop."""
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v8", db_path)
    assert _read_user_version(db_path) == 8  # noqa: PLR2004

    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION == 10  # noqa: PLR2004
        connection = store._connection
        rows = connection.execute(
            "SELECT id, lesson_kind, origin, status, content_fingerprint "
            "FROM memories ORDER BY id"
        ).fetchall()
        assert [(row[0], row[1], row[2], row[3]) for row in rows] == [
            (2, "preference", "user", "active"),
            (6, "preference", "user", "active"),
            (8, "lesson", "legacy", "active"),
            (10, "person", "legacy", "active"),
        ]
        assert rows[0][4] == build_text_digest("The user prefers green tea.")
        quarantine = connection.execute(
            "SELECT source_row_id, reason_code, raw_payload FROM memory_quarantine"
        ).fetchall()
        assert [(row[0], row[1]) for row in quarantine] == [("4", "v9_duplicate_collapsed")]
        assert json.loads(quarantine[0][2])["lesson_kind"] == "profile"
        assert connection.execute("SELECT COUNT(*) FROM memory_suppressions").fetchone() == (0,)
        assert connection.execute(
            "SELECT id, lesson_kind, origin FROM pending_memory_candidates"
        ).fetchall() == [(3, "preference", "legacy")]
        assert connection.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'memories'"
        ).fetchone() == (30,)
        assert not _table_columns(db_path, "memory_extraction_runs")
        assert "family_key" not in _table_columns(db_path, "memories")
        recalled = store.recall_memories("ripgrep", limit=3, project_id="project_alpha")
        assert [memory.id for memory in recalled] == [8]
    finally:
        store.close()

    reopened = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
        assert len(reopened.get_all_memories()) == 2  # noqa: PLR2004
    finally:
        reopened.close()


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
        "memory-v8",
        "memory-v9",
    ],
)
def test_memory_compat_every_fixture_lands_at_current_schema(
    fixture_dir: str, tmp_path: Path
) -> None:
    """Backstop assertion: every fixture, regardless of starting version, ends at v9."""
    db_path = tmp_path / f"memory-{fixture_dir}.db"
    _materialize_db(fixture_dir, db_path)
    store = MemoryStore(db_path)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
    finally:
        store.close()


def _names(db_path: Path, kind: str) -> set[str]:
    connection = sqlite3.connect(str(db_path))
    try:
        return {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = ?", (kind,)
            ).fetchall()
        }
    finally:
        connection.close()


def test_memory_compat_v9_adds_vectors_keeps_rows_and_salts_the_recap(tmp_path: Path) -> None:
    """v9 -> v10: rows, ledger and cursor survive; the recap digest is salted."""
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v9", db_path)
    assert _read_user_version(db_path) == 9  # noqa: PLR2004

    # Test migration at the fixture's capture time. The ordinary startup
    # maintenance expires its operation receipts after their retry window.
    captured_at = datetime(2026, 10, 14, 12, tzinfo=UTC)
    store = MemoryStore(db_path, clock=lambda: captured_at)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION == 10  # noqa: PLR2004
        connection = store._connection
        rows = connection.execute(
            "SELECT id, status, provenance, content_fingerprint, lesson_text "
            "FROM memories ORDER BY id"
        ).fetchall()
        assert [(row[0], row[1]) for row in rows] == [
            (1, "active"), (2, "active"), (3, "active"), (4, "archived"), (5, "active"),
            (6, "active"),
        ]
        for _id, _status, provenance, fingerprint, text in rows:
            expected = (
                recap_text_digest(text) if provenance == "reflection_recap"
                else build_text_digest(text)
            )
            assert fingerprint == expected
        assert rows[5][2] == "reflection_recap"
        assert "memory_vectors" in _names(db_path, "table")
        assert {"memory_vectors_invalidate", "memory_vectors_delete"} <= _names(db_path, "trigger")
        assert connection.execute("SELECT COUNT(*) FROM memory_vectors").fetchone() == (0,)
        assert connection.execute("SELECT COUNT(*) FROM memory_operations").fetchone() == (7,)
        assert connection.execute("SELECT COUNT(*) FROM memory_suppressions").fetchone() == (1,)
        assert connection.execute(
            "SELECT COUNT(*) FROM memory_reflection_cursor"
        ).fetchone() == (1,)
        recalled = store.recall_memories(
            "staging cluster", limit=3, project_id="project_alpha", scope_session_id="chat-v9"
        )
        assert [memory.id for memory in recalled] == [3]
        note = store.remember(
            operation_id="op-v10-note", project_id="project_alpha",
            text="A chat about the staging cluster.", kind="fact", origin="jenny",
            session_id="chat-v9", scope_session_id="chat-v9",
        )
        assert note.status == "saved" and note.duplicate is False
    finally:
        store.close()

    reopened = MemoryStore(db_path, clock=lambda: captured_at)
    try:
        assert _read_user_version(db_path) == SCHEMA_VERSION
    finally:
        reopened.close()


@pytest.mark.parametrize("stage", ["v10_recaps_salted", "v10_schema_created"])
def test_v10_migration_fault_rolls_back_to_intact_v9(
    stage: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "memory.db"
    _materialize_db("memory-v9", db_path)

    def _fail_at_stage(current: str) -> None:
        if current == stage:
            raise RuntimeError(f"injected migration failure at {stage}")

    monkeypatch.setattr(store_migrations, "_migration_checkpoint", _fail_at_stage)
    with pytest.raises(RuntimeError, match="injected migration failure"):
        MemoryStore(db_path)

    assert _read_user_version(db_path) == 9  # noqa: PLR2004
    assert "memory_vectors" not in _names(db_path, "table")
    connection = sqlite3.connect(str(db_path))
    try:
        recap = connection.execute(
            "SELECT content_fingerprint, lesson_text FROM memories WHERE id = 6"
        ).fetchone()
        assert recap[0] == build_text_digest(recap[1])
    finally:
        connection.close()
