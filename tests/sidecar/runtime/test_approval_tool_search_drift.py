"""An approval must survive the turn's OWN mid-turn ``tool_search``.

Dogfood HB-018, 2026-09-28 (chat ``sess_1790632000685_8abcd4f84dd3``, stream
``stream_a7f86f2e``). The turn opened with a pre-generation compaction, called
``todo_write``, then ``tool_search`` (which discovered the deferred
``task_board``) alongside ``git_status``, then ``python_execute``. The owner
clicked Allow and the resume died 490 ms later with ``preempted`` /
``plan_drift``::

    mismatch_components: ["message_history", "request_messages", "system_prompt"]

The approval plan freezes the system prompt rendered at turn start, when
``task_board`` was still deferred. ``tool_search`` then un-deferred it on the
request's ``ToolResolutionContext``, so the resume rebuilt the prompt with
``task_board`` listed under ``## Executable Tools`` -- a prompt the turn never
had -- and reported it as drift. ``message_history`` follows because slot 0 of
that comparison is the prompt; ``request_messages`` is the inner-retry wrapper
appending its own retry row to the request messages on attempts 2 and 3. The
retry of the same prompt worked because the persisted ``tool_search`` result
was then in history, so ``task_board`` was un-deferred from the first
generation on. A later turn in the chat (``delete_file`` approval, also after a
turn-start compaction) resumed fine: it made no mid-turn discovery.

These tests run the real router (deferral, ``tool_search`` dispatch, ask-policy
pause, plan freeze) and the real resume validation against it.
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import (
    RuntimeConfig,
    ToolPolicyRule,
    ToolPolicyRuleMatch,
    ToolPolicySnapshot,
)
from sidecar.ai.feature_flags import (
    FEATURE_CONTEXT_COMPACTION,
    FEATURE_TOKEN_BUDGET,
    FEATURE_TOOL_SEARCH,
)
from sidecar.ai.mcp.models import MCPToolDescriptor, MCPToolResult
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.chat import (
    _validate_approval_plan_live_context,
    resume_chat_send_response_from_approval_plan,
)
from sidecar.runtime.chat_resume_prompt_states import turn_tool_status_states
from sidecar.runtime.turn_retry import InnerRetryableTurnError
from tests.sidecar.ai.routing.test_router import (
    _build_router,
    _CompactionStreamEngine,
    _StubEngine,
    _StubMCPClient,
    _ToolPlan,
)

_USER_TURN = [{"role": "user", "content": "check the board, then read notes.md"}]
_COMPACTION_SUMMARY = (
    "<summary>\n## 1. Intent Summary\nKeep going.\n## 2. Key Technical Concepts\nx\n"
    "## 3. Relevant Files & Code\nx\n## 4. Errors & Debugging\n(none)\n"
    "## 5. Problem-Solving Approaches\nx\n## 6. User Messages\n\"go\"\n"
    "## 7. Pending Tasks\nx\n## 8. Current Work\nx\n## 9. Next Step\nx\n</summary>"
)
# Enough history to cross the auto-compact threshold of the budget below.
_LONG_HISTORY = [
    {"role": "user", "content": "x " * 3000},
    {"role": "assistant", "content": "tool noise " * 400},
]


def _descriptor(name: str, description: str, *, server_name: str) -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name=name,
        description=description,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        side_effecting=False,
        server_name=server_name,
    )


def _descriptors() -> dict[str, MCPToolDescriptor]:
    return {
        "read_file": _descriptor("read_file", "Read a file", server_name="tools"),
        "list_dir": _descriptor("list_dir", "List a directory", server_name="tools"),
        # MCP-sourced, so tool_search_mode="tst" defers both at turn start.
        "mcp__ops__board": _descriptor("mcp__ops__board", "Task board", server_name="ops"),
        "mcp__ops__deploy": _descriptor("mcp__ops__deploy", "Deploy", server_name="ops"),
    }


def _calls(*calls: tuple[str, str, dict[str, Any]]) -> _ToolPlan:
    return _ToolPlan(
        result=GenerationResult(
            content="",
            finish_reason="tool_calls",
            tool_calls=tuple(
                ToolCallRequest(tool_id=tool_id, arguments=arguments, call_id=call_id)
                for tool_id, call_id, arguments in calls
            ),
        )
    )


def _pause_on_gated_read(
    *first_batch: tuple[str, str, dict[str, Any]],
    history: list[dict[str, Any]] | None = None,
    turn_start_compaction: bool = False,
) -> tuple[Any, Any, _StubMCPClient]:
    """Run a turn: ``first_batch`` executes, then an ask-gated read pauses."""
    plans = [
        _calls(*first_batch),
        _calls(("read_file", "call_gated_read", {"path": "notes.md"})),
    ]
    config = RuntimeConfig(
        engine_type="mock",
        model="mock-v1",
        feature_flags={FEATURE_TOOL_SEARCH: True},
        tool_search_mode="tst",
    )
    engine: _StubEngine = _StubEngine(plans=plans)
    if turn_start_compaction:
        # Compaction runs on the stream path; its summary is the first reply.
        engine = _CompactionStreamEngine(
            plans=[
                _ToolPlan(result=GenerationResult(content=_COMPACTION_SUMMARY, finish_reason="stop")),
                *plans,
            ]
        )
        config = replace(
            config,
            # 30% char-fallback headroom (A9-F5): an 8,000-token budget window.
            context_length=11_429,
            max_tokens=256,
            token_budget_reserved_for_summary=256,
            token_budget_warning_ratio=0.2,
            token_budget_auto_compact_ratio=0.3,
            feature_flags={
                FEATURE_TOOL_SEARCH: True,
                FEATURE_TOKEN_BUDGET: True,
                FEATURE_CONTEXT_COMPACTION: True,
            },
        )
    client = _StubMCPClient(
        _descriptors(),
        results={
            "list_dir": MCPToolResult(tool_name="list_dir", output="notes.md", success=True),
        },
    )
    router = _build_router(config=config, engine=engine, mcp_client=client)
    router._config = replace(
        router._config,
        tool_policy_snapshot=ToolPolicySnapshot(
            version=2,
            rules=(
                ToolPolicyRule(
                    id="ask-reads",
                    decision="ask",
                    reason="Review file reads",
                    match=ToolPolicyRuleMatch(tool_id="read_file"),
                ),
            ),
        ),
    )
    messages = [*(history or []), *_USER_TURN]
    decision = router.build_chat_decision(
        request_id="req_tool_search_drift",
        messages=messages,
        latest_user_content=_USER_TURN[-1]["content"],
        mode="assist",
        approvals_pre_granted=False,
    )
    plan = decision.approval_plan
    assert plan is not None, "expected the ask-gated read_file to pause the turn"
    assert plan.approved_call_id == "call_gated_read"
    return router, plan, client


def _validate(router: Any, plan: Any, *, history: list[dict[str, Any]] | None = None) -> None:
    messages = [*(history or []), *_USER_TURN]
    _validate_approval_plan_live_context(
        plan,
        brain_container=SimpleNamespace(
            stack=SimpleNamespace(router=router, config=router._config, engine=router._engine)
        ),
        live_params={"messages": messages},
        canonical_session_messages=None,
    )


def _search(query: str) -> tuple[str, str, dict[str, Any]]:
    return ("tool_search", f"call_search_{query}", {"query": query})


def test_a_tool_the_turn_itself_discovered_does_not_preempt_its_approval() -> None:
    """The HB-018 shape: a search + sibling batch, then an approval."""
    router, plan, _client = _pause_on_gated_read(
        _search("board"), ("list_dir", "call_list", {"path": "."})
    )
    assert "mcp__ops__board" in plan.tool_resolution_context.un_deferred_names

    # Must not raise: the only change since the prompt was rendered is the
    # turn's own discovery, which the tool-contract comparison already covers.
    _validate(router, plan)


def test_hb018_turn_start_compaction_then_search_batch_then_approval_resumes() -> None:
    """The dogfood turn end to end: compact, search + sibling, then approve."""
    router, plan, client = _pause_on_gated_read(
        _search("board"),
        ("list_dir", "call_list", {"path": "."}),
        history=_LONG_HISTORY,
        turn_start_compaction=True,
    )
    engine_calls = router._engine.calls
    assert "conversation summariser" in str(engine_calls[0]["messages"][0]["content"])
    assert any(
        "## Compacted Conversation Summary" in str(item.get("content") or "")
        for item in plan.working_messages
    )
    client._results["read_file"] = MCPToolResult(
        tool_name="read_file", output="notes body", success=True
    )
    router._engine._plans.append(
        _ToolPlan(result=GenerationResult(content="Read it.", finish_reason="stop"))
    )

    response = resume_chat_send_response_from_approval_plan(
        plan,
        brain_container=SimpleNamespace(
            stack=SimpleNamespace(router=router, config=router._config, engine=router._engine)
        ),
        live_params={"messages": [*_LONG_HISTORY, *_USER_TURN]},
        canonical_session_messages=None,
    )

    # Pre-fix: status "preempted" / plan_drift and read_file never ran.
    assert response.result["status"] == "completed"
    assert response.result["response_text"] == "Read it."
    assert client.executed_calls[-1] == ("read_file", {"path": "notes.md"})


def test_discoveries_across_several_searches_are_all_the_turns_own() -> None:
    router, plan, _client = _pause_on_gated_read(_search("board"), _search("deploy"))
    assert {"mcp__ops__board", "mcp__ops__deploy"} <= plan.tool_resolution_context.un_deferred_names

    _validate(router, plan)


def test_a_tool_already_discovered_in_history_stays_available_in_the_rebuild() -> None:
    """Turn-start un-deferrals come from history, exactly as the turn saw them."""
    history = [
        {"role": "user", "content": "what can deploy?"},
        {
            "role": "tool",
            "content": "tool_search",
            "tool_result": {
                "tool_name": "tool_search",
                "metadata": {
                    "kind": "tool_search_result",
                    "discovered_tools": ["mcp__ops__deploy"],
                },
            },
        },
        {"role": "assistant", "content": "mcp__ops__deploy is available."},
    ]
    router, plan, _client = _pause_on_gated_read(_search("board"), history=history)

    _validate(router, plan, history=history)


def test_a_changed_base_prompt_still_refuses_after_a_mid_turn_discovery() -> None:
    router, plan, _client = _pause_on_gated_read(_search("board"))
    router._config = replace(router._config, system_prompt="You are a different assistant.")

    with pytest.raises(InnerRetryableTurnError) as exc_info:
        _validate(router, plan)

    assert "system_prompt" in exc_info.value.diagnostic_components


def test_a_tool_removed_during_the_pause_still_refuses() -> None:
    """External tool-set drift is not the turn's own and keeps refusing."""
    router, plan, client = _pause_on_gated_read(_search("board"))
    client._descriptors.pop("list_dir")

    with pytest.raises(InnerRetryableTurnError) as exc_info:
        _validate(router, plan)

    assert "tool_contract" in exc_info.value.diagnostic_components
    assert "system_prompt" in exc_info.value.diagnostic_components


def test_an_approval_without_a_mid_turn_search_is_unchanged() -> None:
    router, plan, _client = _pause_on_gated_read(("list_dir", "call_list", {"path": "."}))

    _validate(router, plan)


def test_turn_states_replay_the_turns_own_discoveries_in_order() -> None:
    """A mid-turn re-render (plan-exit resume) froze an intermediate state."""
    router, plan, _client = _pause_on_gated_read(_search("board"), _search("deploy"))

    states = list(
        turn_tool_status_states(
            plan,
            kernel=router,
            request_messages=_USER_TURN,
            canonical_session_messages=None,
        )
    )

    def _available(statuses: tuple[Any, ...]) -> set[str]:
        return {
            status.name
            for status in statuses
            if status.available and status.name.startswith("mcp__")
        }

    # Turn start, then after the first search; the final state is the live
    # one, which the caller already rendered.
    assert [_available(statuses) for statuses in states] == [set(), {"mcp__ops__board"}]
