"""Red-first: the builtin-server bracket runs under a PhaseTrace (W4).

Failures name the phase that failed and carry the per-phase timings through
the W0-widened detail channel, so the W1 envelope can render `failed_phase:`
and a pasted `trace:` token greps straight into `log_tool_execution` lines.
"""

from __future__ import annotations

import json
from pathlib import Path

from sidecar.ai.mcp import builtin_server
from sidecar.ai.mcp.builtin_server import BuiltinTool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.phase_trace import PHASE_NAMES
from sidecar.ai.tools.workspace import WorkspaceGuard


def _tool(handler, *, name: str = "probe_tool") -> BuiltinTool:
    return BuiltinTool(
        name=name,
        description="phase-trace probe",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=handler,
    )


def _call(tool: BuiltinTool, workspace_root: Path, arguments: dict | None = None) -> dict:
    return builtin_server._handle_tools_call(  # noqa: SLF001
        "phase-call",
        {tool.name: tool},
        WorkspaceGuard(str(workspace_root)),
        {"name": tool.name, "arguments": arguments or {}},
    )


def test_handler_failure_names_the_execute_phase(tmp_path: Path) -> None:
    def fail(_arguments, _workspace):
        raise ToolExecutionFailure(
            code="CMP-TEST-0002", message="boom", retryable=False
        )

    error_data = _call(_tool(fail), tmp_path)["error"]["data"]
    assert error_data["failed_phase"] == "execute"
    timings = json.loads(error_data["phase_timings_json"])
    assert set(timings) <= set(PHASE_NAMES)
    assert "execute" in timings


def test_validation_failure_names_the_validate_phase(tmp_path: Path) -> None:
    def unreached(_arguments, _workspace):
        raise AssertionError("handler must not run when validation fails")

    tool = BuiltinTool(
        name="strict_tool",
        description="rejects non-object arguments",
        side_effecting=False,
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string", "minLength": 1}},
            "required": ["path"],
        },
        handler=unreached,
    )
    response = _call(tool, tmp_path, arguments={"path": ""})
    error_data = response["error"]["data"]
    assert error_data["failed_phase"] == "validate"
    timings = json.loads(error_data["phase_timings_json"])
    assert "execute" not in timings  # unused phases are absent, not zero


def test_success_carries_phase_timings_and_injected_trace(tmp_path: Path) -> None:
    def ok(_arguments, _workspace):
        return "fine"

    response = _call(_tool(ok), tmp_path, arguments={"_jenny_trace_id": "t_1.call_9"})
    metadata = response["result"]["metadata"]
    timings = json.loads(metadata["phase_timings_json"])
    assert "execute" in timings
    assert set(timings) <= set(PHASE_NAMES)
    assert metadata["trace_id"] == "t_1.call_9"


def test_failure_reflects_injected_trace_id(tmp_path: Path) -> None:
    def fail(_arguments, _workspace):
        raise ToolExecutionFailure(code="CMP-TEST-0002", message="boom", retryable=False)

    response = _call(_tool(fail), tmp_path, arguments={"_jenny_trace_id": "t_1.call_9"})
    assert response["error"]["data"]["trace_id"] == "t_1.call_9"
