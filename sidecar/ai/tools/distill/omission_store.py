"""Reversible omission store for distilled tool output.

Workspace-scoped SQLite (``.jenny/omissions/omissions.db``), schema-versioned,
WAL, TTL + size-cap pruned opportunistically on write. Mirrors the memory
store's connection lifecycle (mkdir → connect → configure → migrate). Instances
are shared across calls via the package-level cache in ``distill/__init__``, so
the instance ``RLock`` genuinely serializes concurrent in-process callers;
cross-process sharing is handled by SQLite WAL + the 10s busy timeout.
Content-addressed: a ref is the first 12 hex of the sha256 of the stored text,
so identical omitted segments dedupe to one row.

Stores only bytes that have already passed the sanitization *redaction*
primitives — the caller (the distill orchestrator) redacts before calling
``put``, so the store never holds an un-redacted secret.

Liveness contract: ``put`` refreshes ``created_at`` on a content collision, so a
segment re-referenced by a fresh marker is treated as newly written — TTL prune
can never drop a row a just-spliced marker points to. Batch callers pass
``prune=False`` per segment and run one ``prune(protect=refs)`` afterwards so
size-cap eviction cannot cannibalize an earlier segment of the same command.
"""

from __future__ import annotations

import functools
import hashlib
import logging
import sqlite3
import threading
import time
import zlib
from collections.abc import Collection
from pathlib import Path
from typing import TYPE_CHECKING

from sidecar.ai.tools.distill.omission_store_migrations import (
    configure_connection,
    run_migrations,
)

if TYPE_CHECKING:
    from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, StoreRef

logger = logging.getLogger(__name__)

_BYTES_PER_MB = 1_000_000
_SECONDS_PER_DAY = 86_400.0


def _locked(method):
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return wrapper


