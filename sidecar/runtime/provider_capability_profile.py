"""Per-(endpoint, model) provider capability profiles.

Profiles are populated from already-detected engine state, exposed through
``initialize`` and ``harness.inspect``, and retain reliability counters plus
schema-roundtrip results. This module performs no HTTP traffic.
"""

from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Mapping

if TYPE_CHECKING:  # pragma: no cover — import only for type annotations.
    from sidecar.ai.tools.schema_roundtrip import RoundtripResult

PROFILE_EXPIRY_SECONDS = 300

PROBE_STATUS_READY = "ready"
PROBE_STATUS_DEGRADED = "degraded"
PROBE_STATUS_FAILED = "failed"
PROBE_STATUS_EXPIRED = "expired"

ROUTE_NATIVE_TOOLS = "native_tools"
ROUTE_IN_BAND_TOOLS = "in_band_tools"
ROUTE_TOOL_DISABLED = "tool_disabled"
ROUTE_NO_REASONING = "no_reasoning"
ROUTE_FAIL_CLOSED = "fail_closed"


@dataclass(frozen=True)
class ProviderCapabilityFeatures:
    chat_supported: bool = False
    alternate_response_api_supported: bool = False
    streaming_supported: bool = False
    native_tools_supported: bool = False
    parallel_tool_calls_supported: bool = False
    thinking_or_reasoning_supported: bool = False
    content_null_between_deltas_seen: bool = False


@dataclass(frozen=True)
class ProviderCapabilityObserved:
    tool_call_delta_shape: str = "unknown"
    max_context_advertised: int | None = None
    observed_first_token_latency_ms: int | None = None
    observed_tool_call_latency_ms: int | None = None


@dataclass(frozen=True)
class ProviderCapabilityDiagnostics:
    reason: str | None = None
    last_error_code: str | None = None


@dataclass(frozen=True)
class ReliabilityCounters:
    """Monotonic per-profile raw counters for lossless rate derivation."""

    tool_call_parse_success_count: int = 0
    tool_call_parse_failure_count: int = 0
    tool_call_repair_count: int = 0
    false_tool_positive_count: int = 0
    tool_argument_validation_failures: int = 0
    tool_execution_retries: int = 0
    final_answer_after_tool_count: int = 0
    turns_with_tool_count: int = 0

    def to_payload(self) -> dict[str, Any]:
        return asdict(self)


# Maps the public ``kind`` string accepted by ``record_tool_call_outcome``
# onto the :class:`ReliabilityCounters` field that should be incremented.
# Unknown kinds are silently ignored (no-op) so future call sites can be
# rolled out without breaking the store contract.
_COUNTER_KIND_TO_FIELD: dict[str, str] = {
    "parse_success": "tool_call_parse_success_count",
    "parse_failure": "tool_call_parse_failure_count",
    "repair_used": "tool_call_repair_count",
    "false_positive": "false_tool_positive_count",
    "validation_failure": "tool_argument_validation_failures",
    "execution_retry": "tool_execution_retries",
    "final_answer_after_tool": "final_answer_after_tool_count",
    "turn_with_tool": "turns_with_tool_count",
}

_CONSERVATIVE_ROUTE_STATUSES = frozenset({PROBE_STATUS_FAILED, PROBE_STATUS_EXPIRED})


@dataclass(frozen=True)
class ProviderCapabilityProfile:
    profile_id: str
    endpoint_id: str
    model_id: str
    generated_at: str
    expires_at: str
    probe_status: str
    selected_route: str
    features: ProviderCapabilityFeatures = field(default_factory=ProviderCapabilityFeatures)
    observed: ProviderCapabilityObserved = field(default_factory=ProviderCapabilityObserved)
    diagnostics: ProviderCapabilityDiagnostics = field(
        default_factory=ProviderCapabilityDiagnostics
    )
    reliability_counters: ReliabilityCounters = field(default_factory=ReliabilityCounters)
    roundtrip: "RoundtripResult | None" = None
    _generated_at_monotonic: float = 0.0

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "profile_id": self.profile_id,
            "endpoint_id": self.endpoint_id,
            "model_id": self.model_id,
            "generated_at": self.generated_at,
            "expires_at": self.expires_at,
            "probe_status": self.probe_status,
            "selected_route": self.selected_route,
            "features": asdict(self.features),
            "observed": asdict(self.observed),
            "diagnostics": asdict(self.diagnostics),
            "reliability_counters": self.reliability_counters.to_payload(),
        }
        if self.roundtrip is not None:
            payload["roundtrip"] = {
                "passed": bool(self.roundtrip.passed),
                "provider": str(self.roundtrip.provider or ""),
                "mismatched_tools": list(self.roundtrip.mismatched_tools or ()),
                "reason": self.roundtrip.reason,
            }
        else:
            payload["roundtrip"] = None
        return payload


