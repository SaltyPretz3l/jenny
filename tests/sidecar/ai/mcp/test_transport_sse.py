"""Red-first tests for the real SSEMCPTransport (MCP Streamable-HTTP)."""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from sidecar.ai.config import MCPServerAuth, MCPServerConfig
from sidecar.ai.error_codes import (
    CMP_MCP_CONFIG_INVALID,
    CMP_MCP_PROTOCOL_FAILED,
    CMP_MCP_SERVER_FAILED,
)
from sidecar.ai.mcp import transport_sse
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.transport_sse import SSEMCPTransport

_TOKEN = "test-bearer-token-abc123"
_SESSION_ID = "sess-xyz-1"


class _FakeMcpServer:
    """A minimal MCP Streamable-HTTP server for driving the transport.

    Answers ``initialize`` (echoing an ``Mcp-Session-Id`` header), records the
    ``notifications/initialized`` notification, and dispatches the five RPC
    methods. ``sse_mode`` toggles whether replies come back as a single JSON
    document or a ``text/event-stream``. Rejects any non-initialize RPC that
    arrives before ``initialize`` (records ``rpc_before_initialize``).
    """

    def __init__(self, *, sse_mode: bool = False, hang_on_initialize: bool = False) -> None:
        self.sse_mode = sse_mode
        self.hang_on_initialize = hang_on_initialize
        self.events: list[str] = []
        self.auth_headers: list[str | None] = []
        self.session_headers: list[str | None] = []
        self.protocol_versions: list[str | None] = []
        self.initialized = False
        self.tool_call_args: list[dict[str, Any]] = []
        self.resources_cursors: list[str | None] = []
        self.malformed_sse = False
        self._release = threading.Event()
        server = self

        class _Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0") or "0")
                raw = self.rfile.read(length) if length else b""
                try:
                    payload = json.loads(raw.decode("utf-8")) if raw else {}
                except json.JSONDecodeError:
                    payload = {}
                server.auth_headers.append(self.headers.get("Authorization"))
                server.session_headers.append(self.headers.get("Mcp-Session-Id"))
                server.protocol_versions.append(self.headers.get("MCP-Protocol-Version"))
                server._dispatch(self, payload)

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}/mcp"

    def release(self) -> None:
        self._release.set()

    def shutdown(self) -> None:
        self._release.set()
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=2.0)

    def _dispatch(self, handler: BaseHTTPRequestHandler, payload: dict[str, Any]) -> None:
        method = payload.get("method")
        if method == "notifications/initialized":
            self.initialized = True
            self.events.append("initialized")
            handler.send_response(202)
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        if method == "initialize":
            self.events.append("initialize")
            if self.hang_on_initialize:
                self._release.wait(timeout=10.0)
            result = {
                "protocolVersion": "2025-03-26",
                "serverInfo": {"name": "fake", "version": "1"},
                "capabilities": {},
            }
            self._reply(handler, payload, result, session_id=_SESSION_ID)
            return
        # Any other RPC must come after initialize.
        if not self.initialized:
            self.events.append("rpc_before_initialize")
        self.events.append(str(method))
        result = self._result_for(method, payload)
        self._reply(handler, payload, result)

    def _result_for(self, method: str | None, payload: dict[str, Any]) -> dict[str, Any]:
        params = payload.get("params") or {}
        if method == "tools/list":
            return {"tools": [{"name": "echo", "description": "echo"}]}
        if method == "tools/call":
            self.tool_call_args.append(dict(params))
            return {"content": [{"type": "text", "text": "called"}]}
        if method == "resources/list":
            self.resources_cursors.append(params.get("cursor"))
            return {"resources": [{"uri": "file:///a", "name": "a"}]}
        if method == "resources/read":
            return {"contents": [{"uri": params.get("uri"), "text": "body"}]}
        if method == "resources/templates/list":
            return {"resourceTemplates": [{"uriTemplate": "file:///{p}"}]}
        return {}

    def _reply(
        self,
        handler: BaseHTTPRequestHandler,
        payload: dict[str, Any],
        result: dict[str, Any],
        *,
        session_id: str | None = None,
    ) -> None:
        obj = {"jsonrpc": "2.0", "id": payload.get("id"), "result": result}
        if self.malformed_sse:
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            if session_id:
                handler.send_header("Mcp-Session-Id", session_id)
            handler.end_headers()
            handler.wfile.write(b"data: {not valid json at all\n\n")
            return
        if self.sse_mode:
            body = f"event: message\ndata: {json.dumps(obj)}\n\n".encode("utf-8")
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            if session_id:
                handler.send_header("Mcp-Session-Id", session_id)
            handler.end_headers()
            handler.wfile.write(body)
            return
        raw = json.dumps(obj).encode("utf-8")
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(raw)))
        if session_id:
            handler.send_header("Mcp-Session-Id", session_id)
        handler.end_headers()
        handler.wfile.write(raw)


