"""Shared models, SQL, and locking for the sidecar memory store."""

from __future__ import annotations

import functools
import itertools
import logging
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, Literal

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.contracts import (  # noqa: F401 - recap ceiling re-exported
    GENERAL_PROJECT_ID,
    MAX_PROMPT_RECAP_LINES,
    require_project_id,
)
from sidecar.exceptions import MemoryStoreError

MAX_RECALL_LIMIT = 5
MAX_HARNESS_PENDING_LIMIT = 200
MAX_CONTENT_LENGTH = 200_000
MAX_ALL_MEMORIES_LIMIT = 10_000
MAX_RECALL_CANDIDATES = 500
MEMORY_RETENTION_MAX_AGE_DAYS = 180
MEMORY_RETENTION_MAX_ROWS_PER_TABLE = 10_000
MEMORY_RETENTION_MAX_DB_BYTES = 256 * 1024 * 1024
MEMORY_MAINTENANCE_MUTATION_INTERVAL = 100
MEMORY_MAINTENANCE_SECONDS = 60 * 60
MEMORY_RETENTION_DELETE_BATCH = 500
# Reflection (row 58 W2): proposals carry "reflection"; the per-chat recap row
# carries RECAP_PROVENANCE and stays out of every listing and recall query.
RECAP_PROVENANCE = "reflection_recap"
NOT_RECAP_SQL = f"provenance != '{RECAP_PROVENANCE}'"
_ALLOWED_MEMORY_PROVENANCE = frozenset(
    {"user_approved", "automatic", "unknown_legacy", "source_removed", "reflection",
     RECAP_PROVENANCE}
)
logger = logging.getLogger(__name__)
_SAVEPOINT_IDS = itertools.count(1)
# Column order is the row contract `_approved_from_row` reads by index.
_APPROVED_MEMORY_COLUMNS = """
    id,
    session_id,
    title,
    lesson_text,
    lesson_kind,
    confidence,
    source_excerpt,
    content_fingerprint,
    provenance,
    created_at,
    updated_at,
    project_id,
    scope_session_id,
    origin,
    status,
    archived_at,
    revision,
    protected,
    always_on,
    source_message_ids
"""
_APPROVED_MEMORY_SELECT = f"SELECT {_APPROVED_MEMORY_COLUMNS} FROM memories"
APPROVED_UPDATED_AT_INDEX = 10
_PENDING_MEMORY_SELECT = """
SELECT
    id,
    session_id,
    source_request_id,
    title,
    lesson_text,
    lesson_kind,
    confidence,
    source_excerpt,
    content_fingerprint,
    category,
    created_at,
    updated_at,
    project_id,
    origin
FROM pending_memory_candidates
"""


@dataclass(frozen=True)
class ApprovedMemory:
    id: int
    session_id: str
    title: str
    lesson_text: str
    lesson_kind: str
    confidence: float
    source_excerpt: str
    content_fingerprint: str
    provenance: str
    created_at: str
    updated_at: str
    project_id: str = GENERAL_PROJECT_ID
    scope_session_id: str = ""
    origin: str = "legacy"
    status: str = "active"
    archived_at: str | None = None
    revision: int = 1
    protected: bool = False
    always_on: bool = False
    source_message_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class PendingMemoryCandidate:
    id: int
    session_id: str
    source_request_id: str
    title: str
    lesson_text: str
    lesson_kind: str
    confidence: float
    source_excerpt: str
    content_fingerprint: str
    category: str
    created_at: str
    updated_at: str
    project_id: str = GENERAL_PROJECT_ID
    origin: str = "legacy"


WriteStatus = Literal["saved", "conflict", "refused"]


@dataclass(frozen=True)
class MemoryWriteResult:
    """Outcome of one v9 memory write. Refusals and conflicts are results."""

    status: WriteStatus
    memory: ApprovedMemory | None
    operation_id: str | None
    duplicate: bool = False
    replayed: bool = False
    undoable: bool = False
    reason: str | None = None
    code: str | None = None
    always_on_lines: tuple[str, ...] = ()


def _project_scope(project_id: object) -> str:
    try:
        return require_project_id(project_id)
    except ValueError as error:
        raise MemoryStoreError(CMP_MEMORY_FAILED, str(error)) from error


def recall_scopes(project_id: str) -> tuple[str, ...]:
    scope = require_project_id(project_id)
    if scope == GENERAL_PROJECT_ID:
        return (scope,)
    return (scope, GENERAL_PROJECT_ID)


def _locked(method):
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return wrapper


@contextmanager
def _transaction(connection: sqlite3.Connection) -> Iterator[None]:
    """Commit one mutation or roll it back without masking its original failure."""

    if connection.in_transaction:
        savepoint = f"memory_nested_{next(_SAVEPOINT_IDS)}"
        connection.execute(f"SAVEPOINT {savepoint}")
        try:
            yield
            connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        except BaseException:
            try:
                connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                connection.execute(f"RELEASE SAVEPOINT {savepoint}")
            except sqlite3.DatabaseError:
                logger.warning("%s memory_savepoint_rollback_failed", CMP_MEMORY_FAILED)
            raise
        return

    try:
        connection.execute("BEGIN IMMEDIATE")
        yield
        connection.commit()
    except BaseException:
        try:
            connection.rollback()
        except sqlite3.DatabaseError:
            logger.warning("%s memory_transaction_rollback_failed", CMP_MEMORY_FAILED)
        raise
