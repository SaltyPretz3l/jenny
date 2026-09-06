"""Structural tool-argument repair policy at the tool-loop dispatch seam."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_tool_loop import (  # noqa: E402 - shared loop harness.
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)
from test_tool_loop_recovery import (  # noqa: E402 - shared recovery fixtures.
    _read_file_descriptor,
    _tool_plan,
)

from sidecar.ai.error_codes import CMP_LOOP_INVALID_TOOL_CALL  # noqa: E402
from sidecar.ai.mcp.models import MCPToolDescriptor  # noqa: E402
from sidecar.ai.routing.loop_events import ToolResultEvent  # noqa: E402
from sidecar.ai.routing.loop_runtime import LoopRuntime  # noqa: E402
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest  # noqa: E402


def _write_file_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="write_file",
        description="Write a file",
        input_schema={"type": "object"},
        side_effecting=True,
        server_name="tools",
    )


def _run_turn(
    first_plan: _ToolPlan,
    mcp_client: _StubMCPClient,
    *,
    final_text: str = "Completed after handling the tool calls.",
) -> tuple[object, list[object]]:
    engine = _ToolLoopEngine(
        plans=[
            first_plan,
            _ToolPlan(
                result=GenerationResult(content=final_text, finish_reason="stop")
            ),
        ]
    )
    router = _build_router(engine=engine, mcp_client=mcp_client)
    router.set_harness_snapshot_provider(
        lambda **_kwargs: {
            "tools": {
                "items": [
                    {"name": "read_file", "display_name": "Read File", "enabled": True},
                    {"name": "write_file", "display_name": "Write File", "enabled": True},
                    {"name": "missing_tool", "display_name": "Missing", "enabled": True},
                ]
            }
        }
    )
    events: list[object] = []
    decision = router.build_chat_decision(
        request_id="req_structural_repair",
        messages=[{"role": "user", "content": "Use the requested tools."}],
        latest_user_content="Use the requested tools.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_structural_repair",
            max_iterations=3,
            streaming=True,
        ),
    )
    return decision, events


def _result_events(events: list[object]) -> list[ToolResultEvent]:
    return [event for event in events if isinstance(event, ToolResultEvent)]


def test_structural_repair_rejects_write_and_clean_sibling_executes() -> None:
    final_text = "The clean read completed after the rejected write call."
    mcp_client = _StubMCPClient((_write_file_descriptor(), _read_file_descriptor()))
    decision, events = _run_turn(
        _tool_plan(
            ToolCallRequest(
                tool_id="write_file",
                arguments={"path": "a", "content": "partial"},
                call_id="call_repaired_write",
                argument_repairs=("parsed_string_arguments", "closed_string"),
            ),
            ToolCallRequest(
                tool_id="read_file",
                arguments={"path": "input.txt"},
                call_id="call_clean_read",
            ),
        ),
        mcp_client,
        final_text=final_text,
    )

    result_events = _result_events(events)
    blocked = [event for event in result_events if event.call_id == "call_repaired_write"]
    assert len(blocked) == 1
    assert blocked[0].error_code == CMP_LOOP_INVALID_TOOL_CALL
    assert blocked[0].metadata is not None
    assert blocked[0].metadata["structural_repair_rejected"] is True
    assert blocked[0].metadata["argument_repairs"] == [
        "parsed_string_arguments",
        "closed_string",
    ]
    assert all(name != "write_file" for name, _arguments in mcp_client.executions)
    executions = [
        (event.tool_name, event.call_id) for event in result_events if event.success
    ]
    assert executions == [("read_file", "call_clean_read")]
    assert decision.response_text == final_text


def test_structural_repair_dispatches_provably_read_only_tool() -> None:
    mcp_client = _StubMCPClient((_read_file_descriptor(),))
    _decision, _events = _run_turn(
        _tool_plan(
            ToolCallRequest(
                tool_id="read_file",
                arguments={"path": "partial"},
                call_id="call_repaired_read",
                argument_repairs=("parsed_string_arguments", "closed_brace"),
            )
        ),
        mcp_client,
    )

    assert [name for name, _arguments in mcp_client.executions] == ["read_file"]


def test_nonstructural_repair_dispatches_side_effecting_tool() -> None:
    mcp_client = _StubMCPClient((_write_file_descriptor(),))
    _decision, _events = _run_turn(
        _tool_plan(
            ToolCallRequest(
                tool_id="write_file",
                arguments={"path": "output.txt", "content": "complete"},
                call_id="call_spelling_repaired_write",
                argument_repairs=("parsed_string_arguments", "stripped_fence"),
            )
        ),
        mcp_client,
    )

    assert [name for name, _arguments in mcp_client.executions] == ["write_file"]


def test_structural_repair_without_descriptor_fails_closed() -> None:
    mcp_client = _StubMCPClient()
    _decision, events = _run_turn(
        _tool_plan(
            ToolCallRequest(
                tool_id="missing_tool",
                arguments={"path": "partial"},
                call_id="call_missing_descriptor",
                argument_repairs=("closed_string",),
            )
        ),
        mcp_client,
    )

    blocked = [
        event
        for event in _result_events(events)
        if event.call_id == "call_missing_descriptor"
    ]
    assert len(blocked) == 1
    assert blocked[0].error_code == CMP_LOOP_INVALID_TOOL_CALL
    assert blocked[0].metadata is not None
    assert blocked[0].metadata["structural_repair_rejected"] is True
    assert mcp_client.executions == []
