"""Tests for sidecar.runtime.initialize_mode -- the PLUG-D16 fail-closed
`initialize` `mode` discriminator -- and its wiring into
sidecar.runtime.request_dispatch.process_message.

Coverage map:
  - every branch of resolve_initialize_mode, including malformed types
  - "Full_Runtime" / " full_runtime " are rejected, not coerced
  - a long/hostile mode value is bounded and redacted in the rejection
  - through process_message: an unknown mode returns an error response AND
    does not merge secrets or apply logging preferences (the "cannot
    silently fall through to full runtime configuration" proof)
  - through process_message: absence of `mode` still initializes exactly as
    before (the byte-identical-for-existing-callers proof)
  - through process_message: a rejected mode preserves the prior
    `initialized` state rather than hardcoding it
  - plugin_runtime mode is accepted only by the isolated Stage-4 branch
"""

from __future__ import annotations

import logging
from dataclasses import FrozenInstanceError
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.request_dispatch as rd
from sidecar.ai.error_codes import CMP_PLUGIN_FEATURE_DISABLED
from sidecar.protocol import API_VERSION, PLUGIN_RUNTIME_APPLIED_METHOD
from sidecar.runtime.initialize_mode import (
    FULL_RUNTIME_MODE,
    PLUGIN_RUNTIME_MODE,
    REASON_UNKNOWN_INITIALIZE_MODE,
    InitializeModeResolution,
    resolve_initialize_mode,
)

LOGGER = logging.getLogger("test.initialize_mode")


def _null_writer(_msg: dict) -> None:
    pass


def _null_reader() -> dict:
    return {}


def _minimal_brain() -> SimpleNamespace:
    """Smallest duck-typed BrainContainer stand-in.

    The INITIALIZE_METHOD branch only touches `brain_container` by handing it
    to `initialize_response`, which every test here monkeypatches, so no
    realistic stack is required.
    """
    return SimpleNamespace(stack=SimpleNamespace(config=SimpleNamespace()))


# ---------------------------------------------------------------------------
# resolve_initialize_mode: pure-function branch coverage
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_params", [None, "string", 42, [], object(), True])
def test_params_not_a_dict_resolves_full_runtime_ok(bad_params: Any) -> None:
    resolution = resolve_initialize_mode(bad_params)
    assert resolution.ok is True
    assert resolution.mode == FULL_RUNTIME_MODE
    assert resolution.reason is None
    assert resolution.rejected_mode is None


def test_missing_mode_key_resolves_full_runtime_ok() -> None:
    resolution = resolve_initialize_mode({"config": {}, "accept_version": API_VERSION})
    assert resolution.ok is True
    assert resolution.mode == FULL_RUNTIME_MODE
    assert resolution.reason is None
    assert resolution.rejected_mode is None


def test_explicit_full_runtime_mode_is_ok() -> None:
    resolution = resolve_initialize_mode({"mode": "full_runtime"})
    assert resolution.ok is True
    assert resolution.mode == FULL_RUNTIME_MODE
    assert resolution.reason is None
    assert resolution.rejected_mode is None


def test_plugin_runtime_mode_selects_exact_plugin_branch() -> None:
    resolution = resolve_initialize_mode({"mode": "plugin_runtime"})
    assert resolution.ok is True
    assert resolution.mode == PLUGIN_RUNTIME_MODE
    assert resolution.reason is None
    assert resolution.rejected_mode is None


@pytest.mark.parametrize(
    "raw_mode",
    [
        "Full_Runtime",
        " full_runtime ",
        "FULL_RUNTIME",
        "full_runtime\n",
        "full_runtime\t",
        "",
        "plugin_runtime ",
        " plugin_runtime",
        "Plugin_Runtime",
    ],
)
def test_case_or_whitespace_near_misses_are_rejected_not_coerced(raw_mode: str) -> None:
    """A near-miss string must never be normalized into a match. An
    attacker-supplied "Full_Runtime" or " full_runtime " must be rejected,
    not silently treated as the canonical value."""
    resolution = resolve_initialize_mode({"mode": raw_mode})
    assert resolution.ok is False
    assert resolution.reason == REASON_UNKNOWN_INITIALIZE_MODE