def derive_endpoint_id(engine_type: str, api_url: str | None) -> str:
    normalized_engine = str(engine_type or "").strip().lower() or "unknown"
    raw_url = str(api_url or "").strip()
    if not raw_url:
        return normalized_engine
    return f"{normalized_engine}@{_normalize_endpoint_url(raw_url)}"


def _normalize_endpoint_url(raw: str) -> str:
    text = raw.strip()
    if not text:
        return text
    scheme, sep, rest = text.partition("://")
    if not sep:
        return text.rstrip("/")
    scheme = scheme.lower()
    host_segment, slash, tail = rest.partition("/")
    if "@" in host_segment:
        host_segment = host_segment.split("@", 1)[1]
    host_segment = host_segment.lower()
    rebuilt = f"{scheme}://{host_segment}"
    if slash:
        rebuilt = f"{rebuilt}/{tail}"
    return rebuilt.rstrip("/")


def derive_model_id(model: str | None) -> str:
    text = str(model or "").strip()
    return text or "unknown"


def derive_profile_id(endpoint_id: str, model_id: str) -> str:
    return f"{endpoint_id}::{model_id}"


def _feature_flags(
    features: Mapping[str, bool] | ProviderCapabilityFeatures,
) -> Mapping[str, Any]:
    if isinstance(features, ProviderCapabilityFeatures):
        return asdict(features)
    if isinstance(features, Mapping):
        return features
    return {}


def _degraded_route(flags: Mapping[str, Any]) -> str:
    if flags.get("chat_supported") and flags.get("streaming_supported"):
        return ROUTE_IN_BAND_TOOLS
    return ROUTE_FAIL_CLOSED


def compute_selected_route(
    *,
    probe_status: str,
    features: Mapping[str, bool] | ProviderCapabilityFeatures,
) -> str:
    flags = _feature_flags(features)
    status = str(probe_status or "").strip().lower()
    route = ROUTE_IN_BAND_TOOLS
    if status in _CONSERVATIVE_ROUTE_STATUSES:
        route = ROUTE_IN_BAND_TOOLS
    elif status == PROBE_STATUS_DEGRADED:
        route = _degraded_route(flags)
    elif not flags.get("chat_supported"):
        route = ROUTE_FAIL_CLOSED
    elif not flags.get("streaming_supported"):
        route = ROUTE_NO_REASONING
    elif flags.get("native_tools_supported"):
        route = ROUTE_NATIVE_TOOLS
    return route


