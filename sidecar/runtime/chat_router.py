"""Router-path orchestration for the chat runtime hub.

Owns the non-streaming/streaming router turn (``_build_router_response``).

Import direction: this module imports the shared leaf helpers from
``chat_response_builders`` and the decision serializer from
``chat_decision_render``.  Patch targets that tests set on the
``sidecar.runtime.chat`` module object (``AgentExecutor``) are resolved late
through ``_chat_hub`` so the monkeypatch surface stays intact.
"""

from __future__ import annotations

import time
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.feature_flags import (
    FEATURE_CANONICAL_TURN_EVENTS,
    is_feature_flag_enabled,
)
from sidecar.ai.routing.agent_executor import AgentExecutor, AgentProgressEvent
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.protocol import AGENT_PROGRESS_METHOD
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_helpers import notification_context
from sidecar.runtime.chat_models import (
    ChatRequestContext,
    ChatRequestError,
    ChatResponse,
    TerminalChatStateError,
)
from sidecar.runtime.chat_response_builders import (
    _terminal_chat_response,
    _tool_failure_error_data,
)
from sidecar.runtime.chat_serialization import _serialize_loop_event, _serialize_turn_event
from sidecar.runtime.chat_tool_observations import chat_response_with_tool_observations
from sidecar.runtime.diagnostics import diagnostics_context
from sidecar.runtime.ipc_payloads import IpcPayloadExternalizer
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.rpc import notification


