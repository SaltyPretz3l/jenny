"""Run the targeted Python runtime contract tests used by the active shell."""
from __future__ import annotations

import subprocess
import sys
from importlib.util import find_spec
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND_TESTS = [
    "tests/sidecar/server_core/",
    "tests/sidecar/runtime/test_chat.py",
    "tests/sidecar/runtime/test_capabilities.py",
]
REQUIRED_MODULES = ("pytest",)


def _missing_modules() -> list[str]:
    return [name for name in REQUIRED_MODULES if find_spec(name) is None]


def main() -> int:
    missing = _missing_modules()
    if missing:
        print("FAIL: backend contract test dependencies are missing")
        print(f"  - missing modules: {', '.join(missing)}")
        print('  - install with: pip install -e ".[dev,backend]"')
        return 1

    result = subprocess.run(
        [sys.executable, "-m", "pytest", *BACKEND_TESTS, "-q"],
        cwd=ROOT,
        check=False,
    )
    if result.returncode != 0:
        print("FAIL: backend contract tests")
        return result.returncode

    print("PASS: backend contract tests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
