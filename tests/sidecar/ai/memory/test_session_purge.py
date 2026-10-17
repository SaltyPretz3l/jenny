"""Session purge: a deleted chat takes its chat-scope memory with it."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_MEMORY_SESSION_PURGED
from sidecar.ai.memory.contracts import build_text_digest
from sidecar.ai.memory.store import MemoryStore
from tests.sidecar.ai.memory.memory_v9_helpers import (
    PROJECT,
    WallClock,
    find_row,
    remember,
    saved_id,
    update_row,
)

CHAT = "chat-purged"
OTHER_CHAT = "chat-kept"


@pytest.fixture
def store(tmp_path: Path) -> Iterator[MemoryStore]:
    memory_store = MemoryStore(tmp_path / "memory.db", clock=WallClock())
    try:
        yield memory_store
    finally:
        memory_store.close()


def _seed_cursor(store: MemoryStore, session_id: str) -> None:
    store._connection.execute(
        """
        INSERT INTO memory_reflection_cursor (
            session_id, project_id, message_count, last_message_id, window_fingerprint,
            session_incarnation, turn_generation, updated_at
        ) VALUES (?, ?, 4, 'message-4', 'sha256:window', 1, 2, '2026-10-14T00:00:00+00:00')
        """,
        (session_id, PROJECT),
    )
    store._connection.commit()


def _seed_pending(store: MemoryStore, session_id: str, lesson: str) -> None:
    store._connection.execute(
        """
        INSERT INTO pending_memory_candidates (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            confidence, source_excerpt, content_fingerprint, category,
            created_at, updated_at, project_id
        ) VALUES (?, 'request-1', 'Pending', ?, 'fact', 0.8, '', ?, '',
                  '2026-10-14T00:00:00+00:00', '2026-10-14T00:00:00+00:00', ?)
        """,
        (session_id, lesson, build_text_digest(lesson), PROJECT),
    )
    store._connection.commit()


def _count(store: MemoryStore, sql: str, *params: object) -> int:
    return int(store._connection.execute(sql, params).fetchone()[0])


def test_purge_removes_chat_scope_state_and_keeps_project_rows(store: MemoryStore) -> None:
    chat_row = remember(
        store, "Halfway through the migration plan", session_id=CHAT, scope_session_id=CHAT
    )
    other_chat = saved_id(
        remember(store, "Reviewing the parser", session_id=OTHER_CHAT, scope_session_id=OTHER_CHAT)
    )
    project_row = saved_id(remember(store, "Uses conventional commits", session_id=CHAT))
    _seed_cursor(store, CHAT)
    _seed_cursor(store, OTHER_CHAT)
    _seed_pending(store, CHAT, "Pending from the purged chat")
    _seed_pending(store, OTHER_CHAT, "Pending from the kept chat")

    counts = store.purge_session(CHAT)

    assert counts == {"memories": 1, "operations": 1, "pending": 1, "cursor": 1,
                      "sources_removed": 1}
    assert chat_row.memory is not None
    assert find_row(store, chat_row.memory.id, project_id=PROJECT, scope_session_id=CHAT) is None
    assert find_row(store, other_chat, project_id=PROJECT, scope_session_id=OTHER_CHAT) is not None
    assert find_row(store, project_row, project_id=PROJECT) is not None
    assert _count(store, "SELECT COUNT(*) FROM memory_reflection_cursor") == 1
    assert _count(store, "SELECT COUNT(*) FROM pending_memory_candidates") == 1
    stub = store._connection.execute(
        "SELECT stub, prior_json, response_json FROM memory_operations WHERE operation_id = ?",
        (chat_row.operation_id,),
    ).fetchone()
    assert tuple(stub) == (1, "", "")
    assert store.is_session_purged(CHAT) is True
    assert store.is_session_purged(OTHER_CHAT) is False


def test_chat_scope_writes_after_a_purge_are_refused(store: MemoryStore) -> None:
    store.purge_session(CHAT)

    result = remember(store, "Late chat note", session_id=CHAT, scope_session_id=CHAT)

    assert (result.status, result.reason) == ("refused", "session_purged")
    assert result.code == CMP_MEMORY_SESSION_PURGED
    assert remember(store, "Project row from that chat", session_id=CHAT).status == "saved"


def test_purge_is_idempotent(store: MemoryStore) -> None:
    remember(store, "Chat-only scratch note", session_id=CHAT, scope_session_id=CHAT)

    first = store.purge_session(CHAT)
    second = store.purge_session(CHAT)

    assert first["memories"] == 1
    assert second == {"memories": 0, "operations": 0, "pending": 0, "cursor": 0,
                      "sources_removed": 0}
    assert _count(store, "SELECT COUNT(*) FROM memory_session_markers") == 1
    with pytest.raises(ValueError):
        store.purge_session("")


@pytest.mark.parametrize("status,provenance", [("active", "reflection"),
                                               ("archived", "reflection"),
                                               ("active", "source_removed")])
def test_purge_marks_derived_shared_sources_without_changing_content_or_ledger(
    store: MemoryStore, status: str, provenance: str,
) -> None:
    derived = saved_id(remember(
        store, "Uses conventional commits for parser changes.", session_id=CHAT,
        origin="reflection", provenance=provenance, source_excerpt="We use conventional commits.",
        source_message_ids=("m-1", "m-2"),
    ))
    other = saved_id(remember(
        store, "Uses tabs for Python code.", session_id=OTHER_CHAT, origin="reflection",
        provenance="reflection", source_excerpt="I use tabs.", source_message_ids=("m-other",),
    ))
    store._connection.execute(
        "UPDATE memories SET status = ?, archived_at = ?, "
        "updated_at = '2026-10-13T00:00:00+00:00' WHERE id = ?",
        (status, "2026-10-13T00:00:00+00:00" if status == "archived" else None, derived),
    )
    store._connection.commit()
    before = store._connection.execute("SELECT * FROM memories WHERE id = ?", (other,)).fetchone()
    ledger = store._connection.execute("SELECT * FROM memory_operations ORDER BY operation_id").fetchall()
    original = store._connection.execute(
        "SELECT lesson_text, lesson_kind, origin, status, revision, updated_at FROM memories WHERE id = ?",
        (derived,),
    ).fetchone()

    counts = store.purge_session(CHAT)

    assert counts["sources_removed"] == 1
    row = store._connection.execute(
        "SELECT lesson_text, lesson_kind, origin, status, revision, updated_at, provenance, "
        "source_excerpt, source_message_ids FROM memories WHERE id = ?", (derived,),
    ).fetchone()
    assert row[:5] == original[:5]
    assert row[5] != original[5]
    assert row[6:] == ("source_removed", "", "[]")
    assert store._connection.execute("SELECT * FROM memories WHERE id = ?", (other,)).fetchone() == before
    assert store._connection.execute("SELECT * FROM memory_operations ORDER BY operation_id").fetchall() == ledger
    recalled = store.recall_memories(
        "conventional commits parser", project_id=PROJECT, scope_session_id=OTHER_CHAT
    )
    assert (derived in [item.id for item in recalled]) is (status == "active")
    assert store.purge_session(CHAT)["sources_removed"] == 1


def test_undo_after_a_purge_keeps_the_source_removed(store: MemoryStore) -> None:
    derived = saved_id(remember(
        store, "Uses conventional commits for parser changes.", session_id=CHAT,
        origin="reflection", provenance="reflection", source_excerpt="We use conventional commits.",
        source_message_ids=("m-1",),
    ))
    edited = update_row(
        store, derived, title="Commits", lesson_text="Uses conventional commits everywhere.",
        project_id=PROJECT,
    )
    store.purge_session(CHAT)

    undone = store.undo(
        operation_id=edited.operation_id, undo_operation_id="undo-after-purge", project_id=PROJECT
    )

    assert undone.status == "saved"
    row = store._connection.execute(
        "SELECT lesson_text, provenance, source_excerpt FROM memories WHERE id = ?", (derived,)
    ).fetchone()
    assert row == ("Uses conventional commits for parser changes.", "source_removed", "")


def test_undo_of_a_source_removal_still_restores_the_source(store: MemoryStore) -> None:
    derived = saved_id(remember(
        store, "Uses conventional commits for parser changes.", session_id=OTHER_CHAT,
        origin="reflection", provenance="reflection", source_excerpt="We use conventional commits.",
    ))
    removed = update_row(
        store, derived, title="Commits", lesson_text="Uses conventional commits for parser changes.",
        project_id=PROJECT, remove_provenance=True,
    )

    store.undo(operation_id=removed.operation_id, undo_operation_id="undo-removal", project_id=PROJECT)

    row = store._connection.execute(
        "SELECT provenance, source_excerpt FROM memories WHERE id = ?", (derived,)
    ).fetchone()
    assert row == ("reflection", "We use conventional commits.")
