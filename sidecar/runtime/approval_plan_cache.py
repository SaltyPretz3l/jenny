"""Bounded in-process ownership for frozen approval plans."""

from __future__ import annotations

import sys
import threading
import time
from dataclasses import dataclass
from typing import Any

_MIN_APPROVAL_PLAN_TTL_SECONDS = 60.0
_MAX_APPROVAL_PLAN_TTL_SECONDS = 600.0
MAX_APPROVAL_PLAN_CACHE_ENTRIES = 128
MAX_APPROVAL_PLAN_CACHE_ENTRIES_PER_SESSION = 16
MAX_APPROVAL_PLAN_CACHE_BYTES = 8 * 1024 * 1024


class ApprovalPlanCacheCapacityError(ValueError):
    """Raised when one frozen approval plan cannot fit the byte ceiling."""

    def __init__(self, *, size_bytes: int, limit_bytes: int) -> None:
        self.size_bytes = max(0, int(size_bytes))
        self.limit_bytes = max(0, int(limit_bytes))
        super().__init__("Approval plan exceeds the in-memory cache byte limit.")


def clamp_approval_plan_ttl(timeout_seconds: float) -> float:
    normalized = float(timeout_seconds or 0.0)
    return min(
        max(normalized, _MIN_APPROVAL_PLAN_TTL_SECONDS),
        _MAX_APPROVAL_PLAN_TTL_SECONDS,
    )


def _deep_size_bytes(value: Any) -> int:
    """Return a cycle-safe retained-size estimate for an approval plan."""

    seen: set[int] = set()
    pending = [value]
    total = 0
    while pending:
        current = pending.pop()
        identity = id(current)
        if identity in seen:
            continue
        seen.add(identity)
        total += sys.getsizeof(current)
        if isinstance(current, dict):
            pending.extend(current.keys())
            pending.extend(current.values())
        elif isinstance(current, (list, tuple, set, frozenset)):
            pending.extend(current)
        elif hasattr(current, "__dict__"):
            pending.append(vars(current))
    return total


@dataclass(frozen=True)
class ApprovalPlanCacheEntry:
    plan: Any
    expires_at_monotonic: float
    session_id: str
    size_bytes: int

    def is_expired(self, *, now: float) -> bool:
        return now >= self.expires_at_monotonic


class ApprovalPlanCache:
    """Bounded cache keyed by ``(request_id, call_id)``.

    Insertion order is the eviction order. A read never promotes an entry, so
    concurrent outcomes produce deterministic oldest-first eviction.
    """

    def __init__(
        self,
        *,
        now_fn: Any | None = None,
        max_entries: int = MAX_APPROVAL_PLAN_CACHE_ENTRIES,
        max_session_entries: int = MAX_APPROVAL_PLAN_CACHE_ENTRIES_PER_SESSION,
        max_bytes: int = MAX_APPROVAL_PLAN_CACHE_BYTES,
        size_fn: Any | None = None,
    ) -> None:
        self._entries: dict[tuple[str, str], ApprovalPlanCacheEntry] = {}
        self._now = now_fn or time.monotonic
        self._max_entries = max(1, int(max_entries))
        self._max_session_entries = max(1, int(max_session_entries))
        self._max_bytes = max(1, int(max_bytes))
        self._size_fn = size_fn or _deep_size_bytes
        self._total_bytes = 0
        self._evictions = {reason: 0 for reason in ("expired", "global", "session", "bytes")}
        self._oversized_rejections = 0
        self._lock = threading.RLock()

    @staticmethod
    def _key(request_id: str, call_id: str) -> tuple[str, str]:
        return (str(request_id or "").strip(), str(call_id or "").strip())

    def put(self, plan: Any, *, ttl_seconds: float) -> Any:
        with self._lock:
            self._purge_expired_locked()
            request_id = str(plan.request_id or "").strip()
            call_id = str(plan.call_id or "").strip()
            if not call_id:
                raise ValueError("Approval plan call_id is required.")
            if not request_id:
                raise ValueError("Approval plan request_id is required.")
            size_bytes = max(1, int(self._size_fn(plan)))
            if size_bytes > self._max_bytes:
                self._oversized_rejections += 1
                raise ApprovalPlanCacheCapacityError(
                    size_bytes=size_bytes,
                    limit_bytes=self._max_bytes,
                )
            key = (request_id, call_id)
            self._remove_locked(key)
            session_id = str(getattr(plan, "session_id", None) or request_id).strip()
            self._entries[key] = ApprovalPlanCacheEntry(
                plan=plan,
                expires_at_monotonic=(
                    self._now() + clamp_approval_plan_ttl(ttl_seconds)
                ),
                session_id=session_id,
                size_bytes=size_bytes,
            )
            self._total_bytes += size_bytes
            self._enforce_bounds_locked(session_id)
        return plan

    def consume(self, request_id: str, call_id: str) -> Any | None:
        with self._lock:
            self._purge_expired_locked()
            entry = self._remove_locked(self._key(request_id, call_id))
            return entry.plan if entry is not None else None

    def evict(self, request_id: str, call_id: str) -> Any | None:
        with self._lock:
            entry = self._remove_locked(self._key(request_id, call_id))
            return entry.plan if entry is not None else None

    def _purge_expired_locked(self) -> int:
        now = self._now()
        expired = [key for key, entry in self._entries.items() if entry.is_expired(now=now)]
        for key in expired:
            self._remove_locked(key, reason="expired")
        return len(expired)

    def _remove_locked(
        self,
        key: tuple[str, str],
        *,
        reason: str | None = None,
    ) -> ApprovalPlanCacheEntry | None:
        entry = self._entries.pop(key, None)
        if entry is None:
            return None
        self._total_bytes = max(0, self._total_bytes - entry.size_bytes)
        if reason is not None:
            self._evictions[reason] += 1
        return entry

    def _enforce_bounds_locked(self, session_id: str) -> None:
        while sum(entry.session_id == session_id for entry in self._entries.values()) > (
            self._max_session_entries
        ):
            if not self._evict_oldest_locked("session", session_id=session_id):
                break
        while len(self._entries) > self._max_entries:
            if not self._evict_oldest_locked("global"):
                break
        while self._total_bytes > self._max_bytes:
            if not self._evict_oldest_locked("bytes"):
                break

    def _evict_oldest_locked(self, reason: str, *, session_id: str | None = None) -> bool:
        key = next(
            (
                candidate
                for candidate, entry in self._entries.items()
                if session_id is None or entry.session_id == session_id
            ),
            None,
        )
        if key is None:
            return False
        self._remove_locked(key, reason=reason)
        return True


__all__ = [
    "MAX_APPROVAL_PLAN_CACHE_BYTES",
    "MAX_APPROVAL_PLAN_CACHE_ENTRIES",
    "MAX_APPROVAL_PLAN_CACHE_ENTRIES_PER_SESSION",
    "ApprovalPlanCache",
    "ApprovalPlanCacheCapacityError",
    "clamp_approval_plan_ttl",
]
