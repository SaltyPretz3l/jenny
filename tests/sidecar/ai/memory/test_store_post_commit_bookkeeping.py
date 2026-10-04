"""A committed memory write answers ok whatever happens afterwards.

``MemoryStore._write_transaction`` commits and then does its bookkeeping (a
mutation counter and, when due, store maintenance). Maintenance already
swallows database errors; any other failure there used to escape from the
write that had just committed, so Electron was told a saved, edited, deleted
or moved memory had failed. Found while fixing review finding DPR-008, where
the project delete rolls back on exactly that answer.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import pytest

from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, build_content_digest
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.store_shared import MEMORY_MAINTENANCE_MUTATION_INTERVAL

PROJECT_ALPHA = "project_alpha"


def _save(store: MemoryStore, lesson: str, *, project_id: str = GENERAL_PROJECT_ID):
    return store.save_memory(
        session_id="session-1",
        title=f"Preference: {lesson}",
        lesson_text=lesson,
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt=lesson,
        project_id=project_id,
    )


def _insert_pending(store: MemoryStore, lesson: str) -> str:
    now = datetime.now(timezone.utc).isoformat()
    fingerprint = build_content_digest("preference", lesson)
    store._connection.execute(
        """
        INSERT INTO pending_memory_candidates (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            confidence, source_excerpt, content_fingerprint, family_key,
            category, created_at, updated_at, project_id
        ) VALUES ('session-1', 'request-1', 'Pending', ?, 'preference', 0.9, '', ?, '', '', ?, ?, ?)
        """,
        (lesson, fingerprint, now, now, GENERAL_PROJECT_ID),
    )
    store._connection.commit()
    return fingerprint


def _write_save_new(store: MemoryStore) -> Callable[[], None]:
    def write() -> None:
        memory, created = _save(store, "The user writes Rust.")
        assert created is True
        assert store.get_memory_by_id(memory.id) is not None

    return write


def _write_save_existing(store: MemoryStore) -> Callable[[], None]:
    first, _created = _save(store, "The user prefers tea.")

    def write() -> None:
        memory, created = _save(store, "The user prefers tea.")
        assert (memory.id, created) == (first.id, False)

    return write


def _write_update(store: MemoryStore) -> Callable[[], None]:
    memory, _created = _save(store, "The user prefers tea.")

    def write() -> None:
        updated = store.update_memory(
            memory_id=memory.id, title="Preference: coffee", lesson_text="The user prefers coffee."
        )
        assert updated.lesson_text == "The user prefers coffee."
        stored = store.get_memory_by_id(memory.id)
        assert stored is not None and stored.lesson_text == "The user prefers coffee."

    return write


def _write_delete(store: MemoryStore) -> Callable[[], None]:
    memory, _created = _save(store, "Forget me.")

    def write() -> None:
        assert store.delete_memory(memory.id) is True
        assert store.get_memory_by_id(memory.id) is None

    return write


def _write_delete_pending(store: MemoryStore) -> Callable[[], None]:
    fingerprint = _insert_pending(store, "Pending lesson.")

    def write() -> None:
        assert (
            store.delete_pending_candidate(session_id="session-1", content_fingerprint=fingerprint)
            is True
        )
        page, _cursor = store.get_pending_candidates_page(limit=10)
        assert page == []

    return write


def _write_move(store: MemoryStore) -> Callable[[], None]:
    memory, _created = _save(store, "Alpha lesson.", project_id=PROJECT_ALPHA)

    def write() -> None:
        result = store.move_project_memories(
            source_project_id=PROJECT_ALPHA, target_project_id=GENERAL_PROJECT_ID
        )
        assert result == {"moved": 1, "merged": 0, "pending_moved": 0}
        assert store.get_memory_by_id(memory.id, project_id=GENERAL_PROJECT_ID) is not None

    return write


_WRITES = {
    "save_new": _write_save_new,
    "save_existing": _write_save_existing,
    "update": _write_update,
    "delete": _write_delete,
    "delete_pending": _write_delete_pending,
    "move_project": _write_move,
}


@pytest.mark.parametrize("write_name", sorted(_WRITES))
def test_a_committed_write_returns_normally_when_due_maintenance_fails(
    write_name: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        write = _WRITES[write_name](store)
        calls = 0

        def failing_maintenance(**_kwargs: object) -> dict[str, object]:
            nonlocal calls
            calls += 1
            raise OSError("disk went away during maintenance")

        # Due on the very next write, through the real scheduling path.
        monkeypatch.setattr(store, "_perform_maintenance", failing_maintenance)
        store._successful_mutations = MEMORY_MAINTENANCE_MUTATION_INTERVAL

        with caplog.at_level(logging.WARNING, logger="sidecar.ai.memory.store"):
            write()

        assert calls == 1, "maintenance ran, after the commit"
        assert "memory_post_commit_bookkeeping_failed" in caplog.text
        assert "OSError" in caplog.text
    finally:
        store.close()


def test_failed_maintenance_stays_due_and_later_writes_keep_working(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        real_maintenance = store._perform_maintenance
        failures = 0

        def failing_once(**kwargs: object) -> dict[str, object]:
            nonlocal failures
            if failures == 0:
                failures += 1
                raise RuntimeError("unexpected maintenance failure")
            return real_maintenance(**kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(store, "_perform_maintenance", failing_once)
        store._successful_mutations = MEMORY_MAINTENANCE_MUTATION_INTERVAL

        first, _created = _save(store, "First lesson.")
        assert store._successful_mutations > MEMORY_MAINTENANCE_MUTATION_INTERVAL, "still due"

        second, _created = _save(store, "Second lesson.")
        assert store._successful_mutations == 0, "the retry ran and reset the schedule"
        assert {memory.id for memory in store.get_all_memories()} == {first.id, second.id}
    finally:
        store.close()


def test_an_error_inside_the_transaction_still_fails_the_write_and_rolls_back(
    tmp_path: Path,
) -> None:
    """The guard covers what follows the commit, never the write itself."""
    store = MemoryStore(tmp_path / "memory.db")
    fingerprint = build_content_digest("preference", "Never stored.")
    try:
        with pytest.raises(RuntimeError, match="inside the transaction"):
            with store._write_transaction():
                store._connection.execute(
                    "INSERT INTO memory_suppressions (project_id, content_fingerprint, reason,"
                    " created_at) VALUES (?, ?, 'forgotten', '2026-10-02T00:00:00+00:00')",
                    (GENERAL_PROJECT_ID, fingerprint),
                )
                raise RuntimeError("inside the transaction")
        assert store.is_memory_suppressed(fingerprint, project_id=GENERAL_PROJECT_ID) is False
        assert store._successful_mutations == 0, "a failed write is not counted"
    finally:
        store.close()
