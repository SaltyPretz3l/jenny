from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]


def test_chat_lifecycle_v2_matrix_checker_passes() -> None:
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "checks" / "check_chat_lifecycle_v2_matrix.py")],
        cwd=ROOT,
        capture_output=True,
        check=False,
        text=True,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stdout + result.stderr
    # Retired scenarios (S24, owner 2026-10-05) leave the roster, so the live
    # count comes from the checker's own constants rather than a pinned number.
    checker = _load_checker()
    live = checker.SCENARIO_COUNT - len(checker.RETIRED_SCENARIOS)
    assert live == 36
    assert f"27 invariants and {live} scenarios" in result.stdout


def _load_checker() -> ModuleType:
    path = ROOT / "scripts" / "checks" / "check_chat_lifecycle_v2_matrix.py"
    spec = importlib.util.spec_from_file_location("check_chat_lifecycle_v2_matrix", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
