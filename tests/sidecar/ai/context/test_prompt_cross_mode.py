"""Phase 12B / I.B.6: cross-mode consistency table.

Parametrized iteration over the locked snapshot scenarios from I.B.2.
Each entry is one mode combination; the test asserts the assembled prompt
renders to its locked file under ``tests/sidecar/ai/context/snapshots/``.

This is NOT a duplicate of ``test_prompt_snapshot.py``. That module has
discrete ``def test_*_snapshot`` functions — useful for human readers and
for clear pytest output. This module consolidates the same six checks into
a single parametrized table so:

* adding a new mode combination is a one-line table edit
* the cross-mode insertion-order invariant has a single failure surface
* a regression where each individual snapshot is correct but the
  composition has subtly drifted (memory-only fine, plan-only fine,
  composite drifted) gets flagged independently of the per-mode tests

Snapshot drift discipline lives in :mod:`_snapshot_support`. Do not delete
or weaken a snapshot to make a failing test pass; the snapshots are
load-bearing for prompt-cache stability.
"""

from __future__ import annotations

from typing import Callable

import pytest

from tests.sidecar.ai.context._prompt_assembly_support import (
    SNAPSHOTS_ROOT,
    assemble,
    memory_overlay,
    plan_overlay,
)
from tests.sidecar.ai.context._snapshot_support import assert_matches_snapshot


def _build_no_overlays() -> str:
    return assemble(runtime_overlays=[])


def _build_memory_only() -> str:
    return assemble(runtime_overlays=[memory_overlay()])


def _build_plan_only() -> str:
    return assemble(runtime_overlays=[plan_overlay()])


CROSS_MODE_CASES: list[tuple[str, Callable[[], str]]] = [
    ("default_no_overlays.txt", _build_no_overlays),
    ("default_memory_only.txt", _build_memory_only),
    ("default_plan_only.txt", _build_plan_only),
]


def test_all_cross_mode_snapshots_exist_on_disk() -> None:
    """Every parametrized case has a corresponding snapshot file.

    Guards against silently dropping a mode coverage by deleting its
    snapshot file: the deletion would otherwise be caught only when the
    parametrized test below runs and pytest prints a misleading
    "Snapshot missing" message.
    """
    missing = [name for name, _ in CROSS_MODE_CASES if not (SNAPSHOTS_ROOT / name).exists()]
    assert not missing, f"missing cross-mode snapshot files: {missing}"


@pytest.mark.parametrize(
    ("snapshot_name", "build"),
    CROSS_MODE_CASES,
    ids=[name for name, _ in CROSS_MODE_CASES],
)
def test_cross_mode_renders_to_locked_snapshot(
    snapshot_name: str, build: Callable[[], str]
) -> None:
    """Each mode combination assembles to its locked snapshot byte-for-byte."""
    actual = build()
    assert_matches_snapshot(actual, SNAPSHOTS_ROOT / snapshot_name)
