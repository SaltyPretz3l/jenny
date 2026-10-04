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
