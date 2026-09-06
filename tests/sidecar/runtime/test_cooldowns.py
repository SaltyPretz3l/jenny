from __future__ import annotations

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
