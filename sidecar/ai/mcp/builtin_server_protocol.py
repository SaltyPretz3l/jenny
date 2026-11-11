"""Builtin MCP server wire envelopes: JSON-RPC results, redacted errors, notifications."""

from __future__ import annotations

import json
import threading
import uuid
from typing import Any, Callable

from sidecar.ai.mcp.builtin_server_io import write_protocol_line
from sidecar.ai.tools.sanitization import PathKeeper, redact_error_paths, strip_surrogates

_MAX_ERROR_MESSAGE_CHARS = 500


def _safe_json_dumps(payload: object) -> str:
    return strip_surrogates(json.dumps(payload, ensure_ascii=False))


# W2-1: tool reader/flush-timer threads write live-output notifications to
# stdout while the dispatch thread eventually writes the call's response —
# every stdout write must hold this lock so lines never interleave.
_STDOUT_WRITE_LOCK = threading.Lock()
# Lockstep with transport_stdio_channel.OUTPUT_CHUNK_NOTIFICATION_METHOD.
OUTPUT_CHUNK_NOTIFICATION_METHOD = "tool/output_chunk"
TOOL_STARTED_NOTIFICATION_METHOD = "tool/started"
SERVER_GENERATION_ID = f"gen_{uuid.uuid4().hex}"


def _write_response(payload: dict[str, Any]) -> None:
    line = _safe_json_dumps(payload) + "\n"
    with _STDOUT_WRITE_LOCK:
        write_protocol_line(line)


def _make_output_chunk_writer(message_id: Any) -> Callable[[dict[str, object]], None]:
    """Notification writer for the in-flight call's live-output batches."""

    def _write(batch: dict[str, object]) -> None:
        _write_response(
            {
                "jsonrpc": "2.0",
                "method": OUTPUT_CHUNK_NOTIFICATION_METHOD,
                "params": {**batch, "request_id": message_id},
            }
        )

    return _write


def _write_tool_started(message_id: Any, operation_id: str) -> None:
    _write_response(
        {
            "jsonrpc": "2.0",
            "method": TOOL_STARTED_NOTIFICATION_METHOD,
            "params": {
                "request_id": message_id,
                "operation_id": operation_id,
                "generation_id": SERVER_GENERATION_ID,
            },
        }
    )


def _result_response(message_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "result": result,
    }


def _redact_error_message(message: str, *, keep: PathKeeper | None = None) -> str:
    redacted = redact_error_paths(str(message), keep=keep)
    if len(redacted) > _MAX_ERROR_MESSAGE_CHARS:
        return f"{redacted[:_MAX_ERROR_MESSAGE_CHARS]}\n...[truncated]"
    return redacted


def _error_response(  # noqa: PLR0913 - keyword-only response fields.
    message_id: Any,
    code: str,
    message: str,
    *,
    retryable: bool = False,
    metadata: dict[str, object] | None = None,
    keep_path: PathKeeper | None = None,
) -> dict[str, Any]:
    # HB-017: the model sees paths the call named or its workspace holds
    # (``keep_path``); every other absolute path stays ``<path>``.
    safe_message = _redact_error_message(message, keep=keep_path)
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "error": {
            "code": -32000,
            "message": safe_message,
            "data": {"code": code, "retryable": bool(retryable), **dict(metadata or {})},
        },
    }
