"""Client integration tests for the MCP Streamable-HTTP (sse) transport.

Drives ``MCPClient.configure`` end-to-end against a fake in-process HTTP server
(the real ``SSEMCPTransport`` built via ``_build_transport``), with the SSRF
validator monkeypatched so the loopback fake server is reachable.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp import transport_sse
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.mcp.exceptions import CMP_MCP_SSE_DISABLED, MCPError
from sidecar.ai.tools.builtins.web_http import ValidatedUrl


class _FakeMcpServer:
    def __init__(self) -> None:
        self.initialized = False
        server = self

        class _Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0") or "0")
                raw = self.rfile.read(length) if length else b""
                payload = json.loads(raw.decode("utf-8")) if raw else {}
                method = payload.get("method")
                if method == "notifications/initialized":
                    server.initialized = True
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                result = server._result_for(method)
                obj = {"jsonrpc": "2.0", "id": payload.get("id"), "result": result}
                body = json.dumps(obj).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}/mcp"

    def _result_for(self, method: str | None) -> dict[str, Any]:
        if method == "initialize":
            return {"protocolVersion": "2025-03-26", "capabilities": {}}
        if method == "tools/list":
            return {"tools": [{"name": "lookup", "description": "look things up"}]}
        if method == "tools/call":
            return {"content": [{"type": "text", "text": "looked up"}]}
        if method in ("resources/list", "resources/templates/list"):
            return {"resources": [], "resourceTemplates": []}
        return {}

    def shutdown(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=2.0)


@pytest.fixture()
def server() -> Any:
    srv = _FakeMcpServer()
    yield srv
    srv.shutdown()


@pytest.fixture(autouse=True)
def allow_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        transport_sse,
        "validate_public_url",
        lambda url, *, allow_private=False: ValidatedUrl(url=url, pinned_ip="127.0.0.1"),
    )


def _sse_config(url: str) -> MCPServerConfig:
    return MCPServerConfig(name="remote", transport="sse", url=url)


def test_configure_sse_enabled_registers_namespaced_tools(server: Any) -> None:
    client = MCPClient()
    try:
        client.configure((_sse_config(server.url),), sse_enabled=True)
        descriptor = client.tool_descriptor("mcp__remote__lookup")
        assert descriptor is not None
        assert descriptor.server_name == "remote"
        assert "remote" in client.diagnostics().connected
    finally:
        client.close()


def test_configure_sse_disabled_records_disabled_failure(server: Any) -> None:
    client = MCPClient()
    try:
        # sse_enabled=False: _build_transport's sse branch raises SSE_DISABLED,
        # which configure() records as a setup failure (byte-identical to today).
        client.configure((_sse_config(server.url),), sse_enabled=False)
        assert client.tool_descriptor("mcp__remote__lookup") is None
        failures = client.diagnostics().failures
        assert any(f.code == CMP_MCP_SSE_DISABLED for f in failures)
    finally:
        client.close()


def test_configure_threads_allow_private_addresses_into_the_transport(
    monkeypatch: pytest.MonkeyPatch,
    server: Any,
) -> None:
    # The owner's tools_web_allow_private_addresses decision must reach the
    # per-server SSRF validation, and must default to the strict posture.
    seen: list[bool] = []

    monkeypatch.setattr(
        transport_sse,
        "validate_public_url",
        lambda url, *, allow_private=False: (
            seen.append(allow_private),
            ValidatedUrl(url=url, pinned_ip="127.0.0.1"),
        )[1],
    )

    client = MCPClient()
    try:
        client.configure((_sse_config(server.url),), sse_enabled=True)
        assert seen == [False]
        client.configure(
            (_sse_config(server.url),),
            sse_enabled=True,
            allow_private_addresses=True,
        )
        assert seen == [False, True]
    finally:
        client.close()
    # close() restores the strict default so a later configure() cannot inherit
    # a stale opt-in.
    assert client._allow_private_addresses is False


def test_build_transport_sse_disabled_still_raises_invariant() -> None:
    client = MCPClient()
    with pytest.raises(MCPError) as excinfo:
        client._build_transport(_sse_config("https://example.com/mcp"), sse_enabled=False)
    assert excinfo.value.code == CMP_MCP_SSE_DISABLED


def test_execute_tool_over_sse_returns_result(server: Any) -> None:
    client = MCPClient()
    try:
        client.configure((_sse_config(server.url),), sse_enabled=True)
        result = client.execute_tool("mcp__remote__lookup", {"query": "release"})
        assert result.output == "looked up"
        assert result.success is True
    finally:
        client.close()


def test_unreachable_sse_server_enters_cooldown_not_throw(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = MCPClient()
    # Point at a closed port; configure() records a failure (no throw).
    config = _sse_config("http://127.0.0.1:1/mcp")
    try:
        client.configure((config,), sse_enabled=True)
        assert client.tool_descriptor("mcp__remote__lookup") is None
        assert client.diagnostics().failures
    finally:
        client.close()


def test_resource_tools_only_register_when_resources_enabled(server: Any) -> None:
    client = MCPClient()
    try:
        client.configure(
            (_sse_config(server.url),),
            sse_enabled=True,
            resources_enabled=True,
        )
        # resources_enabled=True + a server that answers resources/list registers
        # the synthetic resource tools.
        assert client.tool_descriptor("mcp__remote__list_resources") is not None
    finally:
        client.close()

    client2 = MCPClient()
    try:
        client2.configure((_sse_config(server.url),), sse_enabled=True)
        assert client2.tool_descriptor("mcp__remote__list_resources") is None
    finally:
        client2.close()
