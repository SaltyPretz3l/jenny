"""Unit tests for sidecar.runtime.memory: request validation, v9 writes, pages, serializers."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_MEMORY_FAILED, CMP_MEMORY_INVALID_KIND
from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, MEMORY_KINDS, build_text_digest
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.exceptions import MemoryStoreError
from sidecar.runtime.memory import (
    MemoryRequestError,
    archive_project_memories,
    clear_memory_suppressions,
    delete_memory,
    delete_pending_memory,
    list_memories_page,
    list_pending_memories_page,
    memory_error_payload,
    purge_session_memories,
    request_operation_id,
    restore_memory,
    save_memory_candidate,
    serialize_write_result,
    undo_memory_operation,
    update_memory,
)
from sidecar.runtime.memory_text import _normalize_title, _sanitize_source_excerpt
from tests.sidecar.ai.memory.memory_v9_helpers import find_row, pending_rows, save_row


def _insert_pending_candidate(  # noqa: PLR0913 - migrated-row fixture mirrors schema.
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
    project_id: str = "project_general",
) -> int:
    timestamp = datetime.now(timezone.utc).isoformat()
    cursor = store._connection.execute(
        """
        INSERT INTO pending_memory_candidates (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            confidence, source_excerpt, content_fingerprint,
            category, created_at, updated_at, project_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            source_request_id,
            title,
            lesson_text,
            lesson_kind,
            confidence,
            source_excerpt,
            build_text_digest(lesson_text),
            category,
            timestamp,
            timestamp,
            project_id,
        ),
    )
    store._connection.commit()
    assert cursor.lastrowid is not None
    return int(cursor.lastrowid)


@pytest.fixture()
def empty_store(tmp_path: Path) -> MemoryStore:
    store = MemoryStore(tmp_path / "memory.db")
    yield store
    store.close()


def _save(store: MemoryStore | MemoryService, text: str, **extra) -> object:
    result = save_memory_candidate(
        session_id=extra.pop("session_id", "session-1"),
        candidate={
            "title": extra.pop("title", None),
            "lesson_text": text,
            "lesson_kind": extra.pop("lesson_kind", "preference"),
            "source_excerpt": extra.pop("source_excerpt", ""),
        },
        memory_store=store,
        **extra,
    )
    assert result.status == "saved", result
    return result


# ---------------------------------------------------------------------------
# text helpers
# ---------------------------------------------------------------------------


def test_normalize_title_truncates_to_120() -> None:
    assert len(_normalize_title("x" * 200)) == 120


def test_source_provenance_sanitization_bounds_input_before_redaction() -> None:
    source = (
        r"C:\Users\Alice\private\notes.txt alice@example.com api_key=sk-test-secret-value "
        + ("private detail " * 10_000)
    )

    excerpt = _sanitize_source_excerpt(source)

    assert len(excerpt) <= 240
    assert "Alice" not in excerpt
    assert "alice@example.com" not in excerpt
    assert "sk-test-secret-value" not in excerpt
    assert "[LOCAL_PATH_REDACTED]" in excerpt
    assert "[EMAIL_REDACTED]" in excerpt


# ---------------------------------------------------------------------------
# operation ids and error payloads
# ---------------------------------------------------------------------------


def test_request_operation_id_generates_rpc_ids_and_validates_supplied_ones() -> None:
    generated = request_operation_id(None)
    assert generated.startswith("rpc:") and generated != request_operation_id(None)
    assert request_operation_id("client.op-1:a_b") == "client.op-1:a_b"
    for bad in ("", "has space", "x" * 129, 3, "op/slash"):
        with pytest.raises(ValueError, match="operation_id is invalid"):
            request_operation_id(bad)


def test_memory_error_payload_keeps_request_and_store_codes() -> None:
    assert memory_error_payload(MemoryRequestError(CMP_MEMORY_INVALID_KIND, "bad"))[
        "code"
    ] == CMP_MEMORY_INVALID_KIND
    assert memory_error_payload(ValueError("plain"))["code"] == CMP_MEMORY_FAILED
    store_error = MemoryStoreError("CMP-MEM-0007", "x" * 500, retryable=True)
    payload = memory_error_payload(store_error)
    assert payload["code"] == "CMP-MEM-0007" and len(str(payload["detail"])) == 240


