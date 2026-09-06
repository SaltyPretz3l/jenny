"""Freeze and validate the Stage 8 privileged-adapter budget ledger."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUDGET_PATH = ROOT / "config" / "plugins" / "stage8-budgets.json"
EXPECTED_SHA256 = "5fcb647268862c5ff8a82e55858e4ceb418e5b5c714d0af9a1125716c48bad92"
REQUIRED_LIMITS = {
    "full_host_processes_global", "full_host_processes_per_plugin",
    "full_host_processes_per_contribution", "native_mcp_sessions_global",
    "native_mcp_sessions_per_binding", "engine_sessions_global",
    "engine_sessions_per_contribution", "process_descendants_per_tree",
    "startup_deadline_ms", "attestation_deadline_ms", "load_deadline_ms",
    "provisioning_deadline_ms", "provisioning_progress_interval_ms",
    "idle_eviction_ms", "absolute_lease_ms", "graceful_shutdown_ms",
    "forced_proof_ms", "cpu_rate_milli_core", "process_memory_warning_bytes",
    "process_memory_hard_bytes", "privileged_memory_hard_bytes",
    "invocation_queue_per_contribution", "invocation_queue_global",
    "frame_bytes", "result_bytes", "stream_bytes", "stderr_tail_bytes",
    "diagnostic_chars", "crash_limit", "crash_window_ms",
    "crash_backoff_1_ms", "crash_backoff_2_ms", "crash_backoff_3_ms",
    "secret_payload_bytes", "secret_channel_ttl_ms", "secret_deliveries",
    "hook_depth", "hook_fanout", "hook_queue", "hook_event_bytes",
    "hook_deadline_ms", "hook_retries", "hook_dedupe_ids",
    "hook_dedupe_ttl_ms", "provisioned_storage_per_plugin_bytes",
    "provisioned_storage_global_bytes", "consent_windows_global",
    "consent_pending_global", "consent_deadline_ms",
    "native_mcp_discovery_pages", "native_mcp_descriptors",
    "native_mcp_schema_bytes", "native_mcp_schema_total_bytes",
    "native_mcp_discovery_deadline_ms",
}


def main() -> int:
    canonical = BUDGET_PATH.read_bytes().replace(b"\r\n", b"\n")
    document = json.loads(canonical)
    limits = document.get("limits") if isinstance(document, dict) else None
    violations: list[str] = []
    if hashlib.sha256(canonical).hexdigest() != EXPECTED_SHA256:
        violations.append("stage8-budgets.json differs from its frozen digest")
    if set(document) != {"budget_schema_version", "frozen", "limits"}:
        violations.append("budget document has an unexpected top-level shape")
    if document.get("budget_schema_version") != 1 or document.get("frozen") is not True:
        violations.append("budget document must be schema 1 and frozen")
    if not isinstance(limits, dict) or set(limits) != REQUIRED_LIMITS:
        violations.append("budget limits do not exactly match the Stage 8 ledger")
    elif any(isinstance(value, bool) or not isinstance(value, int) or value <= 0
             for value in limits.values()):
        violations.append("every Stage 8 budget must be a positive integer")
    else:
        relationships = (
            (limits["full_host_processes_per_plugin"] <= limits["full_host_processes_global"],
             "per-plugin host budget exceeds global budget"),
            (limits["full_host_processes_per_contribution"] <= limits["full_host_processes_global"],
             "per-contribution host budget exceeds global budget"),
            (limits["native_mcp_sessions_per_binding"] <= limits["native_mcp_sessions_global"],
             "per-binding MCP budget exceeds global budget"),
            (limits["engine_sessions_per_contribution"] <= limits["engine_sessions_global"],
             "per-contribution engine budget exceeds global budget"),
            (limits["process_memory_warning_bytes"] < limits["process_memory_hard_bytes"]
             <= limits["privileged_memory_hard_bytes"], "memory limits are not ordered"),
            (limits["frame_bytes"] <= limits["result_bytes"] <= limits["stream_bytes"],
             "transport byte limits are not ordered"),
            (limits["invocation_queue_per_contribution"] <= limits["invocation_queue_global"],
             "per-contribution queue exceeds global queue"),
            (limits["crash_backoff_1_ms"] < limits["crash_backoff_2_ms"]
             < limits["crash_backoff_3_ms"], "crash backoffs are not strictly ascending"),
            (limits["provisioned_storage_per_plugin_bytes"]
             <= limits["provisioned_storage_global_bytes"], "per-plugin storage exceeds global"),
            (limits["secret_deliveries"] == 1, "direct-secret authority must be one-shot"),
            (limits["hook_depth"] == 1, "hook causal depth must remain one"),
            (limits["consent_windows_global"] == 1 and limits["consent_pending_global"] == 1,
             "consent must allow only one window and pending prompt"),
        )
        violations.extend(message for valid, message in relationships if not valid)
    if violations:
        print("FAIL: plugin Stage 8 budget check")
        for violation in violations:
            print(f"  - {violation}")
        return 1
    print(f"PASS: plugin Stage 8 budgets ({len(limits)} frozen limits)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
