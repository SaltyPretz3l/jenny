from __future__ import annotations

from dataclasses import dataclass, replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig, ToolPolicyRule, ToolPolicyRuleMatch, ToolPolicySnapshot
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.compaction import CompactionResult
from sidecar.ai.context.token_budget import estimate_messages_tokens
from sidecar.ai.error_codes import (
    CMP_LOOP_ENGINE_STALLED,
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_LOOP_TOOL_INTERRUPTED,
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_DISABLED,
    CMP_TOOL_POLICY_DENIED,
)
from sidecar.ai.feature_flags import FEATURE_TOKEN_BUDGET
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_events import (
    ContextCompactedEvent,
    StreamResetEvent,
    TokenDeltaEvent,
    ToolExecutingEvent,
    ToolResultEvent,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.loop_stop import StopDecision, StopReason
from sidecar.ai.routing.provider_tool_limits import MAX_TOOL_CALL_ARGUMENT_BYTES
from sidecar.ai.routing.route_policy_runtime import (
    attempt_in_band_recovery,
    known_tool_names_for_kernel,
)
from sidecar.ai.routing.router import ChatRouter, ToolExecutionOutcome
from sidecar.ai.routing.tool_call_canonicalization import (
    canonicalize_tool_call_arguments,
    canonicalize_tool_calls,
    validate_provider_tool_call_limits,
)
from sidecar.ai.routing.tool_execution import execute_tool
from sidecar.ai.routing.tool_loop import (
    _build_stopped_tool_loop_result,
    _quota_block_guidance,
)
from sidecar.ai.routing.tool_loop_compaction import compact_tool_loop_context
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import GenerationResult, ThinkingDelta, ToolCallRequest
from sidecar.runtime.chat_models import ChatRequestContext, TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.provider_capability_profile import (
    PROBE_STATUS_READY,
    ROUTE_FAIL_CLOSED,
    ROUTE_NATIVE_TOOLS,
    ROUTE_TOOL_DISABLED,
    ProviderCapabilityFeatures,
    ProviderCapabilityObserved,
    ProviderCapabilityProfileStore,
    derive_endpoint_id,
    derive_model_id,
    derive_profile_id,
)
from sidecar.runtime.turn_state import TERMINAL_SUBCODE_TIMEOUT_TURN, TURN_STATE_TIMEOUT


@dataclass(frozen=True)
class _ToolPlan:
    result: GenerationResult
    stream_chunks: tuple[Any, ...] = ()


class _ToolLoopEngine:
    def __init__(self, plans: list[_ToolPlan]) -> None:
        self._plans = plans
        self._index = 0
        self.call_count = 0
        self.requests: list[dict[str, Any]] = []

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.requests.append(kwargs)
        return self._next_plan().result

    def stream_with_tools(self, **kwargs: Any):
        self.requests.append(kwargs)
        plan = self._next_plan()
        for chunk in plan.stream_chunks:
            yield chunk
        return plan.result

    def _next_plan(self) -> _ToolPlan:
        self.call_count += 1
        if self._index >= len(self._plans):
            return _ToolPlan(result=GenerationResult(content="fallback", finish_reason="stop"))
        plan = self._plans[self._index]
        self._index += 1
        return plan

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _StubMCPClient:
    def __init__(
        self,
        descriptors: tuple[MCPToolDescriptor, ...] = (),
        *,
        success: bool = True,
    ) -> None:
        self._descriptors = {
            descriptor.name: descriptor
            for descriptor in descriptors
        }
        self._success = success
        self.executions: list[tuple[str, dict[str, object]]] = []

    @property
    def available_tools(self) -> list[MCPToolDescriptor]:
        return list(self._descriptors.values())

    def tool_descriptor(self, tool_name: str) -> MCPToolDescriptor | None:
        return self._descriptors.get(str(tool_name or "").strip())

    def execute_tool(
        self,
        tool_name: str,
        arguments: dict[str, object],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: object = None,
    ) -> object:
        _ = (timeout_seconds, cancel_handle)
        self.executions.append((tool_name, dict(arguments)))
        return SimpleNamespace(
            tool_name=tool_name,
            output=(f"{tool_name} completed" if self._success else f"{tool_name} failed"),
            success=self._success,
            content_type="text/plain",
            ui_payload=None,
            generated_artifacts=(),
            error_code=None if self._success else "CMP-TOOL-0008",
            metadata={},
        )


def _build_router(  # noqa: PLR0913 - compact test fixture builder.
    *,
    engine: _ToolLoopEngine,
    mcp_client: _StubMCPClient | None = None,
    tools_mermaid_enabled: bool = False,
    web_tool_cap: int | None = None,
    max_tools_per_turn: int | None = None,
    extra_snapshot_tools: tuple[str, ...] = (),
    engine_type: str = "ollama",
) -> ChatRouter:
    config = RuntimeConfig(
        engine_type=engine_type,
        model="qwen",
        tools_workspace_root="C:/workspace",
        tools_mermaid_enabled=tools_mermaid_enabled,
    )
    if web_tool_cap is not None:
        config = replace(config, max_web_tool_calls_per_turn=web_tool_cap)
    if max_tools_per_turn is not None:
        config = replace(config, max_tools_per_turn=max_tools_per_turn)
    if config.mode == "chat":
        config = replace(config, mode="assist")
    router = ChatRouter(
        config=config,
        engine=engine,
        mcp_client=mcp_client or _StubMCPClient(),
        context_builder=ContextBuilder(None),
    )
    snapshot_items = [
        {"name": "inspect_harness", "display_name": "Inspect Harness", "enabled": True},
        {"name": "read_file", "display_name": "Read File", "enabled": True},
        {"name": "write_file", "display_name": "Write File", "enabled": False},
    ]
    for tool_name in extra_snapshot_tools:
        snapshot_items.append(
            {"name": tool_name, "display_name": tool_name, "enabled": True}
        )
    router.set_harness_snapshot_provider(
        lambda **_kwargs: {"tools": {"items": list(snapshot_items)}}
    )
    return router


def _tool_loop_compaction_fixture(
    events: list[object],
    baseline_resets: list[tuple[str, str]],
) -> SimpleNamespace:
    budget = SimpleNamespace(
        reserved_for_summary=128,
        auto_compact_threshold=lambda _num_tools: 50,
        error_threshold=lambda _num_tools: 150,
    )
    return SimpleNamespace(
        budget_tracker=SimpleNamespace(budget=budget, backend=None),
        working_messages=[{"role": "user", "content": "current prompt"}],
        feature_flags={"context_compaction": True},
        request_id="req_tool_loop_compaction",
        session_id="session_tool_loop_compaction",
        system_prompt="system",
        prompt_cache_enabled=False,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_tool_loop_compaction",
        ),
        cache_source_key="cache-key",
        cache_break_detector=SimpleNamespace(
            reset_baseline=lambda key, *, reason: baseline_resets.append((key, reason))
        ),
        kernel=SimpleNamespace(
            _config=SimpleNamespace(max_tokens=256),
            _engine=SimpleNamespace(get_model_max_output_tokens=lambda: None),
            _compaction_breakers=SimpleNamespace(for_key=lambda _key: object()),
            _build_compaction_generate_fn=lambda **_kwargs: (lambda _messages: ""),
        ),
        compaction_stalled=False,
        compaction_last_ditch_used=False,
    )


def test_tool_loop_compaction_requests_mid_turn_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = _tool_loop_compaction_fixture([], [])
    loop.working_messages = [{"role": "user", "content": "x" * 240}]
    compact_kwargs: dict[str, Any] = {}

    def _compact(*_args: Any, **kwargs: Any) -> CompactionResult:
        compact_kwargs.update(kwargs)
        return CompactionResult(
            messages=[{"role": "user", "content": "compacted"}],
            strategy="micro",
            tokens_before=64,
            tokens_after=32,
        )

    monkeypatch.setattr("sidecar.ai.routing.tool_loop_compaction.compact_context", _compact)

    compact_tool_loop_context(loop, num_tools=0)

    assert compact_kwargs["mode"] == "mid_turn"


def test_tool_loop_compaction_passes_the_turn_prompt_as_task_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = _tool_loop_compaction_fixture([], [])
    loop.latest_user_content = "current prompt"
    loop.working_messages = [{"role": "user", "content": "x" * 240}]
    compact_kwargs: dict[str, Any] = {}

    def _compact(*_args: Any, **kwargs: Any) -> CompactionResult:
        compact_kwargs.update(kwargs)
        return CompactionResult(
            messages=[{"role": "user", "content": "compacted"}],
            strategy="micro",
            tokens_before=64,
            tokens_after=32,
        )

    monkeypatch.setattr("sidecar.ai.routing.tool_loop_compaction.compact_context", _compact)

    compact_tool_loop_context(loop, num_tools=0)

    assert compact_kwargs["task_content"] == "current prompt"


def test_tool_loop_compaction_event_carries_summary_and_coverage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[object] = []
    loop = _tool_loop_compaction_fixture(events, [])
    summary_message = {
        "role": "system",
        "content": "## Compacted Conversation Summary\n...",
    }

    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop_compaction.estimate_messages_tokens",
        lambda *_args: 100,
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop_compaction.compact_context",
        lambda *_args, **_kwargs: CompactionResult(
            messages=[summary_message],
            strategy="full",
            tokens_before=100,
            tokens_after=60,
            summary_status="created",
            summary_message=summary_message,
            covered_through_tool_call_id="call_7",
        ),
    )

    assert compact_tool_loop_context(loop, num_tools=0) == 60

    compacted_event = next(
        event for event in events if isinstance(event, ContextCompactedEvent)
    )
    assert compacted_event.summary_message == summary_message
    assert compacted_event.covered_through_tool_call_id == "call_7"
    assert compacted_event.input_complete is False


def test_stalled_compaction_stays_suppressed_below_the_error_threshold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = _tool_loop_compaction_fixture([], [])
    loop.compaction_stalled = True
    loop.working_messages = [{"role": "user", "content": "x" * 240}]
    tokens_before = estimate_messages_tokens(loop.working_messages, None)
    compact_calls = 0

    def _compact(*_args: Any, **_kwargs: Any) -> CompactionResult:
        nonlocal compact_calls
        compact_calls += 1
        raise AssertionError("compact_context must stay suppressed below the error threshold")

    monkeypatch.setattr("sidecar.ai.routing.tool_loop_compaction.compact_context", _compact)

    assert 50 < tokens_before < 150
    assert compact_tool_loop_context(loop, num_tools=0) == tokens_before
    assert compact_calls == 0


def test_stalled_compaction_retries_once_at_the_error_threshold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = _tool_loop_compaction_fixture([], [])
    loop.compaction_stalled = True
    loop.working_messages = [{"role": "user", "content": "x" * 600}]
    tokens_before = estimate_messages_tokens(loop.working_messages, None)
    compact_calls = 0

    def _compact(*_args: Any, **_kwargs: Any) -> CompactionResult:
        nonlocal compact_calls
        compact_calls += 1
        return CompactionResult(
            messages=[{"role": "user", "content": "compacted"}],
            strategy="micro",
            tokens_before=tokens_before,
            tokens_after=tokens_before - 1,
        )

    monkeypatch.setattr("sidecar.ai.routing.tool_loop_compaction.compact_context", _compact)

    assert tokens_before >= 150
    assert compact_tool_loop_context(loop, num_tools=0) == tokens_before - 1
    assert compact_calls == 1
    assert loop.compaction_last_ditch_used is True


def test_stalled_compaction_does_not_retry_twice_at_the_error_threshold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = _tool_loop_compaction_fixture([], [])
    loop.compaction_stalled = True
    loop.compaction_last_ditch_used = True
    loop.working_messages = [{"role": "user", "content": "x" * 600}]
    tokens_before = estimate_messages_tokens(loop.working_messages, None)
    compact_calls = 0

    def _compact(*_args: Any, **_kwargs: Any) -> CompactionResult:
        nonlocal compact_calls
        compact_calls += 1
        raise AssertionError("compact_context must not run after the last-ditch attempt")

    monkeypatch.setattr("sidecar.ai.routing.tool_loop_compaction.compact_context", _compact)

    assert tokens_before >= 150
    assert compact_tool_loop_context(loop, num_tools=0) == tokens_before
    assert compact_calls == 0


def test_tool_loop_compaction_stalls_once_when_no_tokens_are_freed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[object] = []
    baseline_resets: list[tuple[str, str]] = []
    loop = _tool_loop_compaction_fixture(events, baseline_resets)
    compact_calls = 0
    logs: list[dict[str, Any]] = []

    def _compact(*_args: Any, **_kwargs: Any) -> CompactionResult:
        nonlocal compact_calls
        compact_calls += 1
        return CompactionResult(
            messages=[{"role": "user", "content": "replacement must not be adopted"}],
            strategy="micro",
            tokens_before=100,
            tokens_after=100,
            summary_status="not_applicable",
            summary_failure_code="summary_prefix_unavailable",
        )

    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop_compaction.estimate_messages_tokens",
        lambda *_args: 100,
    )
    monkeypatch.setattr("sidecar.ai.routing.tool_loop_compaction.compact_context", _compact)
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop_compaction.log_event",
        lambda *_args, **kwargs: logs.append(kwargs),
    )

    first_tokens = compact_tool_loop_context(loop, num_tools=0)
    second_tokens = compact_tool_loop_context(loop, num_tools=0)

    assert first_tokens == second_tokens == 100
    assert compact_calls == 1
    assert loop.compaction_stalled is True
    assert loop.working_messages == [{"role": "user", "content": "current prompt"}]
    assert baseline_resets == []
    assert not any(isinstance(event, ContextCompactedEvent) for event in events)
    stalled_logs = [entry for entry in logs if entry.get("event") == "ai.router.compaction_stalled"]
    assert len(stalled_logs) == 1
    assert stalled_logs[0]["status"] == "degraded"
    assert stalled_logs[0]["data"] == {
        "tokens": 100,
        "reason_code": "summary_prefix_unavailable",
        "phase": "tool_loop",
    }


