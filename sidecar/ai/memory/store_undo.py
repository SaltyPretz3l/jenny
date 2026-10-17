"""Undo one recorded memory operation from its ledger row.

The inverse comes from the operation's ``prior_json`` / ``prior_suppression``
and is guarded by compare-and-set on ``result_revision``: a row that moved
since the operation is a ``conflict``. Undo of ``forget`` restores the row
and lifts its suppression only when no newer suppression exists; undo of
``update`` never reintroduces a suppressed text; undo of ``remember`` archives
without suppressing. The undo is itself an operation (``op='undo'``) keyed
by ``undo_operation_id``, so a retried undo replays instead of repeating.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.store_operations import (
    OperationRow,
    check_replay,
    load_operation,
    payload_digest,
    refusal,
    require_operation_id,
    timestamp,
)
from sidecar.ai.memory.store_shared import (
    RECAP_PROVENANCE,
    ApprovedMemory,
    MemoryWriteResult,
    _locked,
    _project_scope,
)
from sidecar.ai.memory.store_write_support import text_digest_for
from sidecar.ai.memory.store_writes import _MemoryWritesMixin
from sidecar.exceptions import MemoryStoreError

_UNDOABLE_OPS = frozenset({"remember", "update", "forget", "restore"})


def _prior_state(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    value = json.loads(raw)
    return value if isinstance(value, dict) else None


class _MemoryUndoMixin(_MemoryWritesMixin):
    @_locked
    def undo(
        self,
        *,
        operation_id: str,
        undo_operation_id: str,
        project_id: str | None = None,
    ) -> MemoryWriteResult:
        """Invert operation *operation_id*; *undo_operation_id* keys the undo itself.

        ``project_id``, when given, must own the operation (else ``not_found``).
        """

        target_id = require_operation_id(operation_id)
        undo_id = require_operation_id(undo_operation_id)
        caller_project = None if project_id is None else _project_scope(project_id)
        request_digest = payload_digest("undo", {"operation_id": target_id})
        with self._guarded_write():
            now = self._now()
            target = load_operation(self._connection, target_id)
            scope = target.scope_key if target is not None else ""
            replay = check_replay(
                self._connection, undo_id, action="undo", scope=scope, digest=request_digest,
                now=now,
            )
            if replay is not None:
                return replay
            project = scope.split("\u0000", 1)[0]
            current = self._undo_target(target, project, caller_project, now=now)
            if target is None or current is None:
                return refusal("not_found")
            refused = self._scope_refusal(project, current.scope_session_id)
            if refused is not None:
                return refused
            if current.revision != target.result_revision:
                return refusal("stale_revision", status="conflict", memory=current)
            refused = self._apply_inverse(target, current, now=now)
            if refused is not None:
                return refused
            self._connection.execute(
                "UPDATE memory_operations SET undone_at = ? WHERE operation_id = ?",
                (timestamp(now), target_id),
            )
            memory = self._row(project, current.id)
            if memory is None:
                raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to undo memory operation")
            return self._record(
                operation_id=undo_id, action="undo", scope=scope, digest=request_digest,
                origin="user", memory=memory, now=now, prior={"undo_of": target_id},
            )

    def _undo_target(
        self,
        target: OperationRow | None,
        project: str,
        caller_project: str | None,
        *,
        now: datetime,
    ) -> ApprovedMemory | None:
        """The row an undo may act on, or None when the operation is not undoable here."""

        if (
            target is None
            or target.expired(now)
            or target.undone_at is not None
            or target.op not in _UNDOABLE_OPS
            or target.memory_id is None
            or (caller_project is not None and caller_project != project)
        ):
            return None
        return self._row(project, target.memory_id)

    def _apply_inverse(
        self, target: OperationRow, current: ApprovedMemory, *, now: datetime
    ) -> MemoryWriteResult | None:
        prior_suppression = _prior_state(target.prior_suppression)
        if target.op in {"remember", "restore"}:
            if current.status != "active":
                return refusal("stale_revision", status="conflict", memory=current)
            self._archive_without_suppressing(current, now=now)
            if prior_suppression is not None and self._suppression(
                current.project_id, current.content_fingerprint
            ) is None:
                self._set_suppression(
                    current.project_id, prior_suppression, current.content_fingerprint
                )
            return None
        if target.op == "forget":
            return self._undo_forget(target, current, prior_suppression, now=now)
        return self._undo_update(target, current, now=now)

    def _archive_without_suppressing(self, current: ApprovedMemory, *, now: datetime) -> None:
        stamp = timestamp(now)
        self._connection.execute(
            """
            UPDATE memories
            SET status = 'archived', archived_at = ?, revision = revision + 1, updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (stamp, stamp, current.project_id, current.id),
        )

    def _undo_forget(
        self,
        target: OperationRow,
        current: ApprovedMemory,
        prior_suppression: dict[str, Any] | None,
        *,
        now: datetime,
    ) -> MemoryWriteResult | None:
        if current.status != "archived":
            return refusal("stale_revision", status="conflict", memory=current)
        suppression = self._suppression(current.project_id, current.content_fingerprint)
        if suppression is not None and suppression["created_at"] != target.created_at:
            return refusal("suppressed", status="conflict", memory=current)
        refused = self._reactivation_refusal(current)
        if refused is not None:
            return refused
        self._reactivate(current, now=now, suppression=prior_suppression)
        return None

    def _undo_update(
        self, target: OperationRow, current: ApprovedMemory, *, now: datetime
    ) -> MemoryWriteResult | None:
        prior = _prior_state(target.prior_json)
        if prior is None or current.status != "active":
            return refusal("not_found")
        prior_text = str(prior["lesson_text"])
        digest = text_digest_for(prior_text, current.provenance)
        if digest != current.content_fingerprint:
            if self._suppression(current.project_id, digest) is not None:
                return refusal("suppressed")
            if self._active_twin(
                current.project_id, current.scope_session_id, digest, exclude_id=current.id,
                recap=current.provenance == RECAP_PROVENANCE,
            ):
                return refusal("already_remembered", memory=current)
        if prior.get("always_on"):
            overflow = self._always_on_overflow(
                current.project_id, prior_text, exclude_id=current.id
            )
            if overflow is not None:
                return overflow
        # Row 58 W3: the source chat was deleted since; undo must not bring its excerpt back.
        source_purged = current.provenance == "source_removed" and self._connection.execute(
            "SELECT 1 FROM memory_session_markers WHERE session_id = ?", (current.session_id,)
        ).fetchone() is not None
        self._connection.execute(
            """
            UPDATE memories
            SET title = ?, lesson_text = ?, lesson_kind = ?, content_fingerprint = ?,
                always_on = ?, protected = ?, source_excerpt = ?, provenance = ?,
                revision = revision + 1, updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (
                str(prior["title"]), prior_text, str(prior["lesson_kind"]), digest,
                int(bool(prior.get("always_on"))), int(bool(prior.get("protected"))),
                "" if source_purged else str(prior.get("source_excerpt") or ""),
                "source_removed" if source_purged else str(prior["provenance"]),
                timestamp(now), current.project_id, current.id,
            ),
        )
        prior_suppression = _prior_state(target.prior_suppression)
        lifted = current.content_fingerprint
        if prior_suppression is not None and self._suppression(current.project_id, lifted) is None:
            # The update lifted a suppression on its new text; put it back.
            self._set_suppression(current.project_id, prior_suppression, lifted)
        return None


__all__ = ["_MemoryUndoMixin"]