# ---------------------------------------------------------------------------
# memory.save
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", MEMORY_KINDS)
def test_save_accepts_every_v9_kind(empty_store: MemoryStore, kind: str) -> None:
    result = _save(empty_store, f"The user has a {kind} worth keeping.", lesson_kind=kind)

    assert result.memory.lesson_kind == kind
    assert result.memory.origin == "user"
    assert result.memory.provenance == "user_approved"
    assert result.undoable is True


@pytest.mark.parametrize("kind", ["tool_strategy", "profile", "commitment", "", None, 3])
def test_save_rejects_kinds_outside_the_v9_vocabulary(empty_store: MemoryStore, kind) -> None:
    with pytest.raises(MemoryRequestError) as caught:
        _save(empty_store, "The user prefers tea.", lesson_kind=kind)

    assert caught.value.code == CMP_MEMORY_INVALID_KIND
    assert empty_store.get_all_memories() == []


def test_save_bounds_text_and_requires_a_session(empty_store: MemoryStore) -> None:
    with pytest.raises(ValueError, match="exceeds 400"):
        _save(empty_store, "x" * 401)
    with pytest.raises(ValueError, match="candidate must be an object"):
        save_memory_candidate(session_id="s", candidate=[], memory_store=empty_store)
    with pytest.raises(ValueError, match="session_id"):
        _save(empty_store, "The user prefers tea.", session_id="  ")


def test_save_refuses_credential_shaped_text(empty_store: MemoryStore) -> None:
    with pytest.raises(ValueError, match="credential"):
        save_memory_candidate(
            session_id="s1",
            candidate={"lesson_text": "password: hunter2", "lesson_kind": "fact"},
            memory_store=empty_store,
        )
    assert empty_store.list_active(project_id=GENERAL_PROJECT_ID)[0] == []


def test_save_title_is_optional_and_derived(empty_store: MemoryStore) -> None:
    result = _save(empty_store, "The user prefers tea.")

    assert result.memory.title == "The user prefers tea."


def test_save_replays_one_operation_id(empty_store: MemoryStore) -> None:
    first = _save(empty_store, "The user prefers tea.", operation_id="op-1")
    replay = _save(empty_store, "The user prefers tea.", operation_id="op-1")

    assert replay.replayed is True and replay.memory.id == first.memory.id
    assert len(empty_store.get_all_memories()) == 1


def test_save_chat_scope_and_always_on(empty_store: MemoryStore) -> None:
    scoped = _save(empty_store, "The user is drafting a toast.", scope_session_id="chat-1")
    pinned = _save(empty_store, "The user's name is Sam.", always_on=True)

    assert scoped.memory.scope_session_id == "chat-1"
    assert pinned.memory.always_on is True
    with pytest.raises(ValueError, match="always_on"):
        _save(empty_store, "The user likes jazz.", scope_session_id="chat-1", always_on=True)
    with pytest.raises(ValueError, match="always_on must be a boolean"):
        _save(empty_store, "The user likes jazz.", always_on="yes")


def test_save_bounds_and_redacts_source_provenance(empty_store: MemoryStore) -> None:
    source = (
        r"C:\Users\Alice\secret.txt \\server\private\note.txt /workspace/jenny/plan.md "
        "alice@example.com api_key=sk-test-secret "
        + ("private detail " * 40)
    )

    result = _save(empty_store, "The user prefers concise replies.", source_excerpt=source)

    excerpt = result.memory.source_excerpt
    assert len(excerpt) <= 240
    for leaked in ("Alice", "server", "workspace", "alice@example.com", "sk-test-secret"):
        assert leaked not in excerpt
    assert "[LOCAL_PATH_REDACTED]" in excerpt
    assert "[EMAIL_REDACTED]" in excerpt