def _isoformat_utc(timestamp: float) -> str:
    return (
        datetime.fromtimestamp(timestamp, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class ProviderCapabilityProfileStore:
    """Thread-safe in-memory store of (endpoint, model) capability profiles."""

    def __init__(self, *, expiry_seconds: int = PROFILE_EXPIRY_SECONDS) -> None:
        self._lock = threading.Lock()
        self._profiles: dict[str, ProviderCapabilityProfile] = {}
        self._expiry_seconds = max(int(expiry_seconds), 1)

    def record_probe_result(  # noqa: PLR0913 - keyword DTO-style store API.
        self,
        *,
        endpoint_id: str,
        model_id: str,
        features: ProviderCapabilityFeatures,
        observed: ProviderCapabilityObserved,
        diagnostics: ProviderCapabilityDiagnostics | None = None,
        probe_status: str = PROBE_STATUS_READY,
        now: float | None = None,
    ) -> ProviderCapabilityProfile:
        normalized_endpoint = str(endpoint_id or "").strip() or "unknown"
        normalized_model = derive_model_id(model_id)
        profile_id = derive_profile_id(normalized_endpoint, normalized_model)
        if now is None:
            wall_now = time.time()
            monotonic_now = time.monotonic()
        else:
            wall_now = now
            monotonic_now = now
        normalized_status = str(probe_status or "").strip().lower() or PROBE_STATUS_READY
        diagnostics_value = diagnostics or ProviderCapabilityDiagnostics()
        selected_route = compute_selected_route(
            probe_status=normalized_status,
            features=features,
        )
        profile = ProviderCapabilityProfile(
            profile_id=profile_id,
            endpoint_id=normalized_endpoint,
            model_id=normalized_model,
            generated_at=_isoformat_utc(wall_now),
            expires_at=_isoformat_utc(wall_now + self._expiry_seconds),
            probe_status=normalized_status,
            selected_route=selected_route,
            features=features,
            observed=observed,
            diagnostics=diagnostics_value,
            _generated_at_monotonic=monotonic_now,
        )
        with self._lock:
            self._profiles[profile_id] = profile
        return profile

    def mark_failed(
        self,
        *,
        endpoint_id: str,
        model_id: str,
        reason: str | None = None,
        last_error_code: str | None = None,
        now: float | None = None,
    ) -> ProviderCapabilityProfile:
        return self.record_probe_result(
            endpoint_id=endpoint_id,
            model_id=model_id,
            features=ProviderCapabilityFeatures(),
            observed=ProviderCapabilityObserved(),
            diagnostics=ProviderCapabilityDiagnostics(
                reason=str(reason)[:200] if reason is not None else None,
                last_error_code=last_error_code,
            ),
            probe_status=PROBE_STATUS_FAILED,
            now=now,
        )

    def get_profile(
        self,
        profile_id: str,
        *,
        monotonic_now: float | None = None,
    ) -> ProviderCapabilityProfile | None:
        with self._lock:
            stored = self._profiles.get(profile_id)
        if stored is None:
            return None
        return self._with_expiry_applied(stored, monotonic_now=monotonic_now)

    def all_profiles(
        self,
        *,
        monotonic_now: float | None = None,
    ) -> list[ProviderCapabilityProfile]:
        with self._lock:
            stored = list(self._profiles.values())
        ordered = sorted(stored, key=lambda profile: profile.profile_id)
        evaluated_now = time.monotonic() if monotonic_now is None else monotonic_now
        return [
            self._with_expiry_applied(profile, monotonic_now=evaluated_now)
            for profile in ordered
        ]

    # Reliability and schema-roundtrip state

    def record_tool_call_outcome(
        self,
        *,
        profile_id: str,
        kind: str,
    ) -> ReliabilityCounters | None:
        """Increment one reliability counter on the named profile.

        ``kind`` is one of the eight string constants exported by
        :mod:`sidecar.ai.routing.route_policy`. Returns the updated counters,
        or ``None`` when the profile_id is unknown or the kind is unknown.
        Unknown ``kind`` values silently no-op so future call sites can be
        rolled out without breaking the store.
        """
        field_name = _COUNTER_KIND_TO_FIELD.get(kind)
        if field_name is None:
            return None
        with self._lock:
            stored = self._profiles.get(profile_id)
            if stored is None:
                return None
            current = stored.reliability_counters
            updated_counters = replace(
                current,
                **{field_name: getattr(current, field_name) + 1},
            )
            self._profiles[profile_id] = replace(
                stored, reliability_counters=updated_counters
            )
        return updated_counters

    def record_schema_roundtrip_result(
        self,
        *,
        profile_id: str,
        result: "RoundtripResult",
    ) -> bool:
        """Persist a :class:`RoundtripResult` against the named profile.

        Returns True when the profile existed and was updated, False
        otherwise. Defensive: a missing profile is a no-op rather than an
        error so the routing layer never fails a turn for a diagnostic side
        effect.
        """
        with self._lock:
            stored = self._profiles.get(profile_id)
            if stored is None:
                return False
            self._profiles[profile_id] = replace(stored, roundtrip=result)
        return True

    def get_reliability_counters(
        self,
        *,
        profile_id: str,
    ) -> ReliabilityCounters | None:
        with self._lock:
            stored = self._profiles.get(profile_id)
        return stored.reliability_counters if stored is not None else None

    def reliability_counters_for_profile(
        self,
        *,
        profile_id: str,
    ) -> dict[str, Any]:
        counters = self.get_reliability_counters(profile_id=profile_id)
        if counters is None:
            return {}
        return counters.to_payload()

    def _with_expiry_applied(
        self,
        profile: ProviderCapabilityProfile,
        *,
        monotonic_now: float | None,
    ) -> ProviderCapabilityProfile:
        now = time.monotonic() if monotonic_now is None else monotonic_now
        elapsed = now - profile._generated_at_monotonic
        if elapsed <= self._expiry_seconds:
            return profile
        return replace(
            profile,
            probe_status=PROBE_STATUS_EXPIRED,
            selected_route=compute_selected_route(
                probe_status=PROBE_STATUS_EXPIRED,
                features=profile.features,
            ),
        )


def provider_capability_profiles_payload(
    store: ProviderCapabilityProfileStore | None,
    *,
    monotonic_now: float | None = None,
) -> list[dict[str, Any]]:
    if store is None:
        return []
    try:
        profiles = store.all_profiles(monotonic_now=monotonic_now)
    except Exception:  # noqa: BLE001
        return []
    return [profile.to_payload() for profile in profiles]
