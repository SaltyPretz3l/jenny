"""Unit tests for the ChatGPT plan-usage snapshot parser/stash/attach seam."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.feature_flags import (
    FEATURE_CHATGPT_PLAN_METER,
    is_chatgpt_plan_meter_enabled,
)
from sidecar.runtime.chat_helpers import chat_error_notification
from sidecar.runtime.chat_models import ChatRequestError
from sidecar.runtime.local_engine.request_context import (
    clear_request_context,
    current_request_context,
    install_request_context,
)
from sidecar.runtime.plan_usage_snapshot import (
    PLAN_USAGE_CONTEXT_KEY,
    PLAN_USAGE_SCHEMA_VERSION,
    attach_plan_usage,
    parse_plan_usage_headers,
    read_plan_usage_snapshot,
    record_plan_usage_snapshot,
)


def test_chatgpt_plan_meter_flag_defaults_on_like_context_usage_live() -> None:
    # Mirrors is_context_usage_live_enabled's default-True contract: missing
    # mapping, empty mapping, and non-mapping input all default ON; only an
    # explicit False turns it off. Default-ON kill switch is
    # JENNY_ENABLE_CHATGPT_PLAN_METER=0 (Electron layer; not read here).
    assert is_chatgpt_plan_meter_enabled(None) is True
    assert is_chatgpt_plan_meter_enabled({}) is True
    assert is_chatgpt_plan_meter_enabled({FEATURE_CHATGPT_PLAN_METER: True}) is True
    assert is_chatgpt_plan_meter_enabled({FEATURE_CHATGPT_PLAN_METER: False}) is False
    assert is_chatgpt_plan_meter_enabled("not-a-mapping") is True  # type: ignore[arg-type]

_FULL_HEADERS = {
    "x-codex-primary-used-percent": "62.04",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1756800000",
    "x-codex-secondary-used-percent": "18",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "1757100000",
    "x-codex-rate-limit-reached-type": "primary",
}


_FULL_SNAPSHOT = {
    "schema_version": 1,
    "primary": {"used_percent": 62.0, "window_minutes": 300, "reset_at": 1756800000},
    "secondary": {"used_percent": 18.0, "window_minutes": 10080, "reset_at": 1757100000},
    "rate_limit_reached_type": "primary",
}


def _response(headers: dict[str, str] | None) -> Any:
    return SimpleNamespace(headers=headers)


def test_full_snapshot_parses_both_windows_and_reached_type() -> None:
    snapshot = parse_plan_usage_headers(_response(_FULL_HEADERS))

    assert snapshot == {
        "schema_version": PLAN_USAGE_SCHEMA_VERSION,
        "primary": {"used_percent": 62.0, "window_minutes": 300, "reset_at": 1756800000},
        "secondary": {"used_percent": 18.0, "window_minutes": 10080, "reset_at": 1757100000},
        "rate_limit_reached_type": "primary",
    }


def test_primary_only_snapshot_omits_secondary_and_reached_type() -> None:
    headers = {
        "x-codex-primary-used-percent": "50",
        "x-codex-primary-reset-at": "1756800000",
    }

    snapshot = parse_plan_usage_headers(_response(headers))

    assert snapshot == {
        "schema_version": PLAN_USAGE_SCHEMA_VERSION,
        "primary": {"used_percent": 50.0, "reset_at": 1756800000},
    }


def test_iso8601_reset_at_is_accepted_and_converted_to_epoch_seconds() -> None:
    headers = {
        "x-codex-primary-used-percent": "10",
        "x-codex-primary-reset-at": "2026-07-31T00:00:00Z",
    }

    snapshot = parse_plan_usage_headers(_response(headers))

    assert snapshot is not None
    assert snapshot["primary"]["reset_at"] == 1785456000


@pytest.mark.parametrize(
    "bad_percent",
    ["nan", "inf", "-inf", "not-a-number", ""],
)
def test_malformed_used_percent_drops_only_that_window(bad_percent: str) -> None:
    headers = {
        "x-codex-primary-used-percent": bad_percent,
        "x-codex-primary-reset-at": "1756800000",
        "x-codex-secondary-used-percent": "18",
        "x-codex-secondary-reset-at": "1757100000",
    }

    snapshot = parse_plan_usage_headers(_response(headers))

    assert snapshot is not None
    assert "primary" not in snapshot
    assert snapshot["secondary"]["used_percent"] == 18.0


def test_used_percent_out_of_range_is_clamped_not_dropped() -> None:
    headers = {
        "x-codex-primary-used-percent": "-5",
        "x-codex-primary-reset-at": "1756800000",
    }

    snapshot = parse_plan_usage_headers(_response(headers))

    assert snapshot is not None
    assert snapshot["primary"]["used_percent"] == 0.0


@pytest.mark.parametrize(
    "bad_reset_at",
    ["0", "999999999", "9007199254740992", "not-a-date", ""],
)
def test_out_of_range_or_unparseable_reset_at_drops_the_window(bad_reset_at: str) -> None:
    headers = {
        "x-codex-primary-used-percent": "50",
        "x-codex-primary-reset-at": bad_reset_at,
    }

    snapshot = parse_plan_usage_headers(_response(headers))

    assert snapshot is None


@pytest.mark.parametrize("bad_minutes", ["0", "-1", "1051201", "not-a-number"])
def test_window_minutes_out_of_range_is_omitted_but_window_survives(bad_minutes: str) -> None:
    headers = {
        "x-codex-primary-used-percent": "50",
        "x-codex-primary-window-minutes": bad_minutes,
        "x-codex-primary-reset-at": "1756800000",
    }

    snapshot = parse_plan_usage_headers(_response(headers))

    assert snapshot is not None
    assert "window_minutes" not in snapshot["primary"]
    assert snapshot["primary"]["used_percent"] == 50.0


def test_unknown_reached_type_is_dropped_not_echoed() -> None:
    headers = {
        "x-codex-primary-used-percent": "50",
        "x-codex-primary-reset-at": "1756800000",
        "x-codex-rate-limit-reached-type": "tertiary",
    }

    snapshot = parse_plan_usage_headers(_response(headers))

    assert snapshot is not None
    assert "rate_limit_reached_type" not in snapshot


def test_oversized_header_value_is_bounded_before_parsing() -> None:
    huge_digits = "9" * 100_000
    headers = {
        "x-codex-primary-used-percent": "5" + huge_digits,
        "x-codex-primary-reset-at": "1756800000",
    }

    # A 100KB numeric string is truncated to 64 chars before float() ever
    # sees it (never processed whole -- this must not hang), then the huge
    # (but finite) parsed float is clamped into the 0..100 range like any
    # other out-of-range value; the raw digit run is never echoed back.
    snapshot = parse_plan_usage_headers(_response(headers))

    assert snapshot is not None
    assert snapshot["primary"]["used_percent"] == 100.0
    assert huge_digits not in str(snapshot)


def test_both_windows_bad_returns_none() -> None:
    headers = {
        "x-codex-primary-used-percent": "nan",
        "x-codex-secondary-used-percent": "nan",
    }

    assert parse_plan_usage_headers(_response(headers)) is None


def test_no_headers_returns_none() -> None:
    assert parse_plan_usage_headers(_response(None)) is None
    assert parse_plan_usage_headers(SimpleNamespace()) is None


def test_case_insensitive_dict_lookup_matches_any_header_casing() -> None:
    headers = {
        "X-Codex-Primary-Used-Percent": "50",
        "X-Codex-Primary-Reset-At": "1756800000",
    }

    snapshot = parse_plan_usage_headers(_response(headers))

    assert snapshot is not None
    assert snapshot["primary"]["used_percent"] == 50.0


def test_stash_is_request_scoped_and_cleared() -> None:
    engine = object()
    install_request_context(engine, request_id="req-1")
    try:
        record_plan_usage_snapshot(engine, _response(_FULL_HEADERS))
        assert read_plan_usage_snapshot(engine) is not None
        context = current_request_context(engine)
        assert context is not None
        assert PLAN_USAGE_CONTEXT_KEY in context
    finally:
        clear_request_context(engine)
    assert current_request_context(engine) is None
    assert read_plan_usage_snapshot(engine) is None


def test_record_is_a_silent_no_op_without_a_bound_request_context() -> None:
    engine = object()
    # No install_request_context call -- simulates a direct engine.generate()
    # call outside a chat.send turn.
    record_plan_usage_snapshot(engine, _response(_FULL_HEADERS))
    assert read_plan_usage_snapshot(engine) is None


def test_record_never_raises_on_a_headerless_response() -> None:
    engine = object()
    install_request_context(engine, request_id="req-2")
    try:
        record_plan_usage_snapshot(engine, SimpleNamespace())
        record_plan_usage_snapshot(engine, None)
        record_plan_usage_snapshot(engine, object())
        assert read_plan_usage_snapshot(engine) is None
    finally:
        clear_request_context(engine)


def test_attach_plan_usage_omits_when_disabled() -> None:
    engine = object()
    install_request_context(engine, request_id="req-3")
    try:
        record_plan_usage_snapshot(engine, _response(_FULL_HEADERS))
        payload: dict[str, Any] = {}
        attach_plan_usage(payload, engine, enabled=False)
        assert PLAN_USAGE_CONTEXT_KEY not in payload
    finally:
        clear_request_context(engine)


def test_attach_plan_usage_omits_when_no_snapshot() -> None:
    engine = object()
    install_request_context(engine, request_id="req-4")
    try:
        payload: dict[str, Any] = {}
        attach_plan_usage(payload, engine, enabled=True)
        assert PLAN_USAGE_CONTEXT_KEY not in payload
    finally:
        clear_request_context(engine)


def test_attach_plan_usage_copies_rather_than_aliases() -> None:
    engine = object()
    install_request_context(engine, request_id="req-5")
    try:
        record_plan_usage_snapshot(engine, _response(_FULL_HEADERS))
        payload: dict[str, Any] = {}
        attach_plan_usage(payload, engine, enabled=True)
        attached = payload[PLAN_USAGE_CONTEXT_KEY]
        stashed = read_plan_usage_snapshot(engine)
        assert attached == stashed
        assert attached is not stashed
        attached["primary"]["used_percent"] = 999.0
        assert read_plan_usage_snapshot(engine)["primary"]["used_percent"] != 999.0
    finally:
        clear_request_context(engine)


def test_window_minutes_inf_drops_only_that_field_not_the_snapshot() -> None:
    headers = dict(_FULL_HEADERS)
    headers["x-codex-primary-window-minutes"] = "inf"
    snapshot = parse_plan_usage_headers(_response(headers))
    assert snapshot is not None
    assert "window_minutes" not in snapshot["primary"]
    assert snapshot["primary"]["used_percent"] == _FULL_SNAPSHOT["primary"]["used_percent"]
    assert snapshot["secondary"] == _FULL_SNAPSHOT["secondary"]


def test_naive_iso_reset_at_is_read_as_utc() -> None:
    headers = dict(_FULL_HEADERS)
    headers["x-codex-primary-reset-at"] = "2026-07-31T00:00:00"
    naive = parse_plan_usage_headers(_response(headers))
    headers["x-codex-primary-reset-at"] = "2026-07-31T00:00:00Z"
    explicit = parse_plan_usage_headers(_response(headers))
    assert naive is not None and explicit is not None
    assert naive["primary"]["reset_at"] == explicit["primary"]["reset_at"] == 1785456000


def test_chat_error_notification_carries_plan_usage_from_error_data() -> None:
    engine = object()
    install_request_context(engine, request_id="req-6")
    try:
        record_plan_usage_snapshot(engine, _response(_FULL_HEADERS))
        error = ChatRequestError(
            request_id="req-6",
            trace_id=None,
            session_id=None,
            code="CMP-LOOP-0001",
            message="rate limited",
            rpc_code=-32000,
            retryable=True,
            data={},
        )
        attach_plan_usage(error.data, engine, enabled=True)
    finally:
        clear_request_context(engine)
    notification_payload = chat_error_notification(error)["params"]
    assert notification_payload["plan_usage"] == _FULL_SNAPSHOT
    assert notification_payload["code"] == "CMP-LOOP-0001"