def test_save_clears_matching_pending_candidate(empty_store: MemoryStore) -> None:
    _insert_pending_candidate(
        empty_store,
        session_id="session-approved",
        source_request_id="request-approved",
        title="Goal: finish the garden",
        lesson_text="The user's goal is to finish the garden.",
        lesson_kind="fact",
        confidence=0.9,
        source_excerpt="finish the garden",
        category="user",
    )

    _save(
        empty_store,
        "The user's goal is to finish the garden.",
        lesson_kind="fact",
        session_id="session-approved",
    )

    assert pending_rows(empty_store, project_id=GENERAL_PROJECT_ID) == []


def test_save_works_through_the_memory_service(empty_store: MemoryStore) -> None:
    result = _save(MemoryService(empty_store), "The user prefers tea.")

    assert find_row(empty_store, result.memory.id, project_id=GENERAL_PROJECT_ID) == result.memory


# ---------------------------------------------------------------------------
# memory.update / delete / undo / restore
# ---------------------------------------------------------------------------


def test_update_can_remove_source_without_deleting_memory(empty_store: MemoryStore) -> None:
    saved = _save(
        empty_store, "The user prefers tea.", source_excerpt="I prefer tea while working."
    ).memory

    result = update_memory(
        memory_id=saved.id, changes={"remove_provenance": True}, memory_store=empty_store
    )

    updated = result.memory
    assert updated.id == saved.id and updated.lesson_text == saved.lesson_text
    assert updated.source_excerpt == "" and updated.provenance == "source_removed"
    assert find_row(empty_store, saved.id, project_id=GENERAL_PROJECT_ID) == updated


@pytest.mark.parametrize(
    ("changes", "match"),
    [
        ({}, "needs one of"),
        ({"lesson_text": 42}, "lesson_text must be a string"),
        ({"lesson_text": None, "title": None}, "needs one of"),
        ({"title": 7}, "title must be a string"),
        ({"always_on": 1}, "always_on must be a boolean"),
        ({"remove_provenance": "yes"}, "remove_provenance must be a boolean"),
    ],
)
def test_update_rejects_invalid_changes(empty_store: MemoryStore, changes, match: str) -> None:
    saved = _save(empty_store, "The user prefers tea.").memory

    with pytest.raises(ValueError, match=match):
        update_memory(memory_id=saved.id, changes=changes, memory_store=empty_store)


def test_update_rejects_a_bad_kind_with_its_code(empty_store: MemoryStore) -> None:
    saved = _save(empty_store, "The user prefers tea.").memory

    with pytest.raises(MemoryRequestError) as caught:
        update_memory(
            memory_id=saved.id, changes={"lesson_kind": "goal"}, memory_store=empty_store
        )
    assert caught.value.code == CMP_MEMORY_INVALID_KIND


def test_update_in_another_project_is_not_found(empty_store: MemoryStore) -> None:
    saved = _save(empty_store, "The user prefers tea.", project_id="project_alpha").memory

    result = update_memory(
        memory_id=saved.id,
        changes={"title": "Wrong scope"},
        memory_store=empty_store,
        project_id="project_beta",
    )

    assert result.status == "refused" and result.reason == "not_found"


def test_delete_undo_and_restore_round_trip(empty_store: MemoryStore) -> None:
    saved = _save(empty_store, "The user prefers tea.").memory

    deleted = delete_memory(memory_id=str(saved.id), memory_store=empty_store)
    assert deleted.status == "saved" and deleted.memory.status == "archived"
    undone = undo_memory_operation(operation_id=deleted.operation_id, memory_store=empty_store)
    assert undone.status == "saved" and undone.memory.status == "active"

    again = delete_memory(memory_id=saved.id, memory_store=empty_store)
    restored = restore_memory(memory_id=saved.id, memory_store=empty_store)
    assert again.status == "saved" and restored.memory.status == "active"

    with pytest.raises(ValueError, match="operation_id is required"):
        undo_memory_operation(operation_id=None, memory_store=empty_store)
    for bad_id in (0, -1, True, "x", None):
        with pytest.raises(ValueError, match="memory_id"):
            delete_memory(memory_id=bad_id, memory_store=empty_store)
    with pytest.raises(ValueError, match="expected_revision"):
        delete_memory(memory_id=saved.id, memory_store=empty_store, expected_revision=0)


