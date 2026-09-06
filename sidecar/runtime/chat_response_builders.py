"""Shared terminal-response and tool-failure error helpers for chat.

Leaf module in the chat runtime hub: it depends only on protocol/error
contracts and the tool-observation serializers, and every other chat sibling
imports the two helpers here.  No chat sibling imports back from this module.
"""

from __future__ import annotations

from typing import Any, Callable, Sequence

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.chat_models import ChatResponse
from sidecar.runtime.chat_tool_observations import (
    chat_error_data_with_tool_observations,
    chat_response_with_tool_observations,
)
from sidecar.runtime.turn_state import build_turn_result


def _tool_failure_error_data(
    error: ToolExecutionFailure,
    stack: Any,
    *,
    request_id: str | None,
) -> dict[str, Any] | None:
    data = chat_error_data_with_tool_observations(
        None,
        stack,
        request_id=request_id,
    ) or {}
    data.update(error.to_error_data())
    return data or None


def _terminal_chat_response(
    *,
    request_id: str,
    status: str,
    terminal_subcode: str | None = None,
    notifications: Sequence[dict[str, Any]] | None = None,
    tool_observation_stack: Any | None = None,
    response_text: str | None = None,
    completion_source: str | None = None,
    post_settlement_callback: Callable[[], None] | None = None,
) -> ChatResponse:
    result_payload: dict[str, Any] = build_turn_result(
        request_id=request_id,
        status=status,
        terminal_subcode=terminal_subcode,
    )
    if response_text is not None:
        result_payload["response_text"] = response_text
    if completion_source:
        result_payload["completion_source"] = completion_source
    response = ChatResponse(
        request_id=request_id,
        result=result_payload,
        notifications=list(notifications or []),
        approval_request=None,
        approval_plan=None,
        post_settlement_callback=post_settlement_callback,
    )
    return chat_response_with_tool_observations(response, tool_observation_stack)
