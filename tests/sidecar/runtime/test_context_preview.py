"""Exercise real prompt assembly through the read-only RPC, without inference."""

from dataclasses import replace
from types import SimpleNamespace

import pytest

from sidecar.ai.config_models import RuntimeConfig
from sidecar.ai.context import preview as preview_module
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.history_reframe import reframe_tool_history_messages
from sidecar.ai.context.messages import compact_semantic_messages_with_report
from sidecar.ai.context.token_budget import (
    apply_budget_check,
    estimate_messages_tokens,
    estimate_tool_schema_tokens,
)
from sidecar.ai.engines.mock import MockEngine
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.routing.loop_events import ContextUsageEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import AgentKernel
from sidecar.ai.routing.tool_budget_filter import count_full_tool_schemas
from sidecar.ai.tools.models import GenerationResult, GenerationUsage, ToolCallRequest
from sidecar.protocol import API_VERSION, CONTEXT_PREVIEW_METHOD
from sidecar.runtime import request_dispatch_context as dispatch_module
from sidecar.runtime.request_dispatch_context import process_context_preview
from sidecar.runtime.server_auxiliary_workers import AUXILIARY_FAMILY_BY_METHOD
from tests.sidecar.runtime.test_execution_context import _payload


@pytest.fixture
def preview(tmp_path, monkeypatch):
    engine = MockEngine()

    def forbidden(*_args, **_kwargs):
        pytest.fail("preview must not generate or execute tools")

    monkeypatch.setattr(engine, "generate", forbidden)
    kernel = AgentKernel(
        config=RuntimeConfig(context_length=32768, tools_enabled=False),
        engine=engine,
        mcp_client=MCPClient(),
        context_builder=ContextBuilder(workspace_root=tmp_path),
    )
    params = {
        "accept_version": API_VERSION,
        "request_id": "preview_1",
        "session_id": "session_1",
        "execution_context": _payload(None),
        "messages": [],
        "context_blocks": [],
        "run_mode": "ask",
    }
    container = SimpleNamespace(stack=SimpleNamespace(router=kernel))

    def run(**changes):
        outcome = process_context_preview(1, {**params, **changes}, True, container)
        assert not outcome.notifications
        return outcome.response

    return kernel, run, tmp_path


def test_fresh_prompt_and_changed_system_prompt(preview):
    kernel, run, root = preview
    before = list(root.rglob("*"))
    result = run()["result"]
    assert result["status"] == "estimated"
    assert result["breakdown"]["messages"] == 0
    assert result["breakdown"]["system_prompt"] > 0
    assert result["used_tokens"] == sum(result["breakdown"].values())
    assert result["available_tokens"] == 32768 - result["used_tokens"]
    kernel._config = replace(kernel._config, system_prompt="A different system instruction. " * 900)
    changed = run()["result"]
    assert changed["breakdown"]["system_prompt"] != result["breakdown"]["system_prompt"]
    assert list(root.rglob("*")) == before
    assert "system_prompt" not in changed  # counts only


def test_history_and_modes_use_canonical_counters(preview):
    kernel, run, _root = preview
    messages = [{"role": "user", "content": "Hello world"}]
    result = run(messages=messages)["result"]
    assert result["breakdown"]["messages"] == estimate_messages_tokens(
        messages, kernel._tokenizer_backend()
    )
    plan = run(run_mode="plan", messages=messages)["result"]
    assert plan["used_tokens"] > result["used_tokens"]
    assert plan["used_tokens"] == sum(plan["breakdown"].values())


def test_invalid_authority_model_and_request_are_closed(preview):
    _kernel, run, _root = preview
    assert "error" in run(execution_context=None)
    assert "error" in run(extra="untrusted")
    assert "error" in run(run_mode="bogus")
    assert "error" in run(session_start_date="16 October")
    assert run(preferred_model="other-model")["result"]["reason"] == "model_not_active"
    assert AUXILIARY_FAMILY_BY_METHOD[CONTEXT_PREVIEW_METHOD] == "context_preview"


