"""Project archive (owner decision 2): the desktop project delete.

Deleting a project archives its memories: every active row is archived and
stays restorable, pending candidates go, and every later write for that
project is refused until the project is unarchived. (The old project-move
shim was retired with memory.move_project.)
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_MEMORY_PROJECT_ARCHIVED
from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, build_text_digest
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.exceptions import MemoryStoreError
from tests.sidecar.ai.memory.memory_v9_helpers import (
    OTHER_PROJECT,
    PROJECT,
    WallClock,
    find_row,
    next_operation_id,
    remember,
    saved_id,
)


@pytest.fixture
def store(tmp_path: Path) -> Iterator[MemoryStore]:
    memory_store = MemoryStore(tmp_path / "memory.db", clock=WallClock())
    try:
        yield memory_store
    finally:
        memory_store.close()


def _insert_pending(store: MemoryStore, *, project_id: str, lesson: str) -> None:
    store._connection.execute(
        """
        INSERT INTO pending_memory_candidates (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            confidence, source_excerpt, content_fingerprint,
            category, created_at, updated_at, project_id
        ) VALUES ('session-1', 'request-1', 'Pending', ?, 'preference', 0.9, '', ?, '',
                  '2026-10-14T00:00:00+00:00', '2026-10-14T00:00:00+00:00', ?)
        """,
        (lesson, build_text_digest(lesson), project_id),
    )
    store._connection.commit()


def _pending_count(store: MemoryStore, project_id: str) -> int:
    row = store._connection.execute(
        "SELECT COUNT(*) FROM pending_memory_candidates WHERE project_id = ?",
        (project_id,),
    ).fetchone()
    return int(row[0])


def _restore(store: MemoryStore, memory_id: int):
    return store.restore(operation_id=next_operation_id(), project_id=PROJECT, memory_id=memory_id)


def test_archive_marks_every_active_row_and_drops_pending(store: MemoryStore) -> None:
    first = saved_id(remember(store, "Alpha deploys on Tuesdays", kind="routine"))
    second = saved_id(remember(store, "Alpha uses pnpm", kind="convention"))
    kept = saved_id(remember(store, "Beta uses poetry", project_id=OTHER_PROJECT))
    _insert_pending(store, project_id=PROJECT, lesson="Alpha pending lesson")
    _insert_pending(store, project_id=OTHER_PROJECT, lesson="Beta pending lesson")

    counts = store.archive_project(PROJECT)

    assert counts["archived"] == 2
    assert counts["pending_deleted"] == 1
    for memory_id in (first, second):
        row = find_row(store, memory_id, project_id=PROJECT)
        assert row is not None
        assert (row.status, row.revision) == ("archived", 2)
        assert row.archived_at
    assert store.list_active(project_id=PROJECT, include_general=False)[0] == []
    assert len(store.list_archived(project_id=PROJECT, include_general=False)[0]) == 2
    other = find_row(store, kept, project_id=OTHER_PROJECT)
    assert other is not None and other.status == "active"
    assert _pending_count(store, PROJECT) == 0
    assert _pending_count(store, OTHER_PROJECT) == 1


def test_writes_to_an_archived_project_are_refused(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Alpha ships weekly", kind="decision"))
    store.archive_project(PROJECT)

    write = remember(store, "Alpha ships daily", kind="decision")
    restore = _restore(store, memory_id)

    for result in (write, restore):
        assert (result.status, result.reason) == ("refused", "project_archived")
        assert result.code == CMP_MEMORY_PROJECT_ARCHIVED
    assert remember(store, "General still works", project_id=GENERAL_PROJECT_ID).status == "saved"


def test_update_and_forget_of_an_archived_project_row_report_the_fence(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Alpha ships weekly", kind="decision"))
    store.archive_project(PROJECT)

    update = store.update(
        operation_id="op:update", project_id=PROJECT, memory_id=memory_id, text="Alpha ships daily",
        expected_revision=None, origin="user",
    )
    forget = store.forget(
        operation_id="op:forget", project_id=PROJECT, memory_id=memory_id, expected_revision=None,
        origin="user",
    )

    for result in (update, forget):
        assert (result.status, result.reason) == ("refused", "project_archived")


def test_restore_is_allowed_only_after_unarchive(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Alpha prefers squash merges", kind="convention"))
    store.archive_project(PROJECT)
    assert _restore(store, memory_id).reason == "project_archived"

    store.unarchive_project(PROJECT)
    restored = _restore(store, memory_id)

    assert restored.status == "saved"
    assert restored.memory is not None
    assert (restored.memory.status, restored.memory.revision) == ("active", 3)
    still_archived = store.list_archived(project_id=PROJECT, include_general=False)[0]
    assert still_archived == []


def test_archive_is_idempotent_and_general_cannot_be_archived(store: MemoryStore) -> None:
    remember(store, "Alpha uses tabs", kind="convention")

    assert store.archive_project(PROJECT)["archived"] == 1
    assert store.archive_project(PROJECT)["archived"] == 0
    with pytest.raises(ValueError):
        store.archive_project(GENERAL_PROJECT_ID)
    with pytest.raises(ValueError):
        store.archive_project("alpha")


def test_archived_project_rows_survive_the_archived_retention_window(
    tmp_path: Path,
) -> None:
    clock = WallClock()
    store = MemoryStore(tmp_path / "memory.db", clock=clock)
    try:
        memory_id = saved_id(remember(store, "Alpha keeps a changelog", kind="convention"))
        store.archive_project(PROJECT)
        clock.advance(days=45)
        store._perform_maintenance(
            max_age_days=180, max_rows_per_table=10_000, max_db_bytes=1 << 30,
            apply_age_retention=True,
        )
        assert find_row(store, memory_id, project_id=PROJECT) is not None
    finally:
        store.close()


def test_service_exposes_archive_through_the_approved_api(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        service = MemoryService(store)
        assert service.approved is not None
        remember(store, "Alpha via the service", kind="fact")
        assert service.approved.archive_project(PROJECT)["archived"] == 1
        assert service.approved.unarchive_project(PROJECT) is True
    finally:
        store.close()


def test_delete_archive_then_reinitialize_keeps_the_store_available(tmp_path: Path) -> None:
    """NF4: an archive as the first write after a side-by-side reopen leaves a healthy WAL."""
    from sidecar.ai.memory.unavailable import open_memory_store

    db_path = tmp_path / "memory.db"
    first = MemoryStore(db_path)
    for index in range(4):
        remember(first, f"Recheck lesson {index} about tea.", kind="fact")
    second = MemoryStore(db_path)
    first.close()
    try:
        assert second.archive_project(PROJECT) == {"archived": 4, "pending_deleted": 0}
        third = open_memory_store(db_path)
        try:
            assert isinstance(third, MemoryStore), third.status_payload()
            assert third.status_snapshot(project_id=PROJECT)["counts"]["archived"] == 4
        finally:
            third.close()
    finally:
        second.close()


# --- restore into another project (row 58 W4, owner pick "Restore to…") ----


def _restore_to(store: MemoryStore, memory_id: int, target: str, operation_id: str | None = None):
    return store.restore_to(
        operation_id=operation_id or next_operation_id(), project_id=PROJECT,
        memory_id=memory_id, target_project_id=target,
    )


def test_restore_to_moves_a_deleted_projects_row_into_a_live_project(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Alpha prefers squash merges", kind="convention"))
    store.archive_project(PROJECT)
    op_id = next_operation_id()

    moved = _restore_to(store, memory_id, OTHER_PROJECT, op_id)

    assert moved.status == "saved"
    assert moved.memory is not None
    assert (moved.memory.project_id, moved.memory.status) == (OTHER_PROJECT, "active")
    active = store.list_active(project_id=OTHER_PROJECT, include_general=False)[0]
    assert [row.id for row in active] == [memory_id]
    assert store.list_archived(project_id=PROJECT, include_general=False)[0] == []
    replay = _restore_to(store, memory_id, OTHER_PROJECT, op_id)
    assert (replay.status, replay.memory.id if replay.memory else None) == ("saved", memory_id)
    # The deleted project stays fenced for every other write.
    assert remember(store, "Alpha uses rebase", origin="user").reason == "project_archived"


def test_restore_to_general_and_its_undo_forgets_it_there(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Alpha prefers squash merges", kind="convention"))
    store.archive_project(PROJECT)
    op_id = next_operation_id()
    assert _restore_to(store, memory_id, GENERAL_PROJECT_ID, op_id).status == "saved"

    undone = store.undo(
        operation_id=op_id, undo_operation_id=next_operation_id(), project_id=GENERAL_PROJECT_ID
    )

    assert undone.status == "saved"
    row = find_row(store, memory_id, project_id=GENERAL_PROJECT_ID)
    assert row is not None and row.status == "archived"


def test_restore_to_lifts_the_targets_suppression_of_the_same_text(store: MemoryStore) -> None:
    text = "Alpha prefers squash merges"
    memory_id = saved_id(remember(store, text, origin="user"))
    store.archive_project(PROJECT)
    other_id = saved_id(remember(store, text, project_id=OTHER_PROJECT, origin="user"))
    store.forget(
        operation_id=next_operation_id(), project_id=OTHER_PROJECT, memory_id=other_id,
        expected_revision=None, origin="user",
    )

    assert _restore_to(store, memory_id, OTHER_PROJECT).status == "saved"
    assert remember(store, text, project_id=OTHER_PROJECT).duplicate is True


def test_restore_to_refusals(store: MemoryStore) -> None:
    live_id = saved_id(remember(store, "Beta keeps a changelog", project_id=OTHER_PROJECT))
    store.forget(
        operation_id=next_operation_id(), project_id=OTHER_PROJECT, memory_id=live_id,
        expected_revision=None, origin="user",
    )
    with pytest.raises(MemoryStoreError, match="restores in place"):
        store.restore_to(
            operation_id=next_operation_id(), project_id=OTHER_PROJECT, memory_id=live_id,
            target_project_id=GENERAL_PROJECT_ID,
        )

    shared_id = saved_id(remember(store, "Alpha prefers squash merges"))
    chat_id = saved_id(remember(store, "Drafting the alpha toast", scope_session_id="chat-1"))
    twin_id = saved_id(remember(store, "Alpha runs nightly builds"))
    remember(store, "Alpha runs nightly builds", project_id=GENERAL_PROJECT_ID)
    store.archive_project(PROJECT)
    store.archive_project("project_gamma")

    assert _restore_to(store, shared_id, PROJECT).reason == "project_archived"
    assert _restore_to(store, shared_id, "project_gamma").reason == "project_archived"
    with pytest.raises(MemoryStoreError, match="chat note"):
        _restore_to(store, chat_id, OTHER_PROJECT)
    assert _restore_to(store, twin_id, GENERAL_PROJECT_ID).reason == "already_remembered"
    assert _restore_to(store, 999_999, OTHER_PROJECT).reason == "not_found"
