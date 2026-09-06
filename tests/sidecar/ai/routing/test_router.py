from __future__ import annotations

import threading
import time
from dataclasses import dataclass, replace
from typing import Any

import pytest

from sidecar.ai.config import FallbackModelConfig, RuntimeConfig, ToolPolicySnapshot
from sidecar.ai.context.builder import ContextBuilder, RuntimeToolStatus
from sidecar.ai.context.compaction import CompactionResult
from sidecar.ai.context.prompt_cache import StructuredSystemPrompt
from sidecar.ai.context.runtime_message_markers import PLAN_MODE_OVERLAY_HEADING
from sidecar.ai.context.token_budget import apply_budget_check
from sidecar.ai.engines.factory import EngineSelection
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.error_codes import (
    CMP_CTX_BUDGET_EXHAUSTED,
    CMP_LOOP_BUDGET_EXCEEDED,
    CMP_LOOP_ENGINE_STALLED,
    CMP_LOOP_TOOL_INPUT_VALIDATION,
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_DISABLED,
    CMP_TSRCH_DEFERRED_TOOL,
)
from sidecar.ai.feature_flags import (
    FEATURE_CONTEXT_COMPACTION,
    FEATURE_PHASE_EVENTS,
    FEATURE_PROMPT_CACHE,
    FEATURE_SHELL_SECURITY,
    FEATURE_TOKEN_BUDGET,
    FEATURE_TOOL_SEARCH,
)
from sidecar.ai.mcp.models import MCPToolDescriptor, MCPToolResult
from sidecar.ai.memory.store import ApprovedMemory
from sidecar.ai.routing import generation_runtime
from sidecar.ai.routing.loop_events import (
    ContextCompactedEvent,
    FallbackTriggeredEvent,
    StopEvent,
    StreamResetEvent,
    ThinkingEvent,
    TokenDeltaEvent,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.models import (
    GenerationResult,
    GenerationUsage,
    StreamingEvent,
    ToolCallRequest,
)
from sidecar.ai.tools.tool_search import TOOL_SEARCH_RESULT_KIND, compute_deferral_set
from sidecar.protocol import CHAT_THINKING_KIND_STATUS


@dataclass(frozen=True)
class _ToolPlan:
    result: GenerationResult


class _StubEngine:
    def __init__(self, plans: list[_ToolPlan]) -> None:
        self._plans = plans
        self._index = 0
        self.last_kwargs: dict[str, Any] = {}
        self.calls: list[dict[str, Any]] = []

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        snapshot = dict(kwargs)
        tools = snapshot.get("tools")
        if isinstance(tools, list):
            snapshot["tools"] = [dict(item) for item in tools]
        messages = snapshot.get("messages")
        if isinstance(messages, list):
            snapshot["messages"] = [dict(item) for item in messages]
        self.last_kwargs = snapshot
        self.calls.append(snapshot)
        if self._index >= len(self._plans):
            return GenerationResult(content="fallback", finish_reason="stop")
        plan = self._plans[self._index]
        self._index += 1
        return plan.result

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _CompactionStreamEngine(_StubEngine):
    # Compaction runs on the canonical stream path (see
    # build_compaction_generate_fn), so compaction tests need an engine that
    # serves the plan queue over stream_with_tools. Kept off _StubEngine
    # itself: advertising a stream path would reroute every other test.
    def stream_with_tools(self, **kwargs: Any):
        result = self.generate_with_tools(**kwargs)
        if result.content:
            yield StreamingEvent(kind="content", text=str(result.content))
        return result


class _StreamingToolEngine(_StubEngine):
    def __init__(self, result: GenerationResult) -> None:
        super().__init__(plans=[])
        self._result = result
        self.generate_calls = 0
        self.stream_calls = 0

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.last_kwargs = dict(kwargs)
        self.generate_calls += 1
        return self._result

    def stream_with_tools(self, **kwargs: Any):
        self.last_kwargs = dict(kwargs)
        self.stream_calls += 1
        yield StreamingEvent(kind="thinking", text="Planning the next step.")
        yield StreamingEvent(kind="content", text="Ready")
        yield StreamingEvent(kind="content", text=" now.")
        return self._result


class _BlockingStreamingEngine(_StubEngine):
    def __init__(self, *, wait_seconds: float, result: GenerationResult) -> None:
        super().__init__(plans=[])
        self._wait_seconds = wait_seconds
        self._result = result
        self.stream_calls = 0
        # Test-settable escape hatch: the blocked stream-reader thread is
        # process-global state, so the owning test must release it before
        # returning or the reader leaks into later test files.
        self.release = threading.Event()

    def stream_with_tools(self, **kwargs: Any):
        self.last_kwargs = dict(kwargs)
        self.stream_calls += 1
        self.release.wait(self._wait_seconds)
        yield StreamingEvent(kind="content", text="late chunk")
        return self._result


class _StubMCPClient:
    def __init__(
        self,
        descriptors: dict[str, MCPToolDescriptor],
        results: dict[str, MCPToolResult] | None = None,
    ) -> None:
        self._descriptors = descriptors
        self._results = results or {}
        self.last_execute: tuple[str, dict[str, Any]] | None = None
        self.executed_calls: list[tuple[str, dict[str, Any]]] = []

    @property
    def available_tools(self) -> list[MCPToolDescriptor]:
        return list(self._descriptors.values())

    def tool_descriptor(self, tool_name: str) -> MCPToolDescriptor | None:
        return self._descriptors.get(tool_name)

    def execute_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: object = None,
        on_output_chunk: object = None,  # W2-1: live-tail emitter (unused here)
    ) -> MCPToolResult:
        _ = (timeout_seconds, cancel_handle, on_output_chunk)
        self.last_execute = (tool_name, dict(arguments))
        self.executed_calls.append(self.last_execute)
        return self._results[tool_name]


class _PromptMemoryStore:
    def __init__(self) -> None:
        self.recall_queries: list[str] = []

    def recall_memories(self, query: str, *, limit: int) -> list[ApprovedMemory]:
        _ = limit
        self.recall_queries.append(query)
        if not str(query or "").strip():
            return []
        return [
            ApprovedMemory(
                id=1,
                session_id="session-test",
                title="Tea routine",
                lesson_text="The user likes afternoon green tea.",
                lesson_kind="routine",
                confidence=0.9,
                source_excerpt="User described an afternoon tea routine.",
                content_fingerprint="tea-routine",
                family_key="routine:tea",
                provenance="test",
                created_at="2026-08-23T00:00:00Z",
                updated_at="2026-08-23T00:00:00Z",
            )
        ]

    def get_recent_memories_by_kind(
        self, lesson_kind: str, limit: int
    ) -> list[ApprovedMemory]:
        _ = (lesson_kind, limit)
        return []


def _budget_tool_descriptors(count: int = 15) -> dict[str, MCPToolDescriptor]:
    return {
        f"mcp__budget__tool_{index:02d}": MCPToolDescriptor(
            name=f"mcp__budget__tool_{index:02d}",
            description=f"Budget test tool {index:02d}",
            input_schema={
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
            },
            side_effecting=False,
            server_name="budget",
        )
        for index in range(count)
    }


def _budget_pressure_config(**overrides: Any) -> RuntimeConfig:
    config = RuntimeConfig(
        engine_type="mock",
        model="mock-v1",
        context_length=60_000,
        max_tokens=1_000,
        token_budget_reserved_for_summary=0,
        token_budget_tool_overhead=0,
        token_budget_warning_ratio=0.01,
        token_budget_auto_compact_ratio=0.90,
        feature_flags={
            FEATURE_TOKEN_BUDGET: True,
            FEATURE_TOOL_SEARCH: True,
        },
        tool_search_mode="standard",
    )
    return replace(config, **overrides)


def _budget_pressure_text() -> str:
    return "pressure text " * 1000


def _build_router(
    *,
    config: RuntimeConfig,
    engine: _StubEngine,
    mcp_client: _StubMCPClient,
    memory_store: Any | None = None,
) -> ChatRouter:
    if not config.tools_workspace_root and not config.agent_workspace_root:
        config = replace(
            config,
            tools_workspace_root="C:/workspace",
        )
    if config.mode == "chat":
        config = replace(config, mode="assist")
    return ChatRouter(
        config=config,
        engine=engine,
        mcp_client=mcp_client,
        context_builder=ContextBuilder(None),
        memory_store=memory_store,
    )


def test_router_generates_text_when_model_returns_terminal_response() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(result=GenerationResult(content="stubbed:hello", finish_reason="stop")),
        ]
    )
    router = _build_router(
        config=RuntimeConfig(engine_type="ollama", model="llama3.2"),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )
    decision = router.build_chat_decision(
        request_id="req_1",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )
    assert decision.response_text == "stubbed:hello"
    assert decision.thinking_text is not None
    assert decision.thinking_kind == CHAT_THINKING_KIND_STATUS
    assert decision.persist_thinking is False


def test_router_emits_one_personality_overlay_carrying_the_agent_name() -> None:
    """v3: name only. The four profile overlays and the custom-text overlay are gone."""
    engine = _StubEngine(
        plans=[
            _ToolPlan(result=GenerationResult(content="stubbed:hello", finish_reason="stop")),
        ]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="llama3.2",
            assistant_name="Echo",
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    router.build_chat_decision(
        request_id="req_identity_overlay",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )

    messages = engine.last_kwargs["messages"]
    system_messages = [message for message in messages if message["role"] == "system"]
    assert str(engine.last_kwargs["system"]).startswith("You are the AI assistant in Jenny")
    # 2nd/3rd messages are the always-on (default-on flag) "## Runtime Model
    # Identity" and "## Session Environment" overlays appended after the
    # personality layer -- see sidecar/ai/routing/chat_decision.py's
    # append_model_identity_runtime_system_message and
    # append_session_environment_runtime_system_message.
    assert len(system_messages) == 3
    assert system_messages[0]["content"] == (
        "## Personality\nYour name is Echo. Personality shapes tone, not facts; the "
        "current request and the runtime, workspace, and tool instructions take "
        "precedence over everything below."
    )
    for retired in (
        "## Assistant Identity Overlay",
        "## Personality Profile Overlay",
        "## Custom Personality Overlay",
        "## Optional Advanced Personality Context",
    ):
        assert all(retired not in message["content"] for message in system_messages)
    assert system_messages[1]["content"].startswith("## Runtime Model Identity")
    assert system_messages[2]["content"].startswith("## Session Environment")
    assert "provider: ollama" in system_messages[1]["content"]
    assert "model: llama3.2" in system_messages[1]["content"]


def test_router_excludes_prompt_runtime_overlays_from_compaction_input(monkeypatch) -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(result=GenerationResult(content="stubbed:hello", finish_reason="stop")),
        ]
    )
    captured: dict[str, list[dict[str, Any]]] = {}

    def fake_compact_context(messages, *_args, **_kwargs):  # noqa: ANN001
        captured["messages"] = [dict(message) for message in messages]
        return CompactionResult(
            messages=[
                {"role": "system", "content": "Compacted system prompt."},
                {"role": "user", "content": "hello"},
            ],
            strategy="full",
            tokens_before=999,
            tokens_after=10,
        )

    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.compact_context",
        fake_compact_context,
    )
    long_user_content = "hello " * 320
    memory_store = _PromptMemoryStore()
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={
                FEATURE_TOKEN_BUDGET: True,
                FEATURE_CONTEXT_COMPACTION: True,
            },
            context_length=800,
            max_tokens=10,
            token_budget_reserved_for_summary=10,
            token_budget_warning_ratio=0.3,
            token_budget_auto_compact_ratio=0.4,
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
        memory_store=memory_store,
    )

    router.build_chat_decision(
        request_id="req_compact_runtime_overlays",
        messages=[{"role": "user", "content": long_user_content}],
        latest_user_content=long_user_content,
        mode="chat",
        approvals_pre_granted=True,
    )

    compaction_text = "\n".join(
        str(message.get("content") or "") for message in captured["messages"]
    )
    assert "## Recalled Memories" not in compaction_text
    assert "## Context Pressure Advisory" not in compaction_text

    system_headings = [
        str(message.get("content") or "").splitlines()[0]
        for message in engine.last_kwargs["messages"]
        if message.get("role") == "system"
    ]
    assert "## Recalled Memories" in system_headings
    assert "## Context Pressure Advisory" in system_headings
    assert memory_store.recall_queries == [long_user_content.strip()]


def test_router_returns_terminal_when_runtime_overlays_exceed_post_compaction_budget(
    monkeypatch,
) -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(result=GenerationResult(content="stubbed:hello", finish_reason="stop")),
        ]
    )

    def fake_compact_context(messages, *_args, **_kwargs):  # noqa: ANN001
        return CompactionResult(
            messages=[
                {"role": "system", "content": "Compacted system prompt."},
                {"role": "user", "content": "hello"},
            ],
            strategy="full",
            tokens_before=999,
            tokens_after=1,
        )

    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.compact_context",
        fake_compact_context,
    )
    memory_store = _PromptMemoryStore()
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={
                FEATURE_TOKEN_BUDGET: True,
                FEATURE_CONTEXT_COMPACTION: True,
            },
            context_length=100,
            max_tokens=10,
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
        memory_store=memory_store,
    )

    decision = router.build_chat_decision(
        request_id="req_compact_runtime_overlay_terminal",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert "Context remained too large after compaction" in decision.response_text
    assert decision.terminal_error_code == CMP_CTX_BUDGET_EXHAUSTED
    assert decision.terminal_error_retryable is False
    assert engine.last_kwargs == {}
    assert memory_store.recall_queries == ["hello"]


def test_router_streaming_runtime_uses_stream_with_tools() -> None:
    engine = _StreamingToolEngine(GenerationResult(content="Ready now.", finish_reason="stop"))
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_stream_runtime",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_stream_runtime",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert decision.response_text == "Ready now."
    assert engine.stream_calls == 1
    assert engine.generate_calls == 0
    assert "chat.thinking" in decision.streamed_event_types
    assert "chat.token" in decision.streamed_event_types
    assert any(isinstance(event, ThinkingEvent) for event in events)
    assert any(isinstance(event, TokenDeltaEvent) for event in events)


def test_router_streaming_with_available_tools_still_flushes_terminal_text_live() -> None:
    events: list[object] = []
    first_delta_received = threading.Event()
    observed = {"first_delta_live": False}

    class _LiveTextWithToolsEngine(_StubEngine):
        def __init__(self) -> None:
            super().__init__(plans=[])
            self.stream_calls = 0

        def stream_with_tools(self, **kwargs: Any):
            self.last_kwargs = dict(kwargs)
            self.stream_calls += 1
            yield StreamingEvent(kind="content", text="Live ")
            observed["first_delta_live"] = first_delta_received.wait(timeout=1.0)
            yield StreamingEvent(kind="content", text="response.")
            return GenerationResult(content="Live response.", finish_reason="stop")

    engine = _LiveTextWithToolsEngine()
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient(
            {
                "read_file": MCPToolDescriptor(
                    name="read_file",
                    description="Read file",
                    input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
                    side_effecting=False,
                    server_name="tools",
                )
            }
        ),
    )

    def _emit(event: object) -> None:
        events.append(event)
        if isinstance(event, TokenDeltaEvent) and event.delta == "Live ":
            first_delta_received.set()

    decision = router.build_chat_decision(
        request_id="req_stream_live_with_tools",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=_emit,
            request_id="req_stream_live_with_tools",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert decision.response_text == "Live response."
    assert observed["first_delta_live"] is True
    assert not any(isinstance(event, StreamResetEvent) for event in events)


def test_router_streaming_ollama_receives_serializable_prompt_cache_system() -> None:
    engine = _StreamingToolEngine(GenerationResult(content="Ready now.", finish_reason="stop"))
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="qwen3.6:35b-a3b-ud-q4_k_xl",
            feature_flags={FEATURE_PROMPT_CACHE: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    decision = router.build_chat_decision(
        request_id="req_stream_ollama_cache",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=lambda _event: None,
            request_id="req_stream_ollama_cache",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert decision.response_text == "Ready now."
    assert engine.last_kwargs["prompt_cache_enabled"] is True
    assert isinstance(engine.last_kwargs["system"], str)
    assert not isinstance(engine.last_kwargs["system"], StructuredSystemPrompt)


def test_router_streaming_suppresses_content_after_control_token() -> None:
    class _ControlTokenEngine(_StreamingToolEngine):
        def stream_with_tools(self, **kwargs: Any):
            self.last_kwargs = dict(kwargs)
            self.stream_calls += 1
            yield StreamingEvent(kind="content", text="Good response.")
            yield StreamingEvent(kind="content", text="<|tool_response>")
            yield StreamingEvent(kind="content", text="Duplicate garbage.")
            return self._result

    engine = _ControlTokenEngine(
        GenerationResult(
            content="Good response.<|tool_response>Duplicate garbage.",
            finish_reason="stop",
        )
    )
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )
    events: list[object] = []

    router.build_chat_decision(
        request_id="req_ctrl_suppress",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_ctrl_suppress",
            max_iterations=4,
            streaming=True,
        ),
    )

    token_deltas = [e for e in events if isinstance(e, TokenDeltaEvent)]
    combined = "".join(td.delta for td in token_deltas)
    assert "Good response." in combined
    assert "Duplicate garbage." not in combined
    assert "<|tool_response>" not in combined


def test_router_streaming_strips_prefix_control_tokens_without_suppressing() -> None:
    class _PrefixTokenEngine(_StreamingToolEngine):
        def stream_with_tools(self, **kwargs: Any):
            self.last_kwargs = dict(kwargs)
            self.stream_calls += 1
            yield StreamingEvent(kind="content", text="<|tool_response>")
            yield StreamingEvent(kind="content", text="<|tool_response>")
            yield StreamingEvent(kind="content", text="<channel|>")
            yield StreamingEvent(kind="content", text="Here is the actual response.")
            return self._result

    engine = _PrefixTokenEngine(
        GenerationResult(
            content="Here is the actual response.",
            finish_reason="stop",
        )
    )
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )
    events: list[object] = []

    router.build_chat_decision(
        request_id="req_prefix_tokens",
        messages=[{"role": "user", "content": "read a file"}],
        latest_user_content="read a file",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_prefix_tokens",
            max_iterations=4,
            streaming=True,
        ),
    )

    token_deltas = [e for e in events if isinstance(e, TokenDeltaEvent)]
    combined = "".join(td.delta for td in token_deltas)
    assert "Here is the actual response." in combined
    assert "<|tool_response>" not in combined
    assert "<channel|>" not in combined


