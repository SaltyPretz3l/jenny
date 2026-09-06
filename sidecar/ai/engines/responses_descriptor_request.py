"""Closed-vocabulary request shaping for declarative Responses providers."""

from __future__ import annotations

from typing import Any

from sidecar.ai.engines.chatgpt_subscription_request import (
    build_responses_payload as _build_responses_payload,
)

REQUEST_PROFILE = "openai_responses_v1"


def build_responses_payload(
    *, request_profile: str = REQUEST_PROFILE, **kwargs: Any
) -> dict[str, Any]:
    """Build a request only for a descriptor profile Jenny explicitly implements."""
    if request_profile != REQUEST_PROFILE:
        raise ValueError("provider request profile rejected")
    return _build_responses_payload(**kwargs)


__all__ = ["REQUEST_PROFILE", "build_responses_payload"]
