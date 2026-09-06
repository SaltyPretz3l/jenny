"""Blocking sidecar-to-Electron execution bridge for Electron-owned tools."""

from __future__ import annotations

import itertools
import logging
import math
import re
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.models import MCPToolResult
from sidecar.protocol import API_VERSION, JSONRPC_VERSION, TOOL_EXECUTE_ELECTRON_METHOD
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.multiplexer import (
    ApprovalResponseCancelledError,
    TurnCancellationHandle,
)

_ELECTRON_TOOL_REQUEST_IDS = itertools.count(10_000_000)
_LOGGER = logging.getLogger(__name__)
_MAX_METADATA_DEPTH = 6
_MAX_METADATA_ITEMS = 100
_MAX_METADATA_STRING_CHARS = 20_000
_WINDOWS_DRIVE_PREFIX_LENGTH = 2
_OMIT_METADATA_VALUE = object()
_SENSITIVE_METADATA_VALUE_RE = re.compile(
    r"\b(?:bearer\s+[a-z0-9._~+/=-]{12,}|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{20,})\b",
    re.IGNORECASE,
)


def _close_response_reader(response_reader: Callable[[float], dict[str, Any]]) -> None:
    close = getattr(response_reader, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 - cleanup must not mask tool outcome.
            pass


@contextmanager
def _closing_response_reader(
    response_reader: Callable[[float], dict[str, Any]],
):
    try:
        yield response_reader
    finally:
        _close_response_reader(response_reader)


_PATH_METADATA_KEYS = {
    "absolute_path",
    "absolutePath",
    "local_path",
    "localPath",
    "path",
    "full_path",
    "fullPath",
    "generatedArtifacts",
    "generated_artifacts",
}
def _is_safe_display_path(value: str) -> bool:
    normalized = str(value or "").strip().replace("\\", "/")
    if not normalized or "\x00" in normalized or ".." in normalized:
        return False
    if normalized.startswith("/") or normalized.startswith("//"):
        return False
    if len(normalized) >= _WINDOWS_DRIVE_PREFIX_LENGTH and normalized[1] == ":":
        return False
    head = normalized.split("/", 1)[0]
    return not head.endswith(":")


def _is_path_metadata_key(key: Any) -> bool:
    token = str(key)
    return token in _PATH_METADATA_KEYS or "path" in token.lower()


def _sanitize_metadata_string(value: Any) -> str:
    text = str(value)
    if _SENSITIVE_METADATA_VALUE_RE.search(text):
        return "[redacted]"
    if len(text) > _MAX_METADATA_STRING_CHARS:
        return text[:_MAX_METADATA_STRING_CHARS]
    return text


def _sanitize_artifact_text(value: Any) -> str:
    return _sanitize_metadata_string(value).strip()


def _sanitize_artifact_display_path(value: Any) -> str:
    text = str(value or "").strip()
    if _SENSITIVE_METADATA_VALUE_RE.search(text):
        return ""
    if len(text) > _MAX_METADATA_STRING_CHARS:
        return text[:_MAX_METADATA_STRING_CHARS]
    return text


def _normalize_artifact_dimension(value: Any) -> int:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0
    return math.floor(numeric) if math.isfinite(numeric) and numeric > 0 else 0


def _sanitize_metadata_scalar(value: Any) -> Any:
    if value is None:
        return value
    if isinstance(value, str):
        return _sanitize_metadata_string(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else _OMIT_METADATA_VALUE
    return _OMIT_METADATA_VALUE


def _sanitize_metadata_sequence(value: list[Any] | tuple[Any, ...], depth: int) -> list[Any]:
    output: list[Any] = []
    for item in value[:_MAX_METADATA_ITEMS]:
        cleaned = _sanitize_metadata_value(item, depth + 1)
        if cleaned is not _OMIT_METADATA_VALUE:
            output.append(cleaned)
    return output


def _sanitize_metadata_mapping(value: dict[Any, Any], depth: int) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for key, nested_value in itertools.islice(value.items(), _MAX_METADATA_ITEMS):
        if _is_path_metadata_key(key):
            continue
        cleaned = _sanitize_metadata_value(nested_value, depth + 1)
        if cleaned is not _OMIT_METADATA_VALUE:
            sanitized[str(key)] = cleaned
    return sanitized


@dataclass(frozen=True)
class ElectronToolBridgeRequest:
    tool_name: str
    arguments: dict[str, Any]
    request_id: str
    trace_id: str | None
    session_id: str | None
    tool_call_id: str
    write_message: Callable[[dict[str, Any]], None] | None
    read_message: Callable[[float], dict[str, Any]] | None
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None = None
    timeout_seconds: float | None = None
    logger: Any = None
    cancel_handle: TurnCancellationHandle | None = None
    plan_mode: bool = False
    read_only: bool = False
    plan_decision: str = ""
    plan_feedback: str = ""
    edited_plan: dict[str, Any] | None = None


def electron_tool_request_message(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": JSONRPC_VERSION,
        "api_version": API_VERSION,
        "id": next(_ELECTRON_TOOL_REQUEST_IDS),
        "method": TOOL_EXECUTE_ELECTRON_METHOD,
        "params": {**params, "api_version": API_VERSION},
    }


def _failure_result(*, fallback_tool_name: str, output: str) -> MCPToolResult:
    return MCPToolResult(
        tool_name=fallback_tool_name,
        output=output,
        success=False,
        error_code=CMP_TOOL_EXECUTION_FAILED,
        metadata={"result_kind": "electron_tool_bridge"},
    )


def _sanitize_generated_artifact(item: dict[str, Any]) -> dict[str, Any] | None:
    artifact_id = _sanitize_artifact_text(item.get("artifact_id"))
    artifact_kind = _sanitize_artifact_text(item.get("artifact_kind"))
    title = _sanitize_artifact_text(item.get("title"))
    file_name = _sanitize_artifact_text(item.get("file_name"))
    display_path = _sanitize_artifact_display_path(item.get("display_path"))
    if not artifact_id or not title or not file_name or not display_path:
        return None
    if not _is_safe_display_path(display_path):
        return None
    sanitized = {
        "artifact_id": artifact_id,
        "title": title,
        "file_name": file_name,
        "display_path": display_path,
        "artifact_kind": artifact_kind,
        "language": _sanitize_artifact_text(item.get("language")),
        "mime_type": _sanitize_artifact_text(item.get("mime_type")),
        "width": _normalize_artifact_dimension(item.get("width")),
        "height": _normalize_artifact_dimension(item.get("height")),
        "editable": False if artifact_kind == "image" else item.get("editable") is True,
        "status": _sanitize_artifact_text(item.get("status") or "available") or "available",
    }
    return sanitized


def _sanitize_metadata_value(value: Any, depth: int = 0) -> Any:
    scalar = _sanitize_metadata_scalar(value)
    if scalar is not _OMIT_METADATA_VALUE:
        return scalar
    if depth >= _MAX_METADATA_DEPTH:
        return "[truncated]"
    if isinstance(value, list | tuple):
        return _sanitize_metadata_sequence(value, depth)
    if isinstance(value, dict):
        return _sanitize_metadata_mapping(value, depth)
    return _OMIT_METADATA_VALUE


def _sanitize_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    sanitized: dict[str, Any] = {}
    for key, raw_value in itertools.islice(value.items(), _MAX_METADATA_ITEMS):
        if _is_path_metadata_key(key):
            continue
        cleaned = _sanitize_metadata_value(raw_value)
        if cleaned is not _OMIT_METADATA_VALUE:
            sanitized[str(key)] = cleaned
    return sanitized


def _normalize_result_payload(payload: Any, *, fallback_tool_name: str) -> MCPToolResult:
    if not isinstance(payload, dict):
        return _failure_result(
            fallback_tool_name=fallback_tool_name,
            output="Electron tool bridge returned a malformed result.",
        )
    result = payload
    raw_success = result.get("success")
    if not isinstance(raw_success, bool):
        return _failure_result(
            fallback_tool_name=fallback_tool_name,
            output="Electron tool bridge result omitted a valid success flag.",
        )
    raw_generated_artifacts = result.get("generated_artifacts")
    generated_artifacts = (
        tuple(
            sanitized
            for item in raw_generated_artifacts
            if isinstance(item, dict)
            for sanitized in [_sanitize_generated_artifact(item)]
            if sanitized is not None
        )
        if isinstance(raw_generated_artifacts, list)
        else ()
    )
    raw_metadata = result.get("metadata")
    metadata = _sanitize_metadata(raw_metadata)
    raw_error_code = result.get("error_code")
    error_code = (
        str(raw_error_code).strip()
        if isinstance(raw_error_code, str) and str(raw_error_code).strip()
        else None
    )
    content_type = str(result.get("content_type") or "text").strip() or "text"
    if content_type not in {"text", "mcp_ui"}:
        content_type = "text"
    ui_payload = result.get("ui_payload")
    if not isinstance(ui_payload, dict):
        ui_payload = None
    return MCPToolResult(
        tool_name=str(result.get("tool_name") or fallback_tool_name).strip()
        or fallback_tool_name,
        output=str(result.get("output") or ""),
        success=raw_success,
        content_type=content_type,
        ui_payload=ui_payload,
        generated_artifacts=generated_artifacts,
        error_code=error_code,
        metadata=metadata,
    )


def execute_electron_tool(request: ElectronToolBridgeRequest) -> MCPToolResult:
    event_logger = request.logger if hasattr(request.logger, "log") else _LOGGER
    write_message = request.write_message
    read_message = request.read_message
    response_reader_factory = request.response_reader_factory
    if not callable(write_message) or not (
        callable(response_reader_factory) or callable(read_message)
    ):
        raise MCPError(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="Electron tool bridge is unavailable in this runtime.",
            retryable=False,
        )
    request_message = electron_tool_request_message(
        {
            "request_id": request.request_id,
            "trace_id": request.trace_id,
            "session_id": request.session_id,
            "tool_call_id": request.tool_call_id,
            "tool_name": request.tool_name,
            "arguments": dict(request.arguments),
            "plan_mode": request.plan_mode,
            "read_only": request.read_only,
            "plan_decision": request.plan_decision,
            "plan_feedback": request.plan_feedback[:800],
            **({"edited_plan": request.edited_plan} if request.edited_plan is not None else {}),
        }
    )
    expected_id = int(request_message["id"])
    log_event(
        event_logger,
        20,
        component="runtime.electron_tool_bridge",
        event="sidecar.runtime.electron_tool.requested",
        message="Waiting for Electron tool bridge response",
        status="start",
        request_id=request.request_id,
        trace_id=request.trace_id,
        session_id=request.session_id,
        data={"tool_name": request.tool_name, "tool_call_id": request.tool_call_id},
    )
    if callable(response_reader_factory):
        response_reader = response_reader_factory(
            expected_id,
            cancel_handle=request.cancel_handle,
        )
    elif callable(read_message):
        response_reader = read_message
    else:  # pragma: no cover - guarded above; preserves type narrowing.
        raise MCPError(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="Electron tool bridge is unavailable in this runtime.",
            retryable=False,
        )

    with _closing_response_reader(response_reader):
        write_message(request_message)
        timeout = (
            30.0
            if request.timeout_seconds is None
            else max(float(request.timeout_seconds), 0.1)
        )
        deadline = time.monotonic() + timeout
        while True:
            if request.cancel_handle is not None and request.cancel_handle.cancelled:
                raise MCPError(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="Electron tool bridge request was cancelled.",
                    retryable=True,
                )
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                raise MCPError(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="Electron tool bridge response timed out.",
                    retryable=True,
                )
            try:
                response = response_reader(remaining_seconds)
            except TimeoutError as error:
                raise MCPError(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="Electron tool bridge response timed out.",
                    retryable=True,
                ) from error
            except ApprovalResponseCancelledError as error:
                raise MCPError(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="Electron tool bridge request was cancelled.",
                    retryable=True,
                ) from error
            if not isinstance(response, dict):
                raise MCPError(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="Electron tool bridge returned a malformed response.",
                    retryable=False,
                )
            if response.get("id") != expected_id:
                continue
            if isinstance(response.get("error"), dict):
                error_payload = response["error"]
                data = error_payload.get("data")
                data = data if isinstance(data, dict) else {}
                raise MCPError(
                    code=str(data.get("code") or CMP_TOOL_EXECUTION_FAILED),
                    message=str(error_payload.get("message") or "Electron tool bridge failed."),
                    retryable=data.get("retryable") is not False,
                )
            result = _normalize_result_payload(
                response.get("result"),
                fallback_tool_name=request.tool_name,
            )
            log_event(
                event_logger,
                20 if result.success else 30,
                component="runtime.electron_tool_bridge",
                event="sidecar.runtime.electron_tool.resolved",
                message="Electron tool bridge response received",
                status="success" if result.success else "failure",
                request_id=request.request_id,
                trace_id=request.trace_id,
                session_id=request.session_id,
                data={
                    "tool_name": result.tool_name,
                    "tool_call_id": request.tool_call_id,
                    "error_code": result.error_code,
                },
            )
            return result
