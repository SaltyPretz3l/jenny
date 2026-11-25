"""Row 197: the sidecar half of the Live tab's tools (run_view_look, run_view_restart).

The flag parses and defaults off, the policy default is auto for both, the restart's transport wait
covers a build, the look's picture is admitted from the trusted bridge only, and both tools sit in the
workspace family, which a delegate is never granted.
"""

from __future__ import annotations

import base64
from types import SimpleNamespace

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.config_models import RuntimeConfig
from sidecar.ai.mcp.models import MCPToolDescriptor, MCPToolResult
from sidecar.ai.routing.iteration_limits import (
    RUN_VIEW_RESTART_TIMEOUT_SECONDS,
    tool_timeout_for_runtime,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.preview_vision import admit_preview
from sidecar.ai.routing.sub_agent_invocation import (
    DEFAULT_ALLOWED_TOOL_FAMILIES,
    build_subagent_tool_preferences,
)
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.policy_rules import _DEFAULT_TOOL_DEFAULTS, POLICY_DECISION_AUTO
from sidecar.ai.tools.tool_families import TOOL_FAMILY_NAMES
from sidecar.runtime import electron_tool_bridge as bridge

PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD"
    "/YURmXYAAAAASUVORK5CYII="
)
TOOLS = ("run_view_look", "run_view_restart")


def _parse(**overrides: object) -> RuntimeConfig:
    return parse_runtime_config({"engine_type": "vllm", "model": "Qwen/Qwen3.5-9B", **overrides})


def _wire(call_id: str) -> dict[str, object]:
    return {
        "call_id": call_id, "mime_type": "image/png", "width": 2, "height": 1,
        "data_base64": PNG_BASE64, "byte_length": len(base64.b64decode(PNG_BASE64)),
    }


def _descriptor(name: str, server_name: str = "electron_tool_bridge") -> MCPToolDescriptor:
    return MCPToolDescriptor(name=name, description="", input_schema={}, side_effecting=False,
                             source_kind="builtin", server_name=server_name)


def _admit(tool_id: str, *, vision: bool = True, server_name: str = "electron_tool_bridge",
           runtime: LoopRuntime | None = None) -> tuple[str, str]:
    call = ToolCallRequest(tool_id=tool_id, call_id="look-1", arguments={})
    return admit_preview(
        runtime or LoopRuntime(request_id="req-look"), SimpleNamespace(capabilities={"vision": vision}), call,
        MCPToolResult(tool_id, "Live picture", True, preview_image=_wire("look-1")),
        _descriptor(tool_id, server_name),
    )


def test_the_flag_defaults_off_and_parses_only_a_real_true() -> None:
    assert RuntimeConfig.__dataclass_fields__["tools_run_view_enabled"].default is False
    assert _parse().tools_run_view_enabled is False
    assert _parse(tools_run_view_enabled=True).tools_run_view_enabled is True
    assert _parse(tools_run_view_enabled="nope").tools_run_view_enabled is False


def test_both_tools_default_to_auto() -> None:
    for name in TOOLS:
        assert _DEFAULT_TOOL_DEFAULTS[name] == POLICY_DECISION_AUTO


def test_the_restart_wait_covers_a_build_and_the_look_keeps_the_ordinary_wait() -> None:
    config = SimpleNamespace(engine_type="ollama", feature_flags={}, tools_execution_timeout_seconds=30,
                             host_mode="desktop")
    restart = SimpleNamespace(tool_id="run_view_restart", arguments={})
    look = SimpleNamespace(tool_id="run_view_look", arguments={})
    assert tool_timeout_for_runtime(config, None, restart) == RUN_VIEW_RESTART_TIMEOUT_SECONDS
    assert RUN_VIEW_RESTART_TIMEOUT_SECONDS > 600  # the build-step limit is 10 minutes
    assert tool_timeout_for_runtime(config, None, look) == 30


def test_the_restart_wait_is_not_cut_short_by_the_remaining_working_time() -> None:
    config = SimpleNamespace(engine_type="ollama", feature_flags={}, tools_execution_timeout_seconds=30,
                             host_mode="desktop")
    runtime = LoopRuntime(clock=lambda: 1000.0)
    runtime.wall_clock_deadline = 1100.0  # 100 s of working time left
    restart = SimpleNamespace(tool_id="run_view_restart", arguments={})
    look = SimpleNamespace(tool_id="run_view_look", arguments={})
    assert tool_timeout_for_runtime(config, runtime, restart) == RUN_VIEW_RESTART_TIMEOUT_SECONDS
    assert tool_timeout_for_runtime(config, runtime, look) == 30


def test_a_look_picture_is_queued_for_a_vision_model_from_the_trusted_bridge_only() -> None:
    runtime = LoopRuntime(request_id="req-look")
    assert _admit("run_view_look", runtime=runtime)[0] == "queued"
    assert runtime.preview_images["look-1"].tool_id == "run_view_look"
    assert _admit("run_view_look", vision=False)[0] == "unsupported"
    assert _admit("run_view_look", server_name="jenny_builtin") == ("", "")
    assert _admit("run_view_restart") == ("", "")


def test_the_bridge_keeps_the_look_picture_for_its_own_call_only() -> None:
    def run(tool_name: str, preview_call: str) -> MCPToolResult:
        payload = {"tool_name": tool_name, "output": "ok", "success": True, "preview_image": _wire(preview_call)}

        def factory(expected_id: int, **_kwargs: object):
            return lambda _timeout: {"jsonrpc": "2.0", "id": expected_id, "result": payload}

        return bridge.execute_electron_tool(bridge.ElectronToolBridgeRequest(
            tool_name=tool_name, arguments={}, request_id="req", trace_id="trace", session_id="session",
            tool_call_id="call-1", write_message=lambda _m: None, read_message=None,
            response_reader_factory=factory, timeout_seconds=1.0,
        ))

    assert run("run_view_look", "call-1").preview_image["call_id"] == "call-1"
    assert run("run_view_look", "someone-else").preview_image is None
    assert run("run_view_restart", "call-1").preview_image is None


def test_both_tools_are_workspace_family_which_a_delegate_never_gets() -> None:
    for name in TOOLS:
        assert name in TOOL_FAMILY_NAMES["workspace"]
    assert "workspace" not in DEFAULT_ALLOWED_TOOL_FAMILIES
    assert "workspace" in build_subagent_tool_preferences(DEFAULT_ALLOWED_TOOL_FAMILIES)["disabled_tool_families"]
