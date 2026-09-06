"""Plan-usage header capture on the ChatGPT-subscription engine's HTTP hook.

Covers the engine -> runtime side channel: ``record_plan_usage_snapshot`` is
called from inside ``ChatGPTSubscriptionEngine.stream_with_tools`` right
after the response is opened and BEFORE the initial-status raise, so a 429
response's headers are captured even though the call ultimately raises
``ProviderHttpError``.
"""

from __future__ import annotations

import pytest

from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.runtime.local_engine.request_context import (
    clear_request_context,
    install_request_context,
)
from sidecar.runtime.plan_usage_snapshot import read_plan_usage_snapshot
from tests.sidecar.ai.engines.test_chatgpt_subscription import (
    _FakeSSEStream,
    _TOKEN,
    _completed,
    _drain_stream,
    _engine,
    _sse,
)

_FULL_HEADERS = {
    "x-codex-primary-used-percent": "62.0",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1756800000",
    "x-codex-secondary-used-percent": "18.0",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "1757100000",
}


def test_full_snapshot_captured_on_a_200_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeSSEStream(
        [
            _sse({"type": "response.output_text.delta", "delta": "hi"}),
            _completed(input_tokens=5, output_tokens=2),
        ],
        headers=_FULL_HEADERS,
    )
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-200")
    try:
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        snapshot = read_plan_usage_snapshot(engine)
        assert snapshot is not None
        assert snapshot["primary"]["used_percent"] == 62.0
        assert snapshot["primary"]["window_minutes"] == 300
        assert snapshot["secondary"]["used_percent"] == 18.0
    finally:
        clear_request_context(engine)


def test_primary_only_snapshot_captured(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _FakeSSEStream(
        [_completed()],
        headers={
            "x-codex-primary-used-percent": "40",
            "x-codex-primary-reset-at": "1756800000",
        },
    )
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-primary-only")
    try:
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        snapshot = read_plan_usage_snapshot(engine)
        assert snapshot is not None
        assert snapshot["primary"]["used_percent"] == 40.0
        assert "secondary" not in snapshot
    finally:
        clear_request_context(engine)


def test_429_headers_captured_before_the_status_raise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeSSEStream(
        [],
        status_code=429,
        headers={
            **_FULL_HEADERS,
            "x-codex-rate-limit-reached-type": "primary",
        },
        body={"error": {"code": "rate_limit_exceeded"}},
    )
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-429")
    try:
        with pytest.raises(ProviderHttpError):
            engine.generate(prompt="hello")

        snapshot = read_plan_usage_snapshot(engine)
        assert snapshot is not None
        assert snapshot["rate_limit_reached_type"] == "primary"
        assert snapshot["primary"]["used_percent"] == 62.0
    finally:
        clear_request_context(engine)


def test_malformed_percent_drops_only_that_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeSSEStream(
        [_completed()],
        headers={
            "x-codex-primary-used-percent": "not-a-number",
            "x-codex-primary-reset-at": "1756800000",
            "x-codex-secondary-used-percent": "18",
            "x-codex-secondary-reset-at": "1757100000",
        },
    )
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-malformed")
    try:
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        snapshot = read_plan_usage_snapshot(engine)
        assert snapshot is not None
        assert "primary" not in snapshot
        assert snapshot["secondary"]["used_percent"] == 18.0
    finally:
        clear_request_context(engine)


@pytest.mark.parametrize(
    "reset_at",
    ["0", "999999999", "9007199254740992"],
)
def test_out_of_range_reset_at_drops_the_window(
    monkeypatch: pytest.MonkeyPatch,
    reset_at: str,
) -> None:
    response = _FakeSSEStream(
        [_completed()],
        headers={
            "x-codex-primary-used-percent": "50",
            "x-codex-primary-reset-at": reset_at,
        },
    )
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-oor")
    try:
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        assert read_plan_usage_snapshot(engine) is None
    finally:
        clear_request_context(engine)


def test_unknown_reached_type_is_dropped_not_echoed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeSSEStream(
        [_completed()],
        headers={
            **_FULL_HEADERS,
            "x-codex-rate-limit-reached-type": "tertiary",
        },
    )
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-unknown-reached")
    try:
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        snapshot = read_plan_usage_snapshot(engine)
        assert snapshot is not None
        assert "rate_limit_reached_type" not in snapshot
    finally:
        clear_request_context(engine)


def test_oversized_header_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _FakeSSEStream(
        [_completed()],
        headers={
            "x-codex-primary-used-percent": "5" + ("9" * 100_000),
            "x-codex-primary-reset-at": "1756800000",
        },
    )
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-oversized")
    try:
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        snapshot = read_plan_usage_snapshot(engine)
        assert snapshot is not None
        assert snapshot["primary"]["used_percent"] == 100.0
    finally:
        clear_request_context(engine)


def test_no_headers_leaves_no_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _FakeSSEStream([_completed()], headers={})
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-none")
    try:
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        assert read_plan_usage_snapshot(engine) is None
    finally:
        clear_request_context(engine)


def test_iso8601_and_epoch_reset_at_both_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeSSEStream(
        [_completed()],
        headers={
            "x-codex-primary-used-percent": "20",
            "x-codex-primary-reset-at": "2026-07-31T00:00:00Z",
            "x-codex-secondary-used-percent": "30",
            "x-codex-secondary-reset-at": "1757100000",
        },
    )
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-iso")
    try:
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        snapshot = read_plan_usage_snapshot(engine)
        assert snapshot is not None
        assert snapshot["primary"]["reset_at"] == 1785456000
        assert snapshot["secondary"]["reset_at"] == 1757100000
    finally:
        clear_request_context(engine)


def test_snapshot_never_contains_a_raw_header_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeSSEStream([_completed()], headers=_FULL_HEADERS)
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-shape")
    try:
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        snapshot = read_plan_usage_snapshot(engine)
        assert snapshot is not None
        for window in ("primary", "secondary"):
            for value in snapshot[window].values():
                assert isinstance(value, (int, float))
    finally:
        clear_request_context(engine)


def test_capture_never_raises_on_a_headerless_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _FakeSSEStream([_completed()])
    response.headers = None  # type: ignore[assignment]
    engine, _client = _engine(monkeypatch, response)
    install_request_context(engine, request_id="req-plan-usage-headerless")
    try:
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        assert read_plan_usage_snapshot(engine) is None
    finally:
        clear_request_context(engine)


def test_no_binding_is_a_silent_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    """No ``install_request_context`` call -- mirrors the existing (unbound)
    fixture default, proving the header hook does not disturb the plain
    200/429 contract tests in ``test_chatgpt_subscription.py``."""
    response = _FakeSSEStream([_completed()], headers=_FULL_HEADERS)
    engine, _client = _engine(monkeypatch, response)

    chunks, result = _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

    assert result.finish_reason == "stop"
    assert read_plan_usage_snapshot(engine) is None
    assert _TOKEN not in str(chunks)
