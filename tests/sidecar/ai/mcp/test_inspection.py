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

        def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return []

        def get_prompt(self, name: str, arguments: dict[str, str], **_kwargs: Any) -> dict[str, Any]:
            raise NotImplementedError

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

        def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return []

        def get_prompt(self, name: str, arguments: dict[str, str], **_kwargs: Any) -> dict[str, Any]:
            raise NotImplementedError

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

        def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return []

        def get_prompt(self, name: str, arguments: dict[str, str], **_kwargs: Any) -> dict[str, Any]:
            raise NotImplementedError

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

        def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return []

        def get_prompt(self, name: str, arguments: dict[str, str], **_kwargs: Any) -> dict[str, Any]:
            raise NotImplementedError

        def close(self) -> None:
            pass

    monkeypatch.setattr(inspection.MCPClient, "_build_transport", lambda *_a, **_k: Transport())
    result = inspection.inspect_server({"server": {
        "name": "docs", "transport": "stdio", "command": "node", "args": [],
    }, "confirmed_stdio": True})
    assert result["ok"] is True
    assert all("inputSchema" not in row for row in result["tools"])
    assert result["tools_digest"] == tools_digest(summarize_tools(tools))


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        ({"inspect_timeout_seconds": 90, "request_timeout_seconds": 600, "init_timeout_seconds": 120},
         (90.0, 90.0, 90.0)),
        ({"inspect_timeout_seconds": 90}, (90.0, 30.0, 30.0)),
        ({}, (15.0, 15.0, 15.0)),
    ],
)
def test_inspection_honours_the_row_inspect_timeout(
    monkeypatch: Any, row: dict[str, Any], expected: tuple[float, float, float],
) -> None:
    observed: dict[str, Any] = {}

    class Transport:
        def list_tools(self, **_kwargs: Any) -> list:
            return []

        def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return []

        def get_prompt(self, name: str, arguments: dict[str, str], **_kwargs: Any) -> dict[str, Any]:
            raise NotImplementedError

        def close(self) -> None:
            pass

    class Client:
        def __init__(self, **kwargs: Any) -> None:
            observed["client"] = kwargs

        def _build_transport(self, config: Any, **_kwargs: Any) -> Transport:
            observed["config"] = config
            return Transport()

        def close(self) -> None:
            pass

    monkeypatch.setattr(inspection, "MCPClient", Client)
    result = inspection.inspect_server({"server": {
        "name": "rea", "transport": "stdio", "command": "npx", "args": [], **row,
    }, "confirmed_stdio": True})
    assert result["ok"] is True
    config = observed["config"]
    assert (
        observed["client"]["request_timeout_seconds"],
        config.request_timeout_seconds,
        config.init_timeout_seconds,
    ) == expected


def _inspect_with(monkeypatch: Any, list_tools: Any) -> dict:
    class Transport:
        def list_tools(self, **_kwargs: Any) -> Any:
            return list_tools()

        def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return []

        def get_prompt(self, name: str, arguments: dict[str, str], **_kwargs: Any) -> dict[str, Any]:
            raise NotImplementedError

        def close(self) -> None:
            pass

    monkeypatch.setattr(inspection.MCPClient, "_build_transport", lambda *_a, **_k: Transport())
    return inspection.inspect_server({"server": {
        "name": "rea", "transport": "stdio", "command": "node", "args": [],
    }, "confirmed_stdio": True})


def test_inspection_failure_names_the_offending_tool_and_bound(monkeypatch: Any) -> None:
    result = _inspect_with(monkeypatch, lambda: [
        {"name": "lookup"}, {"name": "inspect_binary_layout", "description": "d" * 2049},
    ])
    assert result["ok"] is False
    failure = result["failure"]
    assert failure["code"] == "CMP-MCP-0004"
    assert failure["reason"] == "tool_text_exceeded"
    assert failure["retryable"] is False
    assert failure["detail"]["tool"] == "inspect_binary_layout"
    assert failure["detail"]["bound"] == "description_chars"
    assert "tools_digest" not in result


def test_inspection_failure_keeps_the_class_name_for_other_errors(monkeypatch: Any) -> None:
    def explode() -> list:
        raise RuntimeError("secret detail")

    result = _inspect_with(monkeypatch, explode)
    assert result["ok"] is False
    assert result["failure"] == {"code": "CMP-MCP-0004", "reason": "RuntimeError"}


