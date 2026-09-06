"""Measure the plugin platform's freezable numeric budgets.

Stage 2's exit gate freezes numeric release budgets before Stage 3 code begins
(PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md "Performance and resource budgets").
Those budgets split cleanly in two:

  DERIVABLE NOW -- structural and security limits that follow from the frozen
  contract schemas themselves. They are machine-independent, so this harness
  computes them exactly and `--check` fails if config/plugins/budgets.json
  drifts from the schemas.

  OWNER-MEASURED -- latency, throughput, cold-start, and storage numbers that
  only mean something measured on the designated baseline machine (the owner's
  RTX 5070 Ti workstation, per the ratified program defaults) with the real app
  running. This harness records them as unmeasured placeholders with a runnable
  recipe rather than inventing values.

The most useful thing computed here is `max_nodes_worst_case`: an exact upper
bound on how many JSON nodes a contract's LARGEST legal payload contains. If
that exceeds the shared `structure.max_nodes` budget, the contract has a region
it can never legally populate -- a latent defect that must be found BEFORE the
freeze makes a versioned contract immutable, not after. V1 and V2 are measured
together while retaining their independently locked schema files.

Emit:   python scripts/measure_plugin_budgets.py --emit
Check:  python scripts/measure_plugin_budgets.py --check
Report: python scripts/measure_plugin_budgets.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.generate_plugin_contracts import SCHEMA_DIRS, _build_spec  # noqa: E402

BUDGETS_PATH = ROOT / "config" / "plugins" / "budgets.json"
STAGE7_BUDGETS_PATH = ROOT / "config" / "plugins" / "stage7-budgets.json"
FROZEN_BUDGET_SCHEMA_DIRS = SCHEMA_DIRS[:2]


def _build_frozen_budget_spec() -> dict[str, Any]:
    """Load only the V1/V2 families owned by the immutable Stage 4 ledger."""
    return _build_spec(FROZEN_BUDGET_SCHEMA_DIRS)


def _walk(node: dict[str, Any]) -> tuple[int, int, int, int]:
    """Return (max_depth, max_nodes, max_string_bytes, max_array_items).

    `max_nodes` counts the worst case: every optional field present and every
    array filled to its declared `max_items`. That is the bound a validator's
    structural budget has to accommodate, so an optimistic count would be
    worse than useless.
    """
    kind = node.get("type")

    if kind == "object":
        depth, nodes, string_bytes, array_items = 1, 1, 0, 0
        for child in node.get("properties", {}).values():
            child_depth, child_nodes, child_bytes, child_items = _walk(child)
            depth = max(depth, 1 + child_depth)
            nodes += child_nodes
            string_bytes = max(string_bytes, child_bytes)
            array_items = max(array_items, child_items)
        return depth, nodes, string_bytes, array_items

    if kind == "array":
        max_items = node.get("max_items") or 0
        item_depth, item_nodes, item_bytes, item_array = _walk(node["items"])
        return 1 + item_depth, 1 + max_items * item_nodes, item_bytes, max(max_items, item_array)

    if kind == "tagged_union":
        # A value is exactly ONE variant, so the worst case is the largest one.
        depth = nodes = string_bytes = array_items = 0
        for variant in node.get("variants", {}).values():
            variant_depth, variant_nodes, variant_bytes, variant_items = _walk(variant)
            depth = max(depth, variant_depth)
            nodes = max(nodes, variant_nodes)
            string_bytes = max(string_bytes, variant_bytes)
            array_items = max(array_items, variant_items)
        return depth, nodes, string_bytes, array_items

    if kind == "string":
        return 1, 1, node.get("max_utf8_bytes") or 0, 0

    return 1, 1, 0, 0


def derive_structural() -> dict[str, Any]:
    spec = _build_frozen_budget_spec()
    structure = spec["structure"]
    contracts: dict[str, Any] = {}

    for name in sorted(spec["contracts"]):
        root = spec["contracts"][name]["root"]
        depth, nodes, string_bytes, array_items = _walk(root)
        contracts[name] = {
            "max_root_keys": root.get("max_keys"),
            "max_depth_worst_case": depth,
            "max_nodes_worst_case": nodes,
            "max_string_bytes": string_bytes,
            "max_array_items": array_items,
            "additional_properties": root.get("additional_properties"),
            "within_shared_depth_budget": depth <= structure["max_depth"],
            "within_shared_node_budget": nodes <= structure["max_nodes"],
        }

    return {
        "shared_structure": structure,
        "contract_count": len(contracts),
        "contracts": contracts,
    }


def _find_declared_conflicts(node: dict[str, Any], shared: dict[str, Any], where: str) -> list[str]:
    """Fields whose OWN declared cap is larger than the shared structural budget.

    This is the sharpest form of the unreachable-capacity defect: a field
    declaring `max_items: 512` under a shared `max_array_items: 256` can never
    hold more than 256 entries -- the structural budget rejects first, with
    `array_budget_exceeded`, no matter what the field says. Freezing that into
    an immutable V1 ships a contract whose declared capacity is a lie.
    """
    conflicts: list[str] = []
    kind = node.get("type")

    if kind == "object":
        max_keys = node.get("max_keys")
        if max_keys is not None and max_keys > shared["max_object_keys"]:
            conflicts.append(
                f"{where}: declares max_keys {max_keys} above the shared max_object_keys "
                f"{shared['max_object_keys']} "
                f"(unreachable by {max_keys - shared['max_object_keys']} keys)"
            )
        for key, child in node.get("properties", {}).items():
            conflicts.extend(_find_declared_conflicts(child, shared, f"{where}.{key}"))

    elif kind == "array":
        max_items = node.get("max_items")
        if max_items is not None and max_items > shared["max_array_items"]:
            conflicts.append(
                f"{where}: declares max_items {max_items} above the shared max_array_items "
                f"{shared['max_array_items']} "
                f"(unreachable by {max_items - shared['max_array_items']} items)"
            )
        conflicts.extend(_find_declared_conflicts(node["items"], shared, f"{where}[]"))

    elif kind == "tagged_union":
        for tag, variant in node.get("variants", {}).items():
            conflicts.extend(_find_declared_conflicts(variant, shared, f"{where}<{tag}>"))

    return conflicts


def find_declared_capacity_conflicts() -> list[str]:
    spec = _build_frozen_budget_spec()
    shared = spec["structure"]
    conflicts: list[str] = []
    for name in sorted(spec["contracts"]):
        conflicts.extend(_find_declared_conflicts(spec["contracts"][name]["root"], shared, name))
    return conflicts


def find_budget_violations(structural: dict[str, Any]) -> list[str]:
    """HARD failures: a single field can never reach its own declared cap.

    Depth is included because a contract nested deeper than the shared
    `max_depth` has a region no payload can legally reach at all. Joint
    array-fill overruns are a softer class -- see find_joint_capacity_advisories.
    """
    violations = list(find_declared_capacity_conflicts())
    for name, entry in structural["contracts"].items():
        if not entry["within_shared_depth_budget"]:
            violations.append(
                f"{name}: worst-case depth {entry['max_depth_worst_case']} exceeds shared "
                f"max_depth {structural['shared_structure']['max_depth']}"
            )
    return violations


def find_joint_capacity_advisories(structural: dict[str, Any]) -> list[str]:
    """ADVISORY: per-field maxima that cannot all be satisfied simultaneously.

    Every individual field here fits the shared budgets; only filling ALL of
    them at once exceeds `max_nodes`. That may well be intended -- the node
    budget is a denial-of-service guard, not a capacity promise, and no real
    payload fills every array at once. It is surfaced rather than failed
    because the freeze makes it permanent, so the owner should decide
    deliberately rather than discover it in Stage 3.
    """
    advisories = []
    for name, entry in structural["contracts"].items():
        if not entry["within_shared_node_budget"]:
            advisories.append(
                f"{name}: filling every array to its declared maximum yields "
                f"{entry['max_nodes_worst_case']} nodes, above the shared max_nodes "
                f"{structural['shared_structure']['max_nodes']}; such a payload is rejected "
                f"with node_budget_exceeded"
            )
    return advisories


def load_budgets() -> dict[str, Any]:
    if not BUDGETS_PATH.exists():
        raise SystemExit(f"{BUDGETS_PATH.relative_to(ROOT)} does not exist; run --emit first")
    return json.loads(BUDGETS_PATH.read_text(encoding="utf-8"))


def emit(structural: dict[str, Any]) -> int:
    document = load_budgets() if BUDGETS_PATH.exists() else {}
    document["derived_structural"] = structural
    BUDGETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    BUDGETS_PATH.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {BUDGETS_PATH.relative_to(ROOT)} ({structural['contract_count']} contracts)")
    return 0


def check(structural: dict[str, Any]) -> int:
    document = load_budgets()
    recorded = document.get("derived_structural")
    if recorded != structural:
        print("FAIL: config/plugins/budgets.json is stale relative to config/plugins/v1/ and v2/")
        print("      re-run: python scripts/measure_plugin_budgets.py --emit")
        return 1
    violations = find_budget_violations(structural)
    if violations:
        print("FAIL: a declared field capacity is unreachable under the shared structural budget")
        for item in violations:
            print(f"  - {item}")
        return 1
    findings = document.get("open_findings", {})
    if findings.get("hard") != violations:
        print("FAIL: config/plugins/budgets.json hard-finding disposition is stale")
        return 1
    advisories = find_joint_capacity_advisories(structural)
    if findings.get("accepted_advisory") != advisories:
        print(
            "FAIL: config/plugins/budgets.json must explicitly accept "
            "the exact current advisory set"
        )
        return 1
    for item in advisories:
        print(f"ADVISORY: {item}")
    print(f"PASS: plugin budgets up to date ({structural['contract_count']} contracts)")
    return 0


def report(structural: dict[str, Any]) -> int:
    shared = structural["shared_structure"]
    print(f"shared structural budgets: {json.dumps(shared)}")
    print(f"{'contract':<34} {'depth':>6} {'nodes':>8} {'str B':>7} {'items':>6}  fits")
    for name, entry in structural["contracts"].items():
        within_budget = (
            entry["within_shared_depth_budget"] and entry["within_shared_node_budget"]
        )
        fits = "ok" if within_budget else "OVER"
        print(
            f"{name:<34} {entry['max_depth_worst_case']:>6} {entry['max_nodes_worst_case']:>8} "
            f"{entry['max_string_bytes']:>7} {entry['max_array_items']:>6}  {fits}"
        )
    violations = find_budget_violations(structural)
    if violations:
        print("\nHARD -- unreachable declared capacity (blocks the freeze):")
        for item in violations:
            print(f"  - {item}")
    advisories = find_joint_capacity_advisories(structural)
    if advisories:
        print("\nADVISORY -- jointly unsatisfiable maxima (owner decision before the freeze):")
        for item in advisories:
            print(f"  - {item}")
    # The bare no-flag form is the recipe handed to the owner, so it must not
    # exit 0 while printing a freeze blocker. Advisories are informational by
    # definition and do not affect the exit code.
    return 1 if violations else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--emit", action="store_true", help="write the derived section into budgets.json"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if budgets.json drifted from the schemas",
    )
    parser.add_argument(
        "--stage7-memory-p95-bytes",
        type=int,
        help="record measured Stage 7 renderer p95 and derive warning/hard limits",
    )
    args = parser.parse_args()

    if args.stage7_memory_p95_bytes is not None:
        measured = args.stage7_memory_p95_bytes
        if measured <= 0:
            raise SystemExit("Stage 7 memory p95 must be positive")
        mib = 1024 * 1024
        warning = ((measured * 3 // 2 + mib - 1) // mib) * mib
        hard = ((measured * 2 + mib - 1) // mib) * mib
        if hard > 512 * mib:
            raise SystemExit("Stage 7 memory p95 would exceed the 512 MiB isolation cap")
        document = json.loads(STAGE7_BUDGETS_PATH.read_text(encoding="utf-8"))
        document["limits"]["memory_p95_bytes"] = measured
        document["limits"]["memory_warning_bytes"] = warning
        document["limits"]["memory_hard_bytes"] = hard
        STAGE7_BUDGETS_PATH.write_text(
            json.dumps(document, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
        print(f"wrote {STAGE7_BUDGETS_PATH.relative_to(ROOT)} from measured p95")
        return 0

    structural = derive_structural()
    if args.emit:
        return emit(structural)
    if args.check:
        return check(structural)
    return report(structural)


if __name__ == "__main__":
    raise SystemExit(main())