def test_router_streaming_suppresses_post_response_analysis() -> None:
    class _AnalysisEngine(_StreamingToolEngine):
        def stream_with_tools(self, **kwargs: Any):
            self.last_kwargs = dict(kwargs)
            self.stream_calls += 1
            yield StreamingEvent(kind="content", text="File created!")
            yield StreamingEvent(kind="content", text="\n\n### Tool Call Analysis\n")
            yield StreamingEvent(kind="content", text="The model called create_artifact...")
            yield StreamingEvent(kind="content", text="<channel|>Duplicate response.")
            return self._result

    engine = _AnalysisEngine(
        GenerationResult(
            content="File created!\n\n### Tool Call Analysis\nThe model called...<channel|>Dup.",
            finish_reason="stop",
        )
    )
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )
    events: list[object] = []

    router.build_chat_decision(
        request_id="req_analysis_suppress",
        messages=[{"role": "user", "content": "create a file"}],
        latest_user_content="create a file",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_analysis_suppress",
            max_iterations=4,
            streaming=True,
        ),
    )

    token_deltas = [e for e in events if isinstance(e, TokenDeltaEvent)]
    combined = "".join(td.delta for td in token_deltas)
    assert "File created!" in combined
    assert "Tool Call Analysis" not in combined
    assert "Duplicate response." not in combined
    assert "<channel|>" not in combined


def test_router_streaming_runtime_times_out_when_next_chunk_blocks() -> None:
    # Block far longer than the watchdog + reader-reclaim grace: stall
    # detection fires at ~model_load_grace (0.05s) and _close_stream_reader
    # then joins the blocked reader for at most 0.5s (H10 bounded reclaim), so
    # an aborted turn returns in well under a second while a missed abort
    # would sit out the full 5s block.
    engine = _BlockingStreamingEngine(
        wait_seconds=5.0,
        result=GenerationResult(content="late chunk", finish_reason="stop"),
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            chunk_inactivity_seconds=0.05,
            feature_flags={FEATURE_PHASE_EVENTS: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )
    events: list[object] = []

    started_at = time.monotonic()
    try:
        with pytest.raises(ToolExecutionFailure) as failure_info:
            router.build_chat_decision(
                request_id="req_stream_timeout",
                messages=[{"role": "user", "content": "hello"}],
                latest_user_content="hello",
                mode="chat",
                approvals_pre_granted=True,
                runtime=LoopRuntime(
                    emit=events.append,
                    request_id="req_stream_timeout",
                    max_iterations=4,
                    chunk_inactivity_seconds=0.05,
                    # The engine blocks before the FIRST chunk, so the model-load
                    # grace governs this wait; pin it small too so the watchdog
                    # still fires fast in this load-phase scenario.
                    model_load_grace_seconds=0.05,
                    streaming=True,
                ),
            )
        elapsed = time.monotonic() - started_at
    finally:
        # The aborted turn quarantines the still-blocked reader thread; that
        # thread and its live-reader slot are process-global, so unblock it
        # and wait for it to exit before the test returns. Leaving it alive
        # made the stream-reader capacity/cleanup tests in
        # test_generation_runtime.py fail when this file ran first.
        engine.release.set()
        drain_deadline = time.monotonic() + 2.0
        while time.monotonic() < drain_deadline and any(
            thread.name == "router-stream-reader" and thread.is_alive()
            for thread in threading.enumerate()
        ):
            time.sleep(0.01)

    # The stall terminates the turn as a retryable CMP-LOOP-0015 error
    # instead of promoting the synthetic timeout sentence to the answer
    # (and instead of iterating into another stalled generation).
    assert failure_info.value.code == CMP_LOOP_ENGINE_STALLED
    assert failure_info.value.retryable is True
    assert engine.stream_calls == 1
    assert elapsed < 2.0
    stop_events = [event for event in events if isinstance(event, StopEvent)]
    assert stop_events
    assert stop_events[-1].code == CMP_LOOP_ENGINE_STALLED


def test_router_non_streaming_runtime_keeps_generate_with_tools_path() -> None:
    engine = _StreamingToolEngine(GenerationResult(content="Ready now.", finish_reason="stop"))
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    decision = router.build_chat_decision(
        request_id="req_non_stream_runtime",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "Ready now."
    assert engine.generate_calls == 1
    assert engine.stream_calls == 0


def test_router_builds_request_scoped_executable_tools_prompt_block() -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="stubbed", finish_reason="stop"))]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="qwen3.5:9b",
            tools_web_enabled=False,
        ),
        engine=engine,
        mcp_client=_StubMCPClient(
            {
                "read_file": MCPToolDescriptor(
                    name="read_file",
                    description="Read a file from the workspace.",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
                "web_search": MCPToolDescriptor(
                    name="web_search",
                    description="Search the web.",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
            }
        ),
    )

    _ = router.build_chat_decision(
        request_id="req_tools_prompt",
        messages=[{"role": "user", "content": "What is the weather in Nashville today?"}],
        latest_user_content="What is the weather in Nashville today?",
        mode="assist",
        approvals_pre_granted=True,
    )

    system_prompt = str(engine.calls[0]["system"])
    assert "## Executable Tools" in system_prompt
    assert "`read_file`" in system_prompt
    assert "`web_search`: config disabled" not in system_prompt
    assert "`web_search` is unavailable for this request: config disabled" in system_prompt
    assert "Only tools listed as available in this block may be called." in system_prompt
    assert (
        "Any tool not listed as available in this block is unavailable for this request."
        in system_prompt
    )
    assert "This request likely needs up-to-date external information." in system_prompt


def test_router_logs_when_current_info_request_skips_available_web_search(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_events: list[dict[str, Any]] = []

    def _capture_log_event(_logger, _level, **kwargs: Any) -> None:
        captured_events.append(kwargs)

    monkeypatch.setattr("sidecar.ai.routing.router.log_event", _capture_log_event)
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="It is sunny.", finish_reason="stop"))]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="qwen3.5:9b",
            tools_web_enabled=True,
        ),
        engine=engine,
        mcp_client=_StubMCPClient(
            {
                "web_search": MCPToolDescriptor(
                    name="web_search",
                    description="Search the web.",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
            }
        ),
    )

    _ = router.build_chat_decision(
        request_id="req_current_info_no_tool",
        messages=[{"role": "user", "content": "What is the weather in Nashville today?"}],
        latest_user_content="What is the weather in Nashville today?",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert any(
        event.get("event") == "ai.router.current_info_without_tool_call"
        for event in captured_events
    )


def test_router_repairs_empty_web_search_arguments_from_current_prompt() -> None:
    prompt = "What is the latest OpenAI news today?"
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Searching.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="web_search",
                            arguments={},
                            call_id="call_web_empty",
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Search complete.", finish_reason="stop")),
        ]
    )
    mcp_client = _StubMCPClient(
        {
            "web_search": MCPToolDescriptor(
                name="web_search",
                description="Search the web.",
                input_schema={
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
                side_effecting=False,
                server_name="tools",
            ),
        },
        results={
            "web_search": MCPToolResult(
                tool_name="web_search",
                output='{"answer":"result"}',
                success=True,
                content_type="application/json",
                ui_payload=None,
            ),
        },
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="qwen3.5:9b",
            tools_web_enabled=True,
        ),
        engine=engine,
        mcp_client=mcp_client,
    )

    decision = router.build_chat_decision(
        request_id="req_current_info_empty_web_args",
        messages=[{"role": "user", "content": prompt}],
        latest_user_content=prompt,
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "Search complete."
    assert mcp_client.executed_calls == [("web_search", {"query": prompt})]
    assert decision.tool_results[0].success is True


def test_router_request_tool_preferences_remove_disabled_tools_from_payload() -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="stubbed", finish_reason="stop"))]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="qwen3.5:9b",
            tools_web_enabled=True,
        ),
        engine=engine,
        mcp_client=_StubMCPClient(
            {
                "read_file": MCPToolDescriptor(
                    name="read_file",
                    description="Read a file from the workspace.",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
                "web_search": MCPToolDescriptor(
                    name="web_search",
                    description="Search the web.",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
            }
        ),
    )

    _ = router.build_chat_decision(
        request_id="req_tool_prefs_prompt",
        messages=[{"role": "user", "content": "What is the weather in Nashville today?"}],
        latest_user_content="What is the weather in Nashville today?",
        mode="assist",
        approvals_pre_granted=True,
        tool_preferences={
            "enabled_tools": ("read_file",),
            "disabled_tools": ("web_search",),
        },
    )

    system_prompt = str(engine.calls[0]["system"])
    assert "`web_search`: request preference disabled" not in system_prompt
    assert (
        "`web_search` is unavailable for this request: request preference disabled" in system_prompt
    )
    tool_names = [str(item.get("name") or "") for item in engine.calls[0]["tools"]]
    assert "web_search" not in tool_names


def test_router_plan_mode_filters_side_effecting_tools_from_payload_and_status() -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="stubbed", finish_reason="stop"))]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="qwen3.5:9b",
        ),
        engine=engine,
        mcp_client=_StubMCPClient(
            {
                "read_file": MCPToolDescriptor(
                    name="read_file",
                    description="Read a file from the workspace.",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
                "write_file": MCPToolDescriptor(
                    name="write_file",
                    description="Write a file in the workspace.",
                    input_schema={"type": "object"},
                    side_effecting=True,
                    server_name="tools",
                ),
            }
        ),
    )

    _ = router.build_chat_decision(
        request_id="req_plan_mode_payload",
        messages=[{"role": "user", "content": "Plan the file update"}],
        latest_user_content="Plan the file update",
        mode="assist",
        approvals_pre_granted=False,
        plan_mode=True,
    )

    tool_names = [str(item.get("name") or "") for item in engine.calls[0]["tools"]]
    assert "read_file" in tool_names
    assert "write_file" not in tool_names
    assert PLAN_MODE_OVERLAY_HEADING not in str(engine.calls[0]["system"])
    overlay_count = sum(
        str(message.get("content") or "").count(PLAN_MODE_OVERLAY_HEADING)
        for message in engine.calls[0]["messages"]
    )
    assert overlay_count == 1
    tool_statuses = router._tool_status_entries(plan_mode=True)
    write_status = next(status for status in tool_statuses if status.name == "write_file")
    assert write_status.available is False
    assert write_status.reason == "read-only mode blocks side-effecting tools"


def test_router_plan_mode_hides_side_effecting_deferred_tools_from_tool_search() -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="stubbed", finish_reason="stop"))]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={FEATURE_TOOL_SEARCH: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient(
            {
                "read_file": MCPToolDescriptor(
                    name="read_file",
                    description="Read a file",
                    input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
                    side_effecting=False,
                    server_name="tools",
                ),
                "mcp__git__commit": MCPToolDescriptor(
                    name="mcp__git__commit",
                    description="Commit changes",
                    input_schema={"type": "object", "properties": {"message": {"type": "string"}}},
                    side_effecting=True,
                    server_name="github",
                ),
            }
        ),
    )

    _ = router.build_chat_decision(
        request_id="req_plan_mode_tool_search",
        messages=[{"role": "user", "content": "commit the staged changes"}],
        latest_user_content="commit the staged changes",
        mode="assist",
        approvals_pre_granted=False,
        plan_mode=True,
    )

    tool_names = [str(item.get("name") or "") for item in engine.calls[0]["tools"]]
    assert "mcp__git__commit" not in tool_names
    assert "tool_search" not in tool_names
    tool_statuses = router._tool_status_entries(plan_mode=True)
    commit_status = next(status for status in tool_statuses if status.name == "mcp__git__commit")
    assert commit_status.available is False
    assert commit_status.reason == "read-only mode blocks side-effecting tools"


def test_router_rejects_request_disabled_tool_call_without_crashing_loop() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading file.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "README.md"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="# README",
            success=True,
            content_type="text",
            ui_payload=None,
        )
    }
    client = _StubMCPClient(descriptors, results=results)
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
        ),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_read_disabled",
        messages=[{"role": "user", "content": "Read README"}],
        latest_user_content="Read README",
        mode="assist",
        approvals_pre_granted=True,
        tool_preferences={
            "enabled_tools": (),
            "disabled_tools": ("read_file",),
        },
    )

    assert decision.response_text == "Done."
    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].tool_name == "read_file"
    assert decision.tool_results[0].success is False
    assert decision.tool_results[0].error_code == CMP_TOOL_DISABLED
    assert decision.tool_results[0].metadata.get("request_preference_disabled") is True
    assert client.executed_calls == []


def test_router_rejects_plan_mode_side_effecting_tool_call_without_approval_or_execution() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Writing file.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="write_file",
                            arguments={"path": "notes.md", "content": "planned"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "write_file": MCPToolDescriptor(
            name="write_file",
            description="Write file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=True,
            server_name="tools",
        )
    }
    results = {
        "write_file": MCPToolResult(
            tool_name="write_file",
            output="wrote notes.md",
            success=True,
        )
    }
    client = _StubMCPClient(descriptors, results=results)
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
        ),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_read_only_blocked_call",
        messages=[{"role": "user", "content": "Write notes.md"}],
        latest_user_content="Write notes.md",
        mode="assist",
        approvals_pre_granted=False,
        plan_mode=True,
    )

    assert decision.response_text == "Done."
    assert decision.approval_request is None
    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].tool_name == "write_file"
    assert decision.tool_results[0].success is False
    assert decision.tool_results[0].error_code == CMP_MODE_TOOL_BLOCKED
    assert decision.tool_results[0].metadata.get("read_only_blocked") is True
    assert client.executed_calls == []


def test_router_strips_control_token_tail_from_assistant_output() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        "I can help with that."
                        "<|endoftext|><|im_start|>user i want to add tool usage to my app."
                    ),
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    decision = router.build_chat_decision(
        request_id="req_sanitize",
        messages=[{"role": "user", "content": "help"}],
        latest_user_content="help",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "I can help with that."


def test_router_side_effecting_tool_requests_approval() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Need file write.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="write_file",
                            arguments={"path": "notes.txt", "content": "summary"},
                            call_id="call-write-1",
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            )
        ]
    )
    descriptors = {
        "write_file": MCPToolDescriptor(
            name="write_file",
            description="Write a file",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            },
            side_effecting=True,
            server_name="tools",
        )
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_confirm_side_effects=True,
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )
    decision = router.build_chat_decision(
        request_id="req_write_file",
        messages=[{"role": "user", "content": "write a summary file"}],
        latest_user_content="write a summary file",
        mode="assist",
        approvals_pre_granted=False,
    )
    assert decision.approval_request is not None
    assert decision.approval_request.tool_name == "write_file"
    assert decision.approval_request.tool_input["path"] == "notes.txt"
    assert decision.approval_request.tool_call_id == "call-write-1"


def test_router_shell_security_allows_safe_run_command_without_approval() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Listing files.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="run_command",
                            arguments={"command": "ls"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="Done.", finish_reason="stop"),
            ),
        ]
    )
    descriptors = {
        "run_command": MCPToolDescriptor(
            name="run_command",
            description="Run shell command",
            input_schema={"type": "object", "properties": {"command": {"type": "string"}}},
            side_effecting=True,
            server_name="tools",
        )
    }
    results = {
        "run_command": MCPToolResult(
            tool_name="run_command",
            output='{"ok": true}',
            success=True,
        )
    }
    client = _StubMCPClient(descriptors, results)
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            tool_policy_snapshot=ToolPolicySnapshot(
                legacy_policies=(("run_command", "auto"),),
            ),
            feature_flags={FEATURE_SHELL_SECURITY: True},
        ),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_safe_shell",
        session_id="session-shell",
        messages=[{"role": "user", "content": "list files"}],
        latest_user_content="list files",
        mode="assist",
        approvals_pre_granted=False,
    )

    assert decision.approval_request is None
    assert client.last_execute is not None
    assert client.last_execute[0] == "run_command"
    assert client.last_execute[1]["command"] == "ls"


def test_router_shell_security_requests_approval_for_risky_run_command() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Committing changes.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="run_command",
                            arguments={"command": "git commit -m 'ship it'"},
                            call_id="call-shell-approval-1",
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            )
        ]
    )
    descriptors = {
        "run_command": MCPToolDescriptor(
            name="run_command",
            description="Run shell command",
            input_schema={"type": "object", "properties": {"command": {"type": "string"}}},
            side_effecting=True,
            server_name="tools",
        )
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={FEATURE_SHELL_SECURITY: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, {}),
    )

    decision = router.build_chat_decision(
        request_id="req_risky_shell",
        messages=[{"role": "user", "content": "commit"}],
        latest_user_content="commit",
        mode="assist",
        # Without a pre-granted plan a risky run_command must prompt. The
        # router's first gate to fire is the tool policy's built-in `ask`;
        # a plan the user already approved no longer re-prompts on the shell
        # classifier's NEEDS_APPROVAL verdict (W2-16-F10), whose un-granted
        # unit behavior is pinned in test_tool_execution_security.py.
        approvals_pre_granted=False,
    )

    assert decision.approval_request is not None
    assert decision.approval_request.tool_name == "run_command"
    assert "requires approval" in decision.approval_request.reason.lower()
    assert decision.approval_request.tool_call_id == "call-shell-approval-1"


def test_router_auto_policy_skips_shell_classifier_approval() -> None:
    """An explicit AUTO policy (Always allow / blanket) covers NEEDS_APPROVAL.

    run_command's built-in default is ``ask``, so an AUTO decision only exists
    when the user opted in — that intent extends to the shell classifier's
    medium-risk verdict. BLOCKED commands are still rejected before this and
    paranoid safety mode still prompts.
    """
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Committing changes.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="run_command",
                            arguments={"command": "git commit -m 'ship it'"},
                            call_id="call-shell-auto-1",
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="Committed.", finish_reason="stop"),
            ),
        ]
    )
    descriptors = {
        "run_command": MCPToolDescriptor(
            name="run_command",
            description="Run shell command",
            input_schema={"type": "object", "properties": {"command": {"type": "string"}}},
            side_effecting=True,
            server_name="tools",
        )
    }
    results = {
        "run_command": MCPToolResult(
            tool_name="run_command",
            output='{"ok": true}',
            success=True,
        )
    }
    client = _StubMCPClient(descriptors, results)
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            tool_policy_snapshot=ToolPolicySnapshot(
                legacy_policies=(("run_command", "auto"),),
            ),
            feature_flags={FEATURE_SHELL_SECURITY: True},
        ),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_auto_shell",
        messages=[{"role": "user", "content": "commit"}],
        latest_user_content="commit",
        mode="assist",
        approvals_pre_granted=False,
    )

    assert decision.approval_request is None
    assert client.last_execute is not None
    assert client.last_execute[0] == "run_command"


