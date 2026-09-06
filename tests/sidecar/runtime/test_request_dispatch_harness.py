from __future__ import annotations

import json
from types import SimpleNamespace

import sidecar.runtime.request_dispatch_harness as harness_module
from sidecar.ai.error_codes import CMP_HARNESS_TURN_NOT_FOUND
from sidecar.protocol import API_VERSION, HARNESS_INSPECT_METHOD, HARNESS_TURN_DIAGNOSTIC_METHOD
from sidecar.runtime.request_dispatch_harness import (
    HARNESS_TURN_NOT_FOUND_CODE,
    INTERNAL_ERROR_CODE,
    INVALID_PARAMS_CODE,
    _harness_precheck,
    process_harness_method,
)


def _brain(*, inspect_fn=None, turn_diag_fn=None):
    """Build a minimal duck-typed BrainContainer with recorder fakes."""
    inspect_calls = []
    diag_calls = []

    def _default_inspect(**kwargs):
        inspect_calls.append(kwargs)
        return {"sections": {}, "recent_history": []}

    def _default_turn_diag(**kwargs):
        diag_calls.append(kwargs)
        return {"provider": "fake", "tokens": 10}

    return (
        SimpleNamespace(
            stack=SimpleNamespace(
                harness_snapshot_builder=SimpleNamespace(
                    inspect=inspect_fn if inspect_fn is not None else _default_inspect,
                ),
                turn_diagnostics=SimpleNamespace(
                    get_snapshot_for_request=(
                        turn_diag_fn if turn_diag_fn is not None else _default_turn_diag
                    ),
                ),
            )
        ),
        inspect_calls,
        diag_calls,
    )


# ---------------------------------------------------------------------------
# Existing test – kept intact
# ---------------------------------------------------------------------------


def test_harness_internal_error_preserves_non_chat_correlation_ids() -> None:
    def _raise_error(**_kwargs):
        raise RuntimeError("harness failed with bearer secret-token")

    outcome = process_harness_method(
        "harness.inspect",
        77,
        {
            "accept_version": API_VERSION,
            "request_id": "req_harness",
            "trace_id": "trace_harness",
            "session_id": "sess_harness",
            "sections": ["runtime"],
        },
        True,
        SimpleNamespace(
            stack=SimpleNamespace(
                harness_snapshot_builder=SimpleNamespace(inspect=_raise_error),
            )
        ),
    )

    assert outcome is not None
    data = outcome.response["error"]["data"]
    assert data["request_id"] == "req_harness"
    assert data["trace_id"] == "trace_harness"
    assert data["session_id"] == "sess_harness"
    assert "secret-token" not in str(data)
    assert "bearer [redacted]" in data["detail"]


# ---------------------------------------------------------------------------
# process_harness_method dispatch
# ---------------------------------------------------------------------------


def test_process_harness_method_unknown_returns_none() -> None:
    brain, _, _ = _brain()
    result = process_harness_method("harness.unknown", 1, {"accept_version": API_VERSION}, True, brain)
    assert result is None


def test_process_harness_method_dispatches_turn_diagnostic() -> None:
    """Covers line 137 — HARNESS_TURN_DIAGNOSTIC_METHOD branch."""
    diag_snapshot = {"provider": "test", "tokens": 42}
    calls = []

    def _get_snap(**kwargs):
        calls.append(kwargs)
        return diag_snapshot

    brain = SimpleNamespace(
        stack=SimpleNamespace(
            turn_diagnostics=SimpleNamespace(get_snapshot_for_request=_get_snap),
        )
    )
    outcome = process_harness_method(
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        10,
        {"accept_version": API_VERSION, "request_id": "req-abc"},
        True,
        brain,
    )
    assert outcome is not None
    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert calls == [{"request_id": "req-abc"}]
    result = outcome.response["result"]
    assert result["provider_diagnostics"] == diag_snapshot


# ---------------------------------------------------------------------------
# _harness_precheck — version mismatch (lines 94-95)
# ---------------------------------------------------------------------------


def test_harness_inspect_version_mismatch_returns_error() -> None:
    """Covers line 95 — version_error is not None path."""
    brain, _, _ = _brain()
    outcome = process_harness_method(
        HARNESS_INSPECT_METHOD,
        5,
        {"accept_version": "1900-01-01"},  # wrong version
        False,
        brain,
    )
    assert outcome is not None
    assert outcome.initialized is False
    err = outcome.response["error"]
    assert err["code"] == INVALID_PARAMS_CODE
    assert "accept_version" in err["message"]


# ---------------------------------------------------------------------------
# _harness_precheck — message_id is None (line 97)
# ---------------------------------------------------------------------------


