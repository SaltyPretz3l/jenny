"""Durable operation-ledger integration for the builtin MCP server."""

from __future__ import annotations

import hashlib
import logging
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.shell_background import active_job_ids
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.operation_ledger import (
    OperationLedger,
    OperationLedgerCall,
    OperationLedgerUnavailable,
    ledger_request_fingerprint,
    operation_timestamp,
    reconcile_content_addressed_pending,
    recorded_operation_outcome,
    render_operation_status,
    workspace_evidence_marker,
)

logger = logging.getLogger(__name__)
_IDEMPOTENCY_KEY_RE = re.compile(r"idem_[0-9a-f]{24}")
_OPERATION_LEDGER_ROOT: list[Path | None] = [None]
# One ledger per configured root: building one captures the trusted root and
# creates its directory, so every bracketed call reusing it skips that work.
_LEDGER_CACHE: list[tuple[Path, OperationLedger] | None] = [None]
_LEDGER_CACHE_LOCK = threading.Lock()
_MAX_EVIDENCE_SESSION_ID = 200


def configure_operation_ledger(root: Path | str | None) -> None:
    _OPERATION_LEDGER_ROOT[0] = None if root is None else Path(root).expanduser()
    with _LEDGER_CACHE_LOCK:
        _LEDGER_CACHE[0] = None


def current_operation_ledger() -> OperationLedger | None:
    root = _OPERATION_LEDGER_ROOT[0]
    if root is None:
        return None
    with _LEDGER_CACHE_LOCK:
        cached = _LEDGER_CACHE[0]
    if cached is not None and cached[0] == root and cached[1].still_bound():
        return cached[1]
    try:
        ledger = OperationLedger(root)
    except OperationLedgerUnavailable:
        logger.warning("operation ledger is unavailable; executing without certainty")
        return None
    with _LEDGER_CACHE_LOCK:
        if _OPERATION_LEDGER_ROOT[0] == root:
            _LEDGER_CACHE[0] = (root, ledger)
    return ledger


def start_background_compaction() -> threading.Thread | None:
    """Compact the ledger beside the serving loop instead of before it.

    Non-daemon, so a normal exit lets the sweep finish and release its lock.
    """
    ledger = current_operation_ledger()
    if ledger is None:
        return None

    def run() -> None:
        try:
            ledger.compact(now_iso=operation_timestamp())
        except Exception:  # noqa: BLE001 - maintenance must never break serving
            logger.warning("operation ledger compaction failed", exc_info=True)

    thread = threading.Thread(target=run, name="operation-ledger-compact", daemon=False)
    thread.start()
    return thread


def _session_receipts(receipts: list[dict], arguments: object) -> list[dict]:
    """Only the calling session's receipts when the call carries a session id."""
    raw = arguments.get("_jenny_session_id") if isinstance(arguments, dict) else None
    session_id = raw.strip()[:_MAX_EVIDENCE_SESSION_ID] if isinstance(raw, str) else ""
    if not session_id:
        return receipts
    return [
        receipt for receipt in receipts
        if isinstance(receipt.get("evidence"), dict)
        and receipt["evidence"].get("session_id") == session_id
    ]


def operation_status_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
    *,
    generation_id: str,
) -> ToolHandlerResult:
    ledger = current_operation_ledger()
    receipts, corrupt_count = ledger.pending_receipts() if ledger is not None else ([], 0)
    receipts = _session_receipts(receipts, arguments)
    if ledger is not None and workspace.root is not None:
        pending: list[dict] = []
        for receipt in receipts:
            evidence = receipt.get("evidence")
            if not (
                isinstance(evidence, dict)
                and isinstance(evidence.get("relative_path"), str)
                and isinstance(evidence.get("content_sha256"), str)
            ):
                pending.append(receipt)
                continue
            if (
                reconcile_content_addressed_pending(receipt, workspace_root=workspace.root)
                != "committed"
            ):
                pending.append(receipt)
                continue
            operation_id = receipt.get("operation_id")
            if isinstance(operation_id, str):
                ledger.settle(
                    operation_id=operation_id,
                    status="committed",
                    now_iso=operation_timestamp(),
                    evidence=evidence,
                )
        receipts = pending
    output = render_operation_status(
        receipts,
        current_generation_id=generation_id,
        background_job_ids=active_job_ids(),
    )
    disclosure = None
    if ledger is None:
        disclosure = "Operation ledger is unavailable; active operations cannot be enumerated."
    elif corrupt_count:
        disclosure = f"Operation ledger contains {corrupt_count} unreadable or corrupt receipt(s)."
    if disclosure is not None:
        output = disclosure if output == "No active operations." else f"{output}\n{disclosure}"
    return ToolHandlerResult(
        output=output,
        metadata={"effects": "none"},
    )


def _pending_evidence(
    tool_name: str, arguments: dict[str, object], workspace: WorkspaceGuard
) -> dict[str, str]:
    evidence = {"tool": tool_name}
    # Session attribution: the interruption overlay surfaces only this
    # session's pendings, never another chat's or a test run's.
    session_id = arguments.get("_jenny_session_id")
    if isinstance(session_id, str) and session_id.strip():
        evidence["session_id"] = session_id.strip()[:_MAX_EVIDENCE_SESSION_ID]
    if tool_name != "write_file":
        return evidence
    path = arguments.get("path")
    content = arguments.get("content")
    if isinstance(path, str) and isinstance(content, str):
        resolved = workspace.resolve_write_path(path)
        root = workspace.require_root()
        evidence["relative_path"] = resolved.relative_to(root).as_posix()
        evidence["content_sha256"] = hashlib.sha256(content.encode("utf-8")).hexdigest()
        evidence["workspace_sha256"] = workspace_evidence_marker(root)
    return evidence


