"""Per-turn and per-session tool quota helpers."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from sidecar.ai.routing.iteration_limits import (
    effective_max_tool_calls_per_session,
    effective_max_web_tool_calls_per_turn,
)
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.tool_families import tool_family_for_status
from sidecar.runtime.cooldowns import CooldownRegistry

TOOL_QUOTA_COOLDOWN_NAMESPACE = "tool_quota"
DEFAULT_TOOL_COOLDOWN_SECONDS = 30.0
# Fail-open ceiling for the per-session cap. Raised from 1_000 to admit the
# cloud loop profile's 2_000 (config parsing bounds cloud_max_tool_calls_per_session
# by the same number, so the two ceilings cannot drift into a silent fail-open
# back to 200). Local config parsing still clamps its own key at 1_000, so the
# local profile's behavior is unchanged.
_MAX_SESSION_TOOL_CALL_CEILING = 2_000


@dataclass(frozen=True)
class ToolQuotaPolicy:
    max_web_tool_calls_per_turn: int = 10
    max_code_intelligence_tool_calls_per_turn: int = 16
    max_tool_calls_per_session: int = 200
    tool_cooldown_seconds: float = DEFAULT_TOOL_COOLDOWN_SECONDS

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "max_web_tool_calls_per_turn",
            _bounded_int(self.max_web_tool_calls_per_turn, default=10, max_value=100),
        )
        object.__setattr__(
            self,
            "max_code_intelligence_tool_calls_per_turn",
            _bounded_int(
                self.max_code_intelligence_tool_calls_per_turn,
                default=16,
                max_value=100,
            ),
        )
        object.__setattr__(
            self,
            "max_tool_calls_per_session",
            _bounded_int(
                self.max_tool_calls_per_session,
                default=200,
                max_value=_MAX_SESSION_TOOL_CALL_CEILING,
            ),
        )
        object.__setattr__(
            self,
            "tool_cooldown_seconds",
            _bounded_float(
                self.tool_cooldown_seconds,
                default=DEFAULT_TOOL_COOLDOWN_SECONDS,
            ),
        )


@dataclass(frozen=True)
class BlockedToolCall:
    call: ToolCallRequest
    reason: str
    metadata: dict[str, object]


@dataclass(frozen=True)
class ToolQuotaDecision:
    allowed: tuple[ToolCallRequest, ...]
    blocked: tuple[BlockedToolCall, ...]


@dataclass(frozen=True)
class _ToolCallClassification:
    web_or_browser: bool
    code_intelligence: bool


@dataclass
class ToolQuotaRegistry:
    policy: ToolQuotaPolicy = field(default_factory=ToolQuotaPolicy)
    session_tool_call_count: int = 0
    cooldown_registry: CooldownRegistry = field(default_factory=CooldownRegistry)
    _web_calls: int = 0
    _code_intelligence_calls: int = 0

    def filter_calls(
        self,
        calls: tuple[ToolCallRequest, ...] | list[ToolCallRequest],
        *,
        tool_contract: Any | None,
    ) -> ToolQuotaDecision:
        allowed: list[ToolCallRequest] = []
        blocked: list[BlockedToolCall] = []
        for call in calls:
            classification = _classify_call(call, tool_contract=tool_contract)
            blocked_call = self._blocked_call(call, classification=classification)
            if blocked_call is not None:
                blocked.append(blocked_call)
                if blocked_call.reason != "tool_cooldown":
                    self.cooldown_registry.mark(
                        TOOL_QUOTA_COOLDOWN_NAMESPACE,
                        call.tool_id,
                        duration_seconds=self.policy.tool_cooldown_seconds,
                        reason=blocked_call.reason,
                    )
                continue
            allowed.append(call)
            self._record_allowed(classification=classification)
        return ToolQuotaDecision(allowed=tuple(allowed), blocked=tuple(blocked))

    def _blocked_call(
        self,
        call: ToolCallRequest,
        *,
        classification: _ToolCallClassification,
    ) -> BlockedToolCall | None:
        cooldown = self.cooldown_registry.status(TOOL_QUOTA_COOLDOWN_NAMESPACE, call.tool_id)
        if cooldown.active:
            return _blocked(
                call,
                quota_scope="tool_cooldown",
                cap=1,
                used=1,
                metadata={
                    "code_intelligence": classification.code_intelligence,
                    "cooldown_remaining_seconds": cooldown.remaining_seconds,
                },
            )
        if self.session_tool_call_count >= self.policy.max_tool_calls_per_session:
            return _blocked(
                call,
                quota_scope="session_tool_budget",
                cap=self.policy.max_tool_calls_per_session,
                used=self.session_tool_call_count,
                metadata={
                    "code_intelligence": classification.code_intelligence,
                },
            )
        if (
            classification.web_or_browser
            and self._web_calls >= self.policy.max_web_tool_calls_per_turn
        ):
            return _blocked(
                call,
                quota_scope="web_per_turn",
                cap=self.policy.max_web_tool_calls_per_turn,
                used=self._web_calls,
                metadata={
                    "code_intelligence": classification.code_intelligence,
                },
            )
        if (
            classification.code_intelligence
            and self._code_intelligence_calls
            >= self.policy.max_code_intelligence_tool_calls_per_turn
        ):
            return _blocked(
                call,
                quota_scope="code_intelligence_per_turn",
                cap=self.policy.max_code_intelligence_tool_calls_per_turn,
                used=self._code_intelligence_calls,
                metadata={
                    "code_intelligence": True,
                },
            )
        return None

    def _record_allowed(self, *, classification: _ToolCallClassification) -> None:
        self.session_tool_call_count += 1
        if classification.web_or_browser:
            self._web_calls += 1
        if classification.code_intelligence:
            self._code_intelligence_calls += 1

    def refund_web_call(
        self,
        call: ToolCallRequest,
        *,
        tool_contract: Any | None,
    ) -> bool:
        """Release one unit of the per-turn web budget for a failed web/browser call.

        The budget is consumed up-front in ``filter_calls`` before the tool runs, so a
        web/browser call that then fails (HTTP error, timeout, validation/SSRF rejection)
        would otherwise permanently burn a slot. Refunding on failure makes the per-turn
        ``web_per_turn`` cap count only *successful* web work. Deliberately does NOT refund
        ``session_tool_call_count`` — the per-session budget is the coarse runaway-loop
        breaker and must stay attempt-based. Never drops ``_web_calls`` below zero.
        """
        if not is_web_or_browser_call(call, tool_contract=tool_contract):
            return False
        if self._web_calls <= 0:
            return False
        self._web_calls -= 1
        if self._web_calls < self.policy.max_web_tool_calls_per_turn:
            cooldown = self.cooldown_registry.status(
                TOOL_QUOTA_COOLDOWN_NAMESPACE,
                call.tool_id,
            )
            if cooldown.active and cooldown.reason == "web_per_turn":
                self.cooldown_registry.clear(TOOL_QUOTA_COOLDOWN_NAMESPACE, call.tool_id)
        return True

    def refund_web_call_for_outcome(
        self,
        outcome: Any,
        *,
        tool_contract: Any | None,
    ) -> bool:
        """Refund the per-turn web budget for a failed execution outcome.

        Classifies by ``outcome.tool_name`` using the same ``tool_contract`` the filter
        used, so the web/browser verdict is identical to the one that consumed the slot.
        """
        probe = ToolCallRequest(
            tool_id=str(getattr(outcome, "tool_name", "") or ""),
            arguments={},
            call_id=str(getattr(outcome, "call_id", "") or ""),
        )
        return self.refund_web_call(probe, tool_contract=tool_contract)


def policy_from_config(config: Any) -> ToolQuotaPolicy:
    return ToolQuotaPolicy(
        # Web + session quotas follow the engine-keyed loop profile; the
        # The code-intelligence cap is profile-independent.
        max_web_tool_calls_per_turn=effective_max_web_tool_calls_per_turn(config),
        max_code_intelligence_tool_calls_per_turn=getattr(
            config,
            "max_code_intelligence_tool_calls_per_turn",
            16,
        ),
        max_tool_calls_per_session=effective_max_tool_calls_per_session(config),
        tool_cooldown_seconds=DEFAULT_TOOL_COOLDOWN_SECONDS,
    )


def is_web_or_browser_call(call: ToolCallRequest, *, tool_contract: Any | None) -> bool:
    return _classify_call(call, tool_contract=tool_contract).web_or_browser


def _classify_call(
    call: ToolCallRequest,
    *,
    tool_contract: Any | None,
) -> _ToolCallClassification:
    tool_id = str(call.tool_id or "").strip().lower()
    descriptor = _tool_descriptor(call, tool_contract=tool_contract)
    family = tool_family_for_status(
        name=tool_id,
        tool_family=str(getattr(descriptor, "tool_family", "") or ""),
    )
    return _ToolCallClassification(
        web_or_browser=family in {"web", "browser"} or "browser" in tool_id,
        code_intelligence=family == "code_intelligence",
    )


def _tool_descriptor(call: ToolCallRequest, *, tool_contract: Any | None) -> Any | None:
    if tool_contract is not None and hasattr(tool_contract, "entry"):
        entry = tool_contract.entry(call.tool_id)
        return getattr(entry, "descriptor", None) if entry is not None else None
    return None


def count_session_tool_results(messages: list[dict[str, object]] | None) -> int:
    count = 0
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        if message.get("kind") == "tool_result" and isinstance(message.get("tool_result"), dict):
            count += 1
            continue
        if message.get("role") == "tool":
            count += 1
    return count


def _blocked(
    call: ToolCallRequest,
    *,
    quota_scope: str,
    cap: int,
    used: int,
    metadata: dict[str, object],
) -> BlockedToolCall:
    next_metadata: dict[str, object] = {
        "quota_scope": quota_scope,
        "cap": cap,
        "used": used,
        **metadata,
    }
    return BlockedToolCall(
        call=call,
        reason=quota_scope,
        metadata=next_metadata,
    )


def _bounded_int(
    value: Any,
    *,
    default: int,
    max_value: int,
    min_value: int = 1,
) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    if parsed < min_value or parsed > max_value:
        return default
    return parsed


def _bounded_float(
    value: Any,
    *,
    default: float,
    min_value: float = 0.0,
) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return parsed if math.isfinite(parsed) and parsed >= min_value else default
