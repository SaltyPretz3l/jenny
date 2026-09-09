"""Authenticated, bounded wire protocol for the command worker."""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import math
import re
from typing import Any

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 128 * 1024
MAX_RESPONSE_BYTES = 3 * 1024 * 1024
MAX_COMMAND_BYTES = 16 * 1024
MAX_CWD_BYTES = 1024
MAX_CWD_DEPTH = 32
MAX_REASON_BYTES = 1024
CONTROLLER_KEY_BYTES = 32
MAC_HEX_BYTES = 64
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
ERROR_RE = re.compile(r"^[a-z_]{1,80}$")
MAX_TIMEOUT_SECONDS = 120.0
MIN_TIMEOUT_SECONDS = 0.1


class ProtocolError(ValueError):
    """A malformed or unauthenticated protocol message."""


def _uuid(value: Any, field: str) -> str:
    if not isinstance(value, str) or not UUID_RE.fullmatch(value):
        raise ProtocolError(f"{field}_invalid")
    return value


def _bounded_text(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str) or len(value.encode("utf-8")) > limit or "\x00" in value:
        raise ProtocolError(f"{field}_invalid")
    return value


def _cwd(value: Any) -> str:
    value = _bounded_text(value, "cwd", MAX_CWD_BYTES)
    if not value or value.startswith("/") or "\\" in value:
        raise ProtocolError("cwd_relative_required")
    # The worker treats cwd as a path below /workspace.  Reject both POSIX and
    # Windows spellings; accepting a backslash here would be surprising once
    # a future wrapper normalizes paths.
    parts = value.replace("\\", "/").split("/")
    if len(parts) > MAX_CWD_DEPTH or (
        value != "." and any(part in ("", ".", "..") for part in parts)
    ):
        raise ProtocolError("cwd_relative_required")
    if ":" in parts[0]:
        raise ProtocolError("cwd_relative_required")
    return value


def validate_request(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ProtocolError("request_object_required")
    if (
        type(request.get("schema_version")) is not int
        or request.get("schema_version") != PROTOCOL_VERSION
    ):
        raise ProtocolError("unsupported_schema_version")
    operation = request.get("operation")
    if operation not in {"status", "submit", "cancel"}:
        raise ProtocolError("unknown_operation")
    _uuid(request.get("request_id"), "request_id")
    required = {"schema_version", "request_id", "operation"}
    if operation == "status":
        expected = required
    elif operation == "submit":
        expected = required | {"incarnation", "job_id", "command", "cwd", "timeout_seconds"}
    else:
        expected = required | {"incarnation", "job_id"}
    if set(request) != expected:
        raise ProtocolError("request_keys_not_exact")
    if operation in {"submit", "cancel"}:
        _uuid(request["incarnation"], "incarnation")
        _uuid(request["job_id"], "job_id")
    if operation == "submit":
        if not _bounded_text(request["command"], "command", MAX_COMMAND_BYTES).strip():
            raise ProtocolError("command_invalid")
        _cwd(request["cwd"])
        timeout = request["timeout_seconds"]
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise ProtocolError("timeout_invalid")
        if (
            not math.isfinite(timeout)
            or timeout < MIN_TIMEOUT_SECONDS
            or timeout > MAX_TIMEOUT_SECONDS
        ):
            raise ProtocolError("timeout_out_of_range")
    return dict(request)


def _json_bytes(value: Any, limit: int) -> bytes:
    try:
        encoded = json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ProtocolError("json_encode_failed") from exc
    if len(encoded) > limit:
        raise ProtocolError("message_too_large")
    return encoded


def encode_envelope(payload: dict[str, Any], key: bytes, *, response: bool = False) -> bytes:
    if not isinstance(key, bytes) or len(key) != CONTROLLER_KEY_BYTES:
        raise ProtocolError("controller_key_invalid")
    payload_b64 = base64.b64encode(
        _json_bytes(payload, MAX_RESPONSE_BYTES if response else MAX_REQUEST_BYTES)
    ).decode("ascii")
    mac = hmac.new(key, payload_b64.encode("ascii"), "sha256").hexdigest()
    envelope = _json_bytes(
        {"mac": mac, "payload": payload_b64}, MAX_RESPONSE_BYTES if response else MAX_REQUEST_BYTES
    )
    return envelope + b"\n"


def decode_envelope(data: bytes, key: bytes, *, response: bool = False) -> dict[str, Any]:
    if not isinstance(data, bytes) or len(data) > (
        MAX_RESPONSE_BYTES if response else MAX_REQUEST_BYTES
    ):
        raise ProtocolError("envelope_too_large")
    if data.endswith(b"\n"):
        data = data[:-1]
    try:
        envelope = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("envelope_json_invalid") from exc
    if not isinstance(envelope, dict) or set(envelope) != {"payload", "mac"}:
        raise ProtocolError("envelope_keys_not_exact")
    payload_b64, mac = envelope["payload"], envelope["mac"]
    if not isinstance(payload_b64, str) or not isinstance(mac, str) or len(mac) != MAC_HEX_BYTES:
        raise ProtocolError("envelope_fields_invalid")
    try:
        base64.b64decode(payload_b64.encode("ascii"), validate=True)
        expected = hmac.new(key, payload_b64.encode("ascii"), "sha256").hexdigest()
    except (UnicodeEncodeError, binascii.Error) as exc:
        raise ProtocolError("payload_encoding_invalid") from exc
    if not hmac.compare_digest(mac, expected):
        raise ProtocolError("message_auth_invalid")
    try:
        payload = json.loads(base64.b64decode(payload_b64).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, binascii.Error) as exc:
        raise ProtocolError("payload_json_invalid") from exc
    return validate_request(payload) if not response else payload


def response(request_id: str, *, ok: bool, **fields: Any) -> dict[str, Any]:
    """Build the exact common response envelope payload."""
    result = {"schema_version": PROTOCOL_VERSION, "request_id": request_id, "ok": bool(ok)}
    result.update(fields)
    if ok and "error" in result:
        raise ProtocolError("success_with_error")
    if not ok:
        reason = result.get("error")
        if (
            not isinstance(reason, str)
            or len(reason.encode("utf-8")) > MAX_REASON_BYTES
            or not ERROR_RE.fullmatch(reason)
        ):
            raise ProtocolError("error_code_invalid")
    return result