def _recorded_operation_response(
    message_id: Any,
    receipt: dict[str, object],
    *,
    error_response: Callable[..., dict[str, Any]],
    result_response: Callable[[Any, dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    success, text, metadata = recorded_operation_outcome(receipt)
    if not success:
        return error_response(message_id, CMP_TOOL_IO_FAILED, text, metadata=metadata)
    return result_response(
        message_id,
        {
            "content": [{"type": "text", "text": text}],
            "isError": False,
            "content_type": "text",
            "success": True,
            "generated_artifacts": [],
            "metadata": metadata,
        },
    )


def _ledger_refusal_response(
    message_id: Any,
    decision: str,
    operation_id: str,
    *,
    error_response: Callable[..., dict[str, Any]],
    effects: str = "unknown",
) -> dict[str, Any]:
    message = (
        f"Operation {operation_id} is already in flight."
        if decision == "join_pending"
        else f"Operation {operation_id} was rejected by the durable ledger: {decision}."
    )
    return error_response(
        message_id,
        CMP_TOOL_IO_FAILED,
        message,
        metadata={"failure_class": "conflict", "effects": effects},
    )


def _create_artifact_coverage_refusal(
    tool_name: str,
    message_id: Any,
    decision: str,
    operation_id: str,
    *,
    error_response: Callable[..., dict[str, Any]],
) -> dict[str, Any] | None:
    if tool_name != "create_artifact":
        return None
    return _ledger_refusal_response(
        message_id,
        decision,
        operation_id,
        error_response=error_response,
        effects="none",
    )


@dataclass
class LedgerBracket(OperationLedgerCall):
    response: dict[str, Any] | None = None

    @classmethod
    def start(  # noqa: PLR0913
        cls,
        *,
        tool_name: str,
        side_effecting: bool,
        key: str,
        arguments: dict[str, object],
        operation_id: str,
        workspace: WorkspaceGuard,
        message_id: Any,
        generation_id: str,
        error_response: Callable[..., dict[str, Any]],
        result_response: Callable[[Any, dict[str, Any]], dict[str, Any]],
    ) -> LedgerBracket:
        response: dict[str, Any] | None
        if not side_effecting:
            return cls(None, key, {}, operation_id)
        if not key:
            response = _create_artifact_coverage_refusal(
                tool_name,
                message_id,
                "missing_or_invalid_idempotency_key",
                operation_id,
                error_response=error_response,
            )
            return cls(None, key, {}, operation_id, response)
        ledger = current_operation_ledger()
        if ledger is None:
            response = _create_artifact_coverage_refusal(
                tool_name,
                message_id,
                "operation_ledger_unavailable",
                key,
                error_response=error_response,
            )
            return cls(None, key, {}, operation_id, response)
        operation_id = key
        arguments["_jenny_operation_id"] = key
        evidence = _pending_evidence(tool_name, arguments, workspace)
        fingerprint = ledger_request_fingerprint(tool_name=tool_name, arguments=arguments)
        now_iso = operation_timestamp()
        decision = ledger.evaluate_idempotency(
            operation_id=key,
            request_fingerprint=fingerprint,
            now_iso=now_iso,
        )
        if decision.get("decision") == "proceed_new":
            created = ledger.create_pending(
                operation_id=key,
                request_fingerprint=fingerprint,
                generation_id=generation_id,
                now_iso=now_iso,
                evidence=evidence,
            )
            if created.get("outcome") == "joined":
                decision = {"decision": "join_pending", "receipt": created.get("receipt")}
            elif not created.get("ok"):
                decision = {"decision": "degraded", "reason": created.get("reason")}
        decision_name = str(decision.get("decision") or "reject_indeterminate")
        receipt = decision.get("receipt")
        if decision_name == "return_recorded_outcome" and isinstance(receipt, dict):
            response = _recorded_operation_response(
                message_id,
                receipt,
                error_response=error_response,
                result_response=result_response,
            )
        elif decision_name == "degraded":
            response = _create_artifact_coverage_refusal(
                tool_name,
                message_id,
                str(decision.get("reason") or "pending_receipt_unavailable"),
                key,
                error_response=error_response,
            )
            return cls(None, key, evidence, operation_id, response)
        elif decision_name != "proceed_new":
            response = _ledger_refusal_response(
                message_id,
                decision_name,
                key,
                error_response=error_response,
            )
        else:
            response = None
        return cls(ledger, key, evidence, operation_id, response)


def ledger_call_arguments(arguments: object) -> tuple[object, str, str]:
    if not isinstance(arguments, dict):
        return arguments, "", ""
    trace = arguments.get("_jenny_trace_id")
    raw_key = arguments.get("_jenny_idempotency_key")
    key = (
        raw_key
        if isinstance(raw_key, str) and _IDEMPOTENCY_KEY_RE.fullmatch(raw_key)
        else ""
    )
    sanitized = dict(arguments)
    sanitized.pop("_jenny_idempotency_key", None)
    return sanitized, key, trace if isinstance(trace, str) and trace else ""
