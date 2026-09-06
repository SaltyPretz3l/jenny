"""Red-first: MCP retry keys on (tool, action), not the tool alone (W6).

`retry_policy.py` replays a failed call only when repeating it cannot duplicate
side effects. Today the client passes the DESCRIPTOR's side_effecting, so
after a W7 family merge a read-only listing under a side-effecting merged tool
would silently become non-retryable — the exact containment regression the
spec's §6.3 prerequisite exists to prevent. The client must resolve the
call's effective side-effect class from declared actions, failing closed for
unknown actions.
"""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.mcp.client_support import descriptor_from_payload
from sidecar.ai.mcp.exceptions import CMP_MCP_SERVER_FAILED, MCPError
from tests.sidecar.ai.mcp.test_client import _configured_client, _FakeTransport


def _actioned_tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "worktree",
            "input_schema": {"type": "object"},
            "side_effecting": True,
            "actions": {
                "list": {"side_effecting": False},
                "delete": {"side_effecting": True},
            },
        }
    ]


def _transport_pair(message: str) -> tuple[_FakeTransport, _FakeTransport]:
    tools = _actioned_tools()
    first = _FakeTransport(
        "docs",
        tools,
        failures=[
            MCPError(code=CMP_MCP_SERVER_FAILED, message=message, retryable=True)
        ],
    )
    second = _FakeTransport("docs", tools)
    return first, second


def test_read_action_is_replayed_after_reconnect(monkeypatch: pytest.MonkeyPatch) -> None:
    first, second = _transport_pair("mcp server 'docs' closed its pipe unexpectedly")
    client = _configured_client(monkeypatch, [first, second])

    result = client.execute_tool("mcp__docs__worktree", {"action": "list"})

    assert result.output == "worktree ok"
    assert first.calls == [("worktree", {"action": "list"})]
    assert second.calls == [("worktree", {"action": "list"})]
    assert result.metadata["mcp_retry_count"] == 1


def test_write_action_is_never_replayed(monkeypatch: pytest.MonkeyPatch) -> None:
    first, second = _transport_pair("mcp server 'docs' response timed out")
    client = _configured_client(monkeypatch, [first, second])

    with pytest.raises(MCPError, match="response timed out"):
        client.execute_tool("mcp__docs__worktree", {"action": "delete"})

    assert first.calls == [("worktree", {"action": "delete"})]
    assert second.calls == []


def test_unknown_action_fails_closed_and_is_never_replayed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first, second = _transport_pair("mcp server 'docs' response timed out")
    client = _configured_client(monkeypatch, [first, second])

    with pytest.raises(MCPError, match="response timed out"):
        client.execute_tool("mcp__docs__worktree", {"action": "explode"})

    assert first.calls == [("worktree", {"action": "explode"})]
    assert second.calls == []


def test_replay_aborts_when_the_registry_flips_to_write_between_check_and_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Adversarial-review F4 (TOCTOU): the replay-safety check runs against the
    # post-reconnect descriptor, but the loop then RE-resolves the registry
    # before calling. A re-registration landing in that window can swap in a
    # descriptor whose same action is now a write; the replay must be aborted
    # (original error re-raised), never executed against the flipped
    # descriptor. The shim below lands the flip deterministically inside the
    # window.
    first, second = _transport_pair("mcp server 'docs' closed its pipe unexpectedly")
    client = _configured_client(monkeypatch, [first, second])
    flipped = descriptor_from_payload(
        "docs",
        {
            "name": "worktree",
            "input_schema": {"type": "object"},
            "side_effecting": True,
            "actions": {"list": {"side_effecting": True}},
        },
    )
    assert flipped is not None
    original_refresh = client._refreshed_replay_descriptor

    def refresh_then_flip(descriptor, arguments):
        refreshed = original_refresh(descriptor, arguments)
        client._tools_by_name[flipped.name] = flipped
        return refreshed

    monkeypatch.setattr(client, "_refreshed_replay_descriptor", refresh_then_flip)

    with pytest.raises(MCPError, match="closed its pipe"):
        client.execute_tool("mcp__docs__worktree", {"action": "list"})

    assert first.calls == [("worktree", {"action": "list"})]
    assert second.calls == []