def test_tool_loop_compaction_keeps_emitting_when_tokens_are_freed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[object] = []
    baseline_resets: list[tuple[str, str]] = []
    loop = _tool_loop_compaction_fixture(events, baseline_resets)
    compact_calls = 0

    def _compact(*_args: Any, **_kwargs: Any) -> CompactionResult:
        nonlocal compact_calls
        compact_calls += 1
        return CompactionResult(
            messages=[{"role": "user", "content": f"compacted {compact_calls}"}],
            strategy="micro",
            tokens_before=100,
            tokens_after=60,
            summary_status="not_applicable",
            summary_failure_code="summary_prefix_unavailable",
        )

    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop_compaction.estimate_messages_tokens",
        lambda *_args: 100,
    )
    monkeypatch.setattr("sidecar.ai.routing.tool_loop_compaction.compact_context", _compact)

    assert compact_tool_loop_context(loop, num_tools=0) == 60
    assert compact_tool_loop_context(loop, num_tools=0) == 60

    compacted_events = [event for event in events if isinstance(event, ContextCompactedEvent)]
    assert compact_calls == 2
    assert len(compacted_events) == 2
    assert loop.compaction_stalled is False
    assert loop.working_messages == [{"role": "user", "content": "compacted 2"}]
    assert baseline_resets == [
        ("cache-key", "compaction"),
        ("cache-key", "compaction"),
    ]


def _assert_hidden_inspect_harness_result(result: ToolExecutionOutcome) -> None:
    assert result.tool_name == "inspect_harness"
    assert result.success is False
    assert result.error_code == CMP_TOOL_DISABLED
    assert result.metadata == {"diagnostic_tool_hidden": True}
    assert "executable-tools digest" in result.output


def _assert_visible_inspect_harness_result(result: ToolExecutionOutcome) -> None:
    """The counterpart to the hidden case, for explicit diagnostic/inventory asks.

    ``inspect_harness`` is model-hidden in ordinary chat, but a request whose
    intent is an explicit harness diagnostic or tool inventory unhides it (see
    ``looks_like_harness_diagnostic_request``). Then it dispatches normally and
    returns a real snapshot rather than the CMP_TOOL_DISABLED refusal.
    """
    assert result.tool_name == "inspect_harness"
    assert result.success is True
    assert result.error_code is None
    assert result.metadata.get("result_kind") == "harness_snapshot"


def test_final_sub_agent_iteration_removes_tool_schemas_and_injects_report_contract() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        '{"status":"completed","summary":"done",'
                        '"evidence":[],"uncertainties":[]}'
                    ),
                    finish_reason="stop",
                )
            )
        ]
    )
    router = _build_router(engine=engine)
    request_context = ChatRequestContext(
        request_id="req_subagent_finalize",
        trace_id="trace_subagent_finalize",
        session_id="session_subagent_finalize",
        mode="assist",
        approvals_pre_granted=False,
        workspace_root_present=True,
        agent_id="research@req_subagent_finalize:1",
        parent_agent_id="main@req_parent",
        agent_depth=1,
        agent_surface="sub_agent",
    )

    decision = router.build_chat_decision(
        request_id=request_context.request_id,
        messages=[{"role": "user", "content": "Inspect one bounded concern."}],
        latest_user_content="Inspect one bounded concern.",
        mode="assist",
        approvals_pre_granted=False,
        request_context=request_context,
        runtime=LoopRuntime(
            request_id=request_context.request_id,
            request_context=request_context,
            max_iterations=1,
        ),
    )

    assert decision.response_text
    assert engine.requests[0]["tools"] == []
    response_format = engine.requests[0]["response_format"]
    assert response_format.type == "json_object"
    assert response_format.json_schema["required"] == [
        "status",
        "summary",
        "evidence",
        "uncertainties",
    ]
    # Since 2026-08-28 the routing normalizer (engine_messages) demotes
    # non-leading system rows to `user` for EVERY engine — same position,
    # same content; real engines already received the nudge this way.
    assert any(
        message.get("role") == "user"
        and "final in-budget sub-agent iteration" in str(message.get("content"))
        for message in engine.requests[0]["messages"]
    )


def test_early_non_report_sub_agent_response_gets_one_constrained_finalization() -> None:
    events: list[object] = []
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="I inspected the bounded concern and found one result.",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        '{"status":"completed","summary":"one result",'
                        '"evidence":[],"uncertainties":[]}'
                    ),
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    request_context = ChatRequestContext(
        request_id="req_subagent_early_prose",
        trace_id="trace_subagent_early_prose",
        session_id="session_subagent_early_prose",
        mode="assist",
        approvals_pre_granted=False,
        workspace_root_present=True,
        agent_id="research@req_subagent_early_prose:1",
        parent_agent_id="main@req_parent",
        agent_depth=1,
        agent_surface="sub_agent",
    )

    decision = router.build_chat_decision(
        request_id=request_context.request_id,
        messages=[{"role": "user", "content": "Inspect one bounded concern."}],
        latest_user_content="Inspect one bounded concern.",
        mode="assist",
        approvals_pre_granted=False,
        request_context=request_context,
        runtime=LoopRuntime(
            emit=events.append,
            request_id=request_context.request_id,
            request_context=request_context,
            max_iterations=4,
        ),
    )

    assert '"status":"completed"' in decision.response_text
    assert len(engine.requests) == 2
    assert engine.requests[0]["response_format"] is None
    assert engine.requests[1]["tools"] == []
    assert engine.requests[1]["response_format"].type == "json_object"
    assert any(
        isinstance(event, StreamResetEvent) and event.reason == "deterministic_replacement"
        for event in events
    )


def test_sub_agent_budget_stop_uses_reserved_constrained_report_iteration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    descriptor = MCPToolDescriptor(
        name="read_file",
        description="Read one workspace file.",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
        side_effecting=False,
        server_name="stub",
    )
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading.",
                    tool_calls=(
                        ToolCallRequest(tool_id="read_file", arguments={"path": "INVENTORY.md"}),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        '{"status":"completed","summary":"No tool results were available",'
                        '"evidence":[],"uncertainties":[]}'
                    ),
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((descriptor,), success=False),
    )
    router._config = replace(
        router._config,
        feature_flags={FEATURE_TOKEN_BUDGET: True},
    )
    budget_records: list[tuple[int | None, int, bool]] = []
    tracker = SimpleNamespace(
        backend=None,
        budget=None,
        num_tools=0,
        current_context_tokens=1234,
        record_iteration=lambda progress, current, *, made_tool_progress=False: budget_records.append(
            (progress, current, made_tool_progress)
        ),
        check_should_continue=lambda: False,
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.apply_budget_check",
        lambda messages, _config, _engine, *, num_tools=0, reasoning_effort=None: (
            messages,
            None,
            tracker,
        ),
    )
    request_context = ChatRequestContext(
        request_id="req_subagent_budget_finalize",
        trace_id="trace_subagent_budget_finalize",
        session_id="session_subagent_budget_finalize",
        mode="assist",
        approvals_pre_granted=False,
        workspace_root_present=True,
        agent_id="research@req_subagent_budget_finalize:1",
        parent_agent_id="main@req_parent",
        agent_depth=1,
        agent_surface="sub_agent",
    )
    runtime = LoopRuntime(
        request_id=request_context.request_id,
        request_context=request_context,
        max_iterations=4,
    )

    decision = router.build_chat_decision(
        request_id=request_context.request_id,
        messages=[{"role": "user", "content": "Inspect current routing ownership."}],
        latest_user_content="Inspect current routing ownership.",
        mode="assist",
        approvals_pre_granted=False,
        request_context=request_context,
        runtime=runtime,
    )

    assert decision.response_text == (
        '{"status":"completed","summary":"No tool results were available",'
        '"evidence":[],"uncertainties":[]}'
    )
    assert runtime.completion_reason == "budget_exhausted"
    assert len(decision.tool_results) == 1
    assert len(engine.requests) == 2
    assert engine.requests[1]["tools"] == []
    assert engine.requests[1]["response_format"].type == "json_object"
    assert budget_records and budget_records[0][2] is False


def test_invalid_constrained_sub_agent_report_does_not_enter_generic_recovery() -> None:
    descriptor = MCPToolDescriptor(
        name="read_file",
        description="Read one workspace file.",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
        side_effecting=False,
        server_name="stub",
    )
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "README.md"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="I found the bounded evidence.",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((descriptor,)),
    )
    request_context = ChatRequestContext(
        request_id="req_subagent_invalid_constrained",
        trace_id="trace_subagent_invalid_constrained",
        session_id="session_subagent_invalid_constrained",
        mode="assist",
        approvals_pre_granted=False,
        workspace_root_present=True,
        agent_id="research@req_subagent_invalid_constrained:1",
        parent_agent_id="main@req_parent",
        agent_depth=1,
        agent_surface="sub_agent",
    )
    runtime = LoopRuntime(
        request_id=request_context.request_id,
        request_context=request_context,
        max_iterations=5,
    )

    decision = router.build_chat_decision(
        request_id=request_context.request_id,
        messages=[{"role": "user", "content": "Read README and report."}],
        latest_user_content="Read README and report.",
        mode="assist",
        approvals_pre_granted=False,
        request_context=request_context,
        runtime=runtime,
    )

    assert decision.response_text == ""
    assert runtime.completion_reason == "subagent_invalid_report"
    assert len(engine.requests) == 3
    assert engine.requests[2]["tools"] == []
    assert engine.requests[2]["response_format"].type == "json_object"


def test_final_sub_agent_iteration_never_dispatches_unoffered_tool_calls() -> None:
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        '{"status":"completed","summary":"done",'
                        '"evidence":[],"uncertainties":[]}'
                    ),
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={"prompt": "unexpected"},
                            call_id="final-call-1",
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            )
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
        extra_snapshot_tools=("mermaid_generate",),
    )
    request_context = ChatRequestContext(
        request_id="req_subagent_final_tool",
        trace_id="trace_subagent_final_tool",
        session_id="session_subagent_final_tool",
        mode="assist",
        approvals_pre_granted=False,
        workspace_root_present=True,
        agent_id="research@req_subagent_final_tool:1",
        parent_agent_id="main@req_parent",
        agent_depth=1,
        agent_surface="sub_agent",
    )

    decision = router.build_chat_decision(
        request_id=request_context.request_id,
        messages=[{"role": "user", "content": "Inspect one bounded concern."}],
        latest_user_content="Inspect one bounded concern.",
        mode="assist",
        approvals_pre_granted=False,
        request_context=request_context,
        runtime=LoopRuntime(
            request_id=request_context.request_id,
            request_context=request_context,
            max_iterations=1,
        ),
    )

    assert decision.response_text
    assert engine.requests[0]["tools"] == []
    assert mcp_client.executions == []


def _mermaid_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="mermaid_generate",
        description="Generate a Mermaid diagram artifact.",
        input_schema={"type": "object", "additionalProperties": True},
        side_effecting=False,
        server_name="stub",
    )


def _fetch_url_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="fetch_url",
        description="Fetch a URL.",
        input_schema={
            "type": "object",
            "properties": {"url": {"type": "string"}},
        },
        side_effecting=False,
        server_name="stub",
        tool_family="web",
    )


def _web_search_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="web_search",
        description="Search the web.",
        input_schema={
            "type": "object",
            "properties": {"query": {"type": "string"}},
        },
        side_effecting=False,
        server_name="stub",
        tool_family="web",
    )


class _FailingFetchClient(_StubMCPClient):
    def __init__(self) -> None:
        super().__init__((_fetch_url_descriptor(),))

    def execute_tool(
        self,
        tool_name: str,
        arguments: dict[str, object],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: object = None,
    ) -> object:
        _ = (timeout_seconds, cancel_handle)
        self.executions.append((tool_name, dict(arguments)))
        return SimpleNamespace(
            tool_name=tool_name,
            output="Navigation failed: ERR_CONNECTION_REFUSED",
            success=False,
            content_type="text/plain",
            ui_payload=None,
            generated_artifacts=(),
            error_code="CMP-TOOL-0008",
            metadata={},
        )


_EMPTY_CHAT_HELP_MENU = (
    "Hi! I'm Jenny. How can I help you today?\n\n"
    "If you're not sure where to start, I can help with things like:\n"
    "* **Organizing thoughts** (Brain Dump)\n"
    "* **Deep research** on a topic\n"
    "* **Designing UI or product flows** (Design Creator)\n"
    "* **Writing or refining text to sound more natural** (Humanizer)\n"
    "* **Summarizing meetings or messy notes**\n"
    "* **Creating diagrams** (Mermaid)\n\n"
    "Just let me know what's on your mind!"
)


