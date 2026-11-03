"""The ``schedule_list`` / ``schedule_change`` manifest schemas (row 85 S4) through the sidecar validator."""

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
_DAILY = {"type": "daily_at", "daily_at": "08:00", "weekdays": [1, 2, 3, 4, 5]}


def _validate(name: str, arguments: object) -> object:
    return validate_tool_arguments(tool_name=name, arguments=arguments, input_schema=_TOOLS[name]["parameters"])


@pytest.mark.parametrize(
    ("name", "arguments"),
    [
        ("schedule_list", {}),
        ("schedule_list", {"include_reminders": True}),
        ("schedule_change", {"action": "create", "label": "Morning", "instruction": "Summarize.", "cadence": _DAILY, "purpose": "x"}),
        ("schedule_change", {"action": "create", "label": "PR", "instruction": "Check CI.",
                             "cadence": {"type": "once_at", "once_at": "2026-11-06T16:00"}, "purpose": "x"}),
        ("schedule_change", {"action": "update", "reminder_id": "rem_1",
                             "cadence": {"type": "interval_minutes", "interval_minutes": 120}, "purpose": "x"}),
        ("schedule_change", {"action": "disable", "reminder_id": "rem_1", "purpose": "x"}),
        ("schedule_change", {"action": "cancel", "reminder_id": "rem_1", "purpose": "x"}),
    ],
)
def test_well_formed_calls_validate(name: str, arguments: object) -> None:
    _validate(name, arguments)


@pytest.mark.parametrize(
    ("name", "arguments"),
    [
        ("schedule_list", {"include_reminders": "yes"}),
        ("schedule_list", {"extra": 1}),
        ("schedule_change", {"action": "create", "label": "x", "instruction": "y", "cadence": _DAILY}),
        ("schedule_change", {"action": "delete", "reminder_id": "rem_1", "purpose": "x"}),
        ("schedule_change", {"action": "cancel", "reminder_id": "rem_1", "purpose": "x", "extra": 1}),
        ("schedule_change", {"action": "cancel", "reminder_id": "rem_1", "purpose": "x" * 201}),
        ("schedule_change", {"action": "update", "reminder_id": "rem_1", "purpose": "x",
                             "cadence": {"type": "interval_minutes", "interval_minutes": 5}}),
        ("schedule_change", {"action": "update", "reminder_id": "rem_1", "purpose": "x",
                             "cadence": {"type": "daily_at", "daily_at": "08:00", "weekdays": [7]}}),
        ("schedule_change", {"action": "update", "reminder_id": "rem_1", "purpose": "x",
                             "cadence": {"type": "daily_at", "daily_at": "08:00", "extra": 1}}),
        ("schedule_change", {"action": "update", "reminder_id": "rem_1", "purpose": "x", "cadence": {"type": "weekly"}}),
    ],
)
def test_malformed_calls_are_rejected(name: str, arguments: object) -> None:
    with pytest.raises(ToolExecutionFailure):
        _validate(name, arguments)


def test_policy_defaults_list_auto_change_ask() -> None:
    assert _DEFAULT_TOOL_DEFAULTS["schedule_list"] == POLICY_DECISION_AUTO
    assert _DEFAULT_TOOL_DEFAULTS["schedule_change"] == POLICY_DECISION_ASK
