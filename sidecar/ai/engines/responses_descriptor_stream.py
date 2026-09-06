"""Closed-vocabulary SSE mapping for declarative Responses providers."""

from __future__ import annotations

from collections.abc import Generator
from typing import Any

from sidecar.ai.engines.chatgpt_subscription_stream import (
    raise_for_initial_status,
    raise_if_cancelled,
    register_close_cancel_callback,
)
from sidecar.ai.engines.chatgpt_subscription_stream import (
    stream_response_events as _stream_response_events,
)
from sidecar.ai.engines.responses_descriptor_request import build_responses_payload
from sidecar.ai.tools.models import GenerationResult, StreamChunk

STREAM_PROFILE = "openai_responses_sse_v1"


def stream_response_events(
    response: Any,
    *,
    stream_profile: str = STREAM_PROFILE,
    **kwargs: Any,
) -> Generator[StreamChunk, None, GenerationResult]:
    """Interpret only the named SSE mapping admitted by the V5 contract."""
    if stream_profile != STREAM_PROFILE:
        raise ValueError("provider stream profile rejected")
    return (yield from _stream_response_events(response, **kwargs))


__all__ = [
    "STREAM_PROFILE",
    "build_responses_payload",
    "raise_for_initial_status",
    "raise_if_cancelled",
    "register_close_cancel_callback",
    "stream_response_events",
]
