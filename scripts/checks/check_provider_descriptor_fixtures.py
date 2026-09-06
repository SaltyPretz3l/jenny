"""Gate the ChatGPT provider-descriptor fixture corpus.

Enforces, all exit-1:

1. ``index.json``'s file registry is exactly the set of ``*.json`` documents that
   exist, in BOTH directions — a fixture cannot ship unregistered, and a stale
   registry entry cannot outlive its file.
2. ``schema_version`` is pinned, ``fixture_id`` matches the path-derived id, and
   the top-level key allowlist is CLOSED — that closure is what forces a
   heterogeneous documentary blob into either ``cases[]`` or ``non_executable[]``
   instead of surviving as un-asserted metadata.
3. ``case_id`` is unique per file, ``binding`` is in the closed vocabulary, and
   ``executable`` is present as a literal boolean (declared, never implied).
4. A fixture with zero executable cases must say so at the top level AND appear
   in ``index.json.non_executable_fixtures``.
5. Anti-vacuous: an executable case needs a non-empty ``expect``; ``input`` may
   be ``{}`` but must be present. Input/expect keys are closed per binding, so
   an expectation no adapter reads cannot ship.
6. Case ratchet: the total executable case count may not fall below
   ``index.json.minimum_executable_cases``.
7. Redaction guard: no fixture's bytes may match a bearer/JWT shape.
8. Constant identity: every declared constant is pinned by a
   ``constant_identity`` case in the same fixture.

The schema itself lives in ``scripts/checks/provider_descriptor_fixtures.py``,
which the pytest conformance suite imports too, so this gate and the runner can
never disagree about what a valid corpus is.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks.provider_descriptor_fixtures import fixture_paths, validate


def main() -> int:
    violations = validate()
    if violations:
        print("FAIL: provider-descriptor fixture check")
        for item in violations:
            print(f"  - {item}")
        return 1
    print(f"PASS: provider-descriptor fixture check ({len(fixture_paths())} fixtures)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
