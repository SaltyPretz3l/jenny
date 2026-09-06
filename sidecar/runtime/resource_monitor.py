"""Long-session process resource monitoring helpers."""

from __future__ import annotations

import threading
from collections import deque
from typing import Any, Deque

try:  # pragma: no cover - optional dependency branch covered by fallbacks.
    import psutil  # type: ignore[import-untyped]
except Exception:  # noqa: BLE001
    psutil = None  # type: ignore[assignment]


DEFAULT_RSS_SAMPLE_WINDOW = 20
DEFAULT_RSS_GROWTH_BYTES_THRESHOLD = 128 * 1024 * 1024
DEFAULT_RSS_GROWTH_RATIO = 0.25


class LongSessionResourceMonitor:
    """Tracks bounded RSS samples and reports leak-like growth without failing turns."""

    def __init__(
        self,
        *,
        sample_window: int = DEFAULT_RSS_SAMPLE_WINDOW,
        growth_bytes_threshold: int = DEFAULT_RSS_GROWTH_BYTES_THRESHOLD,
        growth_ratio: float = DEFAULT_RSS_GROWTH_RATIO,
    ) -> None:
        self._sample_window = max(int(sample_window or DEFAULT_RSS_SAMPLE_WINDOW), 2)
        self._growth_bytes_threshold = max(
            int(growth_bytes_threshold or DEFAULT_RSS_GROWTH_BYTES_THRESHOLD),
            1,
        )
        self._growth_ratio = max(float(growth_ratio or DEFAULT_RSS_GROWTH_RATIO), 0.0)
        self._rss_samples: Deque[int] = deque(maxlen=self._sample_window)
        self._lock = threading.Lock()

    def record_rss_sample(self, rss_bytes: int) -> dict[str, Any]:
        sample = max(int(rss_bytes or 0), 0)
        with self._lock:
            self._rss_samples.append(sample)
            return self._snapshot_locked()

    def sample_current_process(self) -> dict[str, Any]:
        if psutil is None:
            return self._unknown_snapshot("psutil_unavailable")
        try:
            rss_bytes = int(psutil.Process().memory_info().rss)
        except Exception as error:  # noqa: BLE001
            return self._unknown_snapshot(str(error) or type(error).__name__)
        return self.record_rss_sample(rss_bytes)

    def _snapshot_locked(self) -> dict[str, Any]:
        samples = tuple(self._rss_samples)
        latest = samples[-1] if samples else 0
        warning = self._warning_for_samples(samples)
        return {
            "status": "warn" if warning is not None else "ok",
            "rss_bytes": latest,
            "sample_count": len(samples),
            "sample_window": self._sample_window,
            "warning": warning,
        }

    def _warning_for_samples(self, samples: tuple[int, ...]) -> dict[str, Any] | None:
        if len(samples) < self._sample_window:
            return None
        first = max(samples[0], 1)
        latest = samples[-1]
        growth_bytes = latest - first
        growth_ratio = growth_bytes / first
        if (
            growth_bytes <= self._growth_bytes_threshold
            or growth_ratio <= self._growth_ratio
        ):
            return None
        return {
            "kind": "rss_growth",
            "growth_bytes": growth_bytes,
            "growth_ratio": round(growth_ratio, 4),
            "threshold_bytes": self._growth_bytes_threshold,
            "threshold_ratio": self._growth_ratio,
        }

    def _unknown_snapshot(self, reason: str) -> dict[str, Any]:
        with self._lock:
            sample_count = len(self._rss_samples)
        return {
            "status": "unknown",
            "rss_bytes": None,
            "sample_count": sample_count,
            "sample_window": self._sample_window,
            "warning": {
                "kind": "rss_probe_unavailable",
                "reason": str(reason or "unknown"),
            },
        }


GLOBAL_RESOURCE_MONITOR = LongSessionResourceMonitor()


def sample_resource_monitor_snapshot() -> dict[str, Any]:
    """Return a fail-open RSS leak-monitor snapshot for diagnostics surfaces."""
    return GLOBAL_RESOURCE_MONITOR.sample_current_process()
