from __future__ import annotations

import pytest

from sidecar.runtime.provider_capability_profile import (
    PROBE_STATUS_DEGRADED,
    PROBE_STATUS_EXPIRED,
    PROBE_STATUS_FAILED,
    PROBE_STATUS_READY,
    PROFILE_EXPIRY_SECONDS,
    ROUTE_FAIL_CLOSED,
    ROUTE_IN_BAND_TOOLS,
    ROUTE_NATIVE_TOOLS,
    ROUTE_NO_REASONING,
    ProviderCapabilityDiagnostics,
    ProviderCapabilityFeatures,
    ProviderCapabilityObserved,
    ProviderCapabilityProfileStore,
    compute_selected_route,
    derive_endpoint_id,
    derive_model_id,
    derive_profile_id,
    provider_capability_profiles_payload,
)


def _ready_features(**overrides: bool) -> ProviderCapabilityFeatures:
    base = {
        "chat_supported": True,
        "streaming_supported": True,
        "native_tools_supported": True,
    }
    base.update(overrides)
    return ProviderCapabilityFeatures(**base)


def test_endpoint_id_derivation_with_api_url() -> None:
    assert (
        derive_endpoint_id("ollama", "http://localhost:11434")
        == "ollama@http://localhost:11434"
    )


def test_endpoint_id_derivation_without_api_url() -> None:
    assert derive_endpoint_id("mock", None) == "mock"
    assert derive_endpoint_id("mock", "") == "mock"


def test_endpoint_id_normalizes_url_case_and_trailing_slash() -> None:
    assert (
        derive_endpoint_id("vLLM", "HTTP://Localhost:8000/")
        == "vllm@http://localhost:8000"
    )


def test_endpoint_id_strips_userinfo_segment() -> None:
    assert (
        derive_endpoint_id("openai-compatible", "https://user:secret@api.example.com/v1")
        == "openai-compatible@https://api.example.com/v1"
    )


def test_model_id_derivation_handles_empty_model() -> None:
    assert derive_model_id(None) == "unknown"
    assert derive_model_id("") == "unknown"
    assert derive_model_id("   ") == "unknown"
    assert derive_model_id("qwen2.5-coder:14b") == "qwen2.5-coder:14b"


def test_profile_id_concatenation() -> None:
    assert derive_profile_id("ollama@http://localhost:11434", "qwen2.5:14b") == (
        "ollama@http://localhost:11434::qwen2.5:14b"
    )


def test_record_probe_result_creates_profile() -> None:
    store = ProviderCapabilityProfileStore()
    profile = store.record_probe_result(
        endpoint_id="ollama@http://localhost:11434",
        model_id="qwen2.5:14b",
        features=_ready_features(),
        observed=ProviderCapabilityObserved(max_context_advertised=32768),
        probe_status=PROBE_STATUS_READY,
        now=1700000000.0,
    )
    assert profile.profile_id == "ollama@http://localhost:11434::qwen2.5:14b"
    assert profile.probe_status == PROBE_STATUS_READY
    assert profile.selected_route == ROUTE_NATIVE_TOOLS
    assert profile.observed.max_context_advertised == 32768
    fetched = store.get_profile(profile.profile_id, monotonic_now=1700000000.0)
    assert fetched is not None
    assert fetched.profile_id == profile.profile_id


def test_record_probe_result_overwrites_existing_for_same_profile_id() -> None:
    store = ProviderCapabilityProfileStore()
    store.record_probe_result(
        endpoint_id="ollama@http://localhost:11434",
        model_id="qwen2.5:14b",
        features=_ready_features(),
        observed=ProviderCapabilityObserved(max_context_advertised=8192),
        probe_status=PROBE_STATUS_READY,
        now=1.0,
    )
    second = store.record_probe_result(
        endpoint_id="ollama@http://localhost:11434",
        model_id="qwen2.5:14b",
        features=_ready_features(native_tools_supported=False),
        observed=ProviderCapabilityObserved(max_context_advertised=32768),
        probe_status=PROBE_STATUS_READY,
        now=2.0,
    )
    profiles = store.all_profiles(monotonic_now=2.0)
    assert len(profiles) == 1
    assert profiles[0].observed.max_context_advertised == 32768
    assert profiles[0].selected_route == ROUTE_IN_BAND_TOOLS
    assert profiles[0].profile_id == second.profile_id