@pytest.fixture()
def make_server() -> Any:
    servers: list[_FakeMcpServer] = []

    def _make(**kwargs: Any) -> _FakeMcpServer:
        server = _FakeMcpServer(**kwargs)
        servers.append(server)
        return server

    yield _make
    for server in servers:
        server.shutdown()


@pytest.fixture(autouse=True)
def allow_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    # Return a real ValidatedUrl pinned at loopback so the transport connects to
    # the fake server (the real validator would reject a loopback address).
    from sidecar.ai.tools.builtins.web_http import ValidatedUrl

    monkeypatch.setattr(
        transport_sse,
        "validate_public_url",
        lambda url, *, allow_private=False: ValidatedUrl(url=url, pinned_ip="127.0.0.1"),
    )


def _config(url: str, *, auth: MCPServerAuth | None = None, **kwargs: Any) -> MCPServerConfig:
    return MCPServerConfig(
        name="remote",
        transport="sse",
        url=url,
        auth=auth,
        **kwargs,
    )


def test_list_tools_round_trips(make_server: Any) -> None:
    server = make_server()
    transport = SSEMCPTransport(_config(server.url))
    try:
        tools = transport.list_tools()
    finally:
        transport.close()
    assert tools == [{"name": "echo", "description": "echo"}]


def test_initialize_handshake_happens_once_before_first_rpc(make_server: Any) -> None:
    server = make_server()
    transport = SSEMCPTransport(_config(server.url))
    try:
        transport.list_tools()
        transport.list_tools()
    finally:
        transport.close()
    # initialize + initialized exactly once, before any tools/list, and no
    # RPC ever arrived before initialize completed.
    assert server.events[0] == "initialize"
    assert server.events[1] == "initialized"
    assert server.events.count("initialize") == 1
    assert server.events.count("initialized") == 1
    assert "rpc_before_initialize" not in server.events


def test_call_tool_passes_arguments(make_server: Any) -> None:
    server = make_server()
    transport = SSEMCPTransport(_config(server.url))
    try:
        result = transport.call_tool("echo", {"text": "hi"})
    finally:
        transport.close()
    assert result == {"content": [{"type": "text", "text": "called"}]}
    assert server.tool_call_args[0] == {"name": "echo", "arguments": {"text": "hi"}}


def test_resource_methods_round_trip(make_server: Any) -> None:
    server = make_server()
    transport = SSEMCPTransport(_config(server.url))
    try:
        listed = transport.list_resources(cursor="page-1")
        read = transport.read_resource("file:///a")
        templates = transport.list_resource_templates()
    finally:
        transport.close()
    assert listed["resources"][0]["uri"] == "file:///a"
    assert read["contents"][0]["text"] == "body"
    assert templates["resourceTemplates"][0]["uriTemplate"] == "file:///{p}"
    assert server.resources_cursors[0] == "page-1"


def test_server_name_and_close_idempotent(make_server: Any) -> None:
    server = make_server()
    transport = SSEMCPTransport(_config(server.url))
    assert transport.server_name == "remote"
    transport.close()
    # Idempotent + never raises.
    transport.close()


def test_authorization_header_present_with_bearer(make_server: Any) -> None:
    server = make_server()
    auth = MCPServerAuth(kind="bearer", token=_TOKEN)
    transport = SSEMCPTransport(_config(server.url, auth=auth))
    try:
        transport.list_tools()
    finally:
        transport.close()
    assert all(h == f"Bearer {_TOKEN}" for h in server.auth_headers)


def test_authorization_header_absent_without_auth(make_server: Any) -> None:
    server = make_server()
    transport = SSEMCPTransport(_config(server.url))
    try:
        transport.list_tools()
    finally:
        transport.close()
    assert all(h is None for h in server.auth_headers)


def test_protocol_version_header_sent(make_server: Any) -> None:
    server = make_server()
    transport = SSEMCPTransport(_config(server.url))
    try:
        transport.list_tools()
    finally:
        transport.close()
    assert all(v == "2025-03-26" for v in server.protocol_versions)


