"""Repetition guard for extended-thinking streams."""

from __future__ import annotations

import re
from collections import deque
from typing import Callable

from sidecar.ai.config import read_environment_value

from sidecar.ai.config import read_environment_value

_WORD_RE = re.compile(r"\b\w+\b")

THINKING_BUDGET_CHARS_PER_TOKEN = 4
THINKING_BUDGET_CHARS_FLOOR = 65_536
THINKING_BUDGET_ENGINE_CHARS_FLOOR = 16_384


def resolve_thinking_budget_chars(engine: object | None, max_tokens: int) -> int:
    """Resolve the shared character budget for a thinking guard."""
    budget_tokens = getattr(engine, "_thinking_budget_tokens", None)
    if callable(budget_tokens):
        tokens = int(budget_tokens(max_tokens) or 0)
        if tokens > 0:
            return max(
                tokens * THINKING_BUDGET_CHARS_PER_TOKEN,
                THINKING_BUDGET_ENGINE_CHARS_FLOOR,
            )

    token_headroom = getattr(engine, "_thinking_token_headroom", None)
    if callable(token_headroom):
        tokens = int(token_headroom() or 0)
        if tokens > 0:
            return max(
                tokens * THINKING_BUDGET_CHARS_PER_TOKEN,
                THINKING_BUDGET_ENGINE_CHARS_FLOOR,
            )

    return max(
        max(int(max_tokens or 0), 1) * THINKING_BUDGET_CHARS_PER_TOKEN,
        THINKING_BUDGET_CHARS_FLOOR,
    )


def thinking_budget_abort_enabled() -> bool:
    """Return whether the default-on thinking-budget abort kill switch is enabled."""
    return read_environment_value("JENNY_ENABLE_THINKING_BUDGET_ABORT", "1") != "0"


def thinking_budget_continuation_enabled() -> bool:
    """Return whether the default-on thinking-budget continuation switch is enabled."""
    return read_environment_value("JENNY_ENABLE_THINKING_BUDGET_CONTINUATION", "1") != "0"


def _never_tripped() -> bool:
    return False


def budget_trip_check(guard: "ThinkingRepetitionGuard | None") -> Callable[[], bool]:
    """Check whether the guard tripped on its char budget; always False without one."""
    return guard.tripped_on_budget if guard is not None else _never_tripped


class ThinkingRepetitionGuard:
    """Suppress repetitive thinking deltas once a spiral pattern is detected."""

    def __init__(
        self,
        *,
        max_chars: int,
        window_chars: int = 512,
        similarity_threshold: float = 0.7,
        max_repetitive_windows: int = 3,
    ) -> None:
        self.max_chars = max(1, int(max_chars))
        self.window_chars = max(1, int(window_chars))
        self.similarity_threshold = float(similarity_threshold)
        self.max_repetitive_windows = max(1, int(max_repetitive_windows))
        self.should_stop = False
        self.stop_reason: str | None = None
        self._recent_chunks: deque[str] = deque()
        self._buffered_chars = 0
        self._total_chars = 0
        self._consecutive_repetitive_windows = 0

    def feed(self, text: str) -> bool:
        """Return True when the incoming delta should be suppressed."""
        if self.should_stop:
            return True

        delta = str(text or "")
        if not delta:
            return False

        self._total_chars += len(delta)
        if self._total_chars > self.max_chars:
            self._trip("char_limit")
            return True

        self._recent_chunks.append(delta)
        self._buffered_chars += len(delta)
        self._prune_buffer()

        previous_window, current_window = self._build_windows()
        if previous_window and current_window:
            similarity = self._jaccard_similarity(previous_window, current_window)
            if similarity >= self.similarity_threshold:
                self._consecutive_repetitive_windows += 1
            else:
                self._consecutive_repetitive_windows = 0

            if self._consecutive_repetitive_windows >= self.max_repetitive_windows:
                self._trip("repetition")
                return True

        return False

    def tripped_on_budget(self) -> bool:
        return self.should_stop and self.stop_reason == "char_limit"

    @staticmethod
    def _jaccard_similarity(left: str, right: str) -> float:
        left_tokens = ThinkingRepetitionGuard._tokenize(
            ThinkingRepetitionGuard._normalize_window(left)
        )
        right_tokens = ThinkingRepetitionGuard._tokenize(
            ThinkingRepetitionGuard._normalize_window(right)
        )
        if not left_tokens or not right_tokens:
            return 0.0
        intersection = len(left_tokens & right_tokens)
        union = len(left_tokens | right_tokens)
        if union == 0:
            return 0.0
        return intersection / union

    @staticmethod
    def _tokenize(text: str) -> set[str]:
        return {match.group(0).lower() for match in _WORD_RE.finditer(str(text or ""))}

    @staticmethod
    def _normalize_window(text: str) -> str:
        normalized = str(text or "")
        if not normalized:
            return ""
        if normalized and (normalized[0].isalnum() or normalized[0] == "_"):
            normalized = re.sub(r"^\w+", "", normalized)
        if normalized and (normalized[-1].isalnum() or normalized[-1] == "_"):
            normalized = re.sub(r"\w+$", "", normalized)
        return normalized

    def _trip(self, reason: str) -> None:
        self.should_stop = True
        self.stop_reason = reason

    def _prune_buffer(self) -> None:
        max_buffer_chars = max(self.window_chars * 2, self.window_chars)
        while (
            len(self._recent_chunks) > 1
            and self._buffered_chars - len(self._recent_chunks[0]) >= max_buffer_chars
        ):
            removed = self._recent_chunks.popleft()
            self._buffered_chars -= len(removed)

    def _build_windows(self) -> tuple[str, str]:
        window_size = min(self.window_chars, self._buffered_chars // 2)
        if window_size <= 0:
            return "", ""
        previous_parts: list[str] = []
        current_parts: list[str] = []
        remaining_current = window_size
        remaining_previous = window_size

        for chunk in reversed(self._recent_chunks):
            if remaining_current > 0:
                take = min(len(chunk), remaining_current)
                current_parts.append(chunk[-take:])
                remaining_current -= take
                if take < len(chunk):
                    remainder = chunk[:-take]
                    if remaining_previous > 0 and remainder:
                        previous_take = min(len(remainder), remaining_previous)
                        previous_parts.append(remainder[-previous_take:])
                        remaining_previous -= previous_take
                    continue
                continue
            if remaining_previous > 0:
                take = min(len(chunk), remaining_previous)
                previous_parts.append(chunk[-take:])
                remaining_previous -= take
            if remaining_previous <= 0:
                break

        previous_window = "".join(reversed(previous_parts))
        current_window = "".join(reversed(current_parts))
        return previous_window, current_window
