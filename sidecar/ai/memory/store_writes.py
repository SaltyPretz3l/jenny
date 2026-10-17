"""Schema v9 write semantics: remember, update, forget, restore and erase.

Every write is one ``BEGIN IMMEDIATE`` transaction under the store lock, in a
fixed order: replay check -> scope checks (project archived, chat purged) ->
suppression check -> protected check -> compare-and-set on ``revision`` ->
write the row and its operation -> commit. Every refusal is decided before
the first mutation, so a refused write changes nothing. Refusals and
conflicts are results, never exceptions; invalid arguments raise
``MemoryStoreError(CMP_MEMORY_FAILED)``. No memory text reaches a log.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.contracts import (
    MAX_ACTIVE_MEMORIES,
    MAX_LESSON_TEXT_CHARS,
    MAX_PROVENANCE_CHARS,
    MAX_SESSION_ID_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    MAX_TITLE_CHARS,
    MEMORY_KINDS,
    WRITE_ORIGINS,
    require_finite_confidence,
)
from sidecar.ai.memory.store_operations import (
    check_replay,
    memory_to_dict,
    payload_digest,
    refusal,
    require_operation_id,
    scope_key,
    stub_operations,
    timestamp,
)
from sidecar.ai.memory.store_shared import (
    _ALLOWED_MEMORY_PROVENANCE,
    RECAP_PROVENANCE,
    ApprovedMemory,
    MemoryWriteResult,
    _locked,
    _project_scope,
)
from sidecar.ai.memory.store_write_support import (
    _bounded,
    _choice,
    _flag,
    _invalid,
    _memory_id,
    _memory_text,
    _MemoryWriteSupportMixin,
    _message_ids,
    _revision,
    _title_for,
    _writer_refusal,
    text_digest_for,
)
from sidecar.exceptions import MemoryStoreError


class _MemoryWritesMixin(_MemoryWriteSupportMixin):
    def _at_active_capacity(self) -> bool:
        row = self._connection.execute(
            "SELECT COUNT(*) FROM memories WHERE status = 'active'"
        ).fetchone()
        return int(row[0] if row else 0) >= MAX_ACTIVE_MEMORIES

    # --- remember -------------------------------------------------------------

    @_locked
    def remember(  # noqa: PLR0913 - the fixed v9 service contract.
        self,
        *,
        operation_id: str,
        project_id: str,
        text: str,
        kind: str,
        origin: str,
        session_id: str,
        scope_session_id: str = "",
        always_on: bool = False,
        protected: bool = False,
        source_message_ids: tuple[str, ...] | list[str] = (),
        confidence: float = 1.0,
        source_excerpt: str = "",
        title: str | None = None,
        provenance: str | None = None,
    ) -> MemoryWriteResult:
        """Save one memory; a duplicate returns the existing row with no operation."""

        project = _project_scope(project_id)
        op_id = require_operation_id(operation_id)
        lesson = _memory_text(text, "text", MAX_LESSON_TEXT_CHARS)
        lesson_kind = _choice(kind, "kind", MEMORY_KINDS)
        writer = _choice(origin, "origin", WRITE_ORIGINS)
        origin_session = _bounded(session_id, "session_id", MAX_SESSION_ID_CHARS)
        scope_session = _bounded(
            scope_session_id, "scope_session_id", MAX_SESSION_ID_CHARS, allow_blank=True
        )
        wants_always_on = _flag(always_on, "always_on")
        if wants_always_on and scope_session:
            raise _invalid("always_on needs project or global scope")
        values: dict[str, Any] = {
            "title": _title_for(title, lesson),
            "protected": _flag(protected, "protected"),
            "source_message_ids": json.dumps(list(_message_ids(source_message_ids))),
            "confidence": self._confidence(confidence),
            "source_excerpt": _bounded(
                source_excerpt, "source_excerpt", MAX_SOURCE_EXCERPT_CHARS, allow_blank=True
            ),
            "provenance": self._provenance(provenance, writer),
        }
        is_recap = values["provenance"] == RECAP_PROVENANCE
        digest = text_digest_for(lesson, values["provenance"])
        scope = scope_key(project, scope_session)
        request_digest = payload_digest(
            "remember",
            {"text": lesson, "kind": lesson_kind, "always_on": wants_always_on,
             "protected": values["protected"], "origin": writer},
        )
        self._prepare_capacity_for_growth()
        with self._guarded_write():
            now = self._now()
            replay = check_replay(
                self._connection, op_id, action="remember", scope=scope, digest=request_digest,
                now=now,
            )
            if replay is not None:
                return replay
            suppression = self._suppression(project, digest)
            refused = self._scope_refusal(project, scope_session) or _writer_refusal(
                writer, suppressed=suppression is not None, protected=False
            )
            if refused is not None:
                return refused
            twin = self._active_twin(project, scope_session, digest, recap=is_recap)
            if twin is not None:
                if suppression is not None:
                    self._set_suppression(project, None, digest)
                return MemoryWriteResult(
                    status="saved", memory=twin, operation_id=None, duplicate=True
                )
            if wants_always_on:
                overflow = self._always_on_overflow(project, lesson)
                if overflow is not None:
                    return overflow
            if self._at_active_capacity():
                return refusal("capacity")
            self._assert_capacity_for_growth()
            if suppression is not None:
                self._set_suppression(project, None, digest)
            stamp = timestamp(now)
            cursor = self._connection.execute(
                """
                INSERT INTO memories (
                    project_id, scope_session_id, session_id, title, lesson_text, lesson_kind,
                    confidence, source_excerpt, content_fingerprint, provenance, origin,
                    status, revision, protected, always_on, source_message_ids,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)
                """,
                (
                    project, scope_session, origin_session, values["title"], lesson, lesson_kind,
                    values["confidence"], values["source_excerpt"], digest, values["provenance"],
                    writer, int(values["protected"]), int(wants_always_on),
                    values["source_message_ids"], stamp, stamp,
                ),
            )
            self._connection.execute(
                """
                DELETE FROM pending_memory_candidates
                WHERE project_id = ? AND session_id = ? AND content_fingerprint = ?
                """,
                (project, origin_session, digest),
            )
            memory = self._row(project, int(cursor.lastrowid or 0))
            if memory is None:
                raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to save memory")
            return self._record(
                operation_id=op_id, action="remember", scope=scope, digest=request_digest,
                origin=writer, memory=memory, now=now, prior_suppression=suppression,
            )

    @staticmethod
    def _confidence(value: Any) -> float:
        try:
            return require_finite_confidence(value)
        except ValueError as error:
            raise _invalid(str(error)) from error

    @staticmethod
    def _provenance(value: Any, origin: str) -> str:
        if value is None:
            return "user_approved" if origin == "user" else "automatic"
        normalized = _bounded(value, "provenance", MAX_PROVENANCE_CHARS).lower()
        if normalized not in _ALLOWED_MEMORY_PROVENANCE:
            raise _invalid("provenance is required")
        return normalized

    # --- update ---------------------------------------------------------------

    @_locked
    def update(  # noqa: PLR0913 - the fixed v9 service contract.
        self,
        *,
        operation_id: str,
        project_id: str,
        memory_id: int,
        text: str | None = None,
        kind: str | None = None,
        always_on: bool | None = None,
        expected_revision: int | None,
        origin: str,
        title: str | None = None,
        remove_provenance: bool = False,
    ) -> MemoryWriteResult:
        """Edit one active row in place (``revision + 1``); a user edit protects it."""

        project = _project_scope(project_id)
        op_id = require_operation_id(operation_id)
        target = _memory_id(memory_id)
        revision = _revision(expected_revision)
        writer = _choice(origin, "origin", WRITE_ORIGINS)
        lesson = None if text is None else _memory_text(text, "text", MAX_LESSON_TEXT_CHARS)
        lesson_kind = None if kind is None else _choice(kind, "kind", MEMORY_KINDS)
        wants_always_on = None if always_on is None else _flag(always_on, "always_on")
        new_title = None if title is None else _bounded(title, "title", MAX_TITLE_CHARS)
        request_digest = payload_digest(
            "update",
            {"memory_id": target, "text": lesson, "kind": lesson_kind, "always_on": wants_always_on,
             "expected_revision": revision, "title": new_title,
             "remove_provenance": bool(remove_provenance), "origin": writer},
        )
        if lesson is not None:
            self._prepare_capacity_for_growth()
        with self._guarded_write():
            now = self._now()
            current = self._row(project, target)
            scope = scope_key(project, current.scope_session_id if current else "")
            replay = check_replay(
                self._connection, op_id, action="update", scope=scope, digest=request_digest,
                now=now,
            )
            if replay is not None:
                return replay
            fence = self._scope_refusal(project, current.scope_session_id) if current else None
            if fence is not None:
                return fence
            if current is None or current.status != "active":
                return refusal("not_found")
            next_text = lesson if lesson is not None else current.lesson_text
            digest = text_digest_for(next_text, current.provenance)
            suppression = (
                self._suppression(project, digest)
                if digest != current.content_fingerprint
                else None
            )
            next_always_on = current.always_on if wants_always_on is None else wants_always_on
            refused = self._update_refusal(
                current,
                writer=writer,
                revision=revision,
                digest=digest,
                suppressed=suppression is not None,
                always_on_text=next_text if next_always_on else None,
            )
            if refused is not None:
                return refused
            next_title = _next_title(new_title, lesson, current)
            if len(next_title) + len(next_text) > len(current.title) + len(current.lesson_text):
                self._assert_capacity_for_growth()
            if suppression is not None:
                self._set_suppression(project, None, digest)
            self._connection.execute(
                """
                UPDATE memories
                SET title = ?, lesson_text = ?, lesson_kind = ?, content_fingerprint = ?,
                    always_on = ?, protected = ?, source_excerpt = ?, provenance = ?,
                    revision = revision + 1, updated_at = ?
                WHERE project_id = ? AND id = ?
                """,
                (
                    next_title, next_text, lesson_kind or current.lesson_kind, digest,
                    int(next_always_on), int(current.protected or writer == "user"),
                    "" if remove_provenance else current.source_excerpt,
                    "source_removed" if remove_provenance else current.provenance,
                    timestamp(now), project, current.id,
                ),
            )
            memory = self._row(project, current.id)
            if memory is None:
                raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to save memory")
            return self._record(
                operation_id=op_id, action="update", scope=scope, digest=request_digest,
                origin=writer, memory=memory, now=now, prior=memory_to_dict(current),
                prior_suppression=suppression,
            )

    def _update_refusal(  # noqa: PLR0913 - the update gate needs each fact.
        self,
        current: ApprovedMemory,
        *,
        writer: str,
        revision: int | None,
        digest: str,
        suppressed: bool,
        always_on_text: str | None,
    ) -> MemoryWriteResult | None:
        """The update ladder: scope, suppression, protected, CAS, twin, always-on budget."""

        project = current.project_id
        refused = self._scope_refusal(project, current.scope_session_id) or _writer_refusal(
            writer, suppressed=suppressed, protected=current.protected
        )
        if refused is not None:
            return refused
        if revision is not None and revision != current.revision:
            return refusal("stale_revision", status="conflict", memory=current)
        if digest != current.content_fingerprint and self._active_twin(
            project, current.scope_session_id, digest, exclude_id=current.id,
            recap=current.provenance == RECAP_PROVENANCE,
        ):
            return refusal("already_remembered", memory=current)
        if always_on_text is None:
            return None
        if current.scope_session_id:
            raise _invalid("always_on needs project or global scope")
        return self._always_on_overflow(project, always_on_text, exclude_id=current.id)

    # --- forget and restore ---------------------------------------------------

    @_locked
    def forget(
        self,
        *,
        operation_id: str,
        project_id: str,
        memory_id: int,
        expected_revision: int | None,
        origin: str,
    ) -> MemoryWriteResult:
        """Archive one active row and suppress its text in the project."""

        project = _project_scope(project_id)
        op_id = require_operation_id(operation_id)
        target = _memory_id(memory_id)
        revision = _revision(expected_revision)
        writer = _choice(origin, "origin", WRITE_ORIGINS)
        request_digest = payload_digest(
            "forget", {"memory_id": target, "expected_revision": revision, "origin": writer}
        )
        with self._guarded_write():
            now = self._now()
            current = self._row(project, target)
            scope = scope_key(project, current.scope_session_id if current else "")
            replay = check_replay(
                self._connection, op_id, action="forget", scope=scope, digest=request_digest,
                now=now,
            )
            if replay is not None:
                return replay
            fence = self._scope_refusal(project, current.scope_session_id) if current else None
            if fence is not None:
                return fence
            if current is None or current.status != "active":
                return refusal("not_found")
            refused = self._scope_refusal(project, current.scope_session_id)
            refused = refused or _writer_refusal(
                writer, suppressed=False, protected=current.protected
            )
            if refused is not None:
                return refused
            if revision is not None and revision != current.revision:
                return refusal("stale_revision", status="conflict", memory=current)
            prior_suppression = self._suppression(project, current.content_fingerprint)
            stamp = timestamp(now)
            self._connection.execute(
                """
                UPDATE memories
                SET status = 'archived', archived_at = ?, revision = revision + 1, updated_at = ?
                WHERE project_id = ? AND id = ?
                """,
                (stamp, stamp, project, current.id),
            )
            self._set_suppression(
                project, {"reason": "forgotten", "created_at": stamp}, current.content_fingerprint
            )
            self._connection.execute(
                """
                DELETE FROM pending_memory_candidates
                WHERE project_id = ? AND content_fingerprint = ?
                """,
                (project, current.content_fingerprint),
            )
            memory = self._row(project, current.id)
            if memory is None:
                raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to forget memory")
            return self._record(
                operation_id=op_id, action="forget", scope=scope, digest=request_digest,
                origin=writer, memory=memory, now=now, prior=memory_to_dict(current),
                prior_suppression=prior_suppression,
            )

    @_locked
    def restore(
        self,
        *,
        operation_id: str,
        project_id: str,
        memory_id: int,
        origin: str = "user",
    ) -> MemoryWriteResult:
        """Bring one archived row back and lift its suppression."""

        project = _project_scope(project_id)
        op_id = require_operation_id(operation_id)
        target = _memory_id(memory_id)
        writer = _choice(origin, "origin", WRITE_ORIGINS)
        request_digest = payload_digest("restore", {"memory_id": target, "origin": writer})
        self._prepare_capacity_for_growth()
        with self._guarded_write():
            now = self._now()
            current = self._row(project, target)
            scope = scope_key(project, current.scope_session_id if current else "")
            replay = check_replay(
                self._connection, op_id, action="restore", scope=scope, digest=request_digest,
                now=now,
            )
            if replay is not None:
                return replay
            if current is None:
                return refusal("not_found")
            if current.status == "active":
                return MemoryWriteResult(
                    status="saved", memory=current, operation_id=None, duplicate=True
                )
            suppression = self._suppression(project, current.content_fingerprint)
            refused = (
                self._scope_refusal(project, current.scope_session_id)
                or _writer_refusal(
                    writer, suppressed=suppression is not None, protected=current.protected
                )
                or self._reactivation_refusal(current)
            )
            if refused is not None:
                return refused
            self._reactivate(current, now=now, suppression=None)
            memory = self._row(project, current.id)
            if memory is None:
                raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to restore memory")
            return self._record(
                operation_id=op_id, action="restore", scope=scope, digest=request_digest,
                origin=writer, memory=memory, now=now, prior=memory_to_dict(current),
                prior_suppression=suppression,
            )

    def _reactivation_refusal(self, current: ApprovedMemory) -> MemoryWriteResult | None:
        if self._active_twin(
            current.project_id, current.scope_session_id, current.content_fingerprint,
            recap=current.provenance == RECAP_PROVENANCE,
        ):
            return refusal("already_remembered", memory=current)
        if current.always_on:
            overflow = self._always_on_overflow(current.project_id, current.lesson_text)
            if overflow is not None:
                return overflow
        if self._at_active_capacity():
            return refusal("capacity")
        return None

    def _reactivate(
        self, current: ApprovedMemory, *, now: datetime, suppression: dict[str, Any] | None
    ) -> None:
        self._assert_capacity_for_growth()
        self._connection.execute(
            """
            UPDATE memories
            SET status = 'active', archived_at = NULL, revision = revision + 1, updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (timestamp(now), current.project_id, current.id),
        )
        self._set_suppression(current.project_id, suppression, current.content_fingerprint)

    # --- erase ----------------------------------------------------------------

    @_locked
    def erase(self, *, project_id: str, memory_id: int) -> bool:
        """Hard-delete one row (any status); its operations become content-free stubs."""

        project = _project_scope(project_id)
        target = _memory_id(memory_id)
        with self._guarded_write():
            deleted = self._connection.execute(
                "DELETE FROM memories WHERE project_id = ? AND id = ?", (project, target)
            ).rowcount
            if deleted:
                stub_operations(self._connection, where="memory_id = ?", params=(target,))
        return bool(deleted)


def _next_title(new_title: str | None, lesson: str | None, current: ApprovedMemory) -> str:
    """An explicit title wins; a changed text re-derives the title; else keep it."""

    if new_title is not None:
        return new_title
    if lesson is not None and lesson != current.lesson_text:
        return _title_for(None, lesson)
    return current.title


__all__ = ["_MemoryWritesMixin"]