def test_harness_inspect_null_message_id_returns_none_response() -> None:
    """Covers line 97 — message_id is None → response is None."""
    brain, _, _ = _brain()
    outcome = process_harness_method(
        HARNESS_INSPECT_METHOD,
        None,  # message_id = None
        {"accept_version": API_VERSION},
        True,
        brain,
    )
    assert outcome is not None
    assert outcome.response is None
    assert outcome.initialized is True


# ---------------------------------------------------------------------------
# _harness_precheck — require_params_dict=True with non-dict params (lines 99-100)
# ---------------------------------------------------------------------------


def test_harness_precheck_require_params_dict_non_dict_params_error() -> None:
    """Covers lines 99-100 — require_params_dict=True, params is a list.

    We call _harness_precheck directly because validate_accept_version fires
    before the params-type check and can only be bypassed by providing a dict
    with a valid accept_version — which makes isinstance(params, dict) True and
    renders the branch unreachable via process_harness_method.
    """
    # Bypass version check by injecting a mock: we call _harness_precheck directly
    # with a fake method that matches accept_version=None (our crafted scenario).
    # The function is module-level so we can import and call it.
    # We need validate_accept_version to return None — that requires accept_version
    # to equal API_VERSION, which requires params to be a dict. Contradiction.
    # Therefore we test _harness_precheck directly with a monkeypatched
    # validate_accept_version that returns None unconditionally.
    original = harness_module.validate_accept_version
    try:
        harness_module.validate_accept_version = lambda **_kw: None  # type: ignore[assignment]
        result = _harness_precheck(
            method=HARNESS_TURN_DIAGNOSTIC_METHOD,
            message_id=20,
            params=["not", "a", "dict"],
            initialized=True,
            require_params_dict=True,
            invalid_params_message="harness.turn_diagnostic invalid params",
        )
    finally:
        harness_module.validate_accept_version = original

    assert result is not None
    err = result.response["error"]
    assert err["code"] == INVALID_PARAMS_CODE
    assert err["message"] == "harness.turn_diagnostic invalid params"
    assert err["data"]["detail"] == "params must be an object with a request_id field."


# ---------------------------------------------------------------------------
# _harness_precheck — elif non-dict params for inspect (line 110)
# ---------------------------------------------------------------------------


def test_harness_precheck_non_dict_non_none_params_no_require_dict_error() -> None:
    """Covers line 110 — require_params_dict=False, params is int (not None, not dict)."""
    original = harness_module.validate_accept_version
    try:
        harness_module.validate_accept_version = lambda **_kw: None  # type: ignore[assignment]
        result = _harness_precheck(
            method=HARNESS_INSPECT_METHOD,
            message_id=21,
            params=42,  # int: not None, not dict
            initialized=True,
            require_params_dict=False,
            invalid_params_message="harness.inspect invalid params",
        )
    finally:
        harness_module.validate_accept_version = original

    assert result is not None
    err = result.response["error"]
    assert err["code"] == INVALID_PARAMS_CODE
    assert err["message"] == "harness.inspect invalid params"
    assert err["data"]["detail"] == "params must be an object."


# ---------------------------------------------------------------------------
# _process_harness_inspect — precheck not None early return (line 162)
# ---------------------------------------------------------------------------


def test_harness_inspect_precheck_short_circuits() -> None:
    """Covers line 162 — precheck is returned early (wrong version → no inspect call)."""
    inspect_calls = []

    def _inspect(**kwargs):
        inspect_calls.append(kwargs)
        return {}

    brain = SimpleNamespace(
        stack=SimpleNamespace(
            harness_snapshot_builder=SimpleNamespace(inspect=_inspect),
        )
    )
    outcome = process_harness_method(
        HARNESS_INSPECT_METHOD,
        30,
        {"accept_version": "9999-01-01"},
        True,
        brain,
    )
    assert outcome is not None
    # inspect must NOT have been called — the precheck short-circuited
    assert inspect_calls == []
    assert outcome.response["error"]["code"] == INVALID_PARAMS_CODE


# ---------------------------------------------------------------------------
# _process_harness_inspect — happy path (confirms collaborator called)
# ---------------------------------------------------------------------------


def test_harness_inspect_happy_path_calls_snapshot_builder() -> None:
    brain, inspect_calls, _ = _brain()
    params = {
        "accept_version": API_VERSION,
        "sections": ["runtime", "config"],
        "include_recent_history": False,
        "recent_history_limit": 3,
        "include_disabled": False,
    }
    outcome = process_harness_method(HARNESS_INSPECT_METHOD, 99, params, True, brain)
    assert outcome is not None
    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert len(inspect_calls) == 1
    call = inspect_calls[0]
    assert call["sections"] == ["runtime", "config"]
    assert call["include_recent_history"] is False
    assert call["recent_history_limit"] == 3
    assert call["include_disabled"] is False
    result = outcome.response["result"]
    assert "sections" in result


