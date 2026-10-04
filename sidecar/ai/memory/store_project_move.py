"""Move every memory row of one project to another (desktop project delete).

Deleting a project in the desktop app moves its chats to General; its memories
follow in one transaction so Memory never shows a deleted project's id. A row
whose content the target already holds cannot move (the per-project unique
fingerprint) and is merged into the target's copy instead: the duplicate is
dropped, so nothing the user can see is lost.
"""

from __future__ import annotations

import sqlite3
from contextlib import AbstractContextManager
from typing import Callable

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, require_project_id
from sidecar.ai.memory.store_shared import _locked
from sidecar.exceptions import MemoryStoreError

# Tables whose rows carry project scope, in move order. Approved memories come
# first so the counts below describe what the user sees.
_PROJECT_TABLES = (
    "memories",
    "pending_memory_candidates",
    "memory_suppressions",
    "memory_extraction_runs",
)


def validate_move_scopes(source_project_id: object, target_project_id: object) -> tuple[str, str]:
    source = require_project_id(source_project_id)
    target = require_project_id(target_project_id)
    if source == GENERAL_PROJECT_ID:
        raise ValueError("General memories cannot be moved out")
    if source == target:
        raise ValueError("source and target projects must differ")
    return source, target


class _ProjectMoveMixin:
    # Owned by the concrete MemoryStore hub (sidecar/ai/memory/store.py);
    # declared for mypy across the mixin split, with no runtime effect.
    _connection: sqlite3.Connection
    _write_transaction: Callable[[], AbstractContextManager[None]]

    @_locked
    def move_project_memories(
        self,
        *,
        source_project_id: str,
        target_project_id: str,
    ) -> dict[str, int]:
        source, target = validate_move_scopes(source_project_id, target_project_id)
        counts: dict[str, int] = {}
        # Electron reads an error from this call as "nothing moved" and puts
        # the project back (DPR-008). That holds because an error can only come
        # from before the commit or from a rolled-back transaction: what
        # `_write_transaction` does after the commit never raises.
        try:
            with self._write_transaction():
                for table in _PROJECT_TABLES:
                    moved = self._connection.execute(
                        f"UPDATE OR IGNORE {table} SET project_id = ? WHERE project_id = ?",
                        (target, source),
                    ).rowcount
                    merged = self._connection.execute(
                        f"DELETE FROM {table} WHERE project_id = ?",
                        (source,),
                    ).rowcount
                    counts[table] = int(moved or 0)
                    counts[f"{table}:merged"] = int(merged or 0)
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to move project memories") from error
        return {
            "moved": counts["memories"],
            "merged": counts["memories:merged"],
            "pending_moved": counts["pending_memory_candidates"],
        }


__all__ = ["_ProjectMoveMixin", "validate_move_scopes"]
