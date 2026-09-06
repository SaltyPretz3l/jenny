from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.mcp.exceptions import CMP_MCP_CONFIG_INVALID
from sidecar.ai.mcp.tool_namespace import (
    namespace_mcp_tool_name,
    normalize_mcp_name_component,
)
from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME


class _CollisionTransport:
    def __init__(self, server_name: str, tool_names: list[str]) -> None:
        self.server_name = server_name
        self._tools = [{"name": name} for name in tool_names]
        self.closed = False

    def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        del cancel_handle
        return self._tools

    def close(self) -> None:
        self.closed = True


def _configure_collision_client(
    monkeypatch: pytest.MonkeyPatch,
    transports: list[_CollisionTransport],
) -> MCPClient:
    client = MCPClient()
    by_name = {transport.server_name: transport for transport in transports}
    monkeypatch.setattr(
        client,
        "_build_transport",
        lambda server, *, sse_enabled: by_name[server.name],
    )
    configs = tuple(
        MCPServerConfig(name=transport.server_name, transport="stdio", command="python")
        for transport in transports
    )
    client.configure(configs, sse_enabled=False)
    return client


def test_builtin_mcp_tools_keep_existing_names() -> None:
    assert namespace_mcp_tool_name(BUILTIN_MCP_SERVER_NAME, "read_file") == "read_file"


def test_external_mcp_tools_are_namespaced_by_server() -> None:
    assert (
        namespace_mcp_tool_name("Remote Docs", "search-docs")
        == "mcp__remote_docs__search_docs"
    )


def test_external_namespaced_looking_tools_are_namespaced_under_owner() -> None:
    assert (
        namespace_mcp_tool_name("Remote Docs", "mcp__remote_docs__search_docs")
        == "mcp__remote_docs__mcp_remote_docs_search_docs"
    )


def test_namespace_component_uses_safe_fallback() -> None:
    assert normalize_mcp_name_component(" !!! ") == "server"


def test_same_server_normalization_collision_fails_registration_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport = _CollisionTransport("docs", ["search-docs", "search docs"])

    client = _configure_collision_client(monkeypatch, [transport])

    assert client.available_tools == []
    assert client.diagnostics().connected == ()
    assert tuple(failure.code for failure in client.diagnostics().failures) == (
        CMP_MCP_CONFIG_INVALID,
    )
    assert transport.closed is True


def test_cross_server_normalization_collision_fails_registration_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transports = [
        _CollisionTransport("Remote Docs", ["lookup"]),
        _CollisionTransport("remote-docs", ["lookup"]),
    ]

    client = _configure_collision_client(monkeypatch, transports)

    assert client.available_tools == []
    assert client.diagnostics().connected == ()
    assert tuple(failure.code for failure in client.diagnostics().failures) == (
        CMP_MCP_CONFIG_INVALID,
    )
    assert all(transport.closed for transport in transports)
