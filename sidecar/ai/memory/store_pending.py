"""Pending memory-candidate persistence for the sidecar memory store."""

from __future__ import annotations

import sqlite3
from contextlib import AbstractContextManager
from datetime import datetime, timezone
from typing import Any, Callable

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.contracts import (
    GENERAL_PROJECT_ID,
    MAX_CATEGORY_CHARS,
    MAX_LESSON_TEXT_CHARS,
    MAX_REQUEST_ID_CHARS,
    MAX_SESSION_ID_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    MAX_TITLE_CHARS,
    MEMORY_KINDS,
    WRITE_ORIGINS,
    build_text_digest,
    is_content_digest,
    require_bounded_text,
    require_finite_confidence,
)
from sidecar.ai.memory.store_operations import (
    load_operation,
    refusal,
    require_operation_id,
    result_from_json,
)
from sidecar.ai.memory.store_shared import (
    _PENDING_MEMORY_SELECT,
    MAX_HARNESS_PENDING_LIMIT,
    MemoryWriteResult,
    PendingMemoryCandidate,
    _locked,
    _project_scope,
)
from sidecar.ai.memory.store_write_support import _memory_text
from sidecar.exceptions import MemoryStoreError

# A queued proposal keeps the scope it was queued with: the request's project
# first, then General. Another project's row is never reached (isolation).
_PENDING_RESOLUTION_ORDER = "ORDER BY (project_id = ?) DESC, (project_id = ?) DESC, id DESC"
# Refusals after which a queued proposal can never be accepted.
_PERMANENT_REFUSALS = frozenset({"suppressed", "project_archived", "session_purged"})


