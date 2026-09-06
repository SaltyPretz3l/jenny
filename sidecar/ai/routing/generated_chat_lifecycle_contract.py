"""Generated Chat Lifecycle v2 contract. Do not edit by hand."""

# ruff: noqa: E501, C901, PLR0911, PLR0912

from __future__ import annotations

import json
import math
import re
from typing import Any, Callable, Mapping

SPEC = json.loads('{"contract_version":1,"identifier":{"pattern":"^[A-Za-z0-9][A-Za-z0-9._:@/-]*$","max_utf8_bytes":128},"structure":{"max_depth":12,"max_nodes":2048,"max_object_keys":128,"max_array_items":128,"max_diagnostic_path_utf8_bytes":240,"max_payload_utf8_bytes":32768},"chat_start":{"max_payload_utf8_bytes":9437184,"max_attachments":64,"max_mentions":128,"allowed_fields":["sessionId","prompt","visiblePrompt","traceId","preferredModel","reasoningEffort","attachments","interactiveResponse","interactiveRoundCount","planMode","contextPreferences","activeFileContext","mentionContents","toolPreferences","approvalMode","debugOptions","clientTiming","pluginCommandInvocation","skillInvocation","editedMessageId","failureRetry"],"identifier_fields":["sessionId","traceId","editedMessageId"],"string_fields":["prompt","visiblePrompt","preferredModel","reasoningEffort","approvalMode"],"object_fields":["interactiveResponse","contextPreferences","activeFileContext","toolPreferences","debugOptions","clientTiming","pluginCommandInvocation","skillInvocation"],"array_fields":["attachments","mentionContents"]},"terminal":{"statuses":["streaming","complete","error","cancelled","denied","timeout","preempted","interrupted","unknown"],"terminal_statuses":["complete","error","cancelled","denied","timeout","preempted","interrupted"],"aliases":{"completed":"complete","done":"complete","success":"complete","succeeded":"complete","canceled":"cancelled","aborted":"cancelled","runtime_error":"error","errored":"error","failed":"error","failure":"error"}}}')
IDENTIFIER_PATTERN = re.compile(str(SPEC["identifier"]["pattern"]))
TERMINAL_STATUSES = frozenset(SPEC["terminal"]["terminal_statuses"])


def utf8_bytes(value: Any) -> int:
    return len(str(value).encode("utf-8"))


def truncate_utf8(value: Any, max_bytes: int) -> str:
    remaining = max(int(max_bytes), 0)
    result: list[str] = []
    for code_point in str(value or ""):
        size = len(code_point.encode("utf-8"))
        if size > remaining:
            break
        result.append(code_point)
        remaining -= size
    return "".join(result)


def normalize_identifier(value: Any, *, allow_empty: bool = False) -> tuple[bool, str, str | None]:
    if not isinstance(value, str):
        return False, "", "identifier_not_string"
    normalized = value.strip()
    if not normalized:
        return (True, "", None) if allow_empty else (False, "", "identifier_empty")
    if utf8_bytes(normalized) > int(SPEC["identifier"]["max_utf8_bytes"]):
        return False, "", "identifier_too_large"
    if IDENTIFIER_PATTERN.fullmatch(normalized) is None:
        return False, "", "identifier_invalid_grammar"
    return True, normalized, None


def sanitize_structure(
    value: Any,
    *,
    sanitize_string: Callable[[str], str] = str,
    redact_key: Callable[[str], str | None] = lambda _key: None,
) -> tuple[Any, str | None]:
    seen: set[int] = set()
    nodes = 0
    failure_reason: str | None = None
    budgets = SPEC["structure"]

    def visit(item: Any, depth: int, key: str = "") -> Any:
        nonlocal nodes, failure_reason
        nodes += 1
        if nodes > int(budgets["max_nodes"]):
            failure_reason = "node_budget_exceeded"
            return None
        if depth > int(budgets["max_depth"]):
            failure_reason = "depth_budget_exceeded"
            return None
        redacted = redact_key(key)
        if redacted is not None:
            return redacted
        if isinstance(item, str):
            return sanitize_string(item)
        if item is None or isinstance(item, bool):
            return item
        if isinstance(item, (int, float)):
            return item if not isinstance(item, float) or math.isfinite(item) else None
        if not isinstance(item, (Mapping, list, tuple)):
            return None
        identity = id(item)
        if identity in seen:
            failure_reason = "cycle_detected"
            return None
        seen.add(identity)
        if isinstance(item, (list, tuple)):
            if len(item) > int(budgets["max_array_items"]):
                failure_reason = "array_budget_exceeded"
                seen.discard(identity)
                return None
            list_result = [visit(entry, depth + 1) for entry in item]
            seen.discard(identity)
            return list_result
        if len(item) > int(budgets["max_object_keys"]):
            failure_reason = "key_budget_exceeded"
            seen.discard(identity)
            return None
        object_result: dict[str, Any] = {}
        for raw_key, item_value in item.items():
            if not isinstance(raw_key, str):
                continue
            normalized_key = truncate_utf8(" ".join(raw_key.split()), 80)
            if not normalized_key or normalized_key in object_result:
                continue
            object_result[normalized_key] = visit(item_value, depth + 1, raw_key)
            if failure_reason is not None:
                break
        seen.discard(identity)
        return object_result

    sanitized = visit(value, 0)
    if failure_reason is not None:
        return {"truncated": True, "summary": "[truncated:structure]"}, failure_reason
    encoded = json.dumps(
        sanitized, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    if len(encoded) > int(budgets["max_payload_utf8_bytes"]):
        return {"truncated": True, "summary": "[truncated:event-payload]"}, "payload_byte_budget_exceeded"
    return sanitized, None


def normalize_terminal_status(raw: Any) -> str:
    if raw is None or raw == "":
        return ""
    if not isinstance(raw, str):
        return "unknown"
    normalized = re.sub(r"[\s.-]+", "_", raw.strip().lower())
    if not normalized:
        return ""
    if normalized in SPEC["terminal"]["statuses"]:
        return normalized
    return str(SPEC["terminal"]["aliases"].get(normalized, "unknown"))
