from sidecar.ai import config_parsing


def test_config_parsing_has_no_vendor_specific_archived_fallback_set() -> None:
    assert not hasattr(config_parsing, "ARCHIVED_CLOUD_FALLBACK_ENGINES")
    assert config_parsing._parse_fallback_models(
        [{"engine_type": "anthropic", "model": "removed-cloud-model"}]
    ) == ()
