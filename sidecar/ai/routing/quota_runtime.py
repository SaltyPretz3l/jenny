"""Keep one quota owner across resumptions of a logical request."""

from __future__ import annotations

from typing import Any

from sidecar.ai.feature_flags import is_resource_discipline_enabled
from sidecar.ai.routing.tool_quota_state import (
    decode_quota_state,
    encode_quota_state,
    normalize_quota_state,
    quota_policy_state,
)
from sidecar.ai.routing.tool_quotas import ToolQuotaRegistry, policy_from_config
from sidecar.runtime.cooldowns import CooldownRegistry


def initialize_runtime_quota(
    runtime: Any, config: Any, *, enabled: bool, request_context: Any = None
) -> Any:
    previous = getattr(runtime, "quota_discipline_enabled", None)
    if previous is not None and previous != enabled:
        raise ValueError("quota_discipline_changed")
    registry = getattr(runtime, "quota_registry", None)
    policy = policy_from_config(config)
    if registry is not None and registry.policy != policy:
        raise ValueError("quota_policy_changed")
    if enabled and registry is None:
        if previous is True:
            raise ValueError("quota_owner_unavailable")
        registry = ToolQuotaRegistry(
            policy,
            session_tool_call_count=getattr(
                request_context
                if request_context is not None
                else getattr(runtime, "request_context", None),
                "session_tool_call_count",
                0,
            ),
        )
    runtime.quota_registry = registry
    runtime.quota_discipline_enabled = enabled
    return registry


def settle_quota_outcomes(runtime: Any, outcomes: Any, *, tool_contract: Any) -> None:
    registry = getattr(runtime, "quota_registry", None)
    if registry is not None:
        for outcome in outcomes:
            registry.refund_web_call_for_outcome(outcome, tool_contract=tool_contract)


def freeze_runtime_quota(
    runtime: Any, config: Any, *, outcomes: Any = (), tool_contract: Any = None
) -> bytes | None:
    enabled = getattr(runtime, "quota_discipline_enabled", None)
    if enabled is None:
        return None  # Legacy/synthetic runtimes do not acquire invented admission proof.
    settle_quota_outcomes(runtime, outcomes, tool_contract=tool_contract)
    if enabled:
        return encode_quota_state(runtime.quota_registry.snapshot())
    return encode_quota_state(
        {
            "schema_version": 1,
            "enabled": False,
            "policy": quota_policy_state(policy_from_config(config)),
            "session_baseline": 0,
            "admissions": [],
            "cooldowns": CooldownRegistry().export_tool_quota(),
        }
    )


def restore_runtime_quota(runtime: Any, config: Any, value: Any) -> None:
    state = decode_quota_state(value) if isinstance(value, bytes) else normalize_quota_state(value)
    enabled = is_resource_discipline_enabled(getattr(config, "feature_flags", None))
    policy = policy_from_config(config)
    if state["enabled"] != enabled or state["policy"] != quota_policy_state(policy):
        raise ValueError("quota_policy_changed")
    registry = ToolQuotaRegistry.from_snapshot(state, policy=policy) if enabled else None
    runtime.quota_registry = registry
    runtime.quota_discipline_enabled = enabled