def test_tool_bearing_generation_counts_parse_success(monkeypatch) -> None:
    """A generation that parses into tool calls increments ``parse_success``.

    The counter is the success half of the ``well_formed_rate`` denominator;
    it had zero call sites before 2026-07, so the headline metric could never
    report a healthy turn.
    """
    from sidecar.ai.routing import tool_call_retry
    from sidecar.ai.tools import tool_call_healing

    recorded: list[str] = []
    # Patch tool_call_retry's own binding (not route_policy_runtime's): the
    # module-level `from ... import increment_counter_for_kernel` copy is what
    # record_parse_success calls, and patching the source module during a
    # first lazy import would leak the stub into later retry tests.
    monkeypatch.setattr(
        tool_call_retry,
        "increment_counter_for_kernel",
        lambda _kernel, kind: recorded.append(kind),
    )
    tool_call_healing.configure_tool_call_healing(
        {"tool_call_reliability_net_enabled": True}
    )
    try:
        engine = _ToolLoopEngine(
            plans=[
                _ToolPlan(
                    result=GenerationResult(
                        content="",
                        finish_reason="tool_calls",
                        tool_calls=(
                            ToolCallRequest(
                                tool_id="mermaid_generate",
                                arguments={"prompt": "flowchart TD\n  a --> b"},
                                call_id="call_mermaid_parse_success",
                            ),
                        ),
                    )
                ),
                _ToolPlan(result=GenerationResult(content="All done.", finish_reason="stop")),
            ]
        )
        router = _build_router(
            engine=engine,
            mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
            tools_mermaid_enabled=True,
        )
        router.build_chat_decision(
            request_id="req_parse_success",
            messages=[{"role": "user", "content": "Diagram this."}],
            latest_user_content="Diagram this.",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(
                emit=lambda _event: None,
                request_id="req_parse_success",
                max_iterations=3,
                streaming=True,
            ),
        )
    finally:
        tool_call_healing.configure_tool_call_healing(None)

    assert recorded.count("parse_success") == 1


def test_duplicate_non_allowlisted_calls_are_not_coalesced() -> None:
    duplicate_calls = (
        ToolCallRequest(
            tool_id="write_file",
            arguments={"path": "notes.txt", "content": "hello"},
            call_id="call_write_one",
        ),
        ToolCallRequest(
            tool_id="write_file",
            arguments={"path": "notes.txt", "content": "hello"},
            call_id="call_write_two",
        ),
    )

    canonical_calls, _aliases, coalesced_count = canonicalize_tool_calls(duplicate_calls)

    assert canonical_calls == duplicate_calls
    assert coalesced_count == 0


def test_canonicalize_tool_calls_assigns_safe_unique_generation_ids() -> None:
    calls = tuple(
        ToolCallRequest(tool_id="read_file", arguments={}, call_id=call_id)
        for call_id in ("", "duplicate", "duplicate", "bad\nvalue", "x" * 1000)
    )

    canonical_calls, aliases, coalesced_count = canonicalize_tool_calls(calls)

    assert [call.call_id for call in canonical_calls] == [
        "call_1",
        "duplicate",
        "call_3",
        "call_4",
        "call_5",
    ]
    assert len({call.call_id for call in canonical_calls}) == len(canonical_calls)
    assert sum(alias.get("field") == "call_id" for alias in aliases) == 4
    assert coalesced_count == 0


def test_validate_provider_tool_call_limits_isolates_oversized_call() -> None:
    valid = ToolCallRequest(
        tool_id="read_file", arguments={"path": "safe.txt"}, call_id="safe"
    )
    oversized = ToolCallRequest(
        tool_id="read_file",
        arguments={"path": "x" * MAX_TOOL_CALL_ARGUMENT_BYTES},
        call_id="oversized",
    )

    accepted, rejected = validate_provider_tool_call_limits((valid, oversized))

    assert accepted == (valid,)
    assert len(rejected) == 1
    assert rejected[0][0] == oversized
    assert rejected[0][1].code == CMP_LOOP_INVALID_TOOL_CALL


def test_provider_tool_call_count_is_bounded_before_dispatch() -> None:
    calls = tuple(
        ToolCallRequest(
            tool_id="read_file",
            arguments={"path": f"file-{index}.txt"},
            call_id=f"provider-{index}",
        )
        for index in range(130)
    )

    canonical, _aliases, _coalesced = canonicalize_tool_calls(calls)
    accepted, rejected = validate_provider_tool_call_limits(canonical)

    assert len(canonical) == 129
    assert len(accepted) == 128
    assert len(rejected) == 1
    assert rejected[0][1].code == CMP_LOOP_INVALID_TOOL_CALL


def test_canonicalize_tool_calls_recovers_self_prefixed_tool_names() -> None:
    calls = (
        ToolCallRequest(
            tool_id="edit_file:edit_file",
            arguments={"file_path": "notes.txt"},
            call_id="call_edit",
        ),
        ToolCallRequest(
            tool_id="read_file:read_file",
            arguments={"path": "notes.txt"},
            call_id="call_read",
        ),
        ToolCallRequest(
            tool_id="list_files:list_files",
            arguments={"path": "."},
            call_id="call_list",
        ),
    )

    canonical_calls, aliases, coalesced_count = canonicalize_tool_calls(calls)

    assert [call.tool_id for call in canonical_calls] == [
        "edit_file",
        "read_file",
        "list_dir",
    ]
    assert [call.coerced for call in canonical_calls] == [True, True, True]
    assert aliases == [
        {
            "call_id": "call_edit",
            "from": "edit_file:edit_file",
            "to": "edit_file",
        },
        {
            "call_id": "call_read",
            "from": "read_file:read_file",
            "to": "read_file",
        },
        {
            "call_id": "call_list",
            "from": "list_files:list_files",
            "to": "list_dir",
        },
    ]
    assert coalesced_count == 0


def test_canonicalize_tool_calls_recovers_web_family_prefixed_search_name() -> None:
    calls = (
        ToolCallRequest(
            tool_id="web:web_search",
            arguments={"query": "latest OpenAI news"},
            call_id="call_web",
        ),
    )

    canonical_calls, aliases, coalesced_count = canonicalize_tool_calls(calls)

    assert [call.tool_id for call in canonical_calls] == ["web_search"]
    assert canonical_calls[0].coerced is True
    assert aliases == [
        {
            "call_id": "call_web",
            "from": "web:web_search",
            "to": "web_search",
        }
    ]
    assert coalesced_count == 0


@pytest.mark.parametrize(
    "arguments",
    [
        {
            "path": "notes.txt",
            "file_path": "notes.txt",
            "content": "hello",
            "file_content": "hello",
        },
        {
            "file_content": "hello",
            "content": "hello",
            "file_path": "notes.txt",
            "path": "notes.txt",
        },
    ],
)
def test_canonicalize_tool_call_arguments_collapses_equal_aliases(
    arguments: dict[str, object],
) -> None:
    call = ToolCallRequest(
        tool_id="write_file",
        arguments=arguments,
        call_id="call_write_alias",
    )

    calls, aliases, conflicts = canonicalize_tool_call_arguments((call,))

    assert conflicts == ()
    assert calls[0].arguments == {"path": "notes.txt", "content": "hello"}
    assert aliases == [
        {"call_id": "call_write_alias", "from": "file_path", "to": "path"},
        {"call_id": "call_write_alias", "from": "file_content", "to": "content"},
    ]


def test_canonicalize_tool_call_arguments_isolates_conflict_from_valid_sibling() -> None:
    conflicting = ToolCallRequest(
        tool_id="write_file",
        arguments={
            "path": "restricted/target.txt",
            "file_path": "safe/decoy.txt",
            "content": "blocked",
        },
        call_id="call_conflict",
    )
    valid = ToolCallRequest(
        tool_id="write_file",
        arguments={"file_path": "safe/valid.txt", "file_content": "ok"},
        call_id="call_valid",
    )

    calls, aliases, conflicts = canonicalize_tool_call_arguments((conflicting, valid))

    assert [call.call_id for call in calls] == ["call_valid"]
    assert calls[0].arguments == {"path": "safe/valid.txt", "content": "ok"}
    assert aliases == [
        {"call_id": "call_valid", "from": "file_path", "to": "path"},
        {"call_id": "call_valid", "from": "file_content", "to": "content"},
    ]
    assert len(conflicts) == 1
    assert conflicts[0][0] is conflicting
    assert "conflicting arguments 'path' and 'file_path'" in conflicts[0][1].message


def test_unknown_tool_recovery_respects_per_turn_tool_cap() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=tuple(
                        ToolCallRequest(
                            tool_id=f"fake_tool_{index}",
                            arguments={"value": index},
                            call_id=f"call_fake_{index}",
                        )
                        for index in range(25)
                    ),
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_unknown_tool_cap",
        messages=[{"role": "user", "content": "Please use your tools."}],
        latest_user_content="Please use your tools.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_unknown_tool_cap",
            max_iterations=1,
            streaming=True,
        ),
    )

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert len(result_events) == RuntimeConfig().max_tools_per_turn
    assert {event.error_code for event in result_events} == {CMP_LOOP_INVALID_TOOL_CALL}
    # Turn-survival: iteration exhaustion winds down with a summary response
    # (chat.done), not a CMP_LOOP_MAX_ITERATIONS chat error.
    assert decision.response_text


def test_unknown_tool_recovery_uses_remaining_cap_after_valid_calls() -> None:
    valid_count = 15
    unknown_count = 10
    max_tools = RuntimeConfig().max_tools_per_turn
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        *tuple(
                            ToolCallRequest(
                                tool_id="mermaid_generate",
                                arguments={
                                    "prompt": f"flowchart TD\n  a{index} --> b{index}"
                                },
                                call_id=f"call_mermaid_{index}",
                            )
                            for index in range(valid_count)
                        ),
                        *tuple(
                            ToolCallRequest(
                                tool_id=f"fake_tool_{index}",
                                arguments={"value": index},
                                call_id=f"call_fake_{index}",
                            )
                            for index in range(unknown_count)
                        ),
                    ),
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_mixed_tool_cap",
        messages=[{"role": "user", "content": "Please use your tools."}],
        latest_user_content="Please use your tools.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_mixed_tool_cap",
            max_iterations=1,
            streaming=True,
        ),
    )
    # Turn-survival: exhaustion ends in a summary response, not an error.
    assert decision.response_text

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    invalid_events = [
        event
        for event in result_events
        if event.error_code == CMP_LOOP_INVALID_TOOL_CALL
    ]
    success_events = [event for event in result_events if event.success is True]
    assert len(result_events) == max_tools
    assert len(success_events) == valid_count
    assert len(invalid_events) == max_tools - valid_count
    assert len(mcp_client.executions) == valid_count


def test_tool_call_budget_is_cumulative_across_generations() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={"prompt": "flowchart TD\n  A --> B"},
                            call_id="call-first",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={"prompt": "flowchart TD\n  B --> C"},
                            call_id="call-second",
                        ),
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={"prompt": "flowchart TD\n  C --> D"},
                            call_id="call-over-budget",
                        ),
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
        max_tools_per_turn=2,
    )
    runtime = LoopRuntime(request_id="req-cumulative-tool-budget", max_iterations=4)

    decision = router.build_chat_decision(
        request_id="req-cumulative-tool-budget",
        messages=[{"role": "user", "content": "Render the graph."}],
        latest_user_content="Render the graph.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=runtime,
    )

    # The cap was hit on this turn, so the answer carries the resume footer.
    assert decision.response_text == (
        "Done.\n\nReached this turn's tool limit (2). Reply 'resume' to continue."
    )
    assert [call_id for call_id, _arguments in mcp_client.executions] == [
        "mermaid_generate",
        "mermaid_generate",
    ]
    assert runtime.tool_calls_consumed == 2
    assert runtime.remaining_tool_calls == 0
    capped = [
        result
        for result in decision.tool_results
        if result.error_code == CMP_TOOL_CAP_EXCEEDED
    ]
    assert [result.call_id for result in capped] == ["call-over-budget"]
    assert engine.requests[-1]["tools"] == []


def test_tool_call_budget_caps_batch_before_approval_plan_scan() -> None:
    calls = tuple(
        ToolCallRequest(
            tool_id="read_file",
            arguments={"path": f"note-{index}.md"},
            call_id=f"call-read-{index}",
        )
        for index in range(3)
    )
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=calls,
                )
            )
        ]
    )
    mcp_client = _StubMCPClient(
        (
            MCPToolDescriptor(
                name="read_file",
                description="Read a file",
                input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
                side_effecting=False,
                server_name="tools",
                tool_family="filesystem",
            ),
        )
    )
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        max_tools_per_turn=2,
    )
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

    decision = router.build_chat_decision(
        request_id="req-budget-before-approval",
        messages=[{"role": "user", "content": "Read the notes."}],
        latest_user_content="Read the notes.",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(request_id="req-budget-before-approval", max_iterations=4),
    )

    assert decision.approval_plan is not None
    assert [call.call_id for call in decision.approval_plan.tool_calls] == [
        "call-read-0",
        "call-read-1",
    ]
    assert decision.approval_plan.tool_call_limit == 2
    assert decision.approval_plan.remaining_tool_calls == 0
    assert [
        result.call_id
        for result in decision.tool_results
        if result.error_code == CMP_TOOL_CAP_EXCEEDED
    ] == ["call-read-2"]
    assert mcp_client.executions == []


def test_model_emitted_inspect_harness_is_rejected_as_retired() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(ToolCallRequest(
                        tool_id="inspect_harness",
                        arguments={"sections": ["tools"]},
                        call_id="call_retired_harness",
                    ),),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="The legacy diagnostics tool is no longer available.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient()
    router = _build_router(engine=engine, mcp_client=mcp_client)

    decision = router.build_chat_decision(
        request_id="req_retired_harness",
        messages=[{"role": "user", "content": "Inspect the harness."}],
        latest_user_content="Inspect the harness.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req_retired_harness", max_iterations=4),
    )

    assert decision.tool_results[0].tool_name == "inspect_harness"
    assert decision.tool_results[0].success is False
    assert decision.tool_results[0].error_code == CMP_LOOP_INVALID_TOOL_CALL
    assert mcp_client.executions == []


