"""Shared helpers for reasoning markers and delimiter-based extraction."""

from __future__ import annotations

from dataclasses import dataclass

THINK_START_TOKEN = "<think>"
THINK_END_TOKEN = "</think>"
REASONING_START_TOKEN = "<reasoning>"
REASONING_END_TOKEN = "</reasoning>"
THINKING_START_TOKEN = "<thinking>"
THINKING_END_TOKEN = "</thinking>"
PIPE_THINKING_START_TOKEN = "<|thinking|>"
PIPE_THINKING_END_TOKEN = "<|/thinking|>"
BRACKET_THOUGHT_START_TOKEN = "[thought]"
BRACKET_THOUGHT_END_TOKEN = "[/thought]"
GEMMA_REASONING_START_TOKEN = "<|channel>thought"
GEMMA_REASONING_END_TOKEN = "<channel|>"
KNOWN_REASONING_MARKER_PAIRS = (
    (THINK_START_TOKEN, THINK_END_TOKEN),
    (REASONING_START_TOKEN, REASONING_END_TOKEN),
    (THINKING_START_TOKEN, THINKING_END_TOKEN),
    (PIPE_THINKING_START_TOKEN, PIPE_THINKING_END_TOKEN),
    (BRACKET_THOUGHT_START_TOKEN, BRACKET_THOUGHT_END_TOKEN),
    (GEMMA_REASONING_START_TOKEN, GEMMA_REASONING_END_TOKEN),
)


def _trailing_partial_marker_length(text: str, marker: str) -> int:
    max_length = min(len(text), max(len(marker) - 1, 0))
    for length in range(max_length, 0, -1):
        if marker.startswith(text[-length:]):
            return length
    return 0


@dataclass(frozen=True)
class ReasoningExtraction:
    reasoning_text: str = ""
    visible_text: str = ""
    used_markers: bool = False


class DelimitedReasoningParser:
    """Incrementally split visible text from hidden reasoning spans."""

    __slots__ = ("_buffer", "_in_reasoning", "_used_markers", "end_token", "start_token")

    def __init__(self, *, start_token: str, end_token: str) -> None:
        self.start_token = str(start_token or "")
        self.end_token = str(end_token or "")
        self._buffer = ""
        self._in_reasoning = False
        self._used_markers = False

    @property
    def used_markers(self) -> bool:
        return self._used_markers

    def feed(self, chunk: str) -> tuple[str, str]:
        if not chunk:
            return ("", "")
        if not self.start_token or not self.end_token:
            return ("", chunk)

        self._buffer += chunk
        reasoning_parts: list[str] = []
        visible_parts: list[str] = []

        while self._buffer:
            marker = self.end_token if self._in_reasoning else self.start_token
            marker_index = self._buffer.find(marker)
            if marker_index != -1:
                prefix = self._buffer[:marker_index]
                if prefix:
                    if self._in_reasoning:
                        reasoning_parts.append(prefix)
                    else:
                        visible_parts.append(prefix)
                self._buffer = self._buffer[marker_index + len(marker) :]
                self._in_reasoning = not self._in_reasoning
                self._used_markers = True
                continue

            tail_length = _trailing_partial_marker_length(self._buffer, marker)
            emit = self._buffer[:-tail_length] if tail_length else self._buffer
            self._buffer = self._buffer[-tail_length:] if tail_length else ""
            if emit:
                if self._in_reasoning:
                    reasoning_parts.append(emit)
                else:
                    visible_parts.append(emit)
            break

        return ("".join(reasoning_parts), "".join(visible_parts))

    def flush(self) -> tuple[str, str]:
        buffered = self._buffer
        self._buffer = ""
        if not buffered:
            return ("", "")
        if self._in_reasoning:
            return (buffered, "")
        return ("", buffered)


def extract_delimited_reasoning(
    text: str,
    *,
    start_token: str,
    end_token: str,
) -> ReasoningExtraction:
    parser = DelimitedReasoningParser(
        start_token=start_token,
        end_token=end_token,
    )
    reasoning_text, visible_text = parser.feed(str(text or ""))
    tail_reasoning, tail_visible = parser.flush()
    return ReasoningExtraction(
        reasoning_text=f"{reasoning_text}{tail_reasoning}",
        visible_text=f"{visible_text}{tail_visible}",
        used_markers=parser.used_markers,
    )


def strip_known_reasoning_blocks(text: str) -> str:
    visible_text = str(text or "")
    for start_token, end_token in KNOWN_REASONING_MARKER_PAIRS:
        visible_text = extract_delimited_reasoning(
            visible_text,
            start_token=start_token,
            end_token=end_token,
        ).visible_text
    return visible_text


def strip_known_reasoning_markers(text: str) -> str:
    cleaned = str(text or "")
    for start_token, end_token in KNOWN_REASONING_MARKER_PAIRS:
        cleaned = cleaned.replace(start_token, "").replace(end_token, "")
    return cleaned
