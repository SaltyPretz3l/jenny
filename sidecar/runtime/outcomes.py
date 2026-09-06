"""Shared process outcome helpers for sidecar runtime orchestration."""

from __future__ import annotations

from typing import Any, Callable, NamedTuple

from sidecar.runtime.chat import ChatRequestError
from sidecar.runtime.chat_models import merge_error_data
from sidecar.runtime.runtime_gap import build_runtime_gap_candidate_notification


class ProcessOutcome(NamedTuple):
    initialized: bool
    shutdown_requested: bool
    response: dict[str, Any] | None
    notifications: list[dict[str, Any]]
    post_settlement_callback: Callable[[], None] | None = None


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
    response_data: dict[str, Any] = {"code": error.code}
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
