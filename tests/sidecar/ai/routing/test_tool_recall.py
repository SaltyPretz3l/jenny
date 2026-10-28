"""Conversation-local recall through the real synthetic dispatch."""

from __future__ import annotations

import json
import re
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.compaction_micro import tool_placeholder
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_execution import bounded_tool_output, execute_tool
from sidecar.ai.tools.assembly import ToolAssemblyContext, assemble_tool_contract
from sidecar.ai.tools.catalog import build_tool_catalog
from sidecar.ai.tools.models import ToolCallRequest


def _row(call_id: str, output: str, *, is_error: bool = False) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_result": {
            "call_id": call_id,
            "output_text": output,
            "tool_name": "read_file",
            "is_error": is_error,
        },
    }


def _recall(
    arguments: dict[str, Any],
    *,
    rows: list[dict[str, Any]] | None = None,
    outcomes: tuple[Any, ...] = (),
    enabled: bool = True,
    use_contract: bool = True,
) -> Any:
    # The same helper populates each chat decision's runtime before the loop runs.
    from sidecar.ai.routing.tool_recall import build_recall_history

    config = RuntimeConfig(feature_flags={"compaction_recall_tool": enabled})
    catalog = build_tool_catalog(config=config)
    contract = assemble_tool_contract(
        catalog,
        ToolAssemblyContext(
            surface="managed_sidecar",
            config=config,
            engine_supports_tool_calling=True,
            mode="assist",
        ),
    )
    kernel = SimpleNamespace(
        _config=config,
        _active_cancel_handle=None,
        _mcp_client=SimpleNamespace(
            tool_descriptor=lambda name: next(
                (item for item in catalog if item.name == name),
                None,
            )
        ),
    )
    runtime = LoopRuntime(
        request_id="request",
        session_id="session",
        request_context=SimpleNamespace(execution_context=None),
    )
    runtime.recall_history = build_recall_history(rows)
    return execute_tool(
        kernel,
        ToolCallRequest(tool_id="recall_tool_output", call_id="recall-1", arguments=arguments),
        request_id="request",
        session_id="session",
        read_snapshot_cache={},
        tool_contract=contract if use_contract else None,
        runtime=runtime,
        request_outcomes=outcomes,
    )


def _outcome(call_id: str, output: str, *, success: bool = True) -> Any:
    return SimpleNamespace(call_id=call_id, output=output, tool_name="run_command", success=success)


def test_recall_current_turn() -> None:
    result = _recall({"call_id": "current"}, outcomes=(_outcome("current", "fresh"),))
    assert result.success is True
    assert result.output == "fresh"
    assert result.call_id == "recall-1"
    assert result.metadata == {
        "effects": "none",
        "recalled_call_id": "current",
        "source": "current_turn",
        "original_tool": "run_command",
    }


def test_recall_history() -> None:
    result = _recall({"call_id": "old"}, rows=[_row("old", "original")])
    assert result.success is True
    assert result.output == "original"
    assert result.metadata == {
        "effects": "none",
        "recalled_call_id": "old",
        "source": "history",
        "original_tool": "read_file",
    }


def test_current_turn_wins_over_history() -> None:
    result = _recall(
        {"call_id": "same"}, rows=[_row("same", "stale")], outcomes=(_outcome("same", "fresh"),)
    )
    assert result.output == "fresh"
    assert result.metadata["source"] == "current_turn"


@pytest.mark.parametrize("arguments", [{"call_id": "unknown"}, {"call_id": ""}])
def test_missing_id_fails(arguments: dict[str, Any]) -> None:
    result = _recall(arguments)
    assert result.success is False
    assert str(arguments.get("call_id", "")) in result.output
    assert "only outputs from this conversation can be recalled" in result.output.lower()
    assert result.metadata["effects"] == "none"
    assert result.error_code


def test_absent_id_fails_schema_validation() -> None:
    result = _recall({})
    assert result.success is False
    assert result.error_code


@pytest.mark.parametrize("json_output", [False, True])
def test_long_output_uses_standard_bound(json_output: bool) -> None:
    output = "z" * 20_000
    if json_output:
        output = json.dumps({"payload": output})
    result = _recall({"call_id": "long"}, rows=[_row("long", output)])
    expected, truncated = bounded_tool_output(output, tool_name="recall_tool_output")
    assert truncated
    assert result.success is True
    assert result.output == expected
    assert len(result.output) <= 16_000