@pytest.mark.parametrize(
    "raw_mode",
    [None, 1, 1.5, True, False, [], {}, ["full_runtime"], {"mode": "full_runtime"}, (1, 2)],
)
def test_malformed_type_modes_are_rejected(raw_mode: Any) -> None:
    resolution = resolve_initialize_mode({"mode": raw_mode})
    assert resolution.ok is False
    assert resolution.reason == REASON_UNKNOWN_INITIALIZE_MODE
    # `mode` is not meaningful on a rejected resolution -- callers must branch
    # on `ok` first (see InitializeModeResolution's docstring).
    assert resolution.mode == FULL_RUNTIME_MODE


def test_hostile_long_mode_value_is_bounded_and_redacted() -> None:
    hostile = "a" * 10_000
    resolution = resolve_initialize_mode({"mode": hostile})
    assert resolution.ok is False
    assert resolution.reason == REASON_UNKNOWN_INITIALIZE_MODE
    assert resolution.rejected_mode is not None
    assert len(resolution.rejected_mode) <= 32
    assert hostile not in resolution.rejected_mode
    assert resolution.rejected_mode.endswith("...<truncated>")


def test_non_string_mode_display_never_echoes_repr() -> None:
    """A list/dict mode must be represented only by its type name, never
    repr()'d -- repr() of a large/nested structure is unbounded and could
    round-trip attacker-controlled content back into a log line or response."""
    hostile_list = ["x"] * 10_000
    resolution = resolve_initialize_mode({"mode": hostile_list})
    assert resolution.ok is False
    assert resolution.rejected_mode == "<list>"
    assert "x" not in resolution.rejected_mode


def test_none_mode_display_is_type_name_not_none_literal() -> None:
    resolution = resolve_initialize_mode({"mode": None})
    assert resolution.rejected_mode == "<NoneType>"


def test_resolution_is_frozen_dataclass_instance() -> None:
    resolution = resolve_initialize_mode({})
    assert isinstance(resolution, InitializeModeResolution)
    with pytest.raises(FrozenInstanceError):
        resolution.ok = False  # type: ignore[misc]


# ---------------------------------------------------------------------------
# process_message wiring: the guard runs first and fails closed
# ---------------------------------------------------------------------------


