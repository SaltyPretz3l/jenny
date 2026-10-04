"""Chat-send helper cluster for the request-dispatch runtime hub.

Owns the pure/near-pure helpers used by ``process_chat_send_request``: workspace
preflight helpers, phase/canonical notification emitters, chat.send semantic
validation, failure-outcome builders, approval-resolution normalization, and
``_build_chat_response``.

Import direction is strictly one-way: this leaf module is imported by
``request_dispatch_chat`` and re-exported by the ``request_dispatch`` hub. It never
imports the hub at module level (only function-local, late-bound as ``_rd_hub``) to
avoid a circular import. Patch targets that tests set on the
``sidecar.runtime.request_dispatch`` module object (``build_chat_send_response``,
``resume_chat_send_response_from_approval_plan``, ``build_tool_catalog``, and
``log_event``) are resolved late through
``_rd_hub`` so the monkeypatch surface stays intact.
"""

from __future__ import annotations

import logging
import sys
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import (
    CMP_CHAT_INVALID_PARAMS,
    CMP_CHAT_STREAM_FAILED,
)
from sidecar.ai.mode_policy import policy_for_mode
from sidecar.ai.tools.catalog import MANAGED_SIDECAR_SURFACE
from sidecar.runtime.approval import ApprovalResolution
from sidecar.runtime.chat import (
    ChatRequestError,
    chat_error_notification,
    request_id_from_params,
    session_id_from_params,
    trace_id_from_params,
)
from sidecar.runtime.chat_message_validation import validate_chat_messages
from sidecar.runtime.chat_normalization import (
    reasoning_effort_from_params,
    session_start_date_from_params,
)
from sidecar.runtime.chat_serialization import _serialize_loop_event, _serialize_turn_event
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.outcomes import ProcessOutcome, chat_error_outcome
from sidecar.runtime.rpc import error_response, result_response
from sidecar.runtime.turn_retry import InnerRetryableTurnError
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
    TURN_STATE_CANCELLED,
    TURN_STATE_PREEMPTED,
    TURN_STATE_RUNTIME_ERROR,
    TURN_STATE_TIMEOUT,
    build_turn_result,
)

INVALID_PARAMS_CODE = -32602
INTERNAL_ERROR_CODE = -32000
CHAT_STREAM_FAILED = CMP_CHAT_STREAM_FAILED
CHAT_INVALID_PARAMS = CMP_CHAT_INVALID_PARAMS


def _workspace_root_configured(config: Any) -> bool:
    raw_workspace_root = getattr(config, "tools_workspace_root", None) or getattr(
        config, "agent_workspace_root", None
    )
    return bool(str(raw_workspace_root or "").strip())


def _request_tool_preference_set(
    tool_preferences: dict[str, Any] | None,
    key: str,
) -> frozenset[str]:
    if not isinstance(tool_preferences, dict):
        return frozenset()
    value = tool_preferences.get(key)
    if not isinstance(value, (list, tuple, set)):
        return frozenset()
    return frozenset(str(item).strip() for item in value if str(item).strip())


def _workspace_required_tool_names(
    *,
    config: Any,
    mode: str,
    tool_preferences: dict[str, Any] | None = None,
) -> frozenset[str]:
    """Names of workspace-requiring tools that would be active for this turn's
    tooling — mode policy, config flags, and the request's enabled/disabled tool
    preferences all applied.

    The tool-contract assembly already drops these from the model's tool list when
    no workspace root is configured (``sidecar/ai/tools/assembly.py``
    ``_base_unavailable_reason`` -> ``WORKSPACE_REQUIRED_REASON``), so an empty
    result means a missing root removes nothing the model could have used, and the
    turn can degrade gracefully rather than hard-fail.
    """
    import sidecar.runtime.request_dispatch as _rd_hub

    mode_policy = policy_for_mode(mode)
    descriptors = _rd_hub.build_tool_catalog(config=config)
    enabled_tools = _request_tool_preference_set(tool_preferences, "enabled_tools")
    disabled_tools = _request_tool_preference_set(tool_preferences, "disabled_tools")
    names: set[str] = set()

    for descriptor in descriptors:
        if MANAGED_SIDECAR_SURFACE not in tuple(getattr(descriptor, "surfaces", ()) or ()):
            continue

        config_flag = getattr(getattr(descriptor, "availability", None), "config_flag", None)
        if config_flag and getattr(config, config_flag, True) is not True:
            continue

        if descriptor.side_effecting and not bool(getattr(mode_policy, "allow_side_effecting_tools", False)):
            continue

        descriptor_name = str(getattr(descriptor, "name", "") or "").strip()
        if descriptor_name in disabled_tools:
            continue
        if enabled_tools and descriptor_name not in enabled_tools:
            continue

        if bool(getattr(getattr(descriptor, "availability", None), "workspace_required", False)):
            names.add(descriptor_name)

    return frozenset(names)


