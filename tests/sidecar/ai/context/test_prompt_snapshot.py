"""Phase 12A I.B.2: snapshot tests for the system-prompt assembly.

These scenarios lock the cacheable-prefix shape and runtime-overlay insertion
ordering established by Phases 9A/9B. They snapshot the **shape** (sections,
headings, the ``<!-- CACHE_BOUNDARY -->`` marker, runtime-overlay order),
not the prose — see ``_snapshot_support.py:redact`` for the redaction
contract and the snapshot-drift discipline.

Drift from these snapshots will silently break prompt caching. Treat a
failure here as a load-bearing signal:

1. Read the unified diff in pytest output.
2. If the change is intentional, regenerate with ``JENNY_UPDATE_SNAPSHOTS=1``.
3. If accidental, fix the regression.

Phase 12B / I.B.6 reuses the assembly helpers via
``_prompt_assembly_support.py`` and adds a parametrized cross-mode table at
``test_prompt_cross_mode.py``.
"""

from __future__ import annotations

from tests.sidecar.ai.context._prompt_assembly_support import (
    SNAPSHOTS_ROOT,
    assemble,
    memory_overlay,
    plan_overlay,
)
from tests.sidecar.ai.context._snapshot_support import assert_matches_snapshot


def test_default_no_overlays_snapshot() -> None:
    """Locks the bare cacheable prefix and the ``<!-- CACHE_BOUNDARY -->`` marker."""
    actual = assemble(runtime_overlays=[])
    assert_matches_snapshot(actual, SNAPSHOTS_ROOT / "default_no_overlays.txt")


def test_memory_only_snapshot() -> None:
    """Memory-recall overlay alone."""
    actual = assemble(runtime_overlays=[memory_overlay()])
    assert_matches_snapshot(actual, SNAPSHOTS_ROOT / "default_memory_only.txt")


def test_plan_only_snapshot() -> None:
    """Plan-mode overlay alone."""
    actual = assemble(runtime_overlays=[plan_overlay()])
    assert_matches_snapshot(actual, SNAPSHOTS_ROOT / "default_plan_only.txt")
