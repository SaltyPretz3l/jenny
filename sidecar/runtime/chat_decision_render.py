"""Decision → notification serializer for the chat runtime hub.

``_chat_response_from_decision`` turns a resolved ``ChatDecision`` into the
terminal ``ChatResponse`` plus the ordered notification stream (thinking,
tool-execution, tokens, usage/done, canonical turn events).  It sits one layer
above ``chat_response_builders`` and below ``chat_router`` / ``chat_resume``.
"""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import CMP_STREAM_INCOMPLETE
from sidecar.ai.feature_flags import (
    FEATURE_CANONICAL_TURN_EVENTS,
    FEATURE_CONTEXT_COMPACTION,
    FEATURE_TOKEN_BUDGET,
    is_chatgpt_plan_meter_enabled,
    is_feature_flag_enabled,
)
from sidecar.ai.routing.router import ChatDecision
from sidecar.ai.routing.turn_event_contract import build_canonical_turn_event
from sidecar.ai.thinking_guard import resolve_thinking_budget_chars
from sidecar.ai.tools.trusted_attachments import attachment_refs
from sidecar.protocol import (
    CHAT_DONE_METHOD,
    CHAT_ERROR_METHOD,
    CHAT_THINKING_KIND_REASONING,
    CHAT_TOKEN_METHOD,
    TOOL_EXECUTING_METHOD,
    TOOL_RESULT_METHOD,
    TURN_EVENT_METHOD,
)
from sidecar.runtime.chat_helpers import (
    _decision_usage_payload,
    _fallback_usage_payload,
    attach_compact_threshold,
    attach_context_used_tokens,
    attach_context_window,
    estimate_text_tokens,
    notification_context,
    thinking_notification,
    tokenize_with_whitespace,
)
from sidecar.runtime.plan_usage_snapshot import attach_plan_usage
from sidecar.runtime.chat_models import ChatRequestContext, ChatResponse
from sidecar.runtime.chat_response_builders import _terminal_chat_response
from sidecar.runtime.diagnostics import sanitize_diagnostic_text
from sidecar.runtime.ipc_payloads import IpcPayloadExternalizer
from sidecar.runtime.reasoning_status import sanitize_visible_text
from sidecar.runtime.rpc import notification
from sidecar.runtime.turn_state import (
    RUNTIME_ERROR_TERMINAL_SUBCODES,
    TERMINAL_SUBCODE_STREAM_INCOMPLETE,
    TURN_STATE_COMPLETED,
    TURN_STATE_RUNTIME_ERROR,
)


def _toolwork_only_fallback(*, successful: int, failed: int) -> str:
    if failed:
        return (
            f"Tool work finished with {successful} successful and {failed} failed "
            "tool result(s), but the model did not return a visible final answer. "
            "Review the tool results above."
        )
    return (
        "Tool work completed successfully, but the model did not return a visible "
        "final answer. Review the tool results above."
    )