def test_serialize_write_result_carries_reason_code_and_lines(empty_store: MemoryStore) -> None:
    saved = _save(empty_store, "The user prefers tea.").memory
    stale = update_memory(
        memory_id=saved.id,
        changes={"title": "Tea"},
        memory_store=empty_store,
        expected_revision=saved.revision + 5,
    )

    payload = serialize_write_result(stale)

    assert payload["status"] == "conflict" and payload["reason"] == "stale_revision"
    assert payload["code"] == "CMP-MEM-0012"
    assert payload["memory"]["revision"] == saved.revision
    assert "always_on_lines" not in payload
    assert "family_key" not in payload["memory"]


# ---------------------------------------------------------------------------
# lifecycle helpers
# ---------------------------------------------------------------------------


def test_archive_purge_and_clear_suppressions(empty_store: MemoryStore) -> None:
    _save(empty_store, "The user writes Rust.", project_id="project_alpha")
    _save(empty_store, "The user is drafting a toast.", scope_session_id="chat-1")
    forgotten = _save(empty_store, "Forget me.").memory
    delete_memory(memory_id=forgotten.id, memory_store=empty_store)

    assert archive_project_memories(memory_store=empty_store, project_id="project_alpha") == {
        "ok": True,
        "archived": 1,
        "pending_removed": 0,
    }
    with pytest.raises(ValueError):
        archive_project_memories(memory_store=empty_store, project_id=GENERAL_PROJECT_ID)
    assert purge_session_memories(session_id="chat-1", memory_store=empty_store) == {
        "ok": True,
        "removed": 1,
    }
    for bad_session in (None, "  ", 5):
        with pytest.raises(ValueError, match="session_id"):
            purge_session_memories(session_id=bad_session, memory_store=empty_store)
    assert clear_memory_suppressions(memory_store=empty_store, project_id=None) == {"cleared": 1}


# ---------------------------------------------------------------------------
# pages
# ---------------------------------------------------------------------------


def test_list_memories_redacts_legacy_source_provenance(empty_store: MemoryStore) -> None:
    save_row(
        empty_store,
        session_id="legacy-session",
        title="Preference: concise replies",
        lesson_text="The user prefers concise replies.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt=r"C:\Users\Alice\private\notes.txt api_key=sk-test-secret-value",
    )

    page = list_memories_page(cursor=None, limit=10, memory_store=empty_store)

    excerpt = str(page["memories"][0]["source_excerpt"])
    assert "Alice" not in excerpt
    assert "sk-test-secret-value" not in excerpt
    assert "[LOCAL_PATH_REDACTED]" in excerpt


def test_list_archived_and_chat_scope_use_the_v9_lister(empty_store: MemoryStore) -> None:
    kept = _save(empty_store, "The user prefers tea.", project_id="project_alpha").memory
    scoped = _save(
        empty_store, "The user is drafting a toast.", project_id="project_alpha",
        scope_session_id="chat-1",
    ).memory
    gone = _save(empty_store, "Forget me.", project_id="project_alpha").memory
    delete_memory(memory_id=gone.id, memory_store=empty_store, project_id="project_alpha")

    archived = list_memories_page(
        cursor=None, limit=10, memory_store=empty_store, project_id="project_alpha",
        status="archived",
    )
    chat = list_memories_page(
        cursor=None, limit=10, memory_store=empty_store, project_id="project_alpha",
        scope_session_id="chat-1",
    )

    assert [row["id"] for row in archived["memories"]] == [gone.id]
    assert {row["id"] for row in chat["memories"]} == {kept.id, scoped.id}
    for bad in ({"status": "deleted"}, {"status": "archived", "all_projects": True},
                {"status": "archived", "cursor": "v1:bogus"}, {"status": "archived", "cursor": 5}):
        with pytest.raises(ValueError):
            list_memories_page(cursor=bad.pop("cursor", None), limit=10,
                               memory_store=empty_store, **bad)


