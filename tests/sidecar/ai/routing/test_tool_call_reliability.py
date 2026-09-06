"""Tests for the ``ai.router.tool_call_reliability`` event emitter.

Exercises :mod:`sidecar.ai.routing.tool_call_reliability` in isolation with a
seeded capability-profile store (the same fixture shape as
``test_route_policy_runtime.py`` — a bare kernel makes counter increments
silent no-ops by design, so every counter assertion seeds a profile).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any

import pytest

from sidecar.ai.routing.tool_call_reliability import (
    emit_tool_call_reliability_event,
)
from sidecar.ai.tools.tool_call_healing import (
    configure_tool_call_healing,
    drain_heal_telemetry,
    record_repair,
)
from sidecar.runtime.provider_capability_profile import (
    ROUTE_NATIVE_TOOLS,
    ProviderCapabilityDiagnostics,
    ProviderCapabilityFeatures,
    ProviderCapabilityObserved,
    ProviderCapabilityProfile,
    ProviderCapabilityProfileStore,
    derive_endpoint_id,
    derive_model_id,
    derive_profile_id,
)

RELIABILITY_EVENT = "ai.router.tool_call_reliability"


@dataclass
class _StubConfig:
    engine_type: str = "ollama"
    api_url: str | None = None
    model: str = "qwen"


@dataclass
class _StubEngine:
    _provider_capability_profile_store: ProviderCapabilityProfileStore | None = None
    tool_calling_source: str | None = None

    def _ensure_local_runtime_capability_sources(self) -> dict[str, str]:
        if self.tool_calling_source is None:
            raise RuntimeError("no capability sources")
        return {"tool_calling": self.tool_calling_source}


@dataclass
class _StubKernel:
    _config: _StubConfig = field(default_factory=_StubConfig)
    _engine: _StubEngine = field(default_factory=_StubEngine)


@pytest.fixture(autouse=True)
def _reset_healing_state():
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    drain_heal_telemetry()
    yield
    drain_heal_telemetry()
    configure_tool_call_healing(None)


def _make_kernel_with_profile(
    *,
    tool_calling_source: str | None = "native",
) -> tuple[_StubKernel, ProviderCapabilityProfileStore, str]:
    store = ProviderCapabilityProfileStore()
    endpoint_id = derive_endpoint_id("ollama", None)
    model_id = derive_model_id("qwen")
    profile_id = derive_profile_id(endpoint_id, model_id)
    profile = ProviderCapabilityProfile(
        profile_id=profile_id,
        endpoint_id=endpoint_id,
        model_id=model_id,
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
    )
    store._profiles[profile_id] = profile  # type: ignore[attr-defined]
    kernel = _StubKernel(
        _config=_StubConfig(),
        _engine=_StubEngine(
            _provider_capability_profile_store=store,
            tool_calling_source=tool_calling_source,
        ),
    )
    return kernel, store, profile_id


def test_heal_telemetry_counters_are_worker_local() -> None:
    barrier = threading.Barrier(2)
    results: dict[str, int] = {}

    def _worker(name: str, count: int) -> None:
        for _ in range(count):
            record_repair(("single_quotes",))
        barrier.wait(timeout=2.0)
        results[name] = drain_heal_telemetry()["repair_used"]

    first = threading.Thread(target=_worker, args=("first", 1))
    second = threading.Thread(target=_worker, args=("second", 3))
    first.start()
    second.start()
    first.join(timeout=3.0)
    second.join(timeout=3.0)

    assert results == {"first": 1, "second": 3}
    assert drain_heal_telemetry() == {"repair_used": 0}


def _seed_counters(store: ProviderCapabilityProfileStore, profile_id: str) -> None:
    """Seed parse_success ×3, parse_failure ×1 so well_formed_rate is checkable."""
    for _ in range(3):
        store.record_tool_call_outcome(profile_id=profile_id, kind="parse_success")
    store.record_tool_call_outcome(profile_id=profile_id, kind="parse_failure")


def _reliability_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if getattr(record, "event", "") == RELIABILITY_EVENT
    ]


class TestEventEmission:
    def test_emits_with_computed_rate_and_capability_source(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        kernel, store, profile_id = _make_kernel_with_profile(
            tool_calling_source="native"
        )
        _seed_counters(store, profile_id)
        # One drained repair joins the seeded counters: repair_used becomes 1.
        record_repair(("trailing_comma",))
        with caplog.at_level(logging.INFO):
            emit_tool_call_reliability_event(
                kernel=kernel, request_id="req_1", session_id="sess_1"
            )
        records = _reliability_records(caplog)
        assert len(records) == 1
        data = records[0].data  # type: ignore[attr-defined]
        assert data["tool_call_parse_success_count"] == 3
        assert data["tool_call_parse_failure_count"] == 1
        assert data["tool_call_repair_count"] == 1
        # (3 + 1) / (3 + 1 + 1) = 0.8
        assert data["well_formed_rate"] == 0.8
        assert data["tool_calling_capability_source"] == "native"

    def test_capability_source_shows_through_verbatim(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        # Any capability-source string the engine records is surfaced as-is.
        # (http_400_disabled is a legacy value: 400s now degrade per-request
        # without touching the capability sources.)
        kernel, _store, _profile_id = _make_kernel_with_profile(
            tool_calling_source="http_400_disabled"
        )
        with caplog.at_level(logging.INFO):
            emit_tool_call_reliability_event(
                kernel=kernel, request_id="req_2", session_id=None
            )
        records = _reliability_records(caplog)
        assert len(records) == 1
        data = records[0].data  # type: ignore[attr-defined]
        assert data["tool_calling_capability_source"] == "http_400_disabled"

    def test_missing_capability_sources_reports_unknown(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        kernel, _store, _profile_id = _make_kernel_with_profile(
            tool_calling_source=None
        )
        with caplog.at_level(logging.INFO):
            emit_tool_call_reliability_event(
                kernel=kernel, request_id="req_3", session_id=None
            )
        records = _reliability_records(caplog)
        assert len(records) == 1
        data = records[0].data  # type: ignore[attr-defined]
        assert data["tool_calling_capability_source"] == "unknown"


class TestDrainSemantics:
    def test_drained_repairs_route_into_profile_counter_and_reset(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        kernel, store, profile_id = _make_kernel_with_profile()
        for _ in range(3):
            record_repair(("single_quotes",))
        with caplog.at_level(logging.INFO):
            emit_tool_call_reliability_event(
                kernel=kernel, request_id="req_4", session_id=None
            )
        counters = store.get_reliability_counters(profile_id=profile_id)
        assert counters is not None
        assert counters.tool_call_repair_count == 3
        # Drained: a second emit routes nothing further.
        with caplog.at_level(logging.INFO):
            emit_tool_call_reliability_event(
                kernel=kernel, request_id="req_5", session_id=None
            )
        counters = store.get_reliability_counters(profile_id=profile_id)
        assert counters is not None
        assert counters.tool_call_repair_count == 3


class TestFlagOffAndDefensive:
    def test_flag_off_emits_nothing_and_increments_nothing(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        kernel, store, profile_id = _make_kernel_with_profile()
        configure_tool_call_healing(None)
        with caplog.at_level(logging.INFO):
            emit_tool_call_reliability_event(
                kernel=kernel, request_id="req_6", session_id=None
            )
        assert _reliability_records(caplog) == []
        counters = store.get_reliability_counters(profile_id=profile_id)
        assert counters is not None
        assert counters.tool_call_repair_count == 0

    def test_raising_profile_store_never_escapes(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        # get_profile succeeds (so resolve_capability_profile's own guard does
        # not neutralize the store early); the counters read then raises inside
        # the emitter, which must swallow it — no exception, no event.
        @dataclass
        class _StubProfile:
            profile_id: str = "boom@profile"

        class _BoomStore:
            def get_profile(self, _profile_id: str) -> Any:
                return _StubProfile()

            def reliability_counters_for_profile(self, **_kwargs: Any) -> dict:
                raise RuntimeError("store boom")

        kernel, _store, _profile_id = _make_kernel_with_profile()
        kernel._engine._provider_capability_profile_store = _BoomStore()  # type: ignore[assignment]
        with caplog.at_level(logging.INFO):
            emit_tool_call_reliability_event(
                kernel=kernel, request_id="req_7", session_id=None
            )
        # No exception escaped; no event emitted (the read failed mid-way).
        assert _reliability_records(caplog) == []

    def test_bare_kernel_is_a_silent_noop(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        class _Bare:
            pass

        with caplog.at_level(logging.INFO):
            emit_tool_call_reliability_event(
                kernel=_Bare(), request_id="req_8", session_id=None
            )
        # Emits with empty counters or not at all — either way, no crash. With
        # no counted parses the rate must be None (a fake 0.0 would make "no
        # data" indistinguishable from "everything fails").
        records = _reliability_records(caplog)
        if records:
            data = records[0].data  # type: ignore[attr-defined]
            assert data["well_formed_rate"] is None
