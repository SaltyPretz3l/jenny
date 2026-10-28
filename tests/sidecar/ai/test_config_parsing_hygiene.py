import logging

import pytest

from sidecar.ai import config_parsing


def test_config_parsing_has_no_vendor_specific_archived_fallback_set() -> None:
    assert not hasattr(config_parsing, "ARCHIVED_CLOUD_FALLBACK_ENGINES")
    assert config_parsing._parse_fallback_models(
        [{"engine_type": "anthropic", "model": "removed-cloud-model"}]
    ) == ()


def test_mcp_stdio_preserves_confirmed_empty_arguments() -> None:
    args = ["--label", "", "  ", "--mode", "safe"]
    servers = config_parsing._parse_mcp_servers(
        [{"name": "docs", "transport": "stdio", "command": "node", "args": args}],
        sse_enabled=False,
    )
    assert servers[0].args == tuple(args)


def test_mcp_stdio_row_extensions_parse_with_raised_bounds() -> None:
    [server] = config_parsing._parse_mcp_servers(
        [{
            "name": "rea", "transport": "stdio", "command": "npx",
            "env": {"REA_LOG_LEVEL": "debug", "REA_ANALYSIS_PROVIDER": "none"},
            "memory_limit_mb": 8192, "max_processes": 16,
            "request_timeout_seconds": 1800, "inspect_timeout_seconds": 90,
        }],
        sse_enabled=False,
    )
    assert server.env == (("REA_ANALYSIS_PROVIDER", "none"), ("REA_LOG_LEVEL", "debug"))
    assert server.memory_limit_mb == 8192
    assert server.max_processes == 16
    assert server.request_timeout_seconds == 1800.0
    assert server.inspect_timeout_seconds == 90.0


def test_mcp_row_without_extensions_keeps_its_defaults() -> None:
    [server, out_of_bounds] = config_parsing._parse_mcp_servers(
        [
            {"name": "docs", "transport": "stdio", "command": "node"},
            {"name": "wide", "transport": "stdio", "command": "node", "inspect_timeout_seconds": 181,
             "request_timeout_seconds": 1801, "memory_limit_mb": 8193},
        ],
        sse_enabled=False,
    )
    assert server.env == ()
    assert server.inspect_timeout_seconds == 15.0
    assert (server.memory_limit_mb, server.max_processes, server.request_timeout_seconds) == (512, 5, 30.0)
    assert out_of_bounds.inspect_timeout_seconds == 15.0
    assert (out_of_bounds.memory_limit_mb, out_of_bounds.request_timeout_seconds) == (512, 30.0)


@pytest.mark.parametrize(
    ("key", "reason"),
    [
        ("MY_TOKEN", "plaintext_secret"), ("PATH", "reserved_env_key"), ("NODE_OPTIONS", "reserved_env_key"),
        ("NPM_CONFIG_NODE_OPTIONS", "reserved_env_key"), ("JAVA_TOOL_OPTIONS", "reserved_env_key"),
        ("REA_OPTS", "reserved_env_key"),
    ],
)
def test_mcp_row_with_a_rejected_env_key_is_skipped_and_logged_without_its_value(
    caplog: pytest.LogCaptureFixture, key: str, reason: str,
) -> None:
    with caplog.at_level(logging.WARNING, logger=config_parsing.__name__):
        servers = config_parsing._parse_mcp_servers(
            [
                {"name": "rea", "transport": "stdio", "command": "npx",
                 "env": {"REA_LOG_LEVEL": "debug", key: "do-not-log-this-value"}},
                {"name": "docs", "transport": "stdio", "command": "node"},
            ],
            sse_enabled=False,
        )
    assert [server.name for server in servers] == ["docs"]
    records = [record for record in caplog.records
               if getattr(record, "event", "") == "ai.mcp.config_env_rejected"]
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    assert records[0].data == {"server": "rea", "key": key, "reason": reason}
    assert "do-not-log-this-value" not in repr(records[0].__dict__)


@pytest.mark.parametrize(("value", "expected"), [(True, True), (False, False), ("true", False), (1, False)])
def test_mcp_row_read_only_auto_allow_parses_only_a_literal_true(value: object, expected: bool) -> None:
    [stdio, sse, absent] = config_parsing._parse_mcp_servers(
        [
            {"name": "rea", "transport": "stdio", "command": "npx", "read_only_auto_allow": value},
            {"name": "remote", "transport": "sse", "url": "https://mcp.example.test/sse",
             "read_only_auto_allow": value},
            {"name": "docs", "transport": "stdio", "command": "node"},
        ],
        sse_enabled=True,
    )
    assert stdio.read_only_auto_allow is expected
    assert sse.read_only_auto_allow is expected
    assert absent.read_only_auto_allow is False


def test_mcp_row_named_like_the_builtin_server_is_skipped_and_logged(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger=config_parsing.__name__):
        servers = config_parsing._parse_mcp_servers(
            [
                {"name": "jenny_local_tools", "transport": "stdio", "command": "npx",
                 "read_only_auto_allow": True},
                {"name": "docs", "transport": "stdio", "command": "node"},
            ],
            sse_enabled=False,
        )
    assert [server.name for server in servers] == ["docs"]
    records = [record for record in caplog.records
               if getattr(record, "event", "") == "ai.mcp.config_reserved_name_rejected"]
    assert len(records) == 1
    assert records[0].data == {"server": "jenny_local_tools"}