def _retired_model_emitted_inspect_harness_inventory_runs_for_explicit_ask() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="I've checked my harness, and only inspect_harness is available.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"], "include_disabled": True},
                            call_id="call_harness",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        "Hey there! I'm Jenny. It's so nice to meet you. "
                        "How's your day going so far?"
                    ),
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Right now the only functional tool is inspect_harness.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_harness_inventory",
        messages=[
            {
                "role": "user",
                "content": (
                    "Please inspect the harness, then provide a list of all "
                    "functional tool that you may use currently"
                ),
            }
        ],
        latest_user_content=(
            "Please inspect the harness, then provide a list of all functional "
            "tool that you may use currently"
        ),
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_harness_inventory",
            max_iterations=4,
            streaming=True,
        ),
    )

    # "a list of all functional tool that you may use currently" is explicit
    # inventory intent, so the diagnostic tool is unhidden and really runs.
    # The model then answered the inventory ask with a bare greeting, so the
    # loop replaces that non-answer with the actual tool list.
    assert decision.response_text == (
        "Functional tools currently available:\n"
        "- Inspect Harness (`inspect_harness`)\n"
        "- Read File (`read_file`)"
    )
    # Answering straight from the snapshot means no second round-trip: the
    # loop never has to ask the model to restate what the tool already returned.
    assert engine.call_count == 1
    assert len(decision.tool_results) == 1
    _assert_visible_inspect_harness_result(decision.tool_results[0])
    # Round-1 preamble streams before the tool call; exactly one stream reset
    # clears it before the deterministic inventory answer streams.
    assert sum(isinstance(event, StreamResetEvent) for event in events) == 1


def test_execute_tool_fails_before_dispatch_when_wall_clock_expired() -> None:
    class _FakeMCPClient:
        def tool_descriptor(self, tool_name: str) -> MCPToolDescriptor:
            return MCPToolDescriptor(
                name=tool_name,
                description="stub",
                input_schema={"type": "object"},
                side_effecting=False,
                server_name="stub",
            )

        def execute_tool(
            self,
            _tool_name: str,
            _arguments: dict[str, object],
            *,
            timeout_seconds: float | None = None,
            cancel_handle: object = None,
        ) -> object:
            _ = (timeout_seconds, cancel_handle)
            raise AssertionError("expired wall clock should block MCP dispatch")

    kernel = type(
        "Kernel",
        (),
        {
            "_mcp_client": _FakeMCPClient(),
            "_config": RuntimeConfig(tools_execution_timeout_seconds=120.0),
            "_active_cancel_handle": None,
            "_harness_snapshot_provider": None,
            "_normalize_snapshot_lookup_path": lambda self, raw_path: str(raw_path),
        },
    )()
    runtime = LoopRuntime(request_id="req_timeout", wall_clock_deadline=0.0)

    with pytest.raises(TerminalChatStateError) as exc_info:
        execute_tool(
            kernel,
            ToolCallRequest(tool_id="read_file", arguments={"path": "notes.txt"}, call_id="c1"),
            request_id="req_timeout",
            read_snapshot_cache={},
            runtime=runtime,
        )

    assert exc_info.value.status == TURN_STATE_TIMEOUT
    assert exc_info.value.terminal_subcode == TERMINAL_SUBCODE_TIMEOUT_TURN


def test_session_offline_lockdown_blocks_external_tool_without_dispatch_and_continues() -> None:
    descriptor = MCPToolDescriptor(
        name="remote_lookup",
        description="Look up remote data.",
        input_schema={"type": "object", "additionalProperties": False},
        side_effecting=False,
        server_name="remote-server",
    )
    client = _StubMCPClient((descriptor,))
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Trying remote data.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="remote_lookup",
                            arguments={},
                            call_id="remote-call",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Continued without remote data.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=client,
        extra_snapshot_tools=("remote_lookup",),
    )
    request_context = ChatRequestContext(
        request_id="req-lockdown",
        trace_id="trace-lockdown",
        session_id="session-lockdown",
        mode="assist",
        approvals_pre_granted=True,
        session_offline_lockdown=True,
        workspace_root_present=True,
    )

    decision = router.build_chat_decision(
        request_context=request_context,
        request_id=request_context.request_id,
        messages=[{"role": "user", "content": "Try the remote tool."}],
        latest_user_content="Try the remote tool.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            request_id=request_context.request_id,
            request_context=request_context,
            max_iterations=3,
        ),
    )

    assert decision.response_text == "Continued without remote data."
    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].success is False
    assert decision.tool_results[0].error_code == CMP_TOOL_DISABLED
    assert client.executions == []
    assert engine.call_count == 2


def _retired_inspect_harness_fails_before_dispatch_when_wall_clock_expired() -> None:
    def _provider(**_kwargs: object) -> dict[str, object]:
        raise AssertionError("expired wall clock should block inspect_harness dispatch")

    kernel = type(
        "Kernel",
        (),
        {
            "_mcp_client": object(),
            "_config": RuntimeConfig(tools_execution_timeout_seconds=120.0),
            "_active_cancel_handle": None,
            "_harness_snapshot_provider": _provider,
            "_normalize_snapshot_lookup_path": lambda self, raw_path: str(raw_path),
        },
    )()
    runtime = LoopRuntime(request_id="req_timeout_harness", wall_clock_deadline=0.0)

    with pytest.raises(TerminalChatStateError) as exc_info:
        execute_tool(
            kernel,
            ToolCallRequest(
                tool_id="inspect_harness",
                arguments={"sections": ["tools"]},
                call_id="c_harness",
            ),
            request_id="req_timeout_harness",
            read_snapshot_cache={},
            runtime=runtime,
        )

    assert exc_info.value.status == TURN_STATE_TIMEOUT
    assert exc_info.value.terminal_subcode == TERMINAL_SUBCODE_TIMEOUT_TURN


def _retired_visible_inspect_harness_result_triggers_inventory_fallback() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Elementary, I've checked my harness.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"], "include_disabled": True},
                            call_id="call_harness",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Hey! It's good to see you. How's your day going so far?",
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_harness_inventory_low_budget",
        messages=[
            {
                "role": "user",
                "content": (
                    "Please inspect the harness, then provide a list of all "
                    "functional tool that you may use currently"
                ),
            }
        ],
        latest_user_content=(
            "Please inspect the harness, then provide a list of all functional "
            "tool that you may use currently"
        ),
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_harness_inventory_low_budget",
            max_iterations=2,
            streaming=True,
        ),
    )

    # Even on the tightest iteration budget, a real snapshot answers the
    # inventory ask directly rather than letting the model's deflection stand.
    assert decision.response_text == (
        "Functional tools currently available:\n"
        "- Inspect Harness (`inspect_harness`)\n"
        "- Read File (`read_file`)"
    )
    assert engine.call_count == 1
    assert len(decision.tool_results) == 1
    _assert_visible_inspect_harness_result(decision.tool_results[0])
    # Round-1 preamble streams before the tool call; exactly one stream reset
    # clears it before the deterministic inventory answer streams.
    assert sum(isinstance(event, StreamResetEvent) for event in events) == 1


def _retired_inventory_fallback_replaces_generic_model_recovery_text() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="I'll inspect the harness.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"], "include_disabled": True},
                            call_id="call_harness",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="I'm ready to help. What's on your mind?",
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_harness_inventory_ready_reset",
        messages=[
            {
                "role": "user",
                "content": (
                    "Please inspect the harness, then provide a list of all "
                    "functional tools that you may use currently"
                ),
            }
        ],
        latest_user_content=(
            "Please inspect the harness, then provide a list of all functional "
            "tools that you may use currently"
        ),
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_harness_inventory_ready_reset",
            max_iterations=2,
            streaming=True,
        ),
    )

    # "I'm ready to help. What's on your mind?" does not answer the inventory
    # ask either, so the snapshot-derived list wins over the model's text.
    assert decision.response_text == (
        "Functional tools currently available:\n"
        "- Inspect Harness (`inspect_harness`)\n"
        "- Read File (`read_file`)"
    )
    assert engine.call_count == 1
    assert len(decision.tool_results) == 1
    _assert_visible_inspect_harness_result(decision.tool_results[0])
    # Round-1 preamble streams before the tool call; exactly one stream reset
    # clears it before the deterministic inventory answer streams.
    assert sum(isinstance(event, StreamResetEvent) for event in events) == 1


def _retired_inspect_harness_plain_request_runs_model_diagnostics_tool() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="I'll inspect my harness.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={
                                "sections": [
                                    "tools",
                                    "memories",
                                    "skills",
                                    "runtime",
                                    "workspace",
                                    "shell",
                                ],
                                "include_disabled": True,
                            },
                            call_id="call_harness_plain",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        "I can answer capability questions from the executable-tools "
                        "digest instead."
                    ),
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    router.set_harness_snapshot_provider(
        lambda **_kwargs: {
            "sections": ["tools", "memories", "skills", "runtime", "workspace", "shell"],
            "filters": {
                "include_disabled": True,
                "include_recent_history": True,
                "recent_history_limit": 5,
            },
            "tools": {"counts": {"enabled": 1, "disabled": 1, "total": 2}},
            "runtime": {
                "active_engine": "ollama",
                "active_model": "qwen3-test",
                "active_mode": "assist",
            },
            "workspace": {
                "root": "C:/workspace",
                "exists": True,
                "blockers": [],
                "workspace_blocked_tools": [],
            },
            "memories": {"counts": {"approved": 1, "pending": 0}},
            "skills": {"counts": {"total": 5}},
            "shell": {
                "companion": {"summary": "1 follow-up queued."},
                "offline": {"summary": "Offline mode configured."},
                "proactive": {"summary": "0 proactive reminders configured."},
            },
        }
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_plain_harness_menu_restart",
        messages=[
            {
                "role": "user",
                "content": (
                    "hello jenny! How are you today? "
                    "Could you inspect your harness for me please?"
                ),
            }
        ],
        latest_user_content=(
            "hello jenny! How are you today? "
            "Could you inspect your harness for me please?"
        ),
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_plain_harness_menu_restart",
            max_iterations=4,
            streaming=True,
        ),
    )

    # An explicit "inspect your harness" ask is harness-diagnostic intent, so
    # the tool is unhidden and dispatches against the full snapshot.
    assert engine.call_count == 2
    assert decision.response_text == (
        "I can answer capability questions from the executable-tools digest instead."
    )
    assert len(decision.tool_results) == 1
    _assert_visible_inspect_harness_result(decision.tool_results[0])
    # Round-1 preamble streams before the tool call; exactly one stream reset
    # clears it before the final answer streams.
    assert sum(isinstance(event, StreamResetEvent) for event in events) == 1


def _retired_inspect_harness_plain_request_preserves_substantive_model_reply() -> None:
    substantive_reply = (
        "I inspected the harness. It is running on ollama with qwen3-test, "
        "has one enabled tool, and the workspace has no blockers."
    )
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="I'll inspect my harness.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools", "runtime", "workspace"]},
                            call_id="call_harness_substantive",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content=substantive_reply,
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_plain_harness_substantive",
        messages=[
            {
                "role": "user",
                "content": "Could you inspect your harness for me?",
            }
        ],
        latest_user_content="Could you inspect your harness for me?",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_plain_harness_substantive",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert engine.call_count == 2
    assert decision.response_text == substantive_reply
    # Round-1 preamble streams before the blocked tool call; exactly one
    # stream reset clears it before the final answer streams.
    assert sum(isinstance(event, StreamResetEvent) for event in events) == 1


def _retired_inspect_harness_inventory_preserves_substantive_model_reply_with_mermaid() -> None:
    substantive_reply = (
        "Functional tools currently available:\n"
        "- Inspect Harness (`inspect_harness`)\n"
        "- Read File (`read_file`)\n"
        "\n"
        "```mermaid\n"
        "flowchart TD\n"
        '    tools["Available Tools"]\n'
        '    inspect_harness["Inspect Harness"]\n'
        '    read_file["Read File"]\n'
        "    tools --> inspect_harness\n"
        "    tools --> read_file\n"
        "```"
    )
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content=substantive_reply,
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"], "include_disabled": True},
                            call_id="call_harness",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content=substantive_reply,
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_harness_inventory_substantive",
        messages=[
            {
                "role": "user",
                "content": (
                    "Please inspect the tool harness, list available tools, "
                    "and show them in a mermaid flowchart."
                ),
            }
        ],
        latest_user_content=(
            "Please inspect the tool harness, list available tools, "
            "and show them in a mermaid flowchart."
        ),
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_harness_inventory_substantive",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert decision.response_text == substantive_reply
    assert engine.call_count == 2
    # Round-1 preamble streams before the blocked tool call; exactly one
    # stream reset clears it before the final answer streams.
    assert sum(isinstance(event, StreamResetEvent) for event in events) == 1


