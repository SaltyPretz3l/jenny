"""Pending memory-candidate persistence for the sidecar memory store."""

from __future__ import annotations

import sqlite3
from contextlib import AbstractContextManager
from datetime import datetime, timezone
from typing import Any, Callable

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.contracts import (
    MAX_CATEGORY_CHARS,
    MAX_FAMILY_KEY_CHARS,
    MAX_LESSON_TEXT_CHARS,
    MAX_REQUEST_ID_CHARS,
    MAX_SESSION_ID_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    MAX_TITLE_CHARS,
    is_content_digest,
    require_bounded_text,
    require_finite_confidence,
)
from sidecar.ai.memory.store_shared import (
    _PENDING_MEMORY_SELECT,
    MAX_HARNESS_PENDING_LIMIT,
    MAX_RECALL_LIMIT,
    PendingMemoryCandidate,
    _locked,
)
from sidecar.exceptions import MemoryStoreError


class _PendingCandidatesMixin:
    # _connection is owned by the concrete MemoryStore hub (sidecar/ai/memory/store.py);
    # declared here only so mypy can see it across the mixin split. This is a bare
    # annotation with no assigned value, so it has zero runtime effect.
    _connection: sqlite3.Connection
    _write_transaction: Callable[[], AbstractContextManager[None]]
    _assert_capacity_for_growth: Callable[[], None]
    _prepare_capacity_for_growth: Callable[[], None]
    _quarantine_malformed_row: Callable[..., None]

    @_locked
    def get_pending_candidates(
        self,
        session_id: str,
        limit: int = MAX_RECALL_LIMIT,
    ) -> list[PendingMemoryCandidate]:
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "session_id is required")

        safe_limit = max(1, min(int(limit), MAX_RECALL_LIMIT))
        try:
            rows = self._connection.execute(
                f"""
                {_PENDING_MEMORY_SELECT}
                WHERE session_id = ?
                ORDER BY confidence DESC, updated_at DESC, id DESC
                LIMIT ?
                """,
                (normalized_session_id, safe_limit),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED,
                "failed to read pending memory candidates",
            ) from error
        return self._pending_rows(rows)

    @_locked
    def get_pending_candidates_for_harness(
        self,
        limit: int = 80,
    ) -> list[PendingMemoryCandidate]:
        safe_limit = max(1, min(int(limit), MAX_HARNESS_PENDING_LIMIT))
        try:
            rows = self._connection.execute(
                f"""
                {_PENDING_MEMORY_SELECT}
                ORDER BY updated_at DESC, id DESC
                LIMIT ?
                """,
                (safe_limit,),
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
        legacy_offset: int | None = None,
    ) -> tuple[list[PendingMemoryCandidate], tuple[int, int] | int | None]:
        safe_limit = max(1, min(int(limit), 250))
        try:
            if legacy_offset is not None:
                safe_offset = max(0, int(legacy_offset))
                rows = self._connection.execute(
                    f"""
                    {_PENDING_MEMORY_SELECT}
                    ORDER BY updated_at DESC, id DESC
                    LIMIT ? OFFSET ?
                    """,
                    (safe_limit + 1, safe_offset),
                ).fetchall()
                has_more = len(rows) > safe_limit
                page = rows[:safe_limit]
                return (
                    self._pending_rows(page),
                    safe_offset + safe_limit if has_more else None,
                )

            if snapshot_max_id is None:
                anchor_row = self._connection.execute(
                    "SELECT COALESCE(MAX(id), 0) FROM pending_memory_candidates"
                ).fetchone()
                snapshot_max_id = int(anchor_row[0] if anchor_row else 0)
            safe_snapshot = max(0, int(snapshot_max_id))
            safe_after = safe_snapshot + 1 if after_id is None else max(0, int(after_id))
            rows = self._connection.execute(
                f"""
                {_PENDING_MEMORY_SELECT}
                WHERE id <= ? AND id < ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (safe_snapshot, safe_after, safe_limit + 1),
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
    ) -> bool:
        normalized_session_id = str(session_id or "").strip()
        normalized_fingerprint = str(content_fingerprint or "").strip().lower()
        if not normalized_session_id or not normalized_fingerprint:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED, "session_id and content_fingerprint are required"
            )
        try:
            with self._write_transaction():
                existing = self._connection.execute(
                    """
                    SELECT 1 FROM pending_memory_candidates
                    WHERE session_id = ? AND content_fingerprint = ? LIMIT 1
                    """,
                    (normalized_session_id, normalized_fingerprint),
                ).fetchone()
                cursor = self._connection.execute(
                    """
                    DELETE FROM pending_memory_candidates
                    WHERE session_id = ? AND content_fingerprint = ?
                    """,
                    (normalized_session_id, normalized_fingerprint),
                )
                if existing:
                    self._connection.execute(
                        """
                        INSERT INTO memory_suppressions (
                            content_fingerprint, reason, created_at
                        ) VALUES (?, 'dismissed', ?)
                        ON CONFLICT(content_fingerprint) DO UPDATE SET
                            reason = excluded.reason,
                            created_at = excluded.created_at
                        """,
                        (
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
                family_key=require_bounded_text(
                    row[9],
                    field="family_key",
                    max_chars=MAX_FAMILY_KEY_CHARS,
                    allow_blank=True,
                ),
                category=require_bounded_text(
                    row[10],
                    field="category",
                    max_chars=MAX_CATEGORY_CHARS,
                    allow_blank=True,
                ),
                created_at=str(row[11]),
                updated_at=str(row[12]),
            )
        except (IndexError, TypeError, ValueError, OverflowError):
            self._quarantine_malformed_row(
                source_table="pending_memory_candidates",
                row=row,
                reason_code="malformed_runtime_row",
            )
            return None