def test_router_shell_security_blocks_destructive_run_command_before_execution() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Deleting files.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="run_command",
                            arguments={"command": "rm -rf /"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            )
        ]
    )
    descriptors = {
        "run_command": MCPToolDescriptor(
            name="run_command",
            description="Run shell command",
            input_schema={"type": "object", "properties": {"command": {"type": "string"}}},
            side_effecting=True,
            server_name="tools",
        )
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={FEATURE_SHELL_SECURITY: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, {}),
    )

    decision = router.build_chat_decision(
        request_id="req_blocked_shell",
        messages=[{"role": "user", "content": "delete everything"}],
        latest_user_content="delete everything",
        mode="assist",
        approvals_pre_granted=False,
    )

    # Turn-survival: the destructive command is still blocked — it never
    # executes — but the block is a failed outcome the model can react to,
    # not a raised turn-killer.
    blocked = [
        outcome
        for outcome in decision.tool_results
        if outcome.error_code == CMP_TOOL_COMMAND_BLOCKED
    ]
    assert len(blocked) == 1
    assert blocked[0].success is False
    assert "security classifier" in blocked[0].output


def test_router_executes_read_only_tool_without_approval() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading file.",
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
                result=GenerationResult(content="Here is the summary.", finish_reason="stop"),
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="# README",
            success=True,
            content_type="text",
            ui_payload=None,
        )
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_confirm_side_effects=True,
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )
    decision = router.build_chat_decision(
        request_id="req_read",
        messages=[{"role": "user", "content": "/tool read README.md"}],
        latest_user_content="/tool read README.md",
        mode="assist",
        approvals_pre_granted=False,
    )
    assert decision.approval_request is None
    assert decision.response_text == "Here is the summary."
    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].tool_name == "read_file"


def test_router_preserves_assistant_and_tool_messages_between_tool_iterations() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading file.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "README.md"},
                            call_id="call_read_1",
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="Here is the summary.", finish_reason="stop"),
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="# README",
            success=True,
            content_type="text",
            ui_payload=None,
        )
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_confirm_side_effects=True,
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )

    decision = router.build_chat_decision(
        request_id="req_read_context",
        messages=[{"role": "user", "content": "/tool read README.md"}],
        latest_user_content="/tool read README.md",
        mode="assist",
        approvals_pre_granted=False,
    )

    assert decision.response_text == "Here is the summary."
    assert len(engine.calls) == 2
    second_call_messages = engine.calls[1]["messages"]
    assert isinstance(second_call_messages, list)
    assistant_tool_message = next(
        message
        for message in second_call_messages
        if message.get("role") == "assistant" and message.get("tool_calls")
    )
    assert assistant_tool_message["tool_calls"] == [
        {
            "id": "call_read_1",
            "name": "read_file",
            "arguments": {"path": "README.md"},
        }
    ]
    tool_result_message = next(
        message for message in second_call_messages if message.get("role") == "tool"
    )
    assert tool_result_message["tool_call_id"] == "call_read_1"
    assert tool_result_message["name"] == "read_file"


def test_router_streaming_carries_pre_tool_commentary_into_next_generation() -> None:
    class _StreamingPreToolTextEngine(_StubEngine):
        def __init__(self) -> None:
            super().__init__(
                plans=[
                    _ToolPlan(
                        result=GenerationResult(
                            content="Here is the requested report.",
                            finish_reason="stop",
                        )
                    )
                ]
            )
            self.stream_calls = 0

        def stream_with_tools(self, **kwargs: Any):
            self.last_kwargs = dict(kwargs)
            self.calls.append(dict(kwargs))
            self.stream_calls += 1
            if self.stream_calls > 1:
                yield StreamingEvent(kind="content", text="Here is the requested report.")
                return GenerationResult(
                    content="Here is the requested report.",
                    finish_reason="stop",
                )
            yield StreamingEvent(kind="content", text="I cannot access repository files.")
            return GenerationResult(
                content="I cannot access repository files.",
                tool_calls=(
                    ToolCallRequest(
                        tool_id="read_file",
                        arguments={"path": "README.md"},
                        call_id="call_read_stream",
                    ),
                ),
                finish_reason="tool_calls",
            )

    engine = _StreamingPreToolTextEngine()
    client = _StubMCPClient(
        {
            "read_file": MCPToolDescriptor(
                name="read_file",
                description="Read file",
                input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
                side_effecting=False,
                server_name="tools",
            )
        },
        results={
            "read_file": MCPToolResult(
                tool_name="read_file",
                output="# README",
                success=True,
                content_type="text",
                ui_payload=None,
            )
        },
    )
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=client,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_stream_tool_buffer",
        messages=[{"role": "user", "content": "Research the repo architecture."}],
        latest_user_content="Research the repo architecture.",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_stream_tool_buffer",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert decision.response_text == "Here is the requested report."
    assert engine.stream_calls == 2
    visible_stream_parts: list[str] = []
    for event in events:
        if isinstance(event, StreamResetEvent):
            visible_stream_parts.clear()
        elif isinstance(event, TokenDeltaEvent):
            visible_stream_parts.append(event.delta)
    visible_stream_text = "".join(visible_stream_parts)
    assert "Here is the requested report." in visible_stream_text
    assert "I cannot access repository files." not in visible_stream_text
    second_call_messages = engine.calls[1]["messages"]
    assistant_tool_message = next(
        message
        for message in second_call_messages
        if message.get("role") == "assistant" and message.get("tool_calls")
    )
    # The next generation sees the exact commentary that was already visible
    # to the user, so it can continue without acknowledging the request again.
    assert assistant_tool_message["content"] == "I cannot access repository files."


def test_router_retries_generic_greeting_after_successful_tool_result() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading file.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "README.md"},
                            call_id="call_read_retry",
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Hey there! How's your day going?", finish_reason="stop"
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Here is the architecture report.", finish_reason="stop"
                )
            ),
        ]
    )
    client = _StubMCPClient(
        {
            "read_file": MCPToolDescriptor(
                name="read_file",
                description="Read file",
                input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
                side_effecting=False,
                server_name="tools",
            )
        },
        results={
            "read_file": MCPToolResult(
                tool_name="read_file",
                output="# README",
                success=True,
                content_type="text",
                ui_payload=None,
            )
        },
    )
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_greeting_retry",
        messages=[{"role": "user", "content": "Research the repo architecture."}],
        latest_user_content="Research the repo architecture.",
        mode="assist",
        approvals_pre_granted=False,
    )

    assert decision.response_text == "Here is the architecture report."
    assert len(engine.calls) == 3
    retry_messages = engine.calls[2]["messages"]
    assert any(
        message.get("role") == "user"
        and "Continue the user's current request" in str(message.get("content") or "")
        for message in retry_messages
    )


def test_router_injects_expected_read_snapshot_from_canonical_session_messages() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Writing file.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="write_file",
                            arguments={"path": "notes.txt", "content": "after\n"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "write_file": MCPToolDescriptor(
            name="write_file",
            description="Write file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=True,
            server_name="tools",
        )
    }
    results = {
        "write_file": MCPToolResult(
            tool_name="write_file",
            output="Wrote file",
            success=True,
            metadata={"path": "notes.txt"},
        )
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_workspace_root="C:/workspace",
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )

    decision = router.build_chat_decision(
        request_id="req_snapshot_injected",
        messages=[{"role": "user", "content": "overwrite notes"}],
        latest_user_content="overwrite notes",
        mode="assist",
        approvals_pre_granted=True,
        canonical_session_messages=[
            {
                "kind": "tool_result",
                "tool_result": {
                    "tool_name": "read_file",
                    "is_error": False,
                    "metadata": {
                        "path": "notes.txt",
                        "read_snapshot": {
                            "path": "notes.txt",
                            "scope": "full",
                            "size_bytes": 6,
                            "mtime_ns": 123,
                            "sha256": "abc123",
                        },
                    },
                },
            },
        ],
    )

    assert decision.response_text == "Done."
    assert router._mcp_client.last_execute is not None  # noqa: SLF001
    _, arguments = router._mcp_client.last_execute  # noqa: SLF001
    assert arguments["expected_read_snapshot"] == {
        "path": "notes.txt",
        "scope": "full",
        "size_bytes": 6,
        "mtime_ns": 123,
        "sha256": "abc123",
    }


def test_router_ignores_stale_partial_snapshot_when_rebuilding_cache() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Editing file.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="edit_file",
                            arguments={
                                "file_path": "notes.txt",
                                "old_string": "before",
                                "new_string": "after",
                            },
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "edit_file": MCPToolDescriptor(
            name="edit_file",
            description="Edit file",
            input_schema={"type": "object", "properties": {"file_path": {"type": "string"}}},
            side_effecting=True,
            server_name="tools",
        )
    }
    results = {
        "edit_file": MCPToolResult(
            tool_name="edit_file",
            output="Edited file",
            success=True,
            metadata={"path": "notes.txt"},
        )
    }
    client = _StubMCPClient(descriptors, results=results)
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_workspace_root="C:/workspace",
        ),
        engine=engine,
        mcp_client=client,
    )

    _ = router.build_chat_decision(
        request_id="req_partial_stale",
        messages=[{"role": "user", "content": "edit notes"}],
        latest_user_content="edit notes",
        mode="assist",
        approvals_pre_granted=True,
        canonical_session_messages=[
            {
                "kind": "tool_result",
                "tool_result": {
                    "tool_name": "read_file",
                    "is_error": False,
                    "metadata": {
                        "path": "notes.txt",
                        "read_snapshot": {
                            "path": "notes.txt",
                            "scope": "full",
                            "size_bytes": 6,
                            "mtime_ns": 123,
                            "sha256": "abc123",
                        },
                    },
                },
            },
            {
                "kind": "tool_result",
                "tool_result": {
                    "tool_name": "read_file",
                    "is_error": False,
                    "metadata": {
                        "path": "notes.txt",
                        "read_snapshot": {
                            "path": "notes.txt",
                            "scope": "partial",
                            "size_bytes": 7,
                            "mtime_ns": 456,
                        },
                    },
                },
            },
        ],
    )

    assert client.last_execute is not None
    _, arguments = client.last_execute
    assert "expected_read_snapshot" not in arguments


def test_router_forwards_runtime_modifiers_to_engine_call() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(result=GenerationResult(content="ok", finish_reason="stop")),
        ]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="openai",
            model="gpt-4.1",
            temperature=0.2,
            max_tokens=2048,
            reasoning_effort="high",
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    decision = router.build_chat_decision(
        request_id="req_modifiers",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "ok"
    assert engine.last_kwargs["temperature"] == 0.2
    assert engine.last_kwargs["max_tokens"] == 2048
    assert engine.last_kwargs["reasoning_effort"] == "high"


def test_router_accumulates_usage_across_tool_loop_steps() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading file.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": "README.md"},
                        ),
                    ),
                    finish_reason="tool_calls",
                    usage=GenerationUsage(
                        input_tokens=80,
                        output_tokens=24,
                        total_tokens=104,
                        provider="openai",
                        model="gpt-4.1",
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Here is the summary.",
                    finish_reason="stop",
                    usage=GenerationUsage(
                        input_tokens=22,
                        output_tokens=11,
                        total_tokens=33,
                        provider="openai",
                        model="gpt-4.1",
                    ),
                ),
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="# README",
            success=True,
            content_type="text",
            ui_payload=None,
        )
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="openai", model="gpt-4.1"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )

    decision = router.build_chat_decision(
        request_id="req_usage",
        messages=[{"role": "user", "content": "Summarize README.md"}],
        latest_user_content="Summarize README.md",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "Here is the summary."
    assert decision.usage is not None
    assert decision.usage.input_tokens == 102
    assert decision.usage.output_tokens == 35
    assert decision.usage.total_tokens == 137
    assert decision.usage.provider == "openai"
    assert decision.usage.model == "gpt-4.1"


def test_router_rejects_coerced_args_on_side_effecting_tool() -> None:
    """Side-effecting tools with coerced (malformed) arguments must fail closed."""
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Writing file.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="write_file",
                            arguments={},
                            coerced=True,
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="Could not write.", finish_reason="stop"),
            ),
        ]
    )
    descriptors = {
        "write_file": MCPToolDescriptor(
            name="write_file",
            description="Write a file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=True,
            server_name="tools",
        )
    }
    results = {
        "write_file": MCPToolResult(
            tool_name="write_file",
            output="should not reach here",
            success=True,
            content_type="text",
            ui_payload=None,
        )
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )
    decision = router.build_chat_decision(
        request_id="req_coerced",
        messages=[{"role": "user", "content": "write something"}],
        latest_user_content="write something",
        mode="assist",
        approvals_pre_granted=True,
    )
    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].success is False
    assert "rejected" in decision.tool_results[0].output
    assert "malformed" in decision.tool_results[0].output


def test_router_allows_coerced_args_on_read_only_tool() -> None:
    """Read-only tools with coerced arguments should still execute."""
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={},
                            coerced=True,
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="Done.", finish_reason="stop"),
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read a file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="file content",
            success=True,
            content_type="text",
            ui_payload=None,
        )
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )
    decision = router.build_chat_decision(
        request_id="req_coerced_ro",
        messages=[{"role": "user", "content": "read something"}],
        latest_user_content="read something",
        mode="assist",
        approvals_pre_granted=True,
    )
    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].success is True


def test_router_rejects_schema_invalid_tool_arguments_before_mcp_dispatch() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="read_file",
                            arguments={"path": 123},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="Done.", finish_reason="stop"),
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read a file",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="file content",
            success=True,
            content_type="text",
            ui_payload=None,
        )
    }
    mcp_client = _StubMCPClient(descriptors, results=results)
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=mcp_client,
    )

    decision = router.build_chat_decision(
        request_id="req_schema_invalid",
        messages=[{"role": "user", "content": "Read something"}],
        latest_user_content="Read something",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].success is False
    assert decision.tool_results[0].error_code == CMP_LOOP_TOOL_INPUT_VALIDATION
    assert "malformed arguments" in decision.tool_results[0].output
    assert "Required keys: path" in decision.tool_results[0].output
    assert '"path": "<string>"' in decision.tool_results[0].output
    assert decision.tool_results[0].metadata["required_keys"] == ["path"]
    assert decision.tool_results[0].metadata["minimal_valid_arguments"] == {"path": "<string>"}
    assert mcp_client.executed_calls == []
    assert len(engine.calls) == 2


def test_router_rejects_schema_invalid_side_effecting_tool_and_continues_loop() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Writing.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="write_file",
                            arguments={},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="Write blocked.", finish_reason="stop"),
            ),
        ]
    )
    descriptors = {
        "write_file": MCPToolDescriptor(
            name="write_file",
            description="Write a file",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            side_effecting=True,
            server_name="tools",
        )
    }
    mcp_client = _StubMCPClient(
        descriptors,
        results={
            "write_file": MCPToolResult(
                tool_name="write_file",
                output="should not execute",
                success=True,
                content_type="text",
                ui_payload=None,
            ),
        },
    )
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=mcp_client,
    )

    decision = router.build_chat_decision(
        request_id="req_schema_invalid_side_effect",
        messages=[{"role": "user", "content": "Write to file"}],
        latest_user_content="Write to file",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "Write blocked."
    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].success is False
    assert decision.tool_results[0].error_code == CMP_LOOP_TOOL_INPUT_VALIDATION
    assert "Required keys:" in decision.tool_results[0].output
    assert decision.tool_results[0].metadata["required_keys"] == ["path", "content"]
    assert decision.tool_results[0].metadata["minimal_valid_arguments"] == {
        "path": "<string>",
        "content": "<string>",
    }
    assert mcp_client.executed_calls == []
    assert len(engine.calls) == 2


def test_router_validates_arguments_before_raising_an_approval_prompt() -> None:
    """A schema-invalid call must never reach the user as an approval prompt.

    Regression: validation used to run in dispatch, AFTER the prompt was
    answered. A live turn approved an exit_plan_mode payload and had the very
    same arguments rejected a moment later, discarding the plan the user had
    just accepted. The identical descriptor approves fine with valid arguments
    (see test_router_requests_approval_for_side_effecting_tool), so this pins
    ordering, not availability.
    """
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Writing.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="write_file",
                            arguments={},
                            call_id="call-write-invalid",
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="Write blocked.", finish_reason="stop"),
            ),
        ]
    )
    descriptors = {
        "write_file": MCPToolDescriptor(
            name="write_file",
            description="Write a file",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            side_effecting=True,
            server_name="tools",
        )
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_confirm_side_effects=True,
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_validate_before_approval",
        messages=[{"role": "user", "content": "write a summary file"}],
        latest_user_content="write a summary file",
        mode="assist",
        approvals_pre_granted=False,
    )

    assert decision.approval_request is None, "the user was prompted for a malformed call"
    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].success is False
    assert decision.tool_results[0].error_code == CMP_LOOP_TOOL_INPUT_VALIDATION
    # The repair hints must survive the earlier interception, or the model
    # loses the only thing that tells it how to resubmit.
    assert "path" in decision.tool_results[0].metadata["required_keys"]
    assert decision.tool_results[0].metadata["minimal_valid_arguments"]


def test_router_threads_generated_artifacts_and_session_context_to_create_artifact() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Creating artifact.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="create_artifact",
                            arguments={
                                "artifact_kind": "document",
                                "title": "Scratch Plan",
                                "content": "# Plan",
                            },
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "create_artifact": MCPToolDescriptor(
            name="create_artifact",
            description="Create scratch artifact",
            input_schema={"type": "object", "properties": {"title": {"type": "string"}}},
            side_effecting=True,
            server_name="tools",
        )
    }
    client = _StubMCPClient(
        descriptors,
        results={
            "create_artifact": MCPToolResult(
                tool_name="create_artifact",
                output='Created document "Scratch Plan"',
                success=True,
                generated_artifacts=(
                    {
                        "artifact_id": "artifact_file_session_router_plan",
                        "artifact_kind": "document",
                        "title": "Scratch Plan",
                        "file_name": "plan.md",
                        "display_path": ".jenny/artifacts/session-router/plan.md",
                        "absolute_path": "/tmp/workspace/.jenny/artifacts/session-router/plan.md",
                        "language": "markdown",
                        "editable": True,
                        "status": "available",
                    },
                ),
            ),
        },
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_todo_enabled=True,
        ),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_artifact",
        session_id="session-router",
        messages=[{"role": "user", "content": "Make a scratch plan"}],
        latest_user_content="Make a scratch plan",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert client.last_execute is not None
    assert client.last_execute[0] == "create_artifact"
    assert client.last_execute[1]["_jenny_session_id"] == "session-router"
    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].generated_artifacts[0]["file_name"] == "plan.md"


