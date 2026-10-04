"""Verify the frozen Stage 5 budget ledger and its runtime limit owners."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEDGER = ROOT / "config" / "plugins" / "stage5-budgets.json"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks.check_plugin_boundary import inspect_javascript  # noqa: E402

EXPECTED = {
    "distribution": {
        "solver_nodes_max": 64,
        "dependencies_per_node_max": 16,
        "candidates_per_plugin_max": 64,
        "solver_decisions_max": 4_096,
        "solver_incompatibilities_max": 8_192,
        "solver_timeout_ms": 2_000,
        "cache_max_bytes": 536_870_912,
        "installed_store_max_bytes": 4_294_967_296,
        "installed_plugin_max_bytes": 536_870_912,
        "prior_generations_per_plugin": 2,
        "data_snapshots_per_plugin": 2,
    },
}

RUNTIME_DECLARATIONS = {
    "services/plugins/distribution/distribution-limits.js": {
        "LIMITS": {
            "solverNodes": 64,
            "solverDecisions": 4_096,
            "solverIncompatibilities": 8_192,
            "cacheBytes": 536_870_912,
            "retainedGenerations": 3,
        },
    },
}


def _contains_expected(actual: object, expected: object) -> bool:
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and _contains_expected(actual[key], value)
            for key, value in expected.items()
        )
    return actual == expected


def violations() -> list[str]:
    try:
        document = json.loads(LEDGER.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return [f"stage5 budget ledger unreadable: {error}"]
    failures = []
    metadata = {key: document.get(key) for key in (
        "budgets_schema_version", "stage", "status", "frozen",
        "approved_packet", "activation_stage",
    )}
    expected_metadata = {
        "budgets_schema_version": 1, "stage": 5, "status": "frozen",
        "frozen": True, "approved_packet": "stage5d_activation", "activation_stage": 5,
    }
    if metadata != expected_metadata:
        failures.append("Stage 5 budget freeze metadata drifted")
    for section, expected in EXPECTED.items():
        if document.get(section) != expected:
            failures.append(f"Stage 5 {section} budgets drifted")
    paths = [ROOT / relative for relative in RUNTIME_DECLARATIONS]
    try:
        facts_by_path = inspect_javascript(ROOT, paths)
    except (OSError, RuntimeError, ValueError) as error:
        failures.append(str(error))
        return failures
    for relative, expected_declarations in RUNTIME_DECLARATIONS.items():
        facts = facts_by_path.get(str((ROOT / relative).resolve()), {})
        declarations = facts.get("declarations", {}) if isinstance(facts, dict) else {}
        if not _contains_expected(declarations, expected_declarations):
            failures.append(
                f"{relative} runtime budget declarations do not match the frozen ledger"
            )
    return failures


def main() -> int:
    failures = violations()
    if failures:
        print("FAIL: Stage 5 plugin budget check")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("PASS: Stage 5 plugin budgets are frozen and runtime-owned")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
