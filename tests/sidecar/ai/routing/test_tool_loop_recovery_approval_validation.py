from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_tool_loop import (  # noqa: E402
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

from sidecar.ai.error_codes import CMP_LOOP_TOOL_INPUT_VALIDATION  # noqa: E402
from sidecar.ai.mcp.models import MCPToolDescriptor  # noqa: E402
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest  # noqa: E402


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
