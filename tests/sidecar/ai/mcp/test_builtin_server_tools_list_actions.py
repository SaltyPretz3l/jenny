"""W7b-S3(a): builtin_server tools/list forwards per-action safety metadata.

The MCP client already parses an ``actions`` payload key at
``descriptor_from_payload`` (W6); this suite pins the server half of that
loop: a registered :class:`BuiltinTool` carrying an actions dict must emit
``"actions": {name: {"side_effecting": bool}}`` in the tools/list payload,
serialized explicitly (values are :class:`ToolActionSpec`, not plain dicts),
and an actionless tool must omit the key entirely.
"""

from __future__ import annotations

import json

from sidecar.ai.mcp.builtin_server import BuiltinTool, _handle_tools_list
from sidecar.ai.mcp.client_support import descriptor_from_payload
from sidecar.ai.tools.tool_actions import ToolActionSpec


def _tool(
    name: str,
    *,
    side_effecting: bool,
    actions: dict[str, ToolActionSpec] | None = None,
) -> BuiltinTool:
    return BuiltinTool(
        name=name,
        description=f"{name} fixture tool",
        side_effecting=side_effecting,
        input_schema={"type": "object", "properties": {}},
        handler=lambda **_kwargs: None,  # type: ignore[arg-type,return-value]
        actions=actions,
    )


_MIXED_ACTIONS = {
    "hover": ToolActionSpec(side_effecting=False),
    "apply": ToolActionSpec(side_effecting=True),
}


def _list_payload(tools: dict[str, BuiltinTool]) -> list[dict[str, object]]:
    response = _handle_tools_list("msg-1", tools)
    result = response["result"]
    assert isinstance(result, dict)
    payload = result["tools"]
    assert isinstance(payload, list)
    return payload


def test_actioned_tool_emits_explicit_actions_payload() -> None:
    tools = {"lsp": _tool("lsp", side_effecting=True, actions=dict(_MIXED_ACTIONS))}
    (entry,) = _list_payload(tools)
    assert entry["name"] == "lsp"
    assert entry["actions"] == {
        "hover": {"side_effecting": False},
        "apply": {"side_effecting": True},
    }


def test_actionless_tool_omits_actions_key() -> None:
    tools = {"read_file": _tool("read_file", side_effecting=False)}
    (entry,) = _list_payload(tools)
    assert "actions" not in entry


def test_actions_payload_is_json_serializable() -> None:
    tools = {"lsp": _tool("lsp", side_effecting=True, actions=dict(_MIXED_ACTIONS))}
    response = _handle_tools_list("msg-1", tools)
    # ToolActionSpec dataclasses must never leak into the wire payload.
    json.dumps(response)


def test_actions_payload_round_trips_through_client_parser() -> None:
    tools = {"lsp": _tool("lsp", side_effecting=True, actions=dict(_MIXED_ACTIONS))}
    (entry,) = _list_payload(tools)
    descriptor = descriptor_from_payload("builtin", dict(entry))
    assert descriptor is not None
    assert descriptor.actions == _MIXED_ACTIONS
    # Scalar-coercion invariant: a write action present keeps the scalar True.
    assert descriptor.side_effecting is True
