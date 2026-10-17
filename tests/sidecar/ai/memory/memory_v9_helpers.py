"""Shared helpers for the schema v9 memory write tests."""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any

from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, map_legacy_kind
from sidecar.ai.memory.store import (
    ApprovedMemory,
    MemoryStore,
    MemoryWriteResult,
    PendingMemoryCandidate,
)

PROJECT = "project_alpha"
OTHER_PROJECT = "project_beta"

_OPERATION_IDS = itertools.count(1)


class WallClock:
    """Injectable wall clock: tests move time forward explicitly."""

    def __init__(self) -> None:
        self.now = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


def next_operation_id() -> str:
    return f"op-{next(_OPERATION_IDS)}"


def remember(  # noqa: PLR0913 - mirrors the store's keyword contract.
    store: MemoryStore,
    text: str,
    *,
    project_id: str = PROJECT,
    origin: str = "jenny",
    kind: str = "preference",
    session_id: str = "session-1",
    operation_id: str | None = None,
    **kwargs: Any,
) -> MemoryWriteResult:
    return store.remember(
        operation_id=operation_id or next_operation_id(),
        project_id=project_id,
        text=text,
        kind=kind,
        origin=origin,
        session_id=session_id,
        **kwargs,
    )


def save_row(  # noqa: PLR0913 - mirrors the v8-shaped fixture arguments.
    store: MemoryStore,
    *,
    session_id: str,
    title: str,
    lesson_text: str,
    lesson_kind: str,
    confidence: float,
    source_excerpt: str,
    provenance: str = "unknown_legacy",
    project_id: str = GENERAL_PROJECT_ID,
) -> tuple[ApprovedMemory, bool]:
    """User-origin ``remember`` of a v8 or v9 kind: the saved row and whether it is new."""

    result = remember(
        store,
        lesson_text,
        project_id=project_id,
        origin="user",
        kind=map_legacy_kind(lesson_kind),
        session_id=session_id,
        confidence=confidence,
        source_excerpt=source_excerpt,
        title=title,
        provenance=provenance,
    )
    assert result.status == "saved" and result.memory is not None, result
    return result.memory, not result.duplicate


def update_row(  # noqa: PLR0913 - mirrors the store's keyword contract.
    store: MemoryStore,
    memory_id: int,
    *,
    title: str,
    lesson_text: str,
    project_id: str = GENERAL_PROJECT_ID,
    remove_provenance: bool = False,
) -> MemoryWriteResult:
    return store.update(
        operation_id=next_operation_id(),
        project_id=project_id,
        memory_id=memory_id,
        text=lesson_text,
        title=title,
        expected_revision=None,
        origin="user",
        remove_provenance=remove_provenance,
    )


def forget_row(
    store: MemoryStore, memory_id: int, *, project_id: str = GENERAL_PROJECT_ID
) -> MemoryWriteResult:
    return store.forget(
        operation_id=next_operation_id(),
        project_id=project_id,
        memory_id=memory_id,
        expected_revision=None,
        origin="user",
    )


def find_row(
    store: MemoryStore,
    memory_id: int,
    *,
    project_id: str,
    scope_session_id: str | None = None,
) -> ApprovedMemory | None:
    """One row of the project, active or archived (a single page of each)."""

    for lister in (store.list_active, store.list_archived):
        rows, next_cursor = lister(
            project_id=project_id, scope_session_id=scope_session_id, include_general=False
        )
        assert next_cursor is None
        for row in rows:
            if row.id == memory_id:
                return row
    return None


def pending_rows(
    store: MemoryStore, *, project_id: str, session_id: str | None = None
) -> list[PendingMemoryCandidate]:
    rows, next_cursor = store.get_pending_candidates_page(limit=250, project_id=project_id)
    assert next_cursor is None
    return [row for row in rows if session_id is None or row.session_id == session_id]


def saved_id(result: MemoryWriteResult) -> int:
    assert result.status == "saved", result
    assert result.memory is not None
    return result.memory.id


def operation_count(store: MemoryStore) -> int:
    row = store._connection.execute(
        "SELECT COUNT(*) FROM memory_operations"
    ).fetchone()
    return int(row[0])


def suppression_count(store: MemoryStore, project_id: str = PROJECT) -> int:
    row = store._connection.execute(
        "SELECT COUNT(*) FROM memory_suppressions WHERE project_id = ?",
        (project_id,),
    ).fetchone()
    return int(row[0])
