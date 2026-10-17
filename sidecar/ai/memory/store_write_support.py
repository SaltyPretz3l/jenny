"""Shared validators and in-transaction helpers for the schema v9 write path.

Split from :mod:`sidecar.ai.memory.store_writes` to keep each module small.
Every helper here runs inside a caller's ``BEGIN IMMEDIATE`` transaction under
the store lock and never logs memory text.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from datetime import datetime
from typing import Any

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.contracts import (
    ALWAYS_ON_BUDGET_CHARS,
    ALWAYS_ON_HEADING_RESERVE,
    ALWAYS_ON_ROW_OVERHEAD,
    GENERAL_PROJECT_ID,
    MAX_SOURCE_MESSAGE_ID_CHARS,
    MAX_SOURCE_MESSAGE_IDS,
    MAX_TITLE_CHARS,
    build_text_digest,
    recap_text_digest,
    require_bounded_text,
)
from sidecar.ai.memory.store_operations import (
    insert_operation,
    refusal,
)
from sidecar.ai.memory.store_shared import (
    _APPROVED_MEMORY_SELECT,
    RECAP_PROVENANCE,
    ApprovedMemory,
    MemoryWriteResult,
    recall_scopes,
)
from sidecar.ai.tools.sanitization import scrub_memory_text
from sidecar.exceptions import MemoryStoreError


def _invalid(message: str) -> MemoryStoreError:
    return MemoryStoreError(CMP_MEMORY_FAILED, message)


def _memory_text(value: Any, field: str, max_chars: int) -> str:
    """Memory text as stored: scrubbed of invisible/control tokens; a credential is refused."""
    cleaned, secret = scrub_memory_text(_bounded(value, field, max_chars))
    if secret:
        raise _invalid(f"{field} looks like a credential and is not stored")
    return _bounded(cleaned, field, max_chars)


def _bounded(value: Any, field: str, max_chars: int, *, allow_blank: bool = False) -> str:
    if value is not None and not isinstance(value, str):
        raise _invalid(f"{field} must be a string")
    try:
        return require_bounded_text(
            value, field=field, max_chars=max_chars, allow_blank=allow_blank
        )
    except ValueError as error:
        raise _invalid(str(error)) from error


def _choice(value: Any, field: str, allowed: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise _invalid(f"{field} must be one of {', '.join(allowed)}")
    return value


def _flag(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise _invalid(f"{field} must be a boolean")
    return value


def _memory_id(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise _invalid("memory_id must be a positive integer")
    return value


def _revision(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise _invalid("expected_revision must be a positive integer or None")
    return value


def _message_ids(value: Any) -> tuple[str, ...]:
    if isinstance(value, str) or not isinstance(value, (list, tuple)):
        raise _invalid("source_message_ids must be a list of strings")
    if len(value) > MAX_SOURCE_MESSAGE_IDS:
        raise _invalid(f"source_message_ids allows at most {MAX_SOURCE_MESSAGE_IDS} ids")
    return tuple(
        _bounded(item, "source_message_ids[]", MAX_SOURCE_MESSAGE_ID_CHARS) for item in value
    )


def _title_for(title: Any, text: str) -> str:
    if title is None:
        return text[:MAX_TITLE_CHARS].strip() or text[:MAX_TITLE_CHARS]
    return _bounded(title, "title", MAX_TITLE_CHARS)


def _writer_refusal(writer: str, *, suppressed: bool, protected: bool) -> MemoryWriteResult | None:
    """Only the user may write through a suppression or touch a protected row."""

    if writer == "user":
        return None
    if suppressed:
        return refusal("suppressed")
    if protected:
        return refusal("protected")
    return None


def text_digest_for(text: str, provenance: str) -> str:
    """A row's identity: recap rows carry the salted recap digest (row 58 W4)."""

    return recap_text_digest(text) if provenance == RECAP_PROVENANCE else build_text_digest(text)


def _row_cost(text: str) -> int:
    return len(text) + ALWAYS_ON_ROW_OVERHEAD


