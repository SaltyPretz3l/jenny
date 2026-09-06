"""Validate the standing Chat Lifecycle v2 invariant/scenario evidence roster."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MATRIX = ROOT / "tests" / "fixtures" / "chat-lifecycle-v2-invariant-matrix.json"
OWNERS = {"backend", "cross-boundary", "renderer", "sidecar", "storage"}
EVIDENCE_ANCHORS = {
    "tests/backend-service-lifecycle.test.js": (
        "approve and deny resolve scoped approval ids"
    ),
    "tests/backend-sessions.test.js": (
        "managed createSession rejects when the session store refuses"
    ),
    "tests/canonical-turn-event-contract.test.js": (
        "validateTurnEvent matches shared fixture cases"
    ),
    "tests/chat-stream-bridge-v2.test.js": (
        "refuses promotion for mismatched or stale terminal receipts"
    ),
    "tests/chat-stream-managed-runtime-notifications.test.js": (
        "chat.token accrues visible text"
    ),
    "tests/chat-stream-overlap.test.js": "second concurrent send on the same session is rejected",
    "tests/chat-stream-terminal-coordinator.test.js": (
        "all terminal variants use one epoch-proven commit"
    ),
    "tests/chat-terminal-status-vocabulary.test.js": "fails closed to unknown",
    "tests/conversation-store-conformance.test.js": (
        "identity, idempotency, and durability epochs"
    ),
    "tests/electron-session-store-edit-roundtrip.test.js": (
        "old assistant/reasoning/tool rows do not project"
    ),
    "tests/renderer-app-surface-input.test.js": "SURFACE_INPUT_BLOCKER_SELECTOR",
    "tests/renderer-chat-branch-utils.test.js": "branch completion preserves newer navigation",
    "tests/renderer-send-outbox.test.js": "multiple sends preserve immutable FIFO order",
    "tests/renderer-stream-continuation-guard.test.js": (
        "rejects a replaced session incarnation"
    ),
    "tests/renderer-stream-envelope-v2.test.js": "poisons forward and per-channel gaps",
    "tests/renderer-stream-handler-phase-envelope.test.js": (
        "sequence faults switch the live subscription"
    ),
    "tests/renderer-stream-handler-seams.test.js": (
        "falls back to legacy stream events"
    ),
    "tests/renderer-stream-handler-terminal-absorbing.test.js": (
        "late delta after complete"
    ),
    "tests/renderer-stream-handler-terminal-hydration-ordering.test.js": (
        "preserved local-only message"
    ),
    "tests/renderer-stream-handler-terminal-postwork.test.js": (
        "busy releases at a bounded deadline"
    ),
    "tests/renderer-stream-handler-terminal-unsaved.test.js": (
        "unsaved question batches remain inert"
    ),
    "tests/renderer-stream-mailbox.test.js": (
        "serializes one stream while independent streams remain parallel"
    ),
    "tests/renderer-stream-terminal-state.test.js": "preserves the locally terminal row",
    "tests/renderer-transcript-reasoning-v2.test.js": "renders the v2 three-part header anatomy",
    "tests/session-recovery-service.test.js": "replays journaled turn events",
    "tests/session-turn-actor.test.js": "synchronous same-session CAS",
    "tests/session-turn-events.test.js": "RETAINS the journal",
    "tests/sidecar/ai/engines/test_provider_stream_bounds.py": (
        "test_ollama_never_newline_record_is_rejected"
    ),
    "tests/sidecar/ai/routing/test_tool_loop.py": (
        "test_tool_bearing_generation_counts_parse_success"
    ),
    "tests/sidecar/runtime/test_multiplexer.py": "test_chat_cancel_tombstone_replays",
    "tests/stream-envelope-receipt-gate.test.js": (
        "rejects mismatches and immediately reopens legacy"
    ),
}


def _expected(prefix: str, count: int) -> set[str]:
    return {f"{prefix}{index:02d}" for index in range(1, count + 1)}


def _validate_evidence(row_id: str, evidence: object) -> list[str]:
    if not isinstance(evidence, list) or not evidence:
        return [f"{row_id}: evidence must be a non-empty list"]
    errors: list[str] = []
    for raw_path in evidence:
        relative_path = str(raw_path)
        evidence_path = ROOT / relative_path
        if not evidence_path.is_file():
            errors.append(f"{row_id}: missing evidence file {relative_path}")
            continue
        anchor = EVIDENCE_ANCHORS.get(relative_path)
        if not anchor:
            errors.append(f"{row_id}: evidence file has no named test anchor {relative_path}")
            continue
        try:
            evidence_text = evidence_path.read_text(encoding="utf-8")
        except OSError as error:
            errors.append(f"{row_id}: cannot read evidence file {relative_path}: {error}")
            continue
        if anchor not in evidence_text:
            errors.append(f"{row_id}: missing named test anchor {anchor!r} in {relative_path}")
    return errors


def _validate_rows(rows: object, expected: set[str], label: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(rows, list):
        return [f"{label} must be a list"]
    ids = [str(row.get("id", "")) for row in rows if isinstance(row, dict)]
    if len(ids) != len(set(ids)):
        errors.append(f"{label} contains duplicate ids")
    if set(ids) != expected:
        errors.append(
            f"{label} ids differ: missing={sorted(expected - set(ids))} "
            f"extra={sorted(set(ids) - expected)}"
        )
    for row in rows:
        if not isinstance(row, dict):
            errors.append(f"{label} contains a non-object row")
            continue
        row_id = str(row.get("id", "<missing>"))
        if not str(row.get("description", "")).strip():
            errors.append(f"{row_id}: missing description")
        if row.get("owner") not in OWNERS:
            errors.append(f"{row_id}: invalid owner {row.get('owner')!r}")
        errors.extend(_validate_evidence(row_id, row.get("evidence")))
    return errors


def main() -> int:
    try:
        payload = json.loads(MATRIX.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAIL: cannot read lifecycle matrix: {error}")
        return 1
    errors = [
        *_validate_rows(payload.get("invariants"), _expected("I", 27), "invariants"),
        *_validate_rows(payload.get("scenarios"), _expected("S", 37), "scenarios"),
    ]
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS: Chat Lifecycle v2 matrix covers 27 invariants and 37 scenarios")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
