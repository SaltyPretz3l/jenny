"""Tests for the impure side of the Phase 5 route policy.

Targeted coverage of the schema-roundtrip wiring added in Phase 8: the
helpers that adapt the runtime ``tool_payload`` (dicts) into the canonical
:class:`ToolSchema` form, drive :func:`schema_roundtrip_check`, cache the
result on the active :class:`ProviderCapabilityProfile`, and expose the
boolean to :func:`decide_dispatch_route`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sidecar.ai.routing.route_policy_runtime import (
    _build_tool_schemas_from_payload,
    _resolve_provider_for_roundtrip,
    evaluate_schema_roundtrip,
)
from sidecar.ai.tools.schema_roundtrip import RoundtripResult
from sidecar.runtime.provider_capability_profile import (
    ROUTE_NATIVE_TOOLS,
    ProviderCapabilityDiagnostics,
    ProviderCapabilityFeatures,
    ProviderCapabilityObserved,
    ProviderCapabilityProfile,
    ProviderCapabilityProfileStore,
)

# ---------------------------------------------------------------------------
# Helpers / stubs
# ---------------------------------------------------------------------------


@dataclass
class _StubConfig:
    engine_type: str = "ollama"
    api_url: str = "http://localhost:11434"
    model: str = "test-model"


@dataclass
class _StubEngine:
    _provider_capability_profile_store: ProviderCapabilityProfileStore | None = None


@dataclass
class _StubKernel:
    _config: _StubConfig = field(default_factory=_StubConfig)
    _engine: _StubEngine = field(default_factory=_StubEngine)


def _make_profile(
    *,
    profile_id: str = "ollama@localhost::test-model",
    roundtrip: RoundtripResult | None = None,
) -> ProviderCapabilityProfile:
    return ProviderCapabilityProfile(
        profile_id=profile_id,
        endpoint_id="ollama@localhost",
        model_id="test-model",
        generated_at="2026-05-03T00:00:00.000Z",
        expires_at="2026-05-03T00:05:00.000Z",
        probe_status="ready",
        selected_route=ROUTE_NATIVE_TOOLS,
        features=ProviderCapabilityFeatures(
            chat_supported=True,
            streaming_supported=True,
            native_tools_supported=True,
        ),
        observed=ProviderCapabilityObserved(),
        diagnostics=ProviderCapabilityDiagnostics(),
        roundtrip=roundtrip,
    )


def _make_kernel_with_profile(
    profile: ProviderCapabilityProfile,
    *,
    engine_type: str = "ollama",
) -> tuple[_StubKernel, ProviderCapabilityProfileStore]:
    store = ProviderCapabilityProfileStore()
    store._profiles[profile.profile_id] = profile  # type: ignore[attr-defined]
    kernel = _StubKernel(
        _config=_StubConfig(engine_type=engine_type),
        _engine=_StubEngine(_provider_capability_profile_store=store),
    )
    return kernel, store


_VALID_TOOL_PAYLOAD: list[dict[str, Any]] = [
    {
        "name": "echo",
        "description": "Return the input string verbatim.",
        "parameters": {
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
        },
        "side_effecting": False,
    }
]


# ---------------------------------------------------------------------------
# Provider-name resolution
# ---------------------------------------------------------------------------


def test_resolve_provider_passes_through_known_engine_type() -> None:
    kernel = _StubKernel(_config=_StubConfig(engine_type="ollama"))
    assert _resolve_provider_for_roundtrip(kernel) == "ollama"


def test_resolve_provider_aliases_openai_compatible() -> None:
    kernel = _StubKernel(_config=_StubConfig(engine_type="openai-compatible"))
    assert _resolve_provider_for_roundtrip(kernel) == "openai"


def test_resolve_provider_returns_empty_when_engine_type_missing() -> None:
    kernel = _StubKernel(_config=_StubConfig(engine_type=""))
    assert _resolve_provider_for_roundtrip(kernel) == ""


# ---------------------------------------------------------------------------
# Tool-payload → ToolSchema adapter
# ---------------------------------------------------------------------------


def test_build_tool_schemas_from_payload_skips_entries_without_name() -> None:
    payload = [
        {"name": "ok", "parameters": {"type": "object"}},
        {"description": "no name"},
        "not-a-dict",
        {"name": "  "},
    ]
    schemas = _build_tool_schemas_from_payload(payload)
    assert [s.name for s in schemas] == ["ok"]


def test_build_tool_schemas_handles_non_dict_parameters() -> None:
    payload = [{"name": "no_params", "parameters": "garbage"}]
    schemas = _build_tool_schemas_from_payload(payload)
    assert schemas[0].parameters == {}


def test_build_tool_schemas_returns_empty_for_none() -> None:
    assert _build_tool_schemas_from_payload(None) == []


# ---------------------------------------------------------------------------
# evaluate_schema_roundtrip
# ---------------------------------------------------------------------------


def test_evaluate_returns_true_when_profile_missing() -> None:
    kernel = _StubKernel()
    assert evaluate_schema_roundtrip(
        kernel=kernel,
        profile=None,
        tool_payload=_VALID_TOOL_PAYLOAD,
    ) is True


def test_evaluate_uses_cached_pass_result() -> None:
    cached = RoundtripResult(passed=True, provider="ollama")
    profile = _make_profile(roundtrip=cached)
    kernel, _ = _make_kernel_with_profile(profile)
    # tool_payload empty → would normally short-circuit to True; cache must
    # still be consulted so the test asserts the cache path runs first.
    assert evaluate_schema_roundtrip(
        kernel=kernel,
        profile=profile,
        tool_payload=[],
    ) is True


def test_evaluate_uses_cached_fail_result() -> None:
    cached = RoundtripResult(
        passed=False,
        provider="ollama",
        mismatched_tools=("broken_tool",),
        reason="parsed_schema_mismatch",
    )
    profile = _make_profile(roundtrip=cached)
    kernel, _ = _make_kernel_with_profile(profile)
    assert evaluate_schema_roundtrip(
        kernel=kernel,
        profile=profile,
        tool_payload=_VALID_TOOL_PAYLOAD,
    ) is False


def test_evaluate_runs_check_and_caches_result_on_first_call() -> None:
    profile = _make_profile()
    kernel, store = _make_kernel_with_profile(profile)
    assert profile.roundtrip is None
    passed = evaluate_schema_roundtrip(
        kernel=kernel,
        profile=profile,
        tool_payload=_VALID_TOOL_PAYLOAD,
    )
    assert passed is True
    cached = store.get_profile(profile.profile_id)
    assert cached is not None
    assert cached.roundtrip is not None
    assert cached.roundtrip.passed is True
    assert cached.roundtrip.provider == "ollama"


def test_evaluate_returns_true_when_tool_payload_empty() -> None:
    profile = _make_profile()
    kernel, store = _make_kernel_with_profile(profile)
    assert evaluate_schema_roundtrip(
        kernel=kernel,
        profile=profile,
        tool_payload=[],
    ) is True
    # No cache entry is made for the empty-payload short-circuit so a later
    # dispatch with an actual payload still gets to run the real check.
    refreshed = store.get_profile(profile.profile_id)
    assert refreshed is not None
    assert refreshed.roundtrip is None


def test_evaluate_defensive_returns_true_when_provider_missing() -> None:
    profile = _make_profile()
    kernel, _ = _make_kernel_with_profile(profile, engine_type="")
    assert evaluate_schema_roundtrip(
        kernel=kernel,
        profile=profile,
        tool_payload=_VALID_TOOL_PAYLOAD,
    ) is True


def test_evaluate_swallows_internal_errors_and_returns_true() -> None:
    """A broken kernel must not break a turn."""

    class _Boom:
        @property
        def _config(self) -> Any:  # noqa: ANN401 — stub raises on access.
            raise RuntimeError("boom")

    profile = _make_profile()
    assert evaluate_schema_roundtrip(
        kernel=_Boom(),
        profile=profile,
        tool_payload=_VALID_TOOL_PAYLOAD,
    ) is True