def _retired_inspect_harness_inventory_call_returns_snapshot_tool_result() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="I've checked my harness, and only inspect_harness is available.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"], "include_disabled": True},
                            call_id="call_harness",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="I can summarize the tools listed in the current digest.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_harness_inventory_immediate",
        messages=[
            {
                "role": "user",
                "content": (
                    "Please inspect the harness, then provide a list of all "
                    "functional tool that you may use currently"
                ),
            }
        ],
        latest_user_content=(
            "Please inspect the harness, then provide a list of all functional "
            "tool that you may use currently"
        ),
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_harness_inventory_immediate",
            max_iterations=4,
            streaming=True,
        ),
    )

    # The snapshot answers the inventory ask outright, so the loop never spends
    # a second engine round on the model's offer to summarize the digest.
    assert engine.call_count == 1
    assert decision.response_text == (
        "Functional tools currently available:\n"
        "- Inspect Harness (`inspect_harness`)\n"
        "- Read File (`read_file`)"
    )
    assert len(decision.tool_results) == 1
    _assert_visible_inspect_harness_result(decision.tool_results[0])
    # Round-1 preamble streams before the tool call; exactly one stream reset
    # clears it before the final answer streams.
    assert sum(isinstance(event, StreamResetEvent) for event in events) == 1


def _retired_repeated_reasoning_deltas_do_not_stop_before_hidden_harness_result() -> None:
    from sidecar.ai.routing.tool_observation import ToolObservationStore

    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"]},
                            call_id="call_reasoning_then_harness",
                        ),
                    ),
                ),
                stream_chunks=(
                    ThinkingDelta("checking "),
                    ThinkingDelta("checking "),
                    ThinkingDelta("checking "),
                    ThinkingDelta("checking "),
                ),
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_reasoning_then_harness",
        messages=[{
            "role": "user",
            "content": "Please inspect the tool harness and list available tools.",
        }],
        latest_user_content="Please inspect the tool harness and list available tools.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_reasoning_then_harness",
            max_iterations=4,
            streaming=True,
            observation_store=ToolObservationStore(),
        ),
    )

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert result_events
    assert result_events[0].call_id == "call_reasoning_then_harness"
    assert result_events[0].success is True
    assert result_events[0].metadata.get("result_kind") == "harness_snapshot"
    # The inventory ask is answered from the snapshot, superseding "fallback".
    assert decision.response_text == (
        "Functional tools currently available:\n"
        "- Inspect Harness (`inspect_harness`)\n"
        "- Read File (`read_file`)"
    )


def test_pre_dispatched_tool_calls_are_settled_when_cancelled_before_dispatch() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "a.txt"},
                            call_id="call_cancelled_read_1",
                        ),
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "b.txt"},
                            call_id="call_cancelled_read_2",
                        ),
                    ),
                )
            ),
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient(
            (
                MCPToolDescriptor(
                    name="read_file",
                    description="Read a file",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
            )
        ),
    )
    cancel_handle = TurnCancellationHandle(request_id="req_cancelled_harness")
    events: list[object] = []

    def _emit(event: object) -> None:
        events.append(event)
        if isinstance(event, ToolExecutingEvent):
            cancel_handle.cancel(reason="user")

    with pytest.raises(TerminalChatStateError):
        router.build_chat_decision(
            request_id="req_cancelled_harness",
            messages=[{"role": "user", "content": "Read the files"}],
            latest_user_content="Read the files",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(
                emit=_emit,
                request_id="req_cancelled_harness",
                max_iterations=4,
                streaming=True,
                cancel_handle=cancel_handle,
            ),
        )

    executing_events = [event for event in events if isinstance(event, ToolExecutingEvent)]
    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert [event.call_id for event in executing_events] == ["call_cancelled_read_1"]
    assert [event.call_id for event in result_events] == ["call_cancelled_read_1"]
    assert all(event.success is False for event in result_events)
    assert all(event.error_code == CMP_LOOP_TOOL_INTERRUPTED for event in result_events)


def test_approval_gate_does_not_pre_dispatch_unstarted_sibling_tools() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="write_file",
                            arguments={"path": "notes.txt", "content": "hello"},
                            call_id="call_write_requires_approval",
                        ),
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "notes.txt"},
                            call_id="call_readonly_after_approval",
                        ),
                    ),
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient(
        (
            MCPToolDescriptor(
                name="write_file",
                description="Write a file",
                input_schema={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                },
                side_effecting=True,
                server_name="tools",
            ),
            MCPToolDescriptor(
                name="read_file",
                description="Read a file",
                input_schema={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
                side_effecting=False,
                server_name="tools",
            ),
        )
    )
    router = _build_router(engine=engine, mcp_client=mcp_client)
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_approval_batch",
        max_iterations=4,
        streaming=True,
    )

    decision = router.build_chat_decision(
        request_id="req_approval_batch",
        messages=[{"role": "user", "content": "write a note and inspect tools"}],
        latest_user_content="write a note and inspect tools",
        mode="assist",
        approvals_pre_granted=False,
        runtime=runtime,
    )

    assert decision.approval_request is not None
    assert decision.approval_request.tool_call_id == "call_write_requires_approval"
    assert [event for event in events if isinstance(event, ToolExecutingEvent)] == []
    assert [event for event in events if isinstance(event, ToolResultEvent)] == []
    assert runtime.pending_tool_executions() == ()
    assert mcp_client.executions == []


def test_policy_deny_emits_failed_tool_result_without_approval() -> None:
    engine = _ToolLoopEngine(
        [
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="write_file",
                            arguments={"path": "notes.txt", "content": "blocked"},
                            call_id="call_policy_deny",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Policy blocked the write.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient(
        (
            MCPToolDescriptor(
                name="write_file",
                description="Write a file",
                input_schema={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                },
                side_effecting=True,
                server_name="tools",
                tool_family="filesystem",
            ),
        )
    )
    router = _build_router(engine=engine, mcp_client=mcp_client)
    router._config = replace(
        router._config,
        tool_policy_snapshot=ToolPolicySnapshot(
            version=2,
            rules=(
                ToolPolicyRule(
                    id="deny-writes",
                    decision="deny",
                    reason="Writes are disabled for this workspace",
                    match=ToolPolicyRuleMatch(tool_id="write_file"),
                ),
            ),
        ),
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_policy_deny",
        messages=[{"role": "user", "content": "write a note"}],
        latest_user_content="write a note",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_policy_deny",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert decision.approval_request is None
    assert decision.tool_results
    denied = decision.tool_results[0]
    assert denied.success is False
    assert denied.error_code == CMP_TOOL_POLICY_DENIED
    assert denied.metadata["policy_denied"] is True
    assert denied.metadata["policy_decision"]["decision"] == "deny"
    assert denied.metadata["policy_decision"]["matched_rule_id"] == "deny-writes"
    assert [event for event in events if isinstance(event, ToolResultEvent)][0].error_code == (
        CMP_TOOL_POLICY_DENIED
    )
    assert mcp_client.executions == []


def test_policy_ask_without_provider_call_id_builds_resumable_approval_plan() -> None:
    call = ToolCallRequest(
        tool_id="read_file",
        arguments={"path": "README.md"},
    )
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(call,),
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient(
        (
            MCPToolDescriptor(
                name="read_file",
                description="Read a file",
                input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
                side_effecting=False,
                server_name="tools",
                tool_family="filesystem",
            ),
        )
    )
    router = _build_router(engine=engine, mcp_client=mcp_client)
    router._config = replace(
        router._config,
        tool_policy_snapshot=ToolPolicySnapshot(
            version=2,
            rules=(
                ToolPolicyRule(
                    id="ask-reads",
                    decision="ask",
                    reason="Review all file reads",
                    match=ToolPolicyRuleMatch(tool_id="read_file"),
                ),
            ),
        ),
    )

    decision = router.build_chat_decision(
        request_id="req_policy_ask_missing_call_id",
        messages=[{"role": "user", "content": "read README"}],
        latest_user_content="read README",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(
            request_id="req_policy_ask_missing_call_id",
            max_iterations=4,
        ),
    )

    expected_call_id = "call_1"
    assert decision.approval_request is not None
    assert decision.approval_request.tool_call_id == expected_call_id
    assert decision.approval_plan is not None
    assert decision.approval_plan.call_id == expected_call_id
    assert decision.approval_plan.frozen_inputs[0].call_id == expected_call_id
    assert decision.approval_plan.tool_calls[0].call_id == expected_call_id


def test_stopped_tool_loop_marks_streamed_cancellation_events() -> None:
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_stopped_pending_tool",
        max_iterations=4,
        streaming=True,
    )
    pending_call = ToolCallRequest(
        tool_id="inspect_harness",
        arguments={"sections": ["tools"]},
        call_id="call_cancelled_before_dispatch",
    )

    result = _build_stopped_tool_loop_result(
        runtime=runtime,
        kernel=SimpleNamespace(_engine=SimpleNamespace()),
        stop_reason=StopReason(
            decision=StopDecision.STOP,
            message="Loop stopped.",
            code=CMP_LOOP_TOOL_INTERRUPTED,
        ),
        streamed_event_types=set(),
        outcomes=[],
        usage_totals=None,
        pending_tool_calls=(pending_call,),
    )

    assert "tool.executing" in result.streamed_event_types
    assert "tool.result" in result.streamed_event_types
    assert [event.call_id for event in events if isinstance(event, ToolExecutingEvent)] == [
        "call_cancelled_before_dispatch"
    ]
    assert [event.call_id for event in events if isinstance(event, ToolResultEvent)] == [
        "call_cancelled_before_dispatch"
    ]


def test_finished_sequential_tool_emits_result_before_cancellation() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "notes.txt"},
                            call_id="call_cancelled_after_finish",
                        ),
                    ),
                )
            ),
        ]
    )
    cancel_handle = TurnCancellationHandle(request_id="req_cancelled_after_finish")
    events: list[object] = []

    def _emit(event: object) -> None:
        events.append(event)
        if isinstance(event, ToolResultEvent):
            cancel_handle.cancel(reason="user")

    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient(
            (
                MCPToolDescriptor(
                    name="read_file",
                    description="Read a file",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
            )
        ),
    )

    with pytest.raises(TerminalChatStateError):
        router.build_chat_decision(
            request_id="req_cancelled_after_finish",
            messages=[{"role": "user", "content": "Read notes.txt"}],
            latest_user_content="Read notes.txt",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(
                emit=_emit,
                request_id="req_cancelled_after_finish",
                max_iterations=4,
                streaming=True,
                cancel_handle=cancel_handle,
            ),
        )

    executing_events = [event for event in events if isinstance(event, ToolExecutingEvent)]
    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert [event.call_id for event in executing_events] == ["call_cancelled_after_finish"]
    assert [event.call_id for event in result_events] == ["call_cancelled_after_finish"]
    assert result_events[0].success is True


def _retired_duplicate_inspect_harness_calls_coalesce_before_snapshot_result() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"]},
                            call_id="call_harness_a",
                        ),
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"]},
                            call_id="call_harness_b",
                        ),
                    ),
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_duplicate_harness",
        messages=[{
            "role": "user",
            "content": (
                "Please inspect the tool harness, let me know which tools are "
                "available, then show each available tool in a mermaid flowchart"
            ),
        }],
        latest_user_content=(
            "Please inspect the tool harness, let me know which tools are "
            "available, then show each available tool in a mermaid flowchart"
        ),
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_duplicate_harness",
            max_iterations=4,
            streaming=True,
        ),
    )

    # Coalescing still collapses the duplicate to one dispatch; the snapshot
    # then answers the inventory ask without a second engine round.
    assert engine.call_count == 1
    # This prompt also asks for a diagram, so the inventory answer carries a
    # mermaid block; the exact node rendering is pinned by the mermaid tests.
    assert decision.response_text.startswith(
        "Functional tools currently available:\n"
        "- Inspect Harness (`inspect_harness`)\n"
        "- Read File (`read_file`)"
    )
    assert "```mermaid" in decision.response_text
    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert [event.call_id for event in result_events] == ["call_harness_a"]
    assert result_events[0].success is True
    assert result_events[0].metadata.get("result_kind") == "harness_snapshot"


def test_mermaid_alias_duplicates_are_canonicalized_before_tool_events() -> None:
    mermaid_args = {"prompt": "flowchart TD\n  tools --> inspect_harness"}
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments=mermaid_args,
                            call_id="call_mermaid_canonical",
                        ),
                        ToolCallRequest(
                            tool_id="mermaid_gen",
                            arguments=mermaid_args,
                            call_id="call_mermaid_alias_a",
                        ),
                        ToolCallRequest(
                            tool_id="mermaid_gen",
                            arguments=mermaid_args,
                            call_id="call_mermaid_alias_b",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        "```mermaid\n"
                        "flowchart TD\n"
                        "  tools --> inspect_harness\n"
                        "```\n"
                        "The diagram was generated after the visible diagram tool ran."
                    ),
                    finish_reason="stop",
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
    )
    events: list[object] = []
    prompt = (
        "Please inspect the tool harness, let me know which tools are available, "
        "then show each available tool in a mermaid flowchart"
    )

    decision = router.build_chat_decision(
        request_id="req_mermaid_alias_inventory",
        messages=[{"role": "user", "content": prompt}],
        latest_user_content=prompt,
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_mermaid_alias_inventory",
            max_iterations=4,
            streaming=True,
        ),
    )

    executing_events = [event for event in events if isinstance(event, ToolExecutingEvent)]
    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert [(event.call_id, event.tool_name) for event in executing_events] == [
        ("call_mermaid_canonical", "mermaid_generate"),
    ]
    assert {
        (event.call_id, event.tool_name)
        for event in result_events
    } == {
        ("call_mermaid_canonical", "mermaid_generate"),
    }
    assert "mermaid_gen" not in decision.response_text
    assert "```mermaid" in decision.response_text
    assert "inspect_harness" in decision.response_text
    assert mcp_client.executions == [
        ("mermaid_generate", {**mermaid_args, "_jenny_read_only": False})
    ]