# ---------------------------------------------------------------------------
# _process_harness_inspect — None params uses defaults
# ---------------------------------------------------------------------------


def test_harness_inspect_none_params_uses_defaults() -> None:
    brain, inspect_calls, _ = _brain()
    outcome = process_harness_method(
        HARNESS_INSPECT_METHOD,
        50,
        {"accept_version": API_VERSION},  # no extra fields
        True,
        brain,
    )
    assert outcome is not None
    assert len(inspect_calls) == 1
    call = inspect_calls[0]
    assert call["sections"] is None
    assert call["include_recent_history"] is True
    assert call["recent_history_limit"] == 5
    assert call["include_disabled"] is True


def test_harness_inspect_web_search_probe_is_bounded_and_redacted(monkeypatch) -> None:
    brain, _, _ = _brain()
    raw_secret = "bearer secret-provider-token"
    monkeypatch.setattr(
        harness_module,
        "web_search_tool",
        lambda *_args: SimpleNamespace(
            success=False,
            output=json.dumps(
                {
                    "provider": "provider-name-that-is-far-too-long-for-the-contract",
                    "sources": [{}] * 12,
                    "error": raw_secret,
                }
            ),
        ),
    )

    outcome = process_harness_method(
        HARNESS_INSPECT_METHOD,
        51,
        {"accept_version": API_VERSION, "web_search_probe": True},
        True,
        brain,
    )

    probe = outcome.response["result"]["web_search_probe"]
    assert probe["ok"] is False
    assert len(probe["provider"]) == 32
    assert probe["result_count"] == 10
    assert raw_secret not in probe["error"]
    assert "bearer [redacted]" in probe["error"]


def test_harness_inspect_web_search_probe_degrades_without_breaking_snapshot(
    monkeypatch,
) -> None:
    brain, inspect_calls, _ = _brain()

    def _raise(*_args):
        raise RuntimeError("provider exploded with secret-token")

    monkeypatch.setattr(harness_module, "web_search_tool", _raise)
    outcome = process_harness_method(
        HARNESS_INSPECT_METHOD,
        52,
        {"accept_version": API_VERSION, "web_search_probe": True},
        True,
        brain,
    )

    result = outcome.response["result"]
    assert len(inspect_calls) == 1
    assert result["web_search_probe"] == {
        "ok": False,
        "provider": "",
        "result_count": 0,
        "error": "Connection test failed.",
    }


# ---------------------------------------------------------------------------
# _process_harness_turn_diagnostic — lines 195-245
# ---------------------------------------------------------------------------


def test_turn_diagnostic_happy_path_returns_snapshot(  # lines 245-248
) -> None:
    """Covers lines 245-248 — successful snapshot returned."""
    snap = {"provider": "ollama", "tokens": 77}
    calls = []

    def _get_snap(**kwargs):
        calls.append(kwargs)
        return snap

    brain = SimpleNamespace(
        stack=SimpleNamespace(
            turn_diagnostics=SimpleNamespace(get_snapshot_for_request=_get_snap),
        )
    )
    outcome = process_harness_method(
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        100,
        {"accept_version": API_VERSION, "request_id": "req-diag-1"},
        True,
        brain,
    )
    assert outcome is not None
    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert calls == [{"request_id": "req-diag-1"}]
    result = outcome.response["result"]
    assert result["provider_diagnostics"] == snap


def test_turn_diagnostic_missing_request_id_returns_error(  # lines 206-215
) -> None:
    """Covers lines 206-215 — empty request_id → INVALID_PARAMS_CODE error."""
    brain, _, _ = _brain()
    outcome = process_harness_method(
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        101,
        {"accept_version": API_VERSION, "request_id": ""},
        True,
        brain,
    )
    assert outcome is not None
    err = outcome.response["error"]
    assert err["code"] == INVALID_PARAMS_CODE
    assert err["message"] == "harness.turn_diagnostic missing request_id"
    assert err["data"]["detail"] == "params.request_id is required."


def test_turn_diagnostic_absent_request_id_key_returns_error() -> None:
    """request_id key absent — str(None).strip() == '' → same missing-id path."""
    brain, _, _ = _brain()
    outcome = process_harness_method(
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        102,
        {"accept_version": API_VERSION},  # no request_id key at all
        False,
        brain,
    )
    assert outcome is not None
    err = outcome.response["error"]
    assert err["code"] == INVALID_PARAMS_CODE
    assert "missing request_id" in err["message"]


