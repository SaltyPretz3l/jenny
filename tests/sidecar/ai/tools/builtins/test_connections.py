"""Tests for the connections_list builtin."""

from __future__ import annotations

from sidecar.ai.mcp.builtin_server import BuiltinTool, _prepare_call_arguments
from sidecar.ai.tools.builtins.connections import (
    connections_list_tool,
)
from sidecar.ai.tools.registry import build_tool_bindings
from sidecar.ai.tools.workspace import WorkspaceGuard


def _render(config: dict[str, object]) -> str:
    return connections_list_tool({}, object(), config=config)


def test_local_engine_and_web_off() -> None:
    output = _render({"engine_type": "ollama", "tools_web_enabled": False})

    assert output == "\n".join(
        (
            "- Engine: ollama — local",
            "- Web tools: off",
            "- MCP servers: none",
            "- Plugins with network access: not reported by the host "
            "(needs connections_plugin_network_plugins)",
            "- Remote items above can receive what you type here.",
            "- Background traffic not carrying your messages: model catalog refresh; "
            "app auto-updater (when enabled)",
        )
    )


def test_openai_compatible_localhost_engine_and_web_provider() -> None:
    output = _render(
        {
            "engine_type": "openai-compatible",
            "api_url": "http://127.0.0.1:8000/v1",
            "tools_web_enabled": True,
            "tools_web_search_provider": "bing",
        }
    )

    assert "- Engine: openai-compatible — local" in output
    assert "- Web tools: on (bing)" in output


def test_http_mcp_server_lists_transport_and_host() -> None:
    output = _render(
        {
            "engine_type": "mock",
            "mcp_servers": [
                {
                    "name": "research",
                    "transport": "sse",
                    "url": "https://mcp.example.com:8443/rpc?token=hidden",
                },
                {"name": "local", "transport": "stdio", "command": "server"},
            ],
        }
    )

    assert "- MCP servers: research (sse, mcp.example.com:8443)" in output
    assert "local (stdio" not in output


def test_secrets_and_url_credentials_never_appear() -> None:
    output = _render(
        {
            "engine_type": "openai-compatible",
            "api_url": "https://engine-user:engine-password@api.example.com/v1?api_key=engine-secret",
            "tools_web_enabled": True,
            "tools_web_search_provider": "searxng",
            "tools_web_searxng_url": "https://web-user:web-password@search.example.com/search?token=web-secret",
            "tools_web_search_provider_keys": {"searxng": "provider-secret"},
            "api_key": "top-secret-api-key",
            "token": "top-secret-token",
            "mcp_servers": [
                {
                    "name": "private",
                    "transport": "sse",
                    "url": "https://mcp-user:mcp-password@mcp.example.com/rpc?token=mcp-secret",
                    "auth": {"token": "mcp-auth-secret"},
                }
            ],
        }
    )

    for secret in (
        "engine-user",
        "engine-password",
        "engine-secret",
        "web-user",
        "web-password",
        "web-secret",
        "provider-secret",
        "top-secret-api-key",
        "top-secret-token",
        "mcp-user",
        "mcp-password",
        "mcp-secret",
        "mcp-auth-secret",
    ):
        assert secret not in output
    assert "searxng https://search.example.com/search" in output


def test_connections_bindings_keep_request_configs_isolated() -> None:
    config_a = {
        "engine_type": "chatgpt",
        "chatgpt_base_url": "https://session-a.example/v1",
        "tools_connections_enabled": True,
    }
    config_b = {
        "engine_type": "ollama",
        "tools_connections_enabled": True,
    }

    bindings_a = build_tool_bindings(config=config_a)
    output_a = bindings_a["connections_list"]({}, object())
    bindings_b = build_tool_bindings(config=config_b)
    output_b = bindings_b["connections_list"]({}, object())
    output_a_after_b = bindings_a["connections_list"]({}, object())

    assert "- Engine: chatgpt — remote (session-a.example)" in output_a
    assert "- Engine: ollama — local" in output_b
    assert "session-a.example" not in output_b
    assert "- Engine: chatgpt — remote (session-a.example)" in output_a_after_b
    assert "- Engine: ollama — local" not in output_a_after_b

    config_b.update(
        engine_type="chatgpt",
        chatgpt_base_url="https://session-b.example/v1",
    )
    output_b_after_change = bindings_b["connections_list"]({}, object())

    assert "- Engine: chatgpt — remote (session-b.example)" in output_b_after_change
    assert "session-a.example" not in output_b_after_change


def test_connections_reports_request_local_offline_lockdown_only_when_active() -> None:
    locked = connections_list_tool(
        {"_jenny_session_offline_lockdown": True},
        object(),
        config={"engine_type": "ollama"},
    )
    unlocked = _render({"engine_type": "ollama"})

    assert locked.splitlines()[0] == "- Offline lockdown: ON (this session)"
    assert "Offline lockdown" not in unlocked


def test_builtin_transport_admits_lockdown_metadata_outside_public_schema(tmp_path) -> None:
    tool = BuiltinTool(
        name="connections_list",
        description="connections",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}, "additionalProperties": False},
        handler=connections_list_tool,
    )

    arguments, _operation_id, _scope = _prepare_call_arguments(
        tool,
        {"_jenny_session_offline_lockdown": True},
        WorkspaceGuard(str(tmp_path)),
    )

    assert arguments["_jenny_session_offline_lockdown"] is True