def test_mark_failed_sets_status_and_conservative_route() -> None:
    store = ProviderCapabilityProfileStore()
    profile = store.mark_failed(
        endpoint_id="vllm@http://localhost:8000",
        model_id="meta-llama/Llama-2-7b-hf",
        reason="endpoint unreachable",
        now=10.0,
    )
    assert profile.probe_status == PROBE_STATUS_FAILED
    assert profile.selected_route == ROUTE_IN_BAND_TOOLS
    assert profile.diagnostics.reason == "endpoint unreachable"


def test_get_profile_returns_expired_status_after_ttl() -> None:
    store = ProviderCapabilityProfileStore(expiry_seconds=300)
    profile = store.record_probe_result(
        endpoint_id="ollama@http://localhost:11434",
        model_id="qwen2.5:14b",
        features=_ready_features(),
        observed=ProviderCapabilityObserved(),
        probe_status=PROBE_STATUS_READY,
        now=0.0,
    )
    assert profile.selected_route == ROUTE_NATIVE_TOOLS
    refreshed = store.get_profile(profile.profile_id, monotonic_now=400.0)
    assert refreshed is not None
    assert refreshed.probe_status == PROBE_STATUS_EXPIRED
    assert refreshed.selected_route == ROUTE_IN_BAND_TOOLS


def test_get_profile_returns_none_for_unknown_id() -> None:
    store = ProviderCapabilityProfileStore()
    assert store.get_profile("never-recorded::nope") is None


def test_all_profiles_returns_list_in_stable_order() -> None:
    store = ProviderCapabilityProfileStore()
    store.record_probe_result(
        endpoint_id="ollama@http://localhost:11434",
        model_id="zeta",
        features=_ready_features(),
        observed=ProviderCapabilityObserved(),
        now=1.0,
    )
    store.record_probe_result(
        endpoint_id="ollama@http://localhost:11434",
        model_id="alpha",
        features=_ready_features(),
        observed=ProviderCapabilityObserved(),
        now=1.0,
    )
    store.record_probe_result(
        endpoint_id="vllm@http://localhost:8000",
        model_id="beta",
        features=_ready_features(),
        observed=ProviderCapabilityObserved(),
        now=1.0,
    )
    profile_ids = [profile.profile_id for profile in store.all_profiles(monotonic_now=1.0)]
    assert profile_ids == sorted(profile_ids)


@pytest.mark.parametrize(
    "probe_status,features,expected",
    [
        (PROBE_STATUS_FAILED, {"chat_supported": True, "streaming_supported": True}, ROUTE_IN_BAND_TOOLS),
        (PROBE_STATUS_EXPIRED, {"chat_supported": True}, ROUTE_IN_BAND_TOOLS),
        (
            PROBE_STATUS_DEGRADED,
            {"chat_supported": True, "streaming_supported": True},
            ROUTE_IN_BAND_TOOLS,
        ),
        (
            PROBE_STATUS_DEGRADED,
            {"chat_supported": True, "streaming_supported": False},
            ROUTE_FAIL_CLOSED,
        ),
        (
            PROBE_STATUS_DEGRADED,
            {"chat_supported": False, "streaming_supported": True},
            ROUTE_FAIL_CLOSED,
        ),
        (PROBE_STATUS_READY, {"chat_supported": False}, ROUTE_FAIL_CLOSED),
        (
            PROBE_STATUS_READY,
            {"chat_supported": True, "streaming_supported": False},
            ROUTE_NO_REASONING,
        ),
        (
            PROBE_STATUS_READY,
            {
                "chat_supported": True,
                "streaming_supported": True,
                "native_tools_supported": True,
            },
            ROUTE_NATIVE_TOOLS,
        ),
        (
            PROBE_STATUS_READY,
            {
                "chat_supported": True,
                "streaming_supported": True,
                "native_tools_supported": False,
            },
            ROUTE_IN_BAND_TOOLS,
        ),
    ],
)
def test_compute_selected_route_full_matrix(
    probe_status: str, features: dict, expected: str
) -> None:
    assert compute_selected_route(probe_status=probe_status, features=features) == expected


def test_compute_selected_route_accepts_features_dataclass() -> None:
    features = ProviderCapabilityFeatures(
        chat_supported=True,
        streaming_supported=True,
        native_tools_supported=True,
    )
    assert (
        compute_selected_route(probe_status=PROBE_STATUS_READY, features=features)
        == ROUTE_NATIVE_TOOLS
    )