def test_turn_diagnostic_snapshot_none_returns_not_found_error(  # lines 232-244
) -> None:
    """Covers lines 232-244 — snapshot is None → HARNESS_TURN_NOT_FOUND_CODE error."""
    def _get_none(**_kwargs):
        return None

    brain = SimpleNamespace(
        stack=SimpleNamespace(
            turn_diagnostics=SimpleNamespace(get_snapshot_for_request=_get_none),
        )
    )
    outcome = process_harness_method(
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        103,
        {"accept_version": API_VERSION, "request_id": "req-missing"},
        True,
        brain,
    )
    assert outcome is not None
    err = outcome.response["error"]
    assert err["code"] == HARNESS_TURN_NOT_FOUND_CODE
    assert "no diagnostics for request_id" in err["message"]
    assert err["data"]["error_code"] == CMP_HARNESS_TURN_NOT_FOUND
    assert err["data"]["request_id"] == "req-missing"


def test_turn_diagnostic_exception_returns_internal_error(  # lines 220-231
) -> None:
    """Covers lines 220-231 — exception during get_snapshot → INTERNAL_ERROR_CODE."""

    def _raise(**_kwargs):
        raise ValueError("db exploded")

    brain = SimpleNamespace(
        stack=SimpleNamespace(
            turn_diagnostics=SimpleNamespace(get_snapshot_for_request=_raise),
        )
    )
    outcome = process_harness_method(
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        104,
        {
            "accept_version": API_VERSION,
            "request_id": "req-err",
            "trace_id": "trace-xyz",
        },
        True,
        brain,
    )
    assert outcome is not None
    err = outcome.response["error"]
    assert err["code"] == INTERNAL_ERROR_CODE
    assert err["message"] == "harness.turn_diagnostic failed"
    data = err["data"]
    assert data["request_id"] == "req-err"
    assert data["trace_id"] == "trace-xyz"
    assert "db exploded" in data["detail"]


def test_turn_diagnostic_exception_request_id_from_explicit_kwarg() -> None:
    """The internal-error correlation carries the *coerced* request_id explicitly.

    Pins source line ~228: the explicit ``"request_id": request_id`` kwarg in the
    turn_diagnostic exception path. We feed a NON-string request_id (555) so that
    ``correlation_from_params`` (which only keeps str values) drops it — meaning the
    only way ``data["request_id"] == "555"`` can hold is via the explicit kwarg that
    forwards the str()-coerced request_id. Removing that kwarg drops the key entirely.
    """

    def _raise(**_kwargs):
        raise ValueError("kaboom")

    brain = SimpleNamespace(
        stack=SimpleNamespace(
            turn_diagnostics=SimpleNamespace(get_snapshot_for_request=_raise),
        )
    )
    outcome = process_harness_method(
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        106,
        {"accept_version": API_VERSION, "request_id": 555},  # non-str → dropped by correlation
        True,
        brain,
    )
    assert outcome is not None
    err = outcome.response["error"]
    assert err["code"] == INTERNAL_ERROR_CODE
    data = err["data"]
    # correlation_from_params would have filtered the int request_id out; the value
    # only survives because the source forwards the coerced string explicitly.
    assert data["request_id"] == "555"


def test_turn_diagnostic_whitespace_request_id_treated_as_empty() -> None:
    """request_id of whitespace-only → stripped to '' → missing-id error."""
    brain, _, _ = _brain()
    outcome = process_harness_method(
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        105,
        {"accept_version": API_VERSION, "request_id": "   "},
        True,
        brain,
    )
    assert outcome is not None
    err = outcome.response["error"]
    assert err["code"] == INVALID_PARAMS_CODE
    assert "missing request_id" in err["message"]


def test_turn_diagnostic_precheck_short_circuits_on_bad_version() -> None:
    """Precheck inside _process_harness_turn_diagnostic fires before request_id check."""
    diag_calls = []

    def _get_snap(**kwargs):
        diag_calls.append(kwargs)
        return {}

    brain = SimpleNamespace(
        stack=SimpleNamespace(
            turn_diagnostics=SimpleNamespace(get_snapshot_for_request=_get_snap),
        )
    )
    outcome = process_harness_method(
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        200,
        {"accept_version": "0000-01-01", "request_id": "req-x"},
        False,
        brain,
    )
    assert outcome is not None
    assert diag_calls == []
    assert outcome.response["error"]["code"] == INVALID_PARAMS_CODE


def test_turn_diagnostic_initialized_flag_propagated() -> None:
    """initialized=False is propagated into the ProcessOutcome."""
    snap = {"provider": "fake"}

    def _get_snap(**_kwargs):
        return snap

    brain = SimpleNamespace(
        stack=SimpleNamespace(
            turn_diagnostics=SimpleNamespace(get_snapshot_for_request=_get_snap),
        )
    )
    outcome = process_harness_method(
        HARNESS_TURN_DIAGNOSTIC_METHOD,
        300,
        {"accept_version": API_VERSION, "request_id": "req-init"},
        False,
        brain,
    )
    assert outcome is not None
    assert outcome.initialized is False