def test_process_message_unknown_mode_rejected_without_state_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The "cannot silently fall through to full runtime configuration"
    proof: an unknown mode returns an error response AND must not have applied
    logging preferences or reached `initialize_response`.

    `initialize_response` standing in for "no secret was handled" is exact
    since the worker-secrets refactor: there is no longer a config-merging
    step to intercept, because `initialize_response` lifts brokered secrets
    off params["secrets"] itself and never writes them into the config. So the
    only way a secret gets touched on this path is a call that never happens.
    The params below still carry one, so the assertion has something to prove.
    """
    logging_pref_calls: list[Any] = []
    initialize_calls: list[Any] = []

    monkeypatch.setattr(
        rd, "apply_logging_preferences", logging_pref_calls.append
    )
    monkeypatch.setattr(
        rd,
        "initialize_response",
        lambda *a, **k: initialize_calls.append((a, k)) or {"jsonrpc": "2.0", "result": {}},
    )

    outcome = rd.process_message(
        {
            "method": "initialize",
            "id": 1,
            "params": {
                "accept_version": API_VERSION,
                "config": {"marker": True},
                "secrets": {"chatgpt_access_token": "super-secret"},
                "mode": "Full_Runtime",
            },
        },
        False,
        brain_container=_minimal_brain(),  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    assert not logging_pref_calls
    assert not initialize_calls
    assert outcome.response is not None
    err = outcome.response["error"]
    assert err["code"] == rd.INVALID_PARAMS_CODE
    assert err["data"]["reason"] == REASON_UNKNOWN_INITIALIZE_MODE


def test_process_message_plugin_runtime_requires_prior_full_initialize() -> None:
    outcome = rd.process_message(
        {
            "method": "initialize",
            "id": 1,
            "params": {
                "mode": "plugin_runtime",
                "plugin_runtime": {"snapshot": {}, "declarative_content": []},
            },
        },
        False,
        brain_container=_minimal_brain(),  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    assert outcome.initialized is False
    assert outcome.shutdown_requested is False
    err = outcome.response["error"]
    assert err["data"]["code"] == CMP_PLUGIN_FEATURE_DISABLED
    assert err["data"]["reason"] == "plugin_runtime_requires_full_initialization"


def test_process_message_plugin_runtime_returns_exact_attestation_and_notification() -> None:
    attestation = {
        "attestation_schema_version": 1,
        "participant_kind": "sidecar",
        "registry_revision": 2,
    }
    apply_calls: list[dict[str, object]] = []
    brain = SimpleNamespace(
        apply_plugin_runtime=lambda **kwargs: apply_calls.append(kwargs) or attestation,
    )
    outcome = rd.process_message(
        {
            "method": "initialize",
            "id": 2,
            "params": {
                "mode": "plugin_runtime",
                "plugin_runtime": {
                    "snapshot": {"kind": "plugin_runtime_snapshot"},
                    "declarative_content": [],
                },
            },
        },
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    assert apply_calls == [{
        "snapshot": {"kind": "plugin_runtime_snapshot"},
        "declarative_content": [],
    }]
    assert outcome.initialized is True
    assert outcome.response == {
        "jsonrpc": "2.0",
        "id": 2,
        "api_version": API_VERSION,
        "result": attestation,
    }
    assert outcome.notifications == [{
        "jsonrpc": "2.0",
        "api_version": API_VERSION,
        "method": PLUGIN_RUNTIME_APPLIED_METHOD,
        "params": attestation,
    }]


def test_process_message_missing_mode_still_initializes_as_before(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The byte-identical-for-existing-callers proof: an initialize with no
    `mode` field runs the pre-existing pipeline exactly as before."""

    def _fake_initialize_response(message_id: Any, _params: Any, **_kwargs: Any) -> dict:
        return {"jsonrpc": "2.0", "id": message_id, "result": {}}

    monkeypatch.setattr(rd, "initialize_response", _fake_initialize_response)

    outcome = rd.process_message(
        {
            "method": "initialize",
            "id": 9,
            "params": {"accept_version": API_VERSION, "config": {}},
        },
        False,
        brain_container=_minimal_brain(),  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    assert outcome.initialized is True
    assert outcome.response is not None
    assert "error" not in outcome.response


def test_process_message_explicit_full_runtime_mode_still_initializes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An explicit, exactly-canonical `mode: "full_runtime"` behaves the same
    as omitting `mode` entirely -- it is accepted and proceeds to initialize."""

    def _fake_initialize_response(message_id: Any, _params: Any, **_kwargs: Any) -> dict:
        return {"jsonrpc": "2.0", "id": message_id, "result": {}}

    monkeypatch.setattr(rd, "initialize_response", _fake_initialize_response)

    outcome = rd.process_message(
        {
            "method": "initialize",
            "id": 10,
            "params": {"accept_version": API_VERSION, "config": {}, "mode": "full_runtime"},
        },
        False,
        brain_container=_minimal_brain(),  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    assert outcome.initialized is True
    assert outcome.response is not None
    assert "error" not in outcome.response


def test_rejected_reinitialize_preserves_initialized_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rd,
        "initialize_response",
        lambda message_id, _params, **_kwargs: {
            "jsonrpc": "2.0",
            "id": message_id,
            "result": {},
        },
    )
    brain = _minimal_brain()
    first = rd.process_message(
        {
            "method": "initialize",
            "id": 11,
            "params": {"accept_version": API_VERSION, "config": {}},
        },
        False,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    second = rd.process_message(
        {
            "method": "initialize",
            "id": 12,
            "params": {"accept_version": "incompatible", "config": {}},
        },
        first.initialized,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    assert first.initialized is True
    assert second.initialized is True
    assert second.response is not None
    assert "error" in second.response


def test_failed_reinitialize_preserves_initialized_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_count = 0

    def _initialize_response(message_id: Any, _params: Any, **_kwargs: Any) -> dict:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return {"jsonrpc": "2.0", "id": message_id, "result": {}}
        raise RuntimeError("reinitialize failed")

    monkeypatch.setattr(rd, "initialize_response", _initialize_response)
    brain = _minimal_brain()
    first = rd.process_message(
        {
            "method": "initialize",
            "id": 13,
            "params": {"accept_version": API_VERSION, "config": {}},
        },
        False,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    second = rd.process_message(
        {
            "method": "initialize",
            "id": 14,
            "params": {"accept_version": API_VERSION, "config": {}},
        },
        first.initialized,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    assert first.initialized is True
    assert second.initialized is True
    assert second.response is not None
    assert second.response["error"]["data"]["code"] == rd.INITIALIZE_FAILED
