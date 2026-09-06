from __future__ import annotations

from sidecar.runtime.reasoning_status import ReasoningStatusExtractor, ReasoningStatusSynthesizer


def test_reasoning_status_extractor_passthrough_without_markers() -> None:
    extractor = ReasoningStatusExtractor()

    cleaned, status = extractor.feed("Checking the request intent.")

    assert cleaned == "Checking the request intent."
    assert status is None


def test_reasoning_status_extractor_extracts_single_marker() -> None:
    extractor = ReasoningStatusExtractor()

    cleaned, status = extractor.feed(
        "⟨STATUS: Analyzing constraints⟩\nChecking the request intent."
    )

    assert cleaned == "\nChecking the request intent."
    assert status == "Analyzing constraints"


def test_reasoning_status_extractor_buffers_split_markers() -> None:
    extractor = ReasoningStatusExtractor()

    first_cleaned, first_status = extractor.feed("⟨STATUS: Analyzing")
    second_cleaned, second_status = extractor.feed(" constraints⟩\nChecking the request intent.")

    assert first_cleaned == ""
    assert first_status is None
    assert second_cleaned == "\nChecking the request intent."
    assert second_status == "Analyzing constraints"


def test_reasoning_status_extractor_uses_last_marker_in_chunk() -> None:
    extractor = ReasoningStatusExtractor()

    cleaned, status = extractor.feed(
        "⟨STATUS: Reviewing request⟩\nFirst.\n⟨STATUS: Drafting final response⟩\nSecond."
    )

    assert cleaned == "\nFirst.\n\nSecond."
    assert status == "Drafting final response"


def test_reasoning_status_extractor_leaves_overlong_markers_in_text() -> None:
    extractor = ReasoningStatusExtractor()

    cleaned, status = extractor.feed(
        "⟨STATUS: one two three four five six seven eight nine⟩\nKeep this text."
    )

    assert cleaned == "⟨STATUS: one two three four five six seven eight nine⟩\nKeep this text."
    assert status is None


def test_reasoning_status_extractor_dedupes_consecutive_statuses() -> None:
    extractor = ReasoningStatusExtractor()

    first_cleaned, first_status = extractor.feed("⟨STATUS: Analyzing constraints⟩\nFirst.")
    second_cleaned, second_status = extractor.feed("⟨STATUS: Analyzing constraints⟩\nSecond.")

    assert first_cleaned == "\nFirst."
    assert first_status == "Analyzing constraints"
    assert second_cleaned == "\nSecond."
    assert second_status is None


def test_reasoning_status_extractor_treats_oversized_tail_as_literal_text() -> None:
    extractor = ReasoningStatusExtractor()
    oversized = "⟨" + ("a" * 300)

    cleaned, status = extractor.feed(oversized)

    assert cleaned == oversized
    assert status is None
    assert extractor.flush() == ""


def test_reasoning_status_extractor_flushes_buffered_tail_as_literal_text() -> None:
    extractor = ReasoningStatusExtractor()

    cleaned, status = extractor.feed("⟨STATUS: partial")

    assert cleaned == ""
    assert status is None
    assert extractor.flush() == "⟨STATUS: partial"


# ── ReasoningStatusSynthesizer tests ──


def test_synthesizer_emits_after_char_threshold() -> None:
    synth = ReasoningStatusSynthesizer()

    # Short text should not trigger
    result = synth.feed("Short.")
    assert result is None

    # Enough text should trigger a synthesized status
    result = synth.feed(
        "I need to carefully analyze the user's request about database indexing "
        "strategies for their PostgreSQL deployment."
    )
    assert result is not None
    assert len(result.split()) <= 6


def test_synthesizer_strips_filler_words() -> None:
    synth = ReasoningStatusSynthesizer()

    result = synth.feed(
        "Okay, let me think about how to approach this problem with the authentication middleware. "
        "The user wants to replace the old session-based flow."
    )
    assert result is not None
    assert not result.lower().startswith("okay")
    assert not result.lower().startswith("let me")


def test_synthesizer_deduplicates_status() -> None:
    synth = ReasoningStatusSynthesizer()

    first = synth.feed(
        "I need to carefully analyze the user's request about database indexing "
        "strategies for their PostgreSQL deployment with partitioned tables."
    )
    assert first is not None

    # Same text again should be deduped
    second = synth.feed(
        "I need to carefully analyze the user's request about database indexing "
        "strategies for their PostgreSQL deployment with partitioned tables."
    )
    assert second is None


def test_synthesizer_disabled_by_organic_marker() -> None:
    synth = ReasoningStatusSynthesizer()
    synth.mark_organic()

    result = synth.feed(
        "This is a very long reasoning text that should definitely exceed the "
        "character threshold for synthesizing a status update from the stream."
    )
    assert result is None


def test_synthesizer_produces_clean_output() -> None:
    synth = ReasoningStatusSynthesizer()

    result = synth.feed(
        "The authentication middleware needs to be refactored to support JWT tokens "
        "instead of the legacy session cookies that were flagged by compliance."
    )
    assert result is not None
    # Should not end with punctuation
    assert result[-1].isalnum()
    # Should be reasonably short
    assert len(result) <= 60
