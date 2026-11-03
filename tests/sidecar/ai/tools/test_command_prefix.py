"""Row 103: the Python half of the command-prefix derivation.

The fixture is shared with ``tests/command-prefix.test.js`` so the sidecar
matcher and the Electron grant/evaluator agree on every case.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.tools.command_prefix import (
    MAX_COMMAND_CHARS,
    RUNNER_SUBCOMMANDS,
    WRAPPER_PROGRAMS,
    command_matches_exact,
    command_matches_prefix,
    derive_command_scope,
)

_FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "fixtures" / "command-prefix-cases.json").read_text(
        encoding="utf-8"
    )
)


def test_fixture_carries_at_least_forty_cases() -> None:
    assert len(_FIXTURE["cases"]) >= 40
    scopes = {entry["expected"]["scope"] for entry in _FIXTURE["cases"]}
    assert scopes == {"prefix", "exact", "none"}


@pytest.mark.parametrize("entry", _FIXTURE["cases"], ids=lambda entry: repr(entry["command"]))
def test_derivation_matches_fixture(entry: dict[str, Any]) -> None:
    result = derive_command_scope(entry["command"])
    expected = entry["expected"]
    assert result.scope == expected["scope"]
    if expected["scope"] == "prefix":
        assert result.prefix == expected["prefix"]
    if expected["scope"] == "exact":
        assert result.command == expected["command"]


@pytest.mark.parametrize(
    "entry", _FIXTURE["prefix_matches"], ids=lambda entry: f"{entry['prefix']}|{entry['command']}"
)
def test_prefix_matching_matches_fixture(entry: dict[str, Any]) -> None:
    assert command_matches_prefix(entry["command"], entry["prefix"]) is entry["matches"]


@pytest.mark.parametrize(
    "entry", _FIXTURE["exact_matches"], ids=lambda entry: f"{entry['exact']}|{entry['command']}"
)
def test_exact_matching_matches_fixture(entry: dict[str, Any]) -> None:
    assert command_matches_exact(entry["command"], entry["exact"]) is entry["matches"]


def test_wrapper_and_runner_constants_are_frozen() -> None:
    assert isinstance(WRAPPER_PROGRAMS, frozenset)
    assert isinstance(RUNNER_SUBCOMMANDS, frozenset)
    for name in ("cmd", "powershell", "bash", "sudo", "python", "node", "java"):
        assert name in WRAPPER_PROGRAMS
    assert "dotnet" not in WRAPPER_PROGRAMS
    assert sorted(RUNNER_SUBCOMMANDS) == ["dlx", "exec", "run", "tool", "x"]


def test_command_longer_than_the_cap_has_no_always_allow() -> None:
    long_args = "a" * MAX_COMMAND_CHARS
    assert derive_command_scope(f"npm test {long_args}").scope == "none"
    assert command_matches_prefix(f"npm test {long_args}", "npm test") is False
    assert derive_command_scope(f"npm test {'a' * (MAX_COMMAND_CHARS - 9)}").scope == "prefix"


@pytest.mark.parametrize("value", [None, 42, ["npm", "test"], {"command": "npm test"}])
def test_non_string_commands_never_derive_or_match(value: object) -> None:
    assert derive_command_scope(value).scope == "none"
    assert command_matches_prefix(value, "npm test") is False
    assert command_matches_exact(value, "npm test") is False