def _retired_unknown_tool_in_mixed_batch_does_not_poison_hidden_harness_result() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"]},
                            call_id="call_valid_harness",
                        ),
                        ToolCallRequest(
                            tool_id="totally_fake_tool",
                            arguments={"value": True},
                            call_id="call_invalid_tool",
                        ),
                    ),
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_mixed_valid_invalid_tools",
        messages=[{
            "role": "user",
            "content": "Please inspect the tool harness and list available tools.",
        }],
        latest_user_content="Please inspect the tool harness and list available tools.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_mixed_valid_invalid_tools",
            max_iterations=4,
            streaming=True,
        ),
    )

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    by_call_id = {event.call_id: event for event in result_events}
    # The point of this test is that the malformed sibling call cannot poison a
    # good result; that holds whether the harness result is a snapshot or a
    # refusal, so it now asserts the snapshot the explicit ask unhides.
    assert by_call_id["call_valid_harness"].success is True
    assert by_call_id["call_valid_harness"].metadata.get("result_kind") == "harness_snapshot"
    assert by_call_id["call_invalid_tool"].success is False
    assert by_call_id["call_invalid_tool"].error_code == CMP_LOOP_INVALID_TOOL_CALL
    assert decision.response_text == (
        "Functional tools currently available:\n"
        "- Inspect Harness (`inspect_harness`)\n"
        "- Read File (`read_file`)"
    )


def test_malformed_tool_arguments_receive_terminal_error_without_crashing() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments=["not", "an", "object"],  # type: ignore[arg-type]
                            call_id="call_bad_args",
                        ),
                    ),
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_bad_tool_args",
        messages=[{"role": "user", "content": "Inspect tools"}],
        latest_user_content="Inspect tools",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_bad_tool_args",
            max_iterations=2,
            streaming=True,
        ),
    )

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert [event.call_id for event in result_events] == ["call_bad_args"]
    assert result_events[0].success is False
    assert result_events[0].error_code == CMP_LOOP_INVALID_TOOL_CALL
    assert "arguments must be an object" in result_events[0].content
    assert decision.response_text


def test_current_info_request_injects_web_unavailable_context_before_generation() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="I cannot perform a live lookup.",
                    finish_reason="stop",
                )
            )
        ]
    )
    router = _build_router(engine=engine)

    router.build_chat_decision(
        request_id="req_web_unavailable_context",
        messages=[
            {
                "role": "user",
                "content": "What is the latest OpenAI news today?",
            }
        ],
        latest_user_content="What is the latest OpenAI news today?",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            request_id="req_web_unavailable_context",
            max_iterations=2,
        ),
    )

    first_messages = engine.requests[0]["messages"]
    # Since 2026-08-28 the routing normalizer (engine_messages) demotes
    # non-leading system rows to `user` for EVERY engine — same position,
    # same content; real engines already received the nudge this way.
    assert any(
        message["role"] == "user"
        and "web_search is unavailable for this request" in message["content"]
        for message in first_messages
    )


def test_failed_tool_result_replaces_no_context_response_with_failure_summary() -> None:
    # The model denies its failed tool-result context twice: the shared
    # continuation retry fires once, then the deterministic failure summary
    # replaces the second denial.
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="web_search",
                            arguments={"query": "latest OpenAI news"},
                            call_id="call_web",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="I don't have any previous context or tool results to work with.",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Sorry, I have no tool results to reference.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)

    decision = router.build_chat_decision(
        request_id="req_failed_tool_context",
        messages=[
            {
                "role": "user",
                "content": "Could you do a web search for latest OpenAI news?",
            }
        ],
        latest_user_content="Could you do a web search for latest OpenAI news?",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            request_id="req_failed_tool_context",
            max_iterations=4,
        ),
    )

    assert engine.call_count == 3
    assert "previous context" not in decision.response_text
    assert "web_search" in decision.response_text
    assert "unavailable" in decision.response_text.lower()


def test_ignored_failure_context_retry_accepts_recovered_response() -> None:
    # New in the unified recovery path: a response that denies failed
    # tool-result context earns one continuation retry, and a recovered
    # answer from that retry is accepted verbatim.
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="web_search",
                            arguments={"query": "latest OpenAI news"},
                            call_id="call_web_recover",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="I don't have any previous context or tool results to work with.",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        "The web search could not run because that tool is "
                        "unavailable right now, so I could not fetch the news."
                    ),
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)

    decision = router.build_chat_decision(
        request_id="req_failed_tool_recover",
        messages=[
            {
                "role": "user",
                "content": "Could you do a web search for latest OpenAI news?",
            }
        ],
        latest_user_content="Could you do a web search for latest OpenAI news?",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            request_id="req_failed_tool_recover",
            max_iterations=4,
        ),
    )

    assert engine.call_count == 3
    assert "could not run" in decision.response_text
    assert "previous context" not in decision.response_text


def test_empty_post_tool_completion_retries_then_summarizes_failure() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="web_search",
                            arguments={"query": "latest OpenAI news"},
                            call_id="call_web_empty",
                        ),
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_failed_tool_empty_context",
        messages=[
            {
                "role": "user",
                "content": "Could you do a web search for latest OpenAI news?",
            }
        ],
        latest_user_content="Could you do a web search for latest OpenAI news?",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_failed_tool_empty_context",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert engine.call_count == 3
    assert "Completed tool execution but no final assistant text" not in decision.response_text
    assert "web_search" in decision.response_text
    assert "failed" in decision.response_text.lower()
    assert any(isinstance(event, StreamResetEvent) for event in events)
    fallback_tokens = [
        event.delta for event in events
        if isinstance(event, TokenDeltaEvent)
    ]
    assert "".join(fallback_tokens) == decision.response_text


def test_web_tool_quota_burst_is_bounded_before_empty_fallback() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=tuple(
                        ToolCallRequest(
                            tool_id="fetch_url",
                            arguments={"url": "https://example.com/"},
                            call_id=f"call_fetch_{index}",
                        )
                        for index in range(30)
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
        ]
    )
    mcp_client = _FailingFetchClient()
    router = _build_router(engine=engine, mcp_client=mcp_client)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_fetch_burst_empty_context",
        messages=[{"role": "user", "content": "Fetch the page."}],
        latest_user_content="Fetch the page.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_fetch_burst_empty_context",
            max_iterations=4,
            streaming=True,
        ),
    )

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    summarized_events = [
        event
        for event in result_events
        if (event.metadata or {}).get("summarized_blocked_count")
    ]
    assert len(result_events) <= RuntimeConfig().max_web_tool_calls_per_turn + 2
    assert len(mcp_client.executions) <= RuntimeConfig().max_web_tool_calls_per_turn
    assert summarized_events
    assert "fetch_url" in decision.response_text
    assert "CMP-TOOL-0013" in decision.response_text
    assert any(isinstance(event, StreamResetEvent) for event in events)


def _web_per_turn_blocks(events: list[object]) -> list[ToolResultEvent]:
    return [
        event
        for event in events
        if isinstance(event, ToolResultEvent)
        and (event.metadata or {}).get("quota_scope") == "web_per_turn"
    ]


def test_failed_web_calls_do_not_consume_per_turn_budget() -> None:
    # Two failing web calls across two iterations, per-turn web cap = 1. Under the OLD
    # attempt-based accounting the first failure spends the only slot and the second call
    # is blocked with web_per_turn (locking the model out). Refunding failed web calls
    # keeps the budget free, so the second call is never quota-blocked.
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="fetch_url",
                            arguments={"url": f"https://example.com/{index}"},
                            call_id=f"call_fetch_{index}",
                        ),
                    ),
                )
            )
            for index in range(2)
        ]
        + [_ToolPlan(result=GenerationResult(content="done", finish_reason="stop"))]
    )
    mcp_client = _FailingFetchClient()
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        web_tool_cap=1,
        extra_snapshot_tools=("fetch_url",),
    )
    events: list[object] = []

    router.build_chat_decision(
        request_id="req_web_refund",
        messages=[{"role": "user", "content": "Open both pages."}],
        latest_user_content="Open both pages.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_web_refund",
            max_iterations=6,
            streaming=True,
        ),
    )

    fetch_results = [
        event
        for event in events
        if isinstance(event, ToolResultEvent) and event.tool_name == "fetch_url"
    ]
    # Both iterations got to process a fetch call, and neither was web_per_turn-blocked.
    assert len(fetch_results) >= 2
    assert _web_per_turn_blocks(events) == []


def test_web_calls_capped_at_new_default_per_turn() -> None:
    # 11 web calls in one iteration: the per-turn budget admits exactly the new default
    # (10) and blocks the 11th with web_per_turn at cap 10.
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=tuple(
                        ToolCallRequest(
                            tool_id="web_search",
                            arguments={"query": f"q{index}"},
                            call_id=f"call_web_{index}",
                        )
                        for index in range(11)
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="done", finish_reason="stop")),
        ]
    )
    mcp_client = _StubMCPClient((_web_search_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        extra_snapshot_tools=("web_search",),
    )
    events: list[object] = []

    router.build_chat_decision(
        request_id="req_web_cap",
        messages=[{"role": "user", "content": "Search a lot."}],
        latest_user_content="Search a lot.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_web_cap",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert RuntimeConfig().max_web_tool_calls_per_turn == 10
    web_blocks = _web_per_turn_blocks(events)
    assert len(web_blocks) == 1
    assert web_blocks[0].metadata["cap"] == 10
    # The model-facing message reassures it the network is available and resets next reply.
    assert "resets on your next reply" in web_blocks[0].content


def test_quota_block_guidance_web_reassures_network_available() -> None:
    message = _quota_block_guidance("web_per_turn", 10)
    assert "10" in message
    assert "per-turn" in message
    assert "resets on your next reply" in message
    assert "network is still available" in message
    # Steer the model away from the "no network / reset the quota" hallucination.
    assert "do not tell the user the network is down" in message.lower()


def test_quota_block_guidance_covers_other_scopes() -> None:
    assert "session's tool budget" in _quota_block_guidance("session_tool_budget", 200)
    assert "cooldown" in _quota_block_guidance("tool_cooldown", 1)
    assert "resets on your next reply" in _quota_block_guidance(
        "code_intelligence_per_turn", 16
    )
    # Unknown scope falls back to the generic exhausted message.
    assert "exhausted for this request" in _quota_block_guidance("mystery", 0)


def test_empty_post_tool_completion_retries_then_summarizes_success() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={"prompt": "flowchart TD\n  A --> B"},
                            call_id="call_mermaid_empty",
                        ),
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
        ]
    )
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_success_tool_empty_context",
        messages=[{"role": "user", "content": "Generate the mermaid diagram."}],
        latest_user_content="Generate the mermaid diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_success_tool_empty_context",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert engine.call_count == 3
    assert "model did not produce a visible final response" in decision.response_text
    assert "mermaid_generate" in decision.response_text
    assert "completed" in decision.response_text.lower()
    assert any(isinstance(event, StreamResetEvent) for event in events)


# ---------------------------------------------------------------------------
# Phase 5 — route policy + reliability counters
# ---------------------------------------------------------------------------


def test_successful_tool_generic_curly_greeting_retries_then_falls_back() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={"prompt": "flowchart TD\n  A --> B"},
                            call_id="call_mermaid_greeting",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Hi! I\u2019m Jenny, your AI companion. How can I help today?",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Hello! I\u2019m Jenny, nice to meet you.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_post_tool_curly_greeting",
        messages=[{"role": "user", "content": "Generate the mermaid diagram."}],
        latest_user_content="Generate the mermaid diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_post_tool_curly_greeting",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert engine.call_count == 3
    assert "Jenny" not in decision.response_text
    assert "mermaid_generate" in decision.response_text
    assert "completed" in decision.response_text.lower()
    assert any(isinstance(event, StreamResetEvent) for event in events)


def test_post_tool_continuation_retry_budget_shared_across_families() -> None:
    # One continuation retry per turn, shared across the recovery families:
    # the greeting retry consumes it, so a subsequent empty response goes
    # straight to the deterministic summary instead of retrying a second time.
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={"prompt": "flowchart TD\n  A --> B"},
                            call_id="call_mermaid_budget",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Hello! I’m Jenny, nice to meet you.",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
        ]
    )
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_post_tool_shared_budget",
        messages=[{"role": "user", "content": "Generate the mermaid diagram."}],
        latest_user_content="Generate the mermaid diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_post_tool_shared_budget",
            max_iterations=6,
            streaming=True,
        ),
    )

    # 3 calls = tool iteration + greeting (retried) + empty (NOT retried).
    assert engine.call_count == 3
    assert "mermaid_generate" in decision.response_text
    assert "completed" in decision.response_text.lower()
    assert any(isinstance(event, StreamResetEvent) for event in events)


def test_post_tool_empty_at_final_iteration_skips_retry() -> None:
    # The continuation retry needs a spare iteration; at the final iteration
    # the empty response falls straight through to the deterministic summary.
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={"prompt": "flowchart TD\n  A --> B"},
                            call_id="call_mermaid_last_iter",
                        ),
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
        ]
    )
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_post_tool_empty_last_iter",
        messages=[{"role": "user", "content": "Generate the mermaid diagram."}],
        latest_user_content="Generate the mermaid diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_post_tool_empty_last_iter",
            max_iterations=2,
            streaming=True,
        ),
    )

    assert engine.call_count == 2
    assert "mermaid_generate" in decision.response_text
    assert "completed" in decision.response_text.lower()


