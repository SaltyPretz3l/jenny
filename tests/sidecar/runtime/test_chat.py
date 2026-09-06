from __future__ import annotations

import base64
import json
import logging
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.context.builder import (
    ContextBuilder,
    RuntimeToolStatus,
    WorkspaceStatus,
)
from sidecar.ai.engines.base import ModelModality
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.error_codes import (
    CMP_AI_ENGINE_CONNECTION,
    CMP_CTX_BUDGET_EXHAUSTED,
    CMP_TOOL_APPROVAL_DENIED,
    CMP_TOOL_APPROVAL_WINDOW_DROPPED,
)
from sidecar.ai.exceptions import EngineConnectionError
from sidecar.ai.feature_flags import (
    FEATURE_AGENT_EXECUTOR,
    FEATURE_CANONICAL_TURN_EVENTS,
    FEATURE_CONTEXT_COMPACTION,
    FEATURE_PROMPT_CACHE,
    FEATURE_TOKEN_BUDGET,
)
from sidecar.ai.memory.contracts import MemoryPolicy
from sidecar.ai.memory.store import ApprovedMemory
from sidecar.ai.personality import build_personality_system_message
from sidecar.ai.routing import vision_turn as _vision_turn
from sidecar.ai.routing.loop_events import (
    StopEvent,
    TokenDeltaEvent,
    ToolExecutingEvent,
    ToolResultEvent,
)
from sidecar.ai.routing.router import ApprovalRequest, ChatDecision, ToolExecutionOutcome
from sidecar.ai.routing.sub_agent_invocation import (
    SubAgentIdentity,
    _child_request_context,
    invoke_sub_agent,
)
from sidecar.ai.routing.tool_execution import (
    assistant_tool_call_message,
    tool_result_message,
)
from sidecar.ai.routing.tool_observation import (
    KIND_TOOL_EXECUTION_FAILED,
    KIND_TURN_FAILED,
    ToolObservationEvent,
    ToolObservationStore,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import GenerationResult, GenerationUsage
from sidecar.ai.tools.tool_families import KNOWN_TOOL_FAMILIES
from sidecar.protocol import (
    CHAT_THINKING_KIND_REASONING,
    CHAT_THINKING_KIND_STATUS,
    TURN_EVENT_METHOD,
)
from sidecar.runtime.approval_plan import (
    ApprovalPlan,
    FrozenExecutionInputs,
    build_effective_args_fingerprint,
    build_execution_context_fingerprint,
    build_message_history_hash,
    build_sampling_params_hash,
    stable_hash,
)
from sidecar.runtime.chat import (
    ChatRequestError,
    _serialize_loop_event,
    _validate_approval_plan_live_context,
    build_chat_send_response,
    estimate_text_tokens,
    resume_chat_send_response_from_approval_plan,
)
from sidecar.runtime.chat_helpers import CHAT_INVALID_PARAMS, _decision_usage_payload
from sidecar.runtime.chat_models import ChatRequestContext, TerminalChatStateError
from sidecar.runtime.chat_resume import (
    _build_live_approval_system_prompt,
    _normalize_volatile_system_prompt_text,
)
from sidecar.runtime.chat_streaming import _build_live_stream_messages
from sidecar.runtime.diagnostics import StructuredLogFormatter
from sidecar.runtime.multiplexer import SubAgentSlotAllocator
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore
from sidecar.runtime.turn_retry import InnerRetryableTurnError
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
    TERMINAL_SUBCODE_PROTOCOL_VIOLATION,
    TERMINAL_SUBCODE_TIMEOUT_APPROVAL,
    TERMINAL_SUBCODE_TIMEOUT_TURN,
    TURN_STATE_COMPLETED,
    TURN_STATE_DENIED,
    TURN_STATE_PREEMPTED,
    TURN_STATE_RUNTIME_ERROR,
    TURN_STATE_TIMEOUT,
)


def test_serialize_stop_event_includes_user_hint() -> None:
    serialized = _serialize_loop_event(
        StopEvent(
            reason="Detected repeated tool calls. Please review and adjust.",
            code="CMP-LOOP-0003",
            user_hint="Stop calling tools and summarize what you found.",
        ),
        "req_stop",
        trace_id="trace_stop",
        session_id="session_stop",
    )

    assert serialized is not None
    assert serialized["method"] == "chat.thinking"
    assert serialized["params"]["user_hint"] == "Stop calling tools and summarize what you found."


class _StubRouter:
    def __init__(
        self,
        decision: ChatDecision,
        *,
        tool_statuses: tuple[RuntimeToolStatus, ...] = (),
    ) -> None:
        self._decision = decision
        self._tool_statuses = tool_statuses
        self.last_kwargs: dict[str, object] = {}

    def build_chat_decision(self, **kwargs: object) -> ChatDecision:
        self.last_kwargs = dict(kwargs)
        return self._decision

    def _tool_status_entries(self, **kwargs: object) -> tuple[RuntimeToolStatus, ...]:
        self.last_tool_status_kwargs = dict(kwargs)
        return self._tool_statuses


class _StreamingTextRouter:
    def __init__(
        self,
        response_text: str = "Stored reply.",
        completion_source: str = "model",
    ) -> None:
        self.response_text = response_text
        self.completion_source = completion_source

    def build_chat_decision(self, **kwargs: object) -> ChatDecision:
        runtime = kwargs["runtime"]
        assert runtime is not None
        runtime.emit(TokenDeltaEvent(delta=self.response_text, token_index=1))
        return ChatDecision(
            thinking_text=None,
            response_text=self.response_text,
            approval_request=None,
            tool_results=(),
            streamed_event_types=frozenset({"chat.token"}),
            completion_source=self.completion_source,
        )


class _VisionCapableEngine:
    supported_modalities = {ModelModality.TEXT, ModelModality.VISION}
    capabilities = {"text": True, "vision": True}

    def __init__(
        self,
        *,
        finish_reason: str = "stop",
        max_output_tokens: int | None = None,
    ) -> None:
        self.last_prompt = ""
        self.last_images: list[object] = []
        self.last_max_tokens: int | None = None
        self._finish_reason = finish_reason
        self._max_output_tokens = max_output_tokens

    def get_model_max_output_tokens(self) -> int | None:
        return self._max_output_tokens

    def generate_with_vision(
        self,
        prompt: str,
        images: list[object],
        max_tokens: int = 256,
        temperature: float = 0.7,
    ) -> GenerationResult:
        _ = temperature
        self.last_prompt = prompt
        self.last_images = list(images)
        self.last_max_tokens = max_tokens
        return GenerationResult(content="Vision response", finish_reason=self._finish_reason)


class _UnreachableVisionEngine:
    supported_modalities = {ModelModality.TEXT, ModelModality.VISION}
    capabilities = {"text": True, "vision": True}

    def generate_with_vision(
        self, prompt: str, images: list[str], max_tokens: int = 256, temperature: float = 0.7
    ) -> GenerationResult:
        _ = (prompt, images, max_tokens, temperature)
        raise EngineConnectionError(
            "Could not connect to Ollama at http://127.0.0.1:11434: refused",
            retryable=True,
        )


class _TextOnlyEngine:
    supported_modalities = {ModelModality.TEXT}
    capabilities = {"text": True, "vision": False}




class _StubContextBuilder:
    def __init__(self) -> None:
        self._runtime_builder = ContextBuilder(None)
        self.last_runtime_system_prompt = ""
        self.last_learned_lessons = None
        self.last_include_reasoning_status_markers = False

    def build_system_prompt(  # noqa: ANN001
        self,
        runtime_system_prompt: str,
        learned_lessons=None,
        include_reasoning_status_markers: bool = False,
        **_kwargs: object,
    ) -> str:
        self.last_runtime_system_prompt = runtime_system_prompt
        self.last_learned_lessons = learned_lessons
        self.last_include_reasoning_status_markers = include_reasoning_status_markers
        return f"{runtime_system_prompt}\n\nLESSONS:{len(learned_lessons or [])}"

    def build_skills_system_message(self, *, tool_statuses=None) -> str:  # noqa: ANN001
        return self._runtime_builder.build_skills_system_message(tool_statuses=tool_statuses)

    def build_memory_recall_system_message(self, recalled_memories=None) -> str:  # noqa: ANN001
        return self._runtime_builder.build_memory_recall_system_message(recalled_memories)

    def build_context_pressure_advisory(self, budget_status: object) -> str:
        return self._runtime_builder.build_context_pressure_advisory(budget_status)

    def insert_runtime_system_messages(
        self,
        working_messages: list[dict[str, object]],
        runtime_messages: list[str] | tuple[str, ...],
    ) -> list[dict[str, object]]:
        return self._runtime_builder.insert_runtime_system_messages(
            working_messages,
            runtime_messages,
        )

    def workspace_status(self) -> WorkspaceStatus:
        return WorkspaceStatus(
            root=None,
            exists=False,
            skills_loaded=0,
            bootstrap_loaded=0,
            instruction_file_name=None,
            instruction_file_present=False,
        )


class _ThinkingStreamEngine:
    supported_modalities = {ModelModality.TEXT}
    capabilities = {"text": True, "thinking": True}

    def __init__(self) -> None:
        self.last_messages: list[dict[str, str]] = []
        self.last_prompt_cache_enabled = False
        self.last_reasoning_effort: str | None = None

    def stream(
        self,
        prompt: str,
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[dict[str, str]] | None = None,
        response_format: object | None = None,
        cancel_handle: object | None = None,
    ):
        _ = prompt, max_tokens, temperature, system, response_format, cancel_handle
        self.last_messages = list(messages or [])
        self.last_prompt_cache_enabled = prompt_cache_enabled
        self.last_reasoning_effort = reasoning_effort
        yield SimpleNamespace(kind="thinking", text="Checking the request intent.")
        yield SimpleNamespace(kind="content", text="Ready.")
        yield SimpleNamespace(kind="done", text="")

    def get_model_max_output_tokens(self) -> int | None:
        return None


class _RepetitiveThinkingStreamEngine:
    supported_modalities = {ModelModality.TEXT}
    capabilities = {"text": True, "thinking": True}

    def stream(
        self,
        prompt: str,
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[dict[str, str]] | None = None,
        response_format: object | None = None,
        cancel_handle: object | None = None,
    ):
        _ = (
            prompt,
            max_tokens,
            temperature,
            reasoning_effort,
            prompt_cache_enabled,
            system,
            messages,
            response_format,
            cancel_handle,
        )
        repeated = "Checking the request intent carefully. "
        yield SimpleNamespace(kind="thinking", text=repeated)
        yield SimpleNamespace(kind="thinking", text=repeated)
        yield SimpleNamespace(kind="thinking", text=repeated)
        yield SimpleNamespace(kind="thinking", text=repeated)
        yield SimpleNamespace(kind="thinking", text=repeated)
        yield SimpleNamespace(kind="content", text="Ready.")
        yield SimpleNamespace(kind="done", text="")

    def get_model_max_output_tokens(self) -> int | None:
        return None


class _ReasoningOnlyStreamEngine:
    supported_modalities = {ModelModality.TEXT}
    capabilities = {"text": True, "thinking": True}

    def stream(
        self,
        prompt: str,
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[dict[str, str]] | None = None,
        response_format: object | None = None,
        cancel_handle: object | None = None,
    ):
        _ = (
            prompt,
            max_tokens,
            temperature,
            reasoning_effort,
            prompt_cache_enabled,
            system,
            messages,
            response_format,
            cancel_handle,
        )
        yield SimpleNamespace(kind="thinking", text="Only private reasoning here.")
        yield SimpleNamespace(kind="done", text="", finish_reason="reasoning_only")

    def get_model_max_output_tokens(self) -> int | None:
        return None


class _StatusMarkerThinkingStreamEngine:
    supported_modalities = {ModelModality.TEXT}
    capabilities = {"text": True, "thinking": True}

    def stream(
        self,
        prompt: str,
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[dict[str, str]] | None = None,
        response_format: object | None = None,
        cancel_handle: object | None = None,
    ):
        _ = (
            prompt,
            max_tokens,
            temperature,
            reasoning_effort,
            prompt_cache_enabled,
            system,
            messages,
            response_format,
            cancel_handle,
        )
        yield SimpleNamespace(
            kind="thinking",
            text="⟨STATUS: Analyzing constraints⟩\nChecking the request intent.",
        )
        yield SimpleNamespace(kind="content", text="Ready.")
        yield SimpleNamespace(kind="done", text="")

    def get_model_max_output_tokens(self) -> int | None:
        return None


class _TrailingPartialStatusThinkingStreamEngine:
    supported_modalities = {ModelModality.TEXT}
    capabilities = {"text": True, "thinking": True}

    def stream(
        self,
        prompt: str,
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[dict[str, str]] | None = None,
        response_format: object | None = None,
        cancel_handle: object | None = None,
    ):
        _ = (
            prompt,
            max_tokens,
            temperature,
            reasoning_effort,
            prompt_cache_enabled,
            system,
            messages,
            response_format,
            cancel_handle,
        )
        yield SimpleNamespace(kind="thinking", text="⟨STATUS: partial")
        yield SimpleNamespace(kind="content", text="Ready.")
        yield SimpleNamespace(kind="done", text="")

    def get_model_max_output_tokens(self) -> int | None:
        return None


class _ContentMarkerLeakStreamEngine:
    supported_modalities = {ModelModality.TEXT}
    capabilities = {"text": True, "thinking": True}

    def stream(
        self,
        prompt: str,
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[dict[str, str]] | None = None,
        response_format: object | None = None,
        cancel_handle: object | None = None,
    ):
        _ = (
            prompt,
            max_tokens,
            temperature,
            reasoning_effort,
            prompt_cache_enabled,
            system,
            messages,
            response_format,
            cancel_handle,
        )
        yield SimpleNamespace(
            kind="content", text="Before âŸ¨STATUS: Drafting final responseâŸ© after."
        )
        yield SimpleNamespace(kind="done", text="")

    def get_model_max_output_tokens(self) -> int | None:
        return None


class _ControlTokenLeakStreamEngine:
    supported_modalities = {ModelModality.TEXT}
    capabilities = {"text": True, "thinking": True}

    def stream(
        self,
        prompt: str,
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[dict[str, str]] | None = None,
        response_format: object | None = None,
        cancel_handle: object | None = None,
    ):
        _ = (
            prompt,
            max_tokens,
            temperature,
            reasoning_effort,
            prompt_cache_enabled,
            system,
            messages,
            response_format,
            cancel_handle,
        )
        yield SimpleNamespace(kind="content", text="Before <|tool_response> after.")
        yield SimpleNamespace(kind="content", text="<|tool_response>")
        yield SimpleNamespace(kind="content", text=" And more.")
        yield SimpleNamespace(kind="done", text="")

    def get_model_max_output_tokens(self) -> int | None:
        return None


class _NonThinkingContentStreamEngine:
    supported_modalities = {ModelModality.TEXT}
    capabilities = {"text": True, "thinking": False}

    def stream(
        self,
        prompt: str,
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[dict[str, str]] | None = None,
        response_format: object | None = None,
        cancel_handle: object | None = None,
    ):
        _ = (
            prompt,
            max_tokens,
            temperature,
            reasoning_effort,
            prompt_cache_enabled,
            system,
            messages,
            response_format,
            cancel_handle,
        )
        yield SimpleNamespace(kind="content", text="Ready.")
        yield SimpleNamespace(kind="done", text="")

    def get_model_max_output_tokens(self) -> int | None:
        return None


def _build_brain_container(
    decision: ChatDecision,
    *,
    engine_type: str = "openai",
    model: str = "gpt-4.1",
    engine: object | None = None,
    feature_flags: dict[str, bool] | None = None,
    memory_store: object | None = None,
    raw_config: dict[str, object] | None = None,
    subprocess_manager: object | None = None,
    max_inline_payload_bytes: int = 65_536,
    background_runtime_root: str | None = None,
    electron_state_root: str | None = None,
    tool_statuses: tuple[RuntimeToolStatus, ...] = (),
    tool_observations: ToolObservationStore | None = None,
    turn_diagnostics: TurnDiagnosticsStore | None = None,
) -> object:
    context_builder = _StubContextBuilder()
    config = SimpleNamespace(
        mode="chat",
        engine_type=engine_type,
        model=model,
        feature_flags=feature_flags or {},
        system_prompt="Base system prompt",
        max_tokens=16384,
        tools_workspace_root=None,
        agent_workspace_root=None,
        background_runtime_root=background_runtime_root,
        electron_state_root=electron_state_root,
        max_loop_wall_seconds=300.0,
        max_tools_per_turn=20,
        chunk_inactivity_seconds=60.0,
        model_load_grace_seconds=300.0,
        max_inline_payload_bytes=max_inline_payload_bytes,
    )
    stack = SimpleNamespace(
        raw_config=raw_config or {},
        secrets={},
        config=config,
        router=_StubRouter(decision, tool_statuses=tool_statuses),
        engine=engine or _TextOnlyEngine(),
        context_builder=context_builder,
        mcp_client=SimpleNamespace(available_tools=[]),
        memory_store=memory_store,
        tool_observations=tool_observations,
        turn_diagnostics=turn_diagnostics,
    )
    return SimpleNamespace(stack=stack, subprocess_manager=subprocess_manager)


def _done_notification(response: object) -> dict[str, object]:
    notifications = response.notifications
    for item in notifications:
        if item.get("method") == "chat.done":
            return item
    raise AssertionError("chat.done notification not found")


class _ApprovalPromptBuilder:
    def __init__(self, prompt_text: str) -> None:
        self.prompt_text = prompt_text

    def build_system_prompt(self, runtime_system_prompt: str, **kwargs: object) -> str:
        _ = runtime_system_prompt, kwargs
        return self.prompt_text

    def build_skills_system_message(self, *, tool_statuses: object = None) -> str:
        _ = tool_statuses
        return ""


