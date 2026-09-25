"""Exact provider-visible results retained by decision and dependency checkpoints."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from sidecar.ai.routing.router import ToolExecutionOutcome

_MAX_OUTCOMES = 255


def outcome_refs(outcomes: Any, mutation_ref: dict | None = None) -> list[dict]:
    refs = []
    for item in outcomes:
        if (
            not item.call_id
            or not isinstance(item.output, str)
            or type(item.success) is not bool
            or getattr(item, "trusted_attachments", False)
            or ("workspace_change_set" in (getattr(item, "metadata", {}) or {})
                and (mutation_ref is None
                     or not isinstance(item.metadata["workspace_change_set"], dict)
                     or item.metadata["workspace_change_set"].get("change_set_id")
                     != mutation_ref["change_set_id"]))
        ):
            raise ValueError("continuation_outcome_unsupported")
        refs.append(
            {
                "call_id": item.call_id,
                "tool_id": item.tool_name,
                "success": item.success,
                "result_sha256": hashlib.sha256(item.output.encode()).hexdigest(),
            }
        )
    if len(refs) > _MAX_OUTCOMES or len({ref["call_id"] for ref in refs}) != len(refs):
        raise ValueError("continuation_outcome_capacity")
    return refs


def _legacy_child_effects(results: list, checkpoint: dict) -> list[dict]:
    expected = [
        (ref, tool)
        for tool, refs in (
            ("session_spawn", checkpoint.get("completed_spawn_refs", [])),
            ("session_wait", checkpoint.get("completed_wait_refs", [])),
        )
        for ref in refs
    ]
    refs = []
    for event in results:
        matches = [
            (ref, tool) for ref, tool in expected if ref["call_id"] == event.get("tool_call_id")
        ]
        if len(matches) != 1:
            raise ValueError("dependency_outcome_unreferenced")
        ref, tool = matches[0]
        payload = event["payload"]
        output = payload.get("tool_output_summary")
        receipt = json.loads(output)
        canonical = json.dumps(
            receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode()
        if (
            payload.get("tool_name") != tool
            or payload.get("success") is not True
            or not isinstance(receipt, dict)
            or receipt.get("child_work_id") != ref["child_work_id"]
            or hashlib.sha256(canonical).hexdigest() != ref["result_sha256"]
        ):
            raise ValueError("dependency_outcome_receipt_mismatch")
        refs.append(
            {
                "call_id": ref["call_id"],
                "tool_id": tool,
                "success": True,
                "result_sha256": hashlib.sha256(output.encode()).hexdigest(),
            }
        )
    if len(refs) != len(expected):
        raise ValueError("dependency_outcome_missing")
    return refs


_MIN_BYTES = 2
_MAX_EVENTS = 4096


def decode_continuation_outcomes(body: bytes, checkpoint: dict[str, Any]) -> tuple[Any, ...]:
    if (
        not isinstance(body, bytes)
        or not _MIN_BYTES <= len(body) <= 1024 * 1024
        or hashlib.sha256(body).hexdigest() != checkpoint["canonical_refs"]["turn_ref"]["sha256"]
    ):
        raise ValueError("decision_canonical_events_invalid")
    events = json.loads(body)
    if not isinstance(events, list) or len(events) > _MAX_EVENTS:
        raise ValueError("decision_canonical_events_invalid")
    results = [event for event in events if event.get("kind") == "tool_result"]
    refs = checkpoint.get("completed_effect_refs")
    if refs is None:
        refs = _legacy_child_effects(results, checkpoint)
    if len(results) != len(refs):
        raise ValueError("decision_completed_results_mismatch")
    outcomes = []
    for ref in refs:
        matches = [event for event in results if event.get("tool_call_id") == ref["call_id"]]
        if len(matches) != 1:
            raise ValueError("decision_completed_results_mismatch")
        event = matches[0]
        payload = event["payload"]
        output = payload.get("tool_output_summary")
        if (
            event.get("turn_id") != checkpoint["identity"]["turn_id"]
            or payload.get("tool_name") != ref["tool_id"]
            or type(payload.get("success")) is not bool
            or payload["success"] != ref["success"]
            or not isinstance(output, str)
            or hashlib.sha256(output.encode()).hexdigest() != ref["result_sha256"]
            or payload.get("trusted_attachment_refs")
        ):
            raise ValueError("decision_completed_result_invalid")
        outcomes.append(
            ToolExecutionOutcome(
                call_id=ref["call_id"],
                tool_name=ref["tool_id"],
                output=output,
                success=ref["success"],
                tool_input=dict(payload.get("tool_input", {})),
                content_type=payload.get("content_type", "text"),
                ui_payload=payload.get("ui_payload"),
                generated_artifacts=tuple(payload.get("generated_artifacts", [])),
                error_code=payload.get("error_code"),
                metadata=dict(payload.get("metadata", {})),
            )
        )
    outcome_refs(outcomes, checkpoint.get("mutation_ref"))
    return tuple(outcomes)