def test_primary_role_and_profile_overview_are_counted(preview):
    # Row 69: the preview mirrors chat.send's session_role and profile_overview block.
    _kernel, run, _root = preview
    plain = run()["result"]
    primary = run(session_role="primary")["result"]
    assert primary["used_tokens"] > plain["used_tokens"]
    overview = [{"kind": "profile_overview", "content": "## Profile Overview\nProjects: 3"}]
    with_block = run(session_role="primary", context_blocks=overview)["result"]
    assert with_block["used_tokens"] > primary["used_tokens"]
    for bad in (None, "child"):
        assert "error" in run(session_role=bad)


def test_local_trailing_context_does_not_double_count_copied_history(preview):
    kernel, run, _root = preview
    kernel._config = replace(kernel._config, engine_type="ollama", tools_enabled=False)
    fresh = run()["result"]
    history = [{"role": "user", "content": "A long conversation. " * 3000}]
    populated = run(messages=history)["result"]
    history_tokens = estimate_messages_tokens(
        compact_semantic_messages_with_report(history).messages, kernel._tokenizer_backend()
    )
    assert populated["used_tokens"] == fresh["used_tokens"] + history_tokens
    assert populated["breakdown"]["messages"] == history_tokens
    assert populated["breakdown"]["system_prompt"] == fresh["breakdown"]["system_prompt"]
    assert populated["breakdown"]["other"] == fresh["breakdown"]["other"]
    assert all(value >= 0 for value in populated["breakdown"].values())
    assert populated["used_tokens"] == sum(populated["breakdown"].values())


def test_tool_history_uses_canonical_envelopes_and_admission(preview):
    kernel, run, _root = preview
    history = [
        {"role": "user", "content": "Read the file"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "call_1", "name": "read_file", "arguments": '{"path":"a.txt"}'}],
        },
        {"role": "tool", "tool_call_id": "call_1", "name": "read_file", "content": "hello"},
    ]
    prepared = compact_semantic_messages_with_report(
        reframe_tool_history_messages(history, config=kernel._config)
    ).messages
    expected = estimate_messages_tokens(prepared, kernel._tokenizer_backend())
    assert expected != estimate_messages_tokens(history, kernel._tokenizer_backend())
    assert run(messages=history)["result"]["breakdown"]["messages"] == expected


def test_workspace_instructions_follow_request_root(preview):
    _kernel, run, root = preview
    (root / "agentj.md").write_text("Project instructions: keep changes small. " * 30)
    rooted = run(execution_context=_payload(root.resolve()))["result"]
    unbound = run()["result"]
    assert rooted["breakdown"]["instructions"] > 0
    assert unbound["breakdown"]["instructions"] == 0


def test_tools_preferences_and_unknown_capacity(preview, monkeypatch):
    kernel, run, root = preview
    kernel._config = replace(kernel._config, tools_enabled=True)
    rooted = _payload(root.resolve())
    unbound = run()["result"]
    normal = run(execution_context=rooted)["result"]
    # A bound root admits the workspace tools, exactly as the real send does.
    assert normal["breakdown"]["tools"] > unbound["breakdown"]["tools"] > 0
    disabled = run(execution_context=rooted, tool_preferences={"disabled_tools": ["memory"]})[
        "result"
    ]
    assert disabled["breakdown"]["tools"] < normal["breakdown"]["tools"]
    assert all(count >= 0 for count in normal["breakdown"].values())
    kernel._config = replace(kernel._config, context_length=0)
    monkeypatch.setattr(kernel._engine, "get_model_context_length", lambda: None)
    unknown = run()["result"]
    assert unknown["capacity_tokens"] is None
    assert unknown["reserve_tokens"] is None
    assert unknown["available_tokens"] is None


_COMPACTION_ON = {"token_budget": True, "context_compaction": True}


def _observe_tool_payload(monkeypatch):
    """Call through the real filter and keep the payload the request would send."""
    seen = {}
    real = preview_module.apply_budget_aware_tool_filter

    def observed(*args, **kwargs):
        result = real(*args, **kwargs)
        seen["payload"] = list(result.tool_payload)
        return result

    monkeypatch.setattr(preview_module, "apply_budget_aware_tool_filter", observed)
    return seen


