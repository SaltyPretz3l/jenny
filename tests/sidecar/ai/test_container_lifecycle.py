from __future__ import annotations

import threading

from sidecar.ai.container_lifecycle import StackGenerationOwner


def test_retired_stack_closes_once_after_final_generation_lease() -> None:
    closed: list[object] = []
    owner = StackGenerationOwner(closed.append)
    old_stack = object()
    new_stack = object()
    entered = threading.Event()
    release = threading.Event()
    observed: list[object] = []

    owner.publish(old_stack)

    def _hold_old_generation() -> None:
        with owner.lease() as leased:
            observed.append(leased)
            entered.set()
            assert release.wait(timeout=2.0)
            observed.append(owner.current_stack)

    worker = threading.Thread(target=_hold_old_generation)
    worker.start()
    assert entered.wait(timeout=2.0)

    owner.publish(new_stack)
    assert owner.current_stack is new_stack
    assert closed == []

    release.set()
    worker.join(timeout=3.0)

    assert observed == [old_stack, old_stack]
    assert closed == [old_stack]
    owner.retire_all()
    owner.retire_all()
    assert closed == [old_stack, new_stack]


def test_a_leased_old_generation_keeps_serving_a_server_its_successor_adopted(
    monkeypatch,
) -> None:
    # Row 53 S3: the successor adopts the live transport at build time, while
    # the old generation still holds a lease. The old generation keeps serving
    # the server until its lease drains, and its retirement never closes it.
    from typing import Any

    from sidecar.ai.config import MCPServerConfig
    from sidecar.ai.mcp.client import MCPClient
    from sidecar.ai.mcp.transport_base import MCPTransport

    class _Transport(MCPTransport):
        server_name = "rea"
        close_calls = 0

        def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return [{"name": "lookup", "description": "Look up.", "inputSchema": {"type": "object"}}]

        def call_tool(self, tool_name: str, arguments: dict[str, Any], **_kwargs: Any) -> Any:
            return {"content": [{"type": "text", "text": "ok"}]}

        def list_resources(self, **_kwargs: Any) -> dict[str, Any]:
            return {"resources": []}

        def read_resource(self, uri: str, **_kwargs: Any) -> dict[str, Any]:
            return {"contents": []}

        def list_resource_templates(self, **_kwargs: Any) -> dict[str, Any]:
            return {"resourceTemplates": []}

        def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return []

        def get_prompt(self, name: str, arguments: dict[str, str], **_kwargs: Any) -> dict[str, Any]:
            raise NotImplementedError

        def close(self) -> None:
            self.close_calls += 1

    spawned: list[_Transport] = []

    def _build(_client: MCPClient, _server: MCPServerConfig, **_kwargs: Any) -> _Transport:
        spawned.append(_Transport())
        return spawned[-1]

    monkeypatch.setattr(MCPClient, "_build_transport", _build)
    servers = (MCPServerConfig(name="rea", transport="stdio", command="rea"),)
    owner = StackGenerationOwner(lambda client: client.close())
    old_client = MCPClient()
    old_client.configure(servers, sse_enabled=False)
    owner.publish(old_client)

    with owner.lease() as leased:
        new_client = MCPClient()
        new_client.configure(servers, sse_enabled=False, reuse_from=old_client)
        owner.publish(new_client)
        assert leased.execute_tool("mcp__rea__lookup", {}).output == "ok"
        assert spawned[0].close_calls == 0

    assert len(spawned) == 1
    assert spawned[0].close_calls == 0
    assert new_client.execute_tool("mcp__rea__lookup", {}).output == "ok"
    owner.retire_all()
    assert spawned[0].close_calls == 1