def test_inspection_reply_shows_the_read_only_claims(monkeypatch: Any) -> None:
    from sidecar.ai.mcp.tool_surface import summarize_tools, tools_digest

    tools = [{"name": "list_unknowns", "annotations": {"readOnlyHint": True}},
             {"name": "open_binary", "annotations": {"readOnlyHint": True, "openWorldHint": True}},
             {"name": "delete_session", "annotations": {"destructiveHint": True}}]

    class Transport:
        def list_tools(self, **_kwargs: Any) -> list:
            return tools

        def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return []

        def get_prompt(self, name: str, arguments: dict[str, str], **_kwargs: Any) -> dict[str, Any]:
            raise NotImplementedError

        def close(self) -> None:
            pass

    monkeypatch.setattr(inspection.MCPClient, "_build_transport", lambda *_a, **_k: Transport())
    result = inspection.inspect_server({"server": {
        "name": "rea", "transport": "stdio", "command": "npx", "args": [],
    }, "confirmed_stdio": True})
    assert result["ok"] is True
    rows = {row["name"]: row for row in result["tools"]}
    assert rows["list_unknowns"]["read_only_claim"] is True
    assert "read_only_claim" not in rows["open_binary"]
    assert "read_only_claim" not in rows["delete_session"]
    assert result["tools_digest"] == tools_digest(summarize_tools(tools))
    # An opted-in row records the claims in the digest it offers for approval.
    opted_in = inspection.inspect_server({"server": {
        "name": "rea", "transport": "stdio", "command": "npx", "args": [],
        "read_only_auto_allow": True,
    }, "confirmed_stdio": True})
    assert opted_in["tools_digest"] == tools_digest(summarize_tools(tools), read_only_claims=True)
    assert opted_in["tools_digest"] != result["tools_digest"]


def _inspect_prompts(monkeypatch: Any, prompts: Any) -> dict:
    class PromptProbe:
        def list_tools(self, **_kwargs: Any) -> list:
            return [{"name": "lookup"}]

        def list_prompts(self, **_kwargs: Any) -> Any:
            if isinstance(prompts, Exception):
                raise prompts
            return prompts

        def close(self) -> None:
            pass

    monkeypatch.setattr(inspection.MCPClient, "_build_transport", lambda *_a, **_k: PromptProbe())
    return inspection.inspect_server({"server": {
        "name": "rea", "transport": "stdio", "command": "node", "args": [],
    }, "confirmed_stdio": True})


def test_inspection_prompt_surface_and_independent_digest(monkeypatch: Any) -> None:
    from sidecar.ai.mcp.prompt_surface import prompts_digest, summarize_prompts

    prompts = [{"name": "investigate_feature", "arguments": [{"name": "feature", "required": True}]},
               {"name": "Invalid"}]
    result = _inspect_prompts(monkeypatch, prompts)
    assert result["ok"] is True
    assert result["prompts"] == summarize_prompts(prompts)[0]
    assert result["prompt_count"] == 1
    assert result["malformed_prompt_count"] == 1
    assert result["prompts_digest"] == prompts_digest(result["prompts"])
    changed = _inspect_prompts(monkeypatch, [{"name": "investigate_feature",
        "arguments": [{"name": "feature", "required": False}]}])
    assert result["tools_digest"] == changed["tools_digest"]
    assert result["prompts_digest"] != changed["prompts_digest"]


def test_inspection_refuses_too_many_prompts(monkeypatch: Any) -> None:
    result = _inspect_prompts(monkeypatch, [{"name": f"prompt{i}"} for i in range(33)])
    assert result["ok"] is False
    assert result["failure"]["reason"] == "too_many_prompts"
    assert "prompts_digest" not in result


def test_stdio_without_prompts_capability_inspects_as_empty(monkeypatch: Any) -> None:
    from types import SimpleNamespace

    from sidecar.ai.mcp.transport_stdio import StdioMCPTransport

    transport = object.__new__(StdioMCPTransport)
    transport._config = SimpleNamespace(name="rea")
    transport._request_timeout_seconds = 5
    monkeypatch.setattr(transport, "_ensure_initialized", lambda **_k: None)
    monkeypatch.setattr(transport, "close", lambda: None)
    calls = []
    def send_request(method: str, _params: dict, **_kwargs: Any) -> dict:
        calls.append(method)
        response = ({"result": {"tools": []}} if method == "tools/list" else
                    {"error": {"code": -32601, "message": "Method not found"}})
        transport._raise_for_error(response)
        return response
    monkeypatch.setattr(transport, "_send_request", send_request)
    monkeypatch.setattr(inspection.MCPClient, "_build_transport", lambda *_a, **_k: transport)
    result = inspection.inspect_server({"server": {
        "name": "rea", "transport": "stdio", "command": "node", "args": [],
    }, "confirmed_stdio": True})
    assert result["ok"] is True
    assert result["prompts"] == []
    assert result["prompts_digest"] == ""
    assert result["prompt_count"] == result["malformed_prompt_count"] == 0
    assert calls == ["tools/list", "prompts/list"]


@pytest.mark.parametrize("message", ["server failed", "method not found"])
def test_other_prompt_transport_errors_fail_inspection(monkeypatch: Any, message: str) -> None:
    from sidecar.ai.mcp.exceptions import CMP_MCP_SERVER_FAILED, MCPError

    result = _inspect_prompts(monkeypatch, MCPError(code=CMP_MCP_SERVER_FAILED, message=message))
    assert result["ok"] is False
    assert result["failure"]["reason"] == "probe_failed"


def test_any_prompt_error_reply_inspects_as_empty(monkeypatch: Any) -> None:
    from sidecar.ai.mcp.exceptions import CMP_MCP_SERVER_FAILED, MCPError

    result = _inspect_prompts(monkeypatch, MCPError(code=CMP_MCP_SERVER_FAILED,
                                                    message="prompts not supported", response_received=True))
    assert result["ok"] is True
    assert result["prompts"] == []
    assert result["prompts_digest"] == ""