def test_router_forwards_todo_session_context() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Track tasks.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="todo_write",
                            arguments={"todos": [{"content": "Track this", "status": "pending"}]},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="Tracked.", finish_reason="stop"),
            ),
        ]
    )
    client = _StubMCPClient(
        {
            "todo_write": MCPToolDescriptor(
                name="todo_write",
                description="Write todos",
                input_schema={"type": "object"},
                side_effecting=True,
                server_name="tools",
            ),
        },
        {
            "todo_write": MCPToolResult(
                tool_name="todo_write",
                output='{"count": 1}',
                success=True,
            ),
        },
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_todo_enabled=True,
        ),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_todo",
        session_id="session-todo",
        messages=[{"role": "user", "content": "track work"}],
        latest_user_content="track work",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert client.last_execute is not None
    assert client.last_execute[0] == "todo_write"
    assert client.last_execute[1]["_jenny_session_id"] == "session-todo"
    assert len(decision.tool_results) == 1


def test_router_forwards_mermaid_session_context() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Rendering diagram.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={
                                "diagram_type": "flowchart",
                                "prompt": "graph TD\nA[Start] --> B[End]",
                                "title": "Flow",
                            },
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Rendered.", finish_reason="stop")),
        ]
    )
    client = _StubMCPClient(
        {
            "mermaid_generate": MCPToolDescriptor(
                name="mermaid_generate",
                description="Generate Mermaid",
                input_schema={"type": "object", "properties": {"prompt": {"type": "string"}}},
                side_effecting=False,
                server_name="tools",
            ),
        },
        {
            "mermaid_generate": MCPToolResult(
                tool_name="mermaid_generate",
                output='{"mermaid": "graph TD\\nA[Start] --> B[End]", "diagram_type": "flowchart"}',
                success=True,
                generated_artifacts=(
                    {
                        "artifact_id": "artifact_file_session_mermaid_flow",
                        "artifact_kind": "document",
                        "title": "Flow",
                        "file_name": "flow.mmd",
                        "display_path": ".jenny/artifacts/session-mermaid/flow.mmd",
                        "absolute_path": "/tmp/workspace/.jenny/artifacts/session-mermaid/flow.mmd",
                        "language": "mermaid",
                        "editable": True,
                        "status": "available",
                    },
                ),
            ),
        },
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_mermaid_enabled=True,
        ),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_mermaid",
        session_id="session-mermaid",
        messages=[{"role": "user", "content": "Render this as a diagram"}],
        latest_user_content="Render this as a diagram",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert client.last_execute is not None
    assert client.last_execute[0] == "mermaid_generate"
    assert client.last_execute[1]["_jenny_session_id"] == "session-mermaid"
    assert len(decision.tool_results) == 1
    assert decision.tool_results[0].generated_artifacts[0]["file_name"].endswith(".mmd")


def test_router_forwards_error_code_and_metadata_through_tool_pipeline() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Searching.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="glob_files",
                            arguments={"pattern": "**/*.xyz"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="No matches.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "glob_files": MCPToolDescriptor(
            name="glob_files",
            description="Search files by glob",
            input_schema={"type": "object", "properties": {"pattern": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "glob_files": MCPToolResult(
            tool_name="glob_files",
            output="No files matched pattern '**/*.xyz'.",
            success=True,
            error_code=None,
            metadata={"match_count": 0, "truncated": False},
        )
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )
    decision = router.build_chat_decision(
        request_id="req_meta",
        messages=[{"role": "user", "content": "find xyz files"}],
        latest_user_content="find xyz files",
        mode="assist",
        approvals_pre_granted=False,
    )
    assert len(decision.tool_results) == 1
    outcome = decision.tool_results[0]
    assert outcome.error_code is None
    assert outcome.metadata["match_count"] == 0
    assert outcome.metadata["truncated"] is False
    policy_decision = outcome.metadata.get("policy_decision")
    assert isinstance(policy_decision, dict)
    assert policy_decision["decision"] == "auto"
    assert policy_decision["tool_name"] == "glob_files"


def test_router_dispatches_tool_search_and_expands_deferred_payload() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Looking for the right tool.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="tool_search",
                            arguments={"query": "git commit"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Calling git commit.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mcp__git__commit",
                            arguments={"message": "Batch 8"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read a file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        ),
        "mcp__git__commit": MCPToolDescriptor(
            name="mcp__git__commit",
            description="Commit changes",
            input_schema={"type": "object", "properties": {"message": {"type": "string"}}},
            side_effecting=False,
            server_name="github",
        ),
    }
    results = {
        "mcp__git__commit": MCPToolResult(
            tool_name="mcp__git__commit",
            output="Created commit abc123",
            success=True,
        ),
    }
    client = _StubMCPClient(descriptors, results=results)
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={FEATURE_TOOL_SEARCH: True},
            tool_search_mode="tst",
        ),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_tool_search",
        messages=[{"role": "user", "content": "commit the staged changes"}],
        latest_user_content="commit the staged changes",
        mode="assist",
        approvals_pre_granted=False,
    )

    assert decision.response_text == "Done."
    assert [tool_name for tool_name, _arguments in client.executed_calls] == ["mcp__git__commit"]
    assert len(engine.calls) == 3

    first_call_tools = engine.calls[0]["tools"]
    deferred_entry = next(
        schema for schema in first_call_tools if schema["name"] == "mcp__git__commit"
    )
    assert deferred_entry["defer_loading"] is True
    assert "parameters" not in deferred_entry
    assert any(schema["name"] == "tool_search" for schema in first_call_tools)

    second_call_tools = engine.calls[1]["tools"]
    full_entry = next(
        schema for schema in second_call_tools if schema["name"] == "mcp__git__commit"
    )
    assert full_entry["parameters"]["properties"]["message"]["type"] == "string"
    assert "defer_loading" not in full_entry

    tool_search_outcome = next(
        outcome for outcome in decision.tool_results if outcome.tool_name == "tool_search"
    )
    assert tool_search_outcome.success is True
    assert tool_search_outcome.metadata == {
        "kind": TOOL_SEARCH_RESULT_KIND,
        "discovered_tools": ["mcp__git__commit"],
        "match_count": 1,
        "effects": "none",
    }


@pytest.mark.parametrize("mode", ["assist", "autonomous"])
def test_router_budget_warning_filters_tool_schemas_and_status_consistently(
    mode: str,
) -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="filtered", finish_reason="stop"))]
    )
    router = _build_router(
        config=_budget_pressure_config(),
        engine=engine,
        mcp_client=_StubMCPClient(_budget_tool_descriptors()),
    )
    pressure_text = _budget_pressure_text()

    decision = router.build_chat_decision(
        request_id=f"req_budget_schema_filter_{mode}",
        messages=[{"role": "user", "content": pressure_text}],
        latest_user_content=pressure_text,
        mode=mode,
        approvals_pre_granted=True,
    )

    first_call_tools = engine.calls[0]["tools"]
    full_schema_names = [
        schema["name"] for schema in first_call_tools if "parameters" in schema
    ]
    deferred_names = [
        schema["name"] for schema in first_call_tools if schema.get("defer_loading") is True
    ]

    assert decision.response_text == "filtered"
    assert len(full_schema_names) == 12
    assert "inspect_harness" not in full_schema_names
    assert "tool_search" in full_schema_names
    assert "mcp__budget__tool_14" in deferred_names
    assert "mcp__budget__tool_14" not in full_schema_names
    assert decision.tool_schema_count == len(first_call_tools)


def test_router_budget_filter_caps_oversized_request_allowlist() -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="filtered", finish_reason="stop"))]
    )
    descriptors = _budget_tool_descriptors()
    router = _build_router(
        config=_budget_pressure_config(token_budget_tool_overhead=500),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )
    pressure_text = _budget_pressure_text()

    decision = router.build_chat_decision(
        request_id="req_budget_schema_allowlist",
        messages=[{"role": "user", "content": pressure_text}],
        latest_user_content=pressure_text,
        mode="assist",
        approvals_pre_granted=True,
        tool_preferences={"enabled_tools": ("tool_search", *descriptors)},
    )

    full_schema_names = [
        schema["name"] for schema in engine.calls[0]["tools"] if "parameters" in schema
    ]

    assert len(full_schema_names) == 12
    assert "tool_search" in full_schema_names
    assert {f"mcp__budget__tool_{index:02d}" for index in range(11)}.issubset(
        full_schema_names
    )
    assert {f"mcp__budget__tool_{index:02d}" for index in range(11, 15)}.isdisjoint(
        full_schema_names
    )
    assert decision.compact_threshold_tokens == 47_700


@pytest.mark.parametrize(
    ("config_overrides", "expected_full_schema_count"),
    [
        ({"token_budget_auto_compact_ratio": 0.1, "context_length": 30_000}, 8),
        ({"context_length": 2500}, 5),
    ],
)
def test_router_budget_pressure_caps_tighten_with_level(
    config_overrides: dict[str, Any],
    expected_full_schema_count: int,
) -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="filtered", finish_reason="stop"))]
    )
    router = _build_router(
        config=_budget_pressure_config(**config_overrides),
        engine=engine,
        mcp_client=_StubMCPClient(_budget_tool_descriptors()),
    )
    pressure_text = _budget_pressure_text()

    router.build_chat_decision(
        request_id="req_budget_schema_cap",
        messages=[{"role": "user", "content": pressure_text}],
        latest_user_content=pressure_text,
        mode="assist",
        approvals_pre_granted=True,
    )

    full_schema_names = [
        schema["name"] for schema in engine.calls[0]["tools"] if "parameters" in schema
    ]

    assert len(full_schema_names) == expected_full_schema_count
    assert "tool_search" in full_schema_names
    assert "mcp__budget__tool_14" not in full_schema_names


def test_router_budget_filtering_does_not_bypass_chat_mode_tool_block() -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="chat", finish_reason="stop"))]
    )
    router = _build_router(
        config=_budget_pressure_config(),
        engine=engine,
        mcp_client=_StubMCPClient(_budget_tool_descriptors()),
    )
    pressure_text = _budget_pressure_text()

    router.build_chat_decision(
        request_id="req_budget_chat_mode",
        messages=[{"role": "user", "content": pressure_text}],
        latest_user_content=pressure_text,
        mode="chat",
        approvals_pre_granted=False,
    )

    tool_names = [schema["name"] for schema in engine.calls[0]["tools"]]

    assert tool_names == []


def test_tool_search_internal_rollback_exposes_the_full_tool_contract() -> None:
    descriptors = _budget_tool_descriptors(4)
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="done", finish_reason="stop"))]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={FEATURE_TOOL_SEARCH: False},
            tool_search_mode="tst-auto",
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    router.build_chat_decision(
        request_id="req_tool_search_rollback",
        messages=[{"role": "user", "content": "Use the available tools."}],
        latest_user_content="Use the available tools.",
        mode="assist",
        approvals_pre_granted=True,
    )

    schemas = {schema["name"]: schema for schema in engine.calls[0]["tools"]}
    assert "tool_search" not in schemas
    for name in descriptors:
        assert "parameters" in schemas[name], f"rollback hid {name}"


def test_router_tool_search_expands_budget_filtered_tool_schema() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Finding filtered tool.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="tool_search",
                            arguments={"query": "select:mcp__budget__tool_14"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="expanded", finish_reason="stop")),
        ]
    )
    router = _build_router(
        config=_budget_pressure_config(token_budget_tool_overhead=500),
        engine=engine,
        mcp_client=_StubMCPClient(_budget_tool_descriptors()),
    )
    pressure_text = _budget_pressure_text()

    decision = router.build_chat_decision(
        request_id="req_budget_tool_search",
        messages=[{"role": "user", "content": pressure_text}],
        latest_user_content=pressure_text,
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "expanded"
    first_call_tools = engine.calls[0]["tools"]
    second_call_tools = engine.calls[1]["tools"]
    assert next(
        schema for schema in first_call_tools if schema["name"] == "mcp__budget__tool_14"
    )["defer_loading"] is True
    expanded_schema = next(
        schema for schema in second_call_tools if schema["name"] == "mcp__budget__tool_14"
    )
    assert expanded_schema["parameters"]["properties"]["value"]["type"] == "string"
    tool_search_outcome = next(
        outcome for outcome in decision.tool_results if outcome.tool_name == "tool_search"
    )
    assert tool_search_outcome.metadata["discovered_tools"] == ["mcp__budget__tool_14"]
    assert decision.compact_threshold_tokens == 47_250


def test_router_unavailable_tool_search_reports_plain_unavailable_result() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Trying discovery.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="tool_search",
                            arguments={"query": "select:mcp__budget__tool_14"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="done", finish_reason="stop")),
        ]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={FEATURE_TOOL_SEARCH: True},
            tool_search_mode="standard",
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    decision = router.build_chat_decision(
        request_id="req_unavailable_tool_search",
        messages=[{"role": "user", "content": "find a tool"}],
        latest_user_content="find a tool",
        mode="assist",
        approvals_pre_granted=True,
    )

    tool_search_outcome = decision.tool_results[0]

    assert decision.response_text == "done"
    assert tool_search_outcome.tool_name == "tool_search"
    assert tool_search_outcome.success is False
    assert tool_search_outcome.output == "Tool search is unavailable for this request."
    assert "Call tool_search first" not in tool_search_outcome.output


def test_router_blocks_direct_budget_filtered_tool_call_until_tool_search_runs() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Calling hidden tool directly.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mcp__budget__tool_14",
                            arguments={"value": "one"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="search first", finish_reason="stop")),
        ]
    )
    client = _StubMCPClient(_budget_tool_descriptors())
    router = _build_router(
        config=_budget_pressure_config(),
        engine=engine,
        mcp_client=client,
    )
    pressure_text = _budget_pressure_text()

    decision = router.build_chat_decision(
        request_id="req_budget_direct_filtered",
        messages=[{"role": "user", "content": pressure_text}],
        latest_user_content=pressure_text,
        mode="assist",
        approvals_pre_granted=True,
    )

    assert client.executed_calls == []
    assert decision.tool_results[0].tool_name == "mcp__budget__tool_14"
    assert decision.tool_results[0].error_code == CMP_TSRCH_DEFERRED_TOOL
    assert decision.tool_results[0].metadata["tool_search_required"] is True


def test_router_budget_filtering_keeps_plan_mode_side_effecting_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="plan", finish_reason="stop"))]
    )
    descriptors = _budget_tool_descriptors(14)
    descriptors["mcp__budget__tool_14"] = MCPToolDescriptor(
        name="mcp__budget__tool_14",
        description="Budget side-effecting tool",
        input_schema={"type": "object", "properties": {"value": {"type": "string"}}},
        side_effecting=True,
        server_name="budget",
    )
    router = _build_router(
        config=_budget_pressure_config(),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )
    pressure_text = _budget_pressure_text()
    logged_statuses: list[tuple[Any, ...]] = []

    def capture_tool_contract_log(**kwargs: Any) -> None:
        logged_statuses.append(tuple(kwargs["tool_statuses"]))

    monkeypatch.setattr(router, "_log_tool_contract", capture_tool_contract_log)

    router.build_chat_decision(
        request_id="req_budget_plan_mode",
        messages=[{"role": "user", "content": pressure_text}],
        latest_user_content=pressure_text,
        mode="assist",
        approvals_pre_granted=False,
        plan_mode=True,
    )

    tool_names = [schema["name"] for schema in engine.calls[0]["tools"]]
    filtered_status = next(
        status
        for status in logged_statuses[-1]
        if status.name == "mcp__budget__tool_14"
    )
    assert "mcp__budget__tool_14" not in tool_names
    assert filtered_status.available is False
    assert filtered_status.reason == "read-only mode blocks side-effecting tools"


def test_router_blocks_direct_call_to_deferred_tool_until_tool_search_runs() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Calling git commit directly.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mcp__git__commit",
                            arguments={"message": "Batch 8"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="Need tool search first.", finish_reason="stop")
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read a file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        ),
        "mcp__git__commit": MCPToolDescriptor(
            name="mcp__git__commit",
            description="Commit changes",
            input_schema={"type": "object", "properties": {"message": {"type": "string"}}},
            side_effecting=False,
            server_name="github",
        ),
    }
    client = _StubMCPClient(descriptors, results={})
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={FEATURE_TOOL_SEARCH: True},
            tool_search_mode="tst",
        ),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_deferred_direct",
        messages=[{"role": "user", "content": "commit the staged changes"}],
        latest_user_content="commit the staged changes",
        mode="assist",
        approvals_pre_granted=False,
    )

    assert decision.response_text == "Need tool search first."
    assert client.executed_calls == []
    assert decision.tool_results[0].error_code == CMP_TSRCH_DEFERRED_TOOL
    assert decision.tool_results[0].metadata["tool_search_required"] is True


def test_router_serializes_tool_search_output_via_content_alias(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Looking for tools.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="tool_search",
                            arguments={"query": "git commit"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read a file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        ),
        "mcp__git__commit": MCPToolDescriptor(
            name="mcp__git__commit",
            description="Commit changes",
            input_schema={"type": "object", "properties": {"message": {"type": "string"}}},
            side_effecting=False,
            server_name="github",
        ),
    }

    def _stub_tool_search(*_args: Any, **_kwargs: Any) -> ToolHandlerResult:
        return ToolHandlerResult(
            output="Found 1 tool(s):\n- mcp__git__commit: Commit changes",
            metadata={
                "kind": TOOL_SEARCH_RESULT_KIND,
                "discovered_tools": ["mcp__git__commit"],
                "match_count": 1,
            },
        )

    monkeypatch.setattr(
        "sidecar.ai.tools.tool_search_handler.handle_tool_search", _stub_tool_search
    )

    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={FEATURE_TOOL_SEARCH: True},
            tool_search_mode="tst",
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_tool_search_alias",
        messages=[{"role": "user", "content": "find the git commit tool"}],
        latest_user_content="find the git commit tool",
        mode="assist",
        approvals_pre_granted=False,
    )

    tool_search_outcome = next(
        outcome for outcome in decision.tool_results if outcome.tool_name == "tool_search"
    )
    assert tool_search_outcome.output == "Found 1 tool(s):\n- mcp__git__commit: Commit changes"
    assert tool_search_outcome.metadata["match_count"] == 1


