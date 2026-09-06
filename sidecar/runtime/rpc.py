"""JSON-RPC payload helpers shared by sidecar runtime modules."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sidecar.ai.error_codes import CMP_PROTO_INVALID_ENVELOPE
from sidecar.protocol import (
    ALLOWED_NOTIFICATION_METHODS,
    API_VERSION,
    INBOUND_VERSIONED_REQUEST_METHODS,
    JSONRPC_VERSION,
)
from sidecar.runtime.diagnostics import sanitize_diagnostic_text, sanitize_diagnostic_value

_INVALID_REQUEST_CODE = -32600
_MAX_JSONRPC_METHOD_CHARS = 128
_MAX_JSONRPC_ID_CHARS = 128
_MAX_SAFE_JSON_INTEGER = (2**53) - 1


class InvalidNotificationMethodError(ValueError):
    """Raised when a notification method is not in ALLOWED_NOTIFICATION_METHODS."""


@dataclass(frozen=True)
class JsonRpcEnvelope:
    """Validated inbound JSON-RPC shape passed to runtime routing."""

    kind: str
    payload: dict[str, Any]
    method: str | None
    message_id: str | int | None
    params: dict[str, Any]


class JsonRpcEnvelopeError(ValueError):
    """A fully-read JSON object that is not a legal Jenny JSON-RPC envelope."""

    def __init__(
        self,
        reason: str,
        *,
        response_id: str | int | None,
        should_respond: bool,
    ) -> None:
        super().__init__(f"invalid JSON-RPC envelope: {reason}")
        self.reason = reason
        self.response_id = response_id
        self.should_respond = should_respond

    def response(self) -> dict[str, Any]:
        return error_response(
            self.response_id,
            code=_INVALID_REQUEST_CODE,
            message="invalid JSON-RPC request",
            data={"code": CMP_PROTO_INVALID_ENVELOPE, "reason": self.reason},
        )


def _legal_jsonrpc_id(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) <= _MAX_SAFE_JSON_INTEGER
    if isinstance(value, str):
        return bool(value.strip()) and len(value) <= _MAX_JSONRPC_ID_CHARS
    return False


def _safe_response_id(message: dict[str, Any]) -> str | int | None:
    value = message.get("id")
    return value if _legal_jsonrpc_id(value) else None


def _invalid_jsonrpc_id_reason(value: Any) -> str:
    if isinstance(value, int) and not isinstance(value, bool):
        return "id_range"
    if isinstance(value, str):
        return "id_length"
    return "id_type"


def _envelope_error(message: dict[str, Any], reason: str) -> JsonRpcEnvelopeError:
    return JsonRpcEnvelopeError(
        reason,
        response_id=_safe_response_id(message),
        should_respond="id" in message,
    )


def validate_jsonrpc_envelope(message: Any) -> JsonRpcEnvelope:
    """Validate one fully-decoded inbound JSON-RPC object without coercion."""
    if not isinstance(message, dict):
        raise JsonRpcEnvelopeError(
            "object_type", response_id=None, should_respond=True
        )
    if message.get("jsonrpc") != JSONRPC_VERSION:
        raise _envelope_error(message, "jsonrpc_version")

    has_method = "method" in message
    has_result = "result" in message
    has_error = "error" in message
    if has_method:
        if has_result or has_error:
            raise _envelope_error(message, "request_shape")
        method = message.get("method")
        if not isinstance(method, str):
            raise _envelope_error(message, "method_type")
        if not method or method != method.strip() or len(method) > _MAX_JSONRPC_METHOD_CHARS:
            raise _envelope_error(message, "method_format")
        if "id" in message and not _legal_jsonrpc_id(message.get("id")):
            raw_id = message.get("id")
            raise _envelope_error(message, _invalid_jsonrpc_id_reason(raw_id))
        raw_params = message.get("params", {})
        if not isinstance(raw_params, dict):
            raise _envelope_error(message, "params_type")
        return JsonRpcEnvelope(
            kind="request",
            payload=message,
            method=method,
            message_id=message.get("id"),
            params=raw_params,
        )

    if has_result == has_error or "params" in message:
        raise _envelope_error(message, "response_shape")
    if "id" not in message or not _legal_jsonrpc_id(message.get("id")):
        value = message.get("id")
        raise _envelope_error(message, _invalid_jsonrpc_id_reason(value))
    if has_error and not isinstance(message.get("error"), dict):
        raise _envelope_error(message, "response_error_type")
    return JsonRpcEnvelope(
        kind="response",
        payload=message,
        method=None,
        message_id=message["id"],
        params={},
    )


def request_accept_version(params: Any) -> str | None:
    if not isinstance(params, dict):
        return None
    value = params.get("accept_version")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def error_response(
    message_id: Any,
    *,
    code: int,
    message: str,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    sanitized_data = sanitize_diagnostic_value(data or {})
    if not isinstance(sanitized_data, dict):
        sanitized_data = {}
    payload: dict[str, Any] = {
        "code": code,
        "message": sanitize_diagnostic_text(message, limit=512),
        "data": {**sanitized_data, "api_version": API_VERSION},
    }
    return {
        "jsonrpc": JSONRPC_VERSION,
        "id": message_id,
        "api_version": API_VERSION,
        "error": payload,
    }


def result_response(message_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    payload = {**result, "api_version": API_VERSION}
    return {
        "jsonrpc": JSONRPC_VERSION,
        "id": message_id,
        "api_version": API_VERSION,
        "result": payload,
    }


def notification(method: str, params: dict[str, Any]) -> dict[str, Any]:
    if method not in ALLOWED_NOTIFICATION_METHODS:
        raise InvalidNotificationMethodError(
            f"notification method {method!r} is not declared in "
            "sidecar.protocol.ALLOWED_NOTIFICATION_METHODS"
        )
    return {
        "jsonrpc": JSONRPC_VERSION,
        "api_version": API_VERSION,
        "method": method,
        "params": {**params, "api_version": API_VERSION},
    }


def version_error_response(
    message_id: Any,
    *,
    method: str,
    accept_version: str | None,
    invalid_params_code: int,
    version_mismatch_code: str,
) -> dict[str, Any]:
    return error_response(
        message_id,
        code=invalid_params_code,
        message=f"{method} requires compatible accept_version",
        data={
            "code": version_mismatch_code,
            "expected_version": API_VERSION,
            "accept_version": accept_version,
        },
    )


def validate_accept_version(
    *,
    method: str,
    message_id: Any,
    params: Any,
    invalid_params_code: int,
    version_mismatch_code: str,
) -> dict[str, Any] | None:
    accept_version = request_accept_version(params)
    if accept_version == API_VERSION:
        return None
    return version_error_response(
        message_id,
        method=method,
        accept_version=accept_version,
        invalid_params_code=invalid_params_code,
        version_mismatch_code=version_mismatch_code,
    )


def validate_method_version(
    *,
    method: str,
    message_id: Any,
    params: Any,
    invalid_params_code: int,
    version_mismatch_code: str,
) -> dict[str, Any] | None:
    """Apply the API handshake to every known shell -> sidecar request."""
    if method not in INBOUND_VERSIONED_REQUEST_METHODS:
        return None
    return validate_accept_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=invalid_params_code,
        version_mismatch_code=version_mismatch_code,
    )
