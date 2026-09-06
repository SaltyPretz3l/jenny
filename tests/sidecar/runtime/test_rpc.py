from __future__ import annotations

import pytest

from sidecar import protocol
from sidecar.protocol import ALLOWED_NOTIFICATION_METHODS, API_VERSION, JSONRPC_VERSION
from sidecar.runtime.rpc import InvalidNotificationMethodError, error_response, notification


def test_notification_accepts_every_declared_method() -> None:
    for method in ALLOWED_NOTIFICATION_METHODS:
        envelope = notification(method, {})
        assert envelope["method"] == method
        assert envelope["jsonrpc"] == JSONRPC_VERSION
        assert envelope["api_version"] == API_VERSION
        assert envelope["params"]["api_version"] == API_VERSION


def test_notification_rejects_unknown_method() -> None:
    with pytest.raises(InvalidNotificationMethodError) as excinfo:
        notification("not.a.real.method", {})
    assert "not.a.real.method" in str(excinfo.value)


def test_notification_rejects_request_methods() -> None:
    # Request/response methods must never be emitted as notifications.
    for method in (
        protocol.INITIALIZE_METHOD,
        protocol.CHAT_SEND_METHOD,
        protocol.CHAT_CANCEL_METHOD,
        protocol.HARNESS_INSPECT_METHOD,
    ):
        with pytest.raises(InvalidNotificationMethodError):
            notification(method, {})


def test_every_method_constant_is_classified() -> None:
    # Drift guard: every `*_METHOD` constant must be classified as a sidecar
    # notification, request, or inbound-only shell notification.
    inbound_notification_methods = {
        protocol.ENGINE_ACTIVITY_METHOD,
        protocol.SESSION_RUN_MODE_UPDATED_METHOD,
    }
    known_request_methods = set(protocol.INBOUND_VERSIONED_REQUEST_METHODS) | {
        # Sidecar -> Electron blocking request; it is deliberately not part of
        # the shell -> sidecar versioned request set.
        protocol.TOOL_EXECUTE_ELECTRON_METHOD,
    }
    declared_values = {
        value
        for name, value in vars(protocol).items()
        if name.endswith("_METHOD") and isinstance(value, str)
    }
    unclassified = (
        declared_values
        - set(ALLOWED_NOTIFICATION_METHODS)
        - known_request_methods
        - inbound_notification_methods
    )
    assert not unclassified, f"unclassified *_METHOD constants: {sorted(unclassified)}"
    # No phantom allow-listed strings: every entry in the frozenset is a real constant.
    assert set(ALLOWED_NOTIFICATION_METHODS) <= declared_values


def test_notification_params_preserves_caller_fields() -> None:
    envelope = notification(protocol.CHAT_TOKEN_METHOD, {"stream_id": "s1", "text": "hi"})
    assert envelope["params"]["stream_id"] == "s1"
    assert envelope["params"]["text"] == "hi"
    assert envelope["params"]["api_version"] == API_VERSION


def test_error_response_redacts_terminal_message_and_data() -> None:
    envelope = error_response(
        42,
        code=-32000,
        message="models.unload failed with api_key=secret-value",
        data={
            "detail": "provider said bearer hidden-token",
            "headers": {"authorization": "Bearer nested-token"},
        },
    )

    error = envelope["error"]
    raw = str(error)
    assert error["message"] == "models.unload failed with api_key=[redacted]"
    assert "secret-value" not in raw
    assert "hidden-token" not in raw
    assert "nested-token" not in raw
    assert error["data"]["headers"]["authorization"] == "[redacted]"
    assert error["data"]["api_version"] == API_VERSION