@pytest.mark.parametrize("source", ["history", "current_turn"])
def test_error_original_is_successful_recall(source: str) -> None:
    kwargs = (
        {"rows": [_row("error", "permission denied", is_error=True)]}
        if source == "history"
        else {"outcomes": (_outcome("error", "permission denied", success=False),)}
    )
    result = _recall({"call_id": "error"}, **kwargs)
    assert result.success is True
    assert result.output == "permission denied"
    assert result.metadata["original_is_error"] is True


def test_stubbed_history_round_trip() -> None:
    history = [
        {
            "role": "tool",
            "tool_call_id": "stub-id",
            "content": tool_placeholder("stub-id", recall_hint=True),
        }
    ]
    match = re.search(r'recall_tool_output\("([^"]+)"\)', history[0]["content"])
    assert match is not None
    result = _recall({"call_id": match[1]}, rows=[_row("stub-id", "full original")])
    assert result.output == "full original"


def test_history_does_not_survive_the_request() -> None:
    assert _recall({"call_id": "private"}, rows=[_row("private", "secret")]).success
    assert _recall({"call_id": "private"}).success is False


@pytest.mark.parametrize("use_contract", [True, False])
def test_flag_off_refuses_direct_call(use_contract: bool) -> None:
    result = _recall(
        {"call_id": "old"}, rows=[_row("old", "original")], enabled=False, use_contract=use_contract
    )
    assert result.success is False
    assert result.output != "original"


def test_chat_decision_recalls_stubbed_history_then_current_iteration() -> None:
    from sidecar.ai.context.builder import ContextBuilder
    from sidecar.ai.routing.router import ChatRouter
    from sidecar.ai.tools.models import GenerationResult

    class Engine:
        def __init__(self) -> None:
            self.results = iter(
                [
                    GenerationResult(
                        content="",
                        tool_calls=(
                            ToolCallRequest(
                                tool_id="recall_tool_output",
                                call_id="first-recall",
                                arguments={"call_id": "stub-id"},
                            ),
                        ),
                        finish_reason="tool_calls",
                    ),
                    GenerationResult(
                        content="",
                        tool_calls=(
                            ToolCallRequest(
                                tool_id="recall_tool_output",
                                call_id="second-recall",
                                arguments={"call_id": "first-recall"},
                            ),
                        ),
                        finish_reason="tool_calls",
                    ),
                    GenerationResult(content="done", finish_reason="stop"),
                    GenerationResult(
                        content="",
                        tool_calls=(
                            ToolCallRequest(
                                tool_id="recall_tool_output",
                                call_id="other-session-recall",
                                arguments={"call_id": "stub-id"},
                            ),
                        ),
                        finish_reason="tool_calls",
                    ),
                    GenerationResult(content="done", finish_reason="stop"),
                ]
            )

        def generate_with_tools(self, **_kwargs: Any) -> Any:
            return next(self.results)

        def get_model_max_output_tokens(self) -> None:
            return None

        def get_model_context_length(self) -> None:
            return None

    router = ChatRouter(
        config=RuntimeConfig(engine_type="ollama", model="qwen", mode="assist"),
        engine=Engine(),
        context_builder=ContextBuilder(None),
        mcp_client=SimpleNamespace(available_tools=[], tool_descriptor=lambda _name: None),
    )
    decision = router.build_chat_decision(
        request_id="request-1",
        session_id="session-1",
        mode="assist",
        messages=[
            {
                "role": "tool",
                "tool_call_id": "stub-id",
                "content": tool_placeholder("stub-id", recall_hint=True),
            },
            {"role": "user", "content": "recall it"},
        ],
        canonical_session_messages=[_row("stub-id", "original text")],
        latest_user_content="recall it",
        approvals_pre_granted=True,
    )
    assert [result.output for result in decision.tool_results] == [
        "original text",
        "original text",
    ]
    assert [result.metadata["source"] for result in decision.tool_results] == [
        "history",
        "current_turn",
    ]
    other = router.build_chat_decision(
        request_id="request-2",
        session_id="session-2",
        mode="assist",
        messages=[{"role": "user", "content": "recall it"}],
        canonical_session_messages=[],
        latest_user_content="recall it",
        approvals_pre_granted=True,
    )
    assert len(other.tool_results) == 1
    assert other.tool_results[0].success is False


def test_history_index_ignores_malformed_rows_and_keeps_newest_duplicate() -> None:
    from sidecar.ai.routing.tool_recall import MAX_RECALL_RESULTS, build_recall_history

    rows = [_row(str(index), str(index)) for index in range(MAX_RECALL_RESULTS + 1)]
    rows += [
        _row("same", "older"),
        {},
        {"tool_result": {"call_id": "invalid"}},
        _row("same", "newer"),
    ]
    history = build_recall_history(rows)
    assert len(history) == MAX_RECALL_RESULTS
    assert history["same"][0] == "newer"
    assert "invalid" not in history
    assert "0" not in history


