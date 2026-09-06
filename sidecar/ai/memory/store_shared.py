"""Shared models, SQL, and locking for the sidecar memory store."""

from __future__ import annotations

import functools
import itertools
import logging
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

from sidecar.ai.error_codes import CMP_MEMORY_FAILED

MAX_RECALL_LIMIT = 5
PROMPT_RECALL_TOKEN_BUDGET = 256
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
_ALLOWED_MEMORY_PROVENANCE = frozenset(
    {"user_approved", "automatic", "unknown_legacy", "source_removed"}
)
logger = logging.getLogger(__name__)
_SAVEPOINT_IDS = itertools.count(1)
_APPROVED_MEMORY_SELECT = """
SELECT
    id,
    session_id,
    title,
    lesson_text,
    lesson_kind,
    confidence,
    source_excerpt,
    content_fingerprint,
    family_key,
    provenance,
    created_at,
    updated_at
FROM memories
"""
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
    family_key,
    category,
    created_at,
    updated_at
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
    family_key: str
    provenance: str
    created_at: str
    updated_at: str


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
    family_key: str
    category: str
    created_at: str
    updated_at: str


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