def test_session_id_echoed_back_after_initialize(make_server: Any) -> None:
    server = make_server()
    transport = SSEMCPTransport(_config(server.url))
    try:
        transport.list_tools()
    finally:
        transport.close()
    # The initialize request carries no session; every subsequent request does.
    assert server.session_headers[0] is None
    assert server.session_headers[-1] == _SESSION_ID


def test_private_url_rejected_at_construction_without_monkeypatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Remove the loopback bypass so the real validator runs; no server needed.
    monkeypatch.undo()
    with pytest.raises(MCPError) as excinfo:
        SSEMCPTransport(_config("http://127.0.0.1:9/"))
    assert excinfo.value.code == CMP_MCP_CONFIG_INVALID


def test_private_url_allowed_when_owner_opts_in(
    monkeypatch: pytest.MonkeyPatch,
    make_server: Any,
) -> None:
    # allow_private_addresses mirrors tools_web_allow_private_addresses so a
    # self-hosted MCP server on a LAN / tailnet / CGNAT address is reachable.
    # Runs against the REAL validator (loopback bypass removed) and round-trips
    # end to end, proving the relaxed validation still yields a usable transport.
    server = make_server()
    monkeypatch.undo()
    transport = SSEMCPTransport(_config(server.url), allow_private_addresses=True)
    try:
        assert transport.list_tools() == [{"name": "echo", "description": "echo"}]
    finally:
        transport.close()


def test_cgnat_url_rejected_by_default_but_accepted_with_opt_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The CGNAT shared address space (100.64.0.0/10) is not is_private in the
    # stdlib; _is_public_ip rejects it explicitly. Construction is the gate, so
    # no server is needed -- only the accept/reject decision is under test.
    monkeypatch.undo()
    with pytest.raises(MCPError) as excinfo:
        SSEMCPTransport(_config("http://100.64.0.1:9/"))
    assert excinfo.value.code == CMP_MCP_CONFIG_INVALID

    transport = SSEMCPTransport(
        _config("http://100.64.0.1:9/"),
        allow_private_addresses=True,
    )
    transport.close()


def test_oauth_token_source_inherits_allow_private_addresses() -> None:
    # The opt-in must reach the OAuth token mint too; a transport that allowed a
    # private server URL but hard-failed on its private token_url would be a
    # half-configured dead end.
    auth = MCPServerAuth(
        kind="oauth_client_credentials",
        token_url="http://100.64.0.1:9/token",
        client_id="client-abc",
        client_secret="secret",
    )
    transport = SSEMCPTransport(
        _config("http://100.64.0.1:9/", auth=auth),
        allow_private_addresses=True,
    )
    try:
        assert transport._token_source is not None
        assert transport._token_source._allow_private_addresses is True
    finally:
        transport.close()


def test_missing_url_rejected_at_construction() -> None:
    with pytest.raises(MCPError) as excinfo:
        SSEMCPTransport(
            MCPServerConfig(name="remote", transport="sse", url=None)
        )
    assert excinfo.value.code == CMP_MCP_CONFIG_INVALID


def test_init_timeout_fires_without_hanging(make_server: Any) -> None:
    server = make_server(hang_on_initialize=True)
    transport = SSEMCPTransport(_config(server.url, init_timeout_seconds=0.2))
    started = time.monotonic()
    try:
        with pytest.raises(MCPError) as excinfo:
            transport.list_tools()
    finally:
        server.release()
        transport.close()
    elapsed = time.monotonic() - started
    assert elapsed < 2.0
    assert excinfo.value.code == CMP_MCP_SERVER_FAILED


def test_unreachable_host_maps_to_mcperror(monkeypatch: pytest.MonkeyPatch) -> None:
    # Validator bypassed (autouse); point at a closed port on loopback.
    transport = SSEMCPTransport(_config("http://127.0.0.1:1/"))
    try:
        with pytest.raises(MCPError) as excinfo:
            transport.list_tools()
    finally:
        transport.close()
    assert excinfo.value.code == CMP_MCP_SERVER_FAILED
    assert excinfo.value.retryable is True


def test_malformed_sse_maps_to_protocol_failed(make_server: Any) -> None:
    server = make_server(sse_mode=True)
    server.malformed_sse = True
    transport = SSEMCPTransport(_config(server.url))
    try:
        with pytest.raises(MCPError) as excinfo:
            transport.list_tools()
    finally:
        transport.close()
    assert excinfo.value.code == CMP_MCP_PROTOCOL_FAILED


