"""Fail if a tests/release-compat/ test file is not wired into a runner.

Measured failure this prevents (2026-08-28, W7 hygiene wave):
`scripts/run-node-tests-safe.js` discovers `*.test.js` only, but every file in
`tests/release-compat/` is named `test_*.js` / `test_*.py`. Those files run from
`scripts/tests/run-dist-tests.js` (`npm run test:dist`, the ci-public lane) or
they run nowhere at all.

Four JS files were added to the directory after that hardcoded list was written
and none were registered. One of them,
`test_session_store_v18_stability.js`, asserted `hasPendingMigrations() === false`
for a schema-18 fixture; it had been RED since the session store moved to
schema 19 and again to 20, and nothing reported it. A 2026-07-17 audit checked
this same question and recorded the list as complete -- it was, that day. The
list is the kind of thing that only stays correct while someone remembers it,
so this check remembers it instead.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPAT_DIR = ROOT / "tests" / "release-compat"
DIST_RUNNER = ROOT / "scripts" / "tests" / "run-dist-tests.js"

# Files that are helpers/config for the suite rather than tests in it.
NON_TEST_NAMES = {"conftest.py", "__init__.py"}


def _registered_paths() -> set[str]:
    source = DIST_RUNNER.read_text(encoding="utf-8")
    return set(re.findall(r"'(tests/release-compat/[^']+)'", source))


def _expected_paths() -> list[str]:
    found: list[str] = []
    for path in sorted(COMPAT_DIR.iterdir()):
        if not path.is_file() or path.name in NON_TEST_NAMES:
            continue
        if path.suffix not in {".js", ".py"}:
            continue
        if not path.name.startswith("test_"):
            continue
        found.append(path.relative_to(ROOT).as_posix())
    return found


def main() -> int:
    if not COMPAT_DIR.is_dir() or not DIST_RUNNER.is_file():
        print("PASS: no release-compat suite to check")
        return 0
    registered = _registered_paths()
    missing = [item for item in _expected_paths() if item not in registered]
    if missing:
        print("FAIL: release-compat tests are not run by any gate")
        for item in missing:
            print(f"  - {item}")
        print("  Add each to DIST_NODE_TESTS / DIST_PYTHON_TESTS in scripts/tests/run-dist-tests.js.")
        print("  The safe runner discovers *.test.js only, so these run there or nowhere.")
        return 1

    print(f"PASS: all {len(_expected_paths())} release-compat tests are registered with a runner")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
