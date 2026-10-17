"""Queueing "Ask before Jenny saves" candidates (row 58 W1).

The queue is add-only and fails closed: an archived project, a suppressed or
already-active text, or a duplicate pending row all return False and write
nothing. The memory tool relies on these rules when the capture policy is
``ask``.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.memory.store import MemoryStore
from sidecar.exceptions import MemoryStoreError
from tests.sidecar.ai.memory.memory_v9_helpers import (
    OTHER_PROJECT,
    PROJECT,
    WallClock,
    next_operation_id,
    pending_rows,
    remember,
    saved_id,
)

SESSION = "session-1"


@pytest.fixture
def store(tmp_path: Path) -> Iterator[MemoryStore]:
    memory_store = MemoryStore(tmp_path / "memory.db", clock=WallClock())
    try:
        yield memory_store
    finally:
        memory_store.close()


def _queue(store: MemoryStore, text: str, *, project_id: str = PROJECT,
           session_id: str = SESSION) -> bool:
    return store.queue_candidate(
        project_id=project_id,
        session_id=session_id,
        source_request_id=f"tool:{session_id}:call_1",
        text=text,
        kind="preference",
        origin="jenny",
    )


def _pending_texts(store: MemoryStore, *, project_id: str = PROJECT) -> list[str]:
    rows = pending_rows(store, project_id=project_id, session_id=SESSION)
    return [row.lesson_text for row in rows]


def test_queue_candidate_writes_one_pending_row(store: MemoryStore) -> None:
    assert _queue(store, "Prefers tabs") is True

    rows = pending_rows(store, project_id=PROJECT, session_id=SESSION)
    assert [(row.lesson_text, row.lesson_kind, row.origin, row.project_id) for row in rows] == [
        ("Prefers tabs", "preference", "jenny", PROJECT)
    ]
    assert rows[0].source_request_id == f"tool:{SESSION}:call_1"
    assert store.get_all_memories(project_id=PROJECT) == []


def test_queue_candidate_is_idempotent_per_session(store: MemoryStore) -> None:
    assert _queue(store, "Prefers tabs") is True
    assert _queue(store, "Prefers tabs") is False
    assert _queue(store, "Prefers tabs", session_id="session-2") is True

    assert _pending_texts(store) == ["Prefers tabs"]


def test_queue_candidate_refuses_an_active_twin(store: MemoryStore) -> None:
    saved_id(remember(store, "Prefers tabs"))

    assert _queue(store, "Prefers tabs") is False
    assert _queue(store, "Prefers tabs", project_id=OTHER_PROJECT) is True
    assert _pending_texts(store) == []


def test_queue_candidate_refuses_a_suppressed_text(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Prefers tabs"))
    forgotten = store.forget(
        operation_id=next_operation_id(), project_id=PROJECT, memory_id=memory_id,
        expected_revision=None, origin="user",
    )
    assert forgotten.status == "saved"

    assert _queue(store, "Prefers tabs") is False
    assert _pending_texts(store) == []


def test_queue_candidate_refuses_an_archived_project(store: MemoryStore) -> None:
    saved_id(remember(store, "Something else"))
    store.archive_project(PROJECT)

    assert _queue(store, "Prefers tabs") is False
    assert _pending_texts(store) == []


def test_queue_candidate_validates_kind_and_origin(store: MemoryStore) -> None:
    with pytest.raises(MemoryStoreError):
        store.queue_candidate(
            project_id=PROJECT, session_id=SESSION, source_request_id="op",
            text="Prefers tabs", kind="tool_strategy", origin="jenny",
        )
    with pytest.raises(MemoryStoreError):
        store.queue_candidate(
            project_id=PROJECT, session_id=SESSION, source_request_id="op",
            text="Prefers tabs", kind="preference", origin="legacy",
        )
    assert _pending_texts(store) == []
