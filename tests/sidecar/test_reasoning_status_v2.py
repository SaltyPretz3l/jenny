"""V2 reasoning-row sidecar tests.

Covers the additive contract changes shipped behind the ``reasoning_row_v2``
feature flag:
  - ``thinking_notification`` accepts an optional ``tokens_per_second`` kwarg
    and surfaces it on the payload only when provided.
"""

from __future__ import annotations

from sidecar.runtime.chat_helpers import thinking_notification


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