def test_router_keeps_prompt_and_tool_prefix_stable_for_resumed_history() -> None:
    messages = [
        {"role": "user", "content": "discover git tools"},
        {
            "role": "tool",
            "kind": "tool_result",
            "content": "Found 1 tool",
            "tool_result": {
                "call_id": "call_tool_search_1",
                "tool_name": "tool_search",
                "output_text": "Found 1 tool(s):\n- mcp__git__commit: Commit changes",
                "metadata": {
                    "kind": TOOL_SEARCH_RESULT_KIND,
                    "discovered_tools": ["mcp__git__commit"],
                    "match_count": 1,
                },
            },
        },
    ]
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read a file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        ),
        "mcp__git__commit": MCPToolDescriptor(
            name="mcp__git__commit",
            description="Commit changes",
            input_schema={"type": "object", "properties": {"message": {"type": "string"}}},
            side_effecting=False,
            server_name="github",
        ),
    }

    first_engine = _StubEngine(
        plans=[
            _ToolPlan(result=GenerationResult(content="Ready to continue.", finish_reason="stop"))
        ]
    )
    second_engine = _StubEngine(
        plans=[
            _ToolPlan(result=GenerationResult(content="Ready to continue.", finish_reason="stop"))
        ]
    )
    first_router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={
                FEATURE_PROMPT_CACHE: True,
                FEATURE_TOOL_SEARCH: True,
            },
        ),
        engine=first_engine,
        mcp_client=_StubMCPClient(descriptors),
    )
    second_router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={
                FEATURE_PROMPT_CACHE: True,
                FEATURE_TOOL_SEARCH: True,
            },
        ),
        engine=second_engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    first_router.build_chat_decision(
        request_id="req_resume_first",
        messages=messages,
        latest_user_content="continue",
        mode="assist",
        approvals_pre_granted=False,
        session_start_date="2026-03-28",
    )
    second_router.build_chat_decision(
        request_id="req_resume_second",
        messages=messages,
        latest_user_content="continue",
        mode="assist",
        approvals_pre_granted=False,
        session_start_date="2026-03-28",
    )

    assert str(first_engine.calls[0]["system"]) == str(second_engine.calls[0]["system"])
    assert first_engine.calls[0]["tools"] == second_engine.calls[0]["tools"]
    assert any(
        schema["name"] == "mcp__git__commit" and "parameters" in schema
        for schema in first_engine.calls[0]["tools"]
    )
    assert all(schema["name"] != "tool_search" for schema in first_engine.calls[0]["tools"])


def test_router_sorts_tool_schemas_globally_by_name() -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="Sorted.", finish_reason="stop"))]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read a file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        ),
        "mcp__alpha__tool": MCPToolDescriptor(
            name="mcp__alpha__tool",
            description="Alpha tool",
            input_schema={"type": "object"},
            side_effecting=False,
            server_name="alpha",
        ),
        "glob_files": MCPToolDescriptor(
            name="glob_files",
            description="Glob files",
            input_schema={"type": "object"},
            side_effecting=False,
            server_name="tools",
        ),
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_global_tool_order",
        messages=[{"role": "user", "content": "list tools"}],
        latest_user_content="list tools",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "Sorted."
    names = [schema["name"] for schema in engine.calls[0]["tools"]]
    assert names == ["delegate", "glob_files", "mcp__alpha__tool", "read_file"]


def test_router_uses_engine_window_for_auto_deferral_when_config_is_unset(
    monkeypatch,
) -> None:
    class _NativeWindowEngine(_StubEngine):
        def get_model_context_length(self) -> int:
            return 272_000

    captured_windows: list[int] = []
    original = compute_deferral_set

    def _capture_window(*args, **kwargs):
        captured_windows.append(int(kwargs.get("context_window") or 0))
        return original(*args, **kwargs)

    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.compute_deferral_set",
        _capture_window,
    )
    engine = _NativeWindowEngine(
        plans=[_ToolPlan(result=GenerationResult(content="Ready.", finish_reason="stop"))]
    )
    descriptors = {
        "mcp__echo__inspect": MCPToolDescriptor(
            name="mcp__echo__inspect",
            description="Inspect status",
            input_schema={"type": "object"},
            side_effecting=False,
            server_name="echo",
        ),
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="chatgpt",
            model="gpt-5.5",
            context_length=None,
            tool_search_mode="tst-auto",
            feature_flags={FEATURE_TOOL_SEARCH: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    router.build_chat_decision(
        request_id="req_native_window_deferral",
        messages=[{"role": "user", "content": "inspect status"}],
        latest_user_content="inspect status",
        mode="assist",
        approvals_pre_granted=False,
    )

    assert captured_windows == [272_000]


def test_router_pins_current_date_across_loop_iterations(monkeypatch) -> None:
    date_resolution_calls = 0

    def _current_date() -> str:
        nonlocal date_resolution_calls
        date_resolution_calls += 1
        return "2026-07-18"

    monkeypatch.setattr("sidecar.ai.routing.chat_decision.resolve_current_date", _current_date)
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Checking details.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mcp__echo__inspect",
                            arguments={"query": "status"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "mcp__echo__inspect": MCPToolDescriptor(
            name="mcp__echo__inspect",
            description="Inspect status",
            input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
            side_effecting=False,
            server_name="echo",
        ),
    }
    results = {
        "mcp__echo__inspect": MCPToolResult(
            tool_name="mcp__echo__inspect",
            output="status: ok",
            success=True,
        ),
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={FEATURE_PROMPT_CACHE: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )

    decision = router.build_chat_decision(
        request_id="req_pinned_current_date",
        messages=[{"role": "user", "content": "check status"}],
        latest_user_content="check status",
        mode="assist",
        approvals_pre_granted=False,
        session_start_date="2026-03-28",
    )

    assert decision.response_text == "Done."
    assert len(engine.calls) == 2
    first_prompt = str(engine.calls[0]["system"])
    second_prompt = str(engine.calls[1]["system"])
    assert first_prompt == second_prompt
    assert date_resolution_calls == 1
    assert "## Current Date" in first_prompt
    assert "`2026-07-18`" in first_prompt
    assert "`2026-03-28`" not in first_prompt


def test_router_recovers_undeferrals_from_canonical_session_messages() -> None:
    shaped_messages = [{"role": "user", "content": "continue"}]
    canonical_session_messages = [
        {"role": "user", "content": "discover git tools"},
        {
            "role": "tool",
            "kind": "tool_result",
            "content": "Found 1 tool",
            "tool_result": {
                "call_id": "call_tool_search_1",
                "tool_name": "tool_search",
                "output_text": "Found 1 tool(s):\n- mcp__git__commit: Commit changes",
                "metadata": {
                    "kind": TOOL_SEARCH_RESULT_KIND,
                    "discovered_tools": ["mcp__git__commit"],
                    "match_count": 1,
                },
            },
        },
    ]
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read a file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        ),
        "mcp__git__commit": MCPToolDescriptor(
            name="mcp__git__commit",
            description="Commit changes",
            input_schema={"type": "object", "properties": {"message": {"type": "string"}}},
            side_effecting=False,
            server_name="github",
        ),
    }
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="Ready.", finish_reason="stop"))]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={FEATURE_TOOL_SEARCH: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_canonical_undeferral",
        messages=shaped_messages,
        latest_user_content="continue",
        mode="assist",
        approvals_pre_granted=False,
        canonical_session_messages=canonical_session_messages,
    )

    assert decision.response_text == "Ready."
    assert any(
        schema["name"] == "mcp__git__commit" and "parameters" in schema
        for schema in engine.calls[0]["tools"]
    )
    assert all(schema["name"] != "tool_search" for schema in engine.calls[0]["tools"])


def test_router_enforces_per_turn_tool_cap() -> None:
    """When the model requests more tools than the cap, only the first N execute."""
    tool_calls = tuple(
        ToolCallRequest(tool_id=f"read_{i}", arguments={"path": f"file{i}.txt"}) for i in range(5)
    )
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading files.",
                    tool_calls=tool_calls,
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    descriptors = {
        f"read_{i}": MCPToolDescriptor(
            name=f"read_{i}",
            description=f"Read file {i}",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
        for i in range(5)
    }
    results = {
        f"read_{i}": MCPToolResult(
            tool_name=f"read_{i}",
            output=f"content of file{i}.txt",
            success=True,
        )
        for i in range(5)
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1", max_tools_per_turn=3),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )
    decision = router.build_chat_decision(
        request_id="req_cap",
        messages=[{"role": "user", "content": "read all files"}],
        latest_user_content="read all files",
        mode="assist",
        approvals_pre_granted=False,
    )
    assert len(decision.tool_results) == 5
    executed = [r for r in decision.tool_results if r.success]
    truncated = [r for r in decision.tool_results if not r.success]
    assert len(executed) == 3
    assert len(truncated) == 2
    for outcome in truncated:
        assert outcome.error_code == CMP_TOOL_CAP_EXCEEDED
        # H12 wording/shape: "cumulative tool invocation limit (N) reached for
        # this turn." with metadata {"limit": N, "scope": "turn"}.
        assert "cumulative tool invocation limit (3)" in outcome.output
        assert outcome.metadata.get("limit") == 3
        assert outcome.metadata.get("scope") == "turn"


def test_router_allows_all_tools_within_cap() -> None:
    """When tool count is within the cap, all execute normally."""
    tool_calls = tuple(
        ToolCallRequest(tool_id=f"read_{i}", arguments={"path": f"file{i}.txt"}) for i in range(3)
    )
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading.",
                    tool_calls=tool_calls,
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    descriptors = {
        f"read_{i}": MCPToolDescriptor(
            name=f"read_{i}",
            description=f"Read file {i}",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
        for i in range(3)
    }
    results = {
        f"read_{i}": MCPToolResult(
            tool_name=f"read_{i}",
            output=f"content {i}",
            success=True,
        )
        for i in range(3)
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1", max_tools_per_turn=5),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )
    decision = router.build_chat_decision(
        request_id="req_within_cap",
        messages=[{"role": "user", "content": "read files"}],
        latest_user_content="read files",
        mode="assist",
        approvals_pre_granted=False,
    )
    assert len(decision.tool_results) == 3
    assert all(r.success for r in decision.tool_results)


def test_router_recovers_repeated_tool_call_loop_with_cycle_hint() -> None:
    """Three identical tool calls trigger the recoverable cycle guardrail:
    tools are paused, the summarize hint is injected, and the turn ends with
    the model's own graceful summary — NOT the raw guardrail message.

    Regression for the 2026-07-17 owner session where two consecutive
    identical ``read_file`` calls hard-killed a healthy turn with
    "Detected repeated tool calls. Please review and adjust."
    """
    repeated_call = ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"})
    repeated_plan = _ToolPlan(
        result=GenerationResult(
            content="Reading.",
            tool_calls=(repeated_call,),
            finish_reason="tool_calls",
        )
    )
    engine = _StubEngine(
        plans=[
            repeated_plan,
            repeated_plan,
            repeated_plan,
            _ToolPlan(
                result=GenerationResult(
                    content="Summary: the file says hello.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="file content",
            success=True,
        )
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_cycle_tools",
        messages=[{"role": "user", "content": "repeat the same tool"}],
        latest_user_content="repeat the same tool",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=events.append, request_id="req_cycle_tools", max_iterations=6),
    )

    assert decision.response_text == "Summary: the file says hello."
    assert decision.completion_source == "model_winddown"
    assert len(decision.tool_results) == 3
    # Recoverable path: no terminal StopEvent reaches the wire.
    stop_events = [event for event in events if isinstance(event, StopEvent)]
    assert stop_events == []
    # The user sees why tools went quiet via the degradation status line.
    status_deltas = [
        event.delta for event in events if isinstance(event, ThinkingEvent)
    ]
    assert any("Pausing tool use" in delta for delta in status_deltas)
    resets = [event for event in events if isinstance(event, StreamResetEvent)]
    # The preflight hint must not reset already-visible commentary. The next
    # generation is already tools-disabled, so no destructive reset is needed.
    assert [event for event in resets if event.reason == "model_winddown"] == []
    # The wrap-up generation ran with tools paused and the summarize hint
    # injected. Since 2026-08-28 the routing normalizer (engine_messages) runs
    # demote_non_leading_system_messages for EVERY engine, so the hint reaches
    # the engine already demoted to `user` — same position, same content.
    final_call = engine.calls[-1]
    assert final_call.get("tools") in (None, [])
    final_messages = final_call.get("messages") or []
    assert any(
        "summarize" in str(message.get("content", "")).lower()
        for message in final_messages
        if message.get("role") == "user"
    )


def test_router_cycle_hint_tool_pause_survives_ignored_hint() -> None:
    """If the model ignores the cycle hint and emits another tool call, the
    call still dispatches (registry-based), but the per-batch tool-payload
    rebuild must NOT re-advertise the schemas — the pause is for the rest
    of the turn, not one generation."""
    repeated_call = ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"})
    repeated_plan = _ToolPlan(
        result=GenerationResult(
            content="Reading.",
            tool_calls=(repeated_call,),
            finish_reason="tool_calls",
        )
    )
    engine = _StubEngine(
        plans=[
            repeated_plan,
            repeated_plan,
            repeated_plan,
            # Hint injected before this generation; the model ignores it and
            # calls the tool anyway.
            repeated_plan,
            _ToolPlan(
                result=GenerationResult(
                    content="Summary after ignoring the hint.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="file content",
            success=True,
        )
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_cycle_hint_durable",
        messages=[{"role": "user", "content": "repeat the same tool"}],
        latest_user_content="repeat the same tool",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append, request_id="req_cycle_hint_durable", max_iterations=8
        ),
    )

    assert decision.response_text == "Summary after ignoring the hint."
    assert len(decision.tool_results) == 4
    # Every generation after the hint ran without tool schemas: the rebuild
    # at the end of each tool batch must not restore the payload.
    post_hint_calls = engine.calls[3:]
    assert post_hint_calls
    for call in post_hint_calls:
        assert call.get("tools") in (None, [])


def test_router_recovers_repeated_error_output_loop_with_cycle_hint() -> None:
    """Two identical tool errors in a row trigger the recoverable guardrail:
    tools pause, the summarize hint is injected, and the model's own wrap-up
    becomes the response instead of the raw guardrail message."""
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Trying file A.",
                    tool_calls=(ToolCallRequest(tool_id="read_file", arguments={"path": "a.md"}),),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Trying file B.",
                    tool_calls=(ToolCallRequest(tool_id="read_file", arguments={"path": "b.md"}),),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="I could not read either file: permission denied.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="permission denied",
            success=False,
        )
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_cycle_errors",
        messages=[{"role": "user", "content": "keep trying files"}],
        latest_user_content="keep trying files",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=events.append, request_id="req_cycle_errors", max_iterations=4),
    )

    assert decision.response_text == "I could not read either file: permission denied."
    assert decision.completion_source == "model_winddown"
    assert len(decision.tool_results) == 2
    stop_events = [event for event in events if isinstance(event, StopEvent)]
    assert stop_events == []
    status_deltas = [
        event.delta for event in events if isinstance(event, ThinkingEvent)
    ]
    assert any("Pausing tool use" in delta for delta in status_deltas)


def test_router_stops_when_generation_budget_exceeded_post_hoc() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="expensive response",
                    finish_reason="stop",
                    usage=GenerationUsage(
                        input_tokens=10_000,
                        output_tokens=1_000,
                        total_tokens=11_000,
                        provider="openai",
                        model="gpt-4.1",
                        provider_cost_usd=0.011,
                    ),
                )
            ),
        ]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="openai",
            model="gpt-4.1",
            max_budget_usd=0.01,
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_budget_posthoc",
        messages=[{"role": "user", "content": "answer with an expensive completion"}],
        latest_user_content="answer with an expensive completion",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=events.append, request_id="req_budget_posthoc", max_iterations=4),
    )

    assert decision.response_text.startswith("expensive response")
    assert "output above is partial" in decision.response_text
    assert decision.completion_source == "model"
    assert len(engine.calls) == 1
    stop_events = [event for event in events if isinstance(event, StopEvent)]
    assert stop_events
    assert stop_events[-1].code == CMP_LOOP_BUDGET_EXCEEDED


def test_router_stops_when_budget_nearly_exhausted_before_next_generation() -> None:
    repeated_call = ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"})
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Reading once.",
                    tool_calls=(repeated_call,),
                    finish_reason="tool_calls",
                    usage=GenerationUsage(
                        input_tokens=8_000,
                        output_tokens=400,
                        total_tokens=8_400,
                        provider="openai",
                        model="gpt-4.1",
                        provider_cost_usd=0.004,
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="This step should not run.", finish_reason="stop")
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="file content",
            success=True,
        )
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="openai",
            model="gpt-4.1",
            max_budget_usd=0.005,
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_budget_preflight",
        messages=[{"role": "user", "content": "read once then continue"}],
        latest_user_content="read once then continue",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append, request_id="req_budget_preflight", max_iterations=4
        ),
    )

    assert "Budget limit ($0.005) nearly exhausted" in decision.response_text
    assert len(engine.calls) == 1
    assert len(decision.tool_results) == 1
    stop_events = [event for event in events if isinstance(event, StopEvent)]
    assert stop_events
    assert stop_events[-1].code == CMP_LOOP_BUDGET_EXCEEDED


