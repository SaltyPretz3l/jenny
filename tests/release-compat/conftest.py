"""Pytest helpers for the Phase 12B release-compat suite.

The single shared helper :func:`load_userdata_fixture` copies a pre-canned
``userdata-v<N>/`` tree into an isolated ``tmp_path`` so every test runs
against its own filesystem. The Python migration tests for the memory
store materialize SQL fixtures inline via :mod:`sqlite3` and do not need
this helper, but the JS-driven release-compat scaffolding stays
discoverable next to the Python tests for symmetry.
"""

from __future__ import annotations

import shutil
from pathlib import Path

FIXTURES_ROOT = Path(__file__).resolve().parent / "fixtures"


def load_userdata_fixture(fixture_dir: str, target_root: Path) -> Path:
    """Copy ``fixtures/<fixture_dir>/`` into *target_root* and return its path.

    The Python tests do not load the userdata fixtures (those exercise the
    JS session-store migration cascade and are driven by node:test). The
    helper exists so future Python coverage can opt into the same corpus
    without re-implementing the copy step.
    """
    source = FIXTURES_ROOT / fixture_dir
    if not source.exists():
        raise FileNotFoundError(f"release-compat fixture not found: {source}")
    destination = target_root / fixture_dir
    shutil.copytree(source, destination)
    return destination


__all__ = ["FIXTURES_ROOT", "load_userdata_fixture"]
