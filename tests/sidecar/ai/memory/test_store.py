from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_MEMORY_FAILED,
    CMP_MEMORY_FINGERPRINT_CONFLICT,
    CMP_MEMORY_SCHEMA_MIGRATION,
)
from sidecar.ai.memory.contracts import build_content_digest
from sidecar.ai.memory.store import SCHEMA_VERSION, MemoryStore
from sidecar.exceptions import MemoryStoreError


def _insert_pending_candidate(
    store: MemoryStore,
    *,
    session_id: str,
    source_request_id: str,
    title: str,
    lesson_text: str,
    lesson_kind: str,
    confidence: float,
    source_excerpt: str,
    category: str = "",
) -> int:
    timestamp = datetime.now(timezone.utc).isoformat()
    cursor = store._connection.execute(  # noqa: SLF001
        """
        INSERT INTO pending_memory_candidates (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            confidence, source_excerpt, content_fingerprint, family_key,
            category, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
        """,
        (
            session_id,
            source_request_id,
            title,
            lesson_text,
            lesson_kind,
            confidence,
            source_excerpt,
            build_content_digest(lesson_kind, lesson_text),
            category,
            timestamp,
            timestamp,
        ),
    )
    store._connection.commit()  # noqa: SLF001
    assert cursor.lastrowid is not None
    return int(cursor.lastrowid)


