"""The ``settings_change`` / ``settings_get`` manifest schemas (row 88 S2) through the sidecar validator.

The validator supports ``anyOf``, ``enum``, ``type`` and ``properties`` but not ``if/then`` or ``const``,
so Auto as the default run mode is refused by a two-branch ``anyOf`` per change.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure, validate_tool_arguments
from sidecar.ai.tools.policy import (
    _DEFAULT_TOOL_DEFAULTS,
    POLICY_DECISION_ASK,
    POLICY_DECISION_AUTO,
)

_MANIFEST = Path(__file__).resolve().parents[4] / "services" / "tools" / "tool-manifest.json"
_TOOLS = {tool["name"]: tool for tool in json.loads(_MANIFEST.read_text(encoding="utf-8"))["tools"]}
_CHANGE_SCHEMA = _TOOLS["settings_change"]["parameters"]
_GET_SCHEMA = _TOOLS["settings_get"]["parameters"]


def _change(arguments: object) -> object:
    return validate_tool_arguments(
        tool_name="settings_change", arguments=arguments, input_schema=_CHANGE_SCHEMA,
    )


def test_a_valid_two_change_batch_is_accepted() -> None:
    arguments = {
        "changes": [
            {"key": "time_format_24h", "value": True},
            {"key": "default_run_mode", "value": "plan"},
        ],
        "purpose": "Use the 24 hour clock and start new chats in Plan mode.",
    }
    assert _change(arguments) == arguments


@pytest.mark.parametrize("value", [False, 14, 1.5, "de"])
def test_any_scalar_value_is_accepted_for_the_general_keys(value: object) -> None:
    arguments = {"changes": [{"key": "editor_font_size", "value": value}], "purpose": "x"}
    assert _change(arguments) == arguments


@pytest.mark.parametrize("mode", ["ask", "plan", "propose"])
def test_the_other_run_modes_are_accepted(mode: str) -> None:
    arguments = {"changes": [{"key": "default_run_mode", "value": mode}], "purpose": "x"}
    assert _change(arguments) == arguments


@pytest.mark.parametrize(
    "arguments",
    [
        {"changes": [{"key": "default_run_mode", "value": "auto"}], "purpose": "x"},
        {"changes": [{"key": "default_run_mode", "value": True}], "purpose": "x"},
        {"changes": [{"key": "default_run_mode", "value": "yolo"}], "purpose": "x"},
        {"changes": [{"key": "api_key", "value": "x"}], "purpose": "x"},
        {"changes": [{"key": "time_format_24h", "value": True}, {"key": "model", "value": "x"}], "purpose": "x"},
        {"changes": [{"key": "time_format_24h", "value": None}], "purpose": "x"},
        {"changes": [{"key": "time_format_24h", "value": {"a": 1}}], "purpose": "x"},
        {"changes": [{"key": "ui_language", "value": "x" * 65}], "purpose": "x"},
        {"changes": [{"key": "time_format_24h", "value": True, "note": "x"}], "purpose": "x"},
        {"changes": [{"key": "time_format_24h"}], "purpose": "x"},
        {"changes": [], "purpose": "x"},
        {"changes": [{"key": "time_format_24h", "value": True}] * 6, "purpose": "x"},
        {"changes": [{"key": "time_format_24h", "value": True}]},
        {"changes": [{"key": "time_format_24h", "value": True}], "purpose": ""},
        {"changes": [{"key": "time_format_24h", "value": True}], "purpose": "x" * 201},
        {"changes": [{"key": "time_format_24h", "value": True}], "purpose": "x", "extra": 1},
    ],
)
def test_forbidden_or_malformed_changes_are_rejected(arguments: object) -> None:
    with pytest.raises(ToolExecutionFailure):
        _change(arguments)


def test_settings_get_keys_are_unique_listed_and_bounded() -> None:
    assert validate_tool_arguments(tool_name="settings_get", arguments={}, input_schema=_GET_SCHEMA) == {}
    valid = {"keys": ["palette", "ui_language"]}
    assert validate_tool_arguments(tool_name="settings_get", arguments=valid, input_schema=_GET_SCHEMA) == valid
    for bad in ({"keys": []}, {"keys": ["palette", "palette"]}, {"keys": [7]}, {"keys": ["palette"], "x": 1}):
        with pytest.raises(ToolExecutionFailure):
            validate_tool_arguments(tool_name="settings_get", arguments=bad, input_schema=_GET_SCHEMA)


def test_policy_defaults_read_free_and_change_asks() -> None:
    assert _DEFAULT_TOOL_DEFAULTS["settings_get"] == POLICY_DECISION_AUTO
    assert _DEFAULT_TOOL_DEFAULTS["settings_change"] == POLICY_DECISION_ASK
