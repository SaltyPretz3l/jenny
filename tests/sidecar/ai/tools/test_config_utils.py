from dataclasses import dataclass

import pytest

from sidecar.ai.tools.config_utils import ConfigField, config_value, normalize_config_field


@dataclass
class ConfigObject:
    enabled: bool = True


def test_config_value_reads_dict_and_object_sources() -> None:
    assert config_value({"enabled": False}, "enabled", True) is False
    assert config_value(ConfigObject(), "enabled", False) is True


def test_config_value_uses_default_for_missing_or_null_sources() -> None:
    assert config_value(None, "enabled", "fallback") == "fallback"
    assert config_value({}, "enabled", "fallback") == "fallback"


def test_config_field_serializes_display_safe_payload() -> None:
    field = ConfigField(
        key="web",
        label="Web tools",
        field_type="toggle",
        storage="config",
        default=False,
        help_text="Enable web_search and fetch_url.",
        config_flag="tools_web_enabled",
        tool_ids=("web_search", "fetch_url"),
    )

    assert field.to_wire() == {
        "key": "web",
        "label": "Web tools",
        "field_type": "toggle",
        "storage": "config",
        "default": False,
        "help_text": "Enable web_search and fetch_url.",
        "config_flag": "tools_web_enabled",
        "tool_ids": ["web_search", "fetch_url"],
    }


def test_normalize_config_field_rejects_malformed_descriptors() -> None:
    with pytest.raises(ValueError, match="bad_tool.*config_schema.*key"):
        normalize_config_field({"key": "", "label": "Broken"}, tool_name="bad_tool")


def test_normalize_config_field_rejects_password_fields_without_secure_storage() -> None:
    with pytest.raises(ValueError, match="secret_tool.*config_schema.*field_type"):
        normalize_config_field(
            {
                "key": "apiKey",
                "label": "API key",
                "field_type": "password",
                "storage": "config",
            },
            tool_name="secret_tool",
        )


def test_normalize_config_field_rejects_non_boolean_toggle_defaults() -> None:
    with pytest.raises(ValueError, match="bad_tool.*config_schema.*default"):
        normalize_config_field(
            {
                "key": "badToggle",
                "label": "Bad toggle",
                "field_type": "toggle",
                "storage": "config",
                "default": "true",
            },
            tool_name="bad_tool",
        )


def test_normalize_config_field_rejects_malformed_optional_metadata() -> None:
    with pytest.raises(ValueError, match="bad_flag.*config_schema.*config_flag"):
        normalize_config_field(
            {
                "key": "badFlag",
                "label": "Bad flag",
                "field_type": "toggle",
                "storage": "config",
                "default": False,
                "config_flag": False,
            },
            tool_name="bad_flag",
        )

    with pytest.raises(ValueError, match="bad_ids.*config_schema.*tool_ids"):
        normalize_config_field(
            {
                "key": "badIds",
                "label": "Bad ids",
                "field_type": "toggle",
                "storage": "config",
                "default": False,
                "tool_ids": "bad_ids",
            },
            tool_name="bad_ids",
        )


def test_normalize_config_field_rejects_unsupported_non_toggle_fields() -> None:
    with pytest.raises(ValueError, match="text_tool.*config_schema.*field_type"):
        normalize_config_field(
            {
                "key": "label",
                "label": "Label",
                "field_type": "text",
                "storage": "config",
                "default": "",
            },
            tool_name="text_tool",
        )