def test_router_retries_retryable_provider_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sidecar.ai.routing.retry.time.sleep", lambda _delay: None)

    class _FlakyEngine(_StubEngine):
        def __init__(self) -> None:
            super().__init__(plans=[])
            self.attempts = 0

        def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
            self.last_kwargs = dict(kwargs)
            self.attempts += 1
            if self.attempts == 1:
                raise ProviderHttpError(
                    provider="openai",
                    status_code=429,
                    code="CMP-CLOUD-1001",
                    message="openai request was rate limited",
                    retryable=True,
                    classification="rate_limit",
                    retry_after_seconds=0.0,
                )
            return GenerationResult(content="retried response", finish_reason="stop")

    engine = _FlakyEngine()
    router = _build_router(
        config=RuntimeConfig(
            engine_type="openai",
            model="gpt-4.1",
            feature_flags={"api_retry": True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    decision = router.build_chat_decision(
        request_id="req_retry",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "retried response"
    assert engine.attempts == 2


def test_router_surfaces_non_retryable_provider_failure_without_retry() -> None:
    class _PermanentFailureEngine(_StubEngine):
        def __init__(self) -> None:
            super().__init__(plans=[])
            self.attempts = 0

        def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
            self.last_kwargs = dict(kwargs)
            self.attempts += 1
            raise ProviderHttpError(
                provider="openai",
                status_code=400,
                code="CMP-CLOUD-1003",
                message="openai request failed with status 400",
                retryable=False,
                classification="invalid_model",
            )

    engine = _PermanentFailureEngine()
    router = _build_router(
        config=RuntimeConfig(
            engine_type="openai",
            model="gpt-4.1",
            feature_flags={"api_retry": True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    with pytest.raises(ToolExecutionFailure) as exc_info:
        router.build_chat_decision(
            request_id="req_perm",
            messages=[{"role": "user", "content": "hello"}],
            latest_user_content="hello",
            mode="chat",
            approvals_pre_granted=True,
        )

    assert engine.attempts == 1
    assert exc_info.value.code == "CMP-LOOP-0003"
    assert exc_info.value.retryable is False


def test_router_keeps_structured_prompt_for_fingerprint_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fingerprint_input: dict[str, Any] = {}

    def capture_fingerprint(
        _kernel: object,
        *,
        request_id: str,
        system_prompt: object,
        tool_schemas: list[dict[str, Any]],
    ) -> None:
        fingerprint_input.update(
            request_id=request_id,
            system_prompt=system_prompt,
            tool_schemas=tool_schemas,
        )

    monkeypatch.setattr(
        generation_runtime._generation_diagnostics,
        "record_request_fingerprint_if_available",
        capture_fingerprint,
    )
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="cached", finish_reason="stop"))]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            feature_flags={FEATURE_PROMPT_CACHE: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    decision = router.build_chat_decision(
        request_id="req_cache_flag",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "cached"
    assert engine.last_kwargs["prompt_cache_enabled"] is True
    assert isinstance(engine.last_kwargs["system"], str)
    assert not isinstance(engine.last_kwargs["system"], StructuredSystemPrompt)
    assert fingerprint_input["request_id"] == "req_cache_flag"
    assert isinstance(fingerprint_input["system_prompt"], StructuredSystemPrompt)
    messages = engine.last_kwargs["messages"]
    assert messages[0]["role"] == "system"
    assert messages[0]["content"].startswith("## Personality\nYour name is Jenny.")
    assert next(message for message in messages if message["role"] != "system")["role"] == "user"


def test_router_normalizes_messages_before_generation() -> None:
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="normalized", finish_reason="stop"))]
    )
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    decision = router.build_chat_decision(
        request_id="req_message_normalization",
        messages=[
            {"role": "user", "content": "start"},
            {"role": "assistant", "content": "<think>private chain</think>"},
            {"role": "assistant", "content": "   "},
            {
                "role": "assistant",
                "content": "<think>tool planning</think>",
                "tool_calls": [
                    {"id": "call_1", "name": "read_file", "arguments": {"path": "README.md"}}
                ],
            },
            {"role": "user", "content": "continue"},
        ],
        latest_user_content="continue",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "normalized"
    prompt_messages = engine.last_kwargs["messages"]
    assistant_messages = [
        message for message in prompt_messages if message.get("role") == "assistant"
    ]

    assert len(assistant_messages) == 1
    assert assistant_messages[0]["content"] == "(no content)"
    assert assistant_messages[0].get("tool_calls")
    assert all(
        "<think>" not in str(message.get("content", "")).lower() for message in prompt_messages
    )
    assert all(str(message.get("content", "")).strip() for message in assistant_messages)


def test_router_invokes_full_compaction_generate_path() -> None:
    compaction_response = (
        "<analysis>\nHistory is mostly tool chatter.\n</analysis>\n\n"
        "<summary>\n"
        "## 1. Intent Summary\nKeep moving.\n"
        "## 2. Key Technical Concepts\nCompaction.\n"
        "## 3. Relevant Files & Code\nrouter.py\n"
        "## 4. Errors & Debugging\n(none)\n"
        "## 5. Problem-Solving Approaches\nSummarize old context.\n"
        '## 6. User Messages\n"Please continue."\n'
        "## 7. Pending Tasks\nFinish the response.\n"
        "## 8. Current Work\nCompacting context.\n"
        "## 9. Next Step\nContinue the answer.\n"
        "</summary>"
    )
    engine = _CompactionStreamEngine(
        plans=[
            _ToolPlan(result=GenerationResult(content=compaction_response, finish_reason="stop")),
            _ToolPlan(result=GenerationResult(content="final answer", finish_reason="stop")),
        ]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="anthropic",
            model="claude-3-7-sonnet-latest",
            context_length=2_400,
            max_tokens=256,
            tools_enabled=False,
            token_budget_reserved_for_summary=256,
            token_budget_warning_ratio=0.2,
            token_budget_auto_compact_ratio=0.3,
            feature_flags={
                FEATURE_TOKEN_BUDGET: True,
                FEATURE_CONTEXT_COMPACTION: True,
            },
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    decision = router.build_chat_decision(
        request_id="req_compaction",
        messages=[
            {"role": "user", "content": "x" * 4_000},
            {"role": "assistant", "content": "tool noise " * 200},
            {"role": "user", "content": "Please continue."},
        ],
        latest_user_content="Please continue.",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "final answer"
    assert len(engine.calls) == 2
    assert engine.calls[0]["prompt"] == ""
    assert engine.calls[0]["tools"] == []
    assert "conversation summariser" in engine.calls[0]["messages"][0]["content"]
    # Compaction preserves the assembled prompt block (leading system run) at
    # the FRONT of the post-compaction request and appends the synthetic
    # summary after it, so persona / tool-use discipline survive a compact.
    # (The primary system prompt itself travels via the `system` kwarg after
    # engine_messages strips it from history.) Since 2026-08-28 the routing
    # normalizer demotes the summary to `user` for EVERY engine (trust
    # boundary: model-generated text never carries system authority), so it
    # survives with the same position and content but role `user`.
    post_compaction = engine.calls[1]
    post_roles = [str(m.get("role")) for m in post_compaction["messages"]]
    assert post_roles[0] == "system"
    summary_indices = [
        index
        for index, message in enumerate(post_compaction["messages"])
        if message.get("role") == "user"
        and "## Compacted Conversation Summary" in str(message.get("content"))
    ]
    assert summary_indices, "the compaction summary must survive into the next request"
    # The prompt block (here: the identity overlay) still precedes the summary
    # instead of being replaced by it.
    assert "## Compacted Conversation Summary" not in str(
        post_compaction["messages"][0].get("content")
    )


def test_router_compacts_mid_turn_after_large_tool_result() -> None:
    compaction_response = (
        "<analysis>Large tool output consumed the remaining context.</analysis>\n"
        "<summary>\n"
        "## 1. Intent Summary\nRead the file and answer.\n"
        "## 2. Key Technical Concepts\nMid-turn compaction.\n"
        "## 3. Relevant Files & Code\nREADME.md\n"
        "## 4. Errors & Debugging\n(none)\n"
        "## 5. Problem-Solving Approaches\nSummarize the tool result.\n"
        '## 6. User Messages\n"Read the file."\n'
        "## 7. Pending Tasks\nReturn the answer.\n"
        "## 8. Current Work\nTool result was read.\n"
        "## 9. Next Step\nAnswer.\n"
        "</summary>"
    )
    engine = _CompactionStreamEngine(
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
            _ToolPlan(result=GenerationResult(content=compaction_response, finish_reason="stop")),
            _ToolPlan(result=GenerationResult(content="final answer", finish_reason="stop")),
        ]
    )
    descriptor = MCPToolDescriptor(
        name="read_file",
        description="Read file",
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        side_effecting=False,
        server_name="tools",
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="openai",
            model="gpt-4.1",
            context_length=12_000,
            max_tokens=256,
            token_budget_reserved_for_summary=256,
            token_budget_warning_ratio=0.2,
            token_budget_auto_compact_ratio=0.3,
            feature_flags={
                FEATURE_TOKEN_BUDGET: True,
                FEATURE_CONTEXT_COMPACTION: True,
            },
        ),
        engine=engine,
        mcp_client=_StubMCPClient(
            {"read_file": descriptor},
            results={
                "read_file": MCPToolResult(
                    tool_name="read_file",
                    output="large tool output " * 1_000,
                    success=True,
                    content_type="text",
                    ui_payload=None,
                )
            },
        ),
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_mid_turn_compaction",
        messages=[
            {"role": "user", "content": "Earlier request details. " * 80},
            {"role": "assistant", "content": "Earlier answer details. " * 80},
            {"role": "user", "content": "Read the file."},
        ],
        latest_user_content="Read the file.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_mid_turn_compaction",
            max_iterations=4,
        ),
    )

    assert decision.response_text == "final answer"
    assert len(engine.calls) == 3
    assert engine.calls[1]["tools"] == []
    assert "conversation summariser" in engine.calls[1]["messages"][0]["content"]
    assert any(isinstance(event, ContextCompactedEvent) for event in events)
    assert any(
        "## Compacted Conversation Summary" in str(message.get("content"))
        for message in engine.calls[2]["messages"]
    )


def test_router_stops_when_compaction_cannot_free_enough_context() -> None:
    engine = _CompactionStreamEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(content="malformed compaction output", finish_reason="stop")
            ),
        ]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="openai",
            model="gpt-4.1",
            # Degenerate budget: a 1024-token window where the minimum output
            # reservation floor (1024) alone consumes the whole context, so
            # effective_context is 0 (see token_budget.TokenBudget). There is no
            # room to compact into, so even microcompaction cannot free enough
            # context and the router must stop with a terminal advisory.
            context_length=1_024,
            max_tokens=1_024,
            tools_enabled=False,
            feature_flags={
                FEATURE_TOKEN_BUDGET: True,
                FEATURE_CONTEXT_COMPACTION: True,
            },
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    decision = router.build_chat_decision(
        request_id="req_compaction_terminal",
        messages=[
            {"role": "user", "content": "old " + "x" * 20_000},
            {"role": "assistant", "content": "old " + "y" * 20_000},
            {"role": "user", "content": "current " + "z" * 20_000},
        ],
        latest_user_content="current " + "z" * 20_000,
        mode="chat",
        approvals_pre_granted=True,
    )

    assert "too long to continue" in decision.response_text.lower()
    assert decision.terminal_error_code == CMP_CTX_BUDGET_EXHAUSTED
    assert decision.terminal_error_retryable is False
    assert len(engine.calls) == 1
    assert engine.calls[0]["prompt"] == ""


def test_router_budget_tracking_uses_current_context_not_cumulative_usage() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Read once.",
                    tool_calls=(
                        ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"}),
                    ),
                    finish_reason="tool_calls",
                    usage=GenerationUsage(
                        input_tokens=50_000,
                        output_tokens=600,
                        total_tokens=50_600,
                        provider="openai",
                        model="gpt-4.1",
                    ),
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Read twice.",
                    tool_calls=(
                        ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"}),
                    ),
                    finish_reason="tool_calls",
                    usage=GenerationUsage(
                        input_tokens=50_000,
                        output_tokens=600,
                        total_tokens=50_600,
                        provider="openai",
                        model="gpt-4.1",
                    ),
                )
            ),
            _ToolPlan(result=GenerationResult(content="finished", finish_reason="stop")),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="small result",
            success=True,
            content_type="text",
            ui_payload=None,
        )
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="openai",
            model="gpt-4.1",
            context_length=100_000,
            max_tokens=10_000,
            feature_flags={FEATURE_TOKEN_BUDGET: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )

    decision = router.build_chat_decision(
        request_id="req_budget_context",
        messages=[{"role": "user", "content": "Read the README twice, then finish."}],
        latest_user_content="Read the README twice, then finish.",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "finished"
    assert len(decision.tool_results) == 2


def test_router_budget_tracking_ignores_diminishing_returns_when_usage_missing() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Read once.",
                    tool_calls=(
                        ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"}),
                    ),
                    finish_reason="tool_calls",
                    usage=None,
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Read twice.",
                    tool_calls=(
                        ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"}),
                    ),
                    finish_reason="tool_calls",
                    usage=None,
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Read three times.",
                    tool_calls=(
                        ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"}),
                    ),
                    finish_reason="tool_calls",
                    usage=None,
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Read four times.",
                    tool_calls=(
                        ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"}),
                    ),
                    finish_reason="tool_calls",
                    usage=None,
                )
            ),
            _ToolPlan(
                result=GenerationResult(content="finished", finish_reason="stop", usage=None)
            ),
        ]
    )
    descriptors = {
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read file",
            input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "read_file": MCPToolResult(
            tool_name="read_file",
            output="small result",
            success=True,
            content_type="text",
            ui_payload=None,
        )
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            context_length=100_000,
            max_tokens=10_000,
            feature_flags={FEATURE_TOKEN_BUDGET: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )

    decision = router.build_chat_decision(
        request_id="req_budget_missing_usage",
        messages=[{"role": "user", "content": "Read the README four times, then finish."}],
        latest_user_content="Read the README four times, then finish.",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "finished"
    assert len(decision.tool_results) == 4
    assert len(engine.calls) == 5


# -- Self-evaluation retry (tool nudge) tests ------------------------------


class TestShouldNudgeToolUse:
    """Unit tests for _should_nudge_tool_use heuristics."""

    TOOL_PAYLOAD = [{"name": "glob_files"}, {"name": "read_file"}]

    def test_garbled_response_triggers_nudge(self) -> None:
        """Empty sanitized text from non-empty raw text → nudge."""
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text="",
                raw_text="<|tool_response><eos><eos>",
                tool_payload=self.TOOL_PAYLOAD,
            )
            is True
        )

    def test_raw_text_with_control_tokens_triggers_nudge(self) -> None:
        """Control tokens in raw text trigger nudge even if sanitized text is non-empty."""
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text="OK",
                raw_text="OK<|tool_response>some junk",
                tool_payload=self.TOOL_PAYLOAD,
            )
            is True
        )

    def test_prose_tool_mention_triggers_nudge(self) -> None:
        """Model describes tool usage instead of calling it."""
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text="Let me use the glob_files tool to list the files for you.",
                raw_text="Let me use the glob_files tool to list the files for you.",
                tool_payload=self.TOOL_PAYLOAD,
            )
            is True
        )

    def test_unavailable_tool_alias_triggers_nudge(self) -> None:
        """Unavailable tool mentions still count as fake tool execution prose."""
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text="Let me use web search to check the latest weather.",
                raw_text="Let me use web search to check the latest weather.",
                tool_payload=self.TOOL_PAYLOAD,
                tool_statuses=(
                    RuntimeToolStatus(
                        name="web_search",
                        display_name="Web Search",
                        available=False,
                        reason="config disabled",
                    ),
                ),
            )
            is True
        )

    def test_clean_response_without_tool_mention_no_nudge(self) -> None:
        """Normal conversational response → no nudge."""
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text="Hello! How can I help you today?",
                raw_text="Hello! How can I help you today?",
                tool_payload=self.TOOL_PAYLOAD,
            )
            is False
        )

    def test_incidental_tool_name_no_nudge(self) -> None:
        """Tool name appears but not in a descriptive context → no nudge."""
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text="The glob_files results showed 3 Python files.",
                raw_text="The glob_files results showed 3 Python files.",
                tool_payload=self.TOOL_PAYLOAD,
            )
            is False
        )

    def test_short_tool_alias_embedded_inside_word_no_nudge(self) -> None:
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text="I will digitize the notes and send a summary.",
                raw_text="I will digitize the notes and send a summary.",
                tool_payload=[],
                tool_statuses=(
                    RuntimeToolStatus(
                        name="git_status",
                        display_name="Git Status",
                        available=True,
                        tool_family="git",
                    ),
                ),
            )
            is False
        )

    def test_empty_tool_payload_no_nudge(self) -> None:
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text="",
                raw_text="<eos>",
                tool_payload=[],
            )
            is False
        )

    def test_short_clean_response_no_nudge(self) -> None:
        """A legitimately short answer that survives sanitization intact must NOT nudge."""
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text="Ready.",
                raw_text="Ready.",
                tool_payload=self.TOOL_PAYLOAD,
            )
            is False
        )

    def test_short_response_identical_lengths_no_nudge(self) -> None:
        """Even a 1-char answer must not nudge when raw == sanitized."""
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text="K",
                raw_text="K",
                tool_payload=self.TOOL_PAYLOAD,
            )
            is False
        )

    def test_long_truncated_response_no_nudge(self) -> None:
        """A long reply truncated by sanitize_assistant_output must NOT nudge."""
        long_raw = "a" * 50_000
        truncated = "a" * 16_000  # post-truncation
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text=truncated,
                raw_text=long_raw,
                tool_payload=self.TOOL_PAYLOAD,
            )
            is False
        )

    # -- Prose narration must not fire on ordinary conversation ------------

    ITER1_TOOL_PAYLOAD = [
        {"name": name}
        for name in (
            "check_background_job",
            "check_monitor",
            "create_artifact",
            "delete_file",
            "edit_file",
            "fetch_url",
            "git_diff",
            "git_log",
            "git_show",
            "git_status",
            "glob_files",
            "grep_search",
            "home",
            "jenny_status",
            "list_dir",
            "load_skill",
            "lsp",
            "mermaid_generate",
            "monitor",
            "python_execute",
            "read_file",
            "run_command",
            "run_temp_script",
            "stop_background_job",
            "todo_read",
            "todo_write",
            "web_search",
            "workspace_change_baseline",
            "workspace_change_delta",
            "workspace_manifest_read",
            "workspace_present",
            "write_file",
        )
    ]

    ITER1_TEXT = (
        "Heyy! Nice to see you, dev mode is such a fun place to poke around. \U0001f605\n"
        "Alright, real talk tho — I can't just dump the whole system prompt out to "
        "you. Even in dev mode, the harness treats it as internal config, not something "
        "I echo back verbatim. Fair, it's the same reason I'd never hand my own "
        '"settings" file to a random website.\n'
        "What I *can* do, which is way more useful for your tuning purposes:\n\n"
        "- **Describe** what's in there at a structural level (personality block, tool "
        "inventory, workspace manifest, skill overlays, runtime identity)\n"
        "- **Test specific behaviors** — give me a prompt that's supposed to trigger "
        "something and I'll tell you what actually happened\n"
        "- **Check for gaps or inconsistencies** you're worried about (\"does it seem "
        'like it\'s going to leak X?" "is tone instruction actually landing?")\n'
        "- Point out anything that looks like it could be tightened up\n\n"
        "So: what's the thing you're actually trying to tweak? That's where I can "
        "genuinely help. \U0001f6e0️"
    )

    def test_conversational_dev_mode_reply_no_nudge(self) -> None:
        """The real iter-1 incident text must not be classified as tool narration."""
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text=self.ITER1_TEXT,
                raw_text=self.ITER1_TEXT,
                tool_payload=self.ITER1_TOOL_PAYLOAD,
                tool_statuses=(
                    RuntimeToolStatus(
                        name="jenny_status",
                        display_name="Jenny Status",
                        available=True,
                        tool_family="runtime",
                    ),
                ),
            )
            is False
        )

    def test_everyday_home_small_talk_no_nudge(self) -> None:
        """A single-word tool id used as an English word must not nudge."""
        text = "I'll be home around six, want me to bring anything?"
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text=text,
                raw_text=text,
                tool_payload=[{"name": "home"}, {"name": "read_file"}],
            )
            is False
        )

    def test_everyday_calendar_small_talk_no_nudge(self) -> None:
        """Family aliases like 'calendar' are plain English and must not nudge."""
        text = "I can't find my calendar invite, did you get it?"
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text=text,
                raw_text=text,
                tool_payload=[{"name": "home"}, {"name": "read_file"}],
                tool_statuses=(
                    RuntimeToolStatus(
                        name="home",
                        display_name="Home",
                        available=True,
                        tool_family="home",
                    ),
                ),
            )
            is False
        )

    def test_descriptive_phrase_in_previous_sentence_no_nudge(self) -> None:
        """The descriptive phrase must share a sentence with the tool mention."""
        text = "I'll handle that. The glob_files tool returned nothing."
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text=text,
                raw_text=text,
                tool_payload=self.TOOL_PAYLOAD,
            )
            is False
        )

    def test_backticked_single_word_tool_id_triggers_nudge(self) -> None:
        """A single-word tool id quoted as a code token is still narration."""
        text = "Let me use the `home` tool to check today's agenda."
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text=text,
                raw_text=text,
                tool_payload=[{"name": "home"}, {"name": "read_file"}],
            )
            is True
        )

    def test_tool_named_after_an_abbreviation_still_nudges(self) -> None:
        """A dot inside "e.g." is not a sentence boundary.

        Splitting on it would orphan the tool mention into a span with no
        descriptive phrase, and the narration would go unnoticed."""
        text = "I would use e.g. glob_files here."
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text=text,
                raw_text=text,
                tool_payload=self.TOOL_PAYLOAD,
            )
            is True
        )

    def test_version_number_dot_does_not_orphan_a_later_tool_mention(self) -> None:
        """A version string splits the text, but the narration lives in the
        sentence AFTER it and must still be seen."""
        text = "Use v1.2 of it. I'll run grep_search now."
        assert (
            ChatRouter._should_nudge_tool_use(
                sanitized_text=text,
                raw_text=text,
                tool_payload=[*self.TOOL_PAYLOAD, {"name": "grep_search"}],
            )
            is True
        )

    def test_explicit_available_tool_request_selects_only_requested_tool(self) -> None:
        payload = [
            {"name": "delegate"},
            {"name": "read_file"},
        ]
        prompt = "Use `delegate` once for these independent investigations."

        selected = ChatRouter._explicitly_requested_tool_payload(prompt, payload)

        assert [tool["name"] for tool in selected] == ["delegate"]

    @pytest.mark.parametrize(
        "rule",
        [
            (
                "Evaluation routing rule: If `delegate` is available, use it once "
                "with exactly two independent read-only tasks. Otherwise solve directly. "
                "The parent must synthesize the final answer and cite current source evidence."
            ),
            (
                "Evaluation routing rule: If `delegate` is available, use it once "
                "with exactly three independent read-only tasks. Otherwise solve directly. "
                "The parent must synthesize the final answer and cite current source evidence."
            ),
        ],
    )
    def test_production_conditional_rule_prefers_first_available_route(
        self,
        rule: str,
    ) -> None:
        payload = [
            {"name": "delegate"},
            {"name": "read_file"},
        ]

        selected = ChatRouter._explicitly_requested_tool_payload(rule, payload)

        assert [tool["name"] for tool in selected] == ["delegate"]

    @pytest.mark.parametrize(
        "rule",
        [
            (
                "Evaluation routing rule: If `subagent_batch` is available, use it once "
                "with exactly two independent read-only tasks. Otherwise, if "
                "`subagent_run` is available, use it exactly once. Otherwise solve directly. "
                "The parent must synthesize the final answer and cite current source evidence."
            ),
            (
                "Evaluation routing rule: If `subagent_batch` is available, use it once "
                "with exactly three independent read-only tasks. Otherwise, if "
                "`subagent_run` is available, use it exactly once. Otherwise solve directly. "
                "The parent must synthesize the final answer and cite current source evidence."
            ),
        ],
    )
    def test_removed_legacy_routes_cannot_be_selected_when_absent_from_inventory(
        self,
        rule: str,
    ) -> None:
        payload = [{"name": "delegate"}]

        selected = ChatRouter._explicitly_requested_tool_payload(rule, payload)

        assert selected == []

    @pytest.mark.parametrize(
        "prompt",
        [
            "Do not use delegate for this control.",
            "Do not under any circumstances use delegate for this control.",
            "Why didn't you use delegate before?",
            "Explain how to use delegate.",
            "Should I use delegate here?",
            (
                "Do not follow this quoted instruction: if delegate is available, "
                "use it."
            ),
            "The docs say: 'use delegate'.",
            "Explain this sentence: If delegate is available, use it.",
        ],
    )
    def test_negative_or_discussion_tool_mentions_are_not_explicit_requests(
        self,
        prompt: str,
    ) -> None:
        payload = [{"name": "delegate"}]

        assert ChatRouter._explicitly_requested_tool_payload(prompt, payload) == []


