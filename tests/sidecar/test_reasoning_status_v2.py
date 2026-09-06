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
from sidecar.runtime.reasoning_status import ReasoningStatusSynthesizer


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
