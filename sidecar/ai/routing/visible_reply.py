"""Bound the user-visible final reply without the tool-output cap.

Live gate 2026-10-05: a 22,830-character final reply was cut to 16,000 with a
bare " [truncated]" marker. ``MAX_RESPONSE_CHARS`` bounds tool output and
sub-agent reports that re-enter the model's context; the final reply is
streamed to Electron uncapped and persisted there, so the cut was a pure
display loss. The reply keeps the sanitizer (control-token cut, scaffolding
strip, secret redaction) under a far larger safety ceiling and, only past that
ceiling, is cut at a paragraph or sentence boundary with honest copy.
"""

from __future__ import annotations

import logging

from sidecar.ai.tools.sanitization import sanitize_visible_reply
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

__all__ = ("MAX_VISIBLE_REPLY_CHARS", "finalize_visible_reply")

# The same ceiling Electron's reasoning store keeps
# (services/backend/chat-stream-reasoning-delta.js). A 32k-token generation is
# roughly 130k characters, so a healthy reply never reaches it.
MAX_VISIBLE_REPLY_CHARS = 262_144


def finalize_visible_reply(
    raw_content: object,
    *,
    request_id: str | None = None,
    session_id: str | None = None,
    max_chars: int = MAX_VISIBLE_REPLY_CHARS,
) -> str:
    """Sanitize a final reply for display; log when the safety ceiling cut it."""
    raw = str(raw_content or "")
    text, was_cut = sanitize_visible_reply(raw, max_chars=max_chars)
    if was_cut:
        log_event(
            logger,
            logging.INFO,
            component="ai.router",
            event="ai.router.response_truncated",
            message="Final reply passed the visible-reply ceiling and was cut at a boundary",
            status="truncated",
            data={
                "original_length": len(raw),
                "truncated_to": max_chars,
                "kept_length": len(text),
            },
            request_id=request_id,
            session_id=session_id,
        )
    return text