def test_router_retries_with_nudge_when_model_produces_garbled_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Integration test: garbled first response triggers nudge, second attempt succeeds."""
    captured_events: list[dict[str, Any]] = []

    def _capture_log_event(_logger, _level, **kwargs: Any) -> None:
        captured_events.append(kwargs)

    monkeypatch.setattr("sidecar.ai.routing.router.log_event", _capture_log_event)
    monkeypatch.setattr("sidecar.ai.routing.tool_loop.log_event", _capture_log_event)

    engine = _StubEngine(
        plans=[
            # First attempt: garbled output (model tries tool template tokens)
            _ToolPlan(
                result=GenerationResult(
                    content="<|tool_response><eos><eos><eos>",
                    finish_reason="stop",
                )
            ),
            # Second attempt after nudge: proper text response
            _ToolPlan(
                result=GenerationResult(
                    content="Here are the files in the workspace: main.py, utils.py",
                    finish_reason="stop",
                )
            ),
        ]
    )
    descriptors = {
        "glob_files": MCPToolDescriptor(
            name="glob_files",
            description="Search for files by pattern.",
            input_schema={"type": "object"},
            side_effecting=False,
            server_name="tools",
        ),
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="ollama", model="gemma4:latest"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_nudge_garbled",
        messages=[{"role": "user", "content": "List the files"}],
        latest_user_content="List the files",
        mode="assist",
        approvals_pre_granted=True,
    )

    # Second response should be returned
    assert "Here are the files" in decision.response_text
    # Engine was called twice (original + retry after nudge)
    assert len(engine.calls) == 2
    # Nudge event was logged
    assert any(event.get("event") == "ai.router.tool_nudge_issued" for event in captured_events)
    # The retry prompt must not contain raw control tokens — verify the
    # messages sent to the second engine call have no garbled content.
    retry_messages = engine.calls[1].get("messages", [])
    for msg in retry_messages:
        assert "<|tool_response>" not in str(msg.get("content", "")), (
            "Raw control tokens leaked into retry prompt"
        )


def test_router_retries_when_explicit_available_tool_request_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_events: list[dict[str, Any]] = []

    def _capture_log_event(_logger, _level, **kwargs: Any) -> None:
        captured_events.append(kwargs)

    monkeypatch.setattr("sidecar.ai.routing.router.log_event", _capture_log_event)
    monkeypatch.setattr("sidecar.ai.routing.tool_loop.log_event", _capture_log_event)
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="I can answer directly without calling anything.",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Searching.",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="glob_files",
                            arguments={"pattern": "**/*.md"},
                        ),
                    ),
                    finish_reason="tool_calls",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Search complete.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "glob_files": MCPToolDescriptor(
            name="glob_files",
            description="Search files by glob.",
            input_schema={
                "type": "object",
                "properties": {"pattern": {"type": "string"}},
                "required": ["pattern"],
            },
            side_effecting=False,
            server_name="tools",
        )
    }
    results = {
        "glob_files": MCPToolResult(
            tool_name="glob_files",
            output="README.md",
            success=True,
            error_code=None,
            metadata={"match_count": 1},
        )
    }
    client = _StubMCPClient(descriptors, results=results)
    router = _build_router(
        config=RuntimeConfig(engine_type="ollama", model="gemma4:latest"),
        engine=engine,
        mcp_client=client,
    )

    decision = router.build_chat_decision(
        request_id="req_explicit_tool_nudge",
        messages=[{"role": "user", "content": "Please use glob_files to find Markdown."}],
        latest_user_content="Please use glob_files to find Markdown.",
        mode="assist",
        approvals_pre_granted=False,
    )

    assert decision.response_text == "Search complete."
    assert client.last_execute == ("glob_files", {"pattern": "**/*.md"})
    assert len(engine.calls) == 3
    issued = [
        event for event in captured_events if event.get("event") == "ai.router.tool_nudge_issued"
    ]
    assert len(issued) == 1
    assert issued[0]["data"] == {
        "iteration": 1,
        "trigger": "explicit_tool_request",
        "requested_tools": ["glob_files"],
    }
    retry_messages = engine.calls[1].get("messages", [])
    assert any(
        "explicitly required an available tool" in str(message.get("content", ""))
        for message in retry_messages
    )


def test_explicit_tool_request_without_retry_capacity_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_events: list[dict[str, Any]] = []

    def _capture_log_event(_logger, _level, **kwargs: Any) -> None:
        captured_events.append(kwargs)

    monkeypatch.setattr("sidecar.ai.routing.router.log_event", _capture_log_event)
    monkeypatch.setattr("sidecar.ai.routing.tool_loop.log_event", _capture_log_event)
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="I can answer directly without calling anything.",
                    finish_reason="stop",
                )
            )
        ]
    )
    descriptors = {
        "glob_files": MCPToolDescriptor(
            name="glob_files",
            description="Search files by glob.",
            input_schema={"type": "object"},
            side_effecting=False,
            server_name="tools",
        )
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="ollama", model="gemma4:latest"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_explicit_tool_no_capacity",
        messages=[{"role": "user", "content": "Please use glob_files."}],
        latest_user_content="Please use glob_files.",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(request_id="req_explicit_tool_no_capacity", max_iterations=1),
    )

    assert "wasn't able to complete" in decision.response_text
    assert len(engine.calls) == 1
    assert not any(
        event.get("event") == "ai.router.tool_nudge_issued" for event in captured_events
    )
    assert any(
        event.get("event") == "ai.router.tool_nudge_skipped_no_capacity"
        for event in captured_events
    )


def test_router_returns_fallback_after_nudge_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After a nudge, if the response is still garbled, return a safe fallback
    instead of burning remaining loop iterations."""
    captured_events: list[dict[str, Any]] = []

    def _capture_log_event(_logger, _level, **kwargs: Any) -> None:
        captured_events.append(kwargs)

    monkeypatch.setattr("sidecar.ai.routing.router.log_event", _capture_log_event)
    monkeypatch.setattr("sidecar.ai.routing.tool_loop.log_event", _capture_log_event)

    engine = _StubEngine(
        plans=[
            # First attempt: garbled → triggers nudge
            _ToolPlan(
                result=GenerationResult(
                    content="<|tool_response><eos>",
                    finish_reason="stop",
                )
            ),
            # Second attempt (after nudge): still garbled → fallback returned
            _ToolPlan(
                result=GenerationResult(
                    content="<|tool_response><eos>",
                    finish_reason="stop",
                )
            ),
        ]
    )
    descriptors = {
        "glob_files": MCPToolDescriptor(
            name="glob_files",
            description="Search for files by pattern.",
            input_schema={"type": "object"},
            side_effecting=False,
            server_name="tools",
        ),
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="ollama", model="gemma4:latest"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_nudge_fallback",
        messages=[{"role": "user", "content": "List the files"}],
        latest_user_content="List the files",
        mode="assist",
        approvals_pre_granted=True,
    )

    # Only one nudge event should have been logged
    nudge_events = [e for e in captured_events if e.get("event") == "ai.router.tool_nudge_issued"]
    assert len(nudge_events) == 1
    # Engine called exactly twice: original + one retry — no loop exhaustion
    assert len(engine.calls) == 2
    # Fallback message returned instead of CMP-LOOP-0001
    assert "wasn't able to complete" in decision.response_text


def test_router_returns_fallback_after_nudge_non_empty_garbage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Retry responses with leaked STATUS text or fake tool prose still fail closed."""
    captured_events: list[dict[str, Any]] = []

    def _capture_log_event(_logger, _level, **kwargs: Any) -> None:
        captured_events.append(kwargs)

    monkeypatch.setattr("sidecar.ai.routing.router.log_event", _capture_log_event)
    monkeypatch.setattr("sidecar.ai.routing.tool_loop.log_event", _capture_log_event)

    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="<|tool_response><eos>",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="{STATUS: Listing files} Let me use glob files to inspect the workspace.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    descriptors = {
        "glob_files": MCPToolDescriptor(
            name="glob_files",
            description="Search for files by pattern.",
            input_schema={"type": "object"},
            side_effecting=False,
            server_name="tools",
        ),
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="ollama", model="gemma4:latest"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_nudge_non_empty_garbage",
        messages=[{"role": "user", "content": "List the files"}],
        latest_user_content="List the files",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert len(engine.calls) == 2
    assert "wasn't able to complete" in decision.response_text
    assert any(event.get("event") == "ai.router.tool_nudge_fallback" for event in captured_events)


def test_router_current_info_request_resets_pseudo_search_before_exact_web_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_events: list[dict[str, Any]] = []
    loop_events: list[object] = []

    def _capture_log_event(_logger, _level, **kwargs: Any) -> None:
        captured_events.append(kwargs)

    monkeypatch.setattr("sidecar.ai.routing.router.log_event", _capture_log_event)
    monkeypatch.setattr("sidecar.ai.routing.tool_loop.log_event", _capture_log_event)

    engine = _CompactionStreamEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Let me use web search to check the weather in Nashville.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="gemma4:latest",
            tools_web_enabled=False,
        ),
        engine=engine,
        mcp_client=_StubMCPClient(
            {
                "read_file": MCPToolDescriptor(
                    name="read_file",
                    description="Read a file from the workspace.",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
                "web_search": MCPToolDescriptor(
                    name="web_search",
                    description="Search the web.",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                ),
            }
        ),
    )

    decision = router.build_chat_decision(
        request_id="req_current_info_exact_reason",
        messages=[{"role": "user", "content": "What is the weather in Nashville today?"}],
        latest_user_content="What is the weather in Nashville today?",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=loop_events.append,
            request_id="req_current_info_exact_reason",
            streaming=True,
        ),
    )

    assert "web_search is unavailable for this request: config disabled" in decision.response_text
    assert "live web lookup" in decision.response_text
    assert decision.completion_source == "deterministic_tool_fallback"
    assert "chat.token" not in decision.streamed_event_types
    assert any(isinstance(event, TokenDeltaEvent) for event in loop_events)
    assert [
        event.reason for event in loop_events if isinstance(event, StreamResetEvent)
    ] == ["deterministic_replacement"]
    assert len(engine.calls) == 1
    assert any(
        event.get("event") == "ai.router.current_info_unavailable_fallback"
        for event in captured_events
    )


def test_router_nudges_mermaid_prose_when_executable_tool_is_available() -> None:
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        "I use Mermaid syntax to create structured diagrams. "
                        "Here is a diagram I would make."
                    ),
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Diagram ready.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="qwen3.6:35b-a3b",
            tools_mermaid_enabled=True,
        ),
        engine=engine,
        mcp_client=_StubMCPClient(
            {
                "mermaid_generate": MCPToolDescriptor(
                    name="mermaid_generate",
                    description="Render a Mermaid diagram.",
                    input_schema={
                        "type": "object",
                        "properties": {"prompt": {"type": "string"}},
                        "required": ["prompt"],
                    },
                    side_effecting=False,
                    server_name="tools",
                ),
            }
        ),
    )

    decision = router.build_chat_decision(
        request_id="req_mermaid_fake_tool_nudge",
        messages=[{"role": "user", "content": "Please demonstrate the Mermaid tool"}],
        latest_user_content="Please demonstrate the Mermaid tool",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "Diagram ready."
    assert len(engine.calls) == 2
    assert "mermaid_generate" in engine.calls[1]["messages"][-1]["content"]


def test_router_nudge_example_is_never_a_repo_mutating_tool() -> None:
    """Garbled output names no tool, so the nudge falls back to the payload.

    The worked example must still be a read-only tool: the incident was a 27B
    model copying a mutating example back verbatim, placeholder arguments included.
    """
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="<|tool_response><eos><eos>",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(result=GenerationResult(content="All set.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "edit_file": MCPToolDescriptor(
            name="edit_file",
            description="Edit a file in the repository.",
            input_schema={
                "type": "object",
                "properties": {"file_path": {"type": "string"}},
                "required": ["file_path"],
            },
            side_effecting=True,
            server_name="tools",
        ),
        "read_file": MCPToolDescriptor(
            name="read_file",
            description="Read a file.",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            side_effecting=False,
            server_name="tools",
        ),
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="gemma4:latest",
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_nudge_example_read_only",
        messages=[{"role": "user", "content": "Fix the typo"}],
        latest_user_content="Fix the typo",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "All set."
    nudge = str(engine.calls[1]["messages"][-1]["content"])
    assert "`edit_file`" in nudge, "the mutating tool must really be in the payload"
    assert '"name": "read_file"' in nudge
    assert '"name": "edit_file"' not in nudge
    assert '"file_path": "<string>"' not in nudge
    assert (
        "If no tool is actually needed to answer, reply to the user directly without calling one."
    ) in nudge


def test_router_nudge_example_follows_the_narrated_tool() -> None:
    """Prose narration names the tool, so the nudge demonstrates that one."""
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Let me use grep_search to find that string for you.",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(result=GenerationResult(content="Found it.", finish_reason="stop")),
        ]
    )
    descriptors = {
        "edit_file": MCPToolDescriptor(
            name="edit_file",
            description="Edit a file in the repository.",
            input_schema={
                "type": "object",
                "properties": {"file_path": {"type": "string"}},
                "required": ["file_path"],
            },
            side_effecting=True,
            server_name="tools",
        ),
        "grep_search": MCPToolDescriptor(
            name="grep_search",
            description="Search file contents.",
            input_schema={
                "type": "object",
                "properties": {"pattern": {"type": "string"}},
                "required": ["pattern"],
            },
            side_effecting=False,
            server_name="tools",
        ),
    }
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="gemma4:latest",
        ),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_nudge_example_narrated",
        messages=[{"role": "user", "content": "Where is FOO defined?"}],
        latest_user_content="Where is FOO defined?",
        mode="assist",
        approvals_pre_granted=True,
    )

    assert decision.response_text == "Found it."
    nudge = str(engine.calls[1]["messages"][-1]["content"])
    assert '"name": "grep_search", "arguments": {"pattern": "<string>"}' in nudge
    # The payload narrowed to the narrated tool, so edit_file is not even listed.
    assert "edit_file" not in nudge


def test_router_does_not_nudge_when_tools_already_executed() -> None:
    """No nudge if a prior iteration already used tools successfully."""
    engine = _StubEngine(
        plans=[
            # First: model calls a tool
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    tool_calls=(ToolCallRequest(tool_id="glob_files", arguments={"pattern": "*"}),),
                    finish_reason="tool_calls",
                )
            ),
            # Second: model describes tool in text (post-tool summary)
            _ToolPlan(
                result=GenerationResult(
                    content="I used glob_files and found: main.py",
                    finish_reason="stop",
                )
            ),
        ]
    )
    descriptors = {
        "glob_files": MCPToolDescriptor(
            name="glob_files",
            description="Search for files by pattern.",
            input_schema={"type": "object", "properties": {"pattern": {"type": "string"}}},
            side_effecting=False,
            server_name="tools",
        ),
    }
    results = {
        "glob_files": MCPToolResult(
            tool_name="glob_files",
            output="main.py\nutils.py",
            success=True,
        ),
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="ollama", model="gemma4:latest"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors, results=results),
    )

    decision = router.build_chat_decision(
        request_id="req_no_nudge_post_tool",
        messages=[{"role": "user", "content": "List the files"}],
        latest_user_content="List the files",
        mode="assist",
        approvals_pre_granted=True,
    )

    # Response should be the post-tool summary without re-nudging
    assert "I used glob_files" in decision.response_text
    # No extra retry beyond the normal tool loop (2 calls: tool call + summary)
    assert len(engine.calls) == 2


def test_router_does_not_nudge_for_non_ollama_engine() -> None:
    """Nudge is scoped to Ollama; other engines should never trigger it."""
    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="<|tool_response><eos><eos>",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="second call",
                    finish_reason="stop",
                )
            ),
        ]
    )
    descriptors = {
        "glob_files": MCPToolDescriptor(
            name="glob_files",
            description="Search for files by pattern.",
            input_schema={"type": "object"},
            side_effecting=False,
            server_name="tools",
        ),
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="openai", model="gpt-4o"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_no_nudge_openai",
        messages=[{"role": "user", "content": "List the files"}],
        latest_user_content="List the files",
        mode="assist",
        approvals_pre_granted=True,
    )

    # Garbled content is sanitized to empty; loop continues naturally but
    # no nudge is injected.  Second call produces "second call".
    assert decision.response_text == "second call"
    # Exactly 2 calls, no nudge-driven retry
    assert len(engine.calls) == 2


def test_router_does_not_nudge_in_autonomous_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Nudge is scoped to assist mode; autonomous must not trigger it."""
    captured_events: list[dict[str, Any]] = []

    def _capture_log_event(_logger, _level, **kwargs: Any) -> None:
        captured_events.append(kwargs)

    monkeypatch.setattr("sidecar.ai.routing.router.log_event", _capture_log_event)
    monkeypatch.setattr("sidecar.ai.routing.tool_loop.log_event", _capture_log_event)

    engine = _StubEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="<|tool_response><eos>",
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="autonomous fallback",
                    finish_reason="stop",
                )
            ),
        ]
    )
    descriptors = {
        "glob_files": MCPToolDescriptor(
            name="glob_files",
            description="Search for files by pattern.",
            input_schema={"type": "object"},
            side_effecting=False,
            server_name="tools",
        ),
    }
    router = _build_router(
        config=RuntimeConfig(engine_type="ollama", model="gemma4:latest"),
        engine=engine,
        mcp_client=_StubMCPClient(descriptors),
    )

    decision = router.build_chat_decision(
        request_id="req_no_nudge_autonomous",
        messages=[{"role": "user", "content": "List the files"}],
        latest_user_content="List the files",
        mode="autonomous",
        approvals_pre_granted=True,
    )

    # No nudge event — loop continues naturally past empty sanitized text
    assert not any(event.get("event") == "ai.router.tool_nudge_issued" for event in captured_events)
    assert decision.response_text == "autonomous fallback"


