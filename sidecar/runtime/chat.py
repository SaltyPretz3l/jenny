"""Chat request orchestration and backward-compatible re-exports.

This module is the wiring layer for the chat subsystem.  Heavy logic has
been extracted into sibling modules; this file re-exports the public
surface that downstream code imports from ``sidecar.runtime.chat``.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from sidecar.ai.config import resolve_effective_max_tokens
from sidecar.ai.container import BrainContainer
from sidecar.ai.context.builder import normalize_learned_lessons
from sidecar.ai.context.messages import sanitize_semantic_message
from sidecar.ai.context.prompt_cache import resolve_current_date
from sidecar.ai.context.runtime_overlays import build_dynamic_system_messages  # noqa: F401
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.feature_flags import (
    FEATURE_AGENT_EXECUTOR,
    is_chatgpt_plan_meter_enabled,
    is_feature_flag_enabled,
)
from sidecar.ai.memory.contracts import MemoryPolicy
from sidecar.ai.routing import vision_turn as _vision_turn
from sidecar.ai.routing.agent_executor import AgentExecutor  # noqa: F401
from sidecar.ai.routing.iteration_limits import effective_sub_agent_concurrency_budget
from sidecar.ai.tools.tool_call_healing import (
    bind_tool_call_healing,
    reset_tool_call_healing,
)
from sidecar.runtime.approval_plan import describe_approval_plan_changes  # noqa: F401
from sidecar.runtime.chat_helpers import (  # noqa: F401
    CHAT_INVALID_PARAMS,
    _decision_usage_payload,
    _fallback_usage_payload,
    attach_context_window,
    build_vision_prompt,
    chat_error_notification,
    engine_supports_live_reasoning_stream,
    engine_supports_vision,
    estimate_text_tokens,
    extract_latest_user_content,
    mode_from_params,
    notification_context,
    request_id_from_params,
    session_id_from_params,
    thinking_notification,
    tokenize_with_whitespace,
    trace_id_from_params,
)

# ── Re-exports (preserve backward-compatible import paths) ──────────
from sidecar.runtime.chat_models import (  # noqa: F401
    ChatRequestContext,
    ChatRequestError,
    ChatResponse,
    TerminalChatStateError,
)
from sidecar.runtime.chat_normalization import (  # noqa: F401
    approved_plan_from_params,
    memory_policy_from_params,
    normalize_context_blocks,
    normalize_debug_options,
    normalize_interactive_response,
    normalize_messages,
    normalize_tool_preferences,
    normalize_vision_attachments,
    plan_mode_from_params,
    reasoning_effort_from_params,
    session_start_date_from_params,
    tool_preferences_require_sub_agent_fail_closed,
)
from sidecar.runtime.chat_serialization import _serialize_loop_event  # noqa: F401
from sidecar.runtime.chat_streaming import (  # noqa: F401
    _build_live_stream_messages,
    build_live_streaming_chat_response,
)
from sidecar.runtime.chat_tool_observations import (
    chat_response_with_tool_observations,
)
from sidecar.runtime.chat_vision import (  # noqa: F401
    build_vision_chat_response,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.local_engine.request_context import (
    bind_chat_request_context,
    clear_chat_request_context,
)
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.plan_usage_snapshot import attach_plan_usage

logger = logging.getLogger(__name__)
SKILL_INVOCATION_ID_PATTERN = re.compile(
    r"^(bundled|user|project)/[A-Za-z0-9_][A-Za-z0-9._-]*"
    r"(/[A-Za-z0-9_][A-Za-z0-9._-]*){0,7}$"
)


def _normalize_skill_invocation(
    value: Any,
    *,
    request_id: str,
    session_id: str | None,
) -> dict[str, str] | None:
    if value is None:
        return None
    skill_id = value.get("id") if isinstance(value, dict) else None
    if isinstance(skill_id, str) and SKILL_INVOCATION_ID_PATTERN.fullmatch(skill_id):
        return {"id": skill_id}
    log_event(
        logger,
        logging.INFO,
        component="runtime.chat",
        event="ai.skills.invocation_rejected",
        message="Ignored malformed skill invocation metadata.",
        status="rejected",
        request_id=request_id,
        session_id=session_id,
    )
    return None

# ── Moved-symbol re-exports (preserve backward-compatible import paths
# AND keep monkeypatch targets resolvable on this module's namespace) ──
from sidecar.runtime.chat_decision_render import (  # noqa: E402,F401
    _chat_response_from_decision,
)
from sidecar.runtime.chat_response_builders import (  # noqa: E402,F401
    _terminal_chat_response,
    _tool_failure_error_data,
)
from sidecar.runtime.chat_resume import (  # noqa: E402,F401
    _approval_audit_metadata_map,
    _approval_resume_call_window,
    _approval_resume_descriptor,
    _approval_resume_exhausted_factory,
    _build_live_approval_system_prompt,
    _build_live_approval_working_messages,
    _build_live_dynamic_system_messages,
    _is_live_dynamic_system_message,
    _validate_approval_plan_live_context,
    resume_chat_send_response_from_approval_plan,
)
from sidecar.runtime.chat_router import (  # noqa: E402,F401
    _build_router_response,
)


def _executor_runtime_enabled(feature_flags: dict[str, bool] | None) -> bool:
    flags = feature_flags or {}
    return is_feature_flag_enabled(flags, FEATURE_AGENT_EXECUTOR)


def _managed_image_attachment_root(config: Any) -> Path | None:
    raw_root = getattr(config, "electron_state_root", None)
    if not raw_root:
        return None
    return Path(str(raw_root)).expanduser() / "attachments" / "images"


# ── Orchestrator ────────────────────────────────────────────────────


def _maybe_refresh_repo_anchor(
    *,
    session_id: str | None,
    brain_container: BrainContainer,
) -> None:
    """Run-end: refresh this session's repo anchor (the next turn's delta base).

    Flag-gated (``repo_delta_resume_enabled``) and fail-closed. The service is
    imported lazily and never raises; this wrapper additionally guards the
    import and the workspace-root lookup so a failed refresh can never break a
    completed turn. Fires on every completion path, including approval-resume.
    """
    stack = brain_container.stack
    config = stack.config
    if not getattr(config, "repo_delta_resume_enabled", False):
        return
    if not str(session_id or "").strip():
        return
    try:
        workspace_root = stack.router._context_builder.workspace_root
        from sidecar.ai.repo_delta.service import refresh_repo_anchor

        refresh_repo_anchor(
            config=config,
            session_id=session_id,
            workspace_root=workspace_root,
        )
    except Exception as error:  # noqa: BLE001
        log_event(
            logger,
            logging.WARNING,
            component="runtime.chat",
            event="runtime.chat.repo_delta.refresh_failed",
            message="Repository anchor refresh failed closed.",
            status="error",
            session_id=session_id,
            data={"error_type": error.__class__.__name__},
        )


def _maybe_run_post_response_tasks(
    *,
    session_id: str | None,
    brain_container: BrainContainer,
) -> None:
    _maybe_refresh_repo_anchor(
        session_id=session_id,
        brain_container=brain_container,
    )


def build_chat_send_response(
    message_id: Any,
    params: Any,
    *,
    approvals_pre_granted: bool,
    brain_container: BrainContainer,
    invalid_params_code: int,
    stream_notifications: bool = False,
    notification_writer: Any | None = None,
    approval_reader: Any | None = None,
    approval_reader_factory: Any | None = None,
    approval_timeout_seconds: float = 30.0,
    approval_writer: Any | None = None,
    cancel_handle: TurnCancellationHandle | None = None,
    canonical_seq_state: dict[str, int] | None = None,
) -> ChatResponse:
    request_id = request_id_from_params(params, message_id)
    trace_id = trace_id_from_params(params, message_id)
    session_id = session_id_from_params(params)
    if not isinstance(params, dict):
        raise ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=CHAT_INVALID_PARAMS,
            message="chat.send params must be an object",
            rpc_code=invalid_params_code,
            retryable=False,
        )

    stack = brain_container.stack

    def _finalize_response(response: ChatResponse) -> ChatResponse:
        return chat_response_with_tool_observations(response, stack)

    try:
        if cancel_handle is not None:
            cancel_handle.raise_if_cancelled()
        messages = normalize_messages(params.get("messages"))
        # Trusted, typed context channel — see normalize_context_blocks. These
        # deliberately do NOT ride params.messages: the semantic admission gate
        # rejects every system row on untrusted request history, which is
        # exactly why the old splice-into-history overlays were inert.
        context_blocks = normalize_context_blocks(params.get("context_blocks"))
        latest_user_content = extract_latest_user_content(params.get("messages"))
        image_attachments = normalize_vision_attachments(
            params.get("attachments"),
            managed_root=_managed_image_attachment_root(stack.config),
        )
        plan_mode = plan_mode_from_params(params)
        approved_plan = approved_plan_from_params(params)
        reasoning_effort = reasoning_effort_from_params(params)
        session_start_date = session_start_date_from_params(params)
        memory_policy = memory_policy_from_params(params)
        raw_session_offline_lockdown = params.get("session_offline_lockdown", False)
        if not isinstance(raw_session_offline_lockdown, bool):
            raise ValueError("session_offline_lockdown must be a boolean")
    except ValueError as error:
        raise ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=CHAT_INVALID_PARAMS,
            message=str(error),
            rpc_code=invalid_params_code,
            retryable=False,
        ) from error

    canonical_session_messages = (
        params.get("canonical_session_messages")
        if isinstance(params.get("canonical_session_messages"), list)
        else None
    )
    from sidecar.ai.routing.tool_quotas import count_session_tool_results

    session_tool_call_count = count_session_tool_results(canonical_session_messages)
    session_title = str(params.get("session_title") or "").strip()
    mode = mode_from_params(params, stack.config.mode)
    interactive_response = normalize_interactive_response(params)
    raw_tool_preferences = params.get("tool_preferences")
    tool_preferences = normalize_tool_preferences(raw_tool_preferences)
    approval_mode = (
        "auto_run"
        if str(params.get("approval_mode") or "").strip() == "auto_run"
        else "prompt"
    )
    debug_options = normalize_debug_options(params.get("debug_options"))
    turn_diagnostics = getattr(stack, "turn_diagnostics", None)
    feature_flags = stack.config.feature_flags or {}
    vision_images: tuple[VisionImage, ...] = tuple(
        image for attachment in image_attachments
        if isinstance(image := attachment.get("_vision_image"), VisionImage)
    )
    vision_anchor_text = str(
        (sanitize_semantic_message({"role": "user", "content": latest_user_content}) or {}).get(
            "content", ""
        )
    ) if vision_images else ""
    if vision_images and not vision_anchor_text:
        raise ChatRequestError(
            request_id=request_id, trace_id=trace_id, session_id=session_id,
            code=CHAT_INVALID_PARAMS, message=_vision_turn.VISION_ANCHOR_MESSAGE,
            rpc_code=invalid_params_code, retryable=False,
        )
    executor_runtime_enabled = _executor_runtime_enabled(feature_flags)
    agent_id = str(params.get("agent_id") or f"main@{request_id}").strip()
    parent_agent_id = str(params.get("parent_agent_id") or "").strip() or None
    try:
        agent_depth = int(params.get("agent_depth") or 0)
    except (TypeError, ValueError):
        agent_depth = 0
    agent_surface = str(params.get("agent_surface") or "main").strip() or "main"
    parent_approval_plan_hash = str(params.get("parent_approval_plan_hash") or "").strip()
    raw_interrupted_receipts = params.get("interrupted_turn_receipts")
    interrupted_turn_receipts = (
        raw_interrupted_receipts if isinstance(raw_interrupted_receipts, dict) else None
    )
    if turn_diagnostics is not None:
        turn_diagnostics.begin_turn(
            request_id=request_id,
            session_id=session_id,
            mode=mode,
            agent_id=agent_id,
            debug_options=debug_options,
        )
    workspace_status = stack.context_builder.workspace_status()
    workspace_root = getattr(stack.context_builder, "workspace_root", None)
    workspace_root_present = workspace_root is not None
    if not workspace_root_present:
        raw_workspace_root = getattr(stack.config, "tools_workspace_root", None) or getattr(
            stack.config, "agent_workspace_root", None
        )
        workspace_root_present = bool(str(raw_workspace_root or "").strip())
    has_legacy_learning_context = (
        memory_policy is None and params.get("learning_context") is not None
    )
    effective_memory_policy = (
        MemoryPolicy(enabled=False, include_response_style=False)
        if has_legacy_learning_context
        else MemoryPolicy(
            enabled=memory_policy.enabled if memory_policy is not None else True,
            include_response_style=(
                memory_policy.include_response_style if memory_policy is not None else True
            ),
            recall_query="\n".join(
                str(message.get("content") or "").strip()
                for message in messages
                if message.get("role") == "user"
                and not str(message.get("kind") or "").strip()
                and str(message.get("content") or "").strip()
            )[-600:],
        )
    )
    skill_invocation = _normalize_skill_invocation(
        params.get("skill_invocation"), request_id=request_id, session_id=session_id
    )
    request_context = ChatRequestContext(
        request_id=request_id,
        trace_id=trace_id,
        session_id=session_id,
        mode=mode,
        approvals_pre_granted=approvals_pre_granted,
        memory_policy=effective_memory_policy,
        reasoning_effort=reasoning_effort,
        session_start_date=session_start_date,
        current_date=resolve_current_date(),
        plan_mode=plan_mode,
        read_only=plan_mode or agent_surface != "main",
        approved_plan=approved_plan,
        tool_preferences=tool_preferences,
        approval_mode=approval_mode,
        session_offline_lockdown=raw_session_offline_lockdown,
        sub_agent_tool_preferences_fail_closed=(
            tool_preferences_require_sub_agent_fail_closed(raw_tool_preferences)
        ),
        workspace_root_present=workspace_root_present,
        workspace_instruction_present=workspace_status.instruction_file_present,
        debug_options=debug_options,
        interrupted_turn_receipts=interrupted_turn_receipts,
        context_blocks=tuple(context_blocks),
        skill_invocation=skill_invocation,
        vision_images=vision_images,
        vision_anchor_text=vision_anchor_text,
        vision_token_surcharge=_vision_turn.vision_token_surcharge(vision_images),
        session_tool_call_count=session_tool_call_count,
        agent_id=agent_id,
        parent_agent_id=parent_agent_id,
        agent_depth=max(agent_depth, 0),
        agent_surface=agent_surface,
        parent_approval_plan_hash=parent_approval_plan_hash,
        sub_agent_iteration_budget=getattr(stack.config, "max_sub_agent_loop_iterations", 10),
        sub_agent_concurrency_budget=effective_sub_agent_concurrency_budget(stack.config),
    )
    bind_chat_request_context(
        stack.engine,
        request_context=request_context,
        runtime_config=stack.config,
        diagnostics_store=turn_diagnostics,
    )
    healing_token = bind_tool_call_healing(stack.config)
    try:
        # Unified mode: any turn may answer a clarifying question.
        # interactive_response present-but-None-after-normalize means a
        # malformed payload.
        if (
            "interactive_response" in params
            and params.get("interactive_response") is not None
            and interactive_response is None
        ):
            raise ChatRequestError(
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                code=CHAT_INVALID_PARAMS,
                message="interactive_response payload is invalid.",
                rpc_code=invalid_params_code,
                retryable=False,
            )
        if vision_images and not engine_supports_vision(stack.engine):
            raise ChatRequestError(
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                code=CHAT_INVALID_PARAMS, message=_vision_turn.VISION_REFUSAL_MESSAGE,
                rpc_code=invalid_params_code, retryable=False,
            )
        if vision_images and not _vision_turn.vision_unified_turn_enabled(feature_flags):
            if not _vision_turn.legacy_vision_generation_supported(stack.engine):
                raise ChatRequestError(
                    request_id=request_id,
                    trace_id=trace_id,
                    session_id=session_id,
                    code=CHAT_INVALID_PARAMS, message=_vision_turn.VISION_REFUSAL_MESSAGE,
                    rpc_code=invalid_params_code, retryable=False,
                )
            if mode != "chat":
                raise ChatRequestError(
                    request_id=request_id,
                    trace_id=trace_id,
                    session_id=session_id,
                    code=CHAT_INVALID_PARAMS,
                    message="Image attachments are only available in chat mode.",
                    rpc_code=invalid_params_code,
                    retryable=False,
                )
            return _finalize_response(
                build_vision_chat_response(
                    request_id=request_id,
                    trace_id=trace_id,
                    session_id=session_id,
                    latest_user_content=latest_user_content,
                    messages=messages,
                    image_attachments=image_attachments,
                    brain_container=brain_container,
                    invalid_params_code=invalid_params_code,
                    post_response_callback=lambda _response_text: _maybe_run_post_response_tasks(
                        session_id=session_id,
                        brain_container=brain_container,
                    ),
                ),
            )
        learned_lessons = (
            None
            if memory_policy is not None
            else normalize_learned_lessons(params.get("learning_context"))
        )

        if (
            stream_notifications
            and mode == "chat"
            and not executor_runtime_enabled
            and engine_supports_live_reasoning_stream(stack.engine)
        ):
            return _finalize_response(
                build_live_streaming_chat_response(
                    request_id=request_id,
                    trace_id=trace_id,
                    session_id=session_id,
                    latest_user_content=latest_user_content,
                    messages=messages,
                    brain_container=brain_container,
                    reasoning_effort=reasoning_effort,
                    learned_lessons=learned_lessons,
                    memory_policy=effective_memory_policy,
                    context_blocks=context_blocks,
                    skill_invocation=skill_invocation,
                    vision_images=vision_images,
                    vision_anchor_text=vision_anchor_text,
                    max_tokens=resolve_effective_max_tokens(
                        stack.config.max_tokens,
                        stack.engine.get_model_max_output_tokens(),
                        user_override=getattr(
                            stack.config,
                            "resolved_user_max_output_tokens",
                            None,
                        ),
                    ),
                    current_date=request_context.current_date,
                    notification_writer=notification_writer,
                    cancel_handle=cancel_handle,
                    post_response_callback=lambda _response_text: (
                        _maybe_run_post_response_tasks(
                            session_id=session_id,
                            brain_container=brain_container,
                        )
                    ),
                ),
            )
        return _finalize_response(
            _build_router_response(
                request_context=request_context,
                latest_user_content=latest_user_content,
                messages=messages,
                brain_container=brain_container,
                learned_lessons=learned_lessons,
                canonical_session_messages=canonical_session_messages,
                session_title=session_title,
                invalid_params_code=invalid_params_code,
                stream_notifications=stream_notifications,
                notification_writer=notification_writer,
                electron_tool_reader=approval_reader,
                electron_tool_reader_factory=approval_reader_factory,
                electron_tool_writer=approval_writer,
                cancel_handle=cancel_handle,
                canonical_seq_state=canonical_seq_state,
            ),
        )
    except ChatRequestError as error:
        # Router/tool-loop terminal errors (a ChatGPT 429 among them) leave
        # this scope as ChatRequestError and only become `chat.error` in
        # chat_error_notification, after the request context is cleared
        # below. That helper merges error.data top-level, so carrying the
        # stashed plan-usage snapshot on the error is what puts
        # `chat.error.plan_usage` on the wire for the limit banner.
        if error.data is None:
            error.data = {}
        attach_plan_usage(
            error.data,
            stack.engine,
            enabled=is_chatgpt_plan_meter_enabled(feature_flags),
        )
        raise
    except _vision_turn.VisionAnchorError as error:
        raise ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=CHAT_INVALID_PARAMS, message=str(error),
            rpc_code=invalid_params_code, retryable=False,
        ) from error
    finally:
        reset_tool_call_healing(healing_token)
        clear_chat_request_context(stack.engine, request_id=request_id)
