"""Persistence fault injection for the memory store (matrix rows M1-M3, M7-M11).

Crash rows run ``store_fault_child.py`` in a child interpreter that dies with
``os._exit(137)`` at a marked step. Damage rows edit the closed database file.
M4-M6 (bad header, bad WAL, future version) live in ``test_store_preflight.py``.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, MAX_MEMORY_PAGE_SIZE
from sidecar.ai.memory.store import SCHEMA_VERSION, MemoryStore
from sidecar.ai.memory.store_migrations import run_migrations
from sidecar.ai.memory.unavailable import UnavailableMemoryStore, open_memory_store
from sidecar.exceptions import MemoryStoreError
from tests.sidecar.ai.memory.memory_v9_helpers import PROJECT, remember
from tests.sidecar.ai.memory.store_fault_child import CRASH_EXIT_CODE, memory_text

REPO_ROOT = Path(__file__).resolve().parents[4]
CHILD = Path(__file__).with_name("store_fault_child.py")
BULK_TEXT = "Bulk fixture memory {index:03d} " + "likes green tea and long walks. " * 7 + "End."


# --- helpers ---------------------------------------------------------------


def _run_child(
    mode: str, db_path: Path, count: int
) -> tuple[subprocess.CompletedProcess[str], list[int]]:
    env = {**os.environ, "PYTHONPATH": str(REPO_ROOT)}
    result = subprocess.run(
        [sys.executable, str(CHILD), mode, str(db_path), str(count)],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    acked = [
        int(line.split()[1]) for line in result.stdout.splitlines() if line.startswith("ack ")
    ]
    return result, acked


def _raw(db_path: Path, sql: str) -> list[tuple]:
    connection = sqlite3.connect(str(db_path))
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


def _memory_texts(db_path: Path) -> list[str]:
    return sorted(str(row[0]) for row in _raw(db_path, "SELECT lesson_text FROM memories"))


def _store_texts(store: MemoryStore, project_id: str = PROJECT) -> list[str]:
    texts: list[str] = []
    cursor: str | None = None
    while True:
        rows, cursor = store.list_active(
            project_id=project_id,
            include_general=False,
            cursor=cursor,
            limit=MAX_MEMORY_PAGE_SIZE,
        )
        texts.extend(row.lesson_text for row in rows)
        if cursor is None:
            return sorted(texts)


def _save_bulk(db_path: Path, count: int) -> list[str]:
    texts = [BULK_TEXT.format(index=index) for index in range(count)]
    store = MemoryStore(db_path)
    try:
        for text in texts:
            remember(store, text)
    finally:
        store.close()
    return sorted(texts)


def _read_header_pages(data: bytes) -> tuple[int, int]:
    page_size = int.from_bytes(data[16:18], "big")
    return (65_536 if page_size == 1 else page_size), int.from_bytes(data[28:32], "big")


def _table_leaf_pages(data: bytes, page_size: int, root_page: int) -> list[int]:
    """Leaf page numbers of one table b-tree, by walking interior cells."""

    def page_bytes(number: int) -> bytes:
        start = (number - 1) * page_size
        return data[start : start + page_size]

    leaves: list[int] = []
    stack = [root_page]
    while stack:
        number = stack.pop()
        page = page_bytes(number)
        base = 100 if number == 1 else 0
        flag = page[base]
        if flag == 0x0D:
            leaves.append(number)
            continue
        assert flag == 0x05, f"unexpected b-tree page flag {flag:#x} on page {number}"
        cell_count = int.from_bytes(page[base + 3 : base + 5], "big")
        stack.append(int.from_bytes(page[base + 8 : base + 12], "big"))
        for cell in range(cell_count):
            pointer = int.from_bytes(page[base + 12 + 2 * cell : base + 14 + 2 * cell], "big")
            stack.append(int.from_bytes(page[pointer : pointer + 4], "big"))
    return sorted(leaves)


def _memories_leaf_pages(db_path: Path) -> tuple[bytes, int, list[int]]:
    data = db_path.read_bytes()
    root = int(_raw(db_path, "SELECT rootpage FROM sqlite_master WHERE name = 'memories'")[0][0])
    page_size, _ = _read_header_pages(data)
    return data, page_size, _table_leaf_pages(data, page_size, root)


def _assert_degrades_or_serves(
    db_path: Path, expected_texts: list[str], *, damaged_bytes: bytes
) -> MemoryStore | UnavailableMemoryStore:
    """No exception escapes ``open_memory_store``; every outcome is typed."""

    opened = open_memory_store(db_path)
    try:
        if isinstance(opened, UnavailableMemoryStore):
            assert opened.available is False
            assert opened.status_payload()["repair_required"] is True
            assert db_path.read_bytes() == damaged_bytes
            with pytest.raises(MemoryStoreError):
                opened.list_active(project_id=PROJECT)
            return opened
        # Working store: the intact rows must be readable. A store that reports
        # itself available but cannot serve a read is neither of the two contracts.
        try:
            served = _store_texts(opened)
        except MemoryStoreError as error:
            pytest.fail(f"store opened as available but its read failed: {error}")
        missing = set(expected_texts) - set(served)
        assert len(missing) <= 1, f"more than the damaged row lost: {sorted(missing)[:3]}"
        return opened
    finally:
        opened.close()
        # Whatever the outcome, no data page of the damaged file is rewritten; an
        # opened store may only advance the page-1 header change counters.
        after = db_path.read_bytes()
        page_size, _ = _read_header_pages(damaged_bytes)
        assert len(after) == len(damaged_bytes)
        assert after[page_size:] == damaged_bytes[page_size:], "a data page was rewritten"


# --- M1 / M2 / M3: crash rows ---------------------------------------------


def test_m1_kill_after_acknowledged_saves_keeps_every_acked_memory(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"

    result, acked = _run_child("saves", db_path, 6)

    assert result.returncode == CRASH_EXIT_CODE, result.stderr
    assert acked == list(range(6))
    assert Path(f"{db_path}-wal").exists(), "the kill must leave a WAL behind"
    store = MemoryStore(db_path)
    try:
        assert _store_texts(store) == sorted(memory_text(index) for index in acked)
        assert store.journal_mode == "wal"
    finally:
        store.close()


def test_m2_kill_inside_a_write_before_commit_drops_only_that_memory(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"

    result, acked = _run_child("crash_before_commit", db_path, 3)

    assert result.returncode == CRASH_EXIT_CODE, result.stderr
    assert acked == [0, 1, 2]
    store = MemoryStore(db_path)
    try:
        texts = _store_texts(store)
        assert texts == sorted(memory_text(index) for index in acked)
        assert memory_text(3) not in texts
        assert _memory_texts(db_path) == texts
    finally:
        store.close()


def _downgrade_to_v9(db_path: Path) -> None:
    """Strip the v10 additions from a current store, leaving a v9 database."""

    connection = sqlite3.connect(str(db_path))
    try:
        connection.execute("DROP TRIGGER memory_vectors_invalidate")
        connection.execute("DROP TRIGGER memory_vectors_delete")
        connection.execute("DROP TABLE memory_vectors")
        connection.execute("PRAGMA user_version=9")
        connection.commit()
    finally:
        connection.close()


def test_m3_kill_inside_the_v9_to_v10_migration_leaves_v9_and_remigrates(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "memory.db"
    expected = sorted(memory_text(index) for index in range(4))
    store = MemoryStore(db_path)
    try:
        for index in range(4):
            remember(store, memory_text(index))
    finally:
        store.close()
    _downgrade_to_v9(db_path)
    assert _raw(db_path, "PRAGMA user_version") == [(9,)]

    result, _acked = _run_child("crash_in_v10_migration", db_path, 0)

    assert result.returncode == CRASH_EXIT_CODE, result.stderr
    # Raw sqlite3 read: the aborted migration committed nothing.
    assert _raw(db_path, "PRAGMA user_version") == [(9,)]
    assert _memory_texts(db_path) == expected
    assert _raw(db_path, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'memory_vectors'") == [
        (0,)
    ]

    store = MemoryStore(db_path)
    try:
        assert _raw(db_path, "PRAGMA user_version") == [(SCHEMA_VERSION,)]
        assert _store_texts(store) == expected
    finally:
        store.close()
    assert _raw(db_path, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'memory_vectors'") == [
        (1,)
    ]


# --- M7 / M8: damaged main file -------------------------------------------


@pytest.mark.parametrize("damage", ["content_byte", "cell_pointer"])
def test_m7_flipped_byte_in_a_memory_page_degrades_without_rewriting(
    damage: str, tmp_path: Path
) -> None:
    db_path = tmp_path / "memory.db"
    expected = _save_bulk(db_path, 60)
    assert not Path(f"{db_path}-wal").exists(), "close must checkpoint into the main file"
    data, page_size, leaves = _memories_leaf_pages(db_path)
    assert len(leaves) >= 3, "the fixture must span several pages"
    target = leaves[len(leaves) // 2]
    page_start = (target - 1) * page_size
    damaged = bytearray(data)
    if damage == "content_byte":
        # Middle of the page body: lands inside a memory row's text.
        damaged[page_start + page_size // 2] ^= 0xFF
    else:
        # Structural: the first cell pointer now points past the end of the page.
        damaged[page_start + 8 : page_start + 10] = (0xFFFF).to_bytes(2, "big")
    db_path.write_bytes(bytes(damaged))

    _assert_degrades_or_serves(db_path, expected, damaged_bytes=bytes(damaged))


def test_m8_file_truncated_short_of_its_header_page_count_degrades(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    expected = _save_bulk(db_path, 60)
    data = db_path.read_bytes()
    page_size, page_count = _read_header_pages(data)
    assert page_count * page_size == len(data) and page_count >= 6
    truncated = data[: (page_count // 2) * page_size]
    db_path.write_bytes(truncated)

    _assert_degrades_or_serves(db_path, expected, damaged_bytes=truncated)


# --- M9: no-op reopen ------------------------------------------------------


def test_m9_reopening_a_current_store_runs_no_migration(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    expected = _save_bulk(db_path, 5)
    schema_sql = "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"
    schema_before = _raw(db_path, schema_sql)
    rows_before = _raw(db_path, "SELECT * FROM memories ORDER BY id")
    assert _raw(db_path, "PRAGMA user_version") == [(SCHEMA_VERSION,)]
    bytes_before = db_path.read_bytes()

    store = MemoryStore(db_path)
    try:
        assert run_migrations(store._connection) is False
        assert _store_texts(store) == expected
    finally:
        store.close()

    assert _raw(db_path, "PRAGMA user_version") == [(SCHEMA_VERSION,)]
    assert _raw(db_path, schema_sql) == schema_before
    assert _raw(db_path, "SELECT * FROM memories ORDER BY id") == rows_before
    assert not Path(f"{db_path}-wal").exists()
    # Finding: the startup maintenance pass commits a (row-less) write transaction,
    # so a no-op reopen is not byte-identical. Only the page-1 header change
    # counter (offset 24) and version-valid-for (offset 92) move; every row and
    # every page after the first is untouched.
    after = db_path.read_bytes()
    assert len(after) == len(bytes_before)
    page_size, _ = _read_header_pages(bytes_before)
    assert after[page_size:] == bytes_before[page_size:]
    changed = {offset for offset in range(page_size) if after[offset] != bytes_before[offset]}
    assert changed <= set(range(24, 28)) | set(range(92, 96))
    assert int.from_bytes(after[24:28], "big") > int.from_bytes(bytes_before[24:28], "big")


# --- M10: oldest schema ----------------------------------------------------


def _create_v1_db(db_path: Path) -> None:
    """The real v1 shape: only the legacy raw-exchange table, stamped user_version 1."""

    connection = sqlite3.connect(str(db_path))
    try:
        connection.executescript(
            """
            CREATE TABLE memory_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id TEXT NOT NULL,
                user_content TEXT NOT NULL,
                assistant_content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO memory_entries (request_id, user_content, assistant_content, created_at)
            VALUES ('req_1', 'hello', 'world', '2026-03-16T00:00:00+00:00');
            """
        )
        connection.execute("PRAGMA user_version=1")
        connection.commit()
    finally:
        connection.close()


def _create_v2_db(db_path: Path, texts: list[str]) -> None:
    """The oldest shape that held approved memory text: v2 ``memories``, no family_key."""

    connection = sqlite3.connect(str(db_path))
    try:
        connection.execute(
            """
            CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                title TEXT NOT NULL,
                lesson_text TEXT NOT NULL,
                lesson_kind TEXT NOT NULL,
                confidence REAL NOT NULL,
                source_excerpt TEXT NOT NULL DEFAULT '',
                content_fingerprint TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        for index, text in enumerate(texts):
            connection.execute(
                """
                INSERT INTO memories (
                    session_id, title, lesson_text, lesson_kind, confidence,
                    source_excerpt, content_fingerprint, created_at, updated_at
                ) VALUES ('session_1', ?, ?, 'preference', 0.9, 'excerpt', ?,
                          '2026-03-17T00:00:00+00:00', '2026-03-17T00:00:00+00:00')
                """,
                (f"Title {index}", text, f"preference:v2-fixture-{index}"),
            )
        connection.execute("PRAGMA user_version=2")
        connection.commit()
    finally:
        connection.close()


