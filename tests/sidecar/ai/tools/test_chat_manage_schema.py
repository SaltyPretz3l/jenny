"""The ``chat_organize`` / ``chat_configure`` manifest schemas (row 94 P1) through the sidecar validator."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure, validate_tool_arguments
from sidecar.ai.tools.policy import _DEFAULT_TOOL_DEFAULTS, POLICY_DECISION_ASK

_MANIFEST = Path(__file__).resolve().parents[4] / "services" / "tools" / "tool-manifest.json"
_TOOLS = {tool["name"]: tool for tool in json.loads(_MANIFEST.read_text(encoding="utf-8"))["tools"]}
_NAMES = ("chat_organize", "chat_configure")


def _validate(name: str, arguments: object) -> object:
    return validate_tool_arguments(
        tool_name=name, arguments=arguments, input_schema=_TOOLS[name]["parameters"],
    )


@pytest.mark.parametrize(
    ("name", "arguments"),
    [
        ("chat_organize", {"session_id": "s1", "action": "rename", "value": "New title", "purpose": "x"}),
        ("chat_organize", {"session_id": "s1", "action": "pin", "purpose": "x"}),
        ("chat_organize", {"session_id": "s1", "action": "unpin", "purpose": "x"}),
        ("chat_organize", {"session_id": "s1", "action": "archive", "purpose": "x"}),
        ("chat_organize", {"session_id": "s1", "action": "unarchive", "purpose": "x"}),
        ("chat_configure", {"session_id": "s1", "action": "move_to_project", "value": "p1", "purpose": "x"}),
        ("chat_configure", {"session_id": "s1", "action": "set_model", "value": "qwen3", "purpose": "x"}),
        ("chat_configure", {"session_id": "s1", "action": "set_effort", "value": "high", "purpose": "x"}),
        ("chat_configure", {"session_id": "s1", "action": "set_run_mode", "value": "plan", "purpose": "x"}),
    ],
)
def test_valid_calls_are_accepted(name: str, arguments: dict[str, object]) -> None:
    assert _validate(name, arguments) == arguments


@pytest.mark.parametrize(
    ("name", "arguments"),
    [
        ("chat_organize", {"action": "pin", "purpose": "x"}),
        ("chat_organize", {"session_id": "s1", "purpose": "x"}),
        ("chat_organize", {"session_id": "s1", "action": "pin"}),
        ("chat_organize", {"session_id": "s1", "action": "pin", "purpose": ""}),
        ("chat_organize", {"session_id": "s1", "action": "pin", "purpose": "x" * 201}),
        ("chat_organize", {"session_id": "s1", "action": "delete", "purpose": "x"}),
        ("chat_organize", {"session_id": "s1", "action": "set_model", "value": "m", "purpose": "x"}),
        ("chat_organize", {"session_id": "s1", "action": "rename", "value": "x" * 201, "purpose": "x"}),
        ("chat_organize", {"session_id": "s1", "action": "pin", "purpose": "x", "extra": 1}),
        ("chat_configure", {"session_id": "s1", "action": "rename", "value": "t", "purpose": "x"}),
        ("chat_configure", {"session_id": "s1", "action": "set_effort", "value": 3, "purpose": "x"}),
        ("chat_configure", {"session_id": "s1", "action": "set_run_mode", "value": "plan", "purpose": "x", "x": 1}),
    ],
)
def test_malformed_calls_are_rejected(name: str, arguments: object) -> None:
    with pytest.raises(ToolExecutionFailure):
        _validate(name, arguments)


def test_policy_defaults_both_ask() -> None:
    for name in _NAMES:
        assert _DEFAULT_TOOL_DEFAULTS[name] == POLICY_DECISION_ASK
