"""Repetition guard for extended-thinking streams."""

from __future__ import annotations

import re
import time
from collections import deque
from typing import Any, Callable

from sidecar.ai.config import read_environment_value

_WORD_RE = re.compile(r"\b\w+\b")

# Measured on local GGUF reasoning streams (Bonsai 2 27B: 51,969 reasoning
# chars for 16,384 tokens). The old value of 4 overstated the budget by a
# quarter, which is how a chars x 4 guard sized at max_tokens x 4 could never
# be reached before the provider's own token cap.
THINKING_BUDGET_CHARS_PER_TOKEN = 3.2
THINKING_BUDGET_CHARS_FLOOR = 65_536
THINKING_BUDGET_ENGINE_CHARS_FLOOR = 16_384
# Share of a request's num_predict a model may spend thinking when thinking and
# the answer draw on one pool. The remainder is what is left to answer with, so
# the checkpoint fires while the model can still act on it.
THINKING_BUDGET_NUM_PREDICT_FRACTION = 0.65

# ``StreamingEvent.kind`` a tool-loop engine yields when its guard hides the
# rest of the reasoning without ending the generation (abort kill switch off).
# The router turns it into a non-persisted status ``ThinkingEvent`` so the live
# reasoning row says why it went quiet (HB-004). Plain ``stream()`` paths never
# yield it: a plain-text consumer would render an unknown kind as visible text.
THINKING_STATUS_EVENT_KIND = "thinking_status"
REPETITION_HIDDEN_STATUS_TEXT = "Reasoning hidden - repetition detected"
BUDGET_HIDDEN_STATUS_TEXT = "Reasoning hidden - thinking budget reached"


def _budget_chars(tokens: int) -> int:
    return max(int(tokens * THINKING_BUDGET_CHARS_PER_TOKEN), 1)


def resolve_thinking_budget_tokens(engine: object | None, max_tokens: int) -> int | None:
    """Thinking tokens this request may spend before the guard trips.

    Engines that reserve thinking headroom *on top of* the answer budget report
    it directly. Engines that do not (llama-server and every other plain
    OpenAI-compatible server: thinking and answer share one ``num_predict``)
    get a fraction of that shared pool, so the guard is reachable instead of
    sitting above the hard cap. ``None`` means no token budget is resolvable.
    """
    budget_tokens = getattr(engine, "_thinking_budget_tokens", None)
    if callable(budget_tokens):
        tokens = int(budget_tokens(max_tokens) or 0)
        if tokens > 0:
            return tokens

    token_headroom = getattr(engine, "_thinking_token_headroom", None)
    if callable(token_headroom):
        tokens = int(token_headroom() or 0)
        if tokens > 0:
            return tokens

    num_predict = max(int(max_tokens or 0), 0)
    if num_predict > 0:
        return max(int(num_predict * THINKING_BUDGET_NUM_PREDICT_FRACTION), 1)
    return None


def resolve_thinking_budget_chars(engine: object | None, max_tokens: int) -> int:
    """Resolve the shared character budget for a thinking guard.

    The budget is decided in tokens (:py:func:`resolve_thinking_budget_tokens`)
    and converted for the char-counting guard; the char floor applies only to
    engine-reported headroom, never to the shared-pool fraction, which would
    otherwise be raised back above the cap it exists to stay under.
    """
    engine_tokens = getattr(engine, "_thinking_budget_tokens", None)
    headroom = getattr(engine, "_thinking_token_headroom", None)
    engine_reported = callable(engine_tokens) or callable(headroom)
    tokens = resolve_thinking_budget_tokens(engine, max_tokens)
    if tokens is None:
        return THINKING_BUDGET_CHARS_FLOOR
    chars = _budget_chars(tokens)
    if engine_reported:
        return max(chars, THINKING_BUDGET_ENGINE_CHARS_FLOOR)
    return chars


def thinking_budget_abort_enabled() -> bool:
    """Return whether the default-on thinking-budget abort kill switch is enabled."""
    return read_environment_value("JENNY_ENABLE_THINKING_BUDGET_ABORT", "1") != "0"


def thinking_budget_continuation_enabled() -> bool:
    """Return whether the default-on thinking-budget continuation switch is enabled."""
    return read_environment_value("JENNY_ENABLE_THINKING_BUDGET_CONTINUATION", "1") != "0"


def _never_tripped() -> bool:
    return False


def budget_trip_check(guard: "ThinkingRepetitionGuard | None") -> Callable[[], bool]:
    """Check whether the guard's verdict should end the generation.

    Either trip counts: a repetition trip hides every later delta, so leaving
    the engine running only produced minutes of silent reasoning before the
    char budget finally aborted it (HB-004). Callers still gate the abort on
    :py:func:`thinking_budget_abort_enabled`; always False without a guard.
    """
    return guard.tripped_for_abort if guard is not None else _never_tripped


