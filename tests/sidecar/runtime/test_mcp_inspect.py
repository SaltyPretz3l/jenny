from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import sidecar.runtime.request_dispatch_mcp as dispatch
from sidecar.ai.mcp import inspection
from sidecar.protocol import API_VERSION, MCP_INSPECT_METHOD
from sidecar.runtime.multiplexer import TurnCancellationHandle

SHA256_HEX_LENGTH = 64
REQUEST_ID = 41
INVALID_PARAMS_CODE = -32602
VERSION_MISMATCH_CODE = "CMP-PROTO-0001"


class _Transport:
    def __init__(self, tools: Any = None, error: Exception | None = None) -> None:
        self.tools = tools
        self.error = error
        self.closed = False

    def list_tools(self, *, cancel_handle: Any = None) -> Any:
        if cancel_handle is not None:
            cancel_handle.raise_if_cancelled()
        if self.error is not None:
            raise self.error
        return self.tools

    def close(self) -> None:
        self.closed = True


class _Client:
    last: "_Client | None" = None

    def __init__(self, **_: Any) -> None:
        self._allow_private_addresses = False
        self.transport = _Transport(
            [
                {"name": "weather", "description": "Forecast", "inputSchema": {"type": "object"}},
                {"description": "missing name"},
            ]
        )
        self.closed = False
        _Client.last = self

    def _build_transport(self, _config: Any, **_: Any) -> _Transport:
        return self.transport

    def close(self) -> None:
        self.closed = True


def _stdio_params(**overrides: Any) -> dict[str, Any]:
    return {
        "server": {"name": "weather", "transport": "stdio", "command": "weather-mcp", "args": []},
        "confirmed_stdio": True,
        **overrides,
    }


def test_stdio_requires_exact_launch_confirmation() -> None:
    result = inspection.inspect_server(_stdio_params(confirmed_stdio=False))
    assert result == {
        "ok": False,
        "failure": {"code": "CMP-MCP-0002", "reason": "stdio_confirmation_required"},
    }


def test_probe_returns_bounded_surface_and_closes_owned_resources(monkeypatch: Any) -> None:
    monkeypatch.setattr(inspection, "MCPClient", _Client)
    result = inspection.inspect_server(_stdio_params(), allow_private_addresses=True)
    assert result["ok"] is True
    assert result["identity"] == {"name": "weather"}
    assert result["transport"] == "stdio"
    assert result["tool_count"] == 1
    assert result["malformed_tool_count"] == 1
    assert result["tools"][0]["name"] == "weather"
    assert len(result["tools"][0]["schema_digest"]) == SHA256_HEX_LENGTH
    assert len(result["tools_digest"]) == SHA256_HEX_LENGTH
    assert _Client.last is not None
    assert _Client.last._allow_private_addresses is True
    assert _Client.last.transport.closed is True
    assert _Client.last.closed is True


def test_probe_failure_redacts_exception_text_and_still_closes(monkeypatch: Any) -> None:
    class FailingClient(_Client):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self.transport = _Transport(error=RuntimeError("bearer super-secret"))

    monkeypatch.setattr(inspection, "MCPClient", FailingClient)
    result = inspection.inspect_server(_stdio_params())
    assert result["ok"] is False
    assert result["failure"] == {"code": "CMP-MCP-0004", "reason": "RuntimeError"}
    assert "super-secret" not in str(result)
    assert FailingClient.last is not None
    assert FailingClient.last.transport.closed is True


def test_probe_rejects_unbounded_tool_schema_without_hashing_it(monkeypatch: Any) -> None:
    class OversizedSchemaClient(_Client):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self.transport = _Transport([
                {"name": "unsafe", "inputSchema": {"description": "x" * 5000}},
                {"name": "safe", "inputSchema": {"type": "object"}},
            ])

    monkeypatch.setattr(inspection, "MCPClient", OversizedSchemaClient)
    result = inspection.inspect_server(_stdio_params())
    assert result["ok"] is True
    assert result["tool_count"] == 1
    assert result["malformed_tool_count"] == 1
    assert result["tools"][0]["name"] == "safe"
    assert OversizedSchemaClient.last is not None
    assert OversizedSchemaClient.last.transport.closed is True


def test_cancelled_probe_returns_structured_failure_and_closes(monkeypatch: Any) -> None:
    monkeypatch.setattr(inspection, "MCPClient", _Client)
    handle = TurnCancellationHandle(request_id="inspect-1")
    handle.cancel(reason="sidecar_cancel")
    result = inspection.inspect_server(_stdio_params(), cancel_handle=handle)
    assert result["ok"] is False
    assert result["failure"] == {
        "code": "CMP-MCP-0004",
        "reason": "probe_cancelled",
        "retryable": True,
    }
    assert _Client.last is not None
    assert _Client.last.transport.closed is True
    assert _Client.last.closed is True


def test_unsupported_transport_fails_without_starting_a_probe(monkeypatch: Any) -> None:
    def fail_client(**_: Any) -> Any:
        raise AssertionError("client must not be constructed")

    monkeypatch.setattr(inspection, "MCPClient", fail_client)
    result = inspection.inspect_server({"server": {"name": "x", "transport": "websocket"}})
    assert result == {
        "ok": False,
        "failure": {"code": "CMP-MCP-0002", "reason": "transport_unsupported"},
    }


def test_dispatch_is_versioned_and_returns_no_notification(monkeypatch: Any) -> None:
    monkeypatch.setattr(dispatch, "inspect_server", lambda params, **kwargs: {
        "ok": True,
        "private": kwargs["allow_private_addresses"],
        "name": params["server"]["name"],
    })
    brain = SimpleNamespace(stack=SimpleNamespace(config=SimpleNamespace(
        tools_web_allow_private_addresses=True
    )))
    outcome = dispatch.process_mcp_method(
        MCP_INSPECT_METHOD,
        REQUEST_ID,
        {"accept_version": API_VERSION, "server": {"name": "weather"}},
        True,
        brain,
        None,
    )
    assert outcome is not None
    assert outcome.response is not None
    assert outcome.response["jsonrpc"] == "2.0"
    assert outcome.response["id"] == REQUEST_ID
    assert outcome.response["api_version"] == API_VERSION
    assert outcome.response["result"] == {"ok": True, "private": True, "name": "weather",
                                           "api_version": API_VERSION}
    assert outcome.notifications == []
    assert outcome.shutdown_requested is False

    mismatch = dispatch.process_mcp_method(
        MCP_INSPECT_METHOD,
        42,
        {"accept_version": "older", "server": {"name": "weather"}},
        True,
        brain,
        None,
    )
    assert mismatch is not None
    assert mismatch.response is not None
    assert mismatch.response["error"]["code"] == INVALID_PARAMS_CODE
    assert mismatch.response["error"]["data"]["code"] == VERSION_MISMATCH_CODE


def test_shutdown_cancels_registered_inspections() -> None:
    handle, created = dispatch.prepare_mcp_inspection(99)
    assert created is True
    try:
        assert dispatch.cancel_all_mcp_inspections() == 1
        assert handle.cancelled is True
    finally:
        dispatch.complete_mcp_inspection(99, handle)
