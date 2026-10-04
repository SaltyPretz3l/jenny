"""TR-008 (owner 2026-09-28): the per-chat tool budget.

The local default matches the cloud one (2000), and when the budget blocks a
tool call the user is told once per turn: the first blocked result of the turn
carries ``session_budget_notice`` so the timeline shows the notice on that row,
and the model is asked to tell the user a new chat resets the budget.
"""

from __future__ import annotations

from dataclasses import replace

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED
from sidecar.ai.routing.iteration_limits import effective_max_tool_calls_per_session
from sidecar.ai.routing.loop_events import ToolResultEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_loop import _quota_block_guidance
from sidecar.ai.routing.tool_quotas import ToolQuotaPolicy, ToolQuotaRegistry, policy_from_config
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest

from .test_tool_loop import (
    _build_router,
    _mermaid_descriptor,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)


def _call(tool_id: str, call_id: str) -> ToolCallRequest:
    return ToolCallRequest(tool_id=tool_id, arguments={"n": call_id}, call_id=call_id)


def test_local_per_chat_tool_budget_defaults_to_the_cloud_budget() -> None:
    local = parse_runtime_config({"engine_type": "llama-server"})
    cloud = parse_runtime_config({"engine_type": "chatgpt"})

    assert local.max_tool_calls_per_session == 2_000
    assert effective_max_tool_calls_per_session(local) == 2_000
    assert effective_max_tool_calls_per_session(cloud) == 2_000
    assert policy_from_config(local).max_tool_calls_per_session == 2_000
    # Still user-lowerable; values above the shared ceiling fail open to it.
    assert parse_runtime_config({"max_tool_calls_per_session": 150}).max_tool_calls_per_session == 150
    assert (
        parse_runtime_config({"max_tool_calls_per_session": 2_500}).max_tool_calls_per_session
        == 2_000
    )


def test_only_the_first_budget_block_of_a_turn_carries_the_notice() -> None:
    registry = ToolQuotaRegistry(
        ToolQuotaPolicy(max_tool_calls_per_session=2),
        session_tool_call_count=2,
    )

    first = registry.filter_calls(
        [_call("read_file", "read-1"), _call("glob_files", "glob-1")],
        tool_contract=None,
    )
    later = registry.filter_calls([_call("list_directory", "list-1")], tool_contract=None)

    assert [blocked.reason for blocked in first.blocked] == [
        "session_tool_budget",
        "session_tool_budget",
    ]
    assert first.blocked[0].metadata.get("session_budget_notice") is True
    assert "session_budget_notice" not in first.blocked[1].metadata
    assert later.blocked[0].reason == "session_tool_budget"
    assert "session_budget_notice" not in later.blocked[0].metadata


def test_other_quota_blocks_never_carry_the_notice() -> None:
    registry = ToolQuotaRegistry(ToolQuotaPolicy(max_web_tool_calls_per_turn=1))

    decision = registry.filter_calls(
        [_call("web_search", "web-1"), _call("fetch_url", "web-2")],
        tool_contract=None,
    )

    assert all("session_budget_notice" not in blocked.metadata for blocked in decision.blocked)


def test_guidance_tells_the_model_how_the_user_gets_tools_back() -> None:
    message = _quota_block_guidance("session_tool_budget", 2_000)

    assert "2000" in message
    assert "chat's tool budget" in message
    assert "starting a new chat resets the budget" in message
    assert "Settings" not in message


def test_a_blocked_turn_marks_exactly_one_tool_result_with_the_notice() -> None:
    def tool_step(index: int) -> _ToolPlan:
        return _ToolPlan(
            result=GenerationResult(
                content="",
                finish_reason="tool_calls",
                tool_calls=(
                    ToolCallRequest(
                        tool_id="mermaid_generate",
                        arguments={"prompt": f"flowchart TD\n  A{index} --> B{index}"},
                        call_id=f"call_budget_{index}",
                    ),
                ),
            )
        )

    engine = _ToolLoopEngine(
        plans=[
            tool_step(1),
            tool_step(2),
            tool_step(3),
            _ToolPlan(result=GenerationResult(content="Done for now.", finish_reason="stop")),
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
    )
    router._config = replace(router._config, max_tool_calls_per_session=1)
    events: list[object] = []

    router.build_chat_decision(
        request_id="req_session_budget",
        messages=[{"role": "user", "content": "Draw three diagrams."}],
        latest_user_content="Draw three diagrams.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req_session_budget", max_iterations=8, emit=events.append),
    )

    results = [event for event in events if isinstance(event, ToolResultEvent)]
    blocked = [event for event in results if event.error_code == CMP_TOOL_CAP_EXCEEDED]
    assert len(results) == 3
    assert len(blocked) == 2
    noticed = [event for event in blocked if (event.metadata or {}).get("session_budget_notice")]
    assert len(noticed) == 1
    assert (noticed[0].metadata or {}).get("quota_scope") == "session_tool_budget"
    assert "new chat" in noticed[0].content