def guard_log_data(guard: "ThinkingRepetitionGuard | None", *, model: str) -> dict[str, Any]:
    """The ``data`` payload for guard trip/abort/suppression log events.

    Fields must ride ``data``: the JSON log sink drops other ``extra`` keys,
    which is why the HB-004 abort line carried ``data: {}``.
    """
    data: dict[str, Any] = {"model": model}
    if guard is not None:
        data.update(guard.verdict_data())
    return data


def take_hidden_reasoning_notice(guard: "ThinkingRepetitionGuard | None") -> str | None:
    """Status text to show once when a repetition trip hides ongoing reasoning.

    Only when the abort kill switch is off: with the abort on, the engine ends
    the generation instead and the checkpoint continuation takes over.
    """
    if guard is None or thinking_budget_abort_enabled():
        return None
    if not guard.claim_hidden_notice():
        return None
    if guard.first_trip_reason == "repetition":
        return REPETITION_HIDDEN_STATUS_TEXT
    return BUDGET_HIDDEN_STATUS_TEXT


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
        self._started_at = time.monotonic()
        self._dropped_deltas = 0
        self._dropped_chars = 0
        self._first_trip_reason: str | None = None
        self._trip_offset_chars: int | None = None
        self._trip_elapsed_ms: int | None = None
        self._hidden_notice_claimed = False

    def feed(self, text: str) -> bool:
        """Return True when the incoming delta should be suppressed.

        Counting never stops. A repetition trip suppresses output, but the
        char budget stays reachable afterwards: a latched guard that stopped
        counting could never report ``char_limit``, so the engine kept
        generating hidden reasoning to the provider's hard cap (owner turn
        2026-09-20). A ``char_limit`` verdict is never downgraded. Engines
        now end the generation on either trip when the abort is enabled
        (``budget_trip_check``); counting through suppression still bounds the
        kill-switch-off path.
        """
        delta = str(text or "")
        if not delta:
            return self.should_stop

        self._total_chars += len(delta)
        if self._total_chars > self.max_chars:
            if self.stop_reason != "char_limit":
                self._trip("char_limit")
            return self._drop(delta)
        if self.should_stop:
            return self._drop(delta)

        self._recent_chunks.append(delta)
        self._buffered_chars += len(delta)
        self._prune_buffer()

        # No verdict until two full windows exist. Halving a short buffer
        # compared a few words against a few words, so a think that opened
        # with a self-correction ("X is missing - wait no, X is ...") tripped
        # at 81 chars on token-sized deltas (HB-011).
        if self._buffered_chars < self.window_chars * 2:
            return False

        previous_window, current_window = self._build_windows()
        if previous_window and current_window:
            similarity = self._jaccard_similarity(previous_window, current_window)
            if similarity >= self.similarity_threshold:
                self._consecutive_repetitive_windows += 1
            else:
                self._consecutive_repetitive_windows = 0

            if self._consecutive_repetitive_windows >= self.max_repetitive_windows:
                self._trip("repetition")
                return self._drop(delta)

        return False

    def tripped_on_budget(self) -> bool:
        return self.should_stop and self.stop_reason == "char_limit"

    def tripped_for_abort(self) -> bool:
        """True once either trip hides further reasoning (see ``budget_trip_check``)."""
        return self.should_stop

    def claim_hidden_notice(self) -> bool:
        """True exactly once, after either trip, for the hidden-reasoning status."""
        if self._hidden_notice_claimed or self._first_trip_reason is None:
            return False
        self._hidden_notice_claimed = True
        return True

    @property
    def first_trip_reason(self) -> str | None:
        return self._first_trip_reason

    @property
    def dropped_deltas(self) -> int:
        """Deltas suppressed since the first trip, the tripping delta included."""
        return self._dropped_deltas

    def verdict_data(self) -> dict[str, Any]:
        """Structured guard state for the trip/abort/suppression log events."""
        return {
            "stop_reason": self.stop_reason,
            "first_trip_reason": self._first_trip_reason,
            "trip_offset_chars": self._trip_offset_chars,
            "trip_elapsed_ms": self._trip_elapsed_ms,
            "counted_chars": self._total_chars,
            "max_chars": self.max_chars,
            "dropped_deltas": self._dropped_deltas,
            "dropped_chars": self._dropped_chars,
        }

    @property
    def total_chars(self) -> int:
        """Reasoning chars fed so far, counted through any suppression."""
        return self._total_chars

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
        if self._first_trip_reason is None:
            self._first_trip_reason = reason
            self._trip_offset_chars = self._total_chars
            self._trip_elapsed_ms = int((time.monotonic() - self._started_at) * 1000)
        self.should_stop = True
        self.stop_reason = reason

    def _drop(self, delta: str) -> bool:
        self._dropped_deltas += 1
        self._dropped_chars += len(delta)
        return True

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