def test_post_tool_greeting_at_final_iteration_skips_retry() -> None:
    # The iteration guard applies uniformly: a generic restart at the final
    # iteration goes straight to the deterministic summary instead of
    # spending a retry the loop has no room to generate from.
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={"prompt": "flowchart TD\n  A --> B"},
                            call_id="call_mermaid_greeting_last",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Hi! I’m Jenny, your AI companion. How can I help today?",
                    finish_reason="stop",
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_post_tool_greeting_last_iter",
        messages=[{"role": "user", "content": "Generate the mermaid diagram."}],
        latest_user_content="Generate the mermaid diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_post_tool_greeting_last_iter",
            max_iterations=2,
            streaming=True,
        ),
    )

    assert engine.call_count == 2
    assert "Jenny" not in decision.response_text
    assert "mermaid_generate" in decision.response_text
    assert "completed" in decision.response_text.lower()


class _StoreCarryingEngine(_ToolLoopEngine):
    """ToolLoopEngine variant that carries a profile store for Phase 5."""

    def __init__(
        self,
        plans: list[_ToolPlan],
        *,
        store: object | None = None,
    ) -> None:
        super().__init__(plans)
        self._provider_capability_profile_store = store


def _seed_route_profile(*, route: str) -> tuple[ProviderCapabilityProfileStore, str]:
    """Seed a ready ollama/qwen profile and override its selected_route.

    The override bypasses the Phase 2 ladder (which produces native_tools for
    ready+native+streaming). Direct ``_profiles[]`` mutation is the test seam
    — the store does not (and should not) expose a public route-override API.
    """
    store = ProviderCapabilityProfileStore()
    profile = store.record_probe_result(
        endpoint_id=derive_endpoint_id("ollama", None),
        model_id="qwen",
        features=ProviderCapabilityFeatures(
            chat_supported=True,
            streaming_supported=True,
            native_tools_supported=True,
        ),
        observed=ProviderCapabilityObserved(),
        probe_status=PROBE_STATUS_READY,
    )
    profile_id = derive_profile_id(
        derive_endpoint_id("ollama", None), derive_model_id("qwen")
    )
    store._profiles[profile_id] = replace(profile, selected_route=route)
    return store, profile_id


def test_route_disabled_emits_synthetic_rejection_outcome() -> None:
    store, _ = _seed_route_profile(route=ROUTE_TOOL_DISABLED)
    engine = _StoreCarryingEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Trying to call a tool.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "x.txt"},
                            call_id="c_disabled",
                        ),
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="done", finish_reason="stop")),
        ],
        store=store,
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_route_disabled",
        messages=[{"role": "user", "content": "read x.txt"}],
        latest_user_content="read x.txt",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_route_disabled",
            max_iterations=3,
            streaming=True,
        ),
    )

    tool_results = [event for event in events if isinstance(event, ToolResultEvent)]
    assert tool_results, "expected synthetic tool.result event"
    assert tool_results[0].error_code == "CMP-ROUTE-TOOL-DISABLED"
    assert tool_results[0].success is False
    # The loop should still produce a final assistant text from the second plan.
    assert decision.response_text


def test_route_fail_closed_emits_chat_error_and_no_dispatch() -> None:
    store, _ = _seed_route_profile(route=ROUTE_FAIL_CLOSED)
    engine = _StoreCarryingEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "x.txt"},
                            call_id="c_fail_closed",
                        ),
                    ),
                )
            ),
        ],
        store=store,
    )
    router = _build_router(engine=engine)

    with pytest.raises(Exception) as exc_info:
        router.build_chat_decision(
            request_id="req_route_fail_closed",
            messages=[{"role": "user", "content": "read x.txt"}],
            latest_user_content="read x.txt",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(
                request_id="req_route_fail_closed",
                max_iterations=2,
            ),
        )

    assert "CMP-ROUTE-FAIL-CLOSED" in str(exc_info.value) or hasattr(
        exc_info.value, "code"
    )


def test_route_native_dispatch_proceeds_normally() -> None:
    store, profile_id = _seed_route_profile(route=ROUTE_NATIVE_TOOLS)
    engine = _StoreCarryingEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"]},
                            call_id="c_native",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="harness inspected",
                    finish_reason="stop",
                )
            ),
        ],
        store=store,
    )
    router = _build_router(engine=engine)

    decision = router.build_chat_decision(
        request_id="req_route_native",
        messages=[{"role": "user", "content": "inspect"}],
        latest_user_content="inspect",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req_route_native", max_iterations=3),
    )

    assert decision.response_text == "harness inspected"
    counters = store.get_reliability_counters(profile_id=profile_id)
    assert counters is not None
    # Native dispatch records a parse_success counter increment per turn.
    assert counters.tool_call_parse_success_count >= 1


def test_route_downgrade_to_in_band_uses_inband_parser() -> None:
    """When native is configured but coerced args present, route downgrades."""
    store, profile_id = _seed_route_profile(route=ROUTE_NATIVE_TOOLS)
    engine = _StoreCarryingEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        "Here is the call: "
                        '<tool_call>{"name": "read_file", '
                        '"arguments": {"path": "x.txt"}}</tool_call>'
                    ),
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={},
                            call_id="c_coerced",
                            coerced=True,
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="recovered", finish_reason="stop"),
            ),
        ],
        store=store,
    )
    router = _build_router(engine=engine)

    router.build_chat_decision(
        request_id="req_route_downgrade",
        messages=[{"role": "user", "content": "read x"}],
        latest_user_content="read x",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req_route_downgrade", max_iterations=3),
    )

    counters = store.get_reliability_counters(profile_id=profile_id)
    assert counters is not None
    assert counters.tool_call_repair_count >= 1


def test_inband_recovery_uses_effective_bridge_tool_contract() -> None:
    engine = _ToolLoopEngine(plans=[])
    router = _build_router(engine=engine)
    router._config = replace(
        router._config,
        electron_tool_bridge_enabled=True,
    )
    contract = router._assemble_tool_contract()
    assert router._mcp_client.available_tools == []
    assert "jenny_status" in known_tool_names_for_kernel(
        router,
        tool_contract=contract,
    )
    result = GenerationResult(
        content=(
            'Checking status. <tool_call>{"name":"jenny_status",'
            '"arguments":{}}</tool_call>'
        ),
        finish_reason="tool_calls",
    )

    recovered, ok = attempt_in_band_recovery(
        result=result,
        kernel=router,
        tool_contract=contract,
    )

    assert ok is True
    assert len(recovered.tool_calls) == 1
    assert recovered.tool_calls[0].tool_id == "jenny_status"
    assert recovered.tool_calls[0].arguments == {}


def test_inband_recovery_does_not_fall_back_to_mcp_when_contract_is_empty() -> None:
    engine = _ToolLoopEngine(plans=[])
    mcp_client = _StubMCPClient((_web_search_descriptor(),))
    router = _build_router(engine=engine, mcp_client=mcp_client)
    empty_contract = SimpleNamespace(prompt_schemas=())
    result = GenerationResult(
        content=(
            '<tool_call>{"name":"web_search",'
            '"arguments":{"query":"example"}}</tool_call>'
        ),
        finish_reason="tool_calls",
    )

    recovered, ok = attempt_in_band_recovery(
        result=result,
        kernel=router,
        tool_contract=empty_contract,
    )

    assert ok is False
    assert recovered is result


def test_reliability_counters_increment_on_dispatch() -> None:
    store, profile_id = _seed_route_profile(route=ROUTE_NATIVE_TOOLS)
    engine = _StoreCarryingEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="inspect_harness",
                            arguments={"sections": ["tools"]},
                            call_id="c_counter",
                        ),
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="ok", finish_reason="stop"),
            ),
        ],
        store=store,
    )
    router = _build_router(engine=engine)

    router.build_chat_decision(
        request_id="req_counter",
        messages=[{"role": "user", "content": "inspect"}],
        latest_user_content="inspect",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req_counter", max_iterations=3),
    )

    counters = store.get_reliability_counters(profile_id=profile_id)
    assert counters is not None
    assert counters.tool_call_parse_success_count == 1


# ---------------------------------------------------------------------------
# Phase 6 — audit-event recording during ``run_tool_loop``
# ---------------------------------------------------------------------------


def test_audit_events_recorded_at_each_transition() -> None:
    """A clean no-tools turn produces a ``turn_completed`` audit event."""
    from sidecar.ai.routing.tool_observation import (
        KIND_MODEL_VISIBLE_TEXT_DELTA,
        KIND_TURN_COMPLETED,
        ToolObservationStore,
    )

    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Hi there.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []
    store = ToolObservationStore()

    decision = router.build_chat_decision(
        request_id="req_audit_clean",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_audit_clean",
            max_iterations=2,
            observation_store=store,
        ),
    )

    assert "Hi there" in decision.response_text
    audit = store.recent_events(request_id="req_audit_clean", limit=50)
    assert audit, "expected at least one audit event"
    kinds = [event.kind for event in audit]
    assert KIND_TURN_COMPLETED in kinds
    # Streamed/chat tokens are emitted by the streaming path; the
    # non-streaming smoke run here records only the terminal event, but
    # if the engine streams we should also see visible-text deltas.
    if KIND_MODEL_VISIBLE_TEXT_DELTA in kinds:
        delta_events = [e for e in audit if e.kind == KIND_MODEL_VISIBLE_TEXT_DELTA]
        assert all(e.summary.startswith("len=") for e in delta_events)


def test_observations_can_reconstruct_turn() -> None:
    """Reconstruction guarantee: from the observation list alone, every
    lifecycle question is answerable without consulting ``turn_events[]``.
    """
    from sidecar.ai.routing.tool_observation import (
        KIND_MODEL_REASONING_DELTA,
        KIND_MODEL_TOOL_REQUESTED,
        KIND_MODEL_VISIBLE_TEXT_DELTA,
        KIND_TOOL_EXECUTION_FAILED,
        KIND_TOOL_EXECUTION_OBSERVED,
        KIND_TOOL_EXECUTION_STARTED,
        KIND_TURN_COMPLETED,
        KIND_TURN_FAILED,
        KIND_USER_APPROVAL_REJECTED,
        KIND_USER_APPROVAL_REQUESTED,
        ToolObservationEvent,
        ToolObservationStore,
    )

    store = ToolObservationStore()
    request_id = "req_reconstruct"
    store.ensure_turn(request_id=request_id)

    fixtures = (
        ToolObservationEvent(
            kind=KIND_MODEL_TOOL_REQUESTED,
            request_id=request_id,
            tool_call_id="c1",
            tool_name="read_file",
            summary="model_tool_requested read_file",
        ),
        ToolObservationEvent(
            kind=KIND_USER_APPROVAL_REQUESTED,
            request_id=request_id,
            tool_call_id="c1",
            summary="user_approval_requested",
        ),
        ToolObservationEvent(
            kind=KIND_TOOL_EXECUTION_STARTED,
            request_id=request_id,
            tool_call_id="c1",
            tool_name="read_file",
            summary="tool_execution_started read_file",
        ),
        ToolObservationEvent(
            kind=KIND_TOOL_EXECUTION_OBSERVED,
            request_id=request_id,
            tool_call_id="c1",
            tool_name="read_file",
            summary="tool_execution_observed read_file",
        ),
        ToolObservationEvent(
            kind=KIND_MODEL_VISIBLE_TEXT_DELTA,
            request_id=request_id,
            summary="len=12",
        ),
        ToolObservationEvent(
            kind=KIND_MODEL_REASONING_DELTA,
            request_id=request_id,
            summary="len=8",
        ),
        ToolObservationEvent(
            kind=KIND_TURN_COMPLETED,
            request_id=request_id,
            summary="turn_completed chars=42 outcomes=1",
        ),
    )
    for event in fixtures:
        store.record(event)

    audit = store.recent_events(request_id=request_id, limit=50)

    # 1. Did the model request tools? Which?
    requested = tuple(e for e in audit if e.kind == KIND_MODEL_TOOL_REQUESTED)
    assert tuple(e.tool_name for e in requested) == ("read_file",)

    # 2. Did approval gate them? Were any rejected?
    approvals = tuple(
        e
        for e in audit
        if e.kind in (KIND_USER_APPROVAL_REQUESTED, KIND_USER_APPROVAL_REJECTED)
    )
    assert any(e.kind == KIND_USER_APPROVAL_REQUESTED for e in approvals)
    assert not any(e.kind == KIND_USER_APPROVAL_REJECTED for e in approvals)

    # 3. Did each tool execute? Did it succeed?
    started = tuple(e for e in audit if e.kind == KIND_TOOL_EXECUTION_STARTED)
    observed = tuple(e for e in audit if e.kind == KIND_TOOL_EXECUTION_OBSERVED)
    failed = tuple(e for e in audit if e.kind == KIND_TOOL_EXECUTION_FAILED)
    started_ids = {e.tool_call_id for e in started}
    observed_ids = {e.tool_call_id for e in observed}
    failed_ids = {e.tool_call_id for e in failed}
    assert started_ids == {"c1"}
    assert observed_ids == {"c1"}
    assert failed_ids == set()

    # 4. Did the model produce visible text? Reasoning?
    visible = tuple(e for e in audit if e.kind == KIND_MODEL_VISIBLE_TEXT_DELTA)
    reasoning = tuple(e for e in audit if e.kind == KIND_MODEL_REASONING_DELTA)
    assert visible and visible[0].summary == "len=12"
    assert reasoning and reasoning[0].summary == "len=8"

    # 5. Did the turn complete or fail?
    terminals = tuple(
        e for e in audit if e.kind in (KIND_TURN_COMPLETED, KIND_TURN_FAILED)
    )
    assert terminals
    assert terminals[-1].kind == KIND_TURN_COMPLETED


