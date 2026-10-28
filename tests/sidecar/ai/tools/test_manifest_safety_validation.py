"""Manifest validation fails closed on the safety-bearing descriptor fields."""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.tools import catalog as catalog_module
from sidecar.ai.tools.catalog import _normalize_availability, _validate_manifest_entry


def _entry(**overrides: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "name": "probe_tool",
        "description": "Probe tool.",
        "parameters": {"type": "object", "properties": {}},
        "category": "builtin",
        "source_kind": "builtin",
        "side_effecting": False,
        "availability": {"workspace_required": True},
    }
    entry.update(overrides)
    return entry


def _rejects(entry: dict[str, Any], fragment: str) -> None:
    with pytest.raises(ValueError, match=fragment):
        _validate_manifest_entry(entry, index=0)


def test_valid_synthetic_entry_and_the_shipped_manifest_pass() -> None:
    _validate_manifest_entry(_entry(), index=0)
    catalog_module.clear_manifest_caches()
    try:
        assert catalog_module.manifest_descriptors()
    finally:
        catalog_module.clear_manifest_caches()


# C1-B: workspace_required must be explicit, and an absent key reads as required.
def test_workspace_required_must_be_declared() -> None:
    _rejects(_entry(availability={}), "workspace_required must be declared")
    entry = _entry()
    del entry["availability"]
    _rejects(entry, "missing required fields")


def test_absent_workspace_required_normalizes_fail_closed() -> None:
    assert _normalize_availability({}).workspace_required is True
    assert _normalize_availability(None).workspace_required is True
    assert _normalize_availability({"workspace_required": False}).workspace_required is False


# C1-C: side_effecting is required, a bool, and agrees with actions/read_only.
def test_side_effecting_is_required_and_bool() -> None:
    entry = _entry()
    del entry["side_effecting"]
    _rejects(entry, "missing required fields")
    _rejects(_entry(side_effecting="no"), "side_effecting must be a bool")


def test_read_scalar_with_a_write_action_is_rejected() -> None:
    _rejects(
        _entry(actions={"list": {"side_effecting": False}, "drop": {"side_effecting": True}}),
        "contradicts a write action",
    )
    _validate_manifest_entry(
        _entry(side_effecting=True, actions={"drop": {"side_effecting": True}}), index=0
    )


def test_read_only_with_side_effecting_is_rejected() -> None:
    _rejects(_entry(side_effecting=True, read_only=True), "cannot be read_only and side_effecting")
    _rejects(_entry(read_only="yes"), "read_only must be a bool")


# C1-D: actions and preconditions are validated instead of silently dropped.
@pytest.mark.parametrize(
    "actions",
    [
        {},
        [],
        {"a:b": {"side_effecting": False}},
        {"has space": {"side_effecting": False}},
        {" padded": {"side_effecting": False}},
        {"x" * 65: {"side_effecting": False}},
        {"list": {}},
        {"list": {"side_effecting": "false"}},
        {"list": {"side_effecting": False, "extra": 1}},
        {"list": True},
    ],
)
def test_malformed_actions_are_rejected(actions: Any) -> None:
    with pytest.raises(ValueError, match="probe_tool"):
        _validate_manifest_entry(_entry(actions=actions), index=0)


@pytest.mark.parametrize(
    "preconditions",
    [
        {},
        ["git_repo"],
        [{"id": "", "probe": "git_root_present"}],
        [{"id": "git_repo", "probe": "no_such_probe"}],
        [{"id": "git_repo", "probe": {"nested": True}}],
        [{"id": "git_repo", "probe": "git_root_present", "severity": "fatal"}],
        [{"id": "git_repo", "probe": "git_root_present", "extra": 1}],
        [
            {"id": "git_repo", "probe": "git_root_present"},
            {"id": "git_repo", "probe": "workspace_present"},
        ],
    ],
)
def test_malformed_preconditions_are_rejected(preconditions: Any) -> None:
    with pytest.raises(ValueError, match="probe_tool"):
        _validate_manifest_entry(_entry(preconditions=preconditions), index=0)


def test_valid_preconditions_pass() -> None:
    _validate_manifest_entry(
        _entry(preconditions=[
            {"id": "git_repo", "probe": "git_root_present", "severity": "blocking"},
            {"id": "workspace", "probe": "workspace_present"},
        ]),
        index=0,
    )


# C1-E: always_available bypasses every later gate, so only a plain read tool may use it.
def test_always_available_requires_a_read_only_action_free_tool() -> None:
    always = {"workspace_required": False, "always_available": True}
    _validate_manifest_entry(_entry(availability=always), index=0)
    _rejects(_entry(availability=always, side_effecting=True), "always_available")
    _rejects(
        _entry(
            availability=always, side_effecting=True, actions={"go": {"side_effecting": True}}
        ),
        "always_available",
    )
    _rejects(
        _entry(availability=always, actions={"look": {"side_effecting": False}}),
        "always_available",
    )
