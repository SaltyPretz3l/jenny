from __future__ import annotations

import hashlib
import json

import pytest

from sidecar.ai.mcp.tool_surface import MAX_TOOLS, summarize_tools, tools_digest


@pytest.mark.parametrize("change", [
    {"side_effecting": False},
    {"actions": {"read": {"side_effecting": False}}},
    {"actions": {"read": {"side_effecting": True}}},
])
def test_digest_covers_execution_policy(change: dict) -> None:
    original = {"name": "lookup", "description": "Search", "inputSchema": {"type": "object"}}
    before, _ = summarize_tools([original])
    after, _ = summarize_tools([{**original, **change}])
    assert tools_digest(before) != tools_digest(after)


@pytest.mark.parametrize("tools", [
    [{"name": f"tool_{index}"} for index in range(MAX_TOOLS + 1)],
    [{"name": "bad", "inputSchema": {"description": "x" * 5000}}],
    [{"name": "x" * 129}],
    [{"name": "tool", "description": "x" * 513}],
    [{"description": "missing name"}],
])
def test_incomplete_surface_is_rejected(tools: list) -> None:
    with pytest.raises(ValueError):
        summarize_tools(tools)


def test_digest_version_invalidates_existing_approvals() -> None:
    tools, _ = summarize_tools([{"name": "lookup"}])
    legacy = [{"name": "lookup", "description": "", "schema_digest": hashlib.sha256(b"{}").hexdigest()}]
    old_digest = hashlib.sha256(json.dumps(legacy, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert tools_digest(tools) != old_digest


def test_duplicate_tool_names_are_rejected() -> None:
    with pytest.raises(ValueError):
        summarize_tools([{"name": "lookup"}, {"name": " lookup ", "description": "Changed"}])
