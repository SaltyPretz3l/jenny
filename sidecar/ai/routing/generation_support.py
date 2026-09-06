"""Small support helpers for generation runtime import boundaries."""

from __future__ import annotations

from sidecar.ai.config import resolve_effective_max_tokens
from sidecar.ai.context.messages import strip_thinking_from_all_messages

__all__ = [
    "resolve_effective_max_tokens",
    "strip_thinking_from_all_messages",
]
