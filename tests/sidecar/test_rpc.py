"""Tests for sidecar.runtime.rpc — JSON-RPC payload helpers."""

from __future__ import annotations

import pytest

from sidecar.protocol import API_VERSION, INBOUND_VERSIONED_REQUEST_METHODS, JSONRPC_VERSION
from sidecar.runtime.rpc import (
    JsonRpcEnvelopeError,
    error_response,
    notification,
    request_accept_version,
    result_response,
    validate_accept_version,
    validate_jsonrpc_envelope,
    validate_method_version,
    version_error_response,
)

# ── request_accept_version ──


def test_accept_version_returns_value_when_present() -> None:
    assert request_accept_version({"accept_version": "2026-03-06"}) == "2026-03-06"


def test_accept_version_strips_whitespace() -> None:
    assert request_accept_version({"accept_version": "  v1  "}) == "v1"


def test_accept_version_returns_none_for_missing_key() -> None:
    assert request_accept_version({}) is None


def test_accept_version_returns_none_for_empty_string() -> None:
    assert request_accept_version({"accept_version": "   "}) is None


def test_accept_version_returns_none_for_non_dict() -> None:
    assert request_accept_version("not a dict") is None
    assert request_accept_version(None) is None
    assert request_accept_version(42) is None


# ── error_response ──


def test_error_response_structure() -> None:
    resp = error_response(1, code=-32600, message="invalid request")
    assert resp["jsonrpc"] == JSONRPC_VERSION
    assert resp["id"] == 1
    assert resp["api_version"] == API_VERSION
    assert resp["error"]["code"] == -32600
    assert resp["error"]["message"] == "invalid request"
    assert resp["error"]["data"]["api_version"] == API_VERSION


def test_error_response_with_extra_data() -> None:
    resp = error_response(2, code=-32000, message="fail", data={"detail": "boom"})
    assert resp["error"]["data"]["detail"] == "boom"
    assert resp["error"]["data"]["api_version"] == API_VERSION


def test_error_response_with_none_id() -> None:
    resp = error_response(None, code=-32600, message="bad")
    assert resp["id"] is None


# ── result_response ──


def test_result_response_structure() -> None:
    resp = result_response(5, {"status": "ok"})
    assert resp["jsonrpc"] == JSONRPC_VERSION
    assert resp["id"] == 5
    assert resp["api_version"] == API_VERSION
    assert resp["result"]["status"] == "ok"
    assert resp["result"]["api_version"] == API_VERSION


def test_result_response_preserves_all_fields() -> None:
    resp = result_response(6, {"a": 1, "b": [2, 3]})
    assert resp["result"]["a"] == 1
    assert resp["result"]["b"] == [2, 3]


# ── notification ──


def test_notification_structure() -> None:
    msg = notification("chat.token", {"token": "hello"})
    assert msg["jsonrpc"] == JSONRPC_VERSION
    assert msg["api_version"] == API_VERSION
    assert msg["method"] == "chat.token"
    assert msg["params"]["token"] == "hello"
    assert msg["params"]["api_version"] == API_VERSION
    assert "id" not in msg


# ── version_error_response ──


def test_version_error_response_structure() -> None:
    resp = version_error_response(
        10,
        method="chat.send",
        accept_version="old",
        invalid_params_code=-32602,
        version_mismatch_code="CMP-PROTO-0001",
    )
    assert resp["error"]["code"] == -32602
    assert "accept_version" in resp["error"]["message"] or "compatible" in resp["error"]["message"]
    assert resp["error"]["data"]["code"] == "CMP-PROTO-0001"
    assert resp["error"]["data"]["expected_version"] == API_VERSION
    assert resp["error"]["data"]["accept_version"] == "old"


# ── validate_accept_version ──


def test_validate_accept_version_returns_none_when_matching() -> None:
    result = validate_accept_version(
        method="initialize",
        message_id=1,
        params={"accept_version": API_VERSION},
        invalid_params_code=-32602,
        version_mismatch_code="CMP-PROTO-0001",
    )
    assert result is None


def test_validate_accept_version_returns_error_when_mismatched() -> None:
    result = validate_accept_version(
        method="initialize",
        message_id=1,
        params={"accept_version": "wrong"},
        invalid_params_code=-32602,
        version_mismatch_code="CMP-PROTO-0001",
    )
    assert result is not None
    assert result["error"]["code"] == -32602


def test_validate_accept_version_returns_error_when_missing() -> None:
    result = validate_accept_version(
        method="initialize",
        message_id=1,
        params={},
        invalid_params_code=-32602,
        version_mismatch_code="CMP-PROTO-0001",
    )
    assert result is not None


# -- canonical inbound envelope --


def test_validate_jsonrpc_envelope_accepts_request_and_response() -> None:
    request = validate_jsonrpc_envelope(
        {
            "jsonrpc": JSONRPC_VERSION,
            "id": "request-1",
            "method": "initialize",
            "params": {"accept_version": API_VERSION},
        }
    )
    response = validate_jsonrpc_envelope(
        {
            "jsonrpc": JSONRPC_VERSION,
            "id": 42,
            "result": {"approved": True},
        }
    )

    assert request.kind == "request"
    assert request.method == "initialize"
    assert request.message_id == "request-1"
    assert response.kind == "response"
    assert response.message_id == 42


@pytest.mark.parametrize(
    ("message", "reason"),
    [
        ({"id": 1, "method": "initialize", "params": {}}, "jsonrpc_version"),
        (
            {"jsonrpc": "1.0", "id": 1, "method": "initialize", "params": {}},
            "jsonrpc_version",
        ),
        ({"jsonrpc": "2.0", "id": 1, "method": 7, "params": {}}, "method_type"),
        (
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": []},
            "params_type",
        ),
        (
            {"jsonrpc": "2.0", "id": True, "method": "initialize", "params": {}},
            "id_type",
        ),
        (
            {"jsonrpc": "2.0", "id": 1.5, "method": "initialize", "params": {}},
            "id_type",
        ),
        (
            {
                "jsonrpc": "2.0",
                "id": (2**53),
                "method": "initialize",
                "params": {},
            },
            "id_range",
        ),
        (
            {"jsonrpc": "2.0", "id": "x" * 129, "method": "initialize", "params": {}},
            "id_length",
        ),
        (
            {"jsonrpc": "2.0", "id": 1, "result": {}, "error": {}},
            "response_shape",
        ),
        (
            {"jsonrpc": "2.0", "id": 1, "result": {}, "params": {}},
            "response_shape",
        ),
    ],
)
def test_validate_jsonrpc_envelope_rejects_malformed_shapes(
    message: dict[str, object], reason: str
) -> None:
    with pytest.raises(JsonRpcEnvelopeError) as excinfo:
        validate_jsonrpc_envelope(message)

    assert excinfo.value.reason == reason


def test_validate_method_version_covers_every_known_request_method() -> None:
    for method in INBOUND_VERSIONED_REQUEST_METHODS:
        mismatch = validate_method_version(
            method=method,
            message_id=7,
            params={"accept_version": "old"},
            invalid_params_code=-32602,
            version_mismatch_code="CMP-PROTO-0001",
        )
        assert mismatch is not None
        assert mismatch["error"]["data"]["code"] == "CMP-PROTO-0001"

    unknown = validate_method_version(
        method="unknown.method",
        message_id=8,
        params={},
        invalid_params_code=-32602,
        version_mismatch_code="CMP-PROTO-0001",
    )

    assert unknown is None