def _turn_boundary_budget(kernel, payload):
    """The budget exactly as the chat send's preflight builds it."""
    num_tools = count_full_tool_schemas(payload) if kernel._config.tools_enabled else 0
    _messages, budget, _tracker = apply_budget_check(
        [],
        kernel._config,
        kernel._engine,
        num_tools=num_tools,
        tool_schema_tokens=estimate_tool_schema_tokens(payload) if num_tools else None,
    )
    return budget, num_tools


def test_compaction_point_matches_turn_boundary_budget(preview, monkeypatch):
    kernel, run, root = preview
    kernel._config = replace(kernel._config, tools_enabled=True, feature_flags=_COMPACTION_ON)
    seen = _observe_tool_payload(monkeypatch)
    result = run(execution_context=_payload(root.resolve()))["result"]
    budget, num_tools = _turn_boundary_budget(kernel, seen["payload"])
    assert num_tools > 0 and result["breakdown"]["tools"] > 0
    expected = budget.auto_compact_threshold(num_tools) + result["breakdown"]["tools"]
    assert result["compact_at_tokens"] == min(expected, result["capacity_tokens"])
    assert 0 < result["compact_at_tokens"] < result["capacity_tokens"]
    assert result["reserve_tokens"] == result["capacity_tokens"] - result["compact_at_tokens"]


def test_compaction_point_needs_both_flags(preview):
    kernel, run, _root = preview
    for flags in (None, {"token_budget": True}, {"context_compaction": True}):
        kernel._config = replace(kernel._config, feature_flags=flags)
        result = run()["result"]
        assert result["capacity_tokens"] == 32768
        assert result["compact_at_tokens"] is None
        assert result["reserve_tokens"] is None


def test_unknown_capacity_has_no_compaction_point(preview, monkeypatch):
    kernel, run, _root = preview
    kernel._config = replace(kernel._config, context_length=0, feature_flags=_COMPACTION_ON)
    monkeypatch.setattr(kernel._engine, "get_model_context_length", lambda: None)
    result = run()["result"]
    assert result["capacity_tokens"] is None
    assert result["compact_at_tokens"] is None
    assert result["reserve_tokens"] is None


def test_budget_failure_drops_only_the_compaction_point(preview, monkeypatch):
    kernel, run, _root = preview
    kernel._config = replace(kernel._config, feature_flags=_COMPACTION_ON)

    def unreadable():
        raise ValueError("metadata unavailable")

    monkeypatch.setattr(kernel._engine, "get_model_max_output_tokens", unreadable)
    result = run()["result"]
    assert result["status"] == "estimated"
    assert result["capacity_tokens"] == 32768
    assert result["compact_at_tokens"] is None
    assert result["reserve_tokens"] is None


def test_capacity_is_the_window_requests_are_budgeted_with(preview, monkeypatch):
    kernel, run, _root = preview
    kernel._config = replace(kernel._config, feature_flags=_COMPACTION_ON)
    # A native window below the configured length: the request budget uses it.
    monkeypatch.setattr(kernel._engine, "get_model_context_length", lambda: 16384)
    result = run()["result"]
    assert result["capacity_tokens"] == 16384
    assert result["available_tokens"] == 16384 - result["used_tokens"]
    assert result["reserve_tokens"] == 16384 - result["compact_at_tokens"]


