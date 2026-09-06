"""Extract ⟨STATUS:⟩ markers from reasoning token streams."""

from __future__ import annotations

import re
from typing import Final

from sidecar.ai.reasoning_parser import strip_known_reasoning_blocks
from sidecar.ai.tools.sanitization import drop_special_tokens, strip_visible_thought_sentinels

_STATUS_RE: Final = re.compile(r"\u27E8STATUS:\s*(.{2,80}?)\u27E9")
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
_MAX_WORDS: Final[int] = 8
_MAX_TAIL_BYTES: Final[int] = 256

_SENTENCE_SPLIT_RE: Final = re.compile(r"(?<=[.!?\n])\s+")
_FILLER_RE: Final = re.compile(
    r"^(?:okay|ok|so|well|now|let me|let's|i need to|i should|i will|i'll|hmm|alright|right)\b[,:]?\s*",
    re.IGNORECASE,
)
_SYNTH_CHAR_THRESHOLD: Final[int] = 120
_SYNTH_MAX_WORDS: Final[int] = 6


class ReasoningStatusExtractor:
    """Stream-safe extractor for ⟨STATUS:⟩ reasoning markers."""

    __slots__ = ("_tail", "_prev_status")

    def __init__(self) -> None:
        self._tail: str = ""
        self._prev_status: str = ""

    def feed(self, chunk: str) -> tuple[str, str | None]:
        """Process one reasoning chunk and return cleaned text plus a new status."""

        text = f"{self._tail}{chunk}" if self._tail else chunk
        self._tail = ""

        open_idx = text.rfind("\u27e8")
        if open_idx != -1 and "\u27e9" not in text[open_idx:]:
            candidate_tail = text[open_idx:]
            if len(candidate_tail.encode("utf-8")) <= _MAX_TAIL_BYTES:
                self._tail = candidate_tail
                text = text[:open_idx]

        if not text:
            return ("", None)

        latest_status: str | None = None

        def _replace_marker(match: re.Match[str]) -> str:
            nonlocal latest_status
            payload = match.group(1).strip()
            words = payload.split()
            if not words or len(words) > _MAX_WORDS:
                return match.group(0)
            latest_status = payload
            return ""

        cleaned = _STATUS_RE.sub(_replace_marker, text)

        if latest_status is not None:
            while "\n\n\n" in cleaned:
                cleaned = cleaned.replace("\n\n\n", "\n\n")

        if latest_status is not None and latest_status == self._prev_status:
            latest_status = None
        if latest_status is not None:
            self._prev_status = latest_status

        return (cleaned, latest_status)

    def flush(self) -> str:
        """Flush any buffered tail as literal reasoning text."""

        tail = self._tail
        self._tail = ""
        return tail


class ReasoningStatusSynthesizer:
    """Synthesize status updates from reasoning text when no ⟨STATUS:⟩ markers appear."""

    __slots__ = ("_buffer", "_prev_status", "_chars_since_emit", "_organic_seen")

    def __init__(self) -> None:
        self._buffer: str = ""
        self._prev_status: str = ""
        self._chars_since_emit: int = 0
        self._organic_seen: bool = False

    def mark_organic(self) -> None:
        """Signal that a real ⟨STATUS:⟩ marker was found — disable synthesis."""
        self._organic_seen = True

    @property
    def reason(self) -> str:
        """Latest synthesized reason text, or '' if nothing has been emitted yet."""
        return self._prev_status

    def feed(self, text: str) -> str | None:
        """Feed reasoning text; return a synthesized status or None."""
        if self._organic_seen:
            return None
        self._buffer += text
        self._chars_since_emit += len(text)
        if self._chars_since_emit < _SYNTH_CHAR_THRESHOLD:
            return None
        status = self._synthesize()
        self._chars_since_emit = 0
        self._buffer = self._buffer[-200:]
        if not status or status == self._prev_status:
            return None
        self._prev_status = status
        return status

    def _synthesize(self) -> str:
        text = self._buffer[-300:].strip()
        if not text:
            return ""
        segments = _SENTENCE_SPLIT_RE.split(text)
        candidate = ""
        for seg in reversed(segments):
            seg = seg.strip()
            if len(seg) >= 8:
                candidate = seg
                break
        if not candidate:
            candidate = text
        candidate = _FILLER_RE.sub("", candidate).strip()
        if not candidate:
            candidate = text.strip()
        words = candidate.split()[:_SYNTH_MAX_WORDS]
        result = " ".join(words)
        if result and not result[-1].isalnum():
            result = result.rstrip(".,;:!?-–—…")
        return result[:60].strip() if result else ""


def strip_content_markers(text: str) -> str:
    """Remove STATUS markers that leaked into assistant-visible content."""

    return _VISIBLE_STATUS_RE.sub("", text)


def sanitize_visible_text(text: str) -> str:
    """Canonical sanitizer for assistant-visible text."""

    cleaned = drop_special_tokens(str(text or ""))
    cleaned = strip_known_reasoning_blocks(cleaned)
    cleaned = strip_visible_thought_sentinels(cleaned)
    return strip_content_markers(cleaned)
