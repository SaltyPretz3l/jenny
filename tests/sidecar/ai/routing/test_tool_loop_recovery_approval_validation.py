from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_tool_loop import (
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

from sidecar.ai.error_codes import CMP_LOOP_TOOL_INPUT_VALIDATION, CMP_TOOL_COMMAND_BLOCKED
from sidecar.ai.execution_policy import (
    BUILTIN_MCP_SERVER_NAME,
    ELECTRON_TOOL_BRIDGE_SERVER_NAME,
)
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing import tool_call_execution as tool_call_execution_module
from sidecar.ai.routing import tool_dispatch as tool_dispatch_module
from sidecar.ai.tools.builtins import shell_command_split as shell_command_split_module
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest


def test_approval_plan_excludes_schema_invalid_tail_call() -> None:
    descriptor = MCPToolDescriptor(
        name="delete_file",
        description="Delete a file",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
        side_effecting=True,
        server_name="tools",
    )
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Deleting.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="delete_file",
                            arguments={"path": "old.txt"},
                            call_id="call-delete-valid",
                        ),
                        ToolCallRequest(
                            tool_id="delete_file",
                            arguments={},
                            call_id="call-delete-invalid",
                        ),
                    ),
                )
            )
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((descriptor,)),
        extra_snapshot_tools=("delete_file",),
    )

    decision = router.build_chat_decision(
        request_id="req_validate_approval_tail",
        messages=[{"role": "user", "content": "Delete both files."}],
        latest_user_content="Delete both files.",
        mode="assist",
        approvals_pre_granted=False,
    )

    assert decision.approval_request is not None
    assert decision.approval_plan is not None
    assert [call.call_id for call in decision.approval_plan.tool_calls] == [
        "call-delete-valid"
    ]
    assert [outcome.call_id for outcome in decision.tool_results] == ["call-delete-invalid"]
    assert decision.tool_results[0].error_code == CMP_LOOP_TOOL_INPUT_VALIDATION


class _StreamingStubMCPClient(_StubMCPClient):
    """run_command dispatch passes an output-chunk writer; the base stub has none."""

    def execute_tool(self, tool_name, arguments, *, on_output_chunk=None, **kwargs):
        _ = on_output_chunk
        return super().execute_tool(tool_name, arguments, **kwargs)


def _run_command_descriptor(server_name: str) -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="run_command",
        description="Run a shell command",
        input_schema={
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
        side_effecting=True,
        server_name=server_name,
    )


def test_windows_multiline_run_command_is_refused_before_admission_and_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """HB-013: cmd.exe would run only line one and report exit 0.

    The refusal is a recoverable CMP-TOOL outcome recorded before the approval
    gate, so no runtime operation is admitted, no resource lease is taken, and
    the next workspace tool call in the same turn still dispatches.
    """
    monkeypatch.setattr(shell_command_split_module, "os", SimpleNamespace(name="nt"))
    admitted: list[str] = []
    original_admit = tool_dispatch_module.admit_scoped_tool_call

    def _recording_admit(**kwargs):
        admitted.append(str(kwargs["call"].call_id))
        return original_admit(**kwargs)

    monkeypatch.setattr(tool_dispatch_module, "admit_scoped_tool_call", _recording_admit)
    mcp_client = _StreamingStubMCPClient((_run_command_descriptor(BUILTIN_MCP_SERVER_NAME),))
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Verifying.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="run_command",
                            arguments={
                                "command": "py synth --out run1\npy synth --out run2\n"
                                "python -c \"\nprint('same')\n\"",
                            },
                            call_id="call-multiline",
                        ),
                        ToolCallRequest(
                            tool_id="run_command",
                            arguments={"command": "git status"},
                            call_id="call-single-line",
                        ),
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    router = _build_router(
        engine=engine, mcp_client=mcp_client, extra_snapshot_tools=("run_command",),
    )
    router._config = replace(router._config, tools_shell_enabled=True)

    decision = router.build_chat_decision(
        request_id="req_multiline_run_command",
        messages=[{"role": "user", "content": "Verify determinism."}],
        latest_user_content="Verify determinism.",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert [
        (name, arguments["command"]) for name, arguments in mcp_client.executions
    ] == [("run_command", "git status")]
    assert admitted == ["call-single-line"]
    refused = [outcome for outcome in decision.tool_results if outcome.call_id == "call-multiline"]
    assert len(refused) == 1
    assert refused[0].success is False
    assert refused[0].error_code == CMP_TOOL_COMMAND_BLOCKED
    assert "was not executed" in refused[0].output
    assert "first line" in refused[0].output
    assert "run_temp_script" in refused[0].output
    assert refused[0].metadata.get("pre_dispatch_blocked") is True
    # HB-039: a one-line rewrite fixes it, so it is not a permission denial.
    assert refused[0].metadata.get("failure_class") == "bad_arguments"
    assert refused[0].metadata.get("effects") == "none"
    ran = [outcome for outcome in decision.tool_results if outcome.call_id == "call-single-line"]
    assert len(ran) == 1 and ran[0].success is True


@pytest.mark.parametrize(
    ("platform", "server_name", "refused"),
    [
        ("nt", BUILTIN_MCP_SERVER_NAME, True),
        # The desktop sandbox and hosted worker run /bin/sh in Linux: every line runs.
        ("nt", ELECTRON_TOOL_BRIDGE_SERVER_NAME, False),
        ("posix", BUILTIN_MCP_SERVER_NAME, False),
    ],
)
def test_multiline_prevalidation_follows_the_launching_shell(
    monkeypatch: pytest.MonkeyPatch, platform: str, server_name: str, refused: bool,
) -> None:
    monkeypatch.setattr(shell_command_split_module, "os", SimpleNamespace(name=platform))
    router = _build_router(
        engine=_ToolLoopEngine(plans=[]),
        mcp_client=_StubMCPClient((_run_command_descriptor(server_name),)),
    )

    outcome = tool_call_execution_module.prevalidate_call_arguments(
        kernel=router,
        call=ToolCallRequest(
            tool_id="run_command",
            arguments={"command": "echo one\necho two"},
            call_id="call-1",
        ),
        tool_contract=None,
    )

    assert (outcome is not None) is refused
    if refused:
        assert outcome["error_code"] == CMP_TOOL_COMMAND_BLOCKED