def test_the_send_meter_reads_on_the_preview_scale(preview, monkeypatch):
    # The ring shows this preview between turns and the send's context.usage during
    # one: the same prompt must read the same used tokens and auto-compact point.
    kernel, run, _root = preview
    kernel._config = replace(kernel._config, tools_enabled=True, feature_flags=_COMPACTION_ON)
    history = [{"role": "user", "content": "A long conversation. " * 1500}]
    result = run(messages=history)["result"]
    monkeypatch.setattr(kernel._engine, "generate", lambda **_kwargs: "Done.")
    # One tool iteration whose provider reports a prompt far below the real one (a
    # replay engine's fixed usage): the meter still counts the assembled prompt.
    kernel._engine._tool_call_responses = [
        GenerationResult(
            content="",
            finish_reason="tool_calls",
            tool_calls=(ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"}),),
            usage=GenerationUsage(
                input_tokens=32, output_tokens=5, total_tokens=37, last_request_input_tokens=32
            ),
        )
    ]
    events = []
    kernel.build_chat_decision(
        request_id="send_1",
        messages=history,
        latest_user_content=history[-1]["content"],
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(emit=events.append, request_id="send_1", max_iterations=2),
    )
    readings = [event for event in events if isinstance(event, ContextUsageEvent)]
    preflight, iteration = readings[0], readings[-1]
    assert (preflight.phase, iteration.phase) == ("preflight", "iteration")
    assert result["breakdown"]["tools"] > 0
    assert preflight.compact_threshold_tokens == result["compact_at_tokens"]
    assert abs(preflight.context_used_tokens - result["used_tokens"]) <= 16
    # The tool round only adds a little: the reading moves on, it never collapses.
    assert iteration.compact_threshold_tokens == result["compact_at_tokens"]
    assert 0 < iteration.context_used_tokens - preflight.context_used_tokens < 600


def test_compaction_point_crosses_exactly_when_the_turn_would_compact(preview, monkeypatch):
    kernel, run, root = preview
    kernel._config = replace(kernel._config, tools_enabled=True, feature_flags=_COMPACTION_ON)
    seen = _observe_tool_payload(monkeypatch)
    rooted = _payload(root.resolve())
    outcomes = set()
    for repeats in (0, 2000, 4000, 5000, 6000, 8000):
        history = [{"role": "user", "content": "A long conversation. " * repeats}]
        result = run(execution_context=rooted, messages=history)["result"]
        budget, num_tools = _turn_boundary_budget(kernel, seen["payload"])
        prompt_without_tools = result["used_tokens"] - result["breakdown"]["tools"]
        would_compact = prompt_without_tools >= budget.auto_compact_threshold(num_tools)
        assert (result["used_tokens"] >= result["compact_at_tokens"]) is would_compact
        outcomes.add(would_compact)
    assert outcomes == {True, False}


_CALIBRATION = {
    "provider_tokens": 1500,
    "estimate_tokens": 1000,
    "engine": "ninfer",
    "model": "qwen3.8",
    "estimator": "CharEstimationBackend",
}


def _capture_preview_calibration(monkeypatch):
    seen = {}
    real = dispatch_module.preview_context

    def observed(*args, **kwargs):
        seen["calibration"] = kwargs.get("context_calibration")
        seen["request_calibration"] = getattr(args[1], "context_calibration", None)
        return real(*args, **kwargs)

    monkeypatch.setattr(dispatch_module, "preview_context", observed)
    return seen


def test_preview_passes_a_valid_calibration_through(preview, monkeypatch):
    _kernel, run, _root = preview
    seen = _capture_preview_calibration(monkeypatch)
    assert run(context_calibration=dict(_CALIBRATION))["result"]["status"] == "estimated"
    assert seen["calibration"] == _CALIBRATION
    # The tool-budget probe inside the preview reads the request's copy.
    request_calibration = seen["request_calibration"]
    assert request_calibration is not None
    assert request_calibration.provider_tokens == _CALIBRATION["provider_tokens"]


@pytest.mark.parametrize(
    "bad",
    [
        {**_CALIBRATION, "provider_tokens": -1},
        {**_CALIBRATION, "estimate_tokens": True},
        {**_CALIBRATION, "model": ""},
        {"provider_tokens": 1500},
        "not-a-mapping",
        None,
    ],
)
def test_preview_fails_a_malformed_calibration_closed(preview, monkeypatch, bad):
    _kernel, run, _root = preview
    seen = _capture_preview_calibration(monkeypatch)
    assert run(context_calibration=bad)["result"]["status"] == "estimated"
    assert seen["calibration"] is None