def test_memory_store_initializes_schema_and_defaults(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        version = int(store._connection.execute("PRAGMA user_version").fetchone()[0])  # noqa: SLF001
        assert version == SCHEMA_VERSION
        assert store.journal_mode in {"wal", "memory", "delete"}
        assert store.get_all_memories() == []
    finally:
        store.close()


def test_memory_store_rejects_unsupported_schema_version(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    connection = sqlite3.connect(str(db_path))
    try:
        connection.execute("PRAGMA user_version=99")
        connection.commit()
    finally:
        connection.close()

    with pytest.raises(MemoryStoreError, match="unsupported memory schema version") as exc_info:
        MemoryStore(db_path)

    assert exc_info.value.code == CMP_MEMORY_SCHEMA_MIGRATION


def test_memory_store_wraps_database_errors_after_connection_close(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    store.close()

    with pytest.raises(MemoryStoreError, match="failed to read memories") as read_error:
        store.get_all_memories()
    assert read_error.value.code == CMP_MEMORY_FAILED


def test_memory_store_migrates_v1_and_purges_legacy_raw_exchanges(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
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

            INSERT INTO memory_entries (
                request_id,
                user_content,
                assistant_content,
                created_at
            ) VALUES (
                'req_1',
                'hello',
                'world',
                '2026-03-16T00:00:00+00:00'
            );
            """
        )
        connection.execute("PRAGMA user_version=1")
        connection.commit()
    finally:
        connection.close()

    store = MemoryStore(db_path)
    try:
        assert store._connection.execute(  # noqa: SLF001
            "SELECT 1 FROM sqlite_master WHERE name = 'memory_entries'"
        ).fetchone() is None
        memories_columns = {
            row[1]
            for row in store._connection.execute("PRAGMA table_info(memories)").fetchall()  # noqa: SLF001
        }
        assert {
            "session_id",
            "title",
            "lesson_text",
            "content_fingerprint",
            "family_key",
        } <= memories_columns
        version = int(store._connection.execute("PRAGMA user_version").fetchone()[0])  # noqa: SLF001
        assert version == SCHEMA_VERSION
    finally:
        store.close()


def test_memory_store_save_memory_dedupes_normalized_fingerprint(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, created = store.save_memory(
            session_id="session_1",
            title="Preference: tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="I prefer tea",
        )
        duplicate, duplicate_created = store.save_memory(
            session_id="session_2",
            title="Preference: tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="I prefer tea",
        )

        assert created is True
        assert duplicate_created is False
        assert duplicate.id == saved.id
        assert duplicate.session_id == "session_2"
        assert duplicate.source_excerpt == "I prefer tea"
        assert duplicate.updated_at >= saved.updated_at
        assert len(store.get_all_memories()) == 1
        assert store.has_memory_fingerprint(
            build_content_digest("preference", "The user prefers tea.")
        ) is True
    finally:
        store.close()


def test_memory_store_rejects_unstructured_memory_provenance(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        with pytest.raises(MemoryStoreError, match="provenance is required") as exc_info:
            store.save_memory(
                session_id="session_1",
                title="Preference: tea",
                lesson_text="The user prefers tea.",
                lesson_kind="preference",
                confidence=0.95,
                source_excerpt="I prefer tea",
                provenance='{"source":"user"}',
            )

        assert exc_info.value.code == CMP_MEMORY_FAILED
    finally:
        store.close()


def test_memory_store_save_memory_accepts_response_style_kind(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, created = store.save_memory(
            session_id="session_style",
            title="Response style: concise",
            lesson_text="Use concise answers unless the user asks for more detail.",
            lesson_kind="response_style",
            confidence=0.93,
            source_excerpt="be concise",
        )

        assert created is True
        assert saved.lesson_kind == "response_style"
    finally:
        store.close()


def test_memory_store_save_memory_accepts_tool_strategy_kind(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, created = store.save_memory(
            session_id="session_tool_strategy",
            title="Tool strategy: prefer ripgrep",
            lesson_text="For repository text search tasks, prefer rg/ripgrep when it is available.",
            lesson_kind="tool_strategy",
            confidence=0.9,
            source_excerpt="prefer rg",
            family_key="ripgrep",
        )

        assert created is True
        assert saved.lesson_kind == "tool_strategy"
        assert saved.family_key == "ripgrep"
    finally:
        store.close()


@pytest.mark.parametrize(
    ("lesson_kind", "title", "lesson_text", "family_key"),
    [
        (
            "working_preference",
            "Working preference: diagnose root cause first",
            "Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.",
            "diagnose_root_cause_first",
        ),
        (
            "project_context",
            "Project context: sidecar is stateless per request",
            "The sidecar is stateless per request.",
            "sidecar_stateless_per_request",
        ),
    ],
)
def test_memory_store_save_memory_accepts_new_batch_d_memory_kinds(
    tmp_path: Path,
    lesson_kind: str,
    title: str,
    lesson_text: str,
    family_key: str,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, created = store.save_memory(
            session_id="session_new_kind",
            title=title,
            lesson_text=lesson_text,
            lesson_kind=lesson_kind,
            confidence=0.9,
            source_excerpt=title,
            family_key=family_key,
        )

        assert created is True
        assert saved.lesson_kind == lesson_kind
        assert saved.family_key == family_key
    finally:
        store.close()


def test_memory_store_recall_memories_scores_overlap_and_recency(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        older_memory, _ = store.save_memory(
            session_id="session_old",
            title="Preference: tea",
            lesson_text="The user prefers tea over coffee.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="I prefer tea over coffee",
        )
        newer_memory, _ = store.save_memory(
            session_id="session_new",
            title="Preference: green tea",
            lesson_text="The user prefers green tea in the afternoon.",
            lesson_kind="preference",
            confidence=0.7,
            source_excerpt="I prefer green tea in the afternoon",
        )
        stale_timestamp = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
        fresh_timestamp = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        store._connection.execute(  # noqa: SLF001
            "UPDATE memories SET updated_at = ? WHERE id = ?",
            (stale_timestamp, older_memory.id),
        )
        store._connection.execute(  # noqa: SLF001
            "UPDATE memories SET updated_at = ? WHERE id = ?",
            (fresh_timestamp, newer_memory.id),
        )
        store._connection.commit()  # noqa: SLF001

        recalled = store.recall_memories("green tea please", limit=3)

        assert [memory.id for memory in recalled] == [newer_memory.id, older_memory.id]
    finally:
        store.close()


def test_memory_store_recall_memories_prefers_weighted_title_and_source_matches(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        lesson_only_memory, _ = store.save_memory(
            session_id="session_lesson_only",
            title="Preference: drinks",
            lesson_text="The user prefers green tea in the afternoon.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="They usually enjoy a warm drink.",
        )
        weighted_match_memory, _ = store.save_memory(
            session_id="session_weighted",
            title="Green tea routine",
            lesson_text="The user keeps a steady afternoon drink routine.",
            lesson_kind="preference",
            confidence=0.6,
            source_excerpt="green tea in the afternoon",
        )

        recalled = store.recall_memories("green tea afternoon", limit=2)

        assert [memory.id for memory in recalled] == [
            weighted_match_memory.id,
            lesson_only_memory.id,
        ]
    finally:
        store.close()


def test_memory_store_get_recent_memories_by_kind_returns_most_recent_first(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        profile_memory, _ = store.save_memory(
            session_id="session_profile",
            title="Preferred name: Jen",
            lesson_text="The user's name is Jen.",
            lesson_kind="profile",
            confidence=0.99,
            source_excerpt="my name is Jen",
        )
        older_style_memory, _ = store.save_memory(
            session_id="session_style_older",
            title="Response style: concise",
            lesson_text="Use concise answers unless the user asks for more detail.",
            lesson_kind="response_style",
            confidence=0.93,
            source_excerpt="be concise",
        )
        newer_style_memory, _ = store.save_memory(
            session_id="session_style_newer",
            title="Response style: step-by-step",
            lesson_text="Explain things step by step when helping the user.",
            lesson_kind="response_style",
            confidence=0.91,
            source_excerpt="step by step",
        )
        stale_timestamp = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        fresh_timestamp = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        store._connection.execute(  # noqa: SLF001
            "UPDATE memories SET updated_at = ? WHERE id = ?",
            (stale_timestamp, older_style_memory.id),
        )
        store._connection.execute(  # noqa: SLF001
            "UPDATE memories SET updated_at = ? WHERE id = ?",
            (fresh_timestamp, newer_style_memory.id),
        )
        store._connection.commit()  # noqa: SLF001

        recalled = store.get_recent_memories_by_kind("response_style", limit=2)

        assert [memory.id for memory in recalled] == [newer_style_memory.id, older_style_memory.id]
        assert all(memory.lesson_kind == "response_style" for memory in recalled)
        assert profile_memory.id not in [memory.id for memory in recalled]
    finally:
        store.close()


def test_memory_store_recall_memories_breaks_score_ties_by_recency(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        older_memory, _ = store.save_memory(
            session_id="session_old",
            title="Preference: drinks",
            lesson_text="The user prefers tea with breakfast.",
            lesson_kind="preference",
            confidence=0.5,
            source_excerpt="breakfast drink",
        )
        newer_memory, _ = store.save_memory(
            session_id="session_new",
            title="Preference: beverages",
            lesson_text="The user drinks tea after lunch.",
            lesson_kind="preference",
            confidence=0.5,
            source_excerpt="after lunch drink",
        )
        stale_timestamp = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
        fresh_timestamp = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        store._connection.execute(  # noqa: SLF001
            "UPDATE memories SET updated_at = ? WHERE id = ?",
            (stale_timestamp, older_memory.id),
        )
        store._connection.execute(  # noqa: SLF001
            "UPDATE memories SET updated_at = ? WHERE id = ?",
            (fresh_timestamp, newer_memory.id),
        )
        store._connection.commit()  # noqa: SLF001

        recalled = store.recall_memories("tea", limit=2)

        assert [memory.id for memory in recalled] == [newer_memory.id, older_memory.id]
    finally:
        store.close()


def test_memory_store_recall_memories_returns_empty_when_nothing_matches(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        store.save_memory(
            session_id="session_1",
            title="Preference: tea",
            lesson_text="The user prefers tea over coffee.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="I prefer tea over coffee",
        )

        assert store.recall_memories("golang microservices", limit=3) == []
    finally:
        store.close()


def test_memory_store_recall_memories_returns_new_ungated_memory_kinds(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        routine_memory, _ = store.save_memory(
            session_id="session_routine",
            title="Routine: morning routine",
            lesson_text="The user's morning routine includes stretching and green tea.",
            lesson_kind="routine",
            confidence=0.94,
            source_excerpt="every morning I stretch and drink green tea",
        )
        goal_memory, _ = store.save_memory(
            session_id="session_goal",
            title="Goal: finish the garden",
            lesson_text="The user's goal is to finish the garden before June.",
            lesson_kind="goal",
            confidence=0.92,
            source_excerpt="my goal is to finish the garden before June",
        )
        person_memory, _ = store.save_memory(
            session_id="session_person",
            title="Important person: Alex (coworker)",
            lesson_text="The user's coworker is Alex.",
            lesson_kind="important_person",
            confidence=0.9,
            source_excerpt="my coworker Alex is helping with the launch",
        )

        routine_recalled = store.recall_memories("What is my morning green tea routine?", limit=2)
        goal_recalled = store.recall_memories(
            "Remind me about my goal to finish the garden", limit=2
        )
        person_recalled = store.recall_memories(
            "What should I remember about my coworker Alex?", limit=2
        )

        assert [memory.id for memory in routine_recalled] == [routine_memory.id]
        assert [memory.id for memory in goal_recalled] == [goal_memory.id]
        assert [memory.id for memory in person_recalled] == [person_memory.id]
    finally:
        store.close()


def test_memory_store_recall_memories_returns_tool_strategy_matches(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, _ = store.save_memory(
            session_id="session_tool_strategy",
            title="Tool strategy: prefer ripgrep",
            lesson_text="For repository text search tasks, prefer rg/ripgrep when it is available.",
            lesson_kind="tool_strategy",
            confidence=0.9,
            source_excerpt="prefer ripgrep",
            family_key="",
        )

        recalled = store.recall_memories("search repository text with ripgrep", limit=2)

        assert recalled == []
        assert saved.family_key == ""
    finally:
        store.close()


def test_memory_store_recall_memories_returns_tool_strategy_matches_with_family_key(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, _ = store.save_memory(
            session_id="session_tool_strategy",
            title="Tool strategy: prefer ripgrep",
            lesson_text="For repository text search tasks, prefer rg/ripgrep when it is available.",
            lesson_kind="tool_strategy",
            confidence=0.9,
            source_excerpt="prefer ripgrep",
            family_key="ripgrep",
        )

        recalled = store.recall_memories("search repository text with ripgrep", limit=2)

        assert [memory.id for memory in recalled] == [saved.id]
        assert recalled[0].lesson_kind == "tool_strategy"
    finally:
        store.close()


def test_memory_store_recall_memories_ignores_generic_stopword_overlap(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        store.save_memory(
            session_id="session_1",
            title="Preference: tea",
            lesson_text="The user prefers tea over coffee.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="I prefer tea over coffee",
        )

        assert store.recall_memories("What should I do with the project?", limit=3) == []
    finally:
        store.close()


def test_memory_store_lists_memories_newest_first(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        older_memory, _ = store.save_memory(
            session_id="session_old",
            title="Preference: tea",
            lesson_text="The user prefers tea over coffee.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="I prefer tea over coffee",
        )
        newer_memory, _ = store.save_memory(
            session_id="session_new",
            title="Response style: concise",
            lesson_text="Use concise answers unless the user asks for more detail.",
            lesson_kind="response_style",
            confidence=0.93,
            source_excerpt="be concise",
        )

        listed = store.get_all_memories()

        assert [memory.id for memory in listed] == [newer_memory.id, older_memory.id]
    finally:
        store.close()


def test_memory_store_updates_memory_without_changing_kind_metadata(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, _ = store.save_memory(
            session_id="session_1",
            title="Preference: tea",
            lesson_text="The user prefers tea over coffee.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="I prefer tea over coffee",
        )

        updated = store.update_memory(
            memory_id=saved.id,
            title="Preference: green tea",
            lesson_text="The user prefers green tea over coffee.",
        )

        assert updated.id == saved.id
        assert updated.lesson_kind == "preference"
        assert updated.session_id == saved.session_id
        assert updated.source_excerpt == saved.source_excerpt
        assert updated.title == "Preference: green tea"
        assert updated.lesson_text == "The user prefers green tea over coffee."
        assert updated.content_fingerprint == build_content_digest(
            "preference", "The user prefers green tea over coffee."
        )
        assert updated.updated_at >= saved.updated_at
    finally:
        store.close()


def test_memory_store_updates_gated_memory_preserves_family_key(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, _ = store.save_memory(
            session_id="session_work_pref",
            title="Working preference: diagnose root cause first",
            lesson_text="Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.",
            lesson_kind="working_preference",
            confidence=0.94,
            source_excerpt="diagnose root cause first",
            family_key="diagnose_root_cause_first",
        )

        updated = store.update_memory(
            memory_id=saved.id,
            title="Working preference: investigate first",
            lesson_text="Keep this generic so lexical overlap would be broader.",
        )

        assert updated.family_key == "diagnose_root_cause_first"
        assert store.recall_memories("investigate first", limit=2) == []
        recalled = store.recall_memories("debug this issue and find the root cause", limit=2)
        assert [memory.id for memory in recalled] == [saved.id]
    finally:
        store.close()


def test_memory_store_update_memory_rejects_duplicate_fingerprint(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        first_memory, _ = store.save_memory(
            session_id="session_1",
            title="Preference: tea",
            lesson_text="The user prefers tea over coffee.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="I prefer tea over coffee",
        )
        second_memory, _ = store.save_memory(
            session_id="session_2",
            title="Preference: coffee",
            lesson_text="The user prefers coffee in the morning.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="I prefer coffee in the morning",
        )

        with pytest.raises(
            MemoryStoreError, match="content_fingerprint already exists"
        ) as exc_info:
            store.update_memory(
                memory_id=second_memory.id,
                title="Preference: tea",
                lesson_text="THE USER PREFERS TEA OVER COFFEE",
            )

        assert exc_info.value.code == CMP_MEMORY_FINGERPRINT_CONFLICT
        assert store.get_memory_by_id(first_memory.id) is not None
    finally:
        store.close()


def test_memory_store_deletes_memory_by_id(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, _ = store.save_memory(
            session_id="session_1",
            title="Preference: tea",
            lesson_text="The user prefers tea over coffee.",
            lesson_kind="preference",
            confidence=0.95,
            source_excerpt="I prefer tea over coffee",
        )

        deleted = store.delete_memory(saved.id)

        assert deleted is True
        assert store.get_memory_by_id(saved.id) is None
    finally:
        store.close()


def test_memory_store_migrates_v2_memories_with_family_key_backfill(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    connection = sqlite3.connect(str(db_path))
    try:
        connection.executescript(
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
            );

            INSERT INTO memories (
                session_id,
                title,
                lesson_text,
                lesson_kind,
                confidence,
                source_excerpt,
                content_fingerprint,
                created_at,
                updated_at
            ) VALUES
            (
                'session_tool',
                'Tool strategy: plan before implementation',
                'Plan the approach before implementing non-trivial work.',
                'tool_strategy',
                0.87,
                'plan before implementation',
                'tool_strategy:plan-the-approach-before-implementing-non-trivial-work',
                '2026-03-17T00:00:00+00:00',
                '2026-03-17T00:00:00+00:00'
            ),
            (
                'session_project',
                'Project context: workspace has no git metadata',
                'This workspace has no .git metadata, so branch and status information are unavailable.',
                'project_context',
                0.95,
                'workspace has no .git metadata',
                'project_context:workspace-has-no-git-metadata',
                '2026-03-17T00:00:00+00:00',
                '2026-03-17T00:00:00+00:00'
            );
            """
        )
        connection.execute("PRAGMA user_version=2")
        connection.commit()
    finally:
        connection.close()

    store = MemoryStore(db_path)
    try:
        memories = store.get_all_memories()
        assert {memory.family_key for memory in memories} == {
            "plan_first",
            "workspace_has_no_git_metadata",
        }
    finally:
        store.close()


def test_memory_store_v2_to_v3_migration_is_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
    connection = sqlite3.connect(str(db_path))
    try:
        connection.executescript(
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
            );

            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, created_at, updated_at
            ) VALUES (
                'session_1', 'Test memory', 'Some lesson text.',
                'preference', 0.9, 'excerpt',
                'preference:some-lesson-text',
                '2026-03-17T00:00:00+00:00', '2026-03-17T00:00:00+00:00'
            );
            """
        )
        connection.execute("PRAGMA user_version=2")
        connection.commit()
    finally:
        connection.close()

    store = MemoryStore(db_path)
    store.close()

    store2 = MemoryStore(db_path)
    try:
        memories = store2.get_all_memories()
        assert len(memories) == 1
        assert memories[0].lesson_text == "Some lesson text."
    finally:
        store2.close()


def test_memory_store_recall_memories_fails_closed_for_unknown_gated_family_key(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, _ = store.save_memory(
            session_id="session_work_pref",
            title="Working preference: diagnose root cause first",
            lesson_text="Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.",
            lesson_kind="working_preference",
            confidence=0.94,
            source_excerpt="diagnose root cause first",
            family_key="unknown_family",
        )

        assert saved.family_key == "unknown_family"
        assert store.recall_memories("debug this issue and find the root cause", limit=2) == []
    finally:
        store.close()


def test_memory_store_recall_memories_blocks_generic_tool_strategy_overlap(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        store.save_memory(
            session_id="session_tool_strategy",
            title="Tool strategy: plan before implementation",
            lesson_text="Plan the approach before implementing non-trivial work.",
            lesson_kind="tool_strategy",
            confidence=0.87,
            source_excerpt="plan before implementation",
            family_key="plan_first",
        )
        store.save_memory(
            session_id="session_tool_strategy_2",
            title="Tool strategy: keep diffs small",
            lesson_text="Keep changes small and reviewable.",
            lesson_kind="tool_strategy",
            confidence=0.88,
            source_excerpt="keep diffs small",
            family_key="small_diffs",
        )

        assert store.recall_memories("plan the release work", limit=3) == []
        assert store.recall_memories("small implementation detail", limit=3) == []
    finally:
        store.close()


def test_memory_store_recall_memories_keeps_relevant_tool_strategy_matches(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        ripgrep_memory, _ = store.save_memory(
            session_id="session_search",
            title="Tool strategy: prefer ripgrep",
            lesson_text="For repository text search tasks, prefer rg/ripgrep when it is available.",
            lesson_kind="tool_strategy",
            confidence=0.9,
            source_excerpt="prefer rg",
            family_key="ripgrep",
        )
        apply_patch_memory, _ = store.save_memory(
            session_id="session_edit",
            title="Tool strategy: use apply_patch",
            lesson_text="Prefer apply_patch for small manual file edits when practical.",
            lesson_kind="tool_strategy",
            confidence=0.89,
            source_excerpt="prefer apply_patch",
            family_key="apply_patch",
        )

        search_recalled = store.recall_memories(
            "What should I use to search repository text?", limit=2
        )
        edit_recalled = store.recall_memories(
            "How should I edit and patch this file manually?", limit=2
        )

        assert [memory.id for memory in search_recalled] == [ripgrep_memory.id]
        assert [memory.id for memory in edit_recalled] == [apply_patch_memory.id]
    finally:
        store.close()


def test_memory_store_recall_memories_keeps_relevant_working_preference_matches(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, _ = store.save_memory(
            session_id="session_work_pref",
            title="Working preference: diagnose root cause first",
            lesson_text="Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.",
            lesson_kind="working_preference",
            confidence=0.94,
            source_excerpt="diagnose root cause first",
            family_key="diagnose_root_cause_first",
        )

        recalled = store.recall_memories("debug this regression and find the root cause", limit=2)

        assert [memory.id for memory in recalled] == [saved.id]
        assert recalled[0].lesson_kind == "working_preference"
    finally:
        store.close()


def test_memory_store_recall_memories_blocks_generic_working_preference_overlap(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        store.save_memory(
            session_id="session_work_pref",
            title="Working preference: update plan docs after completion",
            lesson_text="When following a plan document, update it after the task or batch is completed.",
            lesson_kind="working_preference",
            confidence=0.88,
            source_excerpt="update the plan document when task or batch is completed",
            family_key="update_plan_docs_after_completion",
        )

        assert store.recall_memories("plan the next feature work", limit=3) == []
    finally:
        store.close()


def test_memory_store_recall_memories_keeps_relevant_project_context_matches(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, _ = store.save_memory(
            session_id="session_project_context",
            title="Project context: workspace has no git metadata",
            lesson_text="This workspace has no .git metadata, so branch and status information are unavailable.",
            lesson_kind="project_context",
            confidence=0.95,
            source_excerpt="workspace has no .git metadata",
            family_key="workspace_has_no_git_metadata",
        )

        recalled = store.recall_memories("what branch am I on in this git workspace?", limit=2)

        assert [memory.id for memory in recalled] == [saved.id]
        assert recalled[0].lesson_kind == "project_context"
    finally:
        store.close()


def test_memory_store_recall_memories_blocks_generic_project_context_overlap(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        store.save_memory(
            session_id="session_project_context",
            title="Project context: tools require explicit workspace root",
            lesson_text="Tools remain blocked until a workspace root is explicitly configured.",
            lesson_kind="project_context",
            confidence=0.9,
            source_excerpt="tools stay blocked until the workspace root is set",
            family_key="tools_require_workspace_root",
        )

        assert store.recall_memories("outline the feature roadmap for this quarter", limit=3) == []
    finally:
        store.close()


def test_memory_store_recall_tool_strategy_plan_matches_should_i_plan(tmp_path: Path) -> None:
    """Relaxed intent gating: 'should I plan this feature?' matches plan-before-implementation."""
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, _ = store.save_memory(
            session_id="session_plan",
            title="Tool strategy: plan before implementation",
            lesson_text="Plan the approach before implementing non-trivial work.",
            lesson_kind="tool_strategy",
            confidence=0.87,
            source_excerpt="plan before implementation",
            family_key="plan_first",
        )

        recalled = store.recall_memories("should I plan this feature first?", limit=3)
        assert len(recalled) == 1
        assert recalled[0].id == saved.id
    finally:
        store.close()


def test_memory_store_recall_tool_strategy_plan_matches_design_the_task(tmp_path: Path) -> None:
    """Relaxed intent gating: 'design this task' matches plan-before-implementation."""
    store = MemoryStore(tmp_path / "memory.db")
    try:
        saved, _ = store.save_memory(
            session_id="session_plan_2",
            title="Tool strategy: plan before implementation",
            lesson_text="Plan the approach before implementing non-trivial work.",
            lesson_kind="tool_strategy",
            confidence=0.87,
            source_excerpt="plan before implementation",
            family_key="plan_first",
        )

        recalled = store.recall_memories("design the change before starting", limit=3)
        assert len(recalled) == 1
        assert recalled[0].id == saved.id
    finally:
        store.close()


def test_memory_store_fresh_db_uses_incremental_auto_vacuum(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        # auto_vacuum: 0=NONE, 1=FULL, 2=INCREMENTAL — a fresh DB must be 2 so the
        # purge sweeps can reclaim freed pages via PRAGMA incremental_vacuum.
        mode = store._connection.execute("PRAGMA auto_vacuum").fetchone()[0]  # noqa: SLF001
        assert mode == 2
    finally:
        store.close()


def test_memory_store_get_pending_candidates_orders_by_confidence_then_recency(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        _insert_pending_candidate(
            store,
            session_id="session-1",
            source_request_id="request-1",
            title="Lower confidence",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.7,
            source_excerpt="tea",
            category="user",
        )
        _insert_pending_candidate(
            store,
            session_id="session-1",
            source_request_id="request-2",
            title="Higher confidence",
            lesson_text="Use concise answers.",
            lesson_kind="response_style",
            confidence=0.9,
            source_excerpt="concise",
            category="feedback",
        )

        pending = store.get_pending_candidates("session-1")

        assert [candidate.title for candidate in pending] == [
            "Higher confidence",
            "Lower confidence",
        ]
    finally:
        store.close()


def test_memory_store_get_pending_candidates_for_harness_orders_by_recency(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        first_id = _insert_pending_candidate(
            store,
            session_id="session-1",
            source_request_id="request-1",
            title="Older",
            lesson_text="Older candidate.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="older",
            category="user",
        )
        second_id = _insert_pending_candidate(
            store,
            session_id="session-2",
            source_request_id="request-2",
            title="Newer",
            lesson_text="Newer candidate.",
            lesson_kind="preference",
            confidence=0.1,
            source_excerpt="newer",
            category="feedback",
        )

        pending = store.get_pending_candidates_for_harness(limit=10)

        assert [candidate.id for candidate in pending] == [second_id, first_id]
    finally:
        store.close()


def test_memory_store_get_pending_candidates_for_harness_applies_limit(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        _insert_pending_candidate(
            store,
            session_id="session-1",
            source_request_id="request-1",
            title="One",
            lesson_text="Candidate one.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="one",
            category="user",
        )
        _insert_pending_candidate(
            store,
            session_id="session-2",
            source_request_id="request-2",
            title="Two",
            lesson_text="Candidate two.",
            lesson_kind="preference",
            confidence=0.8,
            source_excerpt="two",
            category="user",
        )

        pending = store.get_pending_candidates_for_harness(limit=1)
        assert len(pending) == 1
    finally:
        store.close()


def test_memory_store_save_memory_deletes_matching_pending_candidate(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        _insert_pending_candidate(
            store,
            session_id="session-1",
            source_request_id="request-1",
            title="Preference: tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="I prefer tea",
            category="user",
        )

        memory, created = store.save_memory(
            session_id="session-1",
            title="Preference: tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="I prefer tea",
        )

        assert created is True
        assert memory.content_fingerprint == build_content_digest(
            "preference", "The user prefers tea."
        )
        assert store.get_pending_candidates("session-1") == []
    finally:
        store.close()


def test_memory_store_migrates_v3_database_to_v4_extraction_tables(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.db"
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

            CREATE INDEX idx_memory_entries_created_at
              ON memory_entries(created_at DESC);

            CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                title TEXT NOT NULL,
                lesson_text TEXT NOT NULL,
                lesson_kind TEXT NOT NULL,
                confidence REAL NOT NULL,
                source_excerpt TEXT NOT NULL DEFAULT '',
                content_fingerprint TEXT NOT NULL,
                family_key TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX idx_memories_fingerprint
              ON memories(content_fingerprint);
            CREATE INDEX idx_memories_updated_at
              ON memories(updated_at DESC);

            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, family_key, created_at, updated_at
            ) VALUES (
                'session-1',
                'Preference: tea',
                'The user prefers tea.',
                'preference',
                0.9,
                'I prefer tea',
                'preference:the-user-prefers-tea',
                '',
                '2026-03-17T00:00:00+00:00',
                '2026-03-17T00:00:00+00:00'
            );
            """
        )
        connection.execute("PRAGMA user_version=3")
        connection.commit()
    finally:
        connection.close()

    store = MemoryStore(db_path)
    try:
        version = int(store._connection.execute("PRAGMA user_version").fetchone()[0])  # noqa: SLF001
        tables = {
            row[0]
            for row in store._connection.execute(  # noqa: SLF001
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }

        assert version == SCHEMA_VERSION
        assert "memory_extraction_runs" in tables
        assert "pending_memory_candidates" in tables
        assert len(store.get_all_memories()) == 1
    finally:
        store.close()