def _emit_phase_notification(
    *,
    enabled: bool,
    writer: Callable[[dict[str, Any]], None],
    event: Any,
    request_id: str,
    trace_id: str | None,
    session_id: str | None,
    canonical_enabled: bool = False,
    canonical_seq_state: dict[str, int] | None = None,
) -> None:
    if not enabled:
        return
    message = _serialize_loop_event(
        event,
        request_id,
        trace_id=trace_id,
        session_id=session_id,
    )
    if message is not None:
        writer(message)
    if canonical_enabled and canonical_seq_state is not None:
        next_seq = int(canonical_seq_state.get("seq", 0)) + 1
        canonical_message = _serialize_turn_event(
            event,
            request_id,
            trace_id=trace_id,
            session_id=session_id,
            seq=next_seq,
        )
        if canonical_message is not None:
            canonical_seq_state["seq"] = next_seq
            writer(canonical_message)


def _emit_canonical_notification(
    *,
    enabled: bool,
    writer: Callable[[dict[str, Any]], None],
    event: Any,
    request_id: str,
    trace_id: str | None,
    session_id: str | None,
    canonical_seq_state: dict[str, int] | None,
) -> None:
    if not enabled or canonical_seq_state is None:
        return
    next_seq = int(canonical_seq_state.get("seq", 0)) + 1
    canonical_message = _serialize_turn_event(
        event,
        request_id,
        trace_id=trace_id,
        session_id=session_id,
        seq=next_seq,
    )
    if canonical_message is None:
        return
    canonical_seq_state["seq"] = next_seq
    writer(canonical_message)


def _validate_chat_send_semantics(
    *,
    params: Any,
    message_id: Any,
) -> ChatRequestError | None:
    if not isinstance(params, dict):
        return None
    request_id = request_id_from_params(params, message_id)
    trace_id = trace_id_from_params(params, message_id)
    session_id = session_id_from_params(params)
    explicit_request_id = params.get("request_id")
    if "request_id" in params and (
        not isinstance(explicit_request_id, str) or not explicit_request_id.strip()
    ):
        return ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=CHAT_INVALID_PARAMS,
            message="chat.send params.request_id must be a non-empty string when provided.",
            rpc_code=INVALID_PARAMS_CODE,
            retryable=False,
        )
    if "messages" in params:
        messages = params.get("messages")
        if not isinstance(messages, list) or not messages:
            return ChatRequestError(
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                code=CHAT_INVALID_PARAMS,
                message="chat.send params.messages must be a non-empty list.",
                rpc_code=INVALID_PARAMS_CODE,
                retryable=False,
            )
        try:
            validate_chat_messages(messages)
        except ValueError as error:
            return ChatRequestError(
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                code=CHAT_INVALID_PARAMS,
                message=str(error),
                rpc_code=INVALID_PARAMS_CODE,
                retryable=False,
            )
    has_interactive_response = (
        "interactive_response" in params and params.get("interactive_response") is not None
    )
    # interactive_response is valid in any conversation mode, but must remain an
    # object with a non-empty batch_id.
    if has_interactive_response:
        interactive_candidate = params.get("interactive_response")
        candidate_batch_id = (
            str(interactive_candidate.get("batch_id") or "").strip()
            if isinstance(interactive_candidate, dict)
            else ""
        )
        if not candidate_batch_id:
            return ChatRequestError(
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                code=CHAT_INVALID_PARAMS,
                message=("interactive_response must be an object with a non-empty batch_id."),
                rpc_code=INVALID_PARAMS_CODE,
                retryable=False,
            )
    if "plan_mode" in params:
        value = params.get("plan_mode")
        if not isinstance(value, bool):
            return ChatRequestError(
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                code=CHAT_INVALID_PARAMS,
                message="chat.send params.plan_mode must be a boolean when provided.",
                rpc_code=INVALID_PARAMS_CODE,
                retryable=False,
            )
    try:
        reasoning_effort_from_params(params)
        session_start_date_from_params(params)
    except ValueError as error:
        return ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=CHAT_INVALID_PARAMS,
            message=str(error),
            rpc_code=INVALID_PARAMS_CODE,
            retryable=False,
        )
    return None


def _chat_unexpected_failure_outcome(
    *,
    initialized: bool,
    message_id: Any,
    params: Any,
    message: str,
    logger: logging.Logger,
) -> ProcessOutcome:
    logger.exception(message)
    exc_type, exc_value, _ = sys.exc_info()
    cause: dict[str, Any] | None = None
    if exc_type is not None:
        cause = {
            "error_type": exc_type.__name__,
            "error_message": str(exc_value)[:500] if exc_value is not None else None,
        }
    request_id = request_id_from_params(params, message_id)
    chat_error = ChatRequestError(
        request_id=request_id,
        trace_id=trace_id_from_params(params, message_id),
        session_id=session_id_from_params(params),
        code=CHAT_STREAM_FAILED,
        message=message,
        rpc_code=INTERNAL_ERROR_CODE,
        retryable=True,
        data=cause,
    )
    return chat_error_outcome(
        initialized=initialized,
        message_id=message_id,
        error=chat_error,
        error_response=error_response,
        chat_error_notification=chat_error_notification,
    )


