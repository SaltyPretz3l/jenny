"""Strict decoder for the fixed Jenny-owned plugin-host frame vocabulary."""

from __future__ import annotations

import json
from typing import Any

from sidecar.ai.error_codes import CMP_PLUGIN_HOST_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure

ALLOWED_KINDS = frozenset({"text", "thinking", "tool_call", "done", "error"})
MAX_FRAME_BYTES = 65_536
ALLOWED_FIELDS = frozenset(
    {"sequence", "kind", "text", "tool_id", "arguments", "call_id", "code"}
)


def validate_frame(frame: object, expected_sequence: int) -> dict[str, Any]:
    if not isinstance(frame, dict) or set(frame) - ALLOWED_FIELDS:
        raise ValueError("plugin_host_frame_invalid")
    sequence = frame.get("sequence")
    kind = frame.get("kind")
    if (
        not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence != expected_sequence
        or not isinstance(kind, str)
        or kind not in ALLOWED_KINDS
    ):
        raise ValueError("plugin_host_frame_invalid")
    if kind in {"text", "thinking"} and not isinstance(frame.get("text"), str):
        raise ValueError("plugin_host_frame_invalid")
    if kind == "tool_call" and (
        not isinstance(frame.get("tool_id"), str)
        or not isinstance(frame.get("arguments"), dict)
        or not isinstance(frame.get("call_id"), str)
    ):
        raise ValueError("plugin_host_frame_invalid")
    if len(json.dumps(frame, separators=(",", ":")).encode()) > MAX_FRAME_BYTES:
        raise ValueError("plugin_host_frame_too_large")
    return dict(frame)


def plugin_host_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_PLUGIN_HOST_FAILED,
        message=message,
        retryable=False,
    )


__all__ = ["ALLOWED_KINDS", "MAX_FRAME_BYTES", "plugin_host_failure", "validate_frame"]
