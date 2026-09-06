"""Route policy — turn ``selected_route`` into a tool-dispatch decision.

The :func:`decide_dispatch_route` pure function is the single decision-maker
for tool dispatch in :mod:`sidecar.ai.routing.tool_loop`. It maps the
:class:`~sidecar.runtime.provider_capability_profile.ProviderCapabilityProfile`
recommendation plus runtime signals (tool-call presence, coerced
arguments, schema-roundtrip outcome) onto a :class:`RouteDecision` whose
``action`` field selects one of five dispatch branches.
"""

from __future__ import annotations

from dataclasses import dataclass

from sidecar.runtime.provider_capability_profile import (
    ROUTE_FAIL_CLOSED,
    ROUTE_IN_BAND_TOOLS,
    ROUTE_NATIVE_TOOLS,
    ROUTE_NO_REASONING,
    ROUTE_TOOL_DISABLED,
    ProviderCapabilityProfile,
)

DISPATCH_NATIVE = "dispatch_native"
DISPATCH_IN_BAND = "dispatch_in_band"
DOWNGRADE_TO_IN_BAND = "downgrade_to_in_band"
BLOCK_TOOL_DISABLED = "block_tool_disabled"
BLOCK_FAIL_CLOSED = "block_fail_closed"

# Counter kinds passed to
# :py:meth:`ProviderCapabilityProfileStore.record_tool_call_outcome`.
COUNTER_PARSE_SUCCESS = "parse_success"
COUNTER_PARSE_FAILURE = "parse_failure"
COUNTER_REPAIR_USED = "repair_used"
COUNTER_FALSE_POSITIVE = "false_positive"

# ---------------------------------------------------------------------------
# Public DTO
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RouteDecision:
    """Outcome of :func:`decide_dispatch_route`.

    ``route`` mirrors the input :class:`ProviderCapabilityProfile.selected_route`
    so the loop can record it for diagnostics; ``action`` selects the dispatch
    branch; ``reason`` is a short human-readable string for the audit trail
    (Phase 6 consumes it); ``counter_kind`` names the reliability counter to
    increment at the call site (``None`` for no-op).
    """

    route: str
    action: str
    reason: str | None = None
    counter_kind: str | None = None


# Sentinel returned when there are no tool calls and no in-band extraction is
# pending — the caller should not enter the dispatch branch at all.
_NO_DECISION = RouteDecision(
    route="",
    action="",
    reason="no_tool_calls",
    counter_kind=None,
)

_MISSING_PROFILE_DECISION = RouteDecision(
    route=ROUTE_IN_BAND_TOOLS,
    action=DOWNGRADE_TO_IN_BAND,
    reason="profile_missing",
    counter_kind=COUNTER_REPAIR_USED,
)

_NATIVE_SCHEMA_ROUNDTRIP_FAILED = RouteDecision(
    route=ROUTE_NATIVE_TOOLS,
    action=DOWNGRADE_TO_IN_BAND,
    reason="schema_roundtrip_failed",
    counter_kind=COUNTER_REPAIR_USED,
)

_NATIVE_COERCED_ARGUMENTS = RouteDecision(
    route=ROUTE_NATIVE_TOOLS,
    action=DOWNGRADE_TO_IN_BAND,
    reason="coerced_native_arguments",
    counter_kind=COUNTER_REPAIR_USED,
)

_NATIVE_DISPATCH = RouteDecision(
    route=ROUTE_NATIVE_TOOLS,
    action=DISPATCH_NATIVE,
    reason=None,
    counter_kind=COUNTER_PARSE_SUCCESS,
)

_UNKNOWN_ROUTE_DECISION = RouteDecision(
    route=ROUTE_IN_BAND_TOOLS,
    action=DOWNGRADE_TO_IN_BAND,
    reason="unknown_route",
    counter_kind=COUNTER_REPAIR_USED,
)

_SIMPLE_ROUTE_DECISIONS: dict[str, RouteDecision] = {
    ROUTE_IN_BAND_TOOLS: RouteDecision(
        route=ROUTE_IN_BAND_TOOLS,
        action=DISPATCH_IN_BAND,
        reason=None,
        counter_kind=COUNTER_PARSE_SUCCESS,
    ),
    ROUTE_TOOL_DISABLED: RouteDecision(
        route=ROUTE_TOOL_DISABLED,
        action=BLOCK_TOOL_DISABLED,
        reason="route_blocks_tool_dispatch",
        counter_kind=COUNTER_FALSE_POSITIVE,
    ),
    ROUTE_FAIL_CLOSED: RouteDecision(
        route=ROUTE_FAIL_CLOSED,
        action=BLOCK_FAIL_CLOSED,
        reason="route_fail_closed",
        counter_kind=COUNTER_PARSE_FAILURE,
    ),
    ROUTE_NO_REASONING: RouteDecision(
        route=ROUTE_NO_REASONING,
        action=DISPATCH_NATIVE,
        reason=None,
        counter_kind=COUNTER_PARSE_SUCCESS,
    ),
}


def _decide_native_route(
    *,
    coerced_arguments_present: bool,
    schema_roundtrip_passed: bool,
) -> RouteDecision:
    if not schema_roundtrip_passed:
        return _NATIVE_SCHEMA_ROUNDTRIP_FAILED
    if coerced_arguments_present:
        return _NATIVE_COERCED_ARGUMENTS
    return _NATIVE_DISPATCH


# ---------------------------------------------------------------------------
# Pure decision function
# ---------------------------------------------------------------------------


def decide_dispatch_route(
    *,
    profile: ProviderCapabilityProfile | None,
    tool_calls_present: bool,
    coerced_arguments_present: bool = False,
    schema_roundtrip_passed: bool = True,
) -> RouteDecision:
    """Turn ``profile.selected_route`` plus runtime signals into a dispatch action.

    Every row of the policy ladder in the Phase 5 plan is encoded here. The
    function is pure: same inputs always produce the same output. Defensive
    posture: an unknown profile or unknown route falls back to
    ``DOWNGRADE_TO_IN_BAND`` so a diagnostic-side error never blocks a turn.
    """
    if not tool_calls_present:
        return _NO_DECISION

    if profile is None:
        return _MISSING_PROFILE_DECISION

    selected_route = str(profile.selected_route or "").strip().lower()

    if selected_route == ROUTE_NATIVE_TOOLS:
        return _decide_native_route(
            coerced_arguments_present=coerced_arguments_present,
            schema_roundtrip_passed=schema_roundtrip_passed,
        )

    return _SIMPLE_ROUTE_DECISIONS.get(selected_route, _UNKNOWN_ROUTE_DECISION)


__all__ = [
    "BLOCK_FAIL_CLOSED",
    "BLOCK_TOOL_DISABLED",
    "COUNTER_FALSE_POSITIVE",
    "COUNTER_PARSE_FAILURE",
    "COUNTER_PARSE_SUCCESS",
    "COUNTER_REPAIR_USED",
    "DISPATCH_IN_BAND",
    "DISPATCH_NATIVE",
    "DOWNGRADE_TO_IN_BAND",
    "RouteDecision",
    "decide_dispatch_route",
]