def test_the_archived_list_includes_forgotten_chat_notes(empty_store: MemoryStore) -> None:
    # The Settings page lists a project's chat notes while active, so its
    # Forgotten fold must list them too (Restore and Erase now).
    shared = _save(empty_store, "The user prefers tea.", project_id="project_alpha").memory
    scoped = _save(
        empty_store, "The user is drafting a toast.", project_id="project_alpha",
        scope_session_id="chat-1",
    ).memory
    for row in (shared, scoped):
        delete_memory(memory_id=row.id, memory_store=empty_store, project_id="project_alpha")

    archived = list_memories_page(
        cursor=None, limit=10, memory_store=empty_store, project_id="project_alpha",
        status="archived",
    )

    assert {row["id"] for row in archived["memories"]} == {shared.id, scoped.id}


def test_approved_memory_cursor_is_snapshot_stable_during_concurrent_changes(
    empty_store: MemoryStore,
) -> None:
    initial_ids = [
        _save(empty_store, f"The user prefers item {index}.").memory.id for index in range(4)
    ]

    first_page = list_memories_page(cursor=None, limit=2, memory_store=empty_store)
    first_ids = [int(row["id"]) for row in first_page["memories"]]
    cursor = first_page["next_cursor"]
    assert isinstance(cursor, str) and cursor.startswith("v1:")

    update_memory(
        memory_id=initial_ids[0],
        changes={"lesson_text": "The user still prefers item zero."},
        memory_store=empty_store,
    )
    inserted = _save(empty_store, "The user prefers the newly inserted item.").memory

    second_page = list_memories_page(cursor=cursor, limit=2, memory_store=empty_store)
    second_ids = [int(row["id"]) for row in second_page["memories"]]
    assert set(first_ids).isdisjoint(second_ids)
    assert set(first_ids + second_ids) == set(initial_ids)
    assert inserted.id not in second_ids


@pytest.mark.parametrize("lister", [list_memories_page, list_pending_memories_page])
def test_numeric_offset_cursors_are_invalid(empty_store: MemoryStore, lister) -> None:
    with pytest.raises(ValueError, match="cursor is invalid"):
        lister(cursor="2", limit=2, memory_store=empty_store)


def test_all_project_pending_pages_serialize_project_scope(empty_store: MemoryStore) -> None:
    for project_id in ("project_general", "project_alpha", "project_beta"):
        _insert_pending_candidate(
            empty_store,
            session_id=f"session-{project_id}",
            source_request_id=f"request-{project_id}",
            title=f"Pending {project_id}",
            lesson_text=f"The user prefers pending item {project_id}.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="pending item",
            project_id=project_id,
        )

    first_page = list_pending_memories_page(
        cursor=None, limit=2, memory_store=empty_store, all_projects=True
    )
    second_page = list_pending_memories_page(
        cursor=first_page["next_cursor"], limit=2, memory_store=empty_store, all_projects=True
    )

    candidates = [*first_page["candidates"], *second_page["candidates"]]
    assert {candidate["project_id"] for candidate in candidates} == {
        "project_general",
        "project_alpha",
        "project_beta",
    }
    assert all("family_key" not in candidate for candidate in candidates)


def test_delete_pending_memory_removes_matching_candidate(empty_store: MemoryStore) -> None:
    _insert_pending_candidate(
        empty_store,
        session_id="session-delete",
        source_request_id="request-delete",
        title="Preference: tea",
        lesson_text="The user prefers tea.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt="I prefer tea",
        category="user",
    )

    deleted = delete_pending_memory(
        session_id="session-delete",
        content_fingerprint=build_text_digest("The user prefers tea.").upper(),
        memory_store=empty_store,
    )

    assert deleted is True
    assert pending_rows(empty_store, project_id=GENERAL_PROJECT_ID) == []
