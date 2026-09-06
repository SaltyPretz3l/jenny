"""Request-scoped agent kernel for sidecar execution."""

from __future__ import annotations

import logging
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import (
    ContextBuilder,
    LearnedLesson,
    RuntimeToolStatus,
    looks_like_current_info_request,
)
from sidecar.ai.context.cache_detection import CacheBreakDetector
from sidecar.ai.context.compaction import CompactionCircuitBreakerRegistry
from sidecar.ai.context.prompt_cache import StructuredSystemPrompt
from sidecar.ai.context.token_budget import (
    estimate_messages_tokens,
    resolve_tokenizer_backend,
)
from sidecar.ai.engines.base import BaseEngine, EngineMessage
from sidecar.ai.error_codes import CMP_TSRCH_DEFERRED_TOOL
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.routing import chat_decision as _cd
from sidecar.ai.routing import engine_messages as _em
from sidecar.ai.routing import tool_execution as _te
from sidecar.ai.routing import tool_resolution as _tr
from sidecar.ai.routing.generation_runtime import (
    build_compaction_generate_fn as _build_compaction_generate_fn_runtime,
)
from sidecar.ai.routing.generation_runtime import (
    generate_step as _generate_step_runtime,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import (
    GenerationResult,
    GenerationUsage,
    ToolCallRequest,
)
from sidecar.ai.tools.tool_search import TOOL_SEARCH_TOOL_NAME
from sidecar.protocol import CHAT_THINKING_KIND_STATUS
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)
MAX_LOOP_ITERATIONS = 8

# Distinguishes "not yet resolved" from a resolved-to-None backend, so a failed
# tokenizer init is cached instead of retried on every turn.
_UNSET = object()


@dataclass(frozen=True)
class ApprovalRequest:
    tool_name: str
    reason: str
    tool_input: dict[str, object]
    mode: str
    tool_call_id: str | None = None
    policy_decision_id: str | None = None
    policy_scope: str | None = None
    policy_consequence: str | None = None

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "tool_name": self.tool_name,
            "reason": self.reason,
            "tool_input": self.tool_input,
            "mode": self.mode,
        }
        if self.tool_call_id:
            payload["tool_call_id"] = self.tool_call_id
        if self.policy_decision_id:
            payload["policy_decision_id"] = self.policy_decision_id
        if self.policy_scope:
            payload["policy_scope"] = self.policy_scope
        if self.policy_consequence:
            payload["policy_consequence"] = self.policy_consequence
        return payload


@dataclass(frozen=True)
class ToolExecutionOutcome:
    tool_name: str
    output: str
    success: bool
    tool_input: dict[str, object] = field(default_factory=dict)
    content_type: str = "text"
    ui_payload: dict[str, object] | None = None
    generated_artifacts: tuple[dict[str, object], ...] = ()
    error_code: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
    call_id: str = ""
    # Attachments admitted by tool_execution for builtin read_file/python_execute
    # only; synthetic and replayed outcomes leave this empty.
    trusted_attachments: tuple[dict[str, object], ...] = ()


@dataclass(frozen=True)
class ChatDecision:
    thinking_text: str | None
    response_text: str
    approval_request: ApprovalRequest | None
    tool_results: tuple[ToolExecutionOutcome, ...]
    approval_plan: Any | None = None
    thinking_kind: str = CHAT_THINKING_KIND_STATUS
    persist_thinking: bool = False
    usage: GenerationUsage | None = None
    context_tokens_estimate: int | None = None
    message_count: int | None = None
    tool_schema_count: int | None = None
    streamed_event_types: frozenset[str] = field(default_factory=frozenset)
    completion_source: str = "model"
    resumable_stop: str | None = None
    # An explicit terminal failure carried through the normal decision seam.
    # The runtime serializes this as chat.error + turn_failed and must not emit
    # chat.done. None preserves the ordinary successful-decision contract.
    terminal_error_code: str | None = None
    terminal_subcode: str | None = None
    terminal_error_retryable: bool = False
    # Exact auto-compaction trigger (budget.auto_compact_threshold) for the
    # request's TokenBudget, so the renderer meter denominator matches the
    # sidecar trigger. None when the token_budget flag is off.
    compact_threshold_tokens: int | None = None


