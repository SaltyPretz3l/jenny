"""Sanitize assistant-visible text, including leaked ⟨STATUS:⟩ markers."""

from __future__ import annotations

import re
from typing import Final

from sidecar.ai.reasoning_parser import strip_known_reasoning_blocks
from sidecar.ai.tools.sanitization import drop_special_tokens, strip_visible_thought_sentinels

_VISIBLE_STATUS_OPEN_VARIANTS: Final = (
    "\u27e8",
    "\u00e2\u0178\u00a8",
    "\u00c3\u00a2\u00c5\u00b8\u00c2\u00a8",
    "{",
)
_VISIBLE_STATUS_CLOSE_VARIANTS: Final = (
    "\u27e9",
    "\u00e2\u0178\u00a9",
    "\u00c3\u00a2\u00c5\u00b8\u00c2\u00a9",
    "}",
)
_VISIBLE_STATUS_RE: Final = re.compile(
    rf"(?:{'|'.join(re.escape(value) for value in _VISIBLE_STATUS_OPEN_VARIANTS)})"
    r"STATUS:\s*(.{2,120}?)"
    rf"(?:{'|'.join(re.escape(value) for value in _VISIBLE_STATUS_CLOSE_VARIANTS)})",
    re.IGNORECASE,
)


def strip_content_markers(text: str) -> str:
    """Remove STATUS markers that leaked into assistant-visible content."""

    return _VISIBLE_STATUS_RE.sub("", text)


def sanitize_visible_text(text: str) -> str:
    """Canonical sanitizer for assistant-visible text."""

    cleaned = drop_special_tokens(str(text or ""))
    cleaned = strip_known_reasoning_blocks(cleaned)
    cleaned = strip_visible_thought_sentinels(cleaned)
    return strip_content_markers(cleaned)
