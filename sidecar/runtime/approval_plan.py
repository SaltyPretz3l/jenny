"""Sidecar-owned approval-plan types, fingerprints, and in-memory cache."""

from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from typing import Any

from sidecar.ai.context.messages import resolve_personality_rendered
from sidecar.runtime import approval_plan_cache as _approval_plan_cache

ApprovalPlanCache = _approval_plan_cache.ApprovalPlanCache
ApprovalPlanCacheCapacityError = _approval_plan_cache.ApprovalPlanCacheCapacityError
clamp_approval_plan_ttl = _approval_plan_cache.clamp_approval_plan_ttl

SIDECAR_INJECTED_ARG_KEYS: tuple[str, ...] = (
    "expected_read_snapshot",
    "_jenny_approved_plan",
    "_jenny_plan_artifact_write",
    "_jenny_read_only",
    "_jenny_session_id",
    "_jenny_turn_id",
    "_jenny_tool_call_id",
    "_jenny_change_set_id",
)

SIDECAR_HISTORY_HASH_FIELDS: tuple[str, ...] = (
    "role",
    "content",
    "tool_calls",
    "tool_call_id",
    "name",
    "is_error",
    "error_code",
)

_APPROVAL_PLAN_CHANGE_BUCKETS: tuple[dict[str, Any], ...] = (
    {
        "bucket": "what_you_approved_changed",
        "label": "What you approved changed",
        "expanded_by_default": True,
        "components": {
            "tool_contract": "tool_contract",
            "effective_args": "tool_arguments",
            "execution_context": "execution_context",
        },
    },
    {
        "bucket": "conversation_context_changed",
        "label": "Conversation context changed",
        "expanded_by_default": True,
        "components": {
            "system_prompt": "system_prompt",
            "message_history": "conversation_history",
            "request_messages": "conversation_history",
        },
    },
    {
        "bucket": "internal_state_changed",
        "label": "Internal state changed",
        "expanded_by_default": False,
        "components": {
            "model_identity": "model_identity",
            "sampling_params": "sampling_params",
            "parent_approval_plan": "parent_approval_plan",
            "remaining_iterations": "remaining_iterations",
            "tool_budget": "tool_budget",
        },
    },
)


