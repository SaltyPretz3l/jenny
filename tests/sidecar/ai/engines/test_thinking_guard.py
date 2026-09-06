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