def test_approval_resume_rebuilds_request_local_history(monkeypatch: pytest.MonkeyPatch) -> None:
    from sidecar.ai.mcp.models import MCPToolResult
    from sidecar.ai.tools.models import GenerationResult
    from sidecar.runtime.chat import resume_chat_send_response_from_approval_plan
    from tests.sidecar.ai.routing.test_router import _ToolPlan
    from tests.sidecar.runtime.test_approval_tool_search_drift import (
        _USER_TURN,
        _calls,
        _pause_on_gated_read,
    )

    router, plan, _client = _pause_on_gated_read(("list_dir", "list", {"path": "."}))
    _client._results["read_file"] = MCPToolResult(
        tool_name="read_file", output="approved read", success=True,
    )
    router._engine._plans.extend(
        [
            _calls(("recall_tool_output", "recall-resumed", {"call_id": "prior"})),
            _ToolPlan(result=GenerationResult(content="done", finish_reason="stop")),
        ]
    )
    recalled = []
    execute = router._execute_tool

    def capture(call: Any, **kwargs: Any) -> Any:
        result = execute(call, **kwargs)
        if call.tool_id == "recall_tool_output":
            recalled.append(result)
        return result

    monkeypatch.setattr(router, "_execute_tool", capture)
    response = resume_chat_send_response_from_approval_plan(
        plan,
        brain_container=SimpleNamespace(
            stack=SimpleNamespace(
                router=router,
                config=router._config,
                engine=router._engine,
            )
        ),
        live_params={"messages": _USER_TURN},
        canonical_session_messages=[_row("prior", "original before approval")],
    )
    assert response.result["status"] == "completed"
    assert len(recalled) == 1
    assert recalled[0].success is True
    assert recalled[0].output == "original before approval"


def test_desktop_wire_shape_recalls_from_request_tool_rows() -> None:
    """Desktop strips call_id/output_text from canonical rows; the request's tool rows carry it."""
    from sidecar.ai.routing.tool_recall import build_recall_history

    projected = [{"role": "tool", "tool_result": {"tool_name": "read_file", "is_error": False}}]
    messages = [
        {"role": "tool", "tool_call_id": "old", "content": "full text", "name": "read_file"},
        {"role": "tool", "tool_call_id": "stub", "content": tool_placeholder("stub", recall_hint=True)},
        {"role": "tool", "tool_call_id": "both", "content": "model copy"},
        {"role": "tool", "tool_call_id": "err", "content": "denied", "is_error": True},
    ]
    history = build_recall_history(projected + [_row("both", "canonical copy")], messages)
    assert history["old"] == ("full text", "read_file", False)
    assert "stub" not in history
    assert history["both"][0] == "canonical copy"
    assert history["err"] == ("denied", "", True)


def test_chat_decision_recalls_a_prior_turn_through_the_desktop_wire_shape() -> None:
    from sidecar.ai.context.builder import ContextBuilder
    from sidecar.ai.routing.router import ChatRouter
    from sidecar.ai.tools.models import GenerationResult

    class Engine:
        def __init__(self) -> None:
            self.results = iter([
                GenerationResult(
                    content="",
                    tool_calls=(ToolCallRequest(
                        tool_id="recall_tool_output", call_id="r1", arguments={"call_id": "prior"},
                    ),),
                    finish_reason="tool_calls",
                ),
                GenerationResult(content="done", finish_reason="stop"),
            ])

        def generate_with_tools(self, **_kwargs: Any) -> Any:
            return next(self.results)

        def get_model_max_output_tokens(self) -> None:
            return None

        def get_model_context_length(self) -> None:
            return None

    router = ChatRouter(
        config=RuntimeConfig(engine_type="ollama", model="qwen", mode="assist"),
        engine=Engine(),
        context_builder=ContextBuilder(None),
        mcp_client=SimpleNamespace(available_tools=[], tool_descriptor=lambda _name: None),
    )
    decision = router.build_chat_decision(
        request_id="request-1",
        session_id="session-1",
        mode="assist",
        messages=[
            {"role": "user", "content": "read it"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "prior", "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }],
            },
            {"role": "tool", "tool_call_id": "prior", "content": "prior output", "name": "read_file"},
            {"role": "user", "content": "recall it"},
        ],
        canonical_session_messages=[{"role": "tool", "tool_result": {"tool_name": "read_file"}}],
        latest_user_content="recall it",
        approvals_pre_granted=True,
    )
    assert [result.output for result in decision.tool_results] == ["prior output"]
    assert decision.tool_results[0].metadata["source"] == "history"