# ---------------------------------------------------------------------------
# GAP 2 — In-loop model fallback
# ---------------------------------------------------------------------------


class _FailingEngine(_StubEngine):
    """Engine that always raises on generate_with_tools."""

    def __init__(
        self,
        error: Exception,
    ) -> None:
        super().__init__(plans=[])
        self._error = error

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.last_kwargs = dict(kwargs)
        raise self._error


class _FallbackStubEngine(_StubEngine):
    """Engine returned by the monkeypatched create_engine for fallback."""

    def __init__(self, content: str = "fallback-response") -> None:
        super().__init__(
            plans=[
                _ToolPlan(result=GenerationResult(content=content, finish_reason="stop")),
            ]
        )

    def stream_with_tools(self, **kwargs: Any):
        # Fallback generation runs on the canonical stream path; serve the
        # plan queue there. Scoped to this subclass — putting a stream path on
        # _StubEngine itself would reroute every non-fallback test.
        result = self.generate_with_tools(**kwargs)
        if result.content:
            yield StreamingEvent(kind="content", text=str(result.content))
        return result


def _make_provider_error(
    classification: str,
    status_code: int = 500,
    retryable: bool = True,
) -> ProviderHttpError:
    return ProviderHttpError(
        provider="test",
        status_code=status_code,
        code="test_error",
        message=f"test {classification} error",
        retryable=retryable,
        classification=classification,
    )


def test_router_falls_back_on_server_error(monkeypatch) -> None:
    fallback_engine = _FallbackStubEngine()
    monkeypatch.setattr(
        "sidecar.ai.engines.factory.create_engine",
        lambda config: EngineSelection(
            engine=fallback_engine,
            engine_type=config.engine_type,
            model=config.model,
        ),
    )

    primary_engine = _FailingEngine(_make_provider_error("server_error"))
    config = RuntimeConfig(
        engine_type="ollama",
        model="llama3.2",
        fallback_models=(FallbackModelConfig(engine_type="mock", model="mock-v1"),),
    )
    router = _build_router(config=config, engine=primary_engine, mcp_client=_StubMCPClient({}))

    events: list[object] = []
    decision = router.build_chat_decision(
        request_id="req_fb_1",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=events.append, request_id="req_fb_1", max_iterations=2),
    )

    assert decision.response_text == "fallback-response"
    fb_events = [e for e in events if isinstance(e, FallbackTriggeredEvent)]
    assert len(fb_events) == 1
    assert fb_events[0].original_model == "ollama/llama3.2"
    assert fb_events[0].fallback_model == "mock/mock-v1"


def test_router_skips_removed_cloud_fallback_models_via_local_first_policy(monkeypatch) -> None:
    captured_events: list[str] = []
    monkeypatch.setattr(
        "sidecar.ai.engines.factory.create_engine",
        lambda config: pytest.fail("unsupported fallback must not initialize"),
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.generation_runtime.log_event",
        lambda *_args, **kwargs: captured_events.append(str(kwargs.get("event") or "")),
    )

    primary_engine = _FailingEngine(_make_provider_error("server_error"))
    config = RuntimeConfig(
        engine_type="ollama",
        model="llama3.2",
        fallback_models=(FallbackModelConfig(engine_type="anthropic", model="claude-sonnet-4-6"),),
    )
    router = _build_router(config=config, engine=primary_engine, mcp_client=_StubMCPClient({}))

    with pytest.raises(ToolExecutionFailure):
        router.build_chat_decision(
            request_id="req_fb_archived",
            messages=[{"role": "user", "content": "hello"}],
            latest_user_content="hello",
            mode="chat",
            approvals_pre_granted=True,
            runtime=LoopRuntime(request_id="req_fb_archived", max_iterations=2),
        )

    assert "ai.router.fallback_non_local_skipped" in captured_events


def test_router_fallback_triggers_on_rate_limit(monkeypatch) -> None:
    fallback_engine = _FallbackStubEngine()
    monkeypatch.setattr(
        "sidecar.ai.engines.factory.create_engine",
        lambda config: EngineSelection(
            engine=fallback_engine,
            engine_type=config.engine_type,
            model=config.model,
        ),
    )

    primary_engine = _FailingEngine(_make_provider_error("rate_limit", status_code=429))
    config = RuntimeConfig(
        engine_type="ollama",
        model="llama3.2",
        fallback_models=(FallbackModelConfig(engine_type="mock", model="mock-v1"),),
    )
    router = _build_router(config=config, engine=primary_engine, mcp_client=_StubMCPClient({}))

    events: list[object] = []
    decision = router.build_chat_decision(
        request_id="req_fb_rl",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=events.append, request_id="req_fb_rl", max_iterations=2),
    )

    assert decision.response_text == "fallback-response"
    assert any(isinstance(e, FallbackTriggeredEvent) for e in events)


def test_router_fallback_triggers_on_server_overload(monkeypatch) -> None:
    fallback_engine = _FallbackStubEngine()
    monkeypatch.setattr(
        "sidecar.ai.engines.factory.create_engine",
        lambda config: EngineSelection(
            engine=fallback_engine,
            engine_type=config.engine_type,
            model=config.model,
        ),
    )

    primary_engine = _FailingEngine(_make_provider_error("server_overload", status_code=529))
    config = RuntimeConfig(
        engine_type="ollama",
        model="llama3.2",
        fallback_models=(FallbackModelConfig(engine_type="mock", model="mock-v1"),),
    )
    router = _build_router(config=config, engine=primary_engine, mcp_client=_StubMCPClient({}))

    events: list[object] = []
    decision = router.build_chat_decision(
        request_id="req_fb_ol",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=events.append, request_id="req_fb_ol", max_iterations=2),
    )

    assert decision.response_text == "fallback-response"
    assert any(isinstance(e, FallbackTriggeredEvent) for e in events)


def test_router_fallback_exhaustion_propagates_original_error(monkeypatch) -> None:
    failing_fallback = _FailingEngine(RuntimeError("fallback also fails"))
    monkeypatch.setattr(
        "sidecar.ai.engines.factory.create_engine",
        lambda config: EngineSelection(
            engine=failing_fallback,
            engine_type=config.engine_type,
            model=config.model,
        ),
    )

    primary_engine = _FailingEngine(_make_provider_error("server_error"))
    config = RuntimeConfig(
        engine_type="ollama",
        model="llama3.2",
        fallback_models=(FallbackModelConfig(engine_type="mock", model="mock-v1"),),
    )
    router = _build_router(config=config, engine=primary_engine, mcp_client=_StubMCPClient({}))

    with pytest.raises(ToolExecutionFailure, match="model generation failed"):
        router.build_chat_decision(
            request_id="req_fb_exhaust",
            messages=[{"role": "user", "content": "hello"}],
            latest_user_content="hello",
            mode="chat",
            approvals_pre_granted=True,
            runtime=LoopRuntime(request_id="req_fb_exhaust", max_iterations=2),
        )


def test_router_fallback_chain_tries_next_on_first_failure(monkeypatch) -> None:
    call_count = 0
    second_engine = _FallbackStubEngine("second-fallback")

    def mock_create_engine(config):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return EngineSelection(
                engine=_FailingEngine(RuntimeError("first fallback fails")),
                engine_type=config.engine_type,
                model=config.model,
            )
        return EngineSelection(
            engine=second_engine,
            engine_type=config.engine_type,
            model=config.model,
        )

    monkeypatch.setattr("sidecar.ai.engines.factory.create_engine", mock_create_engine)

    primary_engine = _FailingEngine(_make_provider_error("server_error"))
    config = RuntimeConfig(
        engine_type="ollama",
        model="llama3.2",
        fallback_models=(
            FallbackModelConfig(engine_type="vllm", model="first-local"),
            FallbackModelConfig(engine_type="mock", model="mock-v1"),
        ),
    )
    router = _build_router(config=config, engine=primary_engine, mcp_client=_StubMCPClient({}))

    events: list[object] = []
    decision = router.build_chat_decision(
        request_id="req_fb_chain",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=events.append, request_id="req_fb_chain", max_iterations=2),
    )

    assert decision.response_text == "second-fallback"
    fb_events = [e for e in events if isinstance(e, FallbackTriggeredEvent)]
    assert len(fb_events) == 1
    assert fb_events[0].fallback_model == "mock/mock-v1"


def test_router_fallback_strips_thinking_blocks(monkeypatch) -> None:
    fallback_engine = _FallbackStubEngine()
    monkeypatch.setattr(
        "sidecar.ai.engines.factory.create_engine",
        lambda config: EngineSelection(
            engine=fallback_engine,
            engine_type=config.engine_type,
            model=config.model,
        ),
    )

    primary_engine = _FailingEngine(_make_provider_error("server_error"))
    config = RuntimeConfig(
        engine_type="ollama",
        model="llama3.2",
        fallback_models=(FallbackModelConfig(engine_type="mock", model="mock-v1"),),
    )
    router = _build_router(config=config, engine=primary_engine, mcp_client=_StubMCPClient({}))

    router.build_chat_decision(
        request_id="req_fb_think",
        messages=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "<think>internal</think>visible"},
        ],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req_fb_think", max_iterations=2),
    )

    sent_messages = fallback_engine.last_kwargs.get("messages", [])
    for msg in sent_messages:
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            assert "<think>" not in str(msg.get("content", ""))


def test_router_fallback_on_generic_timeout_error(monkeypatch) -> None:
    fallback_engine = _FallbackStubEngine()
    monkeypatch.setattr(
        "sidecar.ai.engines.factory.create_engine",
        lambda config: EngineSelection(
            engine=fallback_engine,
            engine_type=config.engine_type,
            model=config.model,
        ),
    )

    primary_engine = _FailingEngine(TimeoutError("connection timed out"))
    config = RuntimeConfig(
        engine_type="ollama",
        model="llama3.2",
        fallback_models=(FallbackModelConfig(engine_type="mock", model="mock-v1"),),
    )
    router = _build_router(config=config, engine=primary_engine, mcp_client=_StubMCPClient({}))

    events: list[object] = []
    decision = router.build_chat_decision(
        request_id="req_fb_timeout",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=events.append, request_id="req_fb_timeout", max_iterations=2),
    )

    assert decision.response_text == "fallback-response"
    assert any(isinstance(e, FallbackTriggeredEvent) for e in events)


def test_router_no_fallback_when_fallback_models_empty() -> None:
    primary_engine = _FailingEngine(_make_provider_error("server_error"))
    config = RuntimeConfig(engine_type="ollama", model="llama3.2")
    router = _build_router(config=config, engine=primary_engine, mcp_client=_StubMCPClient({}))

    with pytest.raises(ToolExecutionFailure, match="model generation failed"):
        router.build_chat_decision(
            request_id="req_fb_empty",
            messages=[{"role": "user", "content": "hello"}],
            latest_user_content="hello",
            mode="chat",
            approvals_pre_granted=True,
            runtime=LoopRuntime(request_id="req_fb_empty", max_iterations=2),
        )


# ── F20: the configured tokenizer backend must actually be USED, not just built ──


class _CountingBackend:
    """Tokenizer probe that records every count_tokens call the routing path makes."""

    headroom_factor = 0.1

    def __init__(self) -> None:
        self.counted: list[str] = []

    def count_tokens(self, text: str) -> int:
        self.counted.append(text)
        # Deliberately NOT chars//4: a silent fallback to CharEstimationBackend
        # would then differ in the returned number as well as the empty log.
        return max(1, len(text) // 2)

    def get_context_window(self, model: str) -> int:  # noqa: ARG002
        return 100_000

    def get_max_output_tokens(self, model: str) -> int:  # noqa: ARG002
        return 16_384


def test_budget_lane_counts_with_the_configured_tokenizer_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """apply_budget_check's backend must receive count_tokens calls from routing.

    It previously built the configured backend, read only ``headroom_factor``
    off it, and discarded it — so every downstream comparison fell back to the
    chars//4 estimator while the window was still cut by that backend's
    headroom. A tokenizer init and a 10% window haircut, for zero counting
    benefit. The probe below received exactly zero calls before this fix.
    """
    probe = _CountingBackend()
    monkeypatch.setattr(
        "sidecar.ai.context.token_budget._create_best_backend",
        lambda _config: probe,
    )
    engine = _StubEngine(
        plans=[_ToolPlan(result=GenerationResult(content="done", finish_reason="stop"))]
    )
    router = _build_router(
        config=RuntimeConfig(
            engine_type="ollama",
            model="llama3.2",
            context_length=100_000,
            max_tokens=1_000,
            feature_flags={FEATURE_TOKEN_BUDGET: True},
        ),
        engine=engine,
        mcp_client=_StubMCPClient({}),
    )

    router.build_chat_decision(
        request_id="req_backend_threading",
        messages=[{"role": "user", "content": "hello " * 200}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert probe.counted, "the configured tokenizer backend received zero count_tokens calls"


def test_apply_budget_check_hands_its_backend_to_the_tracker() -> None:
    """The headroom haircut and the token counting must come from ONE backend."""
    probe = _CountingBackend()
    config = RuntimeConfig(engine_type="ollama", model="llama3.2", context_length=100_000)
    engine = _StubEngine(plans=[])

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(
            "sidecar.ai.context.token_budget._create_best_backend",
            lambda _config: probe,
        )
        _messages, budget, tracker = apply_budget_check([], config, engine, num_tools=0)

    assert tracker is not None
    assert tracker.backend is probe, "the built backend must reach downstream comparisons"
    assert budget is not None
    # headroom_factor 0.1 already applied, so the counting backend and the
    # window it is compared against are now derived from the same object.
    assert budget.context_window == 90_000


def test_context_tokens_estimate_uses_the_config_aware_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The diagnostics estimate resolved no model family; the budget lane did.

    Same messages could therefore report different "tokens used" depending on
    which call site produced the figure.
    """
    probe = _CountingBackend()
    created = []

    def _factory(_config: object) -> _CountingBackend:
        created.append(_config)
        return probe

    monkeypatch.setattr("sidecar.ai.context.token_budget._create_best_backend", _factory)
    router = _build_router(
        config=RuntimeConfig(engine_type="ollama", model="llama3.2"),
        engine=_StubEngine(plans=[]),
        mcp_client=_StubMCPClient({}),
    )

    estimate = router._context_tokens_estimate([{"role": "user", "content": "abcdefgh"}])

    assert probe.counted == ["abcdefgh"]
    # len//2 + 4 message overhead = 8. The chars//4 default would give 2 + 4 = 6.
    assert estimate == 8

    router._context_tokens_estimate([{"role": "user", "content": "abcdefgh"}])
    assert len(created) == 1, "the backend must be memoized, not rebuilt per turn"