def stable_hash(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _component_changes(
    plan: Any,
    *,
    tool_contract_hash: str | None,
    effective_args_fingerprint: str | None,
    execution_context_fingerprint: str | None,
    model_identity_fingerprint: str | None,
    system_prompt_hash: str | None,
    sampling_params_hash: str | None,
    message_history_hash: str | None,
    request_messages_hash: str | None,
    parent_approval_plan_hash: str | None,
    remaining_iterations: int | None,
    tool_call_limit: int | None,
    remaining_tool_calls: int | None,
) -> set[str]:
    changes: set[str] = set()
    comparisons = {
        "tool_contract": (tool_contract_hash, getattr(plan, "tool_contract_hash", "")),
        "effective_args": (
            effective_args_fingerprint,
            getattr(plan, "effective_args_fingerprint", ""),
        ),
        "execution_context": (
            execution_context_fingerprint,
            getattr(plan, "execution_context_fingerprint", ""),
        ),
        "model_identity": (
            model_identity_fingerprint,
            getattr(plan, "model_identity_fingerprint", ""),
        ),
        "system_prompt": (system_prompt_hash, getattr(plan, "system_prompt_hash", "")),
        "sampling_params": (sampling_params_hash, getattr(plan, "sampling_params_hash", "")),
        "message_history": (message_history_hash, getattr(plan, "message_history_hash", "")),
        "request_messages": (
            request_messages_hash,
            getattr(plan, "request_messages_hash", ""),
        ),
        "parent_approval_plan": (
            parent_approval_plan_hash,
            getattr(plan, "parent_approval_plan_hash", ""),
        ),
    }
    for component, (current_value, plan_value) in comparisons.items():
        if current_value is not None and str(current_value) != str(plan_value):
            changes.add(component)
    if remaining_iterations is not None:
        current_remaining = max(int(remaining_iterations), 0)
        plan_remaining = max(int(getattr(plan, "remaining_iterations", 0) or 0), 0)
        if current_remaining != plan_remaining:
            changes.add("remaining_iterations")
    if tool_call_limit is not None or remaining_tool_calls is not None:
        current_limit = max(int(tool_call_limit or 0), 0)
        current_remaining = max(int(remaining_tool_calls or 0), 0)
        plan_limit = max(int(getattr(plan, "tool_call_limit", 0) or 0), 0)
        plan_remaining = max(int(getattr(plan, "remaining_tool_calls", 0) or 0), 0)
        if current_limit != plan_limit or current_remaining != plan_remaining:
            changes.add("tool_budget")
    return changes


def describe_approval_plan_changes(
    plan: Any,
    *,
    tool_contract_hash: str | None = None,
    effective_args_fingerprint: str | None = None,
    execution_context_fingerprint: str | None = None,
    model_identity_fingerprint: str | None = None,
    system_prompt_hash: str | None = None,
    sampling_params_hash: str | None = None,
    message_history_hash: str | None = None,
    request_messages_hash: str | None = None,
    parent_approval_plan_hash: str | None = None,
    remaining_iterations: int | None = None,
    tool_call_limit: int | None = None,
    remaining_tool_calls: int | None = None,
) -> tuple[dict[str, object], ...]:
    """Return approval-plan drift as compact user-facing buckets."""
    changed_components = _component_changes(
        plan,
        tool_contract_hash=tool_contract_hash,
        effective_args_fingerprint=effective_args_fingerprint,
        execution_context_fingerprint=execution_context_fingerprint,
        model_identity_fingerprint=model_identity_fingerprint,
        system_prompt_hash=system_prompt_hash,
        sampling_params_hash=sampling_params_hash,
        message_history_hash=message_history_hash,
        request_messages_hash=request_messages_hash,
        parent_approval_plan_hash=parent_approval_plan_hash,
        remaining_iterations=remaining_iterations,
        tool_call_limit=tool_call_limit,
        remaining_tool_calls=remaining_tool_calls,
    )
    buckets: list[dict[str, object]] = []
    for bucket in _APPROVAL_PLAN_CHANGE_BUCKETS:
        component_map = bucket["components"]
        if not isinstance(component_map, dict):
            continue
        components = tuple(
            dict.fromkeys(
                display_name
                for source_name, display_name in component_map.items()
                if source_name in changed_components
            )
        )
        if not components:
            continue
        buckets.append(
            {
                "bucket": bucket["bucket"],
                "label": bucket["label"],
                "expanded_by_default": bucket["expanded_by_default"],
                "components": components,
            }
        )
    return tuple(buckets)


@dataclass(frozen=True)
class FrozenExecutionInputs:
    call_id: str
    tool_name: str
    visible_tool_arguments: dict[str, Any]
    effective_tool_arguments: dict[str, Any]
    injected_arg_keys: tuple[str, ...]
    effective_args_fingerprint: str
    execution_context_payload: dict[str, Any]


@dataclass(frozen=True)
class ApprovalPlan:
    call_id: str
    approved_call_id: str
    request_id: str
    trace_id: str | None
    session_id: str | None
    request_context: Any
    latest_user_content: str
    working_messages: tuple[dict[str, Any], ...]
    generation_result: Any
    tool_calls: tuple[Any, ...]
    frozen_inputs: tuple[FrozenExecutionInputs, ...]
    tool_contract: Any
    tool_resolution_context: Any | None
    read_snapshot_cache: dict[str, dict[str, object]]
    outcomes: tuple[Any, ...]
    usage_totals: Any | None
    streamed_event_types: frozenset[str]
    system_prompt: Any
    prompt_cache_enabled: bool
    cache_source_key: str
    remaining_iterations: int
    request_messages_hash: str
    tool_payload: tuple[dict[str, Any], ...]
    tool_statuses: tuple[Any, ...]
    tool_contract_hash: str
    effective_args_fingerprint: str
    execution_context_fingerprint: str
    model_identity_fingerprint: str
    system_prompt_hash: str
    sampling_params_hash: str
    message_history_hash: str
    parent_approval_plan_hash: str
    approval_plan_hash: str
    # Absolute iteration number the loop was paused on. Resume threads this
    # back as ``LoopRuntime.iteration_base`` so the resumed loop numbers its
    # iterations ``completed_iterations + 1 ..`` instead of restarting at 1
    # (streamed thinking/phase ids embed the iteration and must stay unique
    # per turn). Informational for numbering only — excluded from
    # ``approval_plan_hash`` (``remaining_iterations`` already covers drift).
    completed_iterations: int = 0
    tool_call_limit: int = 0
    remaining_tool_calls: int = 0
    # Process-local monotonic deadline for the whole request. Approval plans
    # are in-memory only, so this must be reused on resume rather than reset.
    wall_clock_deadline: float | None = None
    # The FREEZE-TIME answer to "did this turn render its `## Personality` row
    # from the typed context block?". Recorded rather than recomputed because
    # the engine can change between freeze and approval: re-deriving it against
    # LIVE config on a turn frozen under the ChatGPT minimal profile (block on
    # the wire, zero personality rows emitted) would suppress the bare overlay
    # AND find no frozen row to keep, leaving the resumed non-minimal turn with
    # ZERO `## Personality` messages. ``None`` means "not recorded" -- only a
    # legacy/synthetic plan; ``plan_personality_block_present`` reads it as
    # False (production plans always record the boolean at build time). Excluded
    # from ``approval_plan_hash``: it is derived from config and the request,
    # both already covered by ``system_prompt_hash`` / ``sampling_params_hash``
    # / ``message_history_hash``.
    personality_rendered: bool | None = None
    change_set_id: str = ""

    def frozen_input_for_call(self, call_id: str) -> FrozenExecutionInputs | None:
        normalized = str(call_id or "").strip()
        for item in self.frozen_inputs:
            if item.call_id == normalized:
                return item
        return None


def build_message_history_hash(messages: list[dict[str, Any]] | tuple[dict[str, Any], ...]) -> str:
    canonical_messages: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        canonical: dict[str, Any] = {}
        for field in SIDECAR_HISTORY_HASH_FIELDS:
            if field not in message:
                continue
            value = message.get(field)
            if field == "tool_calls" and isinstance(value, list):
                canonical["tool_calls"] = [
                    {
                        "call_id": str(call.get("call_id") or call.get("id") or "").strip(),
                        "name": str(call.get("name") or call.get("tool_id") or "").strip(),
                        "arguments": copy.deepcopy(call.get("arguments"))
                        if isinstance(call.get("arguments"), dict)
                        else {},
                    }
                    for call in value
                    if isinstance(call, dict)
                ]
                continue
            canonical[field] = copy.deepcopy(value)
        if canonical:
            canonical_messages.append(canonical)
    return stable_hash(canonical_messages)


def build_tool_contract_hash(tool_contract: Any) -> str:
    prompt_schemas = tuple(copy.deepcopy(getattr(tool_contract, "prompt_schemas", ()) or ()))
    status_entries = []
    for status in getattr(tool_contract, "status_entries", ()) or ():
        status_entries.append(
            {
                "name": str(getattr(status, "name", "") or ""),
                "available": bool(getattr(status, "available", False)),
                "reason": str(getattr(status, "reason", "") or ""),
                "source_kind": str(getattr(status, "source_kind", "") or ""),
                "tool_family": str(getattr(status, "tool_family", "") or ""),
            }
        )
    return stable_hash(
        {
            "prompt_schemas": prompt_schemas,
            "status_entries": status_entries,
        }
    )


def build_model_identity_fingerprint(*, config: Any, engine: Any) -> str:
    return stable_hash(
        {
            "provider": str(getattr(config, "engine_type", "") or ""),
            "model": str(getattr(config, "model", "") or ""),
            "engine_class": f"{type(engine).__module__}.{type(engine).__name__}",
            "tier": str(getattr(config, "model_tier", "") or ""),
            "fallback_model": str(getattr(config, "fallback_model", "") or ""),
        }
    )


def build_sampling_params_hash(
    *,
    config: Any,
    request_context: Any,
    resolved_max_tokens: int | None,
    prompt_cache_enabled: bool,
) -> str:
    memory_policy = getattr(request_context, "memory_policy", None)
    return stable_hash(
        {
            "max_tokens": resolved_max_tokens,
            "reasoning_effort": str(getattr(request_context, "reasoning_effort", "") or ""),
            "temperature": getattr(config, "temperature", None),
            "top_p": getattr(config, "top_p", None),
            "stop_sequences": copy.deepcopy(getattr(config, "stop_sequences", None)),
            "prompt_cache_enabled": bool(prompt_cache_enabled),
            "memory_policy": {
                "enabled": bool(getattr(memory_policy, "enabled", True)),
                "include_response_style": bool(
                    getattr(memory_policy, "include_response_style", True)
                ),
            },
        }
    )


def build_execution_context_fingerprint(
    frozen_inputs: tuple[FrozenExecutionInputs, ...],
) -> str:
    payload = [
        {
            "call_id": item.call_id,
            "tool_name": item.tool_name,
            "execution_context": {
                key: copy.deepcopy(value)
                for key, value in item.execution_context_payload.items()
                if key != "_jenny_change_set_id"
            },
            "injected_arg_keys": [
                key for key in item.injected_arg_keys if key != "_jenny_change_set_id"
            ],
        }
        for item in frozen_inputs
    ]
    return stable_hash(payload)


def build_effective_args_fingerprint(
    frozen_inputs: tuple[FrozenExecutionInputs, ...],
) -> str:
    payload = [
        {
            "call_id": item.call_id,
            "tool_name": item.tool_name,
            "effective_tool_arguments": {
                key: copy.deepcopy(value)
                for key, value in item.effective_tool_arguments.items()
                if key != "_jenny_change_set_id"
            },
        }
        for item in frozen_inputs
    ]
    return stable_hash(payload)


def build_approval_plan(
    *,
    approved_call_id: str,
    request_context: Any,
    latest_user_content: str,
    request_messages_hash: str,
    working_messages: list[dict[str, Any]],
    generation_result: Any,
    tool_calls: tuple[Any, ...],
    frozen_inputs: tuple[FrozenExecutionInputs, ...],
    tool_contract: Any,
    tool_resolution_context: Any | None,
    read_snapshot_cache: dict[str, dict[str, object]],
    outcomes: tuple[Any, ...],
    usage_totals: Any | None,
    streamed_event_types: frozenset[str],
    system_prompt: Any,
    prompt_cache_enabled: bool,
    cache_source_key: str,
    remaining_iterations: int,
    completed_iterations: int = 0,
    wall_clock_deadline: float | None = None,
    tool_payload: list[dict[str, Any]],
    tool_statuses: tuple[Any, ...],
    config: Any,
    engine: Any,
    resolved_max_tokens: int | None,
    parent_approval_plan_hash: str = "",
    tool_call_limit: int = 0,
    remaining_tool_calls: int = 0,
    change_set_id: str = "",
) -> ApprovalPlan:
    from sidecar.ai.routing.mutation_change_set_lifecycle import (  # noqa: PLC0415
        freeze_approval_tool_calls,
    )

    tool_contract_hash = build_tool_contract_hash(tool_contract)
    effective_args_fingerprint = build_effective_args_fingerprint(frozen_inputs)
    execution_context_fingerprint = build_execution_context_fingerprint(frozen_inputs)
    model_identity_fingerprint = build_model_identity_fingerprint(config=config, engine=engine)
    system_prompt_hash = stable_hash(str(system_prompt))
    sampling_params_hash = build_sampling_params_hash(
        config=config,
        request_context=request_context,
        resolved_max_tokens=resolved_max_tokens,
        prompt_cache_enabled=prompt_cache_enabled,
    )
    message_history_hash = build_message_history_hash(working_messages)
    normalized_parent_approval_plan_hash = str(parent_approval_plan_hash or "").strip()
    normalized_tool_call_limit = max(int(tool_call_limit), 0)
    normalized_remaining_tool_calls = min(
        max(int(remaining_tool_calls), 0),
        normalized_tool_call_limit,
    )
    approval_plan_hash = stable_hash(
        {
            "call_id": str(approved_call_id or "").strip(),
            "tool_contract_hash": tool_contract_hash,
            "effective_args_fingerprint": effective_args_fingerprint,
            "execution_context_fingerprint": execution_context_fingerprint,
            "model_identity_fingerprint": model_identity_fingerprint,
            "system_prompt_hash": system_prompt_hash,
            "sampling_params_hash": sampling_params_hash,
            "message_history_hash": message_history_hash,
            "request_messages_hash": request_messages_hash,
            "parent_approval_plan_hash": normalized_parent_approval_plan_hash,
            "remaining_iterations": max(int(remaining_iterations), 0),
            "tool_call_limit": normalized_tool_call_limit,
            "remaining_tool_calls": normalized_remaining_tool_calls,
        }
    )
    call_id = str(approved_call_id or "").strip()
    if not call_id:
        for tool_call in tool_calls:
            normalized_call_id = str(getattr(tool_call, "call_id", "") or "").strip()
            if normalized_call_id:
                call_id = normalized_call_id
                break
    return ApprovalPlan(
        call_id=call_id,
        personality_rendered=resolve_personality_rendered(
            config,
            getattr(request_context, "context_blocks", ()),
        ),
        approved_call_id=call_id,
        request_id=str(getattr(request_context, "request_id", "") or ""),
        trace_id=getattr(request_context, "trace_id", None),
        session_id=getattr(request_context, "session_id", None),
        request_context=request_context,
        latest_user_content=str(latest_user_content or ""),
        working_messages=tuple(copy.deepcopy(working_messages)),
        generation_result=generation_result,
        tool_calls=freeze_approval_tool_calls(tool_calls, frozen_inputs),
        frozen_inputs=frozen_inputs,
        tool_contract=tool_contract,
        tool_resolution_context=tool_resolution_context,
        read_snapshot_cache=copy.deepcopy(read_snapshot_cache),
        outcomes=tuple(outcomes),
        usage_totals=usage_totals,
        streamed_event_types=frozenset(streamed_event_types),
        system_prompt=system_prompt,
        prompt_cache_enabled=bool(prompt_cache_enabled),
        cache_source_key=str(cache_source_key or ""),
        remaining_iterations=max(int(remaining_iterations), 0),
        completed_iterations=max(int(completed_iterations), 0),
        tool_call_limit=normalized_tool_call_limit,
        remaining_tool_calls=normalized_remaining_tool_calls,
        wall_clock_deadline=(
            float(wall_clock_deadline) if wall_clock_deadline is not None else None
        ),
        request_messages_hash=str(request_messages_hash or ""),
        tool_payload=tuple(copy.deepcopy(tool_payload)),
        tool_statuses=tuple(tool_statuses),
        tool_contract_hash=tool_contract_hash,
        effective_args_fingerprint=effective_args_fingerprint,
        execution_context_fingerprint=execution_context_fingerprint,
        model_identity_fingerprint=model_identity_fingerprint,
        system_prompt_hash=system_prompt_hash,
        sampling_params_hash=sampling_params_hash,
        message_history_hash=message_history_hash,
        parent_approval_plan_hash=normalized_parent_approval_plan_hash,
        approval_plan_hash=approval_plan_hash,
        change_set_id=str(change_set_id or "").strip(),
    )
