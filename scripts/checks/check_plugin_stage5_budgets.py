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
    "network": {
        "metadata_document_max_bytes": 2_097_152,
        "refresh_total_max_bytes": 16_777_216,
        "redirect_max": 5,
        "dns_answers_per_hop_max": 16,
        "connect_timeout_ms": 10_000,
        "first_byte_timeout_ms": 15_000,
        "total_timeout_ms": 120_000,
        "tuf_refresh_timeout_ms": 60_000,
        "git_fetch_timeout_ms": 120_000,
    },
    "distribution": {
        "solver_nodes_max": 64,
        "dependencies_per_node_max": 16,
        "candidates_per_plugin_max": 64,
        "solver_decisions_max": 4_096,
        "solver_incompatibilities_max": 8_192,
        "solver_timeout_ms": 2_000,
        "tuf_root_updates_max": 32,
        "tuf_delegated_roles_max": 64,
        "tuf_targets_max": 10_000,
        "cache_max_bytes": 536_870_912,
        "installed_store_max_bytes": 4_294_967_296,
        "installed_plugin_max_bytes": 536_870_912,
        "prior_generations_per_plugin": 2,
        "data_snapshots_per_plugin": 2,
    },
    "remote_mcp": {
        "descriptors_max": 64,
        "tools_per_descriptor_max": 64,
        "active_contributions_max": 256,
        "schema_item_max_bytes": 65_536,
        "discovery_max_bytes": 4_194_304,
        "inflight_global_max": 4,
        "inflight_per_descriptor_max": 1,
        "queue_global_max": 16,
        "queue_per_descriptor_max": 4,
        "response_max_bytes": 8_388_608,
        "sse_line_max_bytes": 65_536,
        "sse_events_max": 10_000,
    },
    "authorization": {
        "response_max_bytes": 65_536,
        "scopes_max": 32,
        "flow_ttl_ms": 600_000,
        "flows_global_max": 4,
        "flows_per_resource_max": 1,
        "step_up_attempts_max": 2,
        "access_token_cache_max": 64,
    },
}

RUNTIME_DECLARATIONS = {
    "services/plugins/network/bounded-http-client.js": {
        "DEFAULT_LIMITS": {
            "max_redirects": 5,
            "connect_timeout_ms": 10_000,
            "first_byte_timeout_ms": 15_000,
            "total_timeout_ms": 120_000,
        },
    },
    "services/plugins/network/dns-pinning.js": {"MAX_DNS_ANSWERS": 16},
    "services/plugins/distribution/distribution-limits.js": {
        "LIMITS": {
            "solverNodes": 64,
            "solverDecisions": 4_096,
            "solverIncompatibilities": 8_192,
            "cacheBytes": 536_870_912,
            "retainedGenerations": 3,
        },
    },
    "services/plugins/remote-mcp/operation-scheduler.js": {
        "DEFAULT_LIMITS": {
            "global_inflight": 4,
            "descriptor_inflight": 1,
            "global_queue": 16,
            "descriptor_queue": 4,
        },
    },
    "services/plugins/remote-mcp/transport.js": {"RESPONSE_MAX_BYTES": 8_388_608},
    "services/plugins/remote-mcp/sse-parser.js": {
        "DEFAULT_LIMITS": {"max_line_bytes": 65_536, "max_events": 10_000},
    },
    "services/plugins/auth/oauth-flow-service.js": {
        "FLOW_TTL_MS": 600_000,
        "MAX_FLOWS": 4,
        "MAX_STEP_UP_ATTEMPTS": 2,
        "MAX_SCOPES": 32,
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
