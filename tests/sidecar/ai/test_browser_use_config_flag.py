"""The ``tools_browser_use_enabled`` flag: parsed, default off, and the retired keys stay retired."""

from __future__ import annotations

import json

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.config_models import RuntimeConfig
from sidecar.ai.tools.catalog import tool_manifest_path
from sidecar.ai.tools.tool_families import KNOWN_TOOL_FAMILIES, TOOL_FAMILY_NAMES


def _parse(**overrides: object) -> RuntimeConfig:
    return parse_runtime_config({"engine_type": "vllm", "model": "Qwen/Qwen3.5-9B", **overrides})


def test_the_flag_defaults_off_in_the_model_and_the_parser() -> None:
    assert RuntimeConfig.__dataclass_fields__["tools_browser_use_enabled"].default is False
    assert _parse().tools_browser_use_enabled is False


def test_an_explicit_true_enables_it() -> None:
    assert _parse(tools_browser_use_enabled=True).tools_browser_use_enabled is True


@pytest.mark.parametrize("value", [False, "true", "1", 1, 0, None, "maybe", []])
def test_anything_but_a_real_true_stays_off(value: object) -> None:
    assert _parse(tools_browser_use_enabled=value).tools_browser_use_enabled is False


def test_the_manifest_gates_browser_on_exactly_this_flag() -> None:
    manifest = json.loads(tool_manifest_path().read_text(encoding="utf-8"))
    entry = next(tool for tool in manifest["tools"] if tool["name"] == "browser")
    assert entry["availability"]["config_flag"] == "tools_browser_use_enabled"
    assert entry["tool_family"] == "browser_use"
    assert "tools_browser_use_enabled" in RuntimeConfig.__dataclass_fields__


def test_the_retired_browser_keys_are_not_revived() -> None:
    fields = set(RuntimeConfig.__dataclass_fields__)
    assert "tools_browser_enabled" not in fields
    assert not any(field.startswith("tools_browser_") and field != "tools_browser_use_enabled" for field in fields)
    # The new family is separate from the retired family named "browser".
    assert "browser_use" in KNOWN_TOOL_FAMILIES and "browser" in KNOWN_TOOL_FAMILIES
    assert TOOL_FAMILY_NAMES["browser_use"] == ("browser",)
    assert "browser" not in TOOL_FAMILY_NAMES
