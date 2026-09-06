"""Freeze and validate the Stage 7 sandboxed-view numeric budget ledger."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUDGET_PATH = ROOT / "config" / "plugins" / "stage7-budgets.json"
EXPECTED_SHA256 = "7a0f51b44aa62c606eb5c5c6892988bcd97502703d6163c78d91475cf3d85a2d"
MAX_MEMORY_HARD_BYTES = 512 * 1024 * 1024
REQUIRED_LIMITS = {
    "visible_views_global", "visible_views_per_plugin", "background_views_global",
    "assets_per_view", "asset_bytes", "view_bytes", "plugin_view_bytes",
    "bridge_request_bytes", "bridge_response_bytes", "bridge_depth", "bridge_nodes",
    "bridge_object_keys", "bridge_array_items", "bridge_messages_per_second",
    "bridge_queue", "bridge_subscriptions", "bridge_retained_events",
    "artifact_bytes", "artifact_chunk_bytes", "create_deadline_ms", "ready_deadline_ms",
    "dispose_deadline_ms", "zoom_min_milli", "zoom_max_milli", "zoom_step_milli",
    "crash_restarts", "crash_window_ms", "memory_p95_bytes", "memory_warning_bytes",
    "memory_hard_bytes",
    "create_p95_ms", "dispose_p95_ms", "manager_interaction_p95_ms",
}
ZERO_ALLOWED = {"background_views_global"}


def main() -> int:
    canonical = BUDGET_PATH.read_bytes().replace(b"\r\n", b"\n")
    document = json.loads(canonical)
    limits = document.get("limits") if isinstance(document, dict) else None
    violations: list[str] = []
    if hashlib.sha256(canonical).hexdigest() != EXPECTED_SHA256:
        violations.append("stage7-budgets.json differs from its frozen digest")
    if set(document) != {"budget_schema_version", "frozen", "limits"}:
        violations.append("budget document has an unexpected top-level shape")
    if document.get("budget_schema_version") != 1 or document.get("frozen") is not True:
        violations.append("budget document must be schema 1 and frozen")
    if not isinstance(limits, dict) or set(limits) != REQUIRED_LIMITS:
        violations.append("budget limits do not exactly match the Stage 7 ledger")
    elif any(isinstance(value, bool) or not isinstance(value, int) or value < 0 or (
        value == 0 and key not in ZERO_ALLOWED
    ) for key, value in limits.items()):
        violations.append("every Stage 7 budget must be a valid non-negative integer")
    else:
        mib = 1024 * 1024
        measured = limits["memory_p95_bytes"]
        expected_warning = ((measured * 3 // 2 + mib - 1) // mib) * mib
        expected_hard = ((measured * 2 + mib - 1) // mib) * mib
        if expected_hard > MAX_MEMORY_HARD_BYTES:
            violations.append("measured p95 requires a hard limit above the 512 MiB Stage 7 cap")
        elif limits["memory_warning_bytes"] != expected_warning \
                or limits["memory_hard_bytes"] != expected_hard:
            violations.append("memory warning/hard limits must be generated from measured p95")
    if violations:
        print("FAIL: plugin Stage 7 budget check")
        for violation in violations:
            print(f"  - {violation}")
        return 1
    print(f"PASS: plugin Stage 7 budgets ({len(limits)} frozen limits)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