def _chat_response_from_decision(
    *,
    request_context: ChatRequestContext,
    latest_user_content: str,
    canonical_session_messages: Any,
    session_title: str,
    brain_container: BrainContainer,
    decision: ChatDecision,
    progress_notifications: list[dict[str, Any]] | None = None,
    budget_messages: list[dict[str, object]] | None = None,
    stream_notifications: bool = False,
    notification_writer: Any | None = None,
    canonical_seq_state: dict[str, int] | None = None,
) -> ChatResponse:
    from . import chat as _chat_hub

    request_id = request_context.request_id
    trace_id = request_context.trace_id
    session_id = request_context.session_id
    mode = request_context.mode
    stack = brain_container.stack
    payload_externalizer = IpcPayloadExternalizer.from_config(stack.config)
    feature_flags = stack.config.feature_flags or {}
    progress_notifications = list(progress_notifications or [])

    turn_diagnostics = getattr(stack, "turn_diagnostics", None)
    if turn_diagnostics is not None:
        turn_diagnostics.record_request_metrics(
            request_id=request_id,
            mode=mode,
            context_tokens_estimate=decision.context_tokens_estimate,
            message_count=decision.message_count,
            tool_schema_count=decision.tool_schema_count,
        )

    notifications: list[dict[str, Any]] = []
    notifications.extend(progress_notifications)
    streamed = decision.streamed_event_types
    live_notification_writer = (
        notification_writer
        if stream_notifications
        and callable(notification_writer)
        and "chat.token" in streamed
        else None
    )
    terminal_stream_live = live_notification_writer is not None
    canonical_turn_events_enabled = is_feature_flag_enabled(
        feature_flags,
        FEATURE_CANONICAL_TURN_EVENTS,
    )
    # One request-owned counter (W2-30-F07): the caller threads the same dict
    # through router, approval emissions, and resume so seq never restarts.
    seq_state = canonical_seq_state if canonical_seq_state is not None else {"seq": 0}

    def append_canonical(
        event_type: str,
        payload: dict[str, Any] | None = None,
        *,
        tool_call_id: str = "",
        emit_live: bool = False,
    ) -> None:
        if not canonical_turn_events_enabled:
            return
        canonical_seq = int(seq_state.get("seq", 0)) + 1
        seq_state["seq"] = canonical_seq
        source_payload = dict(payload or {})
        if trace_id:
            source_payload["trace_id"] = trace_id
        event = build_canonical_turn_event(
            event_type=event_type,
            turn_id=request_id,
            stream_id=request_id,
            session_id=session_id or "",
            seq=canonical_seq,
            payload=source_payload,
            tool_call_id=tool_call_id,
        )
        turn_notification = notification(TURN_EVENT_METHOD, event.to_payload())
        if emit_live and live_notification_writer is not None:
            live_notification_writer(turn_notification)
            return
        notifications.append(turn_notification)

    if "chat.thinking" not in streamed and decision.thinking_text:
        thinking_budget_chars = resolve_thinking_budget_chars(
            stack.engine, getattr(stack.config, "max_tokens", 0)
        )
        notifications.append(
            thinking_notification(
                request_id,
                trace_id=trace_id,
                session_id=session_id,
                delta=decision.thinking_text,
                thinking_id=f"think_{request_id}",
                kind=decision.thinking_kind,
                persist=decision.persist_thinking,
                thinking_budget_chars=(
                    thinking_budget_chars
                    if decision.persist_thinking
                    or decision.thinking_kind == CHAT_THINKING_KIND_REASONING
                    else None
                ),
            )
        )
        append_canonical(
            "reasoning_delta" if decision.persist_thinking else "status_part",
            {
                (
                    "delta"
                    if decision.persist_thinking
                    else "status_text"
                ): decision.thinking_text,
                "thinking_id": f"think_{request_id}",
                "kind": decision.thinking_kind,
                "persist": decision.persist_thinking,
            },
        )

    if decision.tool_results:
        for outcome in decision.tool_results:
            tool_call_id = str(outcome.call_id or "").strip()
            if "tool.executing" not in streamed:
                executing_payload = {
                    **notification_context(request_id, trace_id=trace_id, session_id=session_id),
                    "tool_name": outcome.tool_name,
                    "tool_call_id": tool_call_id,
                    "tool_input": dict(outcome.tool_input),
                }
                executing_payload = payload_externalizer.harden_tool_notification(
                    method=TOOL_EXECUTING_METHOD,
                    params=executing_payload,
                    request_id=request_id,
                    trace_id=trace_id,
                    session_id=session_id,
                )
                notifications.append(
                    notification(
                        TOOL_EXECUTING_METHOD,
                        executing_payload,
                    )
                )
                append_canonical(
                    "tool_execution_started",
                    {
                        "tool_name": outcome.tool_name,
                        "tool_input": dict(outcome.tool_input),
                    },
                    tool_call_id=tool_call_id,
                )
            if "tool.result" not in streamed:
                result_payload: dict[str, Any] = {
                    **notification_context(request_id, trace_id=trace_id, session_id=session_id),
                    "tool_name": outcome.tool_name,
                    "tool_call_id": tool_call_id,
                    "success": outcome.success,
                    "output": outcome.output,
                    "content_type": outcome.content_type,
                    "tool_input": dict(outcome.tool_input),
                }
                if outcome.ui_payload is not None:
                    result_payload["ui_payload"] = outcome.ui_payload
                if outcome.generated_artifacts:
                    result_payload["generated_artifacts"] = [
                        dict(item) for item in outcome.generated_artifacts
                    ]
                if outcome.error_code:
                    result_payload["error_code"] = outcome.error_code
                if outcome.metadata:
                    result_payload["metadata"] = dict(outcome.metadata)
                outcome_attachments = tuple(getattr(outcome, "trusted_attachments", ()) or ())
                if outcome_attachments:
                    # WIDE-019: live notification carries the full (admitted,
                    # bounded) payloads; the canonical event below persists
                    # only safe refs — never bytes/base64.
                    result_payload["trusted_attachments"] = [
                        dict(item) for item in outcome_attachments
                    ]
                result_payload = payload_externalizer.harden_tool_notification(
                    method=TOOL_RESULT_METHOD,
                    params=result_payload,
                    request_id=request_id,
                    trace_id=trace_id,
                    session_id=session_id,
                )
                notifications.append(notification(TOOL_RESULT_METHOD, result_payload))
                append_canonical(
                    "tool_execution_completed" if outcome.success else "tool_execution_failed",
                    {
                        "tool_name": outcome.tool_name,
                        "success": outcome.success,
                        "tool_output_summary": outcome.output,
                        "content_type": outcome.content_type,
                        "tool_input": dict(outcome.tool_input),
                        **({"error_code": outcome.error_code} if outcome.error_code else {}),
                        **({"metadata": dict(outcome.metadata)} if outcome.metadata else {}),
                        **(
                            {"trusted_attachment_refs": attachment_refs(outcome_attachments)}
                            if outcome_attachments
                            else {}
                        ),
                    },
                    tool_call_id=tool_call_id,
                )

    terminal_error_code = str(
        getattr(decision, "terminal_error_code", None) or ""
    ).strip()
    if terminal_error_code:
        explicit_terminal_subcode = getattr(decision, "terminal_subcode", None)
        explicit_terminal_subcode = (
            explicit_terminal_subcode.strip()
            if isinstance(explicit_terminal_subcode, str)
            else ""
        )
        if explicit_terminal_subcode not in RUNTIME_ERROR_TERMINAL_SUBCODES:
            explicit_terminal_subcode = ""
        visible_error_text = sanitize_visible_text(decision.response_text).strip()
        error_message = sanitize_diagnostic_text(
            visible_error_text or "Chat could not continue.",
            limit=512,
        )
        retryable = bool(getattr(decision, "terminal_error_retryable", False))
        error_payload = {
            **notification_context(
                request_id,
                trace_id=trace_id,
                session_id=session_id,
            ),
            "code": terminal_error_code,
            "message": error_message,
            "retryable": retryable,
        }
        attach_plan_usage(
            error_payload,
            stack.engine,
            enabled=is_chatgpt_plan_meter_enabled(feature_flags),
        )
        error_notification = notification(CHAT_ERROR_METHOD, error_payload)
        if live_notification_writer is not None:
            live_notification_writer(error_notification)
        else:
            notifications.append(error_notification)
        append_canonical(
            "turn_failed",
            {
                "code": terminal_error_code,
                "message": error_message,
                "retryable": retryable,
            },
            emit_live=terminal_stream_live,
        )
        _chat_hub.log_event(
            _chat_hub.logger,
            logging.WARNING,
            component="runtime.chat",
            event="runtime.chat.decision_terminal_error",
            message="Serialized an explicit terminal chat decision as a failure.",
            status="failure",
            trace_id=trace_id,
            request_id=request_id,
            session_id=session_id,
            data={"error_code": terminal_error_code, "retryable": retryable},
        )
        return _terminal_chat_response(
            request_id=request_id,
            status=TURN_STATE_RUNTIME_ERROR,
            terminal_subcode=(
                explicit_terminal_subcode
                or (
                    TERMINAL_SUBCODE_STREAM_INCOMPLETE
                    if terminal_error_code == CMP_STREAM_INCOMPLETE
                    else None
                )
            ),
            notifications=notifications,
            tool_observation_stack=stack,
            response_text=error_message,
            completion_source=str(
                getattr(decision, "completion_source", "") or "terminal_error"
            ),
        )

    if getattr(decision, "approval_request", None) is not None:
        # Callers own the approval branch: a decision still carrying an
        # approval request means that branch was skipped and the request is
        # about to be discarded, settling the turn as a silent success. This
        # is a caller bug -- make it loud instead of invisible.
        _chat_hub.log_event(
            _chat_hub.logger,
            logging.ERROR,
            component="runtime.chat",
            event="runtime.chat.approval_request_dropped",
            message=(
                "Terminal chat decision still carried an unconsumed approval "
                "request; the caller skipped its awaiting_approval branch."
            ),
            status="failure",
            trace_id=trace_id,
            request_id=request_id,
            session_id=session_id,
            data={"tool_result_count": len(decision.tool_results)},
        )

    visible_response_text = sanitize_visible_text(decision.response_text)
    completion_source = str(getattr(decision, "completion_source", "model") or "model")
    successful_tool_result_count = sum(
        1 for outcome in decision.tool_results if getattr(outcome, "success", False)
    )
    failed_tool_result_count = len(decision.tool_results) - successful_tool_result_count
    fallback_applied = False
    if not visible_response_text.strip() and decision.tool_results:
        visible_response_text = _toolwork_only_fallback(
            successful=successful_tool_result_count,
            failed=failed_tool_result_count,
        )
        completion_source = "deterministic_tool_fallback"
        fallback_applied = True
        _chat_hub.log_event(
            _chat_hub.logger,
            logging.WARNING,
            component="runtime.chat",
            event="runtime.chat.toolwork_only_completion_recovered",
            message="Recovered a blank post-tool completion.",
            status="degraded",
            trace_id=trace_id,
            request_id=request_id,
            session_id=session_id,
            data={
                "tool_result_count": len(decision.tool_results),
                "successful_tool_result_count": successful_tool_result_count,
                "failed_tool_result_count": failed_tool_result_count,
            },
        )
    if (
        turn_diagnostics is not None
        and hasattr(turn_diagnostics, "record_terminal_completion")
    ):
        turn_diagnostics.record_terminal_completion(
            request_id=request_id,
            completion_source=completion_source,
            visible_response_chars=len(visible_response_text),
            tool_result_count=len(decision.tool_results),
            successful_tool_result_count=successful_tool_result_count,
            fallback_applied=fallback_applied,
        )
    if "chat.token" not in streamed:
        deltas = tokenize_with_whitespace(visible_response_text)
        for sequence, delta in enumerate(deltas, start=1):
            notifications.append(notification(
                CHAT_TOKEN_METHOD,
                {
                    **notification_context(request_id, trace_id=trace_id, session_id=session_id),
                    "delta": delta,
                    "role": "assistant",
                },
            ))
            # sequence must be 1-based to match legacyTextSequence in managed runtime dedup
            append_canonical(
                "text_delta",
                {
                    "delta": delta,
                    "role": "assistant",
                    "sequence": sequence,
                },
            )
    usage_payload = _decision_usage_payload(
        decision.usage,
        fallback_provider=stack.config.engine_type,
        fallback_model=stack.config.model,
    ) or _fallback_usage_payload(
        latest_user_content=latest_user_content,
        output_tokens=estimate_text_tokens(visible_response_text),
        provider=stack.config.engine_type,
        model=stack.config.model,
    )
    context_tokens = decision.context_tokens_estimate
    if context_tokens is None and is_feature_flag_enabled(feature_flags, FEATURE_TOKEN_BUDGET):
        from sidecar.ai.context.token_budget import (
            CharEstimationBackend,
            estimate_messages_tokens,
        )

        try:
            from sidecar.ai.context.tokenizers import create_tokenizer_backend

            _backend = create_tokenizer_backend()
        except Exception:  # noqa: BLE001
            _backend = CharEstimationBackend()
        context_tokens = estimate_messages_tokens(budget_messages or [], _backend)
    if context_tokens is not None:
        usage_payload["context_tokens_estimate"] = context_tokens
    attach_context_used_tokens(usage_payload, context_tokens_estimate=context_tokens)
    attach_context_window(usage_payload, stack.engine)
    attach_plan_usage(
        usage_payload,
        stack.engine,
        enabled=is_chatgpt_plan_meter_enabled(feature_flags),
    )
    # Only forward the compaction trigger when compaction can actually fire
    # (both flags on); otherwise the meter would advertise an auto-compact
    # point that the disabled runtime will never act on.
    if is_feature_flag_enabled(
        feature_flags, FEATURE_TOKEN_BUDGET
    ) and is_feature_flag_enabled(feature_flags, FEATURE_CONTEXT_COMPACTION):
        attach_compact_threshold(
            usage_payload,
            stack.engine,
            stack.config,
            num_tools=int(decision.tool_schema_count or 0),
            threshold_tokens=getattr(decision, "compact_threshold_tokens", None),
        )
    if visible_response_text:
        append_canonical(
            "text_part_completed",
            {
                "text": visible_response_text,
                "assistant_phase": "final_answer",
                "segment_id": f"assistant_{request_id}_seg_0",
                "segment_group_index": 0,
                "completion_source": completion_source,
            },
            emit_live=terminal_stream_live,
        )
    done_notification = notification(
        CHAT_DONE_METHOD,
        {
            **notification_context(request_id, trace_id=trace_id, session_id=session_id),
            "usage": usage_payload,
            "stop_reason": "end_turn",
            "model": str(usage_payload.get("model") or stack.config.model),
            "provider": str(usage_payload.get("provider") or stack.config.engine_type),
            "response_text": visible_response_text,
            "completion_source": completion_source,
            **(
                {"resumable_stop": getattr(decision, "resumable_stop", None)}
                if getattr(decision, "resumable_stop", None)
                else {}
            ),
        },
    )
    if live_notification_writer is not None:
        live_notification_writer(done_notification)
        _chat_hub.log_event(
            _chat_hub.logger,
            logging.DEBUG,
            component="runtime.chat",
            event="runtime.chat.router_done_emitted_live",
            message="Emitted router chat.done before post-response tasks.",
            status="emitted",
            trace_id=trace_id,
            request_id=request_id,
            session_id=session_id,
            data={
                "mode": mode,
                "stream_notifications": True,
                "streamed_chat_token": True,
            },
        )
    else:
        notifications.append(done_notification)
    append_canonical(
        "turn_completed",
        {
            "stop_reason": "end_turn",
            "model": str(usage_payload.get("model") or stack.config.model),
            "provider": str(usage_payload.get("provider") or stack.config.engine_type),
        },
        emit_live=terminal_stream_live,
    )
    return _terminal_chat_response(
        request_id=request_id,
        status=TURN_STATE_COMPLETED,
        notifications=notifications,
        tool_observation_stack=stack,
        response_text=visible_response_text,
        completion_source=completion_source,
        post_settlement_callback=lambda: _chat_hub._maybe_run_post_response_tasks(
            session_id=session_id,
            brain_container=brain_container,
        ),
    )
