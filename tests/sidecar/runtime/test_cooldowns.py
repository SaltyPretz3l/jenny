from __future__ import annotations

import copy

import pytest

from sidecar.runtime.cooldowns import CooldownRegistry


def test_cooldown_registry_marks_active_and_expires() -> None:
    now = 100.0
    registry = CooldownRegistry(clock=lambda: now)

    registry.mark("mcp", "docs", duration_seconds=10.0, reason="reconnect_failed")

    status = registry.status("mcp", "docs")
    assert status.active is True
    assert status.remaining_seconds == 10.0
    assert status.reason == "reconnect_failed"

    now = 111.0
    assert registry.status("mcp", "docs").active is False
    assert registry.snapshot() == ()


def test_cooldown_registry_snapshot_filters_namespace() -> None:
    registry = CooldownRegistry(clock=lambda: 5.0)
    registry.mark("provider", "ollama", duration_seconds=30.0, reason="rate_limit")
    registry.mark("tool", "web_search", duration_seconds=15.0, reason="rate_limit")

    provider_snapshot = registry.snapshot(namespace="provider")

    assert len(provider_snapshot) == 1
    assert provider_snapshot[0].namespace == "provider"
    assert provider_snapshot[0].name == "ollama"
    assert provider_snapshot[0].remaining_seconds == 30.0


def test_cooldown_registry_clear_removes_entry() -> None:
    registry = CooldownRegistry(clock=lambda: 1.0)
    registry.mark("mcp", "docs", duration_seconds=5.0, reason="reconnect_failed")

    registry.clear("mcp", "docs")

    assert registry.status("mcp", "docs").active is False


def test_quota_checkpoint_uses_elapsed_wall_time_and_new_monotonic_origin():
    wall = 1000.0
    original = CooldownRegistry(clock=lambda: 50.0, wall_clock=lambda: wall)
    original.mark("tool_quota", "web_search", duration_seconds=30, reason="web_per_turn")
    original.mark("provider", "private", duration_seconds=300, reason="rate_limit")
    saved = original.export_tool_quota()
    assert [item["name"] for item in saved["entries"]] == ["web_search"]
    wall += 12
    restored = CooldownRegistry(clock=lambda: 9000.0, wall_clock=lambda: wall)
    restored.mark("mcp", "other", duration_seconds=3)
    restored.restore_tool_quota(saved)
    assert restored.status("tool_quota", "web_search").remaining_seconds == 18
    assert restored.status("mcp", "other").active
    assert restored.export_tool_quota()["entries"] == saved["entries"]
    wall += 30
    restored.restore_tool_quota(saved)
    assert not restored.status("tool_quota", "web_search").active


@pytest.mark.parametrize("mutation", ["namespace", "duplicate", "expiry", "nan", "reason", "backwards"])
def test_quota_checkpoint_refuses_invalid_or_backwards_state_without_changing_registry(mutation):
    registry = CooldownRegistry(clock=lambda: 10.0, wall_clock=lambda: 1000.0)
    registry.mark("tool_quota", "web_search", duration_seconds=30, reason="web_per_turn")
    saved = copy.deepcopy(registry.export_tool_quota())
    if mutation == "namespace":
        saved["namespace"] = "provider"
    elif mutation == "duplicate":
        saved["entries"] *= 2
    elif mutation == "expiry":
        saved["entries"][0]["expires_at_ms"] += 8 * 24 * 60 * 60 * 1000
    elif mutation == "nan":
        saved["captured_at_ms"] = float("nan")
    elif mutation == "reason":
        saved["entries"][0]["reason"] = "provider_failure"
    else:
        saved["captured_at_ms"] += 1
    with pytest.raises(ValueError):
        registry.restore_tool_quota(saved)
    assert registry.status("tool_quota", "web_search").remaining_seconds == 30
