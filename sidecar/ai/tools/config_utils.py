from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

CONFIG_FIELD_TYPES = frozenset({"toggle"})
CONFIG_FIELD_STORAGES = frozenset({"config"})
_MISSING = object()


def config_value(config: Any | None, key: str, default: Any = None) -> Any:
    if config is None:
        return default
    if isinstance(config, dict):
        return config.get(key, default)
    return getattr(config, key, default)


def _normalize_non_empty_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _first_present(source: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in source:
            return source[key]
    return _MISSING


def _normalize_required_string(value: Any, *, tool_name: str, field_name: str) -> str:
    normalized = _normalize_non_empty_string(value)
    if not normalized:
        raise ValueError(
            f"tool manifest entry {tool_name} config_schema {field_name} is required"
        )
    return normalized


def _normalize_optional_string(
    value: Any,
    *,
    tool_name: str,
    field_name: str,
    default: str = "",
) -> str:
    if value is _MISSING or value is None:
        return default
    if not isinstance(value, str):
        raise ValueError(
            f"tool manifest entry {tool_name} config_schema {field_name} must be a string"
        )
    return value.strip() or default


def _normalize_string_tuple(
    value: Any,
    *,
    fallback: str = "",
    tool_name: str,
    field_name: str,
) -> tuple[str, ...]:
    if value is _MISSING or value is None:
        raw_items: list[Any] = []
    elif isinstance(value, list):
        raw_items = value
    else:
        raise ValueError(
            f"tool manifest entry {tool_name} config_schema {field_name} must be a list"
        )
    normalized: list[str] = []
    for raw_item in raw_items:
        item = _normalize_non_empty_string(raw_item)
        if not item:
            raise ValueError(
                f"tool manifest entry {tool_name} config_schema {field_name} "
                "must contain non-empty strings"
            )
        if item not in normalized:
            normalized.append(item)
    if not normalized and fallback:
        normalized.append(fallback)
    return tuple(normalized)


@dataclass(frozen=True)
class ConfigField:
    """Display-safe declarative settings metadata for tool UI/config surfaces."""

    key: str
    label: str
    field_type: str = "toggle"
    storage: str = "config"
    default: Any = False
    help_text: str = ""
    config_flag: str | None = None
    tool_ids: tuple[str, ...] = field(default_factory=tuple)

    def to_wire(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "key": self.key,
            "label": self.label,
            "field_type": self.field_type,
            "storage": self.storage,
            "default": self.default,
            "help_text": self.help_text,
            "tool_ids": list(self.tool_ids),
        }
        if self.config_flag:
            payload["config_flag"] = self.config_flag
        return payload


def normalize_config_field(value: Any, *, tool_name: str) -> ConfigField:
    source = value if isinstance(value, dict) else {}
    key = _normalize_required_string(
        _first_present(source, "key"),
        tool_name=tool_name,
        field_name="key",
    )
    label = _normalize_required_string(
        _first_present(source, "label"),
        tool_name=tool_name,
        field_name="label",
    )
    field_type = _normalize_optional_string(
        _first_present(source, "field_type", "fieldType"),
        tool_name=tool_name,
        field_name="field_type",
        default="toggle",
    )
    if field_type not in CONFIG_FIELD_TYPES:
        raise ValueError(
            f"tool manifest entry {tool_name} config_schema field_type is invalid: {field_type}"
        )
    storage = _normalize_optional_string(
        _first_present(source, "storage"),
        tool_name=tool_name,
        field_name="storage",
        default="config",
    )
    if storage not in CONFIG_FIELD_STORAGES:
        raise ValueError(
            f"tool manifest entry {tool_name} config_schema storage is invalid: {storage}"
        )
    default = source.get("default", False)
    if field_type == "toggle" and not isinstance(default, bool):
        raise ValueError(f"tool manifest entry {tool_name} config_schema default must be a bool")
    config_flag = _normalize_optional_string(
        _first_present(source, "config_flag", "configFlag"),
        tool_name=tool_name,
        field_name="config_flag",
    )
    help_text = _normalize_optional_string(
        _first_present(source, "help_text", "helpText"),
        tool_name=tool_name,
        field_name="help_text",
    )
    return ConfigField(
        key=key,
        label=label,
        field_type=field_type,
        storage=storage,
        default=default,
        help_text=help_text,
        config_flag=config_flag,
        tool_ids=_normalize_string_tuple(
            _first_present(source, "tool_ids", "toolIds"),
            fallback=tool_name,
            tool_name=tool_name,
            field_name="tool_ids",
        ),
    )
