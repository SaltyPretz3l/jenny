"""Shared process outcome helpers for sidecar runtime orchestration."""

from __future__ import annotations

import re
from typing import Any, Callable, Mapping, NamedTuple

from sidecar.ai.routing.tool_resource_deferral import ToolLoopSuspended
from sidecar.runtime.chat import (
    ChatRequestError,
    request_id_from_params,
    session_id_from_params,
)
from sidecar.runtime.chat_models import continuation_identity_from_params, merge_error_data
from sidecar.runtime.execution_context import execution_context_from_params
from sidecar.runtime.rpc import result_response
from sidecar.runtime.runtime_gap import build_runtime_gap_candidate_notification

_CHECKPOINT_ID = re.compile(r"checkpoint_[0-9a-f]{64}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_CHECKPOINT_KEYS = frozenset(
    {"schema_version", "checkpoint_id", "sha256", "bytes", "source_attempt"}
)
_MIN_CHECKPOINT_BYTES = 2
_MAX_CHECKPOINT_BYTES = 1024 * 1024


class ProcessOutcome(NamedTuple):
    initialized: bool
    shutdown_requested: bool
    response: dict[str, Any] | None
    notifications: list[dict[str, Any]]
    post_settlement_callback: Callable[[], None] | None = None
    deliver_after_worker_cleanup: bool = False


def continuation_paused_outcome(
    *, initialized: bool, message_id: Any, params: Any, error: ToolLoopSuspended,
) -> ProcessOutcome:
    """Normalize a typed checkpoint suspension against its enclosing request."""

    if not isinstance(error, ToolLoopSuspended):
        raise ValueError("continuation suspension is not typed")
    request_id = request_id_from_params(params, message_id)
    session_id = session_id_from_params(params)
    execution_context = execution_context_from_params(params)
    logical_turn_id, context = continuation_identity_from_params(
        params, request_id=request_id, session_id=session_id,
        execution_context=execution_context,
    )
    value = error.checkpoint_ref
    expected_attempt = context.source_attempt.to_wire() if context is not None else None
    if (
        context is None
        or logical_turn_id != context.turn_id
        or not isinstance(value, Mapping)
        or set(value) != _CHECKPOINT_KEYS
        or isinstance(value.get("schema_version"), bool)
        or value.get("schema_version") != 1
        or not isinstance(value.get("checkpoint_id"), str)
        or _CHECKPOINT_ID.fullmatch(value["checkpoint_id"]) is None
        or not isinstance(value.get("sha256"), str)
        or _SHA256.fullmatch(value["sha256"]) is None
        or isinstance(value.get("bytes"), bool)
        or not isinstance(value.get("bytes"), int)
        or not _MIN_CHECKPOINT_BYTES <= value["bytes"] <= _MAX_CHECKPOINT_BYTES
        or not isinstance(value.get("source_attempt"), Mapping)
        or dict(value["source_attempt"]) != expected_attempt
    ):
        raise ValueError("continuation checkpoint reference mismatch")
    checkpoint_ref = {
        "schema_version": 1,
        "checkpoint_id": value["checkpoint_id"],
        "sha256": value["sha256"],
        "bytes": value["bytes"],
        "source_attempt": dict(expected_attempt),
    }
    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=result_response(message_id, {
            "request_id": request_id, "status": "paused", "checkpoint_ref": checkpoint_ref,
        }),
        notifications=[],
        deliver_after_worker_cleanup=True,
    )


def chat_error_outcome(
    *,
    initialized: bool,
    message_id: Any,
    error: ChatRequestError,
    error_response: Callable[..., dict[str, Any]],
    chat_error_notification: Callable[[ChatRequestError], dict[str, Any]],
) -> ProcessOutcome:
    notifications = [chat_error_notification(error)]
    runtime_gap_notification = build_runtime_gap_candidate_notification(error)
    if runtime_gap_notification is not None:
        notifications.append(runtime_gap_notification)
    # Electron reads error.data.retryable from the chat.send response and treats
    # an absent field as retryable; the notification already carries it.
    response_data: dict[str, Any] = {"code": error.code, "retryable": error.retryable}
    merge_error_data(response_data, error.data)
    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=error_response(
            message_id,
            code=error.rpc_code,
            message=error.message,
            data=response_data,
        ),
        notifications=notifications,
    )