def _post_approval_retryable_terminal_outcome(
    *,
    initialized: bool,
    message_id: Any,
    request_id: str,
    error: InnerRetryableTurnError,
) -> ProcessOutcome | None:
    normalized_subcode = str(error.terminal_subcode or "").strip().lower()
    if "plan_drift" not in normalized_subcode:
        return None
    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=result_response(
            message_id,
            build_turn_result(
                request_id=request_id,
                status=TURN_STATE_PREEMPTED,
                terminal_subcode=TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
            ),
        ),
        notifications=[],
    )


def _normalize_approval_resolution(
    resolution: ApprovalResolution | bool,
) -> ApprovalResolution:
    if isinstance(resolution, ApprovalResolution):
        return resolution
    return ApprovalResolution(
        approved=bool(resolution),
        status="approved" if resolution else "denied",
    )


def _approval_terminal_log_fields(terminal_status: str) -> tuple[str, str]:
    normalized_status = str(terminal_status or "").strip().lower()
    if normalized_status == TURN_STATE_TIMEOUT:
        return (
            "sidecar.runtime.chat_send.approval_timeout",
            "Tool approval timed out during chat.send",
        )
    if normalized_status == TURN_STATE_CANCELLED:
        return (
            "sidecar.runtime.chat_send.approval_cancelled",
            "Tool approval was cancelled during chat.send",
        )
    if normalized_status == TURN_STATE_PREEMPTED:
        return (
            "sidecar.runtime.chat_send.approval_preempted",
            "Tool approval was preempted during chat.send",
        )
    if normalized_status == TURN_STATE_RUNTIME_ERROR:
        return (
            "sidecar.runtime.chat_send.approval_runtime_error",
            "Tool approval failed during chat.send",
        )
    return (
        "sidecar.runtime.chat_send.approval_denied",
        "Tool execution denied during chat.send",
    )


def _build_chat_response(
    *,
    message_id: Any,
    params: Any,
    approvals_pre_granted: bool,
    brain_container: BrainContainer,
    stream_notifications: bool,
    write_message: Callable[[dict[str, Any]], None],
    read_message: Callable[[], dict[str, Any]],
    approval_response_reader: Callable[[float], dict[str, Any]] | None,
    approval_response_waiter_factory: Callable[
        [int, TurnCancellationHandle | None],
        Callable[[float], dict[str, Any]],
    ]
    | None,
    approval_timeout_seconds: float,
    cancel_handle: TurnCancellationHandle | None = None,
    approval_plan: Any | None = None,
    canonical_session_messages: Any = None,
    session_title: str = "",
    canonical_seq_state: dict[str, int] | None = None,
) -> Any:
    import sidecar.runtime.request_dispatch as _rd_hub

    bridge_response_reader = approval_response_reader or (lambda _timeout: read_message())
    if not isinstance(params, dict):
        return _rd_hub.build_chat_send_response(
            message_id,
            params,
            approvals_pre_granted=approvals_pre_granted,
            brain_container=brain_container,
            invalid_params_code=INVALID_PARAMS_CODE,
            stream_notifications=stream_notifications,
            notification_writer=write_message if stream_notifications else None,
            approval_reader=bridge_response_reader,
            approval_reader_factory=approval_response_waiter_factory,
            approval_timeout_seconds=approval_timeout_seconds,
            approval_writer=write_message,
            cancel_handle=cancel_handle,
            canonical_seq_state=canonical_seq_state,
        )

    def _execute_attempt(attempt_params: dict[str, Any]) -> Any:
        if approval_plan is not None:
            return _rd_hub.resume_chat_send_response_from_approval_plan(
                approval_plan,
                brain_container=brain_container,
                stream_notifications=stream_notifications,
                notification_writer=write_message if stream_notifications else None,
                electron_tool_reader=bridge_response_reader,
                electron_tool_reader_factory=approval_response_waiter_factory,
                electron_tool_writer=write_message,
                live_params=attempt_params,
                canonical_session_messages=canonical_session_messages,
                session_title=session_title,
                cancel_handle=cancel_handle,
                canonical_seq_state=canonical_seq_state,
            )
        return _rd_hub.build_chat_send_response(
            message_id,
            attempt_params,
            approvals_pre_granted=approvals_pre_granted,
            brain_container=brain_container,
            invalid_params_code=INVALID_PARAMS_CODE,
            stream_notifications=stream_notifications,
            notification_writer=write_message if stream_notifications else None,
            approval_reader=bridge_response_reader,
            approval_reader_factory=approval_response_waiter_factory,
            approval_timeout_seconds=approval_timeout_seconds,
            approval_writer=write_message,
            cancel_handle=cancel_handle,
            canonical_seq_state=canonical_seq_state,
        )
    return _execute_attempt(params)