def estimate_tokens(text: str) -> int:
    """Rough char/4 token estimate — deterministic, index-free, good enough for
    the ``~<k>k tokens`` figure in an omission marker."""
    return max(1, len(text) // 4)


def _protect_clause(protect: Collection[str]) -> tuple[str, tuple[str, ...]]:
    """SQL fragment + params excluding *protect* refs (bounded: one command's
    segments). Empty protect → no-op fragment."""
    refs = tuple(protect)
    if not refs:
        return "", ()
    placeholders = ",".join("?" * len(refs))
    return f" AND ref NOT IN ({placeholders})", refs


class OmissionStore:
    """Content-addressed, bounded, reversible store for omitted output bytes."""

    def __init__(
        self,
        db_path: Path | None,
        *,
        ttl_days: float = 7.0,
        max_mb: float = 50.0,
        workspace_store: GuardedWorkspaceStore | None = None,
        db_ref: StoreRef | None = None,
    ) -> None:
        if (workspace_store is None) != (db_ref is None):
            raise ValueError("workspace_store and db_ref must be provided together")
        if workspace_store is None and db_path is None:
            raise ValueError("db_path is required for an unguarded omission store")
        self._db_path = db_path
        self._workspace_store = workspace_store
        self._db_ref = db_ref
        self._ttl_days = float(ttl_days)
        self._max_bytes = int(max_mb * _BYTES_PER_MB)
        self._lock = threading.RLock()
        if workspace_store is not None and db_ref is not None:
            self._connection = workspace_store.open_sqlite(db_ref)
        else:
            assert db_path is not None
            db_path.parent.mkdir(parents=True, exist_ok=True)
            self._connection = sqlite3.connect(
                str(db_path),
                timeout=10.0,
                check_same_thread=False,
            )
        self._journal_mode = configure_connection(self._connection)
        run_migrations(self._connection)

    @classmethod
    def from_workspace_store(
        cls,
        workspace_store: GuardedWorkspaceStore,
        db_ref: StoreRef,
        *,
        ttl_days: float = 7.0,
        max_mb: float = 50.0,
    ) -> OmissionStore:
        return cls(
            None,
            ttl_days=ttl_days,
            max_mb=max_mb,
            workspace_store=workspace_store,
            db_ref=db_ref,
        )

    @property
    def db_path(self) -> Path:
        if self._db_path is None:
            raise RuntimeError("guarded omission stores do not expose a database path")
        return self._db_path

    @property
    def journal_mode(self) -> str:
        return self._journal_mode

    @_locked
    def put(self, content: str, *, source: str, prune: bool = True) -> str:
        """Store *content*, returning a stable 12-hex ref.

        Idempotent by content; a collision REFRESHES ``created_at`` (liveness —
        the caller is about to splice a fresh marker pointing at this ref, so it
        must be treated as newly written for TTL purposes). Prunes
        opportunistically after the write unless ``prune=False`` (batch callers
        run one protected ``prune()`` after all their puts instead).
        """
        self._revalidate_guarded()
        encoded = content.encode("utf-8")
        ref = hashlib.sha256(encoded).hexdigest()[:12]
        blob = zlib.compress(encoded)
        # kept_tokens / access_count are reserved telemetry columns (candidate
        # v2 LRU/savings inputs); nothing writes them on the hot path today.
        self._connection.execute(
            "INSERT INTO omissions "
            "(ref, content, source, created_at, original_tokens, kept_tokens, access_count) "
            "VALUES (?, ?, ?, ?, ?, ?, 0) "
            "ON CONFLICT(ref) DO UPDATE SET "
            "created_at=excluded.created_at, source=excluded.source",
            (ref, blob, source, time.time(), estimate_tokens(content), None),
        )
        self._connection.commit()
        if prune:
            self._prune_locked(protect=(ref,))
        return ref

    @_locked
    def prune(self, *, protect: Collection[str] = ()) -> tuple[int, int]:
        """Run TTL + size-cap pruning now, never evicting *protect* refs.
        Returns ``(ttl_evicted, size_evicted)``."""
        self._revalidate_guarded()
        return self._prune_locked(protect=protect)

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    # ── internals (already holding the lock) ──────────────────────────

    def _prune_locked(self, *, protect: Collection[str] = ()) -> tuple[int, int]:
        ttl_evicted = self._prune_ttl(protect)
        size_evicted = self._prune_size(protect)
        if ttl_evicted or size_evicted:
            logger.info(
                "omission store pruned rows",
                extra={
                    "ttl_evicted": ttl_evicted,
                    "size_evicted": size_evicted,
                    "store": "workspace" if self._workspace_store is not None else "standalone",
                },
            )
        return ttl_evicted, size_evicted

    def _revalidate_guarded(self) -> None:
        if self._workspace_store is not None and self._db_ref is not None:
            self._workspace_store.revalidate(self._db_ref)

    def _prune_ttl(self, protect: Collection[str]) -> int:
        if self._ttl_days <= 0:
            return 0
        cutoff = time.time() - self._ttl_days * _SECONDS_PER_DAY
        clause, params = _protect_clause(protect)
        cursor = self._connection.execute(
            f"DELETE FROM omissions WHERE created_at < ?{clause}",
            (cutoff, *params),
        )
        self._connection.commit()
        return max(0, cursor.rowcount)

    def _prune_size(self, protect: Collection[str]) -> int:
        """Evict oldest unprotected rows until under the byte cap.

        The running total is computed ONCE and decremented per eviction (the
        old per-iteration ``SUM(LENGTH(content))`` rescanned the whole table —
        O(rows²) on a full store). ``rowid`` tiebreak makes "evict oldest"
        deterministic and insert-ordered when timestamps collide. Protected
        rows (the current command's just-written segments) are never victims —
        a batch larger than the cap overshoots transiently and shrinks on the
        next unprotected prune.
        """
        total = self._connection.execute(
            "SELECT COALESCE(SUM(LENGTH(content)), 0) FROM omissions"
        ).fetchone()[0]
        if total <= self._max_bytes:
            return 0
        count = self._connection.execute(
            "SELECT COUNT(*) FROM omissions"
        ).fetchone()[0]
        clause, params = _protect_clause(protect)
        evicted = 0
        # Never evict the last remaining row: a lone over-cap entry is kept.
        while total > self._max_bytes and count - evicted > 1:
            victim = self._connection.execute(
                "SELECT ref, LENGTH(content) FROM omissions "
                f"WHERE 1=1{clause} "
                "ORDER BY created_at ASC, rowid ASC LIMIT 1",
                params,
            ).fetchone()
            if victim is None:
                break  # everything left is protected → accept transient overshoot
            self._connection.execute("DELETE FROM omissions WHERE ref=?", (victim[0],))
            total -= int(victim[1])
            evicted += 1
        if evicted:
            self._connection.commit()
        return evicted