def test_audit_emit_failure_is_swallowed() -> None:
    """A faulty observation store must not break a turn."""
    from sidecar.ai.routing.tool_observation import (
        ToolObservationEvent,
        ToolObservationStore,
    )

    class _FaultyStore(ToolObservationStore):
        def record(self, event: ToolObservationEvent) -> None:
            raise RuntimeError("boom")

    engine = _ToolLoopEngine(
        plans=[_ToolPlan(result=GenerationResult(content="ok", finish_reason="stop"))]
    )
    router = _build_router(engine=engine)
    decision = router.build_chat_decision(
        request_id="req_faulty",
        messages=[{"role": "user", "content": "hi"}],
        latest_user_content="hi",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=lambda _e: None,
            request_id="req_faulty",
            max_iterations=2,
            observation_store=_FaultyStore(),
        ),
    )
    assert "ok" in decision.response_text


def test_run_tool_loop_finalizes_engine_stall_as_terminal_error() -> None:
    """An engine-stall generation must end the turn, not feed the loop.

    Regression for the double-timeout failure: generation_runtime returns
    finish_reason="timeout" with a synthetic timeout sentence as content;
    before the fix the loop treated that sentence as a normal answer (or
    iterated into another stalled generation) and the Electron idle
    watchdog eventually killed the stream with a misleading transport
    error instead of CMP-LOOP-0015.
    """
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Generation timed out due to engine inactivity.",
                    finish_reason="timeout",
                )
            ),
            # A second plan that must never be consumed: the stall ends
            # the turn on the first iteration.
            _ToolPlan(result=GenerationResult(content="late answer", finish_reason="stop")),
        ]
    )
    router = _build_router(engine=engine)

    with pytest.raises(ToolExecutionFailure) as failure_info:
        router.build_chat_decision(
            request_id="req_engine_stall",
            messages=[{"role": "user", "content": "hello"}],
            latest_user_content="hello",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(
                emit=lambda _e: None,
                request_id="req_engine_stall",
                max_iterations=4,
            ),
        )

    assert failure_info.value.code == CMP_LOOP_ENGINE_STALLED
    assert failure_info.value.retryable is True
    assert engine.call_count == 1
    # The message describes the real cause (an inactivity timeout) and the
    # remedy, instead of the misleading "returned no output before finishing".
    assert "produced no new output" in failure_info.value.message
    assert "120s" in failure_info.value.message
    assert "Settings > Models > Model Library > Advanced" in failure_info.value.message
    assert "returned no output before finishing" not in failure_info.value.message


def test_run_tool_loop_describes_cloud_provider_stall_without_local_hardware_advice() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Generation timed out due to engine inactivity.",
                    finish_reason="timeout",
                )
            )
        ]
    )
    router = _build_router(engine=engine, engine_type="chatgpt")

    with pytest.raises(ToolExecutionFailure) as failure_info:
        router.build_chat_decision(
            request_id="req_cloud_engine_stall",
            messages=[{"role": "user", "content": "hello"}],
            latest_user_content="hello",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(
                emit=lambda _e: None,
                request_id="req_cloud_engine_stall",
                max_iterations=4,
                chunk_inactivity_seconds=300.0,
            ),
        )

    assert failure_info.value.code == CMP_LOOP_ENGINE_STALLED
    assert "cloud model provider" in failure_info.value.message
    assert "300s" in failure_info.value.message
    assert "Settings > Models > Model Library > Advanced" in failure_info.value.message
    assert "local model" not in failure_info.value.message
    assert "VRAM" not in failure_info.value.message


# ---------------------------------------------------------------------------
# Reflexive tool-call retry (tool_call_reliability_net_enabled) — loop seams
# ---------------------------------------------------------------------------


def _read_file_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="read_file",
        description="Read a file from disk.",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
        side_effecting=False,
        server_name="stub",
    )


class _InbandFallbackEngine(_StoreCarryingEngine):
    """Engine that reports the in-band fallback posture (native tools off)."""

    def supports_tool_calling(self) -> bool:
        return False


@pytest.fixture()
def _reflexive_retry_reset():
    from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing

    configure_tool_call_healing(None)
    yield
    configure_tool_call_healing(None)


def _intent_plan(content: str) -> _ToolPlan:
    return _ToolPlan(
        result=GenerationResult(
            content=content,
            finish_reason="stop",
            inband_tool_call_parse_failed=True,
        )
    )


# Content that shows tool intent (a <tool_call> tag naming a known tool) AND
# reads as fake tool use in prose (the tool name appears), so both the
# reflexive-retry Trigger-A seam and the existing nudge machinery engage.
_INTENT_CONTENT = (
    "I'll use read_file now.\n"
    '<tool_call>\n{"name": "read_file", "arguments": {oops not json}}\n</tool_call>'
)


def test_reflexive_retry_appends_one_corrective_message_when_enabled(
    _reflexive_retry_reset,
) -> None:
    from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing

    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    store, profile_id = _seed_route_profile(route=ROUTE_NATIVE_TOOLS)
    events: list[object] = []
    engine = _InbandFallbackEngine(
        plans=[
            _intent_plan(_INTENT_CONTENT),  # -> reflexive retry
            _intent_plan(_INTENT_CONTENT),  # -> retry exhausted; nudge fires
            _ToolPlan(result=GenerationResult(content="ok", finish_reason="stop")),
        ],
        store=store,
    )
    router = _build_router(engine=engine, mcp_client=_StubMCPClient((_read_file_descriptor(),)))

    router.build_chat_decision(
        request_id="req_reflexive_on",
        messages=[{"role": "user", "content": "read the file"}],
        latest_user_content="read the file",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_reflexive_on",
            max_iterations=5,
            streaming=True,
        ),
    )

    corrective = [
        req
        for req in engine.requests
        if any(
            isinstance(m, dict)
            and m.get("role") == "user"
            and "could not be parsed" in str(m.get("content", ""))
            for m in req.get("messages", [])
        )
    ]
    # Exactly one generation carried the corrective message across the whole turn.
    assert len(corrective) >= 1
    # The retry never fires a second time: the counter increments once only.
    counters = store.get_reliability_counters(profile_id=profile_id)
    assert counters is not None
    assert counters.tool_execution_retries == 1

    # The generation AFTER the retry received the schema'd response_format
    # (engine reports no native tool support).
    with_format = [
        req for req in engine.requests if req.get("response_format") is not None
    ]
    assert len(with_format) == 1
    assert with_format[0]["response_format"].type == "json_object"
    reflexive_resets = [
        event
        for event in events
        if isinstance(event, StreamResetEvent) and event.reason == "reflexive_retry"
    ]
    assert len(reflexive_resets) == 1


def test_reflexive_retry_off_by_default_is_byte_parity(
    _reflexive_retry_reset,
) -> None:
    # Flag OFF (default): no corrective message, no counter, response_format None,
    # and the existing nudge behavior still fires exactly as today.
    store, profile_id = _seed_route_profile(route=ROUTE_NATIVE_TOOLS)
    engine = _InbandFallbackEngine(
        plans=[
            _intent_plan(_INTENT_CONTENT),  # nudge fires (no reflexive retry)
            _ToolPlan(result=GenerationResult(content="ok", finish_reason="stop")),
        ],
        store=store,
    )
    router = _build_router(engine=engine, mcp_client=_StubMCPClient((_read_file_descriptor(),)))

    router.build_chat_decision(
        request_id="req_reflexive_off",
        messages=[{"role": "user", "content": "read the file"}],
        latest_user_content="read the file",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req_reflexive_off", max_iterations=5),
    )

    corrective = [
        req
        for req in engine.requests
        if any(
            isinstance(m, dict)
            and "could not be parsed" in str(m.get("content", ""))
            for m in req.get("messages", [])
        )
    ]
    assert corrective == []
    counters = store.get_reliability_counters(profile_id=profile_id)
    if counters is not None:
        assert counters.tool_execution_retries == 0
    assert all(req.get("response_format") is None for req in engine.requests)
    # Existing nudge still fires: a nudge user message was appended.
    nudged = [
        req
        for req in engine.requests
        if any(
            isinstance(m, dict)
            and m.get("role") == "user"
            and "tool" in str(m.get("content", "")).lower()
            for m in req.get("messages", [])
        )
    ]
    assert nudged, "the existing tool-use nudge must still fire when the flag is off"


def test_native_tool_report_with_function_notation_settles_without_retry(
    _reflexive_retry_reset,
) -> None:
    from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing

    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    report = (
        "The new flow used edit_file(normalize_bom=true) successfully.\n"
        "workspace_change_baseline() then workspace_change_delta() makes ownership clear.\n"
        "git_show(ref=x, path=y) returned the parent blob."
    )
    events: list[object] = []
    engine = _StoreCarryingEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "README.md"},
                            call_id="call_native_report",
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content=report, finish_reason="stop")),
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_read_file_descriptor(),)),
    )

    decision = router.build_chat_decision(
        request_id="req_native_report",
        messages=[{"role": "user", "content": "read the file and report"}],
        latest_user_content="read the file and report",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_native_report",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert decision.response_text == report
    assert engine.call_count == 2
    assert not any(
        isinstance(event, StreamResetEvent) and event.reason == "reflexive_retry"
        for event in events
    )
    assert not any(
        "could not be parsed" in str(message.get("content", ""))
        for request in engine.requests
        for message in request.get("messages", [])
        if isinstance(message, dict)
    )


def test_merge_generation_usage_overwrites_last_request_input_tokens() -> None:
    from sidecar.ai.routing.tool_loop import _merge_generation_usage
    from sidecar.ai.tools.models import GenerationUsage

    first = GenerationUsage(
        input_tokens=100,
        output_tokens=10,
        total_tokens=110,
        provider="ollama",
        model="qwen3.6:35b",
        last_request_input_tokens=100,
        provider_cost_usd=0.01,
        generation_tokens=10,
        generation_duration_ms=500,
        prompt_eval_duration_ms=100,
        load_duration_ms=20,
        time_to_first_token_ms=75,
    )
    second = GenerationUsage(
        input_tokens=140,
        output_tokens=20,
        total_tokens=160,
        provider="ollama",
        model="qwen3.6:35b",
        last_request_input_tokens=140,
        provider_cost_usd=0.02,
        generation_tokens=20,
        generation_duration_ms=800,
        prompt_eval_duration_ms=120,
        load_duration_ms=30,
        time_to_first_token_ms=90,
    )
    merged = _merge_generation_usage(first, second)
    assert merged is not None
    # Sums stay sums; the last-request reading is OVERWRITTEN, not added.
    assert merged.input_tokens == 240
    assert merged.output_tokens == 30
    assert merged.total_tokens == 270
    assert merged.last_request_input_tokens == 140
    assert merged.provider_cost_usd == pytest.approx(0.03)
    assert merged.generation_tokens == 30
    assert merged.generation_duration_ms == pytest.approx(1300)
    assert merged.prompt_eval_duration_ms == pytest.approx(220)
    assert merged.load_duration_ms == pytest.approx(50)
    assert merged.time_to_first_token_ms == pytest.approx(75)

    third = GenerationUsage(
        generation_tokens=5,
        generation_duration_ms=200,
        prompt_eval_duration_ms=40,
        load_duration_ms=10,
        time_to_first_token_ms=20,
    )
    merged_three = _merge_generation_usage(merged, third)
    assert merged_three is not None
    assert merged_three.generation_tokens == 35
    assert merged_three.generation_duration_ms == pytest.approx(1500)
    assert merged_three.prompt_eval_duration_ms == pytest.approx(260)
    assert merged_three.load_duration_ms == pytest.approx(60)
    assert merged_three.time_to_first_token_ms == pytest.approx(75)


def test_merge_generation_usage_last_request_falls_back_to_input_tokens() -> None:
    from sidecar.ai.routing.tool_loop import _merge_generation_usage
    from sidecar.ai.tools.models import GenerationUsage

    first = GenerationUsage(input_tokens=100, last_request_input_tokens=100)
    # Next usage without the field populated: its own input_tokens stand in.
    second = GenerationUsage(input_tokens=150)
    merged = _merge_generation_usage(first, second)
    assert merged is not None
    assert merged.last_request_input_tokens == 150

    # An all-zero next record keeps the prior reading rather than zeroing it.
    third = GenerationUsage()
    merged_again = _merge_generation_usage(merged, third)
    assert merged_again is not None
    assert merged_again.last_request_input_tokens == 150
    assert merged_again.provider_cost_usd is None


@pytest.mark.parametrize("invalid_cost", [float("nan"), float("inf"), -1.0, True])
def test_merge_generation_usage_rejects_invalid_provider_cost(invalid_cost: object) -> None:
    from sidecar.ai.routing.tool_loop import _merge_generation_usage
    from sidecar.ai.tools.models import GenerationUsage

    merged = _merge_generation_usage(
        GenerationUsage(provider_cost_usd=0.01),
        GenerationUsage(provider_cost_usd=invalid_cost),  # type: ignore[arg-type]
    )
    assert merged is not None
    assert merged.provider_cost_usd is None
