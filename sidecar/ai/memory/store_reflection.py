"""Reflection state and the ``memory.apply`` transaction (row 58 W2).

``apply_reflection`` is one ``BEGIN IMMEDIATE`` transaction under the store
lock; the nested ``remember``/``queue_candidate`` calls become savepoints (the
lock is an RLock). The fence runs first, in order: chat purged, project
archived, policy epoch stale, cursor moved. A fence refusal raises inside the
transaction so it rolls back whole and writes nothing. Per-item refusals
(suppressed, duplicate, capacity, unsafe) are ``skipped``, never failures.

The cursor table predates this slice (schema v9) and is not STRICT: its
``session_incarnation`` column has INTEGER affinity, so Electron's opaque
string is stored as given and read back as ``str``. Electron's ids look like
``inc_<hex>`` and round-trip exactly; a purely numeric string would come back
in SQLite's canonical integer form.

Recap rows are chat-scope ``fact`` rows with origin ``reflection`` and
provenance ``reflection_recap``; every listing and recall query filters them
out (``NOT_RECAP_SQL``). No memory text reaches a log.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import partial
from typing import Any

from sidecar.ai.error_codes import CMP_MEMORY_CAPACITY_EXCEEDED, CMP_MEMORY_FAILED
from sidecar.ai.memory.contracts import (
    DEDUPE_ROW_LIMIT,
    MAX_SESSION_ID_CHARS,
    MEMORY_KINDS,
    require_bounded_text,
)
from sidecar.ai.memory.store_operations import require_operation_id, timestamp
from sidecar.ai.memory.store_shared import (
    NOT_RECAP_SQL,
    RECAP_PROVENANCE,
    MemoryWriteResult,
    _locked,
    _project_scope,
    recall_scopes,
)
from sidecar.ai.memory.store_write_support import _MemoryWriteSupportMixin
from sidecar.exceptions import MemoryStoreError

REFLECTION_PROVENANCE = "reflection"
REFLECTION_CAPTURE_MODES = ("auto", "ask")
TEXT_PREVIEW_CHARS = 80
_FINGERPRINT_SLICE = slice(7, 23)


@dataclass(frozen=True)
class ReflectionCursor:
    message_count: int
    last_message_id: str
    window_fingerprint: str
    session_incarnation: str
    turn_generation: int


@dataclass(frozen=True)
class ReflectionItem:
    text: str
    kind: str
    source_message_id: str
    scope: str = "project"


class _ReflectionRefused(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def reflection_operation_id(session_id: str, window_fingerprint: str, index: int) -> str:
    return f"reflect:{session_id}:{window_fingerprint[_FINGERPRINT_SLICE]}:{index}"


def recap_operation_id(session_id: str, window_fingerprint: str) -> str:
    return f"reflect-recap:{session_id}:{window_fingerprint[_FINGERPRINT_SLICE]}"


def _session(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("session_id must be a string")
    return require_bounded_text(value, field="session_id", max_chars=MAX_SESSION_ID_CHARS)


def _refused(reason: str) -> dict[str, Any]:
    return {"status": "refused", "reason": reason, "saved": [], "queued": 0, "skipped": 0}


class _MemoryReflectionMixin(_MemoryWriteSupportMixin):
    # Provided by the concrete MemoryStore hub; declared for mypy only.
    remember: Callable[..., MemoryWriteResult]
    queue_candidate: Callable[..., bool]

    @_locked
    def reflection_state(self, session_id: str) -> dict[str, Any]:
        """The chat's cursor row (or None) and whether the chat was purged."""

        session = _session(session_id)
        try:
            row = self._connection.execute(
                """
                SELECT project_id, message_count, last_message_id, window_fingerprint,
                       session_incarnation, turn_generation, updated_at
                FROM memory_reflection_cursor WHERE session_id = ?
                """,
                (session,),
            ).fetchone()
            purged = self._connection.execute(
                "SELECT 1 FROM memory_session_markers WHERE session_id = ? LIMIT 1", (session,)
            ).fetchone()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read reflection state") from error
        cursor = None
        if row is not None:
            cursor = {
                "project_id": str(row[0]),
                "message_count": int(row[1]),
                "last_message_id": str(row[2]),
                "window_fingerprint": str(row[3]),
                "session_incarnation": str(row[4]),
                "turn_generation": int(row[5]),
                "updated_at": str(row[6]),
            }
        return {"cursor": cursor, "purged": purged is not None}

    @_locked
    def reflection_dedupe_rows(
        self, *, project_id: str, limit: int = DEDUPE_ROW_LIMIT, scope_session_id: str = ""
    ) -> list[tuple[str, str]]:
        """``(digest, text)`` of the newest active shared rows of the project and General,
        plus the chat's own chat-scope rows when ``scope_session_id`` is given."""

        scopes = recall_scopes(_project_scope(project_id))
        placeholders = ", ".join("?" for _ in scopes)
        chat = _session(scope_session_id) if scope_session_id else ""
        try:
            rows = self._connection.execute(
                f"""
                SELECT content_fingerprint, lesson_text FROM memories
                WHERE project_id IN ({placeholders}) AND scope_session_id IN ('', ?)
                  AND status = 'active' AND {NOT_RECAP_SQL}
                ORDER BY updated_at DESC, id DESC LIMIT ?
                """,
                (*scopes, chat, max(1, int(limit))),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error
        return [(str(row[0]), str(row[1])) for row in rows]

    @_locked
    def apply_reflection(  # noqa: PLR0913 - the fixed memory.apply contract.
        self,
        *,
        session_id: str,
        project_id: str,
        capture: str,
        expected_fingerprint: str | None,
        cursor: ReflectionCursor,
        proposals: Sequence[ReflectionItem],
        recap: str,
        is_policy_stale: Callable[[], bool],
    ) -> dict[str, Any]:
        """Fence, then add-only writes, recap replace and cursor upsert, atomically."""

        session = _session(session_id)
        project = _project_scope(project_id)
        if capture not in REFLECTION_CAPTURE_MODES:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "capture must be auto or ask")
        fingerprint = cursor.window_fingerprint
        require_operation_id(recap_operation_id(session, fingerprint))
        try:
            with self._guarded_write():
                self._reflection_fence(session, project, expected_fingerprint, is_policy_stale)
                saved: list[dict[str, Any]] = []
                if capture == "auto":
                    saved, skipped = self._remember_items(session, project, cursor, proposals)
                    queued = 0
                else:
                    queued, skipped = self._queue_items(session, project, fingerprint, proposals)
                self._replace_recap(session, project, fingerprint, recap)
                self._upsert_cursor(session, project, cursor)
        except _ReflectionRefused as refused:
            return _refused(refused.reason)
        return {"status": "applied", "saved": saved, "queued": queued, "skipped": skipped}

    # --- the transaction's steps (callers hold the lock and the transaction) ----

    def _reflection_fence(
        self,
        session: str,
        project: str,
        expected_fingerprint: str | None,
        is_policy_stale: Callable[[], bool],
    ) -> None:
        if self._connection.execute(
            "SELECT 1 FROM memory_session_markers WHERE session_id = ? LIMIT 1", (session,)
        ).fetchone():
            raise _ReflectionRefused("session_purged")
        if self._connection.execute(
            "SELECT 1 FROM memory_project_state WHERE project_id = ? LIMIT 1", (project,)
        ).fetchone():
            raise _ReflectionRefused("project_archived")
        if is_policy_stale():
            raise _ReflectionRefused("policy_stale")
        row = self._connection.execute(
            "SELECT window_fingerprint FROM memory_reflection_cursor WHERE session_id = ?",
            (session,),
        ).fetchone()
        if (None if row is None else str(row[0])) != expected_fingerprint:
            raise _ReflectionRefused("cursor_moved")

    def _remember_items(
        self,
        session: str,
        project: str,
        cursor: ReflectionCursor,
        proposals: Sequence[ReflectionItem],
    ) -> tuple[list[dict[str, Any]], int]:
        saved: list[dict[str, Any]] = []
        for index, item in enumerate(proposals):
            text = _usable_text(item)
            if text is None:
                continue
            operation_id = reflection_operation_id(session, cursor.window_fingerprint, index)
            result = _skip_on_capacity(partial(
                self.remember,
                operation_id=operation_id,
                project_id=project,
                text=text,
                kind=item.kind,
                origin="reflection",
                provenance=REFLECTION_PROVENANCE,
                session_id=session,
                source_message_ids=(item.source_message_id,),
                scope_session_id=session if item.scope == "chat" else "",
            ))
            # A duplicate or a replay wrote nothing new: it is skipped like a refusal.
            if (
                isinstance(result, MemoryWriteResult)
                and result.status == "saved"
                and not (result.duplicate or result.replayed)
                and result.memory is not None
            ):
                saved.append({
                    "memory_id": result.memory.id,
                    "operation_id": result.operation_id,
                    "kind": result.memory.lesson_kind,
                    "scope": item.scope,
                    "text_preview": result.memory.lesson_text[:TEXT_PREVIEW_CHARS],
                    "undoable": bool(result.undoable),
                })
        return saved, len(proposals) - len(saved)

    def _queue_items(
        self,
        session: str,
        project: str,
        fingerprint: str,
        proposals: Sequence[ReflectionItem],
    ) -> tuple[int, int]:
        queued = 0
        request_id = f"reflect:{session}:{fingerprint[_FINGERPRINT_SLICE]}"
        for item in proposals:
            if item.scope == "chat":
                continue
            text = _usable_text(item)
            if text is not None and _skip_on_capacity(partial(
                self.queue_candidate,
                project_id=project,
                session_id=session,
                source_request_id=request_id,
                text=text,
                kind=item.kind,
                origin="reflection",
            )) is True:
                queued += 1
        return queued, len(proposals) - queued

    def _replace_recap(self, session: str, project: str, fingerprint: str, recap: str) -> None:
        """Archive the chat's active recap (no suppression, no ledger row); add the new one.

        A blank (or fully scrubbed) recap keeps the current one.
        """

        operation_id = recap_operation_id(session, fingerprint)
        if self._connection.execute(
            "SELECT 1 FROM memory_operations WHERE operation_id = ? LIMIT 1", (operation_id,)
        ).fetchone():
            return  # a replay of an applied window keeps its recap as it is
        # The reflection checks load on the first apply, off the sidecar startup path.
        from sidecar.ai.memory.reflection_checks import scrub_recap

        text = scrub_recap(recap)
        if not text:
            return
        stamp = timestamp(self._now())
        self._connection.execute(
            """
            UPDATE memories
            SET status = 'archived', archived_at = ?, revision = revision + 1, updated_at = ?
            WHERE scope_session_id = ? AND provenance = ? AND status = 'active'
            """,
            (stamp, stamp, session, RECAP_PROVENANCE),
        )
        _skip_on_capacity(partial(
            self.remember,
            operation_id=operation_id,
            project_id=project,
            text=text,
            kind="fact",
            origin="reflection",
            provenance=RECAP_PROVENANCE,
            session_id=session,
            scope_session_id=session,
        ))

    def _upsert_cursor(self, session: str, project: str, cursor: ReflectionCursor) -> None:
        self._connection.execute(
            """
            INSERT INTO memory_reflection_cursor (
                session_id, project_id, message_count, last_message_id, window_fingerprint,
                session_incarnation, turn_generation, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                project_id = excluded.project_id,
                message_count = excluded.message_count,
                last_message_id = excluded.last_message_id,
                window_fingerprint = excluded.window_fingerprint,
                session_incarnation = excluded.session_incarnation,
                turn_generation = excluded.turn_generation,
                updated_at = excluded.updated_at
            """,
            (
                session, project, cursor.message_count, cursor.last_message_id,
                cursor.window_fingerprint, cursor.session_incarnation, cursor.turn_generation,
                timestamp(self._now()),
            ),
        )


def _usable_text(item: ReflectionItem) -> str | None:
    """The stored form of the item's text, or None when it must be skipped."""

    if item.kind not in MEMORY_KINDS:
        return None
    from sidecar.ai.memory.reflection_checks import clean_memory_text

    text, failure = clean_memory_text(item.text)
    return None if failure is not None else text


def _skip_on_capacity(write: Callable[[], Any]) -> Any:
    """Run one nested write; a full store skips the item instead of failing the apply."""

    try:
        return write()
    except MemoryStoreError as error:
        if error.code != CMP_MEMORY_CAPACITY_EXCEEDED:
            raise
        return None


__all__ = [
    "RECAP_PROVENANCE",
    "REFLECTION_CAPTURE_MODES",
    "REFLECTION_PROVENANCE",
    "ReflectionCursor",
    "ReflectionItem",
    "recap_operation_id",
    "reflection_operation_id",
]
