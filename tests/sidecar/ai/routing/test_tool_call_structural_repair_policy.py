"""Structural tool-argument repair policy at the tool-loop dispatch seam."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest
from test_tool_loop import (  # shared loop harness.
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)
from test_tool_loop_recovery import (  # shared recovery fixtures.
    _read_file_descriptor,
    _tool_plan,
)

from sidecar.ai.engines import codex_cli_transport
from sidecar.ai.error_codes import CMP_LOOP_INVALID_TOOL_CALL
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing import tool_call_repair_policy
from sidecar.ai.routing.loop_events import ToolResultEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.ai.tools.tool_call_healing import coerce_arguments


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


def test_character_level_repair_dispatches_side_effecting_tool() -> None:
    mcp_client = _StubMCPClient((_write_file_descriptor(),))
    _decision, _events = _run_turn(
        _tool_plan(
            ToolCallRequest(
                tool_id="write_file",
                arguments={"path": "output.txt", "content": "complete"},
                call_id="call_spelling_repaired_write",
                argument_repairs=("parsed_string_arguments", "single_quotes", "trailing_comma"),
            )
        ),
        mcp_client,
    )

    assert [name for name, _arguments in mcp_client.executions] == ["write_file"]


def _healed_partial_call(tool_id: str) -> ToolCallRequest:
    # Two objects where one was meant: the heal keeps the first and drops the rest.
    coerced = coerce_arguments('{"path":"a"} {"content":"x"}')
    assert coerced == ({"path": "a"}, ("parsed_string_arguments", "stripped_debris"))
    arguments, tags = coerced
    return ToolCallRequest(
        tool_id=tool_id, arguments=arguments, call_id=f"call_{tool_id}", argument_repairs=tags
    )


def test_dropped_text_repair_rejects_side_effecting_tool() -> None:
    mcp_client = _StubMCPClient((_write_file_descriptor(),))
    _decision, events = _run_turn(_tool_plan(_healed_partial_call("write_file")), mcp_client)

    (blocked,) = [event for event in _result_events(events) if event.call_id == "call_write_file"]
    assert blocked.error_code == CMP_LOOP_INVALID_TOOL_CALL
    assert blocked.metadata is not None
    assert blocked.metadata["argument_repairs"] == ["parsed_string_arguments", "stripped_debris"]
    assert mcp_client.executions == []


def test_dropped_text_repair_dispatches_read_only_tool() -> None:
    mcp_client = _StubMCPClient((_read_file_descriptor(),))
    _decision, _events = _run_turn(_tool_plan(_healed_partial_call("read_file")), mcp_client)

    assert [name for name, _arguments in mcp_client.executions] == ["read_file"]


@pytest.mark.parametrize(
    ("tags", "unsafe"),
    [
        (("parsed_string_arguments", "balanced_extraction", "ascii_quotes"), set()),
        (("python_literals", "single_quotes", "trailing_comma"), set()),
        (("stripped_fence",), {"stripped_fence"}),
        (("stripped_debris", "trailing_comma"), {"stripped_debris"}),
        (("closed_string", "closed_brace"), {"closed_string", "closed_brace"}),
        (("healed",), {"healed"}),
        (("a_future_tag",), {"a_future_tag"}),
    ],
)
def test_only_allowlisted_repairs_are_safe(tags: tuple[str, ...], unsafe: set[str]) -> None:
    call = ToolCallRequest(tool_id="write_file", arguments={}, argument_repairs=tags)

    assert tool_call_repair_policy.unsafe_argument_repairs(call) == unsafe


def test_codex_transport_reads_the_shared_character_level_set() -> None:
    shared = tool_call_repair_policy.CHARACTER_LEVEL_ARGUMENT_REPAIRS

    assert codex_cli_transport.CHARACTER_LEVEL_ARGUMENT_REPAIRS is shared
    assert shared == {"ascii_quotes", "python_literals", "single_quotes", "trailing_comma"}


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
