"""Regression coverage for builtin-server transport metadata."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server
from sidecar.ai.mcp.builtin_server import BuiltinTool
from sidecar.ai.tools.builtins.skills import _reset_skill_tool_state
from sidecar.ai.tools.workspace import WorkspaceGuard

REPO_ROOT = Path(__file__).resolve().parents[4]
TOOL_MANIFEST = REPO_ROOT / "services" / "tools" / "tool-manifest.json"
# Driven by the production constant so a newly injected ``_jenny_*`` key cannot
# silently re-open the 74ddbc9c regression for additionalProperties:false tools.
TRANSPORT_ARGUMENTS = {
    key: {"_jenny_read_only": True, "_jenny_approved_plan": {"id": "plan_test"}}.get(key, f"{key}_test")
    for key in builtin_server.TRANSPORT_ARGUMENT_KEYS
}
assert {"_jenny_trace_id", "_jenny_session_id", "_jenny_read_only"} <= set(TRANSPORT_ARGUMENTS)


def _strict_manifest_tools() -> list[dict[str, object]]:
    manifest = json.loads(TOOL_MANIFEST.read_text(encoding="utf-8"))
    tools = [
        tool
        for tool in manifest["tools"]
        if tool.get("parameters", {}).get("additionalProperties") is False
    ]
    assert tools
    assert "load_skill" in {tool["name"] for tool in tools}
    return tools


STRICT_TOOLS = _strict_manifest_tools()


def _minimal_value(schema: dict[str, object], *, field_name: str = "") -> object:
    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        return enum[0]
    value_type = schema.get("type")
    if value_type == "object":
        properties = schema.get("properties", {})
        required = list(schema.get("required", []))
        any_of = schema.get("anyOf")
        if isinstance(any_of, list) and any_of and isinstance(any_of[0], dict):
            required.extend(n for n in any_of[0].get("required", []) if n not in required)
        return {
            name: _minimal_value(properties[name], field_name=name)
            for name in required
        }
    if value_type == "array":
        return [_minimal_value(schema.get("items", {}), field_name=field_name)]
    if value_type == "boolean":
        return True
    if value_type in {"integer", "number"}:
        return 1
    return "verification-specialist" if field_name == "name" else "value"


def _minimal_arguments(tool: dict[str, object]) -> dict[str, object]:
    schema = tool["parameters"]
    arguments = _minimal_value(schema)
    assert isinstance(arguments, dict)
    if tool["name"] == "load_skill":
        arguments["scope"] = "bundled"
    return arguments


@pytest.mark.parametrize("manifest_tool", STRICT_TOOLS, ids=lambda tool: tool["name"])
def test_prepare_call_arguments_preserves_transport_keys_for_strict_schemas(
    manifest_tool: dict[str, object], tmp_path: Path
) -> None:
    tool = BuiltinTool(
        name=str(manifest_tool["name"]),
        description="test",
        side_effecting=False,
        input_schema=manifest_tool["parameters"],
        handler=lambda _arguments, _workspace: "ok",
    )
    arguments = {**_minimal_arguments(manifest_tool), **TRANSPORT_ARGUMENTS}

    prepared, operation_id, _scope = builtin_server._prepare_call_arguments(  # noqa: SLF001
        tool,
        arguments,
        WorkspaceGuard(str(tmp_path)),
    )

    assert prepared["_jenny_trace_id"] == TRANSPORT_ARGUMENTS["_jenny_trace_id"]
    assert prepared["_jenny_operation_id"] == TRANSPORT_ARGUMENTS["_jenny_operation_id"]
    assert operation_id == TRANSPORT_ARGUMENTS["_jenny_operation_id"]


def test_load_skill_call_accepts_trace_id_and_returns_bundled_body(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    skill_dir = bundled_root / "verification-specialist"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: Verification Specialist\ndescription: Test skill.\n---\nBundled body.\n",
        encoding="utf-8",
    )
    _reset_skill_tool_state()
    try:
        tools = builtin_server._default_tools(  # noqa: SLF001
            workspace_root_present=True,
            skills_bundled_root=str(bundled_root),
        )
        response = builtin_server._handle_tools_call(  # noqa: SLF001
            "load-skill-call",
            tools,
            WorkspaceGuard(str(tmp_path)),
            {
                "name": "load_skill",
                "arguments": {
                    "name": "verification-specialist",
                    "scope": "bundled",
                    "_jenny_trace_id": "trace_load_skill",
                },
            },
        )
    finally:
        _reset_skill_tool_state()

    assert "error" not in response
    assert "Bundled body." in response["result"]["content"][0]["text"]
