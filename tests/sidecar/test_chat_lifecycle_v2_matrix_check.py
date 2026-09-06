from __future__ import annotations

import subprocess
import sys
from pathlib import Path

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
    assert "27 invariants and 37 scenarios" in result.stdout
