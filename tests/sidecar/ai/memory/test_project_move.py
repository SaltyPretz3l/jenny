"""Deleting a project moves its memories to General (PO review 2026-09-27, D10).

One transaction moves approved memories, pending candidates, suppressions and
extraction bookkeeping; a memory whose content General already holds merges
into General's copy instead of failing the whole move.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, build_content_digest
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.exceptions import MemoryStoreError

PROJECT_ALPHA = "project_alpha"
PROJECT_BETA = "project_beta"


def _save(store: MemoryStore, *, project_id: str, lesson: str, session_id: str = "session-1"):
    return store.save_memory(
        session_id=session_id,
        title=f"Preference: {lesson}",
        lesson_text=lesson,
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt=lesson,
        project_id=project_id,
    )[0]


def _insert_pending(store: MemoryStore, *, project_id: str, lesson: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    store._connection.execute(
        """
        INSERT INTO pending_memory_candidates (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            confidence, source_excerpt, content_fingerprint, family_key,
            category, created_at, updated_at, project_id
        ) VALUES ('session-1', 'request-1', 'Pending', ?, 'preference', 0.9, '', ?, '', '', ?, ?, ?)
        """,
        (lesson, build_content_digest("preference", lesson), now, now, project_id),
    )
    store._connection.commit()


def test_move_relocates_every_project_row_and_merges_duplicates(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        _save(store, project_id=GENERAL_PROJECT_ID, lesson="The user prefers tea.")
        duplicate = _save(store, project_id=PROJECT_ALPHA, lesson="The user prefers tea.")
        unique = _save(store, project_id=PROJECT_ALPHA, lesson="The user writes Rust.")
        other = _save(store, project_id=PROJECT_BETA, lesson="Beta stays put.")
        _insert_pending(store, project_id=PROJECT_ALPHA, lesson="Pending lesson.")
        forgotten = _save(store, project_id=PROJECT_ALPHA, lesson="Forget me.")
        assert store.delete_memory(forgotten.id, project_id=PROJECT_ALPHA) is True

        result = store.move_project_memories(
            source_project_id=PROJECT_ALPHA, target_project_id=GENERAL_PROJECT_ID
        )

        assert result == {"moved": 1, "merged": 1, "pending_moved": 1}
        assert store.get_memory_by_id(unique.id, project_id=GENERAL_PROJECT_ID) is not None
        assert store.get_memory_by_id(unique.id, project_id=PROJECT_ALPHA) is None
        assert store.get_memory_by_id(duplicate.id, project_id=PROJECT_ALPHA) is None
        assert store.get_memory_by_id(other.id, project_id=PROJECT_BETA) is not None
        assert store.status_snapshot(project_id=PROJECT_ALPHA)["counts"]["approved"] == 0
        assert store.status_snapshot()["counts"]["approved"] == 2
        general_pending, _cursor = store.get_pending_candidates_page(
            limit=10, project_id=GENERAL_PROJECT_ID
        )
        assert [row.lesson_text for row in general_pending] == ["Pending lesson."]
        assert store.is_memory_suppressed(
            forgotten.content_fingerprint, project_id=GENERAL_PROJECT_ID
        ), "a forgotten memory stays forgotten after the move"
        recalled = store.recall_memories("Rust", limit=3, project_id=GENERAL_PROJECT_ID)
        assert [memory.id for memory in recalled] == [unique.id], "the recall index follows"
    finally:
        store.close()


def test_a_committed_move_answers_ok_even_when_follow_up_maintenance_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An error answer must mean nothing moved (DPR-008).

    Electron rolls a project delete back on an error answer. Store maintenance
    runs after the commit, so its failure must not become the move's answer.
    """
    store = MemoryStore(tmp_path / "memory.db")
    try:
        unique = _save(store, project_id=PROJECT_ALPHA, lesson="The user writes Rust.")

        def failing_maintenance(*_args: object, **_kwargs: object) -> None:
            raise OSError("disk went away during maintenance")

        monkeypatch.setattr(store, "_run_due_maintenance", failing_maintenance)

        result = store.move_project_memories(
            source_project_id=PROJECT_ALPHA, target_project_id=GENERAL_PROJECT_ID
        )

        assert result == {"moved": 1, "merged": 0, "pending_moved": 0}
        assert store.get_memory_by_id(unique.id, project_id=GENERAL_PROJECT_ID) is not None
    finally:
        store.close()


def _project_rows(store: MemoryStore) -> dict[str, list[tuple]]:
    """Every project-scoped row, so a re-issued move can be shown to change nothing."""
    tables = (
        "memories",
        "pending_memory_candidates",
        "memory_suppressions",
        "memory_extraction_runs",
    )
    return {
        table: store._connection.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
        for table in tables
    }