def test_m10_v1_database_migrates_to_current_and_drops_raw_exchanges(tmp_path: Path) -> None:
    # Contract note: a real v1 file never held lesson text (it stored raw exchanges,
    # which the chain purges by design), so text preservation is pinned from v2 below.
    db_path = tmp_path / "memory.db"
    _create_v1_db(db_path)
    assert _raw(db_path, "PRAGMA user_version") == [(1,)]

    store = MemoryStore(db_path)
    try:
        assert _raw(db_path, "PRAGMA user_version") == [(SCHEMA_VERSION,)]
        assert _raw(db_path, "SELECT 1 FROM sqlite_master WHERE name = 'memory_entries'") == []
        assert _store_texts(store, GENERAL_PROJECT_ID) == []
    finally:
        store.close()


def test_m10_oldest_text_bearing_schema_migrates_and_keeps_memory_text(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    texts = [f"Oldest-schema memory {index} prefers jasmine tea." for index in range(3)]
    _create_v2_db(db_path, texts)
    assert _raw(db_path, "PRAGMA user_version") == [(2,)]

    store = MemoryStore(db_path)
    try:
        assert _raw(db_path, "PRAGMA user_version") == [(SCHEMA_VERSION,)]
        assert _store_texts(store, GENERAL_PROJECT_ID) == sorted(texts)
    finally:
        store.close()


# --- M11: database lost, WAL left behind -----------------------------------


def test_m11_lost_main_file_with_leftover_wal_never_raises(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    wal_path = Path(f"{db_path}-wal")
    # A crash leaves a non-empty WAL; copy it aside because a clean close deletes it.
    result, acked = _run_child("saves", db_path, 4)
    assert result.returncode == CRASH_EXIT_CODE, result.stderr
    assert acked == list(range(4))
    assert wal_path.stat().st_size > 0
    wal_bytes = wal_path.read_bytes()
    db_path.unlink()
    Path(f"{db_path}-shm").unlink(missing_ok=True)
    wal_path.write_bytes(wal_bytes)

    opened = open_memory_store(db_path)
    try:
        # Observed contract: SQLite discards a WAL whose main file is gone, so the
        # sidecar starts a fresh, empty store rather than recovering rows.
        assert isinstance(opened, MemoryStore)
        assert _store_texts(opened) == []
        assert _raw(db_path, "PRAGMA user_version") == [(SCHEMA_VERSION,)]
    finally:
        opened.close()


# --- M7b: a row-level constraint finding is not page damage ----------------


def test_m7b_a_row_breaking_a_check_constraint_keeps_the_store_available(tmp_path: Path) -> None:
    # quick_check reports CHECK/NOT NULL violations too; the store quarantines
    # such a row on read and serves the rest, so a reopen must not refuse it.
    db_path = tmp_path / "memory.db"
    expected = _save_bulk(db_path, 3)
    connection = sqlite3.connect(str(db_path))
    try:
        connection.execute("PRAGMA ignore_check_constraints=ON")
        connection.execute(
            """
            INSERT INTO memories (
                session_id, project_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, origin, provenance,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "session", PROJECT, "broken", "broken", "preference", "not-a-number", "",
                f"sha256:{'f' * 64}", "legacy", "unknown_legacy",
                "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00",
            ),
        )
        connection.commit()
    finally:
        connection.close()
    assert _raw(db_path, "PRAGMA quick_check") == [("CHECK constraint failed in memories",)]

    opened = open_memory_store(db_path)
    try:
        assert isinstance(opened, MemoryStore)
        assert _store_texts(opened) == expected
    finally:
        opened.close()
