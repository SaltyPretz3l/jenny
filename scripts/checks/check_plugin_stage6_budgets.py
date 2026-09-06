"""Freeze and validate the Stage 6 restricted-host numeric budget ledger."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUDGET_PATH = ROOT / "config" / "plugins" / "stage6-budgets.json"
EXPECTED_SHA256 = "efec535262bf0d997aa0273814b679ccd1663c68c589584f09f00598c54049d1"
REQUIRED_LIMITS = {
    "component_bytes", "guest_linear_memory_bytes", "helper_working_set_bytes",
    "tables", "elements", "instances_per_host", "hosts_global", "hosts_per_plugin",
    "concurrent_invocations_global", "concurrent_invocations_per_host",
    "queued_invocations_global", "queued_invocations_per_host", "token_lifetime_ms",
    "token_uses", "secret_handle_lifetime_ms", "secret_handle_uses", "frames",
    "frame_bytes", "stream_bytes", "result_bytes", "unacked_window", "pause_ceiling_ms",
    "transport_message_bytes", "transport_queue", "invocation_deadline_ms",
    "load_deadline_ms", "bootstrap_deadline_ms", "attestation_deadline_ms",
    "guest_cancel_ms", "host_settlement_ms", "shutdown_grace_ms", "forced_exit_ms",
    "stderr_tail_bytes", "retained_events_per_contribution", "retained_events_global",
    "crash_restarts", "crash_window_ms",
}


def main() -> int:
    canonical = BUDGET_PATH.read_bytes().replace(b"\r\n", b"\n")
    digest = hashlib.sha256(canonical).hexdigest()
    document = json.loads(canonical)
    limits = document.get("limits") if isinstance(document, dict) else None
    violations: list[str] = []
    if digest != EXPECTED_SHA256:
        violations.append("stage6-budgets.json differs from its frozen digest")
    if set(document) != {"budget_schema_version", "frozen", "limits"}:
        violations.append("budget document has an unexpected top-level shape")
    if document.get("budget_schema_version") != 1 or document.get("frozen") is not True:
        violations.append("budget document must be schema 1 and frozen")
    if not isinstance(limits, dict) or set(limits) != REQUIRED_LIMITS:
        violations.append("budget limits do not exactly match the Stage 6 ledger")
    elif any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in limits.values()):
        violations.append("every Stage 6 budget must be a positive integer")
    if violations:
        print("FAIL: plugin Stage 6 budget check")
        for violation in violations:
            print(f"  - {violation}")
        return 1
    print(f"PASS: plugin Stage 6 budgets ({len(limits)} frozen limits)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
