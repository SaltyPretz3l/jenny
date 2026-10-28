"""Registry lookups that only need the binding set must not reset tool settings."""

from __future__ import annotations

import pytest

from sidecar.ai.routing import tool_execution_results
from sidecar.ai.tools import registry as registry_module
from sidecar.ai.tools.registry import build_default_registry
from sidecar.ai.tools.tool_call_healing import (
    configure_tool_call_healing,
    default_tool_call_healing_enabled,
    restore_tool_call_healing_default,
)


def test_side_effecting_map_keeps_configured_process_settings() -> None:
    previous = default_tool_call_healing_enabled()
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    tool_execution_results._side_effecting_by_tool.cache_clear()
    try:
        side_effecting = tool_execution_results._side_effecting_by_tool()
        assert side_effecting["read_file"] is False
        assert side_effecting["write_file"] is True
        assert default_tool_call_healing_enabled() is True
    finally:
        tool_execution_results._side_effecting_by_tool.cache_clear()
        restore_tool_call_healing_default(previous)


def test_no_configure_registry_matches_the_configured_binding_set() -> None:
    previous = default_tool_call_healing_enabled()
    try:
        assert set(build_default_registry(config=None, configure=False)) == set(
            build_default_registry(config=None)
        )
    finally:
        restore_tool_call_healing_default(previous)


def test_python_execute_binding_follows_the_manifest_platforms(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = {"tools_python_runtime_enabled": True}
    seen: list[str] = []

    def _unsupported(name: str, platform: str | None = None) -> bool:
        seen.append(name)
        return False

    monkeypatch.setattr(registry_module, "manifest_platform_supported", _unsupported)
    bindings = registry_module.build_tool_bindings(config=config, configure=False)

    assert "python_execute" not in bindings
    assert seen == ["python_execute"]
