from __future__ import annotations

from sidecar.ai.thinking_guard import ThinkingRepetitionGuard


def test_identical_text_trips_guard_after_third_repetitive_window() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    repeated = "Checking the request intent carefully. "

    assert guard.feed(repeated) is False
    assert guard.feed(repeated) is False
    assert guard.feed(repeated) is False
    assert guard.feed(repeated) is True
    assert guard.should_stop is True


def test_varied_text_does_not_false_positive() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)

    assert guard.feed("Checking the request intent carefully. ") is False
    assert guard.feed("Reviewing the current question and relevant context. ") is False
    assert guard.feed("Picking the clearest answer path for this reply. ") is False
    assert guard.feed("Finalizing a direct response for the user now. ") is False
    assert guard.should_stop is False


def test_near_identical_paraphrases_trigger_detection() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)

    assert guard.feed("Checking request intent and drafting a concise answer now. " * 3) is False
    assert (
        guard.feed("Checking request intent and drafting a concise answer carefully. " * 3) is False
    )
    assert guard.feed("Checking request intent and drafting a concise answer clearly. " * 3) is True
    assert (
        guard.feed("Checking request intent and drafting a concise answer directly. " * 3) is True
    )
    assert guard.should_stop is True


def test_hard_character_limit_trips_guard() -> None:
    guard = ThinkingRepetitionGuard(max_chars=10)

    assert guard.feed("12345678901") is True
    assert guard.should_stop is True


def test_guard_remains_latched_after_trigger() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    repeated = "Checking the request intent carefully. "

    guard.feed(repeated)
    guard.feed(repeated)
    guard.feed(repeated)

    assert guard.feed(repeated) is True
    assert guard.feed("Fresh content that would otherwise differ.") is True


def test_progressive_refinement_does_not_false_positive() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)

    assert guard.feed("Checking the request intent carefully. ") is False
    assert guard.feed("Checking the request intent carefully before drafting. ") is False
    assert guard.feed("Checking the request intent carefully before drafting a response. ") is False
    assert (
        guard.feed("Checking the request intent carefully before drafting a short response. ")
        is False
    )
    assert guard.should_stop is False


def test_large_repeated_chunks_trip_guard_despite_window_word_splits() -> None:
    guard = ThinkingRepetitionGuard(max_chars=65536)
    repeated = "Checking the request intent carefully. " * 50

    assert guard.feed(repeated) is False
    assert guard.feed(repeated) is False
    assert guard.feed(repeated) is True
    assert guard.stop_reason == "repetition"

# ---------------------------------------------------------------------------
# Loophole (owner turn 2026-09-20): once a repetition trip latched the guard,
# feed() returned before counting, so a later char-budget overrun could never
# become a ``char_limit`` trip and the engine kept generating hidden reasoning
# to the provider's hard cap.
# ---------------------------------------------------------------------------


def _trip_on_repetition(guard: ThinkingRepetitionGuard) -> int:
    repeated = "Checking the request intent carefully. "
    fed = 0
    for _ in range(4):
        guard.feed(repeated)
        fed += len(repeated)
    assert guard.stop_reason == "repetition"
    return fed


def test_repetition_trip_keeps_counting_and_escalates_to_char_limit() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    fed = _trip_on_repetition(guard)

    # Still suppressed, still short of the budget: repetition stays the reason.
    assert guard.feed("x" * 100) is True
    assert guard.stop_reason == "repetition"
    assert guard.tripped_on_budget() is False
    assert guard.total_chars == fed + 100

    # Crossing the budget while suppressed becomes a budget trip.
    assert guard.feed("y" * 4096) is True
    assert guard.stop_reason == "char_limit"
    assert guard.tripped_on_budget() is True
    assert guard.total_chars == fed + 100 + 4096


def test_char_limit_trip_is_never_downgraded_by_later_repetition() -> None:
    guard = ThinkingRepetitionGuard(max_chars=10)
    assert guard.feed("12345678901") is True
    assert guard.stop_reason == "char_limit"

    repeated = "Checking the request intent carefully. "
    for _ in range(4):
        assert guard.feed(repeated) is True
    assert guard.stop_reason == "char_limit"
    assert guard.tripped_on_budget() is True


def test_total_chars_counts_every_fed_delta_before_and_after_a_trip() -> None:
    guard = ThinkingRepetitionGuard(max_chars=4096)
    assert guard.total_chars == 0
    guard.feed("abc")
    guard.feed("")
    assert guard.total_chars == 3
    _trip_on_repetition(guard)
    guard.feed("after")
    assert guard.total_chars == 3 + 4 * len("Checking the request intent carefully. ") + 5