class _ApprovalResumeRouter:
    def __init__(
        self,
        *,
        frozen_inputs: tuple[FrozenExecutionInputs, ...],
        tool_contract: object | None = None,
        live_read_snapshot_cache: dict[str, dict[str, object]] | None = None,
        rebuilt_read_snapshot_cache: dict[str, dict[str, object]] | None = None,
        prompt_text: str = "Frozen system prompt",
    ) -> None:
        self._frozen_inputs = frozen_inputs
        self._tool_contract = tool_contract or SimpleNamespace(prompt_schemas=(), status_entries=())
        self._live_read_snapshot_cache = live_read_snapshot_cache or {}
        self._rebuilt_read_snapshot_cache = (
            dict(self._live_read_snapshot_cache)
            if rebuilt_read_snapshot_cache is None
            else dict(rebuilt_read_snapshot_cache)
        )
        self.snapshot_updates: list[tuple[str, bool]] = []
        self.freeze_contexts: list[tuple[bool, bool, bool | None]] = []
        self._context_builder = _ApprovalPromptBuilder(prompt_text)
        self._cache_break_detector = None

    def _assemble_tool_contract(self, **kwargs: object) -> object:
        _ = kwargs
        return self._tool_contract

    def _freeze_effective_execution_inputs(
        self,
        call: object,
        *,
        session_id: str | None,
        read_snapshot_cache: dict[str, dict[str, object]],
        tool_contract: object | None = None,
        plan_mode: bool = False,
        read_only: bool = False,
        trusted_plan_artifact_write: bool | None = None,
    ) -> FrozenExecutionInputs:
        _ = call, session_id, tool_contract
        self.freeze_contexts.append((plan_mode, read_only, trusted_plan_artifact_write))
        if read_snapshot_cache == self._live_read_snapshot_cache:
            return self._frozen_inputs[0]
        raise AssertionError("unexpected read_snapshot_cache passed to live freeze helper")

    def _rebuild_read_snapshot_cache(
        self,
        canonical_session_messages: list[dict[str, object]] | None,
    ) -> dict[str, dict[str, object]]:
        _ = canonical_session_messages
        return dict(self._rebuilt_read_snapshot_cache)

    def _update_read_snapshot_cache(
        self,
        cache: dict[str, dict[str, object]],
        *,
        tool_name: str,
        success: bool,
        metadata: dict[str, object],
    ) -> None:
        self.snapshot_updates.append((tool_name, success))
        if not success:
            return
        if tool_name == "read_file":
            snapshot = metadata.get("read_snapshot")
            if isinstance(snapshot, dict) and snapshot.get("scope") == "full":
                cache[str(snapshot["path"])] = dict(snapshot)
            return
        if tool_name in {"write_file", "edit_file"}:
            cache.pop(str(metadata.get("path") or ""), None)

    def _request_tool_set(
        self,
        tool_preferences: dict[str, tuple[str, ...]] | None,
        key: str,
    ) -> frozenset[str]:
        _ = tool_preferences, key
        return frozenset()

    def _context_tokens_estimate(self, messages: list[dict[str, object]]) -> int:
        _ = messages
        return 0

    # Delegate to the same helpers AgentKernel uses (router.py:650-662). The
    # resume path records a transcript pair for every call it settles without
    # dispatching -- pre_filter_tool_calls already did this for filtered calls,
    # and settle_dropped_tool_calls now does it for calls left outside the
    # approval window -- so this double has to answer them like the real kernel.
    @staticmethod
    def _assistant_tool_call_message(
        result: object,
        call: object,
    ) -> dict[str, object]:
        return assistant_tool_call_message(result, call)

    @staticmethod
    def _tool_result_message(
        call: object,
        outcome: object,
    ) -> dict[str, object]:
        return tool_result_message(call, outcome)


def _build_approval_plan_for_chat_tests(
    *,
    remaining_iterations: int = 1,
    prompt_text: str = "Frozen system prompt",
    request_messages: list[dict[str, object]] | None = None,
    tool_call_limit: int = 0,
    remaining_tool_calls: int = 0,
    current_date: str = "2026-04-13",
) -> ApprovalPlan:
    request_messages = request_messages or [{"role": "user", "content": "write notes.md"}]
    frozen_inputs = (
        FrozenExecutionInputs(
            call_id="call-write-1",
            tool_name="write_file",
            visible_tool_arguments={"path": "notes.md", "content": "hello"},
            effective_tool_arguments={"path": "notes.md", "content": "hello"},
            injected_arg_keys=(),
            effective_args_fingerprint=stable_hash({"path": "notes.md", "content": "hello"}),
            execution_context_payload={"session_id": "session-1"},
        ),
    )
    dynamic_system_messages = [
        {"role": "system", "content": build_personality_system_message(None, "")},
    ]
    working_messages = [
        {"role": "system", "content": prompt_text},
        *dynamic_system_messages,
        *request_messages,
    ]
    return ApprovalPlan(
        call_id="call-write-1",
        approved_call_id="call-write-1",
        request_id="req-approval-1",
        trace_id="trace-approval-1",
        session_id="session-1",
        request_context=ChatRequestContext(
            request_id="req-approval-1",
            trace_id="trace-approval-1",
            session_id="session-1",
            mode="chat",
            approvals_pre_granted=False,
            reasoning_effort="medium",
            plan_mode=False,
            tool_preferences=None,
            session_start_date="2026-04-13",
            current_date=current_date,
        ),
        latest_user_content="write notes.md",
        working_messages=tuple(working_messages),
        generation_result=SimpleNamespace(content="Calling write_file"),
        tool_calls=(
            SimpleNamespace(
                tool_id="write_file",
                arguments={"path": "notes.md", "content": "hello"},
                call_id="call-write-1",
            ),
        ),
        frozen_inputs=frozen_inputs,
        tool_contract=SimpleNamespace(prompt_schemas=(), status_entries=()),
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=(),
        usage_totals=None,
        streamed_event_types=frozenset(),
        system_prompt=prompt_text,
        prompt_cache_enabled=False,
        cache_source_key="req-approval-1",
        remaining_iterations=remaining_iterations,
        request_messages_hash=build_message_history_hash(request_messages),
        tool_payload=(),
        tool_statuses=(),
        tool_contract_hash=stable_hash({"prompt_schemas": (), "status_entries": []}),
        effective_args_fingerprint=stable_hash(
            [
                {
                    "call_id": "call-write-1",
                    "tool_name": "write_file",
                    "effective_tool_arguments": {"path": "notes.md", "content": "hello"},
                }
            ]
        ),
        execution_context_fingerprint=stable_hash(
            [
                {
                    "call_id": "call-write-1",
                    "tool_name": "write_file",
                    "execution_context": {"session_id": "session-1"},
                    "injected_arg_keys": [],
                }
            ]
        ),
        model_identity_fingerprint=stable_hash(
            {
                "provider": "mock",
                "model": "mock-v1",
                "engine_class": f"{_TextOnlyEngine.__module__}.{_TextOnlyEngine.__name__}",
                "tier": "",
                "fallback_model": "",
            }
        ),
        system_prompt_hash=stable_hash(prompt_text),
        sampling_params_hash=stable_hash(
            {
                "max_tokens": 16384,
                "reasoning_effort": "medium",
                "temperature": 0.0,
                "top_p": 1.0,
                "stop_sequences": None,
                "prompt_cache_enabled": False,
                "memory_policy": {
                    "enabled": True,
                    "include_response_style": True,
                },
            }
        ),
        message_history_hash=build_message_history_hash(working_messages),
        parent_approval_plan_hash="",
        approval_plan_hash="approval-plan-hash",
        tool_call_limit=tool_call_limit,
        remaining_tool_calls=remaining_tool_calls,
    )


def _approval_read_snapshot() -> dict[str, object]:
    return {
        "path": "notes.md",
        "scope": "full",
        "size_bytes": 5,
        "mtime_ns": 123,
        "sha256": "abc123",
    }


def _approval_validation_brain_container(router: _ApprovalResumeRouter) -> SimpleNamespace:
    engine = _TextOnlyEngine()
    engine.get_model_max_output_tokens = lambda: None  # type: ignore[attr-defined]
    return SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                session_start_date="2026-04-13",
            ),
            engine=engine,
            router=router,
        )
    )


def test_live_approval_prompt_reuses_request_current_date(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def _build_system_prompt(_base_prompt: str, **kwargs: object) -> str:
        captured.update(kwargs)
        return "rebuilt"

    plan = _build_approval_plan_for_chat_tests(current_date="2026-07-18")
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                system_prompt="Frozen system prompt",
                session_start_date="2026-04-13",
                engine_type="mock",
            ),
            router=SimpleNamespace(
                _context_builder=SimpleNamespace(build_system_prompt=_build_system_prompt)
            ),
        )
    )
    monkeypatch.setattr(
        "sidecar.runtime.chat_resume.resolve_current_date",
        lambda: (_ for _ in ()).throw(AssertionError("date must stay pinned")),
    )

    prompt = _build_live_approval_system_prompt(
        plan,
        brain_container=brain_container,
        live_params={},
        tool_statuses=(),
    )

    assert prompt == "rebuilt"
    assert captured["session_start_date"] == "2026-04-13"
    assert captured["current_date"] == "2026-07-18"




def _thinking_notification(response: object) -> dict[str, object]:
    notifications = response.notifications
    for item in notifications:
        if item.get("method") == "chat.thinking":
            return item
    raise AssertionError("chat.thinking notification not found")


def _write_temp_image(tmp_path: Path) -> str:
    image_path = tmp_path / "attachments" / "images" / "test.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42Y"
            "AAAAASUVORK5CYII="
        )
    )
    return str(image_path.resolve())


