"""Unit tests for the Phase 5 route-policy ladder."""

from __future__ import annotations

from sidecar.ai.routing.route_policy import (
    BLOCK_FAIL_CLOSED,
    BLOCK_TOOL_DISABLED,
    COUNTER_FALSE_POSITIVE,
    COUNTER_PARSE_FAILURE,
    COUNTER_PARSE_SUCCESS,
    COUNTER_REPAIR_USED,
    DISPATCH_IN_BAND,
    DISPATCH_NATIVE,
    DOWNGRADE_TO_IN_BAND,
    decide_dispatch_route,
)
from sidecar.runtime.provider_capability_profile import (
    ROUTE_FAIL_CLOSED,
    ROUTE_IN_BAND_TOOLS,
    ROUTE_NATIVE_TOOLS,
    ROUTE_NO_REASONING,
    ROUTE_TOOL_DISABLED,
    ProviderCapabilityDiagnostics,
    ProviderCapabilityFeatures,
    ProviderCapabilityObserved,
    ProviderCapabilityProfile,
)


def _make_profile(*, route: str) -> ProviderCapabilityProfile:
    return ProviderCapabilityProfile(
        profile_id=f"ollama@local::test-{route}",
        endpoint_id="ollama@local",
        model_id=f"test-{route}",
        generated_at="2026-05-02T00:00:00.000Z",
        expires_at="2026-05-02T00:05:00.000Z",
        probe_status="ready",
        selected_route=route,
        features=ProviderCapabilityFeatures(
            chat_supported=True,
            streaming_supported=True,
            native_tools_supported=route == ROUTE_NATIVE_TOOLS,
        ),
        observed=ProviderCapabilityObserved(),
        diagnostics=ProviderCapabilityDiagnostics(),
    )


def test_native_tools_passed_dispatches_native() -> None:
    decision = decide_dispatch_route(
        profile=_make_profile(route=ROUTE_NATIVE_TOOLS),
        tool_calls_present=True,
        coerced_arguments_present=False,
        schema_roundtrip_passed=True,
    )
    assert decision.action == DISPATCH_NATIVE
    assert decision.route == ROUTE_NATIVE_TOOLS
    assert decision.counter_kind == COUNTER_PARSE_SUCCESS


def test_native_tools_with_coerced_args_downgrades() -> None:
    decision = decide_dispatch_route(
        profile=_make_profile(route=ROUTE_NATIVE_TOOLS),
        tool_calls_present=True,
        coerced_arguments_present=True,
        schema_roundtrip_passed=True,
    )
    assert decision.action == DOWNGRADE_TO_IN_BAND
    assert decision.counter_kind == COUNTER_REPAIR_USED
    assert decision.reason == "coerced_native_arguments"


def test_native_tools_failed_roundtrip_downgrades() -> None:
    decision = decide_dispatch_route(
        profile=_make_profile(route=ROUTE_NATIVE_TOOLS),
        tool_calls_present=True,
        coerced_arguments_present=False,
        schema_roundtrip_passed=False,
    )
    assert decision.action == DOWNGRADE_TO_IN_BAND
    assert decision.counter_kind == COUNTER_REPAIR_USED
    assert decision.reason == "schema_roundtrip_failed"


def test_in_band_tools_dispatches_in_band() -> None:
    decision = decide_dispatch_route(
        profile=_make_profile(route=ROUTE_IN_BAND_TOOLS),
        tool_calls_present=True,
    )
    assert decision.action == DISPATCH_IN_BAND
    assert decision.route == ROUTE_IN_BAND_TOOLS
    assert decision.counter_kind == COUNTER_PARSE_SUCCESS


def test_tool_disabled_blocks_with_false_positive_counter() -> None:
    decision = decide_dispatch_route(
        profile=_make_profile(route=ROUTE_TOOL_DISABLED),
        tool_calls_present=True,
    )
    assert decision.action == BLOCK_TOOL_DISABLED
    assert decision.route == ROUTE_TOOL_DISABLED
    assert decision.counter_kind == COUNTER_FALSE_POSITIVE
    assert decision.reason == "route_blocks_tool_dispatch"


def test_fail_closed_blocks_with_no_dispatch() -> None:
    decision = decide_dispatch_route(
        profile=_make_profile(route=ROUTE_FAIL_CLOSED),
        tool_calls_present=True,
    )
    assert decision.action == BLOCK_FAIL_CLOSED
    assert decision.route == ROUTE_FAIL_CLOSED
    assert decision.counter_kind == COUNTER_PARSE_FAILURE
    assert decision.reason == "route_fail_closed"


def test_no_reasoning_dispatches_native() -> None:
    decision = decide_dispatch_route(
        profile=_make_profile(route=ROUTE_NO_REASONING),
        tool_calls_present=True,
    )
    assert decision.action == DISPATCH_NATIVE
    assert decision.route == ROUTE_NO_REASONING


def test_no_calls_returns_no_decision() -> None:
    decision = decide_dispatch_route(
        profile=_make_profile(route=ROUTE_NATIVE_TOOLS),
        tool_calls_present=False,
    )
    assert decision.route == ""
    assert decision.action == ""
    assert decision.counter_kind is None
    assert decision.reason == "no_tool_calls"


def test_decision_includes_reason_string_for_diagnostics() -> None:
    decision = decide_dispatch_route(
        profile=_make_profile(route=ROUTE_TOOL_DISABLED),
        tool_calls_present=True,
    )
    assert isinstance(decision.reason, str)
    assert decision.reason


def test_decision_includes_counter_kind_for_reliability_emit() -> None:
    decision = decide_dispatch_route(
        profile=_make_profile(route=ROUTE_NATIVE_TOOLS),
        tool_calls_present=True,
    )
    assert decision.counter_kind == COUNTER_PARSE_SUCCESS


def test_missing_profile_downgrades_safely() -> None:
    decision = decide_dispatch_route(
        profile=None,
        tool_calls_present=True,
    )
    assert decision.action == DOWNGRADE_TO_IN_BAND
    assert decision.counter_kind == COUNTER_REPAIR_USED


def test_unknown_route_downgrades_safely() -> None:
    profile = _make_profile(route=ROUTE_NATIVE_TOOLS)
    weird = ProviderCapabilityProfile(
        profile_id=profile.profile_id,
        endpoint_id=profile.endpoint_id,
        model_id=profile.model_id,
        generated_at=profile.generated_at,
        expires_at=profile.expires_at,
        probe_status=profile.probe_status,
        selected_route="weird_route_value",
        features=profile.features,
        observed=profile.observed,
        diagnostics=profile.diagnostics,
    )
    decision = decide_dispatch_route(
        profile=weird,
        tool_calls_present=True,
    )
    assert decision.action == DOWNGRADE_TO_IN_BAND
