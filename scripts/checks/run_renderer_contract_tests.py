"""Run the curated jsdom contract subset on the blocking fast-gate.

The subset is intentionally narrow -- contract-surface, jsdom-safe (no Electron
`app`, no real subprocess), no wall-clock timing oracle, total runtime well under
60s -- and runs through the safe runner's `--parallel-only` partition (the same
lane as js-stable-gate). A `run_*` (not `check_*`) name keeps it OFF the
run_all.py policy glob and the test_run_all existence invariant: this is a CI
lane runner, not a policy check. The standing guard
tests/sidecar/test_run_renderer_contract_tests.py protects the list against a
renamed/deleted entry (or an accidentally sequential-risk file that
`--parallel-only` would silently drop) becoming a false green.

Keep RENDERER_CONTRACT_TESTS in sync with the "blocking subset" rows of
docs/process/TESTING_STRATEGY.md. Exit 0 = the subset passed; non-zero = a
contract test failed (or node is unavailable).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

RENDERER_CONTRACT_TESTS = [
    "tests/ipc-contract.test.js",
    "tests/ipc-handler-registration.test.js",
    "tests/preload-harness.test.js",
    "tests/renderer-view-panel-registry.test.js",
    "tests/chat-stream-bridge.test.js",
    "tests/canonical-turn-event-contract.test.js",
    "tests/shell-config-state.test.js",
]


def main() -> int:
    node = shutil.which("node")
    if node is None:
        print("FAIL: node is not available to run the JS contract subset")
        return 1

    missing = [rel for rel in RENDERER_CONTRACT_TESTS if not (ROOT / rel).is_file()]
    if missing:
        print("FAIL: curated JS contract subset references missing file(s)")
        for rel in missing:
            print(f"  - {rel}")
        print("Update RENDERER_CONTRACT_TESTS + the TESTING_STRATEGY lane map after a rename.")
        return 1

    command = [
        node,
        "scripts/run-node-tests-safe.js",
        *RENDERER_CONTRACT_TESTS,
        "--parallel-only",
        "--timeout-ms=120000",
    ]
    result = subprocess.run(command, cwd=ROOT, check=False)
    if result.returncode != 0:
        print("FAIL: JS contract subset")
        return result.returncode

    print(f"PASS: JS contract subset ({len(RENDERER_CONTRACT_TESTS)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
