"""Call-side helpers over the durable operation ledger.

The store (operation_ledger.py) owns receipts, locking, and decisions; this
module owns everything a CALL does around it: the settle bracket, idempotency
key derivation/injection at the dispatch seam, content-addressed
reconciliation, replayed-outcome shaping, and the operation_status rendering.
Every public name here is re-exported from operation_ledger for stability.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sidecar.ai.tools.contracts import canonicalize_tool_arguments
from sidecar.ai.tools.tool_actions import effective_side_effecting

if TYPE_CHECKING:
    from sidecar.runtime.operation_ledger import OperationLedger


@dataclass
class OperationLedgerCall:
    ledger: OperationLedger | None
    key: str
    evidence: dict[str, str]
    operation_id: str

    def settle_failure(self, tool_name: str, error_data: dict[str, str], error: object) -> None:
        if self.ledger is None or not self.key:
            return
        status = self.ledger.settle_failure(
            operation_id=self.key, effects=str(error_data.get("effects") or ""),
            now_iso=operation_timestamp(), evidence=self.evidence, rollback_status=None,
        )
        if status == "indeterminate":
            error_data["effects"] = "unknown"

    def settle_unexpected(self) -> None:
        if self.ledger is not None and self.key:
            now_iso = operation_timestamp()
            self.ledger.settle(operation_id=self.key, status="indeterminate", now_iso=now_iso)

    def settle_result(  # noqa: PLR0913
        self, *, tool_name: str, success: bool, output_text: str,
        metadata: dict[str, object],
        generated_artifacts: tuple[dict[str, object], ...],
    ) -> None:
        if self.ledger is None or not self.key:
            return
        evidence = dict(self.evidence)
        if tool_name == "create_artifact" and generated_artifacts:
            display_path = generated_artifacts[0].get("display_path")
            if isinstance(display_path, str) and display_path:
                evidence["display_path"] = display_path
        status, settled = self.ledger.settle_result(
            operation_id=self.key, success=success, output_text=output_text,
            now_iso=operation_timestamp(), evidence=evidence,
            asserted_effects=metadata.get("effects"), rollback_status=None,
        )
        if settled:
            metadata["effects"] = {
                "committed": "committed",
                "failed": "none",
            }.get(status, "unknown")


def reconcile_content_addressed_pending(receipt: dict, *, workspace_root: Path) -> str:
    """Prove a content-addressed pending write committed, or stay uncertain."""
    try:
        evidence = receipt.get("evidence")
        if not isinstance(evidence, dict):
            return "indeterminate"
        relative_path = evidence.get("relative_path")
        expected = evidence.get("content_sha256")
        if not isinstance(relative_path, str) or not relative_path or not isinstance(expected, str):
            return "indeterminate"
        root = workspace_root.expanduser().resolve(strict=True)
        candidate = (root / relative_path).resolve(strict=True)
        candidate.relative_to(root)
        digest = hashlib.sha256(candidate.read_text(encoding="utf-8").encode("utf-8")).hexdigest()
        return "committed" if digest == expected else "indeterminate"
    except (OSError, RuntimeError, ValueError):
        return "indeterminate"



def ledger_request_fingerprint(*, tool_name: str, arguments: dict[str, object]) -> str:
    public = {key: value for key, value in arguments.items() if not key.startswith("_jenny_")}
    canonical = json.dumps(public, sort_keys=True, separators=(",", ":"), default=str)
    return "fp_" + hashlib.sha256(f"{tool_name}\x1f{canonical}".encode()).hexdigest()


def derive_idempotency_key(
    *, session_id: str, request_id: str, call_id: str, tool_id: str,
    canonical_arguments: object,
) -> str:
    canonical = json.dumps(
        canonical_arguments, sort_keys=True, separators=(",", ":"), default=str
    )
    payload = "\x1f".join((session_id, request_id, call_id, tool_id, canonical))
    return "idem_" + hashlib.sha256(payload.encode()).hexdigest()[:24]


def inject_idempotency_key(
    tool_arguments: dict[str, object], *, descriptor: Any, runtime: Any, call: Any
) -> dict[str, object]:
    try:
        if (
            descriptor is None
            or getattr(descriptor, "source_kind", "mcp") == "mcp"
            or effective_side_effecting(descriptor, call.arguments) is not True
        ):
            return tool_arguments
        canonical, _ = canonicalize_tool_arguments(
            tool_name=call.tool_id, arguments=call.arguments
        )
        tool_arguments["_jenny_idempotency_key"] = derive_idempotency_key(
            session_id=str(getattr(runtime, "session_id", "") or ""),
            request_id=str(getattr(runtime, "request_id", "") or ""),
            call_id=str(call.call_id or ""),
            tool_id=str(call.tool_id or ""),
            canonical_arguments=canonical,
        )
    except Exception:
        pass
    return tool_arguments


def operation_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")



def recorded_operation_outcome(
    receipt: dict[str, object],
) -> tuple[bool, str, dict[str, object]]:
    status = str(receipt.get("status") or "indeterminate")
    raw_evidence = receipt.get("evidence")
    evidence: dict[str, object] = raw_evidence if isinstance(raw_evidence, dict) else {}
    if status != "committed":
        effects = "none" if status == "failed" and evidence.get("effects") == "none" else "unknown"
        return (
            False,
            f"Operation has recorded terminal status {status}; it was not re-executed.",
            {"recorded_status": status, "effects": effects},
        )
    text = "Operation already committed; receipt replayed. Evidence: " + json.dumps(
        evidence, ensure_ascii=False, sort_keys=True
    )
    metadata: dict[str, object] = {"effects": "committed", "evidence": evidence}
    digest = receipt.get("terminal_result_digest")
    if isinstance(digest, str) and digest:
        metadata["terminal_result_digest"] = digest
    return True, text, metadata


def render_operation_status(
    receipts: list[dict], *, current_generation_id: str, background_job_ids: list[str]
) -> str:
    lines: list[str] = []
    for receipt in receipts:
        raw_evidence = receipt.get("evidence")
        evidence: dict[str, object] = raw_evidence if isinstance(raw_evidence, dict) else {}
        path = str(evidence.get("relative_path") or "")
        verify = f"read_file {path}" if path else "operation_status again later"
        generation = (
            "started by another process (an earlier interrupted run, or another live instance)"
            if receipt.get("generation_id") != current_generation_id
            else "current process"
        )
        lines.append(
            f"Operation {receipt['operation_id']}: pending; "
            f"tool {evidence.get('tool') or 'unknown tool'}; {generation}; "
            f"verify with: {verify}. Do not re-run automatically."
        )
    lines.extend(
        f"Background job {job_id}: running; cursor {job_id}." for job_id in background_job_ids
    )
    if lines:
        lines.append("Active monitor enumeration is unavailable in this process.")
    return "\n".join(lines) if lines else "No active operations."


