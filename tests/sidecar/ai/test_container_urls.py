from __future__ import annotations

from pathlib import Path

from sidecar.ai.config import MCPServerConfig, RuntimeConfig
from sidecar.ai.container import _argv_safe_url, _default_mcp_servers


def test_argv_safe_url_preserves_ipv6_brackets_when_stripping_credentials() -> None:
    assert (
        _argv_safe_url("https://user:secret@[2001:db8::1]:8443/search?q=test")
        == "https://[2001:db8::1]:8443/search?q=test"
    )


def test_argv_safe_url_degrades_invalid_credentialed_port_to_empty() -> None:
    assert _argv_safe_url("https://user:secret@example.com:99999/search") == ""


def test_connection_engine_host_degrades_malformed_api_url(tmp_path: Path) -> None:
    config = RuntimeConfig(api_url="https://[not-an-ipv6]/v1")

    servers = _default_mcp_servers(config, tmp_path)
    args = list(servers[0].args)

    assert args[args.index("--connections-engine-host") + 1] == ""


def test_connection_mcp_host_degrades_malformed_server_url(tmp_path: Path) -> None:
    config = RuntimeConfig(
        api_url="https://engine.example/v1",
        mcp_servers=(
            MCPServerConfig(
                name="malformed",
                transport="sse",
                url="https://[not-an-ipv6]/rpc",
            ),
        ),
    )

    servers = _default_mcp_servers(config, tmp_path)
    args = list(servers[0].args)
    server_index = args.index("--connections-mcp-server")

    assert args[server_index + 1 : server_index + 4] == ["malformed", "sse", ""]
