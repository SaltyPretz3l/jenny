"""Fail if a jsdom test loads the renderer app without running its dispose path.

Replaces an AGENTS.md rule that could not be followed. That rule read "jsdom
renderer tests must register `t.after(() => app.dispose())` and must never call
`dom.window.close()`", but measured against the tree its second half condemned
100 files and 287 call sites while catching nothing:

  - 95 of those files build a bare `new JSDOM(fragment)`. There is no app, no
    controller, and nothing holding a timer; `window.close()` is jsdom's own
    documented teardown and the only one available.
  - The 5 that do load the app go through `tests/helpers/renderer-shell-harness`,
    which OVERRIDES `window.close` with a function that stops new timers, clears
    every tracked raf/timeout/interval, awaits `window.__disposeRenderer()`, and
    only then calls jsdom's native close. On a harness app `window.close()` IS
    the dispose path, so the rule forbade the mechanism it demanded.
  - The stated hazard did not reproduce: the four densest closers run 49 close()
    calls, exit 0, and leave the node process table at baseline with no handles
    beyond stdio.

Three separate reviewers read the old rule and filed the same non-bug. What is
worth enforcing is the invariant underneath it -- a test that loads the renderer
app must run the renderer's teardown -- and unlike the prose rule, that is
checkable. Both accepted forms reach `__disposeRenderer`.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TESTS_DIR = ROOT / "tests"
SOURCE_SUFFIXES = {".js", ".mjs"}

LOADS_APP = re.compile(r"\bloadRendererApp\s*\(")
# `dispose()` destructured from the harness, or `app.dispose()` / `controller.dispose()`.
DISPOSES = re.compile(r"(?:^|[^.\w])dispose\s*\(\s*\)|\.\s*dispose\s*\(\s*\)")
# The harness's own override, which clears tracked timers then disposes.
CLOSES_HARNESS_WINDOW = re.compile(r"\bwindow\s*\.\s*close\s*\(\s*\)")

# The harness modules define the teardown the rule asks callers to run.
EXEMPT_RELATIVE_PATHS = {
    "tests/helpers/renderer-shell-harness.js",
    "tests/helpers/renderer-shell-harness-dom.js",
}


def _violations() -> list[str]:
    found: list[str] = []
    for path in sorted(TESTS_DIR.rglob("*")):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        relative_path = path.relative_to(ROOT).as_posix()
        if relative_path in EXEMPT_RELATIVE_PATHS:
            continue
        try:
            source = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if not LOADS_APP.search(source):
            continue
        if DISPOSES.search(source) or CLOSES_HARNESS_WINDOW.search(source):
            continue
        found.append(relative_path)
    return found


def main() -> int:
    violations = _violations()
    if violations:
        print("FAIL: renderer app loaded without a teardown that reaches __disposeRenderer")
        for item in violations:
            print(f"  - {item}")
        print("  Register t.after(() => dispose()) from loadRendererApp(), or await window.close().")
        return 1

    print("PASS: every test loading the renderer app runs its dispose path")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