class AgentKernel:
    def __init__(
        self,
        *,
        config: RuntimeConfig,
        engine: BaseEngine,
        mcp_client: MCPClient,
        context_builder: ContextBuilder,
        memory_store: Any | None = None,
        harness_snapshot_provider: Any | None = None,
        monitor_manager: Any | None = None,
        max_iterations: int | None = None,
        plugin_runtime_tool_provider: Any | None = None,
    ) -> None:
        self._config = config
        self._engine = engine
        self._mcp_client = mcp_client
        self._context_builder = context_builder
        self._memory_store = memory_store
        self._harness_snapshot_provider = harness_snapshot_provider
        self._monitor_manager = monitor_manager
        self._plugin_runtime_tool_provider = plugin_runtime_tool_provider
        configured_max_iterations = (
            max_iterations
            if max_iterations is not None
            else getattr(config, "max_loop_iterations", MAX_LOOP_ITERATIONS)
        )
        self._max_iterations = max(1, int(configured_max_iterations))
        self._cache_break_detector = CacheBreakDetector()
        self._compaction_breakers = CompactionCircuitBreakerRegistry()
        self._tokenizer_lock = threading.Lock()

    def set_harness_snapshot_provider(self, provider: Any | None) -> None:
        self._harness_snapshot_provider = provider

    @property
    def available_tools(self) -> list[str]:
        return [
            name
            for name, status in self.tools_status.items()
            if isinstance(status, dict) and status.get("available") is True
        ]

    @property
    def tools_status(self) -> dict[str, dict[str, Any]]:
        return {
            status.name: {
                "available": status.available,
                "reason": status.reason,
                "display_name": status.display_name,
                "source_kind": status.source_kind,
                "tool_family": status.tool_family,
                "server_name": status.server_name,
            }
            for status in self._tool_status_entries()
            if status.name
        }

    # -- Tool resolution (delegated to tool_resolution.py) -------------------

    def _assemble_tool_contract(
        self,
        *,
        resolution_context: Any | None = None,
        request_context: ChatRequestContext | None = None,
        enforce_mode_policy: bool = True,
        enforce_request_preferences: bool = True,
        include_deferred_tools: bool = True,
    ) -> Any:
        return _tr.assemble_tool_contract(
            self,
            resolution_context=resolution_context,
            request_context=request_context,
            enforce_mode_policy=enforce_mode_policy,
            enforce_request_preferences=enforce_request_preferences,
            include_deferred_tools=include_deferred_tools,
        )

    @property
    def tool_schemas(self) -> list[dict[str, Any]]:
        return _tr.get_tool_schemas(self)

    def _build_full_tool_schema_map(self) -> dict[str, dict[str, Any]]:
        return _tr.build_full_tool_schema_map(self)

    @staticmethod
    def _request_tool_set(
        tool_preferences: dict[str, tuple[str, ...]] | None,
        key: str,
    ) -> frozenset[str]:
        return _tr.request_tool_set(tool_preferences, key)

    def _build_tool_payload(
        self,
        resolution_context: Any | None,
        *,
        plan_mode: bool = False,
        tool_preferences: dict[str, tuple[str, ...]] | None = None,
        request_context: ChatRequestContext | None = None,
    ) -> list[dict[str, Any]]:
        if request_context is None and (plan_mode or tool_preferences is not None):
            request_context = ChatRequestContext(
                request_id="",
                trace_id=None,
                session_id=None,
                mode=self._config.mode,
                approvals_pre_granted=True,
                plan_mode=plan_mode,
                read_only=plan_mode,
                tool_preferences=tool_preferences,
                workspace_root_present=self._tool_has_workspace(),
            )
        return _tr.build_tool_payload(
            self,
            resolution_context,
            request_context=request_context,
        )

    def _engine_supports_tool_calling(self) -> bool:
        return _tr.engine_supports_tool_calling(self)

    def _engine_supports_inband_tool_calling(self) -> bool:
        return _tr.engine_supports_inband_tool_calling(self)

    def _tool_has_workspace(self) -> bool:
        return _tr.tool_has_workspace(self)

    def _tool_status_entries(
        self,
        resolution_context: Any | None = None,
        plan_mode: bool = False,
        tool_preferences: dict[str, tuple[str, ...]] | None = None,
        request_context: ChatRequestContext | None = None,
    ) -> tuple[RuntimeToolStatus, ...]:
        if request_context is None and (plan_mode or tool_preferences is not None):
            request_context = ChatRequestContext(
                request_id="",
                trace_id=None,
                session_id=None,
                mode=self._config.mode,
                approvals_pre_granted=True,
                plan_mode=plan_mode,
                read_only=plan_mode,
                tool_preferences=tool_preferences,
                workspace_root_present=self._tool_has_workspace(),
            )
        return _tr.tool_status_entries(
            self,
            resolution_context,
            request_context=request_context,
        )

    def _log_tool_contract(
        self,
        *,
        request_id: str,
        tool_statuses: tuple[RuntimeToolStatus, ...],
        latest_user_content: str,
    ) -> None:
        _tr.log_tool_contract(
            self,
            request_id=request_id,
            tool_statuses=tool_statuses,
            latest_user_content=latest_user_content,
        )

    def _log_request_tool_preferences(
        self,
        *,
        request_id: str,
        session_id: str | None,
        tool_preferences: dict[str, tuple[str, ...]] | None,
    ) -> None:
        _tr.log_request_tool_preferences(
            self,
            request_id=request_id,
            session_id=session_id,
            tool_preferences=tool_preferences,
        )

    def _log_missing_current_info_tool_use(
        self,
        *,
        request_id: str,
        latest_user_content: str,
        tool_statuses: tuple[RuntimeToolStatus, ...],
        tool_results: list[ToolExecutionOutcome],
    ) -> None:
        if not looks_like_current_info_request(latest_user_content):
            return
        if tool_results:
            return
        web_search_available = any(
            status.name == "web_search" and status.available is True for status in tool_statuses
        )
        if not web_search_available:
            return
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.current_info_without_tool_call",
            message=(
                "Current-info request completed without any tool call even though "
                "web_search was executable."
            ),
            status="degraded",
            data={
                "available_tools": _tr.available_tool_names(tool_statuses),
            },
            request_id=request_id,
        )

    @staticmethod
    def _cache_source_key(
        *,
        request_id: str,
        session_id: str | None,
        request_context: ChatRequestContext | None = None,
    ) -> str:
        if int(getattr(request_context, "agent_depth", 0) or 0) > 0:
            return str(request_id or "").strip()
        session_key = str(session_id or "").strip()
        if session_key:
            return session_key
        return str(request_id or "").strip()

    @staticmethod
    def _remaining_deferred_names(resolution_context: Any | None) -> frozenset[str]:
        return _tr.remaining_unexposed_tool_names(resolution_context)

    def _is_direct_deferred_tool_call(
        self,
        call: ToolCallRequest,
        resolution_context: Any | None,
    ) -> bool:
        if call.tool_id == TOOL_SEARCH_TOOL_NAME:
            return False
        return call.tool_id in self._remaining_deferred_names(resolution_context)

    @staticmethod
    def _build_deferred_outcome(call: ToolCallRequest) -> ToolExecutionOutcome:
        """Build a deferred-tool error outcome for tool_loop delegation."""
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output=(
                f"Tool '{call.tool_id}' is deferred for this request. "
                "Call tool_search first to discover it, then retry the tool call."
            ),
            success=False,
            tool_input={str(key): value for key, value in call.arguments.items()},
            error_code=CMP_TSRCH_DEFERRED_TOOL,
            metadata={
                "deferred": True,
                "tool_search_required": True,
            },
            call_id=call.call_id,
        )

    def _system_prompt_for_engine(
        self,
        system_prompt: str | StructuredSystemPrompt,
    ) -> str:
        if isinstance(system_prompt, StructuredSystemPrompt):
            return system_prompt.to_text()
        return str(system_prompt)

    @staticmethod
    def _cache_usage_tokens(raw_usage: dict[str, Any], *keys: str) -> int:
        for key in keys:
            try:
                value = int(raw_usage.get(key) or 0)
            except (TypeError, ValueError):
                continue
            return max(value, 0)
        return 0

    def _tokenizer_backend(self) -> Any:
        """Memoized config-aware tokenizer backend for this kernel.

        Cached because a transformers/tiktoken init is not free and the config
        is fixed for the life of a kernel. Fails soft to ``None`` (the chars//4
        estimator) so a diagnostics figure can never fail a turn.
        """
        backend = getattr(self, "_cached_tokenizer_backend", _UNSET)
        if backend is _UNSET:
            with self._tokenizer_lock:
                backend = getattr(self, "_cached_tokenizer_backend", _UNSET)
                if backend is _UNSET:
                    try:
                        backend = resolve_tokenizer_backend(self._config)
                    except Exception:  # noqa: BLE001
                        backend = None
                    self._cached_tokenizer_backend = backend
        return backend

    def _context_tokens_estimate(self, messages: list[dict[str, object]]) -> int:
        # Use the config-aware tokenizer so this diagnostic estimate matches the
        # token figure used by compaction.
        return estimate_messages_tokens(messages, self._tokenizer_backend())

    def _build_chat_decision(
        self,
        *,
        working_messages: list[dict[str, object]],
        thinking_text: str | None,
        response_text: str,
        approval_request: ApprovalRequest | None,
        tool_results: tuple[ToolExecutionOutcome, ...],
        thinking_kind: str = CHAT_THINKING_KIND_STATUS,
        persist_thinking: bool = False,
        usage: GenerationUsage | None = None,
        streamed_event_types: frozenset[str] | None = None,
        completion_source: str = "model",
    ) -> ChatDecision:
        return _cd._build_chat_decision(
            self,
            working_messages=working_messages,
            thinking_text=thinking_text,
            response_text=response_text,
            approval_request=approval_request,
            tool_results=tool_results,
            thinking_kind=thinking_kind,
            persist_thinking=persist_thinking,
            usage=usage,
            streamed_event_types=streamed_event_types,
            completion_source=completion_source,
        )

    def build_chat_decision(
        self,
        *,
        request_context: ChatRequestContext | None = None,
        request_id: str,
        messages: list[dict[str, object]],
        latest_user_content: str,
        mode: str,
        approvals_pre_granted: bool,
        session_id: str | None = None,
        learned_lessons: list[LearnedLesson] | None = None,
        reasoning_effort: str | None = None,
        session_start_date: str | None = None,
        canonical_session_messages: list[dict[str, object]] | None = None,
        runtime: LoopRuntime | None = None,
        plan_mode: bool = False,
        tool_preferences: dict[str, tuple[str, ...]] | None = None,
    ) -> ChatDecision:
        return _cd.build_chat_decision(
            self,
            request_context=request_context,
            request_id=request_id,
            messages=messages,
            latest_user_content=latest_user_content,
            mode=mode,
            approvals_pre_granted=approvals_pre_granted,
            session_id=session_id,
            learned_lessons=learned_lessons,
            reasoning_effort=reasoning_effort,
            session_start_date=session_start_date,
            canonical_session_messages=canonical_session_messages,
            runtime=runtime,
            plan_mode=plan_mode,
            tool_preferences=tool_preferences,
        )

    def _generate_step(
        self,
        *,
        latest_user_content: str,
        working_messages: list[dict[str, object]],
        reasoning_effort: str | None,
        prompt_cache_enabled: bool,
        source_key: str,
        system_prompt: str | StructuredSystemPrompt,
        tool_schemas: list[dict[str, Any]],
        cache_break_detector: Any | None,
        runtime: LoopRuntime | None = None,
        response_format: Any | None = None,
    ) -> tuple[GenerationResult, set[str]]:
        return _generate_step_runtime(
            self,
            latest_user_content=latest_user_content,
            working_messages=working_messages,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            source_key=source_key,
            system_prompt=system_prompt,
            tool_schemas=tool_schemas,
            cache_break_detector=cache_break_detector,
            runtime=runtime,
            response_format=response_format,
        )

    def _build_compaction_generate_fn(
        self,
        *,
        request_id: str,
        max_tokens: int,
        prompt_cache_enabled: bool,
        runtime: LoopRuntime | None = None,
    ) -> Any:
        return _build_compaction_generate_fn_runtime(
            self,
            request_id=request_id,
            max_tokens=max_tokens,
            prompt_cache_enabled=prompt_cache_enabled,
            runtime=runtime,
        )

    # -- Self-evaluation retry helpers --------------------------------------

    @staticmethod
    def _should_nudge_tool_use(
        sanitized_text: str,
        raw_text: str,
        tool_payload: list[dict[str, Any]],
        *,
        tool_statuses: tuple[RuntimeToolStatus, ...] | None = None,
    ) -> bool:
        return _em.should_nudge_tool_use(
            sanitized_text,
            raw_text,
            tool_payload,
            tool_statuses=tool_statuses,
        )

    @staticmethod
    def _build_tool_use_nudge(
        tool_payload: list[dict[str, Any]],
        *,
        trigger_tool_names: Sequence[str] = (),
    ) -> str:
        return _em.build_tool_use_nudge(
            tool_payload,
            trigger_tool_names=trigger_tool_names,
        )

    @staticmethod
    def _explicitly_requested_tool_payload(
        latest_user_content: str,
        tool_payload: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return _em.explicitly_requested_tool_payload(latest_user_content, tool_payload)

    @staticmethod
    def _build_explicit_tool_use_nudge(tool_payload: list[dict[str, Any]]) -> str:
        return _em.build_tool_use_nudge(tool_payload, explicit_request=True)

    @staticmethod
    def _engine_messages(
        messages: list[dict[str, object]],
        *,
        primary_system_text: str,
        vision_images: Sequence[Any] = (),
        vision_anchor_text: str | None = None,
    ) -> list[EngineMessage]:
        return _em.engine_messages(
            messages,
            primary_system_text=primary_system_text,
            vision_images=vision_images,
            vision_anchor_text=vision_anchor_text,
        )

    def _approval_if_needed(
        self,
        calls: tuple[ToolCallRequest, ...],
        *,
        mode: str,
        mode_allows_side_effecting: bool,
        require_approval: bool,
        approvals_pre_granted: bool,
        resolution_context: Any | None,
        tool_contract: Any | None = None,
        plan_mode: bool = False,
        read_only: bool = False,
        request_disabled_tools: frozenset[str] = frozenset(),
        policy_decisions_by_call: dict[str, Any] | None = None,
        approval_mode: str = "prompt",
    ) -> ApprovalRequest | None:
        return _te.approval_if_needed(
            self,
            calls,
            mode=mode,
            mode_allows_side_effecting=mode_allows_side_effecting,
            require_approval=require_approval,
            approvals_pre_granted=approvals_pre_granted,
            resolution_context=resolution_context,
            tool_contract=tool_contract,
            plan_mode=plan_mode,
            read_only=read_only,
            request_disabled_tools=request_disabled_tools,
            policy_decisions_by_call=policy_decisions_by_call,
            approval_mode=approval_mode,
        )

    def _filter_tool_calls_by_policy(
        self,
        calls: tuple[ToolCallRequest, ...],
        *,
        mode: str,
        mode_allows_side_effecting: bool,
        resolution_context: Any | None,
        tool_contract: Any | None = None,
        plan_mode: bool = False,
        read_only: bool = False,
        request_disabled_tools: frozenset[str] = frozenset(),
    ) -> Any:
        return _te.filter_tool_calls_by_policy(
            self,
            calls,
            mode=mode,
            mode_allows_side_effecting=mode_allows_side_effecting,
            resolution_context=resolution_context,
            tool_contract=tool_contract,
            plan_mode=plan_mode,
            read_only=read_only,
            request_disabled_tools=request_disabled_tools,
        )

    def _update_read_snapshot_cache(
        self,
        cache: dict[str, dict[str, object]],
        *,
        tool_name: str,
        success: bool,
        metadata: dict[str, object],
    ) -> None:
        _te.update_read_snapshot_cache(
            self,
            cache,
            tool_name=tool_name,
            success=success,
            metadata=metadata,
        )

    def _rebuild_read_snapshot_cache(
        self,
        canonical_session_messages: list[dict[str, object]] | None,
    ) -> dict[str, dict[str, object]]:
        return _te.rebuild_read_snapshot_cache(self, canonical_session_messages)

    def _freeze_effective_execution_inputs(
        self,
        call: ToolCallRequest,
        *,
        session_id: str | None,
        read_snapshot_cache: dict[str, dict[str, object]],
        tool_contract: Any | None = None,
        plan_mode: bool = False,
        read_only: bool = False,
        trusted_plan_artifact_write: bool | None = None,
    ) -> Any:
        return _te.freeze_effective_execution_inputs(
            self,
            call,
            session_id=session_id,
            read_snapshot_cache=read_snapshot_cache,
            tool_contract=tool_contract,
            plan_mode=plan_mode,
            read_only=read_only,
            trusted_plan_artifact_write=trusted_plan_artifact_write,
        )

    def _execute_tool_search(
        self,
        call: ToolCallRequest,
        *,
        resolution_context: Any | None,
        runtime: LoopRuntime | None = None,
    ) -> ToolExecutionOutcome:
        return _te.execute_tool_search(
            self,
            call,
            resolution_context=resolution_context,
            runtime=runtime,
        )

    @staticmethod
    def _assert_valid_tool_call(call: ToolCallRequest) -> None:
        _te.assert_valid_tool_call(call)

    def _execute_tool(
        self,
        call: ToolCallRequest,
        *,
        request_id: str,
        session_id: str | None = None,
        read_snapshot_cache: dict[str, dict[str, object]],
        tool_contract: Any | None = None,
        trusted_plan_artifact_write: bool | None = None,
        audit_metadata: dict[str, object] | None = None,
        runtime: LoopRuntime | None = None,
    ) -> ToolExecutionOutcome:
        return _te.execute_tool(
            self,
            call,
            request_id=request_id,
            session_id=session_id,
            read_snapshot_cache=read_snapshot_cache,
            tool_contract=tool_contract,
            trusted_plan_artifact_write=trusted_plan_artifact_write,
            audit_metadata=audit_metadata,
            runtime=runtime,
        )

    @staticmethod
    def _assistant_tool_call_message(
        result: GenerationResult,
        call: ToolCallRequest,
    ) -> dict[str, object]:
        return _te.assistant_tool_call_message(result, call)

    def _tool_result_message(
        self,
        call: ToolCallRequest,
        outcome: ToolExecutionOutcome,
    ) -> dict[str, object]:
        return _te.tool_result_message(call, outcome, config=self._config)


class ChatRouter(AgentKernel):
    """Compatibility alias while callers transition to AgentKernel naming."""
