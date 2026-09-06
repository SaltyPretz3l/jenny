"""Tests for the reflexive tool-call retry decision layer (sibling of the loop).

These exercise :mod:`sidecar.ai.routing.tool_call_retry` in isolation — no
``run_tool_loop`` — mirroring the flag-cache reset fixture from
``tests/sidecar/ai/tools/test_tool_call_healing.py`` (kept local; not imported
across test files).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.routing import tool_call_retry
from sidecar.ai.routing.tool_call_retry import (
    RetryDecision,
    apply_reflexive_retry,
    build_corrective_message,
    evaluate_reflexive_retry,
    native_tools_active_for_kernel,
)
from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing
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

KNOWN_TOOLS = frozenset({"grep_search", "read_file"})
TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    "grep_search": {
        "type": "object",
        "properties": {"pattern": {"type": "string"}},
        "required": ["pattern"],
    },
    "read_file": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
}


@pytest.fixture(autouse=True)
def _reset_healing_cache():
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    yield
    configure_tool_call_healing(None)


# ---------------------------------------------------------------------------
# Trigger A — unparseable intent
# ---------------------------------------------------------------------------


class TestTriggerA:
    def test_intent_without_surviving_calls_retries(self) -> None:
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(),
            known_tool_names=KNOWN_TOOLS,
            tool_schemas=TOOL_SCHEMAS,
            already_retried=False,
            native_tools_active=False,
        )
        assert decision.should_retry is True
        assert decision.corrective_message is not None
        assert decision.corrective_message["role"] == "user"
        body = decision.corrective_message["content"]
        assert "<tool_call>" in body
        assert '{"name": "TOOL_NAME", "arguments": {"param": "value"}}' in body
        assert "grep_search" in body
        assert "read_file" in body
        assert decision.trigger == "unparseable_intent"

    def test_native_tools_ignore_inband_parse_failure(self) -> None:
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(),
            known_tool_names=KNOWN_TOOLS,
            tool_schemas=TOOL_SCHEMAS,
            already_retried=False,
            native_tools_active=True,
        )
        assert decision.should_retry is False
        assert decision.response_format is None

    def test_native_posture_prefers_public_engine_capability(self) -> None:
        class _PublicInbandEngine:
            supports_tool_calling = False

        kernel = type("Kernel", (), {"_engine": _PublicInbandEngine()})()

        assert native_tools_active_for_kernel(kernel) is False

    def test_response_format_schema_when_native_tools_inactive(self) -> None:
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(),
            known_tool_names=KNOWN_TOOLS,
            tool_schemas=TOOL_SCHEMAS,
            already_retried=False,
            native_tools_active=False,
        )
        assert decision.should_retry is True
        assert decision.trigger == "unparseable_intent"
        assert isinstance(decision.response_format, ResponseFormat)
        assert decision.response_format.type == "json_object"
        schema = decision.response_format.json_schema
        assert schema is not None
        name_enum = set(schema["properties"]["name"]["enum"])
        assert name_enum == set(KNOWN_TOOLS)
        assert schema["required"] == ["name", "arguments"]
        # Trigger A has no rejected tool, so arguments is the generic object.
        assert schema["properties"]["arguments"] == {"type": "object"}

    def test_prose_mentioning_tool_does_not_retry(self) -> None:
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=False,
            surviving_calls=(),
            validation_errors=(),
            known_tool_names=KNOWN_TOOLS,
            tool_schemas=TOOL_SCHEMAS,
            already_retried=False,
            native_tools_active=True,
        )
        assert decision.should_retry is False


# ---------------------------------------------------------------------------
# Trigger B — validation rejection
# ---------------------------------------------------------------------------


class TestTriggerB:
    def test_validation_error_retries_with_verbatim_text_and_schema(self) -> None:
        verbatim = "arguments.pattern: field required (this exact text)"
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=False,
            surviving_calls=(),
            validation_errors=(
                {"tool_name": "grep_search", "validation_error": verbatim},
            ),
            known_tool_names=KNOWN_TOOLS,
            tool_schemas=TOOL_SCHEMAS,
            already_retried=False,
            native_tools_active=True,
        )
        assert decision.should_retry is True
        assert decision.trigger == "validation_rejection"
        body = decision.corrective_message["content"]
        assert verbatim in body
        # The tool's full parameters schema JSON appears (a required key from it).
        assert '"pattern"' in body
        assert '"required"' in body
        assert "<tool_call>" in body

    def test_response_format_arguments_uses_rejected_tool_schema(self) -> None:
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=False,
            surviving_calls=(),
            validation_errors=(
                {"tool_name": "grep_search", "validation_error": "bad"},
            ),
            known_tool_names=KNOWN_TOOLS,
            tool_schemas=TOOL_SCHEMAS,
            already_retried=False,
            native_tools_active=False,
        )
        assert isinstance(decision.response_format, ResponseFormat)
        schema = decision.response_format.json_schema
        assert schema is not None
        assert schema["properties"]["arguments"] == TOOL_SCHEMAS["grep_search"]

    def test_trigger_b_wins_over_a_when_both_present(self) -> None:
        # Failed in-band evidence also exists, but validation takes precedence.
        verbatim = "arguments.pattern: field required"
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(
                {"tool_name": "grep_search", "validation_error": verbatim},
            ),
            known_tool_names=KNOWN_TOOLS,
            tool_schemas=TOOL_SCHEMAS,
            already_retried=False,
            native_tools_active=False,
        )
        assert decision.should_retry is True
        # Trigger B precedence: verbatim validation text present in message.
        assert verbatim in decision.corrective_message["content"]
        schema = decision.response_format.json_schema
        assert schema["properties"]["arguments"] == TOOL_SCHEMAS["grep_search"]


# ---------------------------------------------------------------------------
# Refusal conditions
# ---------------------------------------------------------------------------


class TestRefusals:
    def test_already_retried_never_retries(self) -> None:
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(
                {"tool_name": "grep_search", "validation_error": "bad"},
            ),
            known_tool_names=KNOWN_TOOLS,
            tool_schemas=TOOL_SCHEMAS,
            already_retried=True,
            native_tools_active=True,
        )
        assert decision.should_retry is False

    def test_no_intent_no_errors_never_retries(self) -> None:
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=False,
            surviving_calls=(),
            validation_errors=(),
            known_tool_names=KNOWN_TOOLS,
            tool_schemas=TOOL_SCHEMAS,
            already_retried=False,
            native_tools_active=True,
        )
        assert decision.should_retry is False

    def test_empty_known_tool_names_never_retries(self) -> None:
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(),
            known_tool_names=frozenset(),
            tool_schemas={},
            already_retried=False,
            native_tools_active=True,
        )
        assert decision.should_retry is False

    def test_flag_off_never_retries(self) -> None:
        configure_tool_call_healing({"tool_call_reliability_net_enabled": False})
        decision = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(
                {"tool_name": "grep_search", "validation_error": "bad"},
            ),
            known_tool_names=KNOWN_TOOLS,
            tool_schemas=TOOL_SCHEMAS,
            already_retried=False,
            native_tools_active=False,
        )
        assert decision.should_retry is False


# ---------------------------------------------------------------------------
# build_corrective_message
# ---------------------------------------------------------------------------


class TestBuildCorrectiveMessage:
    def test_includes_envelope_and_error_text(self) -> None:
        message = build_corrective_message(
            error_text="something went wrong",
            tool_schema=None,
        )
        assert message["role"] == "user"
        assert "something went wrong" in message["content"]
        assert "<tool_call>" in message["content"]

    def test_includes_schema_json_when_present(self) -> None:
        message = build_corrective_message(
            error_text="bad args",
            tool_schema=TOOL_SCHEMAS["read_file"],
        )
        assert '"path"' in message["content"]


# ---------------------------------------------------------------------------
# apply_reflexive_retry (impure helper)
# ---------------------------------------------------------------------------


@dataclass
class _StubConfig:
    engine_type: str = "ollama"
    api_url: str | None = None
    model: str = "qwen"


@dataclass
class _StubEngine:
    _provider_capability_profile_store: ProviderCapabilityProfileStore | None = None
    supports_tool_calling: bool = False


@dataclass
class _StubKernel:
    _config: _StubConfig = field(default_factory=_StubConfig)
    _engine: _StubEngine = field(default_factory=_StubEngine)


def _make_kernel_with_profile() -> tuple[_StubKernel, ProviderCapabilityProfileStore, str]:
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
        _engine=_StubEngine(_provider_capability_profile_store=store),
    )
    return kernel, store, profile_id


class TestApplyReflexiveRetry:
    def test_appends_one_message_and_increments_counter(self) -> None:
        kernel, store, profile_id = _make_kernel_with_profile()
        decision = RetryDecision(
            should_retry=True,
            corrective_message={"role": "user", "content": "fix your call"},
            response_format=None,
        )
        working: list[dict[str, Any]] = []
        applied = apply_reflexive_retry(
            kernel=kernel,
            decision=decision,
            working_messages=working,
            request_id="req_x",
            session_id="sess_x",
        )
        assert applied is True
        assert working == [{"role": "user", "content": "fix your call"}]
        counters = store.get_reliability_counters(profile_id=profile_id)
        assert counters is not None
        assert counters.tool_execution_retries == 1

    def test_internal_exception_swallowed_returns_false(self) -> None:
        # A working-messages sink whose append raises must be swallowed and
        # reported as no-retry so the turn is never failed by a state error.
        class _BoomList(list):
            def append(self, _item: Any) -> None:  # type: ignore[override]
                raise RuntimeError("boom")

        kernel, _store, _profile_id = _make_kernel_with_profile()
        decision = RetryDecision(
            should_retry=True,
            corrective_message={"role": "user", "content": "fix your call"},
            response_format=None,
        )
        applied = apply_reflexive_retry(
            kernel=kernel,
            decision=decision,
            working_messages=_BoomList(),
            request_id="req_x",
            session_id="sess_x",
        )
        assert applied is False

    @pytest.mark.parametrize("failing_diagnostic", ["increment_counter_for_kernel", "log_event"])
    def test_successful_append_survives_diagnostic_failure(
        self,
        monkeypatch: pytest.MonkeyPatch,
        failing_diagnostic: str,
    ) -> None:
        def _fail(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("diagnostic sink failed")

        monkeypatch.setattr(tool_call_retry, failing_diagnostic, _fail)
        decision = RetryDecision(
            should_retry=True,
            corrective_message={"role": "user", "content": "repair"},
            response_format=None,
            trigger="validation_rejection",
        )
        working: list[dict[str, Any]] = []

        applied = apply_reflexive_retry(
            kernel=object(),
            decision=decision,
            working_messages=working,
            request_id="req_diagnostic_failure",
            session_id="session_diagnostic_failure",
        )

        assert applied is True
        assert working == [{"role": "user", "content": "repair"}]


class TestParseFailureCounting:
    """Trigger-A telemetry: parse_failure counts independently of the retry."""

    def test_intent_without_calls_counts_parse_failure_once(self) -> None:
        from sidecar.ai.routing.tool_call_retry import run_reflexive_retry

        kernel, store, profile_id = _make_kernel_with_profile()
        tool_payload = [
            {"name": "grep_search", "parameters": TOOL_SCHEMAS["grep_search"]},
            {"name": "read_file", "parameters": TOOL_SCHEMAS["read_file"]},
        ]
        applied, _fmt = run_reflexive_retry(
            kernel=kernel,
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(),
            tool_payload=tool_payload,
            working_messages=[],
            already_retried=False,
            request_id="req_pf",
            session_id=None,
        )
        assert applied is True
        counters = store.get_reliability_counters(profile_id=profile_id)
        assert counters is not None
        assert counters.tool_call_parse_failure_count == 1

    def test_parse_failure_counts_even_when_already_retried(self) -> None:
        from sidecar.ai.routing.tool_call_retry import run_reflexive_retry

        kernel, store, profile_id = _make_kernel_with_profile()
        tool_payload = [
            {"name": "grep_search", "parameters": TOOL_SCHEMAS["grep_search"]},
        ]
        applied, _fmt = run_reflexive_retry(
            kernel=kernel,
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(),
            tool_payload=tool_payload,
            working_messages=[],
            already_retried=True,
            request_id="req_pf2",
            session_id=None,
        )
        assert applied is False
        counters = store.get_reliability_counters(profile_id=profile_id)
        assert counters is not None
        assert counters.tool_call_parse_failure_count == 1

    def test_plain_text_content_counts_nothing(self) -> None:
        from sidecar.ai.routing.tool_call_retry import run_reflexive_retry

        kernel, store, profile_id = _make_kernel_with_profile()
        applied, _fmt = run_reflexive_retry(
            kernel=kernel,
            inband_tool_call_parse_failed=False,
            surviving_calls=(),
            validation_errors=(),
            tool_payload=[{"name": "grep_search", "parameters": {}}],
            working_messages=[],
            already_retried=False,
            request_id="req_pf3",
            session_id=None,
        )
        assert applied is False
        counters = store.get_reliability_counters(profile_id=profile_id)
        assert counters is not None
        assert counters.tool_call_parse_failure_count == 0

    def test_parse_signal_without_known_tools_counts_nothing(self) -> None:
        from sidecar.ai.routing.tool_call_retry import run_reflexive_retry

        kernel, store, profile_id = _make_kernel_with_profile()
        applied, _fmt = run_reflexive_retry(
            kernel=kernel,
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(),
            tool_payload=[],
            working_messages=[],
            already_retried=False,
            request_id="req_no_tools_pf",
            session_id=None,
        )

        assert applied is False
        counters = store.get_reliability_counters(profile_id=profile_id)
        assert counters is not None
        assert counters.tool_call_parse_failure_count == 0

    def test_native_engine_parse_signal_counts_nothing(self) -> None:
        from sidecar.ai.routing.tool_call_retry import run_reflexive_retry

        kernel, store, profile_id = _make_kernel_with_profile()
        kernel._engine.supports_tool_calling = True

        applied, _fmt = run_reflexive_retry(
            kernel=kernel,
            inband_tool_call_parse_failed=True,
            surviving_calls=(),
            validation_errors=(),
            tool_payload=[{"name": "grep_search", "parameters": {}}],
            working_messages=[],
            already_retried=False,
            request_id="req_native_pf",
            session_id=None,
        )

        assert applied is False
        counters = store.get_reliability_counters(profile_id=profile_id)
        assert counters is not None
        assert counters.tool_call_parse_failure_count == 0
