"""Fail if a tests/gui-smoke/ smoke file is not wired into the GUI smoke runner.

Measured failure this prevents (2026-08-28, owner-run GUI smoke pass):
`*.smoke.js` is invisible to `scripts/run-node-tests-safe.js` (it discovers
`*.test.js`), so `npm run smoke:gui` is the ONLY thing that runs these files --
and its suite list is hardcoded. `selectSuiteFiles()` rejects any path absent
from that list, so an unregistered file cannot even be run by naming it.

Two files were unregistered. `plugin-declarative-contributions.smoke.js` had
NEVER been listed since it was added in `ee7fcd75` (confirmed with
`git log -S`), was edited by a later hygiene wave, and is named as a release
gate by `docs/operations/MANUAL_TEST_MATRIX.md` -- yet
`npm run smoke:gui <its path>` exited 1 with "unknown GUI smoke file".

An unrun smoke file rots silently and invisibly. The same pass found
`settings-plugins-section.smoke.js` asserting a property retired in `632da0e4`
and `chats-panel.smoke.js` asserting a dot contract production never had (the
assertion post-dated the W6 redesign that removed it). Neither could fail,
because neither ever ran.

Registering a file is cheap even when it needs an owner fixture: the env-gated
suites skip, exactly like the already-registered Stage 7 entry.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SMOKE_DIR = ROOT / "tests" / "gui-smoke"
RUNNER = ROOT / "scripts" / "run-gui-smoke.js"


def _registered_names() -> set[str]:
    source = RUNNER.read_text(encoding="utf-8")
    return set(re.findall(r"'([A-Za-z0-9._-]+\.smoke\.js)'", source))


def _expected_names() -> list[str]:
    return sorted(path.name for path in SMOKE_DIR.glob("*.smoke.js") if path.is_file())


def main() -> int:
    if not SMOKE_DIR.is_dir() or not RUNNER.is_file():
        print("PASS: no GUI smoke suite to check")
        return 0
    expected = _expected_names()
    if not expected:
        print("FAIL: no *.smoke.js files found -- this check is looking in the wrong place")
        return 1
    registered = _registered_names()
    missing = [name for name in expected if name not in registered]
    if missing:
        print("FAIL: GUI smoke files exist that no command runs")
        for name in missing:
            print(f"  - tests/gui-smoke/{name}")
        print("  Add each to suiteFiles in scripts/run-gui-smoke.js.")
        print("  selectSuiteFiles() rejects unlisted paths, so these cannot be run at all.")
        print("  Env-gated suites are fine to register: they skip without their fixture.")
        return 1

    print(f"PASS: all {len(expected)} GUI smoke files are registered with the runner")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
