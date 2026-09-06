"""Attach bounded tool-observation audit rows to chat results/errors."""

from __future__ import annotations

from typing import Any

from sidecar.ai.routing.tool_observation import recent_observations_payload
from sidecar.runtime.chat_models import ChatResponse


def tool_observations_for_request(
    stack: Any,
    *,
    request_id: str | None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return public tool-observation payloads for ``request_id`` if available."""
    store = getattr(stack, "tool_observations", None)
    if store is None:
        return []
    return recent_observations_payload(store, request_id=request_id, limit=limit)


def chat_result_with_tool_observations(
    result: dict[str, Any],
    stack: Any,
    *,
    request_id: str | None,
) -> dict[str, Any]:
    """Return ``result`` with additive ``tool_observations`` when rows exist."""
    observations = tool_observations_for_request(stack, request_id=request_id)
    if not observations:
        return result
    if "tool_observations" in result:
        return result
    return {**result, "tool_observations": observations}


def chat_response_with_tool_observations(
    response: ChatResponse,
    stack: Any,
) -> ChatResponse:
    """Return ``response`` with bounded audit observations attached to result."""
    result = chat_result_with_tool_observations(
        response.result,
        stack,
        request_id=response.request_id,
    )
    if result is response.result:
        return response
    return ChatResponse(
        request_id=response.request_id,
        result=result,
        notifications=response.notifications,
        approval_request=response.approval_request,
        approval_plan=response.approval_plan,
        post_settlement_callback=response.post_settlement_callback,
    )


def chat_error_data_with_tool_observations(
    data: dict[str, Any] | None,
    stack: Any,
    *,
    request_id: str | None,
) -> dict[str, Any] | None:
    """Return error data with additive ``tool_observations`` when rows exist."""
    observations = tool_observations_for_request(stack, request_id=request_id)
    if not observations:
        return data
    result = dict(data or {})
    result.setdefault("tool_observations", observations)
    return result