def test_requests_connect_to_the_pinned_ip(
    make_server: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # DNS-rebinding hardening: the transport must connect to the IP pinned by
    # validate_public_url at construction, not re-resolve the hostname. The URL
    # hostname (.invalid TLD) is guaranteed unresolvable, so this round-trip
    # succeeds ONLY if the connection used the pin.
    from sidecar.ai.tools.builtins.web_http import ValidatedUrl

    server = make_server()
    port = server.url.rsplit(":", 1)[1].split("/", 1)[0]
    url = f"http://mcp-pin-probe.invalid:{port}/mcp"
    monkeypatch.setattr(
        transport_sse,
        "validate_public_url",
        lambda u, *, allow_private=False: ValidatedUrl(url=u, pinned_ip="127.0.0.1"),
    )
    transport = SSEMCPTransport(_config(url))
    try:
        tools = transport.list_tools()
    finally:
        transport.close()
    assert tools == [{"name": "echo", "description": "echo"}]


def test_jsonrpc_error_message_is_bounded(make_server: Any) -> None:
    # A hostile server must not be able to balloon logs/errors with an
    # unbounded JSON-RPC error.message.
    server = make_server()
    real_reply = server._reply

    def _huge_error_reply(
        handler: Any,
        payload: dict[str, Any],
        result: dict[str, Any],
        *,
        session_id=None,
    ) -> None:
        if payload.get("method") == "tools/list":
            obj = {
                "jsonrpc": "2.0",
                "id": payload.get("id"),
                "error": {"code": -32000, "message": "x" * 50_000},
            }
            raw = json.dumps(obj).encode("utf-8")
            handler.send_response(200)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(raw)))
            handler.end_headers()
            handler.wfile.write(raw)
            return
        real_reply(handler, payload, result, session_id=session_id)

    server._reply = _huge_error_reply  # type: ignore[assignment]
    transport = SSEMCPTransport(_config(server.url))
    try:
        with pytest.raises(MCPError) as excinfo:
            transport.list_tools()
    finally:
        transport.close()
    assert len(str(excinfo.value)) < 700


def test_jsonrpc_error_reply_mapped_like_stdio(make_server: Any) -> None:
    server = make_server()

    # Override the reply path to emit a JSON-RPC error object.
    def _reply_error(handler: Any, payload: dict[str, Any], result: dict[str, Any], *, session_id=None) -> None:
        obj = {
            "jsonrpc": "2.0",
            "id": payload.get("id"),
            "error": {"code": -32000, "message": "tool blew up"},
        }
        raw = json.dumps(obj).encode("utf-8")
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(raw)))
        if session_id:
            handler.send_header("Mcp-Session-Id", session_id)
        handler.end_headers()
        handler.wfile.write(raw)

    # Only error out on tools/list; initialize must still succeed.
    real_reply = server._reply

    def _selective_reply(handler: Any, payload: dict[str, Any], result: dict[str, Any], *, session_id=None) -> None:
        if payload.get("method") == "tools/list":
            _reply_error(handler, payload, result, session_id=session_id)
            return
        real_reply(handler, payload, result, session_id=session_id)

    server._reply = _selective_reply  # type: ignore[assignment]
    transport = SSEMCPTransport(_config(server.url))
    try:
        with pytest.raises(MCPError) as excinfo:
            transport.list_tools()
    finally:
        transport.close()
    assert "tool blew up" in str(excinfo.value)


def test_sse_mode_reply_works_for_call_tool(make_server: Any) -> None:
    server = make_server(sse_mode=True)
    transport = SSEMCPTransport(_config(server.url))
    try:
        result = transport.call_tool("echo", {"x": 1})
    finally:
        transport.close()
    assert result == {"content": [{"type": "text", "text": "called"}]}


def test_401_with_static_bearer_is_not_retryable_and_hides_token(make_server: Any) -> None:
    server = make_server()

    real_reply = server._reply

    def _401_reply(handler: Any, payload: dict[str, Any], result: dict[str, Any], *, session_id=None) -> None:
        if payload.get("method") == "tools/list":
            handler.send_response(401)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", "2")
            handler.end_headers()
            handler.wfile.write(b"{}")
            return
        real_reply(handler, payload, result, session_id=session_id)

    server._reply = _401_reply  # type: ignore[assignment]
    auth = MCPServerAuth(kind="bearer", token=_TOKEN)
    transport = SSEMCPTransport(_config(server.url, auth=auth))
    try:
        with pytest.raises(MCPError) as excinfo:
            transport.list_tools()
    finally:
        transport.close()
    assert excinfo.value.code == CMP_MCP_SERVER_FAILED
    assert excinfo.value.retryable is False
    assert _TOKEN not in str(excinfo.value)
