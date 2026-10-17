"""Failure gates for the schema v9 write path (replay, CAS, protection, undo)."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_MEMORY_ALWAYS_ON_FULL,
    CMP_MEMORY_CAPACITY_EXCEEDED,
    CMP_MEMORY_OPERATION_EXPIRED,
    CMP_MEMORY_OPERATION_MISMATCH,
    CMP_MEMORY_PROTECTED,
    CMP_MEMORY_STALE_REVISION,
    CMP_MEMORY_SUPPRESSED,
)
from sidecar.ai.memory import store_writes
from sidecar.ai.memory.contracts import (
    ALWAYS_ON_BUDGET_CHARS,
    ALWAYS_ON_HEADING_RESERVE,
    ALWAYS_ON_ROW_OVERHEAD,
    GENERAL_PROJECT_ID,
)
from sidecar.ai.memory.store import MemoryStore
from tests.sidecar.ai.memory.memory_v9_helpers import (
    OTHER_PROJECT,
    PROJECT,
    WallClock,
    find_row,
    next_operation_id,
    operation_count,
    remember,
    saved_id,
    suppression_count,
)


@pytest.fixture
def clock() -> WallClock:
    return WallClock()


@pytest.fixture
def store(tmp_path: Path, clock: WallClock) -> Iterator[MemoryStore]:
    memory_store = MemoryStore(tmp_path / "memory.db", clock=clock)
    try:
        yield memory_store
    finally:
        memory_store.close()


def _forget(store: MemoryStore, memory_id: int, *, origin: str = "user", revision=None):
    return store.forget(
        operation_id=next_operation_id(),
        project_id=PROJECT,
        memory_id=memory_id,
        expected_revision=revision,
        origin=origin,
    )


def test_replay_with_matching_payload_returns_the_stored_response(store: MemoryStore) -> None:
    first = remember(store, "Prefers green tea in the morning", operation_id="op-replay")
    replay = remember(store, "Prefers green tea in the morning", operation_id="op-replay")

    assert first.status == "saved" and first.undoable and not first.replayed
    assert replay.status == "saved"
    assert replay.replayed is True
    assert replay.operation_id == "op-replay"
    assert replay.memory is not None and first.memory is not None
    assert replay.memory.id == first.memory.id
    assert replay.memory.revision == first.memory.revision
    assert len(store.list_active(project_id=PROJECT)[0]) == 1
    assert operation_count(store) == 1


def test_replay_with_a_different_payload_is_refused(store: MemoryStore) -> None:
    remember(store, "Prefers green tea", operation_id="op-mismatch")

    result = remember(store, "Prefers black coffee", operation_id="op-mismatch")

    assert (result.status, result.reason) == ("refused", "operation_mismatch")
    assert result.code == CMP_MEMORY_OPERATION_MISMATCH
    assert len(store.list_active(project_id=PROJECT)[0]) == 1


def test_an_operation_past_its_retry_window_is_refused(
    store: MemoryStore, clock: WallClock
) -> None:
    remember(store, "Prefers green tea", operation_id="op-expiring")
    clock.advance(hours=25)

    result = remember(store, "Prefers green tea", operation_id="op-expiring")

    assert (result.status, result.reason) == ("refused", "operation_expired")
    assert result.code == CMP_MEMORY_OPERATION_EXPIRED


def test_update_with_a_stale_revision_conflicts(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Uses tabs"))
    store.update(
        operation_id=next_operation_id(),
        project_id=PROJECT,
        memory_id=memory_id,
        text="Uses four spaces",
        expected_revision=1,
        origin="jenny",
    )

    result = store.update(
        operation_id=next_operation_id(),
        project_id=PROJECT,
        memory_id=memory_id,
        text="Uses two spaces",
        expected_revision=1,
        origin="jenny",
    )

    assert (result.status, result.reason) == ("conflict", "stale_revision")
    assert result.code == CMP_MEMORY_STALE_REVISION
    assert result.memory is not None and result.memory.lesson_text == "Uses four spaces"
    assert result.memory.revision == 2


def test_jenny_cannot_change_a_protected_row_and_a_user_update_protects(
    store: MemoryStore,
) -> None:
    memory_id = saved_id(remember(store, "Lives in Lisbon", kind="fact"))
    user_edit = store.update(
        operation_id=next_operation_id(),
        project_id=PROJECT,
        memory_id=memory_id,
        text="Lives in Porto",
        expected_revision=1,
        origin="user",
    )
    assert user_edit.status == "saved"
    assert user_edit.memory is not None and user_edit.memory.protected is True

    jenny_edit = store.update(
        operation_id=next_operation_id(),
        project_id=PROJECT,
        memory_id=memory_id,
        text="Lives in Madrid",
        expected_revision=2,
        origin="jenny",
    )
    jenny_forget = _forget(store, memory_id, origin="jenny", revision=2)

    for result in (jenny_edit, jenny_forget):
        assert (result.status, result.reason) == ("refused", "protected")
        assert result.code == CMP_MEMORY_PROTECTED
    current = find_row(store, memory_id, project_id=PROJECT)
    assert current is not None and current.lesson_text == "Lives in Porto"
    assert current.status == "active"


def test_forget_suppresses_jenny_but_not_the_user(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Drinks oat milk"))
    forgotten = _forget(store, memory_id, revision=1)
    assert forgotten.status == "saved"
    assert forgotten.memory is not None and forgotten.memory.status == "archived"
    assert suppression_count(store) == 1

    jenny = remember(store, "drinks  OAT milk.")
    assert (jenny.status, jenny.reason) == ("refused", "suppressed")
    assert jenny.code == CMP_MEMORY_SUPPRESSED

    user = remember(store, "Drinks oat milk", origin="user")
    assert user.status == "saved" and not user.duplicate
    assert suppression_count(store) == 0


def test_duplicate_add_returns_the_existing_row_without_an_operation(
    store: MemoryStore,
) -> None:
    first = remember(store, "Likes rust")
    before = operation_count(store)

    duplicate = remember(store, "likes   Rust.", kind="fact")

    assert duplicate.status == "saved"
    assert duplicate.duplicate is True
    assert duplicate.undoable is False
    assert duplicate.operation_id is None
    assert duplicate.memory is not None and first.memory is not None
    assert duplicate.memory.id == first.memory.id
    assert operation_count(store) == before


def test_undo_forget_restores_the_row_and_removes_the_suppression(
    store: MemoryStore,
) -> None:
    memory_id = saved_id(remember(store, "Takes the 8:15 train"))
    forgotten = _forget(store, memory_id, revision=1)

    undone = store.undo(operation_id=forgotten.operation_id, undo_operation_id="undo-1")

    assert undone.status == "saved"
    assert undone.memory is not None and undone.memory.status == "active"
    assert undone.memory.revision == 3
    assert suppression_count(store) == 0
    assert remember(store, "Takes the 8:15 train").duplicate is True


def test_undo_forget_conflicts_when_a_newer_suppression_exists(
    store: MemoryStore, clock: WallClock
) -> None:
    first_id = saved_id(remember(store, "Plays chess on Sundays"))
    first_forget = _forget(store, first_id, revision=1)
    second_id = saved_id(remember(store, "Plays chess on Sundays", origin="user"))
    clock.advance(minutes=5)
    _forget(store, second_id, revision=1)

    result = store.undo(operation_id=first_forget.operation_id, undo_operation_id="undo-2")

    assert result.status == "conflict"
    current = find_row(store, first_id, project_id=PROJECT)
    assert current is not None and current.status == "archived"
    assert suppression_count(store) == 1


def test_undo_update_into_a_suppressed_digest_is_refused(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Prefers vim"))
    updated = store.update(
        operation_id=next_operation_id(),
        project_id=PROJECT,
        memory_id=memory_id,
        text="Prefers emacs",
        expected_revision=1,
        origin="jenny",
    )
    other_id = saved_id(remember(store, "Prefers vim"))
    _forget(store, other_id, revision=1)

    result = store.undo(operation_id=updated.operation_id, undo_operation_id="undo-3")

    assert (result.status, result.reason) == ("refused", "suppressed")
    current = find_row(store, memory_id, project_id=PROJECT)
    assert current is not None and current.lesson_text == "Prefers emacs"


def test_undo_remember_archives_without_suppressing(store: MemoryStore) -> None:
    created = remember(store, "Owns a cat named Miso", kind="fact")

    undone = store.undo(operation_id=created.operation_id, undo_operation_id="undo-4")

    assert undone.status == "saved"
    assert undone.memory is not None and undone.memory.status == "archived"
    assert suppression_count(store) == 0
    assert remember(store, "Owns a cat named Miso", kind="fact").status == "saved"


def test_undo_twice_is_not_found_unless_it_replays_the_same_undo(store: MemoryStore) -> None:
    created = remember(store, "Works remotely on Fridays", kind="routine")
    first = store.undo(operation_id=created.operation_id, undo_operation_id="undo-5")

    again = store.undo(operation_id=created.operation_id, undo_operation_id="undo-6")
    replay = store.undo(operation_id=created.operation_id, undo_operation_id="undo-5")

    assert first.status == "saved"
    assert (again.status, again.reason) == ("refused", "not_found")
    assert replay.status == "saved" and replay.replayed is True


def test_a_duplicate_add_has_nothing_to_undo(store: MemoryStore) -> None:
    remember(store, "Speaks Portuguese", kind="fact")
    duplicate = remember(store, "Speaks Portuguese", kind="fact")

    result = store.undo(operation_id=duplicate.operation_id or "missing", undo_operation_id="u")

    assert (result.status, result.reason) == ("refused", "not_found")


def test_projects_are_isolated_and_general_reaches_both(store: MemoryStore) -> None:
    remember(store, "Alpha uses pnpm workspaces", kind="convention")
    remember(store, "Beta uses poetry workspaces", kind="convention", project_id=OTHER_PROJECT)
    remember(store, "General likes concise workspaces", project_id=GENERAL_PROJECT_ID)

    alpha_rows, _ = store.list_active(project_id=PROJECT)
    beta_rows, _ = store.list_active(project_id=OTHER_PROJECT)
    alpha_recall = store.recall_memories("workspaces", limit=5, project_id=PROJECT, include_general=True)

    assert {row.lesson_text for row in alpha_rows} == {
        "Alpha uses pnpm workspaces",
        "General likes concise workspaces",
    }
    assert {row.lesson_text for row in beta_rows} == {
        "Beta uses poetry workspaces",
        "General likes concise workspaces",
    }
    assert {row.project_id for row in alpha_recall} == {PROJECT, GENERAL_PROJECT_ID}


def test_chat_scope_rows_never_recall_in_another_session(store: MemoryStore) -> None:
    remember(store, "Debugging the flaky parser test", scope_session_id="chat-a", session_id="chat-a")
    remember(store, "Parser rewrite ships next week", kind="decision")

    in_a = store.recall_memories("parser", limit=5, project_id=PROJECT, scope_session_id="chat-a")
    in_b = store.recall_memories("parser", limit=5, project_id=PROJECT, scope_session_id="chat-b")
    listed_b, _ = store.list_active(project_id=PROJECT, scope_session_id="chat-b")

    assert {row.lesson_text for row in in_a} == {
        "Debugging the flaky parser test",
        "Parser rewrite ships next week",
    }
    assert [row.lesson_text for row in in_b] == ["Parser rewrite ships next week"]
    assert [row.lesson_text for row in listed_b] == ["Parser rewrite ships next week"]


def test_always_on_overflow_is_refused_with_the_current_lines(store: MemoryStore) -> None:
    usable = ALWAYS_ON_BUDGET_CHARS - ALWAYS_ON_HEADING_RESERVE
    general_text = "G" * 400
    project_text = "P" * 400
    used = len(general_text) + len(project_text) + 2 * ALWAYS_ON_ROW_OVERHEAD
    overflowing = "B" * (usable - used - ALWAYS_ON_ROW_OVERHEAD + 1)
    assert remember(store, general_text, project_id=GENERAL_PROJECT_ID, always_on=True).status == "saved"
    assert remember(store, project_text, always_on=True).status == "saved"
    fitting = remember(store, "F" * (usable - used - ALWAYS_ON_ROW_OVERHEAD), project_id=OTHER_PROJECT, always_on=True)
    assert fitting.status == "saved"

    result = remember(store, overflowing, always_on=True)

    assert (result.status, result.reason) == ("refused", "always_on_full")
    assert result.code == CMP_MEMORY_ALWAYS_ON_FULL
    assert result.always_on_lines == (general_text, project_text)
    assert [row.lesson_text for row in store.always_on_rows(PROJECT)] == [general_text, project_text]
    assert remember(store, overflowing).status == "saved"


def test_capacity_is_refused_at_the_active_row_cap(
    store: MemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store_writes, "MAX_ACTIVE_MEMORIES", 2)
    remember(store, "First durable fact", kind="fact")
    remember(store, "Second durable fact", kind="fact", project_id=OTHER_PROJECT)

    result = remember(store, "Third durable fact", kind="fact")

    assert (result.status, result.reason) == ("refused", "capacity")
    assert result.code == CMP_MEMORY_CAPACITY_EXCEEDED


def test_erase_keeps_a_content_free_stub_that_refuses_replay(store: MemoryStore) -> None:
    created = remember(store, "Secret project codename Bluebird", operation_id="op-erase")
    assert created.memory is not None

    assert store.erase(project_id=PROJECT, memory_id=created.memory.id) is True

    stub = store._connection.execute(
        "SELECT stub, prior_json, response_json FROM memory_operations WHERE operation_id = ?",
        ("op-erase",),
    ).fetchone()
    assert tuple(stub) == (1, "", "")
    replay = remember(store, "Secret project codename Bluebird", operation_id="op-erase")
    assert (replay.status, replay.reason) == ("refused", "operation_expired")
    assert find_row(store, created.memory.id, project_id=PROJECT) is None


def test_operations_list_and_retention_stubs_expired_rows(
    store: MemoryStore, clock: WallClock
) -> None:
    created = remember(store, "Reads on the train")
    operations = store.list_operations(project_id=PROJECT)
    assert [entry["operation_id"] for entry in operations] == [created.operation_id]
    assert "Reads on the train" not in repr(operations)

    clock.advance(hours=25)
    store._perform_maintenance(
        max_age_days=180, max_rows_per_table=10_000, max_db_bytes=1 << 30, apply_age_retention=True
    )
    assert store.list_operations(project_id=PROJECT) == []
    clock.advance(hours=25)
    store._perform_maintenance(
        max_age_days=180, max_rows_per_table=10_000, max_db_bytes=1 << 30, apply_age_retention=True
    )
    assert operation_count(store) == 0


def test_archived_rows_are_purged_after_the_retention_window(
    store: MemoryStore, clock: WallClock
) -> None:
    memory_id = saved_id(remember(store, "Old gym schedule", kind="routine"))
    _forget(store, memory_id, revision=1)
    assert len(store.list_archived(project_id=PROJECT)[0]) == 1

    clock.advance(days=31)
    store._perform_maintenance(
        max_age_days=180, max_rows_per_table=10_000, max_db_bytes=1 << 30, apply_age_retention=True
    )

    assert store.list_archived(project_id=PROJECT)[0] == []
    assert suppression_count(store) == 1