class _PendingCandidatesMixin:
    # _connection is owned by the concrete MemoryStore hub (sidecar/ai/memory/store.py);
    # declared here only so mypy can see it across the mixin split. This is a bare
    # annotation with no assigned value, so it has zero runtime effect.
    _connection: sqlite3.Connection
    _write_transaction: Callable[[], AbstractContextManager[None]]
    _assert_capacity_for_growth: Callable[[], None]
    _prepare_capacity_for_growth: Callable[[], None]
    _quarantine_malformed_row: Callable[..., None]
    _now: Callable[[], datetime]
    remember: Callable[..., MemoryWriteResult]
    is_session_purged: Callable[[str], bool]

    @_locked
    def get_pending_candidates_for_harness(
        self,
        limit: int = 80,
        *,
        project_id: str = GENERAL_PROJECT_ID,
    ) -> list[PendingMemoryCandidate]:
        scope = _project_scope(project_id)
        safe_limit = max(1, min(int(limit), MAX_HARNESS_PENDING_LIMIT))
        try:
            rows = self._connection.execute(
                f"""
                {_PENDING_MEMORY_SELECT}
                WHERE project_id = ?
                ORDER BY updated_at DESC, id DESC
                LIMIT ?
                """,
                (scope, safe_limit),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED,
                "failed to read pending memory candidates",
            ) from error
        return self._pending_rows(rows)

    @_locked
    def get_pending_candidates_page(
        self,
        *,
        limit: int,
        snapshot_max_id: int | None = None,
        after_id: int | None = None,
        project_id: str = GENERAL_PROJECT_ID,
        all_projects: bool = False,
    ) -> tuple[list[PendingMemoryCandidate], tuple[int, int] | None]:
        scope = None if all_projects else _project_scope(project_id)
        project_predicate = "" if all_projects else "WHERE project_id = ?"
        project_params = () if all_projects else (scope,)
        safe_limit = max(1, min(int(limit), 250))
        try:
            if snapshot_max_id is None:
                anchor_row = self._connection.execute(
                    f"SELECT COALESCE(MAX(id), 0) FROM pending_memory_candidates {project_predicate}",
                    project_params,
                ).fetchone()
                snapshot_max_id = int(anchor_row[0] if anchor_row else 0)
            safe_snapshot = max(0, int(snapshot_max_id))
            safe_after = safe_snapshot + 1 if after_id is None else max(0, int(after_id))
            rows = self._connection.execute(
                f"""
                {_PENDING_MEMORY_SELECT}
                WHERE {'' if all_projects else 'project_id = ? AND '}id <= ? AND id < ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (*project_params, safe_snapshot, safe_after, safe_limit + 1),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED,
                "failed to read pending memory candidates",
            ) from error
        has_more = len(rows) > safe_limit
        page = rows[:safe_limit]
        next_cursor = (
            (safe_snapshot, int(page[-1][0])) if has_more and page else None
        )
        return (
            self._pending_rows(page),
            next_cursor,
        )

    @_locked
    def delete_pending_candidate(
        self,
        *,
        session_id: str,
        content_fingerprint: str,
        project_id: str = GENERAL_PROJECT_ID,
    ) -> bool:
        scope = _project_scope(project_id)
        normalized_session_id = str(session_id or "").strip()
        normalized_fingerprint = str(content_fingerprint or "").strip().lower()
        if not normalized_session_id or not normalized_fingerprint:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED, "session_id and content_fingerprint are required"
            )
        try:
            with self._write_transaction():
                existing = self._connection.execute(
                    f"""
                    SELECT id, project_id FROM pending_memory_candidates
                    WHERE session_id = ? AND content_fingerprint = ?
                    AND project_id IN (?, ?)
                    {_PENDING_RESOLUTION_ORDER} LIMIT 1
                    """,
                    (
                        normalized_session_id, normalized_fingerprint, scope, GENERAL_PROJECT_ID,
                        scope, GENERAL_PROJECT_ID,
                    ),
                ).fetchone()
                cursor = self._connection.execute(
                    "DELETE FROM pending_memory_candidates WHERE id = ?",
                    (existing[0] if existing else 0,),
                )
                if existing:
                    self._connection.execute(
                        """
                        INSERT INTO memory_suppressions (
                            project_id, content_fingerprint, reason, created_at
                        ) VALUES (?, ?, 'dismissed', ?)
                        ON CONFLICT(project_id, content_fingerprint) DO UPDATE SET
                            reason = excluded.reason,
                            created_at = excluded.created_at
                        """,
                        (
                            str(existing[1]),
                            normalized_fingerprint,
                            datetime.now(timezone.utc).isoformat(),
                        ),
                    )
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED,
                "failed to delete pending memory candidate",
            ) from error
        return int(cursor.rowcount or 0) > 0

    @_locked
    def accept_pending(
        self,
        *,
        operation_id: str,
        project_id: str,
        session_id: str,
        content_fingerprint: str,
    ) -> MemoryWriteResult:
        """Save one queued proposal through the ladder a Jenny write gets.

        The row is written with its own queued project, never the request's. It
        goes once the write saved it or can never succeed; a transient refusal
        or a raised error keeps it queued.
        """

        op_id = require_operation_id(operation_id)
        scope = _project_scope(project_id)
        session = str(session_id or "").strip()
        fingerprint = str(content_fingerprint or "").strip().lower()
        if not session or not fingerprint:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED, "session_id and content_fingerprint are required"
            )
        if load_operation(self._connection, op_id) is not None:
            # A retry answers from the ledger before any other queued twin is resolved.
            return self._replay_accepted(op_id, scope, session, fingerprint)
        candidate = self._resolve_pending(scope, session, fingerprint)
        if candidate is None:
            return refusal("not_found")
        if self.is_session_purged(candidate.session_id):
            result = refusal("session_purged")
        else:
            result = self._remember_candidate(op_id, candidate)
        if result.status == "saved" or result.reason in _PERMANENT_REFUSALS:
            try:
                with self._write_transaction():
                    self._connection.execute(
                        "DELETE FROM pending_memory_candidates WHERE id = ?", (candidate.id,)
                    )
            except sqlite3.DatabaseError as error:
                raise MemoryStoreError(
                    CMP_MEMORY_FAILED, "failed to clear pending memory candidate"
                ) from error
        return result

    def _remember_candidate(
        self, operation_id: str, candidate: PendingMemoryCandidate
    ) -> MemoryWriteResult:
        return self.remember(
            operation_id=operation_id,
            project_id=candidate.project_id,
            text=candidate.lesson_text,
            kind=candidate.lesson_kind,
            origin="jenny",
            session_id=candidate.session_id,
            scope_session_id="",
            always_on=False,
            confidence=candidate.confidence,
            source_excerpt=candidate.source_excerpt,
            title=candidate.title,
            provenance="user_approved",
        )

    def _resolve_pending(
        self, scope: str, session_id: str, fingerprint: str
    ) -> PendingMemoryCandidate | None:
        try:
            row = self._connection.execute(
                f"""
                {_PENDING_MEMORY_SELECT}
                WHERE session_id = ? AND content_fingerprint = ? AND project_id IN (?, ?)
                {_PENDING_RESOLUTION_ORDER} LIMIT 1
                """,
                (
                    session_id, fingerprint, scope, GENERAL_PROJECT_ID,
                    scope, GENERAL_PROJECT_ID,
                ),
            ).fetchone()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED, "failed to read pending memory candidate"
            ) from error
        return self._pending_from_row(row) if row is not None else None

    def _replay_accepted(
        self, operation_id: str, scope: str, session_id: str, fingerprint: str
    ) -> MemoryWriteResult:
        """A retried accept answers with the recorded save, in the caller's reach only."""

        recorded = load_operation(self._connection, operation_id)
        if recorded is None:
            return refusal("not_found")
        if recorded.expired(self._now()) or not recorded.response_json:
            return refusal("operation_expired")
        result = result_from_json(recorded.response_json, operation_id=operation_id)
        if (
            recorded.action != "remember"
            or result.memory is None
            or (result.memory.session_id, result.memory.content_fingerprint)
            != (session_id, fingerprint)
            or result.memory.project_id not in (scope, GENERAL_PROJECT_ID)
        ):
            return refusal("operation_mismatch")
        return result

    @_locked
    def queue_candidate(
        self,
        *,
        project_id: str,
        session_id: str,
        source_request_id: str,
        text: str,
        kind: str,
        origin: str,
    ) -> bool:
        """Queue one candidate for the "Ask before Jenny saves" list.

        Returns False (and writes nothing) when the project is archived, the
        chat was purged, the text is suppressed or already an active memory in
        that project, or the same text is already pending for the session.
        """

        scope = _project_scope(project_id)
        session = require_bounded_text(
            session_id, field="session_id", max_chars=MAX_SESSION_ID_CHARS
        )
        request = require_bounded_text(
            source_request_id, field="source_request_id", max_chars=MAX_REQUEST_ID_CHARS
        )
        lesson = _memory_text(text, "text", MAX_LESSON_TEXT_CHARS)
        if kind not in MEMORY_KINDS or origin not in WRITE_ORIGINS:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "kind or origin is invalid")
        digest = build_text_digest(lesson)
        stamp = datetime.now(timezone.utc).isoformat()
        self._prepare_capacity_for_growth()
        try:
            with self._write_transaction():
                blocked = self._connection.execute(
                    """
                    SELECT 1 WHERE EXISTS (
                        SELECT 1 FROM memory_project_state WHERE project_id = ?
                    ) OR EXISTS (
                        SELECT 1 FROM memory_session_markers WHERE session_id = ?
                    ) OR EXISTS (
                        SELECT 1 FROM memory_suppressions
                        WHERE project_id = ? AND content_fingerprint = ?
                    ) OR EXISTS (
                        SELECT 1 FROM memories
                        WHERE project_id = ? AND status = 'active' AND content_fingerprint = ?
                    )
                    """,
                    (scope, session, scope, digest, scope, digest),
                ).fetchone()
                if blocked:
                    return False
                self._assert_capacity_for_growth()
                cursor = self._connection.execute(
                    """
                    INSERT INTO pending_memory_candidates (
                        session_id, source_request_id, title, lesson_text, lesson_kind,
                        confidence, source_excerpt, content_fingerprint, category,
                        created_at, updated_at, project_id, origin
                    ) VALUES (?, ?, ?, ?, ?, 1.0, '', ?, '', ?, ?, ?, ?)
                    ON CONFLICT(project_id, session_id, content_fingerprint) DO NOTHING
                    """,
                    (
                        session, request, lesson[:MAX_TITLE_CHARS].strip() or lesson,
                        lesson, kind, digest, stamp, stamp, scope, origin,
                    ),
                )
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED, "failed to queue pending memory candidate"
            ) from error
        return int(cursor.rowcount or 0) > 0

    def _pending_rows(
        self,
        rows: list[sqlite3.Row | tuple[Any, ...]],
    ) -> list[PendingMemoryCandidate]:
        converted: list[PendingMemoryCandidate] = []
        for row in rows:
            candidate = self._pending_from_row(row)
            if candidate is not None:
                converted.append(candidate)
        return converted

    def _pending_from_row(
        self,
        row: sqlite3.Row | tuple[Any, ...],
    ) -> PendingMemoryCandidate | None:
        try:
            candidate_id = int(row[0])
            fingerprint = str(row[8] or "").strip().lower()
            if candidate_id <= 0 or not is_content_digest(fingerprint):
                raise ValueError("invalid pending memory identity")
            return PendingMemoryCandidate(
                id=candidate_id,
                session_id=require_bounded_text(
                    row[1], field="session_id", max_chars=MAX_SESSION_ID_CHARS
                ),
                source_request_id=require_bounded_text(
                    row[2], field="source_request_id", max_chars=MAX_REQUEST_ID_CHARS
                ),
                title=require_bounded_text(
                    row[3], field="title", max_chars=MAX_TITLE_CHARS
                ),
                lesson_text=require_bounded_text(
                    row[4], field="lesson_text", max_chars=MAX_LESSON_TEXT_CHARS
                ),
                lesson_kind=require_bounded_text(
                    row[5], field="lesson_kind", max_chars=MAX_CATEGORY_CHARS
                ),
                confidence=require_finite_confidence(row[6]),
                source_excerpt=require_bounded_text(
                    row[7],
                    field="source_excerpt",
                    max_chars=MAX_SOURCE_EXCERPT_CHARS,
                    allow_blank=True,
                ),
                content_fingerprint=fingerprint,
                category=require_bounded_text(
                    row[9],
                    field="category",
                    max_chars=MAX_CATEGORY_CHARS,
                    allow_blank=True,
                ),
                created_at=str(row[10]),
                updated_at=str(row[11]),
                project_id=_project_scope(row[12]),
                origin=str(row[13]),
            )
        except (IndexError, TypeError, ValueError, OverflowError):
            self._quarantine_malformed_row(
                source_table="pending_memory_candidates",
                row=row,
                reason_code="malformed_runtime_row",
            )
            return None
