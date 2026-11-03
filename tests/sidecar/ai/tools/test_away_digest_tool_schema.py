"""The ``away_digest`` manifest schema (row 86 S3) through the sidecar validator, its policy and family."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.tools.contracts import ToolExecutionFailure, validate_tool_arguments
from sidecar.ai.tools.policy import _DEFAULT_TOOL_DEFAULTS, POLICY_DECISION_AUTO
from sidecar.ai.tools.tool_families import TOOL_FAMILY_NAMES

_MANIFEST = Path(__file__).resolve().parents[4] / "services" / "tools" / "tool-manifest.json"
_TOOLS = {tool["name"]: tool for tool in json.loads(_MANIFEST.read_text(encoding="utf-8"))["tools"]}


def _validate(arguments: object) -> object:
    return validate_tool_arguments(
        tool_name="away_digest",
        arguments=arguments,
        input_schema=_TOOLS["away_digest"]["parameters"],
    )


@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"since": "2026-11-02T08:00:00Z"},
        {"since": "2026-11-02T08:00Z"},
        {"since": "2026-11-02T08:00:00.123+05:30"},
        {"since": "2026-11-02T08:00:00-06:00"},
    ],
)
def test_well_formed_calls_validate(arguments: object) -> None:
    _validate(arguments)


@pytest.mark.parametrize(
    "arguments",
    [
        {"since": 1730534400},
        {"since": "yesterday"},
        {"since": "2026-11-02"},
        {"since": "2026-11-02T08:00:00"},
        {"since": "2026-11-02 08:00:00Z"},
        {"since": "2026-11-02T08:00:00Z" + " " * 30},
        {"extra": 1},
        {"since": "2026-11-02T08:00:00Z", "until": "2026-11-02T09:00:00Z"},
    ],
)
def test_malformed_calls_are_rejected(arguments: object) -> None:
    with pytest.raises(ToolExecutionFailure):
        _validate(arguments)


def test_manifest_entry_is_read_only_electron_and_default_off() -> None:
    entry = _TOOLS["away_digest"]
    assert entry["owner"] == "electron"
    assert entry["read_only"] is True
    assert entry["side_effecting"] is False
    assert entry["availability"]["config_flag"] == "tools_primary_digests_enabled"
    assert entry["parameters"]["additionalProperties"] is False
    assert _DEFAULT_TOOL_DEFAULTS["away_digest"] == POLICY_DECISION_AUTO
    assert "away_digest" in {name for names in TOOL_FAMILY_NAMES.values() for name in names}
    assert parse_runtime_config({}).tools_primary_digests_enabled is False
    assert (
        parse_runtime_config({"tools_primary_digests_enabled": True}).tools_primary_digests_enabled
        is True
    )