def test_payload_shape_matches_spec() -> None:
    store = ProviderCapabilityProfileStore()
    profile = store.record_probe_result(
        endpoint_id="ollama@http://localhost:11434",
        model_id="qwen2.5:14b",
        features=ProviderCapabilityFeatures(
            chat_supported=True,
            streaming_supported=True,
            native_tools_supported=True,
            thinking_or_reasoning_supported=True,
        ),
        observed=ProviderCapabilityObserved(max_context_advertised=32768),
        diagnostics=ProviderCapabilityDiagnostics(),
        probe_status=PROBE_STATUS_READY,
        now=1700000000.0,
    )
    payload = profile.to_payload()
    assert set(payload.keys()) == {
        "profile_id",
        "endpoint_id",
        "model_id",
        "generated_at",
        "expires_at",
        "probe_status",
        "selected_route",
        "features",
        "observed",
        "diagnostics",
        "reliability_counters",
        "roundtrip",
    }
    assert set(payload["features"].keys()) == {
        "chat_supported",
        "alternate_response_api_supported",
        "streaming_supported",
        "native_tools_supported",
        "parallel_tool_calls_supported",
        "thinking_or_reasoning_supported",
        "content_null_between_deltas_seen",
    }
    assert set(payload["observed"].keys()) == {
        "tool_call_delta_shape",
        "max_context_advertised",
        "observed_first_token_latency_ms",
        "observed_tool_call_latency_ms",
    }
    assert set(payload["diagnostics"].keys()) == {"reason", "last_error_code"}
    assert payload["generated_at"].endswith("Z")
    assert payload["expires_at"].endswith("Z")
    assert payload["selected_route"] == ROUTE_NATIVE_TOOLS


def test_payload_excludes_internal_monotonic_field() -> None:
    store = ProviderCapabilityProfileStore()
    profile = store.record_probe_result(
        endpoint_id="ollama",
        model_id="qwen2.5:14b",
        features=_ready_features(),
        observed=ProviderCapabilityObserved(),
        now=1.0,
    )
    payload = profile.to_payload()
    assert "_generated_at_monotonic" not in payload
    for key in payload:
        assert not key.startswith("_")


def test_provider_capability_profiles_payload_returns_empty_for_none() -> None:
    assert provider_capability_profiles_payload(None) == []


def test_provider_capability_profiles_payload_returns_list_for_populated_store() -> None:
    store = ProviderCapabilityProfileStore()
    store.record_probe_result(
        endpoint_id="ollama@http://localhost:11434",
        model_id="qwen2.5:14b",
        features=_ready_features(),
        observed=ProviderCapabilityObserved(),
        now=1.0,
    )
    payload = provider_capability_profiles_payload(store, monotonic_now=1.0)
    assert isinstance(payload, list)
    assert len(payload) == 1
    assert payload[0]["profile_id"] == "ollama@http://localhost:11434::qwen2.5:14b"


def test_module_constants_match_spec_values() -> None:
    assert PROFILE_EXPIRY_SECONDS == 300
    assert PROBE_STATUS_READY == "ready"
    assert PROBE_STATUS_DEGRADED == "degraded"
    assert PROBE_STATUS_FAILED == "failed"
    assert PROBE_STATUS_EXPIRED == "expired"
    assert ROUTE_NATIVE_TOOLS == "native_tools"
    assert ROUTE_IN_BAND_TOOLS == "in_band_tools"
    assert ROUTE_NO_REASONING == "no_reasoning"
    assert ROUTE_FAIL_CLOSED == "fail_closed"


def test_new_module_does_not_import_http_libraries() -> None:
    """Phase 2 invariant: zero new HTTP traffic from the profile module."""
    import sidecar.runtime.provider_capability_profile as module

    source = module.__loader__.get_source("sidecar.runtime.provider_capability_profile")
    assert source is not None
    forbidden = ["import httpx", "import urllib", "import requests", "import socket"]
    for needle in forbidden:
        assert needle not in source, f"Forbidden HTTP import found: {needle!r}"


# ---------------------------------------------------------------------------
# Phase 5: reliability counters + schema-roundtrip persistence
# ---------------------------------------------------------------------------


def _seed_ready_profile(store: ProviderCapabilityProfileStore) -> str:
    profile = store.record_probe_result(
        endpoint_id="ollama@http://localhost:11434",
        model_id="qwen2.5:14b",
        features=_ready_features(),
        observed=ProviderCapabilityObserved(),
    )
    return profile.profile_id


