"""SSE transport error redaction, tools/list pagination and OAuth mint budget."""

from __future__ import annotations

import threading
import time
from typing import Any

import pytest

from sidecar.ai.config import MCPServerAuth, MCPServerConfig
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.transport_sse import SSEMCPTransport
from tests.sidecar.ai.mcp.test_transport_sse import (  # noqa: F401 -- shared fixtures
    _TOKEN,
    allow_loopback,
    make_server,
)


@pytest.mark.parametrize("oauth", [False, True])
def test_server_error_redacts_unlabelled_credentials(make_server: Any, oauth: bool, caplog: Any) -> None:  # noqa: F811
    server = make_server()
    auth = MCPServerAuth(kind="oauth_client_credentials", token_url=server.url,
                         client_id="client", client_secret="private-secret") if oauth else MCPServerAuth(kind="bearer", token=_TOKEN)
    transport = SSEMCPTransport(MCPServerConfig(name="remote", transport="sse", url=server.url, auth=auth))
    if oauth:
        assert transport._token_source is not None
        transport._token_source._cached_token = _TOKEN
    text = f"rejected {_TOKEN} older-minted-token private-secret Authorization: Basic abc123 https://user:password@host/path sk-abcdefghijk"
    with pytest.raises(MCPError) as caught:
        transport._raise_for_error({"error": {"message": text}})
    for value in (_TOKEN, "older-minted-token" if oauth else _TOKEN, "private-secret" if oauth else _TOKEN, "abc123", "user:password", "sk-abcdefghijk"):
        assert value not in caught.value.message
        assert value not in caplog.text


def test_server_error_replaces_an_echoed_bearer_token(make_server: Any) -> None:  # noqa: F811
    server = make_server()
    transport = SSEMCPTransport(MCPServerConfig(name="remote", transport="sse", url=server.url,
                                                auth=MCPServerAuth(kind="bearer", token=_TOKEN)))
    with pytest.raises(MCPError) as caught:
        transport._raise_for_error({"error": {"message": f"bad token {_TOKEN}"}})
    assert _TOKEN not in caught.value.message
    assert "[REDACTED]" in caught.value.message


def test_tools_list_follows_pages(make_server: Any) -> None:  # noqa: F811
    server = make_server()
    seen = []
    def result(method: Any, payload: Any) -> dict[str, Any]:
        cursor = payload["params"].get("cursor")
        seen.append(cursor)
        return {"tools": [{"name": "second"}]} if cursor else {"tools": [{"name": "first"}], "nextCursor": "page-2"}
    server._result_for = result
    transport = SSEMCPTransport(MCPServerConfig(name="remote", transport="sse", url=server.url))
    assert [tool["name"] for tool in transport.list_tools()] == ["first", "second"]
    assert seen == [None, "page-2"]


def test_tools_list_rejects_repeated_cursor(make_server: Any) -> None:  # noqa: F811
    server = make_server()
    server._result_for = lambda *_args: {"tools": [], "nextCursor": "same"}
    transport = SSEMCPTransport(MCPServerConfig(name="remote", transport="sse", url=server.url))
    with pytest.raises(MCPError, match="pagination"):
        transport.list_tools()


def test_oauth_mint_fits_the_callers_exchange_budget(make_server: Any) -> None:  # noqa: F811
    from tests.sidecar.ai.mcp.test_mcp_http_auth import _TokenServer, _write_token
    release = threading.Event()
    def responder(handler: Any, form: Any) -> None:
        release.wait(1)
        try:
            _write_token(handler, {"access_token": "minted"})
        except OSError:
            pass
    issuer = _TokenServer(responder)
    server = make_server()
    transport = SSEMCPTransport(MCPServerConfig(name="remote", transport="sse", url=server.url,
        auth=MCPServerAuth(kind="oauth_client_credentials", token_url=issuer.url, client_id="client", client_secret="secret")), allow_private_addresses=True)
    started = time.monotonic()
    try:
        with pytest.raises(MCPError):
            transport.call_tool("echo", {}, timeout_seconds=0.15)
        assert time.monotonic() - started < 0.7
        assert server.events == []
    finally:
        release.set()
        transport.close()
        issuer.shutdown()


def test_tools_list_page_limit_is_a_visible_failure(make_server: Any) -> None:  # noqa: F811
    server = make_server()
    pages = []
    def result(*_args: Any) -> dict[str, Any]:
        pages.append(1)
        return {"tools": [{"name": "hidden"}], "nextCursor": str(len(pages))}
    server._result_for = result
    transport = SSEMCPTransport(MCPServerConfig(name="remote", transport="sse", url=server.url))
    with pytest.raises(MCPError, match="pagination"):
        transport.list_tools()
    assert len(pages) == 32
