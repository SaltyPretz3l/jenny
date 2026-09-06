"""Transcript repair helpers for OpenAI-style chat messages."""

from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Any

from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

SYNTHETIC_TOOL_RESULT_PLACEHOLDER = "[Tool execution interrupted]"


def _message_id(message: dict[str, object], index: int) -> str:
    candidate = str(message.get("id") or "").strip()
    if candidate:
        return candidate
    return f"message_{index}"


def _copy_message(message: dict[str, object]) -> dict[str, object]:
    return dict(message)


def _call_id(call: Any) -> str:
    if not isinstance(call, dict):
        return ""
    return str(call.get("id") or call.get("call_id") or "").strip()


def _tool_call_name(call: Any) -> str:
    if not isinstance(call, dict):
        return ""
    return str(call.get("name") or call.get("tool_id") or "").strip()


def _tool_result_id(message: dict[str, object]) -> str:
    return str(message.get("tool_call_id") or "").strip()


def _message_content(message: dict[str, object]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    return ""


def _is_tool_message(message: dict[str, object]) -> bool:
    return str(message.get("role") or "").strip().lower() == "tool"


def _is_assistant_message(message: dict[str, object]) -> bool:
    return str(message.get("role") or "").strip().lower() == "assistant"


def _drop_empty_assistant(message: dict[str, object]) -> bool:
    tool_calls = message.get("tool_calls")
    has_calls = isinstance(tool_calls, list) and len(tool_calls) > 0
    return _is_assistant_message(message) and not has_calls and not _message_content(message)


def _dedupe_assistant_tool_calls(
    message: dict[str, object],
    *,
    seen_tool_call_ids: set[str],
) -> dict[str, object] | None:
    if not _is_assistant_message(message):
        return _copy_message(message)

    updated = _copy_message(message)
    tool_calls = updated.get("tool_calls")
    if not isinstance(tool_calls, list):
        return None if _drop_empty_assistant(updated) else updated

    deduped_calls: list[dict[str, object]] = []
    for raw_call in tool_calls:
        if not isinstance(raw_call, dict):
            continue
        call = dict(raw_call)
        call_id = _call_id(call)
        if not call_id or call_id in seen_tool_call_ids:
            continue
        seen_tool_call_ids.add(call_id)
        call["id"] = call_id
        deduped_calls.append(call)

    if deduped_calls:
        updated["tool_calls"] = deduped_calls
        return updated

    updated.pop("tool_calls", None)
    return None if _drop_empty_assistant(updated) else updated


def _synthetic_tool_result(tool_call_id: str, tool_name: str) -> dict[str, object]:
    message: dict[str, object] = {
        "role": "tool",
        "tool_call_id": tool_call_id,
        "content": SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
        "is_error": True,
    }
    if tool_name:
        message["name"] = tool_name
    return message


def _first_tool_call_indices(messages: list[dict[str, object]]) -> dict[str, int]:
    indices: dict[str, int] = {}
    for index, message in enumerate(messages):
        if not _is_assistant_message(message):
            continue
        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue
        for call in tool_calls:
            call_id = _call_id(call)
            if call_id and call_id not in indices:
                indices[call_id] = index
    return indices


def _first_real_tool_results(
    messages: list[dict[str, object]],
    call_indices: dict[str, int],
) -> dict[str, dict[str, object]]:
    results: dict[str, dict[str, object]] = {}
    for index, message in enumerate(messages):
        if not _is_tool_message(message):
            continue
        call_id = _tool_result_id(message)
        call_index = call_indices.get(call_id)
        if call_index is None or index <= call_index or call_id in results:
            continue
        results[call_id] = _copy_message(message)
    return results


def _repaired_assistant_group(
    message: dict[str, object],
    *,
    index: int,
    seen_tool_call_ids: set[str],
    real_results: dict[str, dict[str, object]],
) -> list[dict[str, object]]:
    assistant = _dedupe_assistant_tool_calls(
        message,
        seen_tool_call_ids=seen_tool_call_ids,
    )
    if assistant is None:
        return []
    tool_calls = assistant.get("tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        return [assistant]
    source_id = _message_id(assistant, index)
    repaired: list[dict[str, object]] = []
    for call_index, call in enumerate(tool_calls, start=1):
        call_id = _call_id(call)
        if not call_id:
            continue
        split_assistant = _copy_message(assistant)
        split_assistant["tool_calls"] = [dict(call)]
        if len(tool_calls) > 1:
            split_assistant["_normalized_from"] = source_id
            split_assistant["id"] = f"{source_id}__tool_{call_index}"
        repaired.append(split_assistant)
        result = real_results.get(call_id)
        repaired.append(
            _copy_message(result)
            if result is not None
            else _synthetic_tool_result(call_id, _tool_call_name(call))
        )
    return repaired


def ensure_tool_result_pairing(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    """Repair OpenAI-style tool groups without discarding real sibling results.

    A provider may return one assistant row containing several calls followed by
    results in any order.  Associate the complete sibling set before rendering
    the normalized one-call rows; only a genuinely absent result is synthesized.
    The first call/result occurrence wins when persisted history contains
    duplicates, and tool rows that precede their call remain orphans.
    """
    original = [_copy_message(message) for message in messages if isinstance(message, dict)]
    try:
        call_indices = _first_tool_call_indices(original)
        real_results = _first_real_tool_results(original, call_indices)
        repaired: list[dict[str, object]] = []
        seen_tool_call_ids: set[str] = set()

        for index, raw_message in enumerate(original):
            if _is_assistant_message(raw_message):
                repaired.extend(
                    _repaired_assistant_group(
                        raw_message,
                        index=index,
                        real_results=real_results,
                        seen_tool_call_ids=seen_tool_call_ids,
                    )
                )
                continue

            if _is_tool_message(raw_message):
                # Matching results were emitted atomically with their assistant
                # call.  Later duplicates and true orphans are intentionally
                # dropped; neither is a valid provider transcript row.
                continue

            repaired.append(_copy_message(raw_message))

        return [message for message in repaired if not _drop_empty_assistant(message)]
    except Exception as error:  # noqa: BLE001
        log_event(
            logger,
            logging.WARNING,
            component="ai.context.message_utils",
            event="ai.context.message_utils.repair_failed",
            message="Tool result pairing repair failed closed.",
            status="error",
            data={"error": str(error)},
        )
        return original


# Bounds for admitted tool_envelope values. History is untrusted input: an
# unbounded string here would ride a trusted-looking envelope line or silently
# dominate semantic-history byte admission.
_ENVELOPE_TEXT_LIMIT = 240
_ENVELOPE_JSON_LIMIT = 2000
_ENVELOPE_EFFECTS_VOCABULARY = frozenset({"none", "committed", "partial", "unknown"})


def admit_tool_envelope(envelope_value: Any) -> dict[str, object] | None:
    """Whitelist, bound, and shape-check a persisted tool_envelope object.

    THE single admission gate for the versioned envelope-field object — the
    history sanitizer and the pre-admission re-framer must both go through it
    so the two can never disagree about what a field is allowed to claim.
    Returns None for anything that is not a well-formed v1 object.
    """
    if not (
        isinstance(envelope_value, dict)
        and type(envelope_value.get("v")) is int
        and envelope_value.get("v") == 1
    ):
        return None
    envelope: dict[str, object] = {"v": 1}
    for key in (
        "failure_class",
        "effects",
        "precondition_id",
        "remediation",
        "failed_phase",
        "phase_timings_json",
        "trace_id",
        "idempotency_key",
    ):
        value = envelope_value.get(key)
        if not (isinstance(value, str) and value.strip()):
            continue
        limit = _ENVELOPE_JSON_LIMIT if key == "phase_timings_json" else _ENVELOPE_TEXT_LIMIT
        text = value.strip()[:limit]
        if key == "effects" and text not in _ENVELOPE_EFFECTS_VOCABULARY:
            continue
        envelope[key] = text
    elapsed_value = envelope_value.get("elapsed_ms")
    if type(elapsed_value) is int and elapsed_value >= 0:
        envelope["elapsed_ms"] = elapsed_value
    elif isinstance(elapsed_value, str):
        try:
            elapsed = Decimal(elapsed_value.strip())
            if elapsed.is_finite() and elapsed >= 0:
                envelope["elapsed_ms"] = int(elapsed)
        except (InvalidOperation, ValueError):
            pass
    return envelope


__all__ = [
    "SYNTHETIC_TOOL_RESULT_PLACEHOLDER",
    "admit_tool_envelope",
    "ensure_tool_result_pairing",
]