class _MemoryWriteSupportMixin:
    # Owned by the concrete MemoryStore hub (sidecar/ai/memory/store.py);
    # declared for mypy across the mixin split, with no runtime effect.
    _connection: sqlite3.Connection
    _write_transaction: Callable[[], AbstractContextManager[None]]
    _assert_capacity_for_growth: Callable[[], None]
    _prepare_capacity_for_growth: Callable[[], None]
    _approved_from_row: Callable[..., ApprovedMemory | None]
    _approved_rows: Callable[..., list[ApprovedMemory]]
    _now: Callable[[], datetime]

    # --- transaction and read helpers (callers hold the lock) ---------------

    @contextmanager
    def _guarded_write(self) -> Iterator[None]:
        try:
            with self._write_transaction():
                yield
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to write memory") from error

    def _row(self, project_id: str, memory_id: int) -> ApprovedMemory | None:
        row = self._connection.execute(
            f"{_APPROVED_MEMORY_SELECT} WHERE project_id = ? AND id = ? LIMIT 1",
            (project_id, memory_id),
        ).fetchone()
        return self._approved_from_row(row) if row else None

    def _scope_refusal(self, project_id: str, scope_session_id: str) -> MemoryWriteResult | None:
        archived = self._connection.execute(
            "SELECT 1 FROM memory_project_state WHERE project_id = ? LIMIT 1", (project_id,)
        ).fetchone()
        if archived:
            return refusal("project_archived")
        if scope_session_id and self._connection.execute(
            "SELECT 1 FROM memory_session_markers WHERE session_id = ? LIMIT 1",
            (scope_session_id,),
        ).fetchone():
            return refusal("session_purged")
        return None

    def _suppression(self, project_id: str, digest: str) -> dict[str, str] | None:
        row = self._connection.execute(
            """
            SELECT reason, created_at FROM memory_suppressions
            WHERE project_id = ? AND content_fingerprint = ?
            """,
            (project_id, digest),
        ).fetchone()
        if row is None:
            return None
        return {"digest": digest, "reason": str(row[0]), "created_at": str(row[1])}

    def _set_suppression(self, project_id: str, state: dict[str, Any] | None, digest: str) -> None:
        """Make the suppression for *digest* exactly *state* (None removes it)."""

        self._connection.execute(
            "DELETE FROM memory_suppressions WHERE project_id = ? AND content_fingerprint = ?",
            (project_id, digest),
        )
        if state is not None:
            self._connection.execute(
                """
                INSERT INTO memory_suppressions (
                    project_id, content_fingerprint, reason, created_at
                ) VALUES (?, ?, ?, ?)
                """,
                (project_id, digest, state.get("reason") or "forgotten", state["created_at"]),
            )

    def _active_twin(
        self,
        project_id: str,
        scope_session_id: str,
        digest: str,
        exclude_id: int = 0,
        *,
        recap: bool = False,
    ) -> ApprovedMemory | None:
        """The active row with this identity; notes and recaps never twin each other."""

        row = self._connection.execute(
            f"""
            {_APPROVED_MEMORY_SELECT}
            WHERE project_id = ? AND scope_session_id = ? AND content_fingerprint = ?
              AND status = 'active' AND id != ? AND (provenance = ?) = ?
            LIMIT 1
            """,
            (project_id, scope_session_id, digest, exclude_id, RECAP_PROVENANCE, int(recap)),
        ).fetchone()
        return self._approved_from_row(row) if row else None

    def _always_on_memories(self, project_id: str) -> list[ApprovedMemory]:
        scopes = recall_scopes(project_id)
        placeholders = ", ".join("?" for _ in scopes)
        rows = self._connection.execute(
            f"""
            {_APPROVED_MEMORY_SELECT}
            WHERE project_id IN ({placeholders}) AND status = 'active'
              AND always_on = 1 AND scope_session_id = ''
            ORDER BY project_id != ?, id ASC
            """,
            (*scopes, GENERAL_PROJECT_ID),
        ).fetchall()
        return self._approved_rows(rows)

    def _always_on_overflow(
        self, project_id: str, text: str, exclude_id: int = 0
    ) -> MemoryWriteResult | None:
        current = self._always_on_memories(project_id)
        used = sum(_row_cost(memory.lesson_text) for memory in current if memory.id != exclude_id)
        if used + _row_cost(text) <= ALWAYS_ON_BUDGET_CHARS - ALWAYS_ON_HEADING_RESERVE:
            return None
        return refusal(
            "always_on_full",
            always_on_lines=tuple(memory.lesson_text for memory in current),
        )

    def _record(  # noqa: PLR0913 - one ledger row has this many facts.
        self,
        *,
        operation_id: str,
        action: str,
        scope: str,
        digest: str,
        origin: str,
        memory: ApprovedMemory,
        now: datetime,
        prior: dict[str, Any] | None = None,
        prior_suppression: dict[str, Any] | None = None,
        op: str | None = None,
    ) -> MemoryWriteResult:
        result = MemoryWriteResult(
            status="saved",
            memory=memory,
            operation_id=operation_id,
            undoable=(op or action) != "undo",
        )
        insert_operation(
            self._connection,
            operation_id=operation_id,
            action=action,
            scope=scope,
            digest=digest,
            memory_id=memory.id,
            op=op or action,
            origin=origin,
            prior=prior,
            prior_suppression=prior_suppression,
            result=result,
            now=now,
        )
        return result
