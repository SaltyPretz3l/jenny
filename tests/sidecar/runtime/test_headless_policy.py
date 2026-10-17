"""Automatic CLI decisions cannot be bypassed by stored/default auto policy."""
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.policy import evaluate_tool_policy
from sidecar.runtime.headless_policy import constrain_automatic_tool_policy


@pytest.mark.parametrize("mode", ["auto-readonly", "auto-tools"])
@pytest.mark.parametrize("tool", ["read_file", "fetch_url", "web_search", "write_file", "new_mcp_tool", "conversations_recent", "conversation_open", "conversations_search"])
def test_every_tool_requires_cli_decision(mode, tool):
    config = constrain_automatic_tool_policy({"tool_policy_snapshot": {
        "rules": [{"id": "auto", "decision": "auto", "match": {}}],
        "legacy_policies": {"read_file": "auto"},
    }}, mode=mode)
    descriptor = SimpleNamespace(name=tool, read_only=True)
    result = evaluate_tool_policy(descriptor=descriptor, arguments={}, mode="assist",
                                  snapshot=config["tool_policy_snapshot"])
    assert result.decision == "ask"


@pytest.mark.parametrize("snapshot", [
    {"read_file": "deny"},
    {"rules": [{"id": "deny", "decision": "deny", "match": {"tool_id": "read_file"}}]},
    {"legacy_policies": {"project_notes:read": "deny"}},
])
def test_configured_denial_survives(snapshot):
    config = constrain_automatic_tool_policy({"tool_policy_snapshot": snapshot}, mode="auto-readonly")
    action_policy = "project_notes:read" in snapshot.get("legacy_policies", {})
    descriptor = SimpleNamespace(name="project_notes" if action_policy else "read_file", read_only=True)
    result = evaluate_tool_policy(descriptor=descriptor, arguments={"action": "read"}, mode="assist",
                                  snapshot=config["tool_policy_snapshot"])
    assert result.decision == "deny"


@pytest.mark.parametrize("mode", ["prompt", "dangerously-skip"])
def test_other_modes_keep_config(mode):
    config = {"engine_type": "replay"}
    assert constrain_automatic_tool_policy(config, mode=mode) is config