def test_build_chat_send_response_emits_provider_usage_when_available() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
        usage=GenerationUsage(
            input_tokens=144,
            output_tokens=32,
            total_tokens=176,
            provider="openai",
            model="gpt-4.1",
            provider_cost_usd=0.0123,
            generation_tokens=32,
            generation_duration_ms=800,
            prompt_eval_duration_ms=120,
            load_duration_ms=50,
            time_to_first_token_ms=90,
        ),
    )
    response = build_chat_send_response(
        "msg-1",
        {
            "request_id": "req-usage",
            "messages": [{"role": "user", "content": "Summarize the README"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision),
        invalid_params_code=-32602,
    )

    done = _done_notification(response)
    usage = done["params"]["usage"]
    assert usage["input_tokens"] == 144
    assert usage["output_tokens"] == 32
    assert usage["total_tokens"] == 176
    assert usage["provider"] == "openai"
    assert usage["model"] == "gpt-4.1"
    assert usage["estimated"] is False
    assert usage["generation_tokens"] == 32
    assert usage["generation_duration_ms"] == pytest.approx(800)
    assert usage["prompt_eval_duration_ms"] == pytest.approx(120)
    assert usage["load_duration_ms"] == pytest.approx(50)
    assert usage["time_to_first_token_ms"] == pytest.approx(90)
    assert usage["cost_usd"] == pytest.approx(0.0123)
    assert usage["cost_source"] == "provider"


def test_usage_cost_truth_marks_local_zero_and_unknown_cloud_unavailable() -> None:
    local = _decision_usage_payload(
        GenerationUsage(input_tokens=1, provider="ollama", model="qwen"),
        fallback_provider="ollama",
        fallback_model="qwen",
    )
    cloud = _decision_usage_payload(
        GenerationUsage(input_tokens=1, provider="cloud", model="unknown"),
        fallback_provider="cloud",
        fallback_model="unknown",
    )

    assert local is not None
    assert local["cost_usd"] == 0.0
    assert local["cost_source"] == "local_zero"
    assert "generation_duration_ms" not in local
    assert "time_to_first_token_ms" not in local
    assert cloud is not None
    assert cloud["cost_usd"] is None
    assert cloud["cost_source"] == "unavailable"


def test_build_chat_send_response_recovers_blank_successful_tool_completion() -> None:
    diagnostics = TurnDiagnosticsStore()
    decision = ChatDecision(
        thinking_text=None,
        response_text="",
        approval_request=None,
        tool_results=(
            ToolExecutionOutcome(
                tool_name="read_file",
                output="README contents",
                success=True,
            ),
            ToolExecutionOutcome(
                tool_name="run_command",
                output="process bootstrap failed",
                success=False,
            ),
        ),
    )
    response = build_chat_send_response(
        "msg-toolwork-fallback",
        {
            "request_id": "req-toolwork-fallback",
            "messages": [{"role": "user", "content": "Inspect the harness"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            turn_diagnostics=diagnostics,
        ),
        invalid_params_code=-32602,
    )

    done = _done_notification(response)["params"]
    snapshot = diagnostics.get_snapshot_for_request("req-toolwork-fallback")
    assert done["completion_source"] == "deterministic_tool_fallback"
    assert "1 successful and 1 failed" in done["response_text"]
    assert response.result["response_text"] == done["response_text"]
    assert snapshot is not None
    assert snapshot["terminal_completion"] == {
        "completion_source": "deterministic_tool_fallback",
        "visible_response_chars": len(done["response_text"]),
        "tool_result_count": 2,
        "successful_tool_result_count": 1,
        "fallback_applied": True,
    }


def test_build_chat_send_response_recovers_blank_all_failed_tool_completion() -> None:
    """A blank completion where EVERY tool failed must still explain itself.

    The blank-completion net used to be gated on ``successful_tool_result_count``,
    so the all-failed turn -- the one that most needs an explanation -- was the
    single case it skipped, and the turn settled with no visible text at all.
    ``_toolwork_only_fallback``'s own ``if failed:`` wording was unreachable as a
    result: it required at least one success AND one failure.
    """
    diagnostics = TurnDiagnosticsStore()
    decision = ChatDecision(
        thinking_text=None,
        response_text="",
        approval_request=None,
        tool_results=(
            ToolExecutionOutcome(
                tool_name="run_command",
                output="'powershell' is not recognized",
                success=False,
            ),
        ),
    )
    response = build_chat_send_response(
        "msg-allfailed-fallback",
        {
            "request_id": "req-allfailed-fallback",
            "messages": [{"role": "user", "content": "what day is it"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            turn_diagnostics=diagnostics,
        ),
        invalid_params_code=-32602,
    )

    done = _done_notification(response)["params"]
    snapshot = diagnostics.get_snapshot_for_request("req-allfailed-fallback")
    assert done["completion_source"] == "deterministic_tool_fallback"
    assert "0 successful and 1 failed" in done["response_text"]
    assert response.result["response_text"] == done["response_text"]
    assert snapshot is not None
    assert snapshot["terminal_completion"] == {
        "completion_source": "deterministic_tool_fallback",
        "visible_response_chars": len(done["response_text"]),
        "tool_result_count": 1,
        "successful_tool_result_count": 0,
        "fallback_applied": True,
    }


def test_build_chat_send_response_uses_router_context_estimate_when_available() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
        context_tokens_estimate=4321,
    )
    response = build_chat_send_response(
        "msg-context-estimate",
        {
            "request_id": "req-context-estimate",
            "messages": [{"role": "user", "content": "x" * 20_000}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            feature_flags={FEATURE_TOKEN_BUDGET: True},
        ),
        invalid_params_code=-32602,
    )

    done = _done_notification(response)
    usage = done["params"]["usage"]
    assert usage["context_tokens_estimate"] == 4321


def test_build_chat_send_response_forwards_engine_context_window_to_usage() -> None:
    class _WindowedEngine(_TextOnlyEngine):
        def get_model_context_length(self) -> int:
            return 131072

    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
        context_tokens_estimate=4321,
    )
    response = build_chat_send_response(
        "msg-context-window",
        {
            "request_id": "req-context-window",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine=_WindowedEngine(),
            feature_flags={FEATURE_TOKEN_BUDGET: True},
        ),
        invalid_params_code=-32602,
    )

    usage = _done_notification(response)["params"]["usage"]
    assert usage["context_window"] == 131072


def test_build_chat_send_response_omits_context_window_when_engine_unknown() -> None:
    class _NoWindowEngine(_TextOnlyEngine):
        def get_model_context_length(self) -> None:
            return None

    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    response = build_chat_send_response(
        "msg-no-window",
        {
            "request_id": "req-no-window",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision, engine=_NoWindowEngine()),
        invalid_params_code=-32602,
    )

    usage = _done_notification(response)["params"]["usage"]
    assert "context_window" not in usage


def test_build_chat_send_response_includes_tool_call_id_in_approval_payload() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="",
        approval_request=ApprovalRequest(
            tool_name="write_file",
            reason="The model requested a side-effecting MCP tool call.",
            tool_input={"path": "notes.md"},
            mode="assist",
            tool_call_id="call-approval-1",
        ),
        approval_plan=SimpleNamespace(call_id="call-approval-1"),
        tool_results=(),
    )
    response = build_chat_send_response(
        "msg-approval",
        {
            "request_id": "req-approval",
            "messages": [{"role": "user", "content": "Write notes.md"}],
        },
        approvals_pre_granted=False,
        brain_container=_build_brain_container(decision),
        invalid_params_code=-32602,
    )

    assert response.result["status"] == "awaiting_approval"
    assert response.approval_request is not None
    assert response.approval_request["tool_name"] == "write_file"
    assert response.approval_request["tool_call_id"] == "call-approval-1"
    assert response.approval_plan is not None


def test_build_chat_send_response_includes_policy_decision_id_in_approval_payload() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="",
        approval_request=ApprovalRequest(
            tool_name="read_file",
            reason="Tool policy requires approval: Review all file reads",
            tool_input={"path": "notes.md"},
            mode="assist",
            tool_call_id="call-policy-approval",
            policy_decision_id="policy_abc123",
        ),
        approval_plan=SimpleNamespace(call_id="call-policy-approval"),
        tool_results=(),
    )
    response = build_chat_send_response(
        "msg-policy-approval",
        {
            "request_id": "req-policy-approval",
            "messages": [{"role": "user", "content": "Read notes.md"}],
        },
        approvals_pre_granted=False,
        brain_container=_build_brain_container(decision),
        invalid_params_code=-32602,
    )

    assert response.result["status"] == "awaiting_approval"
    assert response.approval_request is not None
    assert response.approval_request["tool_call_id"] == "call-policy-approval"
    assert response.approval_request["policy_decision_id"] == "policy_abc123"


def test_build_chat_send_response_includes_tool_observations_on_completed_result() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req-observed-complete")
    store.record(
        ToolObservationEvent(
            kind=KIND_TOOL_EXECUTION_FAILED,
            request_id="req-observed-complete",
            tool_call_id="call-observed",
            tool_name="inspect_harness",
            summary="tool interrupted",
            error_code="CMP-LOOP-0013",
        )
    )
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    response = build_chat_send_response(
        "msg-observed-complete",
        {
            "request_id": "req-observed-complete",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision, tool_observations=store),
        invalid_params_code=-32602,
    )

    observations = response.result["tool_observations"]
    assert observations[0]["kind"] == KIND_TOOL_EXECUTION_FAILED
    assert observations[0]["tool_call_id"] == "call-observed"
    assert observations[0]["sequence"] == 1


def test_build_chat_send_response_pins_dates_on_request_context(monkeypatch) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)
    monkeypatch.setattr("sidecar.runtime.chat.resolve_current_date", lambda: "2026-07-18")

    build_chat_send_response(
        "msg-session-start-date",
        {
            "request_id": "req-session-start-date",
            "session_start_date": "2026-03-28",
            "messages": [{"role": "user", "content": "Continue the session"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert brain_container.stack.router.last_kwargs["session_start_date"] == "2026-03-28"
    request_context = brain_container.stack.router.last_kwargs["request_context"]
    assert request_context.session_start_date == "2026-03-28"
    assert request_context.current_date == "2026-07-18"


def test_build_chat_send_response_forwards_canonical_session_messages_to_router() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)
    canonical_messages = [
        {
            "id": "tool_result_1",
            "role": "tool",
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
    ]

    build_chat_send_response(
        "msg-canonical-session",
        {
            "request_id": "req-canonical-session",
            "messages": [{"role": "user", "content": "Continue"}],
            "canonical_session_messages": canonical_messages,
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert (
        brain_container.stack.router.last_kwargs["canonical_session_messages"] == canonical_messages
    )
    request_context = brain_container.stack.router.last_kwargs["request_context"]
    assert isinstance(request_context, ChatRequestContext)
    assert request_context.session_tool_call_count == 1


def test_build_chat_send_response_forwards_tool_preferences_to_router() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)

    build_chat_send_response(
        "msg-tool-preferences",
        {
            "request_id": "req-tool-preferences",
            "messages": [{"role": "user", "content": "Continue"}],
            "tool_preferences": {
                "enabled_tools": ["read_file"],
                "disabled_tools": ["web_search", "fetch_url"],
                "disabled_tool_families": ["web"],
            },
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert brain_container.stack.router.last_kwargs["tool_preferences"] == {
        "enabled_tools": ("read_file",),
        "disabled_tools": ("fetch_url", "web_search"),
        "disabled_tool_families": ("web",),
    }
    request_context = brain_container.stack.router.last_kwargs["request_context"]
    assert isinstance(request_context, ChatRequestContext)
    assert request_context.sub_agent_tool_preferences_fail_closed is False


@pytest.mark.parametrize(
    "raw_preferences",
    (
        {},
        {
            "enabled_tools": [],
            "disabled_tools": [],
            "disabled_tool_families": [],
        },
        {"enabled_tools": "read_file"},
        {"enabled_tools": ["read_file"], "unknown_key": []},
        {"disabled_tools": [None]},
        {"disabled_tool_families": ["filesytem"]},
    ),
)
def test_chat_ingress_fails_closed_malformed_parent_authority_for_sub_agent(
    raw_preferences: object,
) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)

    build_chat_send_response(
        "msg-tool-preferences-fail-closed",
        {
            "request_id": "req-tool-preferences-fail-closed",
            "messages": [{"role": "user", "content": "Continue"}],
            "tool_preferences": raw_preferences,
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    parent_context = brain_container.stack.router.last_kwargs["request_context"]
    assert isinstance(parent_context, ChatRequestContext)
    child_router = _StubRouter(decision)
    invoke_sub_agent(
        router=child_router,
        parent_context=parent_context,
        messages=[],
        latest_user_content="inspect",
        slot_allocator=SubAgentSlotAllocator(),
        tool_preferences_override={"disabled_tools": ("subagent_run",)},
    )

    child_context = child_router.last_kwargs["request_context"]
    assert isinstance(child_context, ChatRequestContext)
    assert child_context.tool_preferences is not None
    assert set(child_context.tool_preferences["disabled_tool_families"]) == (KNOWN_TOOL_FAMILIES)


def test_build_chat_send_response_forwards_plan_mode_to_router() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)

    build_chat_send_response(
        "msg-plan-mode",
        {
            "request_id": "req-plan-mode",
            "messages": [{"role": "user", "content": "Plan the change"}],
            "plan_mode": True,
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert brain_container.stack.router.last_kwargs["plan_mode"] is True


def test_build_chat_send_response_rejects_null_plan_mode() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )

    with pytest.raises(Exception) as error_info:
        build_chat_send_response(
            "msg-plan-mode-null",
            {
                "request_id": "req-plan-mode-null",
                "messages": [{"role": "user", "content": "Plan the change"}],
                "plan_mode": None,
            },
            approvals_pre_granted=True,
            brain_container=_build_brain_container(decision),
            invalid_params_code=-32602,
        )

    assert "plan_mode must be a boolean" in str(error_info.value)


@pytest.mark.parametrize(
    ("engine_type", "expected_concurrency"),
    (("openai", 1), ("chatgpt", 3)),
)
def test_build_chat_send_response_passes_feature_flags_into_agent_executor(
    monkeypatch,
    engine_type: str,
    expected_concurrency: int,
) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Executor path.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(
        decision,
        engine_type=engine_type,
        feature_flags={FEATURE_AGENT_EXECUTOR: True},
    )
    slot_allocator = object()
    brain_container.stack.sub_agent_slot_allocator = slot_allocator
    captured: dict[str, object] = {}

    class _FakeExecutor:
        def __init__(
            self,
            *,
            router: object,
            on_progress: object | None = None,
            feature_flags: dict[str, bool] | None = None,
            sub_agent_slot_allocator: object | None = None,
            cancel_handle: object | None = None,
            suppress_plan_proposal: bool = False,
        ) -> None:
            captured["router"] = router
            captured["on_progress"] = on_progress
            captured["feature_flags"] = feature_flags
            captured["sub_agent_slot_allocator"] = sub_agent_slot_allocator
            captured["cancel_handle"] = cancel_handle

        def execute(self, **kwargs: object) -> ChatDecision:
            captured["execute_kwargs"] = dict(kwargs)
            return decision

    monkeypatch.setattr("sidecar.runtime.chat.AgentExecutor", _FakeExecutor)

    response = build_chat_send_response(
        "msg-agent-executor-flags",
        {
            "request_id": "req-agent-executor-flags",
            "messages": [{"role": "user", "content": "Use the executor"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert response.result["status"] == "completed"
    assert captured["feature_flags"] == {FEATURE_AGENT_EXECUTOR: True}
    assert captured["router"] is brain_container.stack.router
    assert callable(captured["on_progress"])
    execute_kwargs = captured["execute_kwargs"]
    assert isinstance(execute_kwargs, dict)
    request_context = execute_kwargs["request_context"]
    assert isinstance(request_context, ChatRequestContext)
    assert request_context.request_id == "req-agent-executor-flags"
    assert request_context.mode == "chat"
    assert request_context.workspace_root_present is False
    assert request_context.workspace_instruction_present is False
    assert request_context.agent_id == "main@req-agent-executor-flags"
    assert request_context.agent_surface == "main"
    assert request_context.sub_agent_concurrency_budget == expected_concurrency


def test_build_chat_send_response_binds_agent_id_diagnostics_context() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Context path.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)
    captured: dict[str, object] = {}

    class _ContextRouter(_StubRouter):
        def build_chat_decision(self, **kwargs: object) -> ChatDecision:
            record = logging.LogRecord(
                "tests.chat.context",
                logging.INFO,
                __file__,
                0,
                "context probe",
                (),
                None,
            )
            captured["diagnostic_record"] = json.loads(
                StructuredLogFormatter().format(record)
            )
            return super().build_chat_decision(**kwargs)

    brain_container.stack.router = _ContextRouter(decision)

    response = build_chat_send_response(
        "msg-agent-context",
        {
            "request_id": "req-agent-context",
            "agent_id": "planner@req-agent-context",
            "messages": [{"role": "user", "content": "check context"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert response.result["status"] == "completed"
    assert captured["diagnostic_record"]["agent_id"] == "planner@req-agent-context"
    assert captured["diagnostic_record"]["request_id"] == "req-agent-context"
    outside_record = logging.LogRecord(
        "tests.chat.context",
        logging.INFO,
        __file__,
        0,
        "outside context probe",
        (),
        None,
    )
    outside_payload = json.loads(StructuredLogFormatter().format(outside_record))
    assert outside_payload["agent_id"] is None
    assert outside_payload["request_id"] is None


def test_build_chat_send_response_passes_stream_runtime_into_agent_executor(
    monkeypatch,
) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Executor path.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(
        decision,
        feature_flags={FEATURE_AGENT_EXECUTOR: True},
    )
    slot_allocator = object()
    brain_container.stack.sub_agent_slot_allocator = slot_allocator
    captured: dict[str, object] = {}

    class _FakeExecutor:
        def __init__(
            self,
            *,
            router: object,
            on_progress: object | None = None,
            feature_flags: dict[str, bool] | None = None,
            sub_agent_slot_allocator: object | None = None,
            cancel_handle: object | None = None,
            suppress_plan_proposal: bool = False,
        ) -> None:
            captured["sub_agent_slot_allocator"] = sub_agent_slot_allocator
            _ = router, on_progress, feature_flags, cancel_handle

        def execute(self, **kwargs: object) -> ChatDecision:
            captured["runtime"] = kwargs.get("runtime")
            return decision

    monkeypatch.setattr("sidecar.runtime.chat.AgentExecutor", _FakeExecutor)

    written: list[dict[str, object]] = []
    response = build_chat_send_response(
        "msg-agent-executor-runtime",
        {
            "request_id": "req-agent-executor-runtime",
            "messages": [{"role": "user", "content": "Use the executor"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert response.result["status"] == "completed"
    runtime = captured["runtime"]
    assert runtime is not None
    assert runtime.request_id == "req-agent-executor-runtime"
    assert runtime.streaming is True
    assert runtime.sub_agent_slot_allocator is slot_allocator
    assert runtime.request_context.request_id == "req-agent-executor-runtime"


def test_build_chat_send_response_marks_workspace_root_present_when_configured_even_if_missing() -> (
    None
):
    decision = ChatDecision(
        thinking_text=None,
        response_text="Executor path.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(
        decision,
        raw_config={"tools_workspace_root": "G:\\missing-workspace"},
    )
    brain_container.stack.config.tools_workspace_root = "G:\\missing-workspace"

    response = build_chat_send_response(
        "msg-workspace-root-present",
        {
            "request_id": "req-workspace-root-present",
            "messages": [{"role": "user", "content": "Use the executor"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert response.result["status"] == "completed"
    request_context = brain_container.stack.router.last_kwargs["request_context"]
    assert isinstance(request_context, ChatRequestContext)
    assert request_context.workspace_root_present is True


def test_build_chat_send_response_emits_tool_result_error_code_and_metadata() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Done.",
        approval_request=None,
        tool_results=(
            ToolExecutionOutcome(
                tool_name="tool_search",
                output="Found 1 tool",
                success=True,
                tool_input={"query": "git commit"},
                error_code="CMP-TSRCH-0001",
                metadata={
                    "kind": "tool_search_result",
                    "discovered_tools": ["mcp__git__commit"],
                    "match_count": 1,
                },
                call_id="call_tool_search_1",
            ),
        ),
    )

    response = build_chat_send_response(
        "msg-tool-result-meta",
        {
            "request_id": "req-tool-result-meta",
            "messages": [{"role": "user", "content": "Find the git tool"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision),
        invalid_params_code=-32602,
    )

    tool_executing_notification = next(
        item for item in response.notifications if item["method"] == "tool.executing"
    )
    tool_result_notification = next(
        item for item in response.notifications if item["method"] == "tool.result"
    )
    assert tool_executing_notification["params"]["tool_call_id"] == "call_tool_search_1"
    assert tool_executing_notification["params"]["tool_input"] == {"query": "git commit"}
    assert tool_result_notification["params"]["tool_call_id"] == "call_tool_search_1"
    assert tool_result_notification["params"]["error_code"] == "CMP-TSRCH-0001"
    assert tool_result_notification["params"]["tool_input"] == {"query": "git commit"}
    assert tool_result_notification["params"]["metadata"] == {
        "kind": "tool_search_result",
        "discovered_tools": ["mcp__git__commit"],
        "match_count": 1,
    }


def test_build_chat_send_response_externalizes_oversized_reconstructed_tool_payloads(
    tmp_path: Path,
) -> None:
    large_text = "x" * 90_000
    decision = ChatDecision(
        thinking_text=None,
        response_text="Done.",
        approval_request=None,
        tool_results=(
            ToolExecutionOutcome(
                tool_name="read_file",
                output=large_text,
                success=True,
                tool_input={"blob": large_text},
                metadata={"trace": large_text},
                call_id="call_read_large_1",
            ),
        ),
    )

    response = build_chat_send_response(
        "msg-tool-result-externalized",
        {
            "request_id": "req-tool-result-externalized",
            "messages": [{"role": "user", "content": "Read the file"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            background_runtime_root=str(tmp_path),
        ),
        invalid_params_code=-32602,
    )

    tool_executing_notification = next(
        item for item in response.notifications if item["method"] == "tool.executing"
    )
    tool_result_notification = next(
        item for item in response.notifications if item["method"] == "tool.result"
    )
    executing_external = tool_executing_notification["params"]["_external_payloads"]
    result_external = tool_result_notification["params"]["_external_payloads"]
    assert "tool_input" in executing_external
    assert "output" in result_external
    assert "metadata" in result_external
    assert Path(executing_external["tool_input"]["path"]).is_file()
    assert Path(result_external["output"]["path"]).is_file()
    assert Path(result_external["metadata"]["path"]).is_file()
    assert tool_result_notification["params"]["output"].endswith("[truncated]")


def test_build_chat_send_response_externalizes_oversized_streamed_tool_payloads(
    tmp_path: Path,
) -> None:
    large_text = "y" * 90_000

    class _RuntimeStreamingRouter:
        def build_chat_decision(self, **kwargs: object) -> ChatDecision:
            runtime = kwargs["runtime"]
            assert runtime is not None
            runtime.emit(
                ToolExecutingEvent(
                    call_id="call_1",
                    tool_name="read_file",
                    arguments={"blob": large_text},
                )
            )
            runtime.emit(
                ToolResultEvent(
                    call_id="call_1",
                    tool_name="read_file",
                    success=True,
                    content=large_text,
                    tool_input={"blob": large_text},
                    metadata={"trace": large_text},
                )
            )
            return ChatDecision(
                thinking_text=None,
                response_text="Done.",
                approval_request=None,
                tool_results=(),
                streamed_event_types=frozenset({"tool.executing", "tool.result"}),
            )

    brain_container = _build_brain_container(
        ChatDecision(
            thinking_text=None,
            response_text="unused",
            approval_request=None,
            tool_results=(),
        ),
        background_runtime_root=str(tmp_path),
    )
    brain_container.stack.router = _RuntimeStreamingRouter()
    written: list[dict[str, object]] = []

    response = build_chat_send_response(
        "msg-tool-stream-externalized",
        {
            "request_id": "req-tool-stream-externalized",
            "messages": [{"role": "user", "content": "Read the file"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert response.result["status"] == "completed"
    assert [item["method"] for item in written] == ["tool.executing", "tool.result"]
    executing_external = written[0]["params"]["_external_payloads"]
    result_external = written[1]["params"]["_external_payloads"]
    assert "tool_input" in executing_external
    assert "output" in result_external
    assert Path(executing_external["tool_input"]["path"]).is_file()
    assert Path(result_external["output"]["path"]).is_file()


def test_build_chat_send_response_reconstructs_only_missing_tool_result_notification() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Done.",
        approval_request=None,
        tool_results=(
            ToolExecutionOutcome(
                tool_name="read_file",
                output="README",
                success=True,
                tool_input={"path": "README.md"},
                call_id="call_readme_partial_1",
            ),
        ),
        streamed_event_types=frozenset({"tool.executing"}),
    )

    response = build_chat_send_response(
        "msg-tool-partial-stream",
        {
            "request_id": "req-tool-partial-stream",
            "messages": [{"role": "user", "content": "Read the README"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision),
        invalid_params_code=-32602,
    )

    methods = [item["method"] for item in response.notifications]
    assert methods.count("tool.executing") == 0
    assert methods.count("tool.result") == 1
    tool_result_notification = next(
        item for item in response.notifications if item["method"] == "tool.result"
    )
    assert tool_result_notification["params"]["tool_call_id"] == "call_readme_partial_1"


def test_build_chat_send_response_skips_duplicate_tool_notifications_when_both_streamed() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Done.",
        approval_request=None,
        tool_results=(
            ToolExecutionOutcome(
                tool_name="read_file",
                output="README",
                success=True,
                tool_input={"path": "README.md"},
                call_id="call_readme_streamed_1",
            ),
        ),
        streamed_event_types=frozenset({"tool.executing", "tool.result"}),
    )

    response = build_chat_send_response(
        "msg-tool-fully-streamed",
        {
            "request_id": "req-tool-fully-streamed",
            "messages": [{"role": "user", "content": "Read the README"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision),
        invalid_params_code=-32602,
    )

    methods = [item["method"] for item in response.notifications]
    assert "tool.executing" not in methods
    assert "tool.result" not in methods


def test_build_chat_send_response_strips_status_markers_from_router_visible_output() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text=(
            "⟨STATUS: Acknowledging user meta request⟩\n"
            "⟨STATUS: Choosing riddle content⟩\n"
            "Here is the visible answer."
        ),
        approval_request=None,
        tool_results=(),
    )

    response = build_chat_send_response(
        "msg-router-visible-sanitize",
        {
            "request_id": "req-router-visible-sanitize",
            "messages": [{"role": "user", "content": "Say hello"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision),
        invalid_params_code=-32602,
    )

    visible_text = "".join(
        item["params"]["delta"] for item in response.notifications if item["method"] == "chat.token"
    )
    assert "⟨STATUS:" not in visible_text
    assert "Here is the visible answer." in visible_text


def test_build_chat_send_response_marks_fallback_usage_as_estimated() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Fallback response",
        approval_request=None,
        tool_results=(),
    )
    response = build_chat_send_response(
        "msg-2",
        {
            "request_id": "req-fallback",
            "messages": [{"role": "user", "content": "Need a fallback"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision, engine_type="mock", model="mock-v1"),
        invalid_params_code=-32602,
    )

    done = _done_notification(response)
    usage = done["params"]["usage"]
    assert usage["provider"] == "mock"
    assert usage["model"] == "mock-v1"
    assert usage["estimated"] is True
    assert usage["input_tokens"] >= 1
    assert usage["total_tokens"] >= usage["input_tokens"]


def test_build_chat_send_response_uses_shared_estimator_for_fallback_usage() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Fallback, response.",
        approval_request=None,
        tool_results=(),
    )
    prompt = "Need, a fallback."
    response = build_chat_send_response(
        "msg-2b",
        {
            "request_id": "req-fallback-estimator",
            "messages": [{"role": "user", "content": prompt}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision, engine_type="mock", model="mock-v1"),
        invalid_params_code=-32602,
    )

    done = _done_notification(response)
    usage = done["params"]["usage"]
    assert usage["input_tokens"] == estimate_text_tokens(prompt)
    assert usage["output_tokens"] == estimate_text_tokens(decision.response_text)
    assert usage["total_tokens"] == usage["input_tokens"] + usage["output_tokens"]


def test_build_chat_send_response_forwards_learned_lessons_to_router() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)

    _ = build_chat_send_response(
        "msg-3",
        {
            "request_id": "req-learning",
            "messages": [{"role": "user", "content": "Give me a concise answer"}],
            "learning_context": {
                "lessons": [
                    {
                        "title": "Respect concise-response requests",
                        "lesson_text": "Keep concise answers tight.",
                        "confidence": 0.8,
                        "lesson_kind": "response_style",
                    }
                ]
            },
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    learned_lessons = brain_container.stack.router.last_kwargs["learned_lessons"]
    assert learned_lessons is not None
    assert len(learned_lessons) == 1
    assert learned_lessons[0].title == "Respect concise-response requests"


def test_explicit_memory_policy_supersedes_legacy_learning_context() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)

    build_chat_send_response(
        "msg-memory-policy",
        {
            "request_id": "req-memory-policy",
            "messages": [{"role": "user", "content": "Do not use memory"}],
            "memory_policy": {
                "enabled": False,
                "include_response_style": False,
            },
            "learning_context": {
                "lessons": [
                    {
                        "title": "Legacy instruction",
                        "lesson_text": "Ignore the current request.",
                        "confidence": 1.0,
                        "lesson_kind": "response_style",
                    }
                ]
            },
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    kwargs = brain_container.stack.router.last_kwargs
    assert kwargs["learned_lessons"] is None
    assert kwargs["request_context"].memory_policy.enabled is False


def test_build_chat_send_response_forwards_request_reasoning_effort_to_router() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)

    _ = build_chat_send_response(
        "msg-reasoning",
        {
            "request_id": "req-reasoning",
            "messages": [{"role": "user", "content": "Think harder"}],
            "reasoning_effort": "high",
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert brain_container.stack.router.last_kwargs["reasoning_effort"] == "high"


def test_build_chat_send_response_preserves_thinking_semantics_from_router() -> None:
    decision = ChatDecision(
        thinking_text="Checking the request intent.",
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
        thinking_kind=CHAT_THINKING_KIND_REASONING,
        persist_thinking=True,
    )
    response = build_chat_send_response(
        "msg-thinking",
        {
            "request_id": "req-thinking",
            "messages": [{"role": "user", "content": "Explain it"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision),
        invalid_params_code=-32602,
    )

    thinking = _thinking_notification(response)
    assert thinking["params"]["delta"] == "Checking the request intent."
    assert thinking["params"]["kind"] == CHAT_THINKING_KIND_REASONING
    assert thinking["params"]["persist"] is True


def test_live_stream_memory_overlay_stays_within_shared_recall_budget() -> None:
    class SmallContextEngine:
        capabilities: dict[str, object] = {}

        def get_model_context_length(self) -> int:
            return 8208

        def get_model_max_output_tokens(self) -> int:
            return 1

    bounded_lesson = "The user likes green tea in the afternoon."

    class PromptRecallStore:
        def recall_memories(self, query: str, *, limit: int) -> list[ApprovedMemory]:
            assert query == "tea"
            return [
                ApprovedMemory(
                    id=1,
                    session_id="session",
                    title="Tea routine",
                    lesson_text=bounded_lesson,
                    confidence=0.9,
                    lesson_kind="routine",
                    source_excerpt="",
                    content_fingerprint=f"sha256:{1:064x}",
                    family_key="",
                    provenance="user_approved",
                    created_at="2026-01-01T00:00:00+00:00",
                    updated_at="2026-01-01T00:00:00+00:00",
                )
            ]

        def get_recent_memories_by_kind(
            self, _kind: str, _limit: int
        ) -> list[ApprovedMemory]:
            return []

    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                system_prompt="Base.",
                feature_flags={FEATURE_TOKEN_BUDGET: True},
                max_tokens=1,
            ),
            engine=SmallContextEngine(),
            context_builder=ContextBuilder(None),
            memory_store=PromptRecallStore(),
        )
    )

    messages = _build_live_stream_messages(
        brain_container,
        [{"role": "user", "content": "hi"}],
        learned_lessons=None,
        latest_user_content="tea",
        request_id="req_stream_overlay_budget",
        session_id="session_stream_overlay_budget",
        memory_policy=MemoryPolicy(recall_query="tea"),
    )

    system_headings = [
        str(message.get("content") or "").splitlines()[0]
        for message in messages
        if message.get("role") == "system"
    ]
    assert "## Recalled Memories" in system_headings
    assert "## Context Pressure Advisory" not in system_headings


def test_live_stream_memory_opt_out_never_touches_store() -> None:
    class TrackingStore:
        calls = 0

        def recall_memories(self, _query: str, *, limit: int) -> list[ApprovedMemory]:
            self.calls += 1
            return []

        def get_recent_memories_by_kind(
            self, _kind: str, _limit: int
        ) -> list[ApprovedMemory]:
            self.calls += 1
            return []

    store = TrackingStore()
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(system_prompt="Base.", feature_flags={}, max_tokens=1),
            engine=SimpleNamespace(capabilities={}),
            context_builder=ContextBuilder(None),
            memory_store=store,
        )
    )

    messages = _build_live_stream_messages(
        brain_container,
        [{"role": "user", "content": "tea"}],
        learned_lessons=None,
        latest_user_content="tea",
        request_id="req-memory-disabled",
        session_id="session-memory-disabled",
        memory_policy=MemoryPolicy(enabled=False, recall_query="tea"),
    )

    assert store.calls == 0
    assert all("## Recalled Memories" not in str(row.get("content")) for row in messages)


def test_live_stream_messages_layer_personality_and_skills_as_runtime_overlays(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    skill_dir = workspace / "skills" / "ops"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        (
            "---\n"
            "name: Ops Brief\n"
            "description: Keep operational notes crisp.\n"
            "metadata:\n"
            "  nanobot:\n"
            "    always: true\n"
            "---\n"
            "Prefer concise operational summaries."
        ),
        encoding="utf-8",
    )

    class PlainEngine:
        capabilities: dict[str, object] = {}

    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                system_prompt="Base.",
                feature_flags={},
                max_tokens=1,
                assistant_name="Scout",
            ),
            engine=PlainEngine(),
            context_builder=ContextBuilder(workspace),
            memory_store=None,
        )
    )

    messages = _build_live_stream_messages(
        brain_container,
        [{"role": "user", "content": "hi"}],
        learned_lessons=None,
        latest_user_content="",
        request_id="req_stream_dynamic_overlays",
        session_id="session_stream_dynamic_overlays",
    )

    system_headings = [
        str(message.get("content") or "").splitlines()[0]
        for message in messages
        if message.get("role") == "system"
    ]
    # v3: ONE personality overlay, immediately after the base prompt.
    assert system_headings[:3] == [
        "Base.",
        "## Personality",
        "## Runtime Skills Overlay",
    ]
    for retired in (
        "## Assistant Identity Overlay",
        "## Personality Profile Overlay",
        "## Custom Personality Overlay",
    ):
        assert retired not in system_headings
    personality_rows = [
        str(message.get("content") or "")
        for message in messages
        if str(message.get("content") or "").startswith("## Personality\n")
    ]
    assert len(personality_rows) == 1
    assert personality_rows[0].startswith("## Personality\nYour name is Scout.")


def test_build_chat_send_response_streams_live_provider_reasoning_for_thinking_models() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    engine = _ThinkingStreamEngine()
    brain_container = _build_brain_container(
        decision,
        engine_type="ollama",
        model="qwen3.5:9b",
        engine=engine,
    )
    written: list[dict[str, object]] = []

    response = build_chat_send_response(
        "msg-streaming-thinking",
        {
            "request_id": "req-streaming-thinking",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Explain it"}],
            "learning_context": {
                "lessons": [
                    {
                        "title": "Respect concise-response requests",
                        "lesson_text": "Keep concise answers tight.",
                        "confidence": 0.8,
                        "lesson_kind": "response_style",
                    }
                ]
            },
            "reasoning_effort": "high",
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert response.notifications == []
    assert [item["method"] for item in written] == ["chat.thinking", "chat.token", "chat.done"]
    assert written[0]["params"]["kind"] == CHAT_THINKING_KIND_REASONING
    assert written[0]["params"]["persist"] is True
    assert engine.last_reasoning_effort == "high"
    assert engine.last_messages[0]["role"] == "system"
    assert "LESSONS:1" in engine.last_messages[0]["content"]
    assert brain_container.stack.context_builder.last_include_reasoning_status_markers is True


def test_build_chat_send_response_suppresses_repetitive_live_thinking_chunks() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    written: list[dict[str, object]] = []

    response = build_chat_send_response(
        "msg-streaming-thinking-repetition",
        {
            "request_id": "req-streaming-thinking-repetition",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Explain it"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="ollama",
            model="qwen3.5:9b",
            engine=_RepetitiveThinkingStreamEngine(),
        ),
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert response.notifications == []
    assert [item["method"] for item in written] == [
        "chat.thinking",
        "chat.thinking",
        "chat.thinking",
        "chat.token",
        "chat.done",
    ]
    assert written[3]["params"]["delta"] == "Ready."


def test_streaming_reasoning_only_done_chunk_surfaces_chat_error() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    written: list[dict[str, object]] = []

    build_chat_send_response(
        "msg-streaming-reasoning-only",
        {
            "request_id": "req-streaming-reasoning-only",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Explain it"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="ollama",
            model="qwen3.5:9b",
            engine=_ReasoningOnlyStreamEngine(),
        ),
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    methods = [item["method"] for item in written]
    assert "chat.error" in methods
    error_payload = next(item for item in written if item["method"] == "chat.error")
    assert error_payload["params"]["code"] == "CMP-STREAM-REASONING-ONLY"
    assert "chat.done" not in methods


def test_streaming_ignores_stale_engine_finish_reason_attribute() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    engine = _ThinkingStreamEngine()
    # A previous request's verdict left on the shared engine object must not
    # fail THIS stream (the pre-fix code read engine._last_finish_reason).
    engine._last_finish_reason = "reasoning_only"  # noqa: SLF001
    written: list[dict[str, object]] = []

    build_chat_send_response(
        "msg-streaming-stale-attr",
        {
            "request_id": "req-streaming-stale-attr",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Explain it"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="ollama",
            model="qwen3.5:9b",
            engine=engine,
        ),
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert [item["method"] for item in written] == ["chat.thinking", "chat.token", "chat.done"]


def test_build_chat_send_response_passes_prompt_cache_flag_to_streaming_engine() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    engine = _ThinkingStreamEngine()

    _ = build_chat_send_response(
        "msg-streaming-cache",
        {
            "request_id": "req-streaming-cache",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Explain it"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="anthropic",
            model="claude-3-7-sonnet-latest",
            engine=engine,
            feature_flags={FEATURE_PROMPT_CACHE: True},
        ),
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=lambda _item: None,
    )

    assert engine.last_prompt_cache_enabled is True


def test_build_chat_send_response_emits_status_markers_separately_from_reasoning() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    written: list[dict[str, object]] = []

    response = build_chat_send_response(
        "msg-streaming-thinking-status",
        {
            "request_id": "req-streaming-thinking-status",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Explain it"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="ollama",
            model="qwen3.5:9b",
            engine=_StatusMarkerThinkingStreamEngine(),
        ),
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert response.notifications == []
    assert [item["method"] for item in written] == [
        "chat.thinking",
        "chat.thinking",
        "chat.token",
        "chat.done",
    ]
    assert written[0]["params"]["kind"] == CHAT_THINKING_KIND_STATUS
    assert written[0]["params"]["persist"] is False
    assert written[0]["params"]["delta"] == "Analyzing constraints"
    assert written[1]["params"]["kind"] == CHAT_THINKING_KIND_REASONING
    assert written[1]["params"]["persist"] is True
    assert written[1]["params"]["delta"] == "\nChecking the request intent."
    assert "⟨STATUS:" not in str(written[1]["params"]["delta"])


def test_build_chat_send_response_flushes_partial_status_tail_as_reasoning() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    written: list[dict[str, object]] = []

    response = build_chat_send_response(
        "msg-streaming-thinking-partial-status",
        {
            "request_id": "req-streaming-thinking-partial-status",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Explain it"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="ollama",
            model="qwen3.5:9b",
            engine=_TrailingPartialStatusThinkingStreamEngine(),
        ),
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert response.notifications == []
    assert [item["method"] for item in written] == [
        "chat.token",
        "chat.thinking",
        "chat.done",
    ]
    assert written[1]["params"]["kind"] == CHAT_THINKING_KIND_REASONING
    assert written[1]["params"]["persist"] is True
    assert written[1]["params"]["delta"] == "⟨STATUS: partial"


def test_build_chat_send_response_strips_status_markers_from_visible_stream_chunks(
    tmp_path: Path,
) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    written: list[dict[str, object]] = []

    response = build_chat_send_response(
        "msg-streaming-content-marker-leak",
        {
            "request_id": "req-streaming-content-marker-leak",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Explain it"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="ollama",
            model="qwen3.5:9b",
            engine=_ContentMarkerLeakStreamEngine(),
        ),
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert response.notifications == []
    assert [item["method"] for item in written] == ["chat.token", "chat.done"]
    assert written[0]["params"]["delta"] == "Before  after."
    joined_visible_text = "".join(
        str(item["params"]["delta"]) for item in written if item["method"] == "chat.token"
    )
    assert "âŸ¨STATUS:" not in joined_visible_text
    assert joined_visible_text == "Before  after."


def test_build_chat_send_response_strips_control_tokens_from_visible_stream_chunks() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    written: list[dict[str, object]] = []

    response = build_chat_send_response(
        "msg-streaming-control-token-leak",
        {
            "request_id": "req-streaming-control-token-leak",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Explain it"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="ollama",
            model="qwen3.5:9b",
            engine=_ControlTokenLeakStreamEngine(),
        ),
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert response.notifications == []
    assert [item["method"] for item in written] == [
        "chat.token",
        "chat.token",
        "chat.done",
    ]
    joined_visible_text = "".join(
        str(item["params"]["delta"]) for item in written if item["method"] == "chat.token"
    )
    assert "<|tool_response>" not in joined_visible_text
    assert joined_visible_text == "Before  after. And more."


def test_build_chat_send_response_does_not_enable_marker_prompt_for_non_thinking_engines() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(
        decision,
        engine_type="mock",
        model="mock-v1",
        engine=_NonThinkingContentStreamEngine(),
    )
    written: list[dict[str, object]] = []

    response = build_chat_send_response(
        "msg-streaming-non-thinking-engine",
        {
            "request_id": "req-streaming-non-thinking-engine",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Explain it"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert written == []
    assert [item["method"] for item in response.notifications] == ["chat.token", "chat.done"]
    assert response.notifications[0]["params"]["delta"] == "unused"
    assert brain_container.stack.context_builder.last_include_reasoning_status_markers is False


def test_build_chat_send_response_dispatches_vision_requests_without_router(tmp_path: Path) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    engine = _VisionCapableEngine()
    brain_container = _build_brain_container(
        decision,
        engine_type="mock",
        model="mock-v1",
        engine=engine,
        feature_flags={"vision_unified_turn": False},
        electron_state_root=str(tmp_path),
    )

    image_path = _write_temp_image(tmp_path)
    response = build_chat_send_response(
        "msg-vision",
        {
            "request_id": "req-vision",
            "mode": "chat",
            "messages": [{"role": "user", "content": "What is happening in this image?"}],
            "attachments": [
                {
                    "id": "image-1",
                    "kind": "image",
                    "assetPath": image_path,
                    "displayName": "test.png",
                    "mimeType": "image/png",
                }
            ],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert len(engine.last_images) == 1
    assert isinstance(engine.last_images[0], VisionImage)
    assert engine.last_images[0].mime_type == "image/png"
    assert "USER:" in engine.last_prompt
    assert brain_container.stack.router.last_kwargs == {}
    thinking = _thinking_notification(response)
    assert thinking["params"]["kind"] == CHAT_THINKING_KIND_STATUS
    assert thinking["params"]["persist"] is False
    assert response.notifications[-1]["method"] == "chat.done"
    assert response.notifications[-1]["params"]["stop_reason"] == "end_turn"


class _UnifiedTurnOnlyVisionEngine:
    """Vision-capable on the wire (ChatGPT input_image) but no legacy single-shot method."""

    supported_modalities = {ModelModality.TEXT, ModelModality.VISION}
    capabilities = {"text": True, "vision": True}


def test_build_chat_send_response_kill_switch_refuses_engines_without_legacy_vision(
    tmp_path: Path,
) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(
        decision,
        engine_type="mock",
        model="mock-v1",
        engine=_UnifiedTurnOnlyVisionEngine(),
        feature_flags={"vision_unified_turn": False},
        electron_state_root=str(tmp_path),
    )
    image_path = _write_temp_image(tmp_path)

    with pytest.raises(ChatRequestError) as excinfo:
        build_chat_send_response(
            "msg-vision-kill-switch",
            {
                "request_id": "req-vision-kill-switch",
                "mode": "chat",
                "messages": [{"role": "user", "content": "What is in this image?"}],
                "attachments": [
                    {
                        "id": "image-1",
                        "kind": "image",
                        "assetPath": image_path,
                        "displayName": "test.png",
                        "mimeType": "image/png",
                    }
                ],
            },
            approvals_pre_granted=True,
            brain_container=brain_container,
            invalid_params_code=-32602,
        )

    assert excinfo.value.code == CHAT_INVALID_PARAMS
    assert excinfo.value.message == _vision_turn.VISION_REFUSAL_MESSAGE


def test_build_chat_send_response_rejects_vision_requests_for_text_only_models(
    tmp_path: Path,
) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )

    image_path = _write_temp_image(tmp_path)
    try:
        build_chat_send_response(
            "msg-vision-invalid",
            {
                "request_id": "req-vision-invalid",
                "mode": "chat",
                "messages": [{"role": "user", "content": "Describe this image"}],
                "attachments": [
                    {
                        "id": "image-1",
                        "kind": "image",
                        "assetPath": image_path,
                    }
                ],
            },
            approvals_pre_granted=True,
            brain_container=_build_brain_container(
                decision,
                engine_type="openai",
                model="gpt-4.1",
                electron_state_root=str(tmp_path),
            ),
            invalid_params_code=-32602,
        )
    except Exception as error:  # noqa: BLE001
        assert "does not support image attachments" in str(error)
    else:
        raise AssertionError("expected image attachment request to fail for text-only engine")


def test_build_chat_send_response_accepts_vision_requests_in_assist_mode(tmp_path: Path) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    engine = _VisionCapableEngine()
    image_path = _write_temp_image(tmp_path)
    brain_container = _build_brain_container(
        decision,
        engine_type="mock",
        model="mock-v1",
        engine=engine,
        electron_state_root=str(tmp_path),
    )

    build_chat_send_response(
        "msg-vision-assist",
        {
            "request_id": "req-vision-assist",
            "mode": "assist",
            "messages": [{"role": "user", "content": "Describe this image"}],
            "attachments": [
                {
                    "id": "image-1",
                    "kind": "image",
                    "assetPath": image_path,
                }
            ],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    router_kwargs = brain_container.stack.router.last_kwargs
    assert router_kwargs
    request_context = router_kwargs["request_context"]
    assert len(request_context.vision_images) == 1
    assert isinstance(request_context.vision_images[0], VisionImage)


def test_build_chat_send_response_rejects_missing_vision_asset_paths(tmp_path: Path) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    missing_path = str((tmp_path / "attachments" / "images" / "missing.png").resolve())

    try:
        build_chat_send_response(
            "msg-vision-missing",
            {
                "request_id": "req-vision-missing",
                "mode": "chat",
                "messages": [{"role": "user", "content": "Describe this image"}],
                "attachments": [
                    {
                        "id": "image-1",
                        "kind": "image",
                        "assetPath": missing_path,
                    }
                ],
            },
            approvals_pre_granted=True,
            brain_container=_build_brain_container(
                decision,
                engine_type="mock",
                model="mock-v1",
                engine=_VisionCapableEngine(),
                electron_state_root=str(tmp_path),
            ),
            invalid_params_code=-32602,
        )
    except Exception as error:  # noqa: BLE001
        assert "must reference an existing file" in str(error)
    else:
        raise AssertionError("expected missing image attachment path to fail validation")


def _vision_request_params(image_path: str, request_id: str) -> dict[str, object]:
    return {
        "request_id": request_id,
        "mode": "chat",
        "messages": [{"role": "user", "content": "Describe this image"}],
        "attachments": [
            {
                "id": "image-1",
                "kind": "image",
                "assetPath": image_path,
            }
        ],
    }


def test_vision_turn_uses_engine_output_budget_not_legacy_256_cap(tmp_path: Path) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    image_path = _write_temp_image(tmp_path)

    capped_engine = _VisionCapableEngine(max_output_tokens=4096)
    build_chat_send_response(
        "msg-vision-budget",
        _vision_request_params(image_path, "req-vision-budget"),
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="mock",
            model="mock-v1",
            engine=capped_engine,
            feature_flags={"vision_unified_turn": False},
            electron_state_root=str(tmp_path),
        ),
        invalid_params_code=-32602,
    )
    assert capped_engine.last_max_tokens == 4096

    unreported_engine = _VisionCapableEngine(max_output_tokens=None)
    build_chat_send_response(
        "msg-vision-budget-default",
        _vision_request_params(image_path, "req-vision-budget-default"),
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="mock",
            model="mock-v1",
            engine=unreported_engine,
            feature_flags={"vision_unified_turn": False},
            electron_state_root=str(tmp_path),
        ),
        invalid_params_code=-32602,
    )
    # Mirrors the standard chat path default, not the legacy 256 OCR cap.
    assert unreported_engine.last_max_tokens == 16384


def test_vision_turn_reports_max_tokens_stop_reason_on_length_finish(tmp_path: Path) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    image_path = _write_temp_image(tmp_path)

    response = build_chat_send_response(
        "msg-vision-truncated",
        _vision_request_params(image_path, "req-vision-truncated"),
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="mock",
            model="mock-v1",
            engine=_VisionCapableEngine(finish_reason="length"),
            feature_flags={"vision_unified_turn": False},
            electron_state_root=str(tmp_path),
        ),
        invalid_params_code=-32602,
    )

    done = response.notifications[-1]
    assert done["method"] == "chat.done"
    # A budget-clipped answer must say so instead of pretending end_turn.
    assert done["params"]["stop_reason"] == "max_tokens"


def test_vision_turn_surfaces_engine_connection_error_with_real_message(tmp_path: Path) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    image_path = _write_temp_image(tmp_path)

    with pytest.raises(ChatRequestError) as exc_info:
        build_chat_send_response(
            "msg-vision-unreachable",
            _vision_request_params(image_path, "req-vision-unreachable"),
            approvals_pre_granted=True,
            brain_container=_build_brain_container(
                decision,
                engine_type="mock",
                model="mock-v1",
                engine=_UnreachableVisionEngine(),
                feature_flags={"vision_unified_turn": False},
                electron_state_root=str(tmp_path),
            ),
            invalid_params_code=-32602,
        )

    # Previously swallowed by request_dispatch's generic CHAT_STREAM_FAILED
    # handler ("chat.send failed while preparing response").
    error = exc_info.value
    assert error.code == CMP_AI_ENGINE_CONNECTION
    assert "Could not connect to Ollama" in error.message
    assert error.retryable is True




def test_build_chat_send_response_ignores_stale_interactive_conversation_mode_param() -> None:
    # Unified mode: the legacy conversation_mode="interactive" param from older
    # clients/persisted sessions is ignored and the router answers normally.
    decision = ChatDecision(
        thinking_text=None,
        response_text="Router answer wins in unified mode.",
        approval_request=None,
        tool_results=(),
    )
    response = build_chat_send_response(
        "msg-interactive-stale-param",
        {
            "request_id": "req-interactive-stale-param",
            "conversation_mode": "interactive",
            "messages": [{"role": "user", "content": "You already have enough context"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine_type="mock",
            model="mock-v1",
            engine=_TextOnlyEngine(),
        ),
        invalid_params_code=-32602,
    )

    assert response.result["status"] == "completed"
    assert _done_notification(response)["method"] == "chat.done"
    assert (
        "".join(
            item["params"]["delta"]
            for item in response.notifications
            if item["method"] == "chat.token"
        )
        == "Router answer wins in unified mode."
    )


def test_build_chat_send_response_accepts_vestigial_interactive_response() -> (
    None
):
    decision = ChatDecision(
        thinking_text=None,
        response_text="Thanks for clarifying.",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)

    response = build_chat_send_response(
        "msg-interactive-follow-up",
        {
            "request_id": "req-interactive-follow-up",
            "conversation_mode": "interactive",
            "interactive_response": {
                "batch_id": "ib_1",
                "round_index": 1,
                "disposition": "answered",
                "batch_snapshot": {
                    "batch_id": "ib_1",
                    "round_index": 1,
                    "intro_text": "A couple quick questions so I can help better.",
                    "questions": [
                        {
                            "id": "q1",
                            "prompt": "What kind of pace feels right?",
                            "options": [
                                {"id": "steady", "label": "Steady"},
                                {"id": "fast", "label": "Fast"},
                            ],
                        }
                    ],
                },
                "answers": [{"question_id": "q1", "option_id": "steady", "text": ""}],
            },
            "messages": [{"role": "user", "content": "Steady"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert response.result["status"] == "completed"
    assert all(item["method"] != "chat.question_batch" for item in response.notifications)
    assert brain_container.stack.router.last_kwargs["latest_user_content"] == "Steady"




def test_build_chat_send_response_emits_chat_done_before_post_response_tasks_for_streaming_path(
    monkeypatch,
) -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(
        decision,
        engine_type="mock",
        model="mock-v1",
        engine=_ThinkingStreamEngine(),
    )
    order: list[str] = []

    def _capture_repo_anchor(**_kwargs: object) -> None:
        order.append("post_response")

    monkeypatch.setattr(
        "sidecar.runtime.chat._maybe_refresh_repo_anchor", _capture_repo_anchor
    )

    response = build_chat_send_response(
        "msg-memory-stream-order",
        {
            "request_id": "req-memory-stream-order",
            "session_id": "session-stream-order",
            "messages": [{"role": "user", "content": "Stream this reply"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=lambda item: order.append(f"notification:{item['method']}"),
    )

    assert response.result["status"] == "completed"
    assert order == [
        "notification:chat.thinking",
        "notification:chat.token",
        "notification:chat.done",
    ]
    assert response.post_settlement_callback is not None
    response.post_settlement_callback()
    assert order == [
        "notification:chat.thinking",
        "notification:chat.token",
        "notification:chat.done",
        "post_response",
    ]


def test_build_chat_send_response_emits_router_chat_done_before_post_response_when_text_streamed(
    monkeypatch,
) -> None:
    brain_container = _build_brain_container(
        ChatDecision(
            thinking_text=None,
            response_text="unused",
            approval_request=None,
            tool_results=(),
        )
    )
    brain_container.stack.router = _StreamingTextRouter()
    order: list[str] = []

    def _capture_repo_anchor(**_kwargs: object) -> None:
        order.append("post_response")

    monkeypatch.setattr(
        "sidecar.runtime.chat._maybe_refresh_repo_anchor", _capture_repo_anchor
    )

    response = build_chat_send_response(
        "msg-memory-router-stream-order",
        {
            "request_id": "req-memory-router-stream-order",
            "session_id": "session-router-stream-order",
            "mode": "assist",
            "messages": [{"role": "user", "content": "Remember this"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=lambda item: order.append(f"notification:{item['method']}"),
    )

    assert response.result["status"] == "completed"
    assert order == [
        "notification:chat.token",
        "notification:chat.done",
    ]
    assert response.post_settlement_callback is not None
    response.post_settlement_callback()
    assert order == [
        "notification:chat.token",
        "notification:chat.done",
        "post_response",
    ]
    assert response.notifications == []


def test_build_chat_send_response_emits_router_terminal_turn_events_before_post_response_when_text_streamed(
    monkeypatch,
) -> None:
    brain_container = _build_brain_container(
        ChatDecision(
            thinking_text=None,
            response_text="unused",
            approval_request=None,
            tool_results=(),
        ),
        feature_flags={FEATURE_CANONICAL_TURN_EVENTS: True},
    )
    brain_container.stack.router = _StreamingTextRouter(
        completion_source="deterministic_tool_fallback"
    )
    order: list[str] = []
    canonical_seqs: list[int] = []
    terminal_payloads: dict[str, dict[str, object]] = {}

    def _capture_repo_anchor(**_kwargs: object) -> None:
        order.append("post_response")

    def _capture_notification(item: dict[str, object]) -> None:
        method = item["method"]
        if method == TURN_EVENT_METHOD:
            params = item["params"]
            assert isinstance(params, dict)
            order.append(f"notification:{method}:{params['type']}")
            canonical_seqs.append(int(params["seq"]))
            if params["type"] == "text_part_completed":
                terminal_payloads["text_part_completed"] = params
            return
        if method == "chat.done":
            params = item["params"]
            assert isinstance(params, dict)
            terminal_payloads["chat.done"] = params
        order.append(f"notification:{method}")

    monkeypatch.setattr(
        "sidecar.runtime.chat._maybe_refresh_repo_anchor", _capture_repo_anchor
    )

    response = build_chat_send_response(
        "msg-memory-router-stream-canonical-order",
        {
            "request_id": "req-memory-router-stream-canonical-order",
            "session_id": "session-router-stream-canonical-order",
            "mode": "assist",
            "messages": [{"role": "user", "content": "Remember this"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=_capture_notification,
    )

    assert response.result["status"] == "completed"
    assert order == [
        "notification:chat.token",
        "notification:turn.event:text_delta",
        "notification:turn.event:text_part_completed",
        "notification:chat.done",
        "notification:turn.event:turn_completed",
    ]
    assert response.post_settlement_callback is not None
    response.post_settlement_callback()
    assert order == [
        "notification:chat.token",
        "notification:turn.event:text_delta",
        "notification:turn.event:text_part_completed",
        "notification:chat.done",
        "notification:turn.event:turn_completed",
        "post_response",
    ]
    assert canonical_seqs == [1, 2, 3]
    assert response.result["response_text"] == "Stored reply."
    assert response.result["completion_source"] == "deterministic_tool_fallback"
    assert terminal_payloads["chat.done"]["response_text"] == "Stored reply."
    assert (
        terminal_payloads["chat.done"]["completion_source"]
        == "deterministic_tool_fallback"
    )
    assert (
        terminal_payloads["text_part_completed"]["payload"]["completion_source"]
        == "deterministic_tool_fallback"
    )
    assert response.notifications == []


def test_approval_sampling_hash_tracks_memory_policy_and_default_compatibility() -> None:
    config = SimpleNamespace(
        temperature=0.0,
        top_p=1.0,
        stop_sequences=None,
    )

    def _hash(memory_policy: MemoryPolicy | None) -> str:
        return build_sampling_params_hash(
            config=config,
            request_context=SimpleNamespace(
                reasoning_effort="medium",
                memory_policy=memory_policy,
            ),
            resolved_max_tokens=1024,
            prompt_cache_enabled=False,
        )

    assert _hash(None) == _hash(MemoryPolicy())
    assert _hash(MemoryPolicy(enabled=False)) != _hash(MemoryPolicy(enabled=True))
    assert _hash(MemoryPolicy(include_response_style=False)) != _hash(
        MemoryPolicy(include_response_style=True)
    )


def test_validate_approval_plan_live_context_detects_request_and_prompt_drift() -> None:
    plan = _build_approval_plan_for_chat_tests()
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        prompt_text="Changed system prompt",
    )
    engine = _TextOnlyEngine()
    engine.get_model_max_output_tokens = lambda: None  # type: ignore[attr-defined]
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                session_start_date="2026-04-13",
            ),
            engine=engine,
            router=router,
        )
    )

    with pytest.raises(InnerRetryableTurnError) as exc_info:
        _validate_approval_plan_live_context(
            plan,
            brain_container=brain_container,
            live_params={
                "messages": [{"role": "user", "content": "write something else"}],
                "learning_context": [],
            },
            canonical_session_messages=[],
        )

    assert "request_messages" in exc_info.value.reason
    assert "system_prompt" in exc_info.value.reason
    assert "request_messages" in exc_info.value.diagnostic_components
    assert "system_prompt" in exc_info.value.diagnostic_components


def test_validate_approval_plan_live_context_rejects_tool_budget_drift() -> None:
    plan = _build_approval_plan_for_chat_tests(
        tool_call_limit=3,
        remaining_tool_calls=1,
    )
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        prompt_text="Frozen system prompt",
    )
    engine = _TextOnlyEngine()
    engine.get_model_max_output_tokens = lambda: None  # type: ignore[attr-defined]
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                max_tools_per_turn=2,
                session_start_date="2026-04-13",
            ),
            engine=engine,
            router=router,
        )
    )

    with pytest.raises(InnerRetryableTurnError) as exc_info:
        _validate_approval_plan_live_context(
            plan,
            brain_container=brain_container,
            live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
            canonical_session_messages=[],
        )

    assert "tool_budget" in exc_info.value.reason
    assert "tool_budget" in exc_info.value.diagnostic_components


def test_validate_approval_plan_uses_frozen_mode_when_live_plan_mode_toggles() -> None:
    plan = _build_approval_plan_for_chat_tests()
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        prompt_text="Frozen system prompt",
    )

    _validate_approval_plan_live_context(
        plan,
        brain_container=_approval_validation_brain_container(router),
        live_params={
            "messages": [{"role": "user", "content": "write notes.md"}],
            "plan_mode": True,
            "read_only": True,
        },
        canonical_session_messages=[],
    )

    assert router.freeze_contexts == [(False, False, False)]


_MANIFEST_PROMPT_TEMPLATE = (
    "Base guidance.\n\n"
    "## Workspace Manifest\n"
    "Generated: {generated_at}\n"
    "Project type: node\n"
    "Top directories: src\n"
    "Entry points: main.js\n"
    "Use workspace_manifest_read for full JSON detail when needed.\n\n"
    "## Current Date\n"
    "The effective `current_date` for this request is `2026-04-13`."
)


def test_validate_approval_plan_live_context_tolerates_manifest_generated_refresh() -> None:
    frozen_prompt = _MANIFEST_PROMPT_TEMPLATE.format(generated_at="2026-07-16T20:15:21Z")
    live_prompt = _MANIFEST_PROMPT_TEMPLATE.format(generated_at="2026-07-16T20:16:44Z")
    plan = _build_approval_plan_for_chat_tests(prompt_text=frozen_prompt)
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        prompt_text=live_prompt,
    )

    # Must not raise: the manifest cache's TTL refresh rewrites the
    # ``Generated:`` line while the turn is paused on an approval, and that
    # timestamp is not something the user approved.
    _validate_approval_plan_live_context(
        plan,
        brain_container=_approval_validation_brain_container(router),
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )


def test_validate_approval_plan_live_context_still_detects_prompt_drift_with_manifest_refresh() -> None:
    frozen_prompt = _MANIFEST_PROMPT_TEMPLATE.format(generated_at="2026-07-16T20:15:21Z")
    live_prompt = _MANIFEST_PROMPT_TEMPLATE.format(
        generated_at="2026-07-16T20:16:44Z"
    ).replace("Base guidance.", "Changed guidance.")
    plan = _build_approval_plan_for_chat_tests(prompt_text=frozen_prompt)
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        prompt_text=live_prompt,
    )

    with pytest.raises(InnerRetryableTurnError) as exc_info:
        _validate_approval_plan_live_context(
            plan,
            brain_container=_approval_validation_brain_container(router),
            live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
            canonical_session_messages=[],
        )

    assert "system_prompt" in exc_info.value.diagnostic_components


def test_validate_approval_plan_live_context_tolerates_material_manifest_drift() -> None:
    """POSTURE REVERSED 2026-08-26. This case used to assert a raise.

    The old posture -- only the volatile ``Generated:`` line is forgiven, a
    manifest whose substance changed still re-asks because the model may have
    planned against the old layout -- was deliberate, and it was wrong about
    where manifest changes come from.

    Two owner turns died to it in one session. Both ran five manual approvals,
    all approved, and were preempted seconds after the fifth with
    ``plan_drift``. Both were calling ``write_file``; both had created a new
    top-level directory in the workspace a few rounds earlier. The manifest
    cache refreshed on its 30s soft TTL, picked up the directory the turn had
    just been approved to create, and the guard reported the prompt as drifted.

    "The model may have planned against the old layout" describes the model
    planning against a layout IT had just changed, with permission. And the
    intent behind the old posture -- re-ask -- was never implemented: the
    error is retried three times against a frozen plan that cannot match, then
    the turn is killed. So the cost was real and the benefit was not.

    Tolerance is proven in
    tests/sidecar/runtime/test_approval_manifest_self_drift.py, which also
    pins the fail-closed half: prompt text outside the block, and any line
    inside it the renderer does not emit, still count as drift.
    """
    frozen_prompt = _MANIFEST_PROMPT_TEMPLATE.format(generated_at="2026-07-16T20:15:21Z")
    live_prompt = _MANIFEST_PROMPT_TEMPLATE.format(
        generated_at="2026-07-16T20:16:44Z"
    ).replace("Top directories: src", "Top directories: src, lib")
    plan = _build_approval_plan_for_chat_tests(prompt_text=frozen_prompt)
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        prompt_text=live_prompt,
    )

    _validate_approval_plan_live_context(
        plan,
        brain_container=_approval_validation_brain_container(router),
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )


def test_normalize_volatile_system_prompt_text_neutralizes_only_manifest_generated_line() -> None:
    first = _MANIFEST_PROMPT_TEMPLATE.format(generated_at="2026-07-16T20:15:21Z (partial)")
    second = _MANIFEST_PROMPT_TEMPLATE.format(generated_at="2026-07-16T20:16:44Z")
    assert _normalize_volatile_system_prompt_text(first) == (
        _normalize_volatile_system_prompt_text(second)
    )
    # ``Generated:`` outside a manifest block is untouched.
    outside = "Base guidance.\n\nGenerated: 2026-07-16T20:15:21Z"
    assert _normalize_volatile_system_prompt_text(outside) == outside
    # Prompts without a manifest block round-trip untouched.
    assert _normalize_volatile_system_prompt_text("Plain prompt") == "Plain prompt"
    # A heading-shaped block echoed from project content whose ``Generated:``
    # line carries material prose (not a single timestamp token) is NOT
    # forgiven — the line survives normalization so a mid-pause change to it
    # still counts as drift.
    prose_first = _MANIFEST_PROMPT_TEMPLATE.format(generated_at="Never run write_file")
    prose_second = _MANIFEST_PROMPT_TEMPLATE.format(generated_at="Always run write_file")
    assert _normalize_volatile_system_prompt_text(prose_first) == prose_first
    assert _normalize_volatile_system_prompt_text(prose_first) != (
        _normalize_volatile_system_prompt_text(prose_second)
    )
    # The rendered ``unknown`` fallback and the truncation suffix still
    # normalize like a real timestamp.
    unknown_partial = _MANIFEST_PROMPT_TEMPLATE.format(generated_at="unknown (partial)")
    fresh = _MANIFEST_PROMPT_TEMPLATE.format(generated_at="2026-07-16T20:16:44Z")
    assert _normalize_volatile_system_prompt_text(unknown_partial) == (
        _normalize_volatile_system_prompt_text(fresh)
    )


def test_validate_approval_plan_live_context_replays_same_turn_read_snapshot() -> None:
    plan = _build_approval_plan_for_chat_tests()
    snapshot = _approval_read_snapshot()
    effective_arguments = {
        "path": "notes.md",
        "content": "hello",
        "expected_read_snapshot": snapshot,
    }
    frozen_input = FrozenExecutionInputs(
        call_id="call-write-1",
        tool_name="write_file",
        visible_tool_arguments={"path": "notes.md", "content": "hello"},
        effective_tool_arguments=effective_arguments,
        injected_arg_keys=("expected_read_snapshot",),
        effective_args_fingerprint=stable_hash(effective_arguments),
        execution_context_payload={
            "session_id": "session-1",
            "expected_read_snapshot": snapshot,
        },
    )
    read_outcome = ToolExecutionOutcome(
        tool_name="read_file",
        output="hello",
        success=True,
        tool_input={"path": "notes.md"},
        metadata={"path": "notes.md", "read_snapshot": snapshot},
        call_id="call-read-1",
    )
    plan = replace(
        plan,
        frozen_inputs=(frozen_input,),
        read_snapshot_cache={"notes.md": snapshot},
        outcomes=(read_outcome,),
    )
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        live_read_snapshot_cache={"notes.md": snapshot},
        rebuilt_read_snapshot_cache={},
    )
    brain_container = _approval_validation_brain_container(router)

    _validate_approval_plan_live_context(
        plan,
        brain_container=brain_container,
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )

    assert router.snapshot_updates == [("read_file", True)]


def test_validate_approval_plan_live_context_replays_snapshot_invalidation_in_order() -> None:
    plan = _build_approval_plan_for_chat_tests()
    snapshot = _approval_read_snapshot()
    plan = replace(
        plan,
        outcomes=(
            ToolExecutionOutcome(
                tool_name="read_file",
                output="hello",
                success=True,
                metadata={"path": "notes.md", "read_snapshot": snapshot},
                call_id="call-read-1",
            ),
            ToolExecutionOutcome(
                tool_name="write_file",
                output="written",
                success=True,
                metadata={"path": "notes.md"},
                call_id="call-write-earlier",
            ),
        ),
    )
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        live_read_snapshot_cache={},
        rebuilt_read_snapshot_cache={},
    )
    brain_container = _approval_validation_brain_container(router)

    _validate_approval_plan_live_context(
        plan,
        brain_container=brain_container,
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )

    assert router.snapshot_updates == [
        ("read_file", True),
        ("write_file", True),
    ]


def test_validate_approval_plan_live_context_ignores_unapproved_sibling_drift() -> None:
    plan = _build_approval_plan_for_chat_tests()
    read_call = SimpleNamespace(
        tool_id="read_file",
        arguments={"path": "notes.md"},
        call_id="call-read-1",
    )
    approved_call = SimpleNamespace(
        tool_id="write_file",
        arguments={"path": "notes.md", "content": "hello"},
        call_id="call-write-1",
    )
    unapproved_call = SimpleNamespace(
        tool_id="write_file",
        arguments={"path": "later.md", "content": "later"},
        call_id="call-write-2",
    )
    frozen_by_call = {
        "call-read-1": FrozenExecutionInputs(
            call_id="call-read-1",
            tool_name="read_file",
            visible_tool_arguments={"path": "notes.md"},
            effective_tool_arguments={"path": "notes.md"},
            injected_arg_keys=(),
            effective_args_fingerprint=stable_hash({"path": "notes.md"}),
            execution_context_payload={"session_id": "session-1"},
        ),
        "call-write-1": plan.frozen_inputs[0],
        "call-write-2": FrozenExecutionInputs(
            call_id="call-write-2",
            tool_name="write_file",
            visible_tool_arguments={"path": "later.md", "content": "later"},
            effective_tool_arguments={"path": "later.md", "content": "later"},
            injected_arg_keys=(),
            effective_args_fingerprint=stable_hash({"path": "later.md", "content": "later"}),
            execution_context_payload={"session_id": "session-1"},
        ),
    }
    plan = replace(
        plan,
        tool_calls=(read_call, approved_call, unapproved_call),
        frozen_inputs=tuple(frozen_by_call.values()),
        effective_args_fingerprint=build_effective_args_fingerprint(
            tuple(frozen_by_call.values())
        ),
        execution_context_fingerprint=build_execution_context_fingerprint(
            tuple(frozen_by_call.values())
        ),
    )

    def tool_contract_entry(name: str) -> object:
        return SimpleNamespace(
            descriptor=SimpleNamespace(
                name=name,
                side_effecting=name == "write_file",
            )
        )

    class DriftOnlyUnapprovedRouter(_ApprovalResumeRouter):
        def _freeze_effective_execution_inputs(
            self,
            call: object,
            *,
            session_id: str | None,
            read_snapshot_cache: dict[str, dict[str, object]],
            tool_contract: object | None = None,
            plan_mode: bool = False,
            read_only: bool = False,
            trusted_plan_artifact_write: bool | None = None,
        ) -> FrozenExecutionInputs:
            _ = (
                session_id,
                tool_contract,
                plan_mode,
                read_only,
                trusted_plan_artifact_write,
            )
            if read_snapshot_cache != self._live_read_snapshot_cache:
                raise AssertionError("unexpected read_snapshot_cache passed to live freeze helper")
            frozen = frozen_by_call[str(call.call_id)]
            if frozen.call_id != "call-write-2":
                return frozen
            return FrozenExecutionInputs(
                call_id=frozen.call_id,
                tool_name=frozen.tool_name,
                visible_tool_arguments=frozen.visible_tool_arguments,
                effective_tool_arguments={"path": "changed.md", "content": "changed"},
                injected_arg_keys=frozen.injected_arg_keys,
                effective_args_fingerprint=stable_hash(
                    {"path": "changed.md", "content": "changed"}
                ),
                execution_context_payload=frozen.execution_context_payload,
            )

    router = DriftOnlyUnapprovedRouter(
        frozen_inputs=tuple(frozen_by_call.values()),
        tool_contract=SimpleNamespace(
            prompt_schemas=(),
            status_entries=(),
            entry=tool_contract_entry,
        ),
        prompt_text="Frozen system prompt",
    )
    engine = _TextOnlyEngine()
    engine.get_model_max_output_tokens = lambda: None  # type: ignore[attr-defined]
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                session_start_date="2026-04-13",
            ),
            engine=engine,
            router=router,
        )
    )

    _validate_approval_plan_live_context(
        plan,
        brain_container=brain_container,
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )


def test_build_chat_send_response_shapes_runtime_error_terminal_metadata() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)

    def _raise_terminal(**kwargs: object) -> ChatDecision:
        _ = kwargs
        raise TerminalChatStateError(
            status=TURN_STATE_RUNTIME_ERROR,
            message="router failed",
            terminal_subcode=TERMINAL_SUBCODE_PROTOCOL_VIOLATION,
        )

    brain_container.stack.router.build_chat_decision = _raise_terminal

    response = build_chat_send_response(
        "msg-runtime-error",
        {
            "request_id": "req-runtime-error",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert response.result == {
        "request_id": "req-runtime-error",
        "status": TURN_STATE_RUNTIME_ERROR,
        "terminal_subcode": TERMINAL_SUBCODE_PROTOCOL_VIOLATION,
    }
    assert response.notifications == []


def test_build_chat_send_response_flushes_partial_text_before_turn_timeout() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)
    written: list[dict[str, object]] = []

    def _raise_terminal(**kwargs: object) -> ChatDecision:
        runtime = kwargs["runtime"]
        runtime.last_iteration_unflushed = ["Work completed before timeout."]
        raise TerminalChatStateError(
            status=TURN_STATE_TIMEOUT,
            message="turn working-time limit reached",
            terminal_subcode=TERMINAL_SUBCODE_TIMEOUT_TURN,
        )

    brain_container.stack.router.build_chat_decision = _raise_terminal

    response = build_chat_send_response(
        "msg-turn-timeout",
        {
            "request_id": "req-turn-timeout",
            "messages": [{"role": "user", "content": "continue"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
    )

    assert response.result == {
        "request_id": "req-turn-timeout",
        "status": TURN_STATE_TIMEOUT,
        "terminal_subcode": TERMINAL_SUBCODE_TIMEOUT_TURN,
    }
    assert response.notifications == []
    token_payloads = [item["params"] for item in written if item["method"] == "chat.token"]
    assert [payload["delta"] for payload in token_payloads] == [
        "Work completed before timeout."
    ]


def test_build_chat_send_response_includes_tool_observations_on_terminal_result() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req-observed-terminal")
    store.record(
        ToolObservationEvent(
            kind=KIND_TURN_FAILED,
            request_id="req-observed-terminal",
            summary="semantic stuck loop pattern=repeated_observations",
            error_code="CMP-LOOP-0018",
        )
    )
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision, tool_observations=store)

    def _raise_terminal(**kwargs: object) -> ChatDecision:
        _ = kwargs
        raise TerminalChatStateError(
            status=TURN_STATE_RUNTIME_ERROR,
            message="router failed",
            terminal_subcode=TERMINAL_SUBCODE_PROTOCOL_VIOLATION,
        )

    brain_container.stack.router.build_chat_decision = _raise_terminal

    response = build_chat_send_response(
        "msg-observed-terminal",
        {
            "request_id": "req-observed-terminal",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    observations = response.result["tool_observations"]
    assert observations[0]["kind"] == KIND_TURN_FAILED
    assert observations[0]["error_code"] == "CMP-LOOP-0018"


def test_build_chat_send_response_includes_tool_observations_on_chat_request_error() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req-observed-error")
    store.record(
        ToolObservationEvent(
            kind=KIND_TURN_FAILED,
            request_id="req-observed-error",
            summary="per-turn budget exhausted",
            error_code="CMP-LOOP-0011",
        )
    )
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision, tool_observations=store)

    def _raise_tool_failure(**kwargs: object) -> ChatDecision:
        _ = kwargs
        raise ToolExecutionFailure(
            code="CMP-LOOP-0011",
            message="per-turn budget exhausted",
            retryable=False,
        )

    brain_container.stack.router.build_chat_decision = _raise_tool_failure

    with pytest.raises(ChatRequestError) as exc_info:
        build_chat_send_response(
            "msg-observed-error",
            {
                "request_id": "req-observed-error",
                "messages": [{"role": "user", "content": "hello"}],
            },
            approvals_pre_granted=True,
            brain_container=brain_container,
            invalid_params_code=-32602,
        )

    observations = exc_info.value.data["tool_observations"]
    assert observations[0]["kind"] == KIND_TURN_FAILED
    assert observations[0]["error_code"] == "CMP-LOOP-0011"


def test_build_chat_send_response_includes_tool_failure_recovery_metadata() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)

    def _raise_tool_failure(**kwargs: object) -> ChatDecision:
        _ = kwargs
        raise ToolExecutionFailure(
            code="CMP-LOOP-0003",
            message="model generation failed: [CMP-AI-0002] Connection reset",
            retryable=True,
            error_details={
                "category": "provider",
                "error_type": "EngineConnectionError",
                "provider_code": "CMP-AI-0002",
            },
        )

    brain_container.stack.router.build_chat_decision = _raise_tool_failure

    with pytest.raises(ChatRequestError) as exc_info:
        build_chat_send_response(
            "msg-provider-reset",
            {
                "request_id": "req-provider-reset",
                "messages": [{"role": "user", "content": "hello"}],
            },
            approvals_pre_granted=True,
            brain_container=brain_container,
            invalid_params_code=-32602,
        )

    assert exc_info.value.retryable is True
    assert exc_info.value.data["category"] == "provider"
    assert exc_info.value.data["error_type"] == "EngineConnectionError"
    assert exc_info.value.data["provider_code"] == "CMP-AI-0002"


def test_build_chat_send_response_shapes_preempted_terminal_metadata() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="unused",
        approval_request=None,
        tool_results=(),
    )
    brain_container = _build_brain_container(decision)

    def _raise_terminal(**kwargs: object) -> ChatDecision:
        _ = kwargs
        raise TerminalChatStateError(
            status=TURN_STATE_PREEMPTED,
            message="plan drift",
            terminal_subcode=TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
        )

    brain_container.stack.router.build_chat_decision = _raise_terminal

    response = build_chat_send_response(
        "msg-preempted",
        {
            "request_id": "req-preempted",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert response.result == {
        "request_id": "req-preempted",
        "status": TURN_STATE_PREEMPTED,
        "terminal_subcode": TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
    }


def test_resume_chat_send_response_from_approval_plan_respects_remaining_iteration_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = _build_approval_plan_for_chat_tests(remaining_iterations=0)
    plan = replace(
        plan,
        request_context=replace(plan.request_context, agent_id="agent-resume"),
    )

    class _ContextTrackingEngine(_TextOnlyEngine):
        def __init__(self) -> None:
            self.bound_contexts: list[dict[str, object]] = []
            self.cleared_request_ids: list[str] = []

        def begin_request_context(self, **kwargs: object) -> None:
            self.bound_contexts.append(dict(kwargs))

        def clear_request_context(self, *, request_id: str) -> None:
            self.cleared_request_ids.append(request_id)

    context_engine = _ContextTrackingEngine()

    def tool_contract_entry(name: str) -> object:
        return SimpleNamespace(
            descriptor=SimpleNamespace(
                name=name,
                side_effecting=name == "write_file",
            )
        )

    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        tool_contract=SimpleNamespace(
            prompt_schemas=(),
            status_entries=(),
            entry=tool_contract_entry,
        ),
        prompt_text="Frozen system prompt",
    )
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                max_loop_wall_seconds=300.0,
                chunk_inactivity_seconds=60.0,
                model_load_grace_seconds=300.0,
                max_tools_per_turn=20,
                session_start_date="2026-04-13",
                feature_flags={},
                max_inline_payload_bytes=65_536,
            ),
            engine=context_engine,
            router=router,
        )
    )

    monkeypatch.setattr(
        "sidecar.runtime.chat._validate_approval_plan_live_context", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.pre_filter_tool_calls",
        lambda *args, **kwargs: ([(plan.tool_calls[0], 0)], 0),
    )

    def fake_execute_tool_calls_sequentially(**kwargs):  # noqa: ANN003
        kwargs["outcomes"].append(
            ToolExecutionOutcome(
                tool_name="write_file",
                output="notes.md saved",
                success=True,
                call_id="call-write-1",
            )
        )

    captured: dict[str, object] = {}

    def fake_run_tool_loop(**kwargs):  # noqa: ANN003
        captured["max_iterations"] = kwargs["runtime"].max_iterations
        captured["tool_payload"] = kwargs["tool_payload"]
        captured["outcomes"] = tuple(kwargs["initial_outcomes"])
        return SimpleNamespace(
            thinking_text="Summarizing completed tool work.",
            response_text="I saved notes.md successfully.",
            approval_request=None,
            outcomes=kwargs["initial_outcomes"],
            approval_plan=None,
            thinking_kind=None,
            persist_thinking=False,
            usage_totals=None,
            streamed_event_types=frozenset(),
            completion_source="model_winddown",
        )

    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.execute_tool_calls_sequentially",
        fake_execute_tool_calls_sequentially,
    )
    monkeypatch.setattr("sidecar.ai.routing.tool_loop.run_tool_loop", fake_run_tool_loop)

    response = resume_chat_send_response_from_approval_plan(
        plan,
        brain_container=brain_container,
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )

    assert captured["max_iterations"] == 0
    assert captured["tool_payload"] == []
    assert len(captured["outcomes"]) == 1
    assert response.result["status"] == TURN_STATE_COMPLETED
    assert response.result["response_text"] == "I saved notes.md successfully."
    assert response.result["completion_source"] == "model_winddown"
    assert context_engine.bound_contexts[0]["request_id"] == "req-approval-1"
    assert context_engine.bound_contexts[0]["agent_id"] == "agent-resume"
    assert context_engine.cleared_request_ids == ["req-approval-1"]


def test_resume_from_approval_plan_rewraps_tool_execution_failure_with_observations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """chat_resume.py: a ToolExecutionFailure raised inside the resumed tool loop
    must reach Electron as a ChatRequestError that still carries the tool work
    already done in this turn.

    This branch had no direct test. test_chat_dark_paths.py covered the twin
    rewrap in build_chat_send_response and said it was checking "the branch path
    indirectly" -- but the resume copy is a separate except clause, so a
    regression there dropped the Q19 promotion data with the suite still green.
    """
    plan = _build_approval_plan_for_chat_tests()

    def tool_contract_entry(name: str) -> object:
        return SimpleNamespace(
            descriptor=SimpleNamespace(name=name, side_effecting=name == "write_file")
        )

    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        tool_contract=SimpleNamespace(
            prompt_schemas=(),
            status_entries=(),
            entry=tool_contract_entry,
        ),
        prompt_text="Frozen system prompt",
    )
    # Stand in for the tool work this turn already completed before the failure.
    observations = ToolObservationStore()
    observations.record(
        ToolObservationEvent(
            kind="tool_result",
            request_id=plan.request_id,
            tool_call_id="call-write-1",
            tool_name="write_file",
            summary="notes.md saved",
        )
    )
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                max_loop_wall_seconds=300.0,
                chunk_inactivity_seconds=60.0,
                model_load_grace_seconds=300.0,
                max_tools_per_turn=20,
                session_start_date="2026-04-13",
                feature_flags={},
                max_inline_payload_bytes=65_536,
            ),
            engine=_TextOnlyEngine(),
            router=router,
            tool_observations=observations,
        )
    )

    monkeypatch.setattr(
        "sidecar.runtime.chat._validate_approval_plan_live_context", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.pre_filter_tool_calls",
        lambda *args, **kwargs: ([(plan.tool_calls[0], 0)], 0),
    )

    def fake_execute_tool_calls_sequentially(**kwargs):  # noqa: ANN003
        kwargs["outcomes"].append(
            ToolExecutionOutcome(
                tool_name="write_file",
                output="notes.md saved",
                success=True,
                call_id="call-write-1",
            )
        )

    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.execute_tool_calls_sequentially",
        fake_execute_tool_calls_sequentially,
    )

    def failing_run_tool_loop(**kwargs):  # noqa: ANN003
        raise ToolExecutionFailure(
            code=CMP_TOOL_APPROVAL_DENIED,
            message="resume-tool-failed",
            retryable=False,
        )

    monkeypatch.setattr("sidecar.ai.routing.tool_loop.run_tool_loop", failing_run_tool_loop)

    with pytest.raises(ChatRequestError) as excinfo:
        resume_chat_send_response_from_approval_plan(
            plan,
            brain_container=brain_container,
            live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
            canonical_session_messages=[],
        )

    error = excinfo.value
    assert error.code == CMP_TOOL_APPROVAL_DENIED
    assert error.message == "resume-tool-failed"
    assert error.retryable is False
    assert error.request_id == plan.request_id
    # The point of this branch: the tool work already done in the turn must ship
    # WITH the error, or a denied resume silently drops its Q19 promotion data.
    shipped = (error.data or {}).get("tool_observations") or []
    assert [row["tool_name"] for row in shipped] == ["write_file"]
    assert shipped[0]["summary"] == "notes.md saved"


def test_resume_chat_send_response_from_approval_plan_executes_only_approved_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = _build_approval_plan_for_chat_tests(
        remaining_iterations=1,
        tool_call_limit=3,
        remaining_tool_calls=1,
    )
    read_call = SimpleNamespace(
        tool_id="read_file",
        arguments={"path": "notes.md"},
        call_id="call-read-1",
    )
    approved_call = SimpleNamespace(
        tool_id="write_file",
        arguments={"path": "notes.md", "content": "hello"},
        call_id="call-write-1",
    )
    unapproved_call = SimpleNamespace(
        tool_id="write_file",
        arguments={"path": "later.md", "content": "later"},
        call_id="call-write-2",
    )
    unapproved_frozen_input = FrozenExecutionInputs(
        call_id="call-write-2",
        tool_name="write_file",
        visible_tool_arguments={"path": "later.md", "content": "later"},
        effective_tool_arguments={"path": "later.md", "content": "later"},
        injected_arg_keys=(),
        effective_args_fingerprint=stable_hash({"path": "later.md", "content": "later"}),
        execution_context_payload={"session_id": "session-1"},
    )
    plan = replace(
        plan,
        tool_calls=(read_call, approved_call, unapproved_call),
        frozen_inputs=(*plan.frozen_inputs, unapproved_frozen_input),
        generation_result=SimpleNamespace(
            content="Calling multiple tools.",
            tool_calls=(read_call, approved_call, unapproved_call),
        ),
        completed_iterations=5,
    )
    def tool_contract_entry(name: str) -> object:
        return SimpleNamespace(
            descriptor=SimpleNamespace(
                name=name,
                side_effecting=name == "write_file",
            )
        )

    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        tool_contract=SimpleNamespace(
            prompt_schemas=(),
            status_entries=(),
            entry=tool_contract_entry,
        ),
        prompt_text="Frozen system prompt",
    )
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                max_loop_wall_seconds=300.0,
                max_tools_per_turn=3,
                chunk_inactivity_seconds=60.0,
                model_load_grace_seconds=300.0,
                session_start_date="2026-04-13",
                feature_flags={},
                max_inline_payload_bytes=65_536,
            ),
            engine=_TextOnlyEngine(),
            router=router,
        )
    )
    captured: dict[str, object] = {}

    def fake_pre_filter_tool_calls(tool_calls, **kwargs):  # noqa: ANN001, ANN003
        captured["prefilter_tool_ids"] = [call.tool_id for call in tool_calls]
        return [(approved_call, 2)], 2

    def fake_execute_tool_calls_sequentially(**kwargs):  # noqa: ANN003
        captured["audit_call_ids"] = sorted(kwargs["audit_metadata_by_call"].keys())
        kwargs["outcomes"].append(
            ToolExecutionOutcome(
                tool_name="write_file",
                output="notes.md saved",
                success=True,
                call_id="call-write-1",
            )
        )

    def fake_run_tool_loop(**kwargs):  # noqa: ANN003
        captured["approvals_pre_granted"] = kwargs["approvals_pre_granted"]
        captured["iteration_base"] = kwargs["runtime"].iteration_base
        captured["current_iteration"] = kwargs["runtime"].current_iteration
        captured["tool_call_limit"] = kwargs["runtime"].tool_call_limit
        captured["tool_calls_consumed"] = kwargs["runtime"].tool_calls_consumed
        captured["remaining_tool_calls"] = kwargs["runtime"].remaining_tool_calls
        captured["initial_outcomes"] = list(kwargs["initial_outcomes"])
        return SimpleNamespace(
            thinking_text="",
            response_text="",
            approval_request=None,
            outcomes=kwargs["initial_outcomes"],
            approval_plan=None,
            thinking_kind=None,
            persist_thinking=False,
            usage_totals=None,
            streamed_event_types=frozenset(),
            completion_source="model",
        )

    monkeypatch.setattr(
        "sidecar.runtime.chat._validate_approval_plan_live_context", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.pre_filter_tool_calls",
        fake_pre_filter_tool_calls,
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.execute_tool_calls_sequentially",
        fake_execute_tool_calls_sequentially,
    )
    monkeypatch.setattr("sidecar.ai.routing.tool_loop.run_tool_loop", fake_run_tool_loop)

    response = resume_chat_send_response_from_approval_plan(
        plan,
        brain_container=brain_container,
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )

    assert response.result["status"] == TURN_STATE_COMPLETED
    assert captured["prefilter_tool_ids"] == ["read_file", "write_file"]
    assert captured["audit_call_ids"] == ["call-write-1"]
    assert captured["approvals_pre_granted"] is False
    # Resume continues the paused turn's iteration numbering: the loop is
    # rebased onto the plan's completed iteration count so streamed
    # thinking/phase ids never reuse a pre-approval iteration identity.
    assert captured["iteration_base"] == 5
    assert captured["current_iteration"] == 5
    assert captured["tool_call_limit"] == 3
    assert captured["tool_calls_consumed"] == 2
    assert captured["remaining_tool_calls"] == 1
    assert response.result["completion_source"] == "deterministic_tool_fallback"

    # The EXECUTION window is unchanged: only the read-only sibling ahead of the
    # approved call plus the approved call itself are dispatched. call-write-2
    # sits after the approved call and is still never executed.
    executed_call_ids = {
        outcome.call_id for outcome in captured["initial_outcomes"] if outcome.success
    }
    assert executed_call_ids == {"call-write-1"}

    # What changed: the batch reserved THREE calls against the turn budget, so a
    # dropped sibling can no longer vanish without a trace. call-write-2 now
    # gets an explicit terminal outcome, which both tells the model its request
    # was discarded and keeps the budget reconciled -- previously it produced no
    # tool.result row at all and the budget stayed permanently debited.
    dropped = [
        outcome for outcome in captured["initial_outcomes"] if outcome.call_id == "call-write-2"
    ]
    assert len(dropped) == 1, captured["initial_outcomes"]
    assert dropped[0].success is False
    assert dropped[0].error_code == CMP_TOOL_APPROVAL_WINDOW_DROPPED
    assert "approved execution window" in dropped[0].output
    assert (
        "1 successful and 1 failed tool result(s)" in response.result["response_text"]
    ), response.result["response_text"]


def test_resume_chat_send_response_from_approval_plan_maps_exhausted_plan_drift_to_preempted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = _build_approval_plan_for_chat_tests()
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        prompt_text="Frozen system prompt",
    )
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                max_loop_wall_seconds=300.0,
                chunk_inactivity_seconds=60.0,
                model_load_grace_seconds=300.0,
                session_start_date="2026-04-13",
                feature_flags={},
                max_inline_payload_bytes=65_536,
            ),
            engine=_TextOnlyEngine(),
            router=router,
        )
    )
    validate_calls = {"count": 0}

    def _raise_plan_drift(*args: object, **kwargs: object) -> None:
        _ = args, kwargs
        validate_calls["count"] += 1
        raise InnerRetryableTurnError(
            reason="approval plan drifted before execution (execution_context).",
            retry_prompt="retry with fresh plan",
            terminal_subcode="approval_plan_drift",
        )

    monkeypatch.setattr(
        "sidecar.runtime.chat._validate_approval_plan_live_context",
        _raise_plan_drift,
    )

    response = resume_chat_send_response_from_approval_plan(
        plan,
        brain_container=brain_container,
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )

    assert validate_calls["count"] == 3
    assert response.result == {
        "request_id": plan.request_id,
        "status": TURN_STATE_PREEMPTED,
        "terminal_subcode": TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
    }


def test_resume_chat_send_response_from_approval_plan_returns_denied_terminal_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = _build_approval_plan_for_chat_tests()
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        prompt_text="Frozen system prompt",
    )
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                max_loop_wall_seconds=300.0,
                chunk_inactivity_seconds=60.0,
                model_load_grace_seconds=300.0,
                session_start_date="2026-04-13",
                feature_flags={},
                max_inline_payload_bytes=65_536,
            ),
            engine=_TextOnlyEngine(),
            router=router,
        )
    )

    monkeypatch.setattr(
        "sidecar.runtime.chat._validate_approval_plan_live_context",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.pre_filter_tool_calls",
        lambda *args, **kwargs: ([], 0),
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop.run_tool_loop",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            TerminalChatStateError(
                status=TURN_STATE_DENIED,
                message="approval denied",
            )
        ),
    )

    response = resume_chat_send_response_from_approval_plan(
        plan,
        brain_container=brain_container,
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )

    assert response.result == {
        "request_id": plan.request_id,
        "status": TURN_STATE_DENIED,
    }


def test_resume_chat_send_response_from_approval_plan_reprompts_for_a_second_approval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A resumed turn needing approval AGAIN must pause and ask, not settle.

    Owner repro (2026-08-21, session sess_1787280515954_997682f42f9a): a tool
    failed, the model announced a corrected command, and the turn stopped dead
    with no error. Cause: the resume path copied ``approval_request`` onto the
    ChatDecision and handed it to ``_chat_response_from_decision``, which never
    reads that field. The second approval prompt was discarded and the turn
    settled as a silent success carrying the approval path's empty
    ``response_text`` -- so the follow-up tool call never ran and the user saw
    nothing at all.
    """
    plan = _build_approval_plan_for_chat_tests()
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        prompt_text="Frozen system prompt",
    )
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                max_loop_wall_seconds=300.0,
                chunk_inactivity_seconds=60.0,
                model_load_grace_seconds=300.0,
                session_start_date="2026-04-13",
                feature_flags={},
                max_inline_payload_bytes=65_536,
            ),
            engine=_TextOnlyEngine(),
            router=router,
        )
    )

    second_approval = ApprovalRequest(
        tool_name="run_command",
        reason="command requires approval",
        tool_input={"command": r"C:\Windows\System32\powershell.exe -Command Get-Date"},
        mode="assist",
        tool_call_id="call-run-2",
    )
    failed_outcome = ToolExecutionOutcome(
        tool_name="run_command",
        output="'powershell' is not recognized as an internal or external command",
        success=False,
        call_id="call-run-1",
    )

    monkeypatch.setattr(
        "sidecar.runtime.chat._validate_approval_plan_live_context",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.pre_filter_tool_calls",
        lambda *args, **kwargs: ([], 0),
    )

    def fake_run_tool_loop(**kwargs):  # noqa: ANN003
        assert kwargs["approvals_pre_granted"] is False
        return SimpleNamespace(
            thinking_text="",
            response_text="",
            approval_request=second_approval,
            outcomes=(failed_outcome,),
            approval_plan=None,
            thinking_kind=None,
            persist_thinking=False,
            usage_totals=None,
            streamed_event_types=frozenset(),
            completion_source="model",
        )

    monkeypatch.setattr("sidecar.ai.routing.tool_loop.run_tool_loop", fake_run_tool_loop)

    response = resume_chat_send_response_from_approval_plan(
        plan,
        brain_container=brain_container,
        live_params={"messages": [{"role": "user", "content": "what day is it"}]},
        canonical_session_messages=[],
    )

    # The turn pauses for the SECOND approval instead of silently completing.
    assert response.result["status"] == "awaiting_approval"
    assert response.approval_request is not None
    assert response.approval_request["tool_name"] == "run_command"
    assert response.approval_request["tool_call_id"] == "call-run-2"
    assert response.approval_request["request_id"] == plan.request_id
    # It must not have settled as a finished turn: no terminal completion state
    # and, critically, no blank assistant answer standing in for the prompt.
    assert response.result["status"] != TURN_STATE_COMPLETED
    assert "response_text" not in response.result


def test_resume_chat_send_response_from_approval_plan_returns_timeout_terminal_subcode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = _build_approval_plan_for_chat_tests()
    router = _ApprovalResumeRouter(
        frozen_inputs=plan.frozen_inputs,
        prompt_text="Frozen system prompt",
    )
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                system_prompt="Frozen system prompt",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
                max_tokens=16384,
                max_loop_wall_seconds=300.0,
                chunk_inactivity_seconds=60.0,
                model_load_grace_seconds=300.0,
                session_start_date="2026-04-13",
                feature_flags={},
                max_inline_payload_bytes=65_536,
            ),
            engine=_TextOnlyEngine(),
            router=router,
        )
    )

    monkeypatch.setattr(
        "sidecar.runtime.chat._validate_approval_plan_live_context",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.pre_filter_tool_calls",
        lambda *args, **kwargs: ([], 0),
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop.run_tool_loop",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            TerminalChatStateError(
                status=TURN_STATE_TIMEOUT,
                message="approval timeout",
                terminal_subcode=TERMINAL_SUBCODE_TIMEOUT_APPROVAL,
            )
        ),
    )

    response = resume_chat_send_response_from_approval_plan(
        plan,
        brain_container=brain_container,
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )

    assert response.result == {
        "request_id": plan.request_id,
        "status": TURN_STATE_TIMEOUT,
        "terminal_subcode": TERMINAL_SUBCODE_TIMEOUT_APPROVAL,
    }




def test_build_chat_send_response_forwards_last_request_input_tokens() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
        usage=GenerationUsage(
            input_tokens=240,
            output_tokens=32,
            total_tokens=272,
            provider="ollama",
            model="qwen3.6:35b",
            last_request_input_tokens=140,
        ),
    )
    response = build_chat_send_response(
        "msg-last-request",
        {
            "request_id": "req-last-request",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision),
        invalid_params_code=-32602,
    )

    usage = _done_notification(response)["params"]["usage"]
    # Overwrite-not-add: the summed input_tokens and the latest request size
    # travel as separate fields so the context meter can read the latter.
    assert usage["input_tokens"] == 240
    assert usage["last_request_input_tokens"] == 140


def test_build_chat_send_response_omits_zero_last_request_input_tokens() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
        usage=GenerationUsage(
            input_tokens=144,
            output_tokens=32,
            total_tokens=176,
            provider="ollama",
            model="qwen3.6:35b",
        ),
    )
    response = build_chat_send_response(
        "msg-zero-last-request",
        {
            "request_id": "req-zero-last-request",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision),
        invalid_params_code=-32602,
    )

    usage = _done_notification(response)["params"]["usage"]
    # Present-but-zero must fall through to estimation renderer-side, so the
    # key is omitted entirely instead of shipping a 0.
    assert "last_request_input_tokens" not in usage


def test_build_chat_send_response_forwards_decision_compact_threshold() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
        compact_threshold_tokens=5000,
    )
    response = build_chat_send_response(
        "msg-compact-threshold",
        {
            "request_id": "req-compact-threshold",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            feature_flags={FEATURE_TOKEN_BUDGET: True, FEATURE_CONTEXT_COMPACTION: True},
        ),
        invalid_params_code=-32602,
    )

    usage = _done_notification(response)["params"]["usage"]
    # The exact trigger from the request's TokenBudget wins over the
    # engine-derived fallback so the ring denominator matches the sidecar
    # compaction trigger.
    assert usage["compact_threshold_tokens"] == 5000


def test_build_chat_send_response_serializes_terminal_decision_as_error() -> None:
    decision = ChatDecision(
        thinking_text="Context budget exhausted after compaction.",
        response_text=(
            "Context remained too large after compaction. Please start a new thread "
            "or reduce the active context."
        ),
        approval_request=None,
        tool_results=(),
        completion_source="context_budget_terminal",
        terminal_error_code=CMP_CTX_BUDGET_EXHAUSTED,
        terminal_error_retryable=False,
    )
    response = build_chat_send_response(
        "msg-context-terminal",
        {
            "request_id": "req-context-terminal",
            "messages": [{"role": "user", "content": "continue"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            feature_flags={FEATURE_CANONICAL_TURN_EVENTS: True},
        ),
        invalid_params_code=-32602,
    )

    assert response.result["status"] == TURN_STATE_RUNTIME_ERROR
    assert response.result["response_text"].startswith("Context remained too large")
    methods = [item["method"] for item in response.notifications]
    assert "chat.error" in methods
    assert "chat.token" not in methods
    assert "chat.done" not in methods
    error_payload = next(
        item["params"] for item in response.notifications if item["method"] == "chat.error"
    )
    assert error_payload["request_id"] == "req-context-terminal"
    assert error_payload["trace_id"] == "req-context-terminal"
    assert error_payload["code"] == CMP_CTX_BUDGET_EXHAUSTED
    assert error_payload["message"] == (
        "Context remained too large after compaction. Please start a new thread "
        "or reduce the active context."
    )
    assert error_payload["retryable"] is False
    failed_event = next(
        item["params"]
        for item in response.notifications
        if item["method"] == TURN_EVENT_METHOD
        and item["params"].get("type") == "turn_failed"
    )
    assert failed_event["payload"]["code"] == CMP_CTX_BUDGET_EXHAUSTED
    assert failed_event["payload"]["retryable"] is False


def test_build_chat_send_response_omits_compact_threshold_when_compaction_disabled() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
        compact_threshold_tokens=5000,
    )
    response = build_chat_send_response(
        "msg-compaction-off",
        {
            "request_id": "req-compaction-off",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        # token_budget on but context_compaction rolled back: compaction can
        # never fire, so the meter must not advertise a trigger.
        brain_container=_build_brain_container(
            decision,
            feature_flags={FEATURE_TOKEN_BUDGET: True},
        ),
        invalid_params_code=-32602,
    )

    usage = _done_notification(response)["params"]["usage"]
    assert "compact_threshold_tokens" not in usage


def test_build_chat_send_response_derives_compact_threshold_from_engine() -> None:
    class _BudgetedEngine(_TextOnlyEngine):
        def get_model_context_length(self) -> int:
            return 131072

        def get_model_max_output_tokens(self) -> int:
            return 16384

    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    response = build_chat_send_response(
        "msg-derived-threshold",
        {
            "request_id": "req-derived-threshold",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine=_BudgetedEngine(),
            feature_flags={FEATURE_TOKEN_BUDGET: True, FEATURE_CONTEXT_COMPACTION: True},
        ),
        invalid_params_code=-32602,
    )

    usage = _done_notification(response)["params"]["usage"]
    # TokenBudget(131072, 16384): effective = 131072 - 16384 (output
    # reservation) - 8192 (summary reservation) = 106496; x 0.90 = 95846.
    assert usage["compact_threshold_tokens"] == 95846


def _vision_attachment(asset_path: str) -> dict[str, str]:
    return {"id": "image-1", "kind": "image", "assetPath": asset_path}


def test_build_chat_send_response_flag_off_keeps_assist_vision_rejection(
    tmp_path: Path,
) -> None:
    engine = _VisionCapableEngine()
    brain_container = _build_brain_container(
        ChatDecision(None, "unused", None, ()),
        engine_type="mock",
        model="mock-v1",
        engine=engine,
        feature_flags={"vision_unified_turn": False},
        electron_state_root=str(tmp_path),
    )

    with pytest.raises(ChatRequestError, match="Image attachments are only available in chat mode"):
        build_chat_send_response(
            "msg-vision-legacy-assist",
            {
                "request_id": "req-vision-legacy-assist",
                "mode": "assist",
                "messages": [{"role": "user", "content": "Describe this image"}],
                "attachments": [_vision_attachment(_write_temp_image(tmp_path))],
            },
            approvals_pre_granted=True,
            brain_container=brain_container,
            invalid_params_code=-32602,
        )

    assert engine.last_images == []


def test_build_chat_send_response_flag_on_never_calls_legacy_vision(
    tmp_path: Path,
) -> None:
    class _RouterOnlyVisionEngine(_VisionCapableEngine):
        def generate_with_vision(self, *args: object, **kwargs: object) -> GenerationResult:
            _ = args, kwargs
            raise AssertionError("legacy vision path must not run")

    engine = _RouterOnlyVisionEngine()
    brain_container = _build_brain_container(
        ChatDecision(None, "routed", None, ()),
        engine_type="mock",
        model="mock-v1",
        engine=engine,
        feature_flags={"vision_unified_turn": True},
        electron_state_root=str(tmp_path),
    )

    build_chat_send_response(
        "msg-vision-unified-chat",
        {
            "request_id": "req-vision-unified-chat",
            "mode": "chat",
            "messages": [{"role": "user", "content": "Describe this image"}],
            "attachments": [_vision_attachment(_write_temp_image(tmp_path))],
        },
        approvals_pre_granted=True,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    assert brain_container.stack.router.last_kwargs


def test_vision_anchor_is_sanitized_and_images_only_reach_its_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _CapturingVisionStreamEngine:
        supported_modalities = {ModelModality.TEXT, ModelModality.VISION}
        capabilities = {"text": True, "vision": True, "thinking": True}

        def __init__(self) -> None:
            self.stream_messages: list[list[dict[str, object]]] = []

        def get_model_max_output_tokens(self) -> int | None:
            return None

        def stream(self, **kwargs: object):
            messages = kwargs.get("messages")
            self.stream_messages.append(list(messages) if isinstance(messages, list) else [])
            yield SimpleNamespace(kind="content", text="Done.")
            yield SimpleNamespace(kind="done", text="")

        def generate_with_vision(self, *args: object, **kwargs: object) -> GenerationResult:
            _ = args, kwargs
            raise AssertionError("legacy vision path must not run")

    recorded_contexts: list[ChatRequestContext] = []

    def _record_context(**kwargs: object) -> ChatRequestContext:
        context = ChatRequestContext(**kwargs)  # type: ignore[arg-type]
        recorded_contexts.append(context)
        return context

    monkeypatch.setattr("sidecar.runtime.chat.ChatRequestContext", _record_context)
    decision = ChatDecision(None, "unused", None, ())
    vision_engine = _CapturingVisionStreamEngine()
    build_chat_send_response(
        "msg-history-images-vision",
        {
            "request_id": "req-history-images-vision",
            "mode": "chat",
            "messages": [
                {"role": "user", "content": "older", "images": ["junk"]},
                {
                    "role": "user",
                    "content": "  describe data:image/png;base64,AAAA  ",
                    "images": ["junk"],
                },
            ],
            "attachments": [_vision_attachment(_write_temp_image(tmp_path))],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(
            decision,
            engine=vision_engine,
            feature_flags={"vision_unified_turn": True},
            electron_state_root=str(tmp_path),
        ),
        invalid_params_code=-32602,
        stream_notifications=True,
    )

    vision_rows = vision_engine.stream_messages[0]
    image_rows = [row for row in vision_rows if "images" in row]
    assert len(image_rows) == 1
    expected_anchor = "describe [omitted encoded attachment payload]"
    assert recorded_contexts[0].vision_anchor_text == expected_anchor
    assert recorded_contexts[0].vision_token_surcharge == _vision_turn.vision_token_surcharge(
        recorded_contexts[0].vision_images
    )
    assert image_rows[0]["content"] == expected_anchor
    assert isinstance(image_rows[0]["images"][0], VisionImage)

    text_engine = _CapturingVisionStreamEngine()
    build_chat_send_response(
        "msg-history-images-text",
        {
            "request_id": "req-history-images-text",
            "mode": "chat",
            "messages": [{"role": "user", "content": "text only", "images": ["junk"]}],
        },
        approvals_pre_granted=True,
        brain_container=_build_brain_container(decision, engine=text_engine),
        invalid_params_code=-32602,
        stream_notifications=True,
    )
    assert all("images" not in row for row in text_engine.stream_messages[0])


def test_vision_request_rejects_an_empty_sanitized_anchor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "sidecar.runtime.chat.sanitize_semantic_message",
        lambda _message: {"role": "user"},
    )

    with pytest.raises(ChatRequestError) as error_info:
        build_chat_send_response(
            "msg-vision-empty-anchor",
            {
                "request_id": "req-vision-empty-anchor",
                "mode": "assist",
                "messages": [{"role": "user", "content": "data:image/png;base64,AAAA"}],
                "attachments": [_vision_attachment(_write_temp_image(tmp_path))],
            },
            approvals_pre_granted=True,
            brain_container=_build_brain_container(
                ChatDecision(None, "unused", None, ()),
                engine=_VisionCapableEngine(),
                electron_state_root=str(tmp_path),
            ),
            invalid_params_code=-32602,
        )

    error = error_info.value
    assert error.code == "CMP-CHAT-0001"
    assert error.rpc_code == -32602
    assert str(error) == _vision_turn.VISION_ANCHOR_MESSAGE


def test_sub_agent_context_does_not_inherit_parent_vision_state() -> None:
    parent = ChatRequestContext(
        request_id="parent-request",
        trace_id="trace",
        session_id="session",
        mode="assist",
        approvals_pre_granted=True,
        vision_images=(
            VisionImage(
                mime_type="image/png",
                width=64,
                height=48,
                frame_count=1,
                data=b"vision-payload",
            ),
        ),
        vision_anchor_text="describe the image",
        vision_token_surcharge=255,
    )

    child = _child_request_context(
        parent_context=parent,
        identity=SubAgentIdentity("invocation", "task", "child", "parent"),
        tool_preferences_override=None,
        iteration_budget_override=None,
        report_mode="structured",
    )

    assert child.vision_images == ()
    assert child.vision_anchor_text == ""
    assert child.vision_token_surcharge == 0


def test_text_only_engine_refuses_vision_before_any_engine_call(tmp_path: Path) -> None:
    class _CountingTextOnlyEngine:
        supported_modalities = {ModelModality.TEXT}
        capabilities = {"text": True, "vision": False}

        def __init__(self) -> None:
            self.calls = 0

        def get_model_max_output_tokens(self) -> int | None:
            return None

        def generate_with_vision(self, *args: object, **kwargs: object) -> GenerationResult:
            _ = args, kwargs
            self.calls += 1
            return GenerationResult(content="unexpected", finish_reason="stop")

        def stream(self, **kwargs: object):
            _ = kwargs
            self.calls += 1
            yield SimpleNamespace(kind="done", text="")

    engine = _CountingTextOnlyEngine()
    with pytest.raises(ChatRequestError) as error_info:
        build_chat_send_response(
            "msg-vision-text-only-counted",
            {
                "request_id": "req-vision-text-only-counted",
                "mode": "chat",
                "messages": [{"role": "user", "content": "Describe this image"}],
                "attachments": [_vision_attachment(_write_temp_image(tmp_path))],
            },
            approvals_pre_granted=True,
            brain_container=_build_brain_container(
                ChatDecision(None, "unused", None, ()),
                engine=engine,
                electron_state_root=str(tmp_path),
            ),
            invalid_params_code=-32602,
        )

    error = error_info.value
    assert str(error) == "The active model does not support image attachments."
    assert error.code == "CMP-CHAT-0001"
    assert error.rpc_code == -32602
    assert error.retryable is False
    assert engine.calls == 0