def test_a_reissued_move_after_a_committed_one_changes_nothing(tmp_path: Path) -> None:
    """Electron re-issues the move when the first reply was lost (DPR-008)."""
    db_path = tmp_path / "memory.db"
    store = MemoryStore(db_path)
    try:
        _save(store, project_id=GENERAL_PROJECT_ID, lesson="The user prefers tea.")
        _save(store, project_id=PROJECT_ALPHA, lesson="The user prefers tea.")
        unique = _save(store, project_id=PROJECT_ALPHA, lesson="The user writes Rust.")
        _insert_pending(store, project_id=PROJECT_ALPHA, lesson="Pending lesson.")
        forgotten = _save(store, project_id=PROJECT_ALPHA, lesson="Forget me.")
        assert store.delete_memory(forgotten.id, project_id=PROJECT_ALPHA) is True

        first = store.move_project_memories(
            source_project_id=PROJECT_ALPHA, target_project_id=GENERAL_PROJECT_ID
        )
        assert first == {"moved": 1, "merged": 1, "pending_moved": 1}
        committed = _project_rows(store)

        again = store.move_project_memories(
            source_project_id=PROJECT_ALPHA, target_project_id=GENERAL_PROJECT_ID
        )
        assert again == {"moved": 0, "merged": 0, "pending_moved": 0}
        assert _project_rows(store) == committed
    finally:
        store.close()

    # The re-issue usually reaches a restarted sidecar: a fresh connection.
    restarted = MemoryStore(db_path)
    try:
        assert restarted.move_project_memories(
            source_project_id=PROJECT_ALPHA, target_project_id=GENERAL_PROJECT_ID
        ) == {"moved": 0, "merged": 0, "pending_moved": 0}
        assert _project_rows(restarted) == committed
        recalled = restarted.recall_memories("Rust", limit=3, project_id=GENERAL_PROJECT_ID)
        assert [memory.id for memory in recalled] == [unique.id]
    finally:
        restarted.close()


def test_move_is_idempotent_and_validates_its_scopes(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        empty = store.move_project_memories(
            source_project_id=PROJECT_ALPHA, target_project_id=GENERAL_PROJECT_ID
        )
        assert empty == {"moved": 0, "merged": 0, "pending_moved": 0}
        with pytest.raises(ValueError):
            store.move_project_memories(
                source_project_id=GENERAL_PROJECT_ID, target_project_id=PROJECT_ALPHA
            )
        with pytest.raises(ValueError):
            store.move_project_memories(
                source_project_id=PROJECT_ALPHA, target_project_id=PROJECT_ALPHA
            )
        with pytest.raises(ValueError):
            store.move_project_memories(
                source_project_id="alpha", target_project_id=GENERAL_PROJECT_ID
            )
    finally:
        store.close()


def test_service_exposes_the_move_and_refuses_when_unavailable(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        _save(store, project_id=PROJECT_ALPHA, lesson="Moves through the service.")
        service = MemoryService(store)
        assert service.move_project_memories(
            source_project_id=PROJECT_ALPHA, target_project_id=GENERAL_PROJECT_ID
        ) == {"moved": 1, "merged": 0, "pending_moved": 0}
    finally:
        store.close()

    from sidecar.ai.memory.unavailable import UnavailableMemoryStore

    unavailable = MemoryService(
        UnavailableMemoryStore.from_failure(tmp_path / "broken.db", RuntimeError("boom"))
    )
    with pytest.raises(MemoryStoreError):
        unavailable.move_project_memories(
            source_project_id=PROJECT_ALPHA, target_project_id=GENERAL_PROJECT_ID
        )


def test_delete_move_then_reinitialize_keeps_the_store_available(tmp_path: Path) -> None:
    """NF4 (live re-check 2026-09-27): delete the current project, then open another.

    A workspace-root switch re-initializes the sidecar in process: the new stack
    opens its MemoryStore while the previous stack's connection is still live,
    so the WAL file survives and the new store's startup checkpoint backfills
    it. The move is the next write, so SQLite restarts the WAL at frame 1 with
    new salts and leaves the older, longer generation's frames behind it in the
    file. The next re-initialize must read that as a healthy restarted log, not
    as a corrupt one that needs explicit repair.
    """
    from sidecar.ai.memory.unavailable import open_memory_store

    db_path = tmp_path / "memory.db"
    first = MemoryStore(db_path)
    for index in range(4):
        _save(first, project_id=PROJECT_ALPHA, lesson=f"Recheck lesson {index} about tea.")
    # Root cleared by the delete: the replacement stack opens beside the live one.
    second = MemoryStore(db_path)
    first.close()
    try:
        assert second.move_project_memories(
            source_project_id=PROJECT_ALPHA, target_project_id=GENERAL_PROJECT_ID
        ) == {"moved": 4, "merged": 0, "pending_moved": 0}
        # Another project opened: the next replacement stack opens beside the live one.
        third = open_memory_store(db_path)
        try:
            assert isinstance(third, MemoryStore), third.status_payload()
            assert third.status_snapshot()["counts"]["approved"] == 4
        finally:
            third.close()
    finally:
        second.close()
