"""Restore a deleted project's forgotten row into another project (row 58 W4).

The Memory page's "Restore to…": a deleted (archived) project's memories come
back only where the user puts them, one row at a time, never automatically
into General (owner decision 2 stands).
"""

from __future__ import annotations

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.store_operations import (
    check_replay,
    memory_to_dict,
    payload_digest,
    refusal,
    require_operation_id,
    scope_key,
    timestamp,
)
from sidecar.ai.memory.store_shared import (
    RECAP_PROVENANCE,
    ApprovedMemory,
    MemoryWriteResult,
    _locked,
    _project_scope,
)
from sidecar.ai.memory.store_write_support import _invalid, _memory_id
from sidecar.ai.memory.store_writes import _MemoryWritesMixin
from sidecar.exceptions import MemoryStoreError


class _MemoryRestoreToMixin(_MemoryWritesMixin):
    @_locked
    def restore_to(
        self,
        *,
        operation_id: str,
        project_id: str,
        memory_id: int,
        target_project_id: str,
    ) -> MemoryWriteResult:
        """Restore one forgotten row of a deleted project into *target_project_id*.

        The user's "Restore to…" on the Memory page (row 58 W4); user origin
        only. The deleted project stays fenced for every other write. A live
        project's row or a chat note is an invalid request; a duplicate,
        a full always-on section or a full store refuses as a plain restore
        does. The text's suppression in the target is lifted, and the operation
        is recorded in the target's scope, so its Undo forgets the row there.
        """

        source = _project_scope(project_id)
        destination = _project_scope(target_project_id)
        op_id = require_operation_id(operation_id)
        target = _memory_id(memory_id)
        request_digest = payload_digest(
            "restore_to", {"memory_id": target, "target_project_id": destination}
        )
        scope = scope_key(destination, "")
        self._prepare_capacity_for_growth()
        with self._guarded_write():
            now = self._now()
            replay = check_replay(
                self._connection, op_id, action="restore", scope=scope, digest=request_digest,
                now=now,
            )
            if replay is not None:
                return replay
            current = self._row(source, target)
            if (
                current is None
                or current.status != "archived"
                or current.provenance == RECAP_PROVENANCE
            ):
                return refusal("not_found")
            refused = self._restore_to_refusal(current, destination)
            if refused is not None:
                return refused
            prior_suppression = self._suppression(destination, current.content_fingerprint)
            self._assert_capacity_for_growth()
            self._connection.execute(
                """
                UPDATE memories
                SET project_id = ?, status = 'active', archived_at = NULL,
                    revision = revision + 1, updated_at = ?
                WHERE project_id = ? AND id = ?
                """,
                (destination, timestamp(now), source, current.id),
            )
            self._set_suppression(destination, None, current.content_fingerprint)
            memory = self._row(destination, current.id)
            if memory is None:
                raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to restore memory")
            return self._record(
                operation_id=op_id, action="restore", scope=scope, digest=request_digest,
                origin="user", memory=memory, now=now, prior=memory_to_dict(current),
                prior_suppression=prior_suppression,
            )

    def _restore_to_refusal(
        self, current: ApprovedMemory, destination: str
    ) -> MemoryWriteResult | None:
        # The page offers "Restore to…" only for a deleted project's shared rows.
        if self._scope_refusal(current.project_id, "") is None:
            raise _invalid("a live project's row restores in place")
        if current.scope_session_id:
            raise _invalid("a chat note cannot move to another project")
        refused = self._scope_refusal(destination, "")
        if refused is not None:
            return refused
        if self._active_twin(destination, "", current.content_fingerprint):
            return refusal("already_remembered", memory=current)
        if current.always_on:
            return self._always_on_overflow(destination, current.lesson_text)
        return None
