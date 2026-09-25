"""V2 reasoning-row sidecar tests.

Covers the additive contract changes shipped behind the ``reasoning_row_v2``
feature flag:
  - ``ReasoningStatusSynthesizer.reason`` is exposed as a public read-only
    property.
  - ``thinking_notification`` accepts an optional ``tokens_per_second`` kwarg
    and surfaces it on the payload only when provided.
"""

from __future__ import annotations

from sidecar.runtime.chat_helpers import thinking_notification
from sidecar.runtime.reasoning_status import ReasoningStatusExtractor, ReasoningStatusSynthesizer


def test_v2_extractor_enforces_two_to_six_word_bound() -> None:
    extractor = ReasoningStatusExtractor(v2_enabled=True)

    _, one_word = extractor.feed("\u27e8STATUS: Inspecting\u27e9")
    _, two_words = extractor.feed("\u27e8STATUS: Inspecting constraints\u27e9")
    _, six_words = extractor.feed("\u27e8STATUS: Inspecting all current runtime contract constraints\u27e9")
    seven_marker = "\u27e8STATUS: Inspecting all current runtime contract constraints carefully\u27e9"
    seven_cleaned, seven_words = extractor.feed(seven_marker)

    assert one_word is None
    assert two_words == "Inspecting constraints"
    assert six_words == "Inspecting all current runtime contract constraints"
    assert seven_cleaned == seven_marker
    assert seven_words is None


def test_legacy_extractor_retains_one_to_eight_word_bound() -> None:
    extractor = ReasoningStatusExtractor(v2_enabled=False)

    _, one_word = extractor.feed("\u27e8STATUS: Inspecting\u27e9")
    _, eight_words = extractor.feed(
        "\u27e8STATUS: Inspecting all current runtime contract constraints very carefully\u27e9"
    )

    assert one_word == "Inspecting"
    assert eight_words == "Inspecting all current runtime contract constraints very carefully"


def test_v2_organic_marker_resets_silence_window_and_fallback_resumes() -> None:
    synth = ReasoningStatusSynthesizer(v2_enabled=True)
    assert synth.feed("Earlier reasoning that must not survive the organic reset. " * 3) is not None

    synth.mark_organic()

    assert synth.feed("Quiet after marker. ") is None
    resumed = synth.feed(
        "Working through the next independent phase after the organic marker without another marker. "
        * 2
    )
    assert resumed is not None
    assert "Earlier reasoning" not in resumed


def test_v2_resumed_fallback_keeps_existing_dedupe() -> None:
    repeated = (
        "Carefully examining the same bounded implementation details for the current phase. " * 2
    )
    synth = ReasoningStatusSynthesizer(v2_enabled=True)
    first = synth.feed(repeated)
    synth.mark_organic()
    second = synth.feed(repeated)

    assert first is not None
    assert second is None


def test_v2_suppresses_long_one_word_identifier_and_url_statuses() -> None:
    candidates = (
        "reasoning_identifier_" + ("x" * 130),
        "https://example.test/" + ("pathsegment" * 14),
    )

    for reasoning in candidates:
        assert len(reasoning) >= 120
        assert ReasoningStatusSynthesizer(v2_enabled=True).feed(reasoning) is None


def test_v2_suppresses_two_word_status_truncated_to_one_word() -> None:
    reasoning = f"{'a' * 59} {'b' * 70}"

    assert len(reasoning.split()) == 2
    assert ReasoningStatusSynthesizer(v2_enabled=True).feed(reasoning) is None


def test_legacy_synthesis_retains_final_truncation_behavior() -> None:
    candidates = (
        "reasoning_identifier_" + ("x" * 130),
        f"{'a' * 59} {'b' * 70}",
    )

    for reasoning in candidates:
        result = ReasoningStatusSynthesizer(v2_enabled=False).feed(reasoning)
        assert result == reasoning[:60].strip()


def test_synthesizer_reason_is_empty_until_first_emit() -> None:
    synth = ReasoningStatusSynthesizer()

    assert synth.reason == ""


def test_synthesizer_reason_tracks_latest_emit() -> None:
    synth = ReasoningStatusSynthesizer()

    first = synth.feed(
        "I need to carefully analyze the user's request about database indexing "
        "strategies for their PostgreSQL deployment and query planning trade-offs."
    )

    assert first is not None
    assert synth.reason == first


def test_synthesizer_reason_unchanged_when_emit_is_deduped() -> None:
    synth = ReasoningStatusSynthesizer()

    first = synth.feed(
        "I need to carefully analyze the user's request about database indexing "
        "strategies for their PostgreSQL deployment with partitioned tables."
    )
    cached_reason = synth.reason
    deduped = synth.feed(
        "I need to carefully analyze the user's request about database indexing "
        "strategies for their PostgreSQL deployment with partitioned tables."
    )

    assert first is not None
    assert deduped is None
    # `_prev_status` (and therefore `reason`) is updated only when a new status
    # is emitted, so the dedupe path leaves the public property untouched.
    assert synth.reason == cached_reason


def test_thinking_notification_omits_tokens_per_second_by_default() -> None:
    payload = thinking_notification(
        request_id="req_1",
        trace_id=None,
        session_id=None,
        delta="thinking",
        thinking_id="tid_1",
    )

    assert "tokens_per_second" not in payload["params"]


def test_thinking_notification_includes_tokens_per_second_when_provided() -> None:
    payload = thinking_notification(
        request_id="req_1",
        trace_id=None,
        session_id=None,
        delta="thinking",
        thinking_id="tid_1",
        tokens_per_second=12.4,
    )

    assert payload["params"]["tokens_per_second"] == 12.4


def test_thinking_notification_coerces_tokens_per_second_to_float() -> None:
    payload = thinking_notification(
        request_id="req_1",
        trace_id=None,
        session_id=None,
        delta="thinking",
        thinking_id="tid_1",
        tokens_per_second=18,
    )

    value = payload["params"]["tokens_per_second"]
    assert isinstance(value, float)
    assert value == 18.0
