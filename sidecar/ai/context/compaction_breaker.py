"""Circuit breaker for full-compaction LLM failures.

Extracted from ``compaction.py`` (P2 Wave 2, 2026-08-28) to keep the
orchestration module under the 600-line soft target. ``compaction.py``
re-exports every public name here, so callers and tests keep importing from
``sidecar.ai.context.compaction``.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable

_MAX_CONSECUTIVE_FAILURES = 3
MAX_COMPACTION_BREAKERS = 64
# Registry entries expire after one hour of inactivity for bounded LRU retention.
COMPACTION_BREAKER_EXPIRY_SECONDS = 60.0 * 60.0
# An open per-session breaker retries full compaction after five minutes.
COMPACTION_BREAKER_RESET_SECONDS = 300.0


@dataclass
class CompactionCircuitBreaker:
    """Prevents repeated full-compaction LLM failures from stalling."""

    max_failures: int = _MAX_CONSECUTIVE_FAILURES
    reset_after_seconds: float = COMPACTION_BREAKER_RESET_SECONDS
    clock: Callable[[], float] = time.monotonic
    _consecutive_failures: int = 0
    _opened_at: float | None = None
    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)

    def record_failure(self) -> None:
        with self._lock:
            self._consecutive_failures += 1
            if self._consecutive_failures >= self.max_failures:
                self._opened_at = self.clock()

    def record_success(self) -> None:
        with self._lock:
            self._consecutive_failures = 0
            self._opened_at = None

    def is_open(self) -> bool:
        with self._lock:
            if self._consecutive_failures < self.max_failures:
                return False
            now = self.clock()
            if self._opened_at is None:
                self._opened_at = now
                return True
            if now - self._opened_at >= max(0.0, self.reset_after_seconds):
                self._consecutive_failures = 0
                self._opened_at = None
                return False
            return True

    def seconds_until_reset(self) -> float:
        """Remaining open-window seconds; 0.0 when the breaker is closed."""
        if not self.is_open():
            return 0.0
        opened_at = self._opened_at if self._opened_at is not None else self.clock()
        return max(0.0, self.reset_after_seconds - (self.clock() - opened_at))

    @property
    def failure_count(self) -> int:
        with self._lock:
            return self._consecutive_failures


@dataclass(frozen=True)
class _CompactionBreakerEntry:
    breaker: CompactionCircuitBreaker
    last_accessed: float


class CompactionCircuitBreakerRegistry:
    """Bounded, expiring per-session owner for full-compaction breakers."""

    def __init__(
        self,
        *,
        max_entries: int = MAX_COMPACTION_BREAKERS,
        expiry_seconds: float = COMPACTION_BREAKER_EXPIRY_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_entries = max(1, int(max_entries))
        self._expiry_seconds = max(1.0, float(expiry_seconds))
        self._clock = clock
        self._entries: OrderedDict[str, _CompactionBreakerEntry] = OrderedDict()
        self._lock = threading.Lock()

    def for_key(self, key: str | None) -> CompactionCircuitBreaker:
        normalized = str(key or "").strip() or "__engine__"
        now = self._clock()
        with self._lock:
            self._prune_expired(now)
            existing = self._entries.pop(normalized, None)
            if existing is not None:
                self._entries[normalized] = _CompactionBreakerEntry(
                    breaker=existing.breaker,
                    last_accessed=now,
                )
                return existing.breaker
            while len(self._entries) >= self._max_entries:
                self._entries.popitem(last=False)
            breaker = CompactionCircuitBreaker(
                reset_after_seconds=COMPACTION_BREAKER_RESET_SECONDS,
                clock=self._clock,
            )
            self._entries[normalized] = _CompactionBreakerEntry(
                breaker=breaker,
                last_accessed=now,
            )
            return breaker

    def _prune_expired(self, now: float) -> None:
        expired = [
            key
            for key, entry in self._entries.items()
            if now - entry.last_accessed >= self._expiry_seconds
        ]
        for key in expired:
            self._entries.pop(key, None)

    @property
    def size(self) -> int:
        with self._lock:
            self._prune_expired(self._clock())
            return len(self._entries)
