"""Small support helpers for generation runtime import boundaries."""

from __future__ import annotations

from typing import Any

from sidecar.ai.config import resolve_effective_max_tokens
from sidecar.ai.context.compaction_prompts import compaction_reply
from sidecar.ai.context.messages import strip_thinking_from_all_messages

__all__ = [
    "compaction_reply_text",
    "resolve_effective_max_tokens",
    "strip_thinking_from_all_messages",
]


def compaction_reply_text(result: Any, feature_flags: Any) -> str:
    """A compaction reply's text, carrying the provider finish reason (row 60).

    A stalled stream ends with the watchdog's synthetic text and finish reason
    ``timeout``. That is not a summary to parse: raising keeps it from earning
    a re-ask, which would repeat the whole slow prefill.
    """
    finish_reason = getattr(result, "finish_reason", None)
    if finish_reason == "timeout":
        raise TimeoutError("Compaction summary call timed out")
    return compaction_reply(result.content or "", finish_reason, feature_flags)
