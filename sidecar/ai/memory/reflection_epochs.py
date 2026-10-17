"""The in-process policy-epoch fence for reflection applies (row 58 W2).

Electron bumps its memory policy epoch whenever consent or capture settings
change and reports it through ``memory.policy_epoch``. ``memory.apply`` is
refused ``policy_stale`` when its epoch is below the highest one seen for the
same ``epoch_source`` (one random id per Electron process, so a restarted
Electron never inherits a stale higher epoch). Process memory only, bounded
to the most recently reported sources.
"""

from __future__ import annotations

import threading
from collections import OrderedDict

DEFAULT_MAX_EPOCH_SOURCES = 64


class PolicyEpochFence:
    def __init__(self, *, max_sources: int = DEFAULT_MAX_EPOCH_SOURCES) -> None:
        self._lock = threading.Lock()
        self._latest: OrderedDict[str, int] = OrderedDict()
        self._max_sources = max(1, int(max_sources))

    def observe(self, source: str, epoch: int) -> int:
        """Record *epoch* for *source*; return the highest epoch seen for it."""

        with self._lock:
            latest = max(epoch, self._latest.pop(source, epoch))
            self._latest[source] = latest
            while len(self._latest) > self._max_sources:
                self._latest.popitem(last=False)
            return latest

    def is_stale(self, source: str, epoch: int) -> bool:
        with self._lock:
            latest = self._latest.get(source)
        return latest is not None and epoch < latest


__all__ = ["DEFAULT_MAX_EPOCH_SOURCES", "PolicyEpochFence"]
