"""Lightweight optional-import probing for AI runtime dependencies.

Records capability flags without crashing startup.  Surfaces structured
dependency status to the hardware/readiness flow (Item 1).

All probes are lazy — they run on first access, not at import time.
"""

from __future__ import annotations

import importlib
import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Probe results
# ---------------------------------------------------------------------------

_STATUS_AVAILABLE = "available"
_STATUS_MISSING = "missing"
_STATUS_ERROR = "error"


@dataclass(frozen=True)
class DependencyInfo:
    """Status of a single optional dependency."""

    name: str
    status: str  # "available" | "missing" | "error"
    version: str = ""
    error: str = ""

@dataclass(frozen=True)
class DependencyReport:
    """Aggregated status of all probed optional dependencies."""

    dependencies: dict[str, DependencyInfo] = field(default_factory=dict)

    def to_dict(self) -> dict[str, str]:
        return {name: info.status for name, info in self.dependencies.items()}


# ---------------------------------------------------------------------------
# Individual probes
# ---------------------------------------------------------------------------


def _probe_module(name: str) -> DependencyInfo:
    try:
        module = importlib.import_module(name)

        version = str(getattr(module, "__version__", ""))
        logger.info("%s %s is available.", name, version)
        return DependencyInfo(name=name, status=_STATUS_AVAILABLE, version=version)
    except ImportError:
        logger.info("%s is not installed.", name)
        return DependencyInfo(name=name, status=_STATUS_MISSING)
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s import failed: %s", name, exc)
        return DependencyInfo(name=name, status=_STATUS_ERROR, error=str(exc))


# ---------------------------------------------------------------------------
# Aggregate probe (cached for session lifetime)
# ---------------------------------------------------------------------------

_cached_report: DependencyReport | None = None


def probe_dependencies(*, force: bool = False) -> DependencyReport:
    """Probe all optional AI dependencies.

    Results are cached for the session lifetime.  Pass ``force=True`` to
    re-probe (useful in tests).
    """
    global _cached_report  # noqa: PLW0603
    if _cached_report is not None and not force:
        return _cached_report

    deps: dict[str, DependencyInfo] = {}
    for name in ("torch", "tiktoken", "transformers"):
        info = _probe_module(name)
        deps[info.name] = info

    _cached_report = DependencyReport(dependencies=deps)
    return _cached_report
