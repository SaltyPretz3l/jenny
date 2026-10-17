"""Accepting and dismissing "Ask before Jenny saves" candidates (row 58 W1b).

Acceptance re-runs the ladder a Jenny write gets, against the scope the
proposal was queued with: a stale proposal cannot resurrect a forgotten text,
and a global proposal from a project chat lands in General.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, build_text_digest
from sidecar.ai.memory.store import MemoryStore, MemoryWriteResult
from sidecar.exceptions import MemoryStoreError
from tests.sidecar.ai.memory.memory_v9_helpers import (
    OTHER_PROJECT,
    PROJECT,
    WallClock,
    next_operation_id,
    operation_count,
    remember,
    saved_id,
)

SESSION = "session-1"
TEXT = "Prefers tabs"


@pytest.fixture
def store(tmp_path: Path) -> Iterator[MemoryStore]:
    memory_store = MemoryStore(tmp_path / "memory.db", clock=WallClock())
    try:
        yield memory_store
    finally:
        memory_store.close()


def _queue(store: MemoryStore, text: str = TEXT, *, project_id: str = PROJECT,
           session_id: str = SESSION) -> str:
    queued = store.queue_candidate(
        project_id=project_id, session_id=session_id,
        source_request_id=f"tool:{session_id}:call_1", text=text, kind="preference",
        origin="jenny",
    )
    assert queued is True
    return build_text_digest(text)


def _accept(store: MemoryStore, fingerprint: str, *, project_id: str = PROJECT,
            session_id: str = SESSION, operation_id: str | None = None) -> MemoryWriteResult:
    return store.accept_pending(
        operation_id=operation_id or next_operation_id(), project_id=project_id,
        session_id=session_id, content_fingerprint=fingerprint,
    )


def _pending_count(store: MemoryStore) -> int:
    row = store._connection.execute("SELECT COUNT(*) FROM pending_memory_candidates").fetchone()
    return int(row[0])


def _suppression_reasons(store: MemoryStore, project_id: str) -> list[str]:
    rows = store._connection.execute(
        "SELECT reason FROM memory_suppressions WHERE project_id = ?", (project_id,)
    ).fetchall()
    return [str(row[0]) for row in rows]


def _active_texts(store: MemoryStore, project_id: str) -> list[str]:
    rows, _cursor = store.list_active(project_id=project_id, include_general=False)
    return [row.lesson_text for row in rows]


def test_accept_saves_a_jenny_row_with_user_approved_provenance(store: MemoryStore) -> None:
    fingerprint = _queue(store)

    result = _accept(store, fingerprint)

    assert result.status == "saved" and result.duplicate is False
    assert result.memory is not None
    assert (result.memory.project_id, result.memory.origin, result.memory.provenance) == (
        PROJECT, "jenny", "user_approved",
    )
    assert (result.memory.scope_session_id, result.memory.always_on) == ("", False)
    assert result.memory.session_id == SESSION
    assert _pending_count(store) == 0


def test_accept_refuses_a_text_forgotten_after_it_was_proposed(store: MemoryStore) -> None:
    fingerprint = _queue(store)
    store._connection.execute(
        "INSERT INTO memory_suppressions (project_id, content_fingerprint, reason, created_at)"
        " VALUES (?, ?, 'forgotten', '2026-10-14T12:00:00+00:00')",
        (PROJECT, fingerprint),
    )
    store._connection.commit()

    result = _accept(store, fingerprint)

    assert (result.status, result.reason) == ("refused", "suppressed")
    assert _active_texts(store, PROJECT) == []
    assert _pending_count(store) == 0
    assert _suppression_reasons(store, PROJECT) == ["forgotten"]


def test_accept_into_an_archived_project_refuses_and_drops_the_row(store: MemoryStore) -> None:
    fingerprint = _queue(store)
    store._connection.execute(
        "INSERT INTO memory_project_state (project_id, archived_at) VALUES (?, ?)",
        (PROJECT, "2026-10-14T12:00:00+00:00"),
    )
    store._connection.commit()

    result = _accept(store, fingerprint)

    assert (result.status, result.reason) == ("refused", "project_archived")
    assert _active_texts(store, PROJECT) == []
    assert _pending_count(store) == 0


def test_accept_of_a_global_proposal_from_a_project_chat_lands_in_general(
    store: MemoryStore,
) -> None:
    fingerprint = _queue(store, project_id=GENERAL_PROJECT_ID)

    result = _accept(store, fingerprint, project_id=PROJECT)

    assert result.status == "saved" and result.memory is not None
    assert (result.memory.project_id, result.memory.origin, result.memory.provenance) == (
        GENERAL_PROJECT_ID, "jenny", "user_approved",
    )
    assert _active_texts(store, GENERAL_PROJECT_ID) == [TEXT]
    assert _active_texts(store, PROJECT) == []
    assert _pending_count(store) == 0


def test_accept_prefers_the_request_project_then_general_never_another(
    store: MemoryStore,
) -> None:
    fingerprint = _queue(store, project_id=OTHER_PROJECT)
    _queue(store, project_id=GENERAL_PROJECT_ID)
    _queue(store, project_id=PROJECT)

    results = [_accept(store, fingerprint, project_id=PROJECT) for _ in range(3)]

    assert [r.memory.project_id for r in results if r.memory] == [PROJECT, GENERAL_PROJECT_ID]
    assert (results[2].status, results[2].reason) == ("refused", "not_found")
    assert _active_texts(store, OTHER_PROJECT) == []
    assert _pending_count(store) == 1


def test_accept_of_an_existing_active_twin_is_a_duplicate_and_clears_the_row(
    store: MemoryStore,
) -> None:
    fingerprint = _queue(store)
    existing = saved_id(remember(store, TEXT, origin="user", session_id="session-2"))
    assert _pending_count(store) == 1

    result = _accept(store, fingerprint)

    assert result.status == "saved" and result.duplicate is True
    assert result.memory is not None and result.memory.id == existing
    assert _active_texts(store, PROJECT) == [TEXT]
    assert _pending_count(store) == 0


def test_accept_without_a_matching_row_is_not_found(store: MemoryStore) -> None:
    _queue(store)

    wrong_session = _accept(store, build_text_digest(TEXT), session_id="session-9")
    wrong_text = _accept(store, build_text_digest("Something else"))

    for result in (wrong_session, wrong_text):
        assert (result.status, result.reason, result.code) == (
            "refused", "not_found", "CMP-MEM-0004",
        )
    assert _active_texts(store, PROJECT) == []
    assert _pending_count(store) == 1


def test_a_capacity_refusal_keeps_the_pending_row(
    store: MemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    fingerprint = _queue(store)
    monkeypatch.setattr(store, "_at_active_capacity", lambda: True)

    result = _accept(store, fingerprint)

    assert (result.status, result.reason) == ("refused", "capacity")
    assert _pending_count(store) == 1
    monkeypatch.undo()
    assert _accept(store, fingerprint).status == "saved"
    assert _pending_count(store) == 0


def test_a_credential_in_the_queued_text_raises_and_keeps_the_row(store: MemoryStore) -> None:
    fingerprint = _queue(store)
    store._connection.execute(
        "UPDATE pending_memory_candidates SET lesson_text = ?", ("password: hunter2",)
    )
    store._connection.commit()

    with pytest.raises(MemoryStoreError):
        _accept(store, fingerprint)

    assert _active_texts(store, PROJECT) == []
    assert _pending_count(store) == 1


def test_a_replayed_operation_returns_the_recorded_result_and_writes_once(
    store: MemoryStore,
) -> None:
    fingerprint = _queue(store)
    operation_id = next_operation_id()

    first = _accept(store, fingerprint, operation_id=operation_id)
    operations = operation_count(store)
    second = _accept(store, fingerprint, operation_id=operation_id)

    assert first.status == "saved" and first.replayed is False
    assert second.status == "saved" and second.replayed is True
    assert second.memory is not None and first.memory is not None
    assert second.memory.id == first.memory.id
    assert operation_count(store) == operations
    assert _active_texts(store, PROJECT) == [TEXT]


def test_a_reused_operation_id_for_another_proposal_is_a_mismatch(store: MemoryStore) -> None:
    operation_id = next_operation_id()
    assert _accept(store, _queue(store), operation_id=operation_id).status == "saved"
    other = _queue(store, "Prefers spaces")

    result = _accept(store, other, operation_id=operation_id)

    assert (result.status, result.reason) == ("refused", "operation_mismatch")
    assert _pending_count(store) == 1


def test_dismiss_of_a_general_proposal_from_a_project_chat_suppresses_under_general(
    store: MemoryStore,
) -> None:
    fingerprint = _queue(store, project_id=GENERAL_PROJECT_ID)

    dismissed = store.delete_pending_candidate(
        session_id=SESSION, content_fingerprint=fingerprint.upper(), project_id=PROJECT
    )

    assert dismissed is True
    assert _pending_count(store) == 0
    assert _suppression_reasons(store, GENERAL_PROJECT_ID) == ["dismissed"]
    assert _suppression_reasons(store, PROJECT) == []


def test_dismiss_prefers_the_request_project_and_misses_cleanly(store: MemoryStore) -> None:
    fingerprint = _queue(store, project_id=PROJECT)
    _queue(store, project_id=GENERAL_PROJECT_ID)

    assert store.delete_pending_candidate(
        session_id=SESSION, content_fingerprint=fingerprint, project_id=PROJECT
    ) is True
    assert _suppression_reasons(store, PROJECT) == ["dismissed"]
    assert _pending_count(store) == 1
    assert store.delete_pending_candidate(
        session_id="session-9", content_fingerprint=fingerprint, project_id=PROJECT
    ) is False
    other = _queue(store, "Prefers spaces", project_id=OTHER_PROJECT)
    assert store.delete_pending_candidate(
        session_id=SESSION, content_fingerprint=other, project_id=PROJECT
    ) is False
    assert _pending_count(store) == 2


def test_a_replay_from_another_project_does_not_return_the_saved_row(store: MemoryStore) -> None:
    fingerprint = _queue(store)
    operation_id = next_operation_id()
    assert _accept(store, fingerprint, operation_id=operation_id).status == "saved"

    replay = _accept(store, fingerprint, project_id=OTHER_PROJECT, operation_id=operation_id)

    assert (replay.status, replay.reason, replay.memory) == (
        "refused", "operation_mismatch", None,
    )


def test_an_identical_retry_replays_before_a_queued_general_twin(store: MemoryStore) -> None:
    fingerprint = _queue(store)
    _queue(store, project_id=GENERAL_PROJECT_ID)
    operation_id = next_operation_id()
    first = _accept(store, fingerprint, operation_id=operation_id)

    retry = _accept(store, fingerprint, operation_id=operation_id)

    assert first.status == "saved" and retry.status == "saved" and retry.replayed is True
    assert retry.memory is not None and retry.memory.project_id == PROJECT
    assert _active_texts(store, GENERAL_PROJECT_ID) == []
    assert _pending_count(store) == 1


def test_accept_for_a_purged_chat_refuses_and_drops_the_row(store: MemoryStore) -> None:
    fingerprint = _queue(store)
    store._connection.execute(
        "INSERT INTO memory_session_markers (session_id, purged_at) VALUES (?, ?)",
        (SESSION, "2026-10-14T12:00:00+00:00"),
    )
    store._connection.commit()

    result = _accept(store, fingerprint)

    assert (result.status, result.reason) == ("refused", "session_purged")
    assert _active_texts(store, PROJECT) == []
    assert _pending_count(store) == 0


def test_a_purged_chat_cannot_queue_a_late_proposal(store: MemoryStore) -> None:
    store.purge_session(SESSION)

    queued = store.queue_candidate(
        project_id=PROJECT, session_id=SESSION, source_request_id="tool:late",
        text=TEXT, kind="preference", origin="jenny",
    )

    assert queued is False
    assert _pending_count(store) == 0