def test_record_tool_call_outcome_increments_correct_counter() -> None:
    store = ProviderCapabilityProfileStore()
    profile_id = _seed_ready_profile(store)

    counters = store.record_tool_call_outcome(profile_id=profile_id, kind="parse_success")
    assert counters is not None
    assert counters.tool_call_parse_success_count == 1

    counters = store.record_tool_call_outcome(profile_id=profile_id, kind="repair_used")
    assert counters is not None
    assert counters.tool_call_repair_count == 1
    # Earlier counter survives.
    assert counters.tool_call_parse_success_count == 1

    counters = store.record_tool_call_outcome(profile_id=profile_id, kind="false_positive")
    assert counters is not None
    assert counters.false_tool_positive_count == 1


def test_record_tool_call_outcome_with_unknown_kind_is_no_op() -> None:
    store = ProviderCapabilityProfileStore()
    profile_id = _seed_ready_profile(store)

    assert (
        store.record_tool_call_outcome(profile_id=profile_id, kind="not_a_real_kind")
        is None
    )
    # Existing counters are unchanged.
    snapshot = store.get_reliability_counters(profile_id=profile_id)
    assert snapshot is not None
    assert snapshot.tool_call_parse_success_count == 0
    assert snapshot.tool_call_repair_count == 0


def test_record_tool_call_outcome_unknown_profile_returns_none() -> None:
    store = ProviderCapabilityProfileStore()
    assert (
        store.record_tool_call_outcome(profile_id="missing", kind="parse_success")
        is None
    )


def test_record_schema_roundtrip_result_stores_on_profile() -> None:
    from sidecar.ai.tools.schema_roundtrip import RoundtripResult

    store = ProviderCapabilityProfileStore()
    profile_id = _seed_ready_profile(store)

    result = RoundtripResult(
        passed=True,
        provider="ollama",
        mismatched_tools=(),
        reason=None,
    )
    assert store.record_schema_roundtrip_result(profile_id=profile_id, result=result)

    stored = store.get_profile(profile_id)
    assert stored is not None
    assert stored.roundtrip is not None
    assert stored.roundtrip.passed is True
    assert stored.roundtrip.provider == "ollama"


def test_record_schema_roundtrip_result_unknown_profile_returns_false() -> None:
    from sidecar.ai.tools.schema_roundtrip import RoundtripResult

    store = ProviderCapabilityProfileStore()
    result = RoundtripResult(passed=True, provider="ollama")
    assert (
        store.record_schema_roundtrip_result(profile_id="missing", result=result)
        is False
    )


def test_reliability_counters_appear_in_payload() -> None:
    store = ProviderCapabilityProfileStore()
    profile_id = _seed_ready_profile(store)

    store.record_tool_call_outcome(profile_id=profile_id, kind="parse_success")
    store.record_tool_call_outcome(profile_id=profile_id, kind="repair_used")

    payload = provider_capability_profiles_payload(store)
    assert payload, "expected at least one profile in payload"
    counters = payload[0].get("reliability_counters")
    assert isinstance(counters, dict)
    assert counters["tool_call_parse_success_count"] == 1
    assert counters["tool_call_repair_count"] == 1
    assert counters["turns_with_tool_count"] == 0


def test_roundtrip_appears_in_payload() -> None:
    from sidecar.ai.tools.schema_roundtrip import RoundtripResult

    store = ProviderCapabilityProfileStore()
    profile_id = _seed_ready_profile(store)

    store.record_schema_roundtrip_result(
        profile_id=profile_id,
        result=RoundtripResult(
            passed=False,
            provider="ollama",
            mismatched_tools=("read_file",),
            reason="parsed_schema_mismatch",
        ),
    )

    payload = provider_capability_profiles_payload(store)
    assert payload
    roundtrip = payload[0].get("roundtrip")
    assert isinstance(roundtrip, dict)
    assert roundtrip["passed"] is False
    assert roundtrip["mismatched_tools"] == ["read_file"]
    assert roundtrip["reason"] == "parsed_schema_mismatch"


def test_payload_roundtrip_is_null_when_unrecorded() -> None:
    store = ProviderCapabilityProfileStore()
    _seed_ready_profile(store)

    payload = provider_capability_profiles_payload(store)
    assert payload
    assert payload[0].get("roundtrip") is None


def test_get_reliability_counters_returns_current_snapshot() -> None:
    store = ProviderCapabilityProfileStore()
    profile_id = _seed_ready_profile(store)

    snapshot = store.get_reliability_counters(profile_id=profile_id)
    assert snapshot is not None
    assert snapshot.tool_call_parse_success_count == 0

    store.record_tool_call_outcome(profile_id=profile_id, kind="parse_success")
    refreshed = store.get_reliability_counters(profile_id=profile_id)
    assert refreshed is not None
    assert refreshed.tool_call_parse_success_count == 1
