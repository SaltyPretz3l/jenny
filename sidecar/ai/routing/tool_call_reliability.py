"""Reliability observability for the tool-call net.

Emits the per-turn ``ai.router.tool_call_reliability`` structured log event —
the owner-facing surface for the v1 headline metric (≥98% well-formed tool
calls post-heal). The event carries the cumulative per-profile reliability
counters (this module is the first consumer of
``ProviderCapabilityProfileStore.reliability_counters_for_profile``), the
derived ``well_formed_rate`` (``None`` until any parse/repair/failure has been
counted — a fake ``0.0`` on an empty profile would make "no data" and
"everything fails" indistinguishable), and the engine's
``tool_calling_capability_source``. ``parse_success`` is counted once per
tool-bearing generation at the tool-loop seam; HTTP-400 rejections fall back
per-request in the engine and no longer flip a session capability flag.

Before reading the counters, the emitter drains the heal-telemetry accumulator
(``tool_call_healing.drain_heal_telemetry``) and routes each tallied repair into
the per-profile ``repair_used`` counter — the heal seams (in-band parser,
native-args coercion) have no kernel access, so this is where their successes
reach the profile store.

Defensive posture (mirrors ``route_policy_runtime``): every path swallows
internal errors — a diagnostic-side failure never fails a turn. The whole
module is flag-gated on ``is_healing_enabled()`` and does nothing when the
reliability net is off.
"""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.routing import route_policy_runtime as _route_policy_runtime
from sidecar.ai.tools.tool_call_healing import drain_heal_telemetry, is_healing_enabled
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)


def _capability_source(kernel: Any) -> str:
    """Best-effort read of the engine's tool-calling capability source."""
    try:
        sources = kernel._engine._ensure_local_runtime_capability_sources()
        return str(sources.get("tool_calling") or "unknown")
    except Exception:  # noqa: BLE001 — diagnostic-only.
        return "unknown"


def _route_drained_repairs_to_profile(kernel: Any) -> None:
    """Drain the heal accumulator into the per-profile ``repair_used`` counter."""
    counts = drain_heal_telemetry()
    repair_count = int(counts.get("repair_used", 0) or 0)
    for _ in range(repair_count):
        _route_policy_runtime.increment_counter_for_kernel(kernel, "repair_used")


def _counters_payload(kernel: Any) -> dict[str, Any]:
    """Best-effort cumulative counters for the kernel's active profile."""
    profile = _route_policy_runtime.resolve_capability_profile(kernel)
    if profile is None:
        return {}
    store = _route_policy_runtime._resolve_store(kernel)
    if store is None:
        return {}
    payload = store.reliability_counters_for_profile(profile_id=profile.profile_id)
    return payload if isinstance(payload, dict) else {}


def emit_tool_call_reliability_event(
    *,
    kernel: Any,
    request_id: str,
    session_id: str | None,
) -> None:
    """Emit the per-turn reliability event (no-op when the net is off).

    Swallows every internal error: observability must never fail a turn.
    """
    if not is_healing_enabled():
        return
    try:
        _route_drained_repairs_to_profile(kernel)
        payload = _counters_payload(kernel)
        parse_success = int(payload.get("tool_call_parse_success_count", 0) or 0)
        repair_used = int(payload.get("tool_call_repair_count", 0) or 0)
        parse_failure = int(payload.get("tool_call_parse_failure_count", 0) or 0)
        denominator = parse_success + repair_used + parse_failure
        well_formed_rate = (
            round((parse_success + repair_used) / denominator, 4) if denominator else None
        )
        log_event(
            logger,
            logging.INFO,
            component="ai.router",
            event="ai.router.tool_call_reliability",
            message="Tool-call reliability counters for the active provider profile.",
            status="ok",
            data={
                **payload,
                "well_formed_rate": well_formed_rate,
                "tool_calling_capability_source": _capability_source(kernel),
                "session_id": session_id,
            },
            request_id=request_id,
        )
    except Exception:  # noqa: BLE001 — diagnostic-only; never fail a turn.
        pass