def _build_router_response(
    *,
    request_context: ChatRequestContext,
    latest_user_content: str,
    messages: list[dict[str, object]],
    brain_container: BrainContainer,
    learned_lessons: list[Any] | None,
    canonical_session_messages: Any,
    session_title: str,
    invalid_params_code: int,
    stream_notifications: bool = False,
    notification_writer: Any | None = None,
    electron_tool_reader: Any | None = None,
    electron_tool_reader_factory: Any | None = None,
    electron_tool_writer: Any | None = None,
    cancel_handle: TurnCancellationHandle | None = None,
    canonical_seq_state: dict[str, int] | None = None,
) -> ChatResponse:
    from . import chat as _chat_hub

    request_id = request_context.request_id
    trace_id = request_context.trace_id
    session_id = request_context.session_id
    stack = brain_container.stack
    payload_externalizer = IpcPayloadExternalizer.from_config(stack.config)
    progress_notifications: list[dict[str, Any]] = []

    def emit_agent_progress(event: AgentProgressEvent) -> None:
        progress_payload: dict[str, Any] = {
            **notification_context(request_id, trace_id=trace_id, session_id=session_id),
            "task_id": event.task_id,
            "task_type": event.task_type,
            "source": event.source,
            "status": event.status,
            "stage": event.stage,
            "percent": event.percent,
            "summary": event.summary,
            "message": event.summary,
            "terminal": event.terminal,
            "success": event.success,
        }
        if event.agent_id:
            progress_payload["agent_id"] = event.agent_id
        if event.parent_agent_id:
            progress_payload["parent_agent_id"] = event.parent_agent_id
        if event.terminal_subcode:
            progress_payload["terminal_subcode"] = event.terminal_subcode
        progress_notifications.append(
            notification(
                AGENT_PROGRESS_METHOD,
                progress_payload,
            )
        )

    # -- Build LoopRuntime with event serialization callback ----------
    from sidecar.ai.routing.iteration_limits import (
        effective_chunk_inactivity_seconds,
        effective_max_loop_wall_seconds,
        max_iterations_for_agent_surface,
    )
    from sidecar.ai.routing.loop_events import LoopEvent
    from sidecar.ai.routing.loop_runtime import LoopRuntime

    runtime: LoopRuntime | None = None
    # One request-owned counter (W2-30-F07): shared with the dispatcher's
    # approval emissions and the resume runtime so seq never restarts at zero.
    seq_state = canonical_seq_state if canonical_seq_state is not None else {"seq": 0}
    if stream_notifications and callable(notification_writer):
        canonical_turn_events_enabled = is_feature_flag_enabled(
            stack.config.feature_flags or {},
            FEATURE_CANONICAL_TURN_EVENTS,
        )

        def _serialize_and_write(event: LoopEvent) -> None:
            msg = _serialize_loop_event(
                event,
                request_id,
                trace_id=trace_id,
                session_id=session_id,
                payload_externalizer=payload_externalizer,
            )
            if msg is not None:
                notification_writer(msg)
            if canonical_turn_events_enabled:
                next_seq = int(seq_state.get("seq", 0)) + 1
                canonical_msg = _serialize_turn_event(
                    event,
                    request_id,
                    trace_id=trace_id,
                    session_id=session_id,
                    seq=next_seq,
                )
                if canonical_msg is not None:
                    seq_state["seq"] = next_seq
                    notification_writer(canonical_msg)

        runtime = LoopRuntime(
            emit=_serialize_and_write,
            request_id=request_id,
            trace_id=trace_id or "",
            session_id=session_id or "",
            notification_writer=notification_writer,
            electron_tool_writer=electron_tool_writer,
            electron_tool_reader=electron_tool_reader,
            electron_tool_reader_factory=electron_tool_reader_factory,
            max_iterations=max_iterations_for_agent_surface(
                stack.config,
                mode=request_context.mode,
                agent_surface=request_context.agent_surface,
            ),
            wall_clock_deadline=(time.monotonic() + effective_max_loop_wall_seconds(stack.config)),
            chunk_inactivity_seconds=effective_chunk_inactivity_seconds(stack.config),
            model_load_grace_seconds=stack.config.model_load_grace_seconds,
            streaming=True,
            cancel_handle=cancel_handle,
            observation_store=getattr(stack, "tool_observations", None),
            request_context=request_context,
            sub_agent_slot_allocator=getattr(stack, "sub_agent_slot_allocator", None),
        )
    else:
        runtime = LoopRuntime(
            request_id=request_id,
            trace_id=trace_id or "",
            session_id=session_id or "",
            electron_tool_writer=electron_tool_writer,
            electron_tool_reader=electron_tool_reader,
            electron_tool_reader_factory=electron_tool_reader_factory,
            max_iterations=max_iterations_for_agent_surface(
                stack.config,
                mode=request_context.mode,
                agent_surface=request_context.agent_surface,
            ),
            wall_clock_deadline=(time.monotonic() + effective_max_loop_wall_seconds(stack.config)),
            chunk_inactivity_seconds=effective_chunk_inactivity_seconds(stack.config),
            model_load_grace_seconds=stack.config.model_load_grace_seconds,
            cancel_handle=cancel_handle,
            observation_store=getattr(stack, "tool_observations", None),
            request_context=request_context,
            sub_agent_slot_allocator=getattr(stack, "sub_agent_slot_allocator", None),
        )

    executor: AgentExecutor | None = None
    with diagnostics_context(
        request_id=request_id,
        trace_id=trace_id,
        session_id=session_id,
        agent_id=request_context.agent_id,
    ):
        try:
            if cancel_handle is not None:
                cancel_handle.raise_if_cancelled()
            feature_flags = stack.config.feature_flags or {}
            if _chat_hub._executor_runtime_enabled(feature_flags):
                executor = _chat_hub.AgentExecutor(
                    router=stack.router,
                    on_progress=emit_agent_progress,
                    feature_flags=feature_flags,
                )
                decision = executor.execute(
                    request_context=request_context,
                    messages=messages,
                    latest_user_content=latest_user_content,
                    learned_lessons=learned_lessons,
                    canonical_session_messages=(
                        canonical_session_messages
                        if isinstance(canonical_session_messages, list)
                        else None
                    ),
                    runtime=runtime,
                )
            else:
                decision = stack.router.build_chat_decision(
                    request_context=request_context,
                    request_id=request_id,
                    messages=messages,
                    latest_user_content=latest_user_content,
                    mode=request_context.mode,
                    approvals_pre_granted=request_context.approvals_pre_granted,
                    session_id=session_id,
                    learned_lessons=learned_lessons,
                    reasoning_effort=request_context.reasoning_effort,
                    session_start_date=request_context.session_start_date,
                    canonical_session_messages=(
                        canonical_session_messages
                        if isinstance(canonical_session_messages, list)
                        else None
                    ),
                    runtime=runtime,
                    plan_mode=request_context.plan_mode,
                    tool_preferences=request_context.tool_preferences,
                )
        except TerminalChatStateError as error:
            if runtime is not None:
                from sidecar.ai.routing.tool_loop import flush_unflushed_terminal_output

                flush_unflushed_terminal_output(runtime, stack.router)
            return _terminal_chat_response(
                request_id=request_id,
                status=error.status,
                terminal_subcode=error.terminal_subcode,
                notifications=progress_notifications,
                tool_observation_stack=stack,
            )
        except ToolExecutionFailure as error:
            raise ChatRequestError(
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                code=error.code,
                message=error.message,
                rpc_code=invalid_params_code,
                retryable=error.retryable,
                data=_tool_failure_error_data(
                    error,
                    stack,
                    request_id=request_id,
                ),
            ) from error

    if decision.approval_request is not None and not request_context.approvals_pre_granted:
        return chat_response_with_tool_observations(
            ChatResponse(
                request_id=request_id,
                result={"request_id": request_id, "status": "awaiting_approval"},
                notifications=progress_notifications,
                approval_request={
                    **notification_context(request_id, trace_id=trace_id, session_id=session_id),
                    **decision.approval_request.to_payload(),
                },
                approval_plan=decision.approval_plan,
            ),
            stack,
        )
    return _chat_response_from_decision(
        request_context=request_context,
        latest_user_content=latest_user_content,
        canonical_session_messages=canonical_session_messages,
        session_title=session_title,
        brain_container=brain_container,
        decision=decision,
        progress_notifications=progress_notifications,
        budget_messages=messages,
        stream_notifications=stream_notifications,
        notification_writer=notification_writer,
        canonical_seq_state=seq_state,
    )
