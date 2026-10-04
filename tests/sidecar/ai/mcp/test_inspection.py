from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.mcp import inspection


@pytest.mark.parametrize("permission", [None, False])
def test_sse_inspection_requires_electron_permission(monkeypatch: Any, permission: Any) -> None:
    def forbidden_client(**_kwargs: Any) -> Any:
        pytest.fail("disabled SSE inspection constructed a client")

    monkeypatch.setattr(inspection, "MCPClient", forbidden_client)
    result = inspection.inspect_server({
        "server": {"name": "remote", "transport": "sse", "url": "https://example.test/sse"},
        "mcp_sse_enabled": permission,
    })
    assert result == {"ok": False, "failure": {"code": "CMP-MCP-0002", "reason": "sse_disabled"}}


def test_inspection_executes_exact_confirmed_arguments(monkeypatch: Any) -> None:
    args = ["--label", "", "  ", "--mode", "safe"]
    observed = []

    class Transport:
        def list_tools(self, **_kwargs: Any) -> list:
            return []

        def close(self) -> None:
            pass

    def build(_self: Any, config: Any, **_kwargs: Any) -> Transport:
        observed.append(list(config.args))
        return Transport()

    monkeypatch.setattr(inspection.MCPClient, "_build_transport", build)
    result = inspection.inspect_server({"server": {
        "name": "docs", "transport": "stdio", "command": "node", "args": args,
    }, "confirmed_stdio": True})
    assert result["ok"] is True
    assert observed == [args]


@pytest.mark.parametrize("tools", [
    [{"description": "missing name"}],
    [{"name": "bad", "inputSchema": {"description": "x" * 5000}}],
])
def test_inspection_rejects_incomplete_surfaces_without_review_digest(
    monkeypatch: Any, tools: Any,
) -> None:
    closed = []

    class Transport:
        def list_tools(self, **_kwargs: Any) -> Any:
            return tools

        def close(self) -> None:
            closed.append(True)

    monkeypatch.setattr(inspection.MCPClient, "_build_transport", lambda *_args, **_kwargs: Transport())
    result = inspection.inspect_server({"server": {
        "name": "docs", "transport": "stdio", "command": "node", "args": [],
    }, "confirmed_stdio": True})
    assert result["ok"] is False
    assert "tools_digest" not in result
    assert closed == [True]


def test_sse_inspection_uses_the_effective_permission(monkeypatch: Any) -> None:
    observed = []

    class Transport:
        def list_tools(self, **_kwargs: Any) -> list:
            return []

        def close(self) -> None:
            pass

    def build(_self: Any, config: Any, *, sse_enabled: bool) -> Transport:
        observed.append((config.transport, sse_enabled))
        return Transport()

    monkeypatch.setattr(inspection.MCPClient, "_build_transport", build)
    result = inspection.inspect_server({"server": {
        "name": "remote", "transport": "sse", "url": "https://example.test/sse",
    }, "mcp_sse_enabled": True})
    assert result["ok"] is True
    assert observed == [("sse", True)]


def test_inspection_reply_omits_schemas_but_digest_covers_them(monkeypatch: Any) -> None:
    from sidecar.ai.mcp.tool_surface import summarize_tools, tools_digest

    tools = [{"name": "lookup", "description": "Search", "inputSchema": {
        "type": "object", "properties": {"q": {"type": "string"}}}}]

    class Transport:
        def list_tools(self, **_kwargs: Any) -> list:
            return tools

        def close(self) -> None:
            pass

    monkeypatch.setattr(inspection.MCPClient, "_build_transport", lambda *_a, **_k: Transport())
    result = inspection.inspect_server({"server": {
        "name": "docs", "transport": "stdio", "command": "node", "args": [],
    }, "confirmed_stdio": True})
    assert result["ok"] is True
    assert all("inputSchema" not in row for row in result["tools"])
    assert result["tools_digest"] == tools_digest(summarize_tools(tools)[0])
