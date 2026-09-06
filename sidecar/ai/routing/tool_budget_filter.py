"""Budget-aware tool-schema filtering for request-scoped routing."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, replace
from typing import Any

from sidecar.ai.config_models import uses_minimal_system_prompt
from sidecar.ai.context.builder import (
    looks_like_current_info_request,
    looks_like_source_architecture_request,
)
from sidecar.ai.context.token_budget import (
    apply_budget_check,
    build_tool_schema_budget_plan,
    check_budget,
    estimate_messages_tokens,
    ordered_unique_names,
    tool_schema_cap_for_budget_level,
)
from sidecar.ai.feature_flags import FEATURE_TOKEN_BUDGET, is_feature_flag_enabled
from sidecar.ai.routing.system_messages import build_request_system_messages
from sidecar.ai.tools import assembly as _tool_assembly
from sidecar.ai.tools import tool_families as _tool_families
from sidecar.ai.tools import tool_search as _tool_search
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

TOOL_NOT_EXPOSED_REASON = _tool_assembly.TOOL_NOT_EXPOSED_REASON
TOOL_SEARCH_TOOL_NAME = _tool_search.TOOL_SEARCH_TOOL_NAME
build_search_index = _tool_search.build_search_index
status_matches_tool_family = _tool_families.status_matches_tool_family
tool_preference_set = _tool_assembly.tool_preference_set


@dataclass(frozen=True)
class ToolBudgetFilterResult:
    tool_contract: Any
    tool_payload: list[dict[str, Any]]
    tool_statuses: tuple[Any, ...]
    system_prompt: Any | None = None


@dataclass(frozen=True)
class _BudgetPressureProbe:
    status: Any | None
    system_prompt: Any


@dataclass(frozen=True)
class ToolBudgetFilterInput:
    kernel: Any
    feature_flags: dict[str, Any]
    request_context: ChatRequestContext
    tool_resolution_context: Any | None
    semantic_history: list[dict[str, object]]
    runtime_overlay_messages: list[str]
    context_block_messages: list[dict[str, object]]
    learned_lessons: list[Any] | None
    prompt_cache_enabled: bool
    pinned_current_date: str
    latest_user_content: str
    request_id: str
    session_id: str | None
    tool_search_enabled: bool
    has_active_background_jobs: bool = False
    has_active_monitors: bool = False
    has_pending_operations: bool = False


_CONTINUATION_RE = re.compile(
    r"^(?:resume|proceed|continue|go ahead|keep going|yes|please continue)[.! ]*$",
    re.IGNORECASE,
)
_STATUS_TOOL_NAMES = frozenset(
    {"check_background_job", "check_monitor", "operation_status"}
)
_MAX_CONTINUATION_UTTERANCE_CHARS = 40
_MAX_RECENT_SUCCESSFUL_TOOLS = 4
_FILESYSTEM_TOOL_PRIORITY = (
    "read_file",
    "grep_search",
    "edit_file",
    "write_file",
    "glob_files",
    "list_dir",
    "workspace_manifest_read",
    "delete_file",
    "move_file",
)
_FILESYSTEM_BUDGET_FLOOR = 3


def count_full_tool_schemas(tool_payload: list[dict[str, Any]]) -> int:
    """Count schemas carrying provider-facing argument contracts."""
    return sum(1 for schema in tool_payload if "parameters" in schema)


def build_system_prompt_for_statuses(
    context: ToolBudgetFilterInput,
    tool_statuses: tuple[Any, ...],
) -> Any:
    kernel = context.kernel
    kwargs = {
        "learned_lessons": context.learned_lessons,
        "session_start_date": context.request_context.session_start_date,
        "current_date": context.pinned_current_date,
        "tool_statuses": list(tool_statuses),
        "latest_user_content": context.latest_user_content,
        "engine_type": kernel._config.engine_type,
        "include_skills": False,
        "include_bootstrap": not uses_minimal_system_prompt(kernel._config),
        "workspace_manifest_enabled": bool(
            getattr(kernel._config, "tools_workspace_manifest_enabled", False)
        ),
        "task_capsule_enabled": bool(
            getattr(kernel._config, "tools_task_capsule_enabled", False)
        ),
    }
    if context.prompt_cache_enabled:
        return kernel._context_builder.build_system_prompt(
            kernel._config.system_prompt,
            cache_aware=True,
            **kwargs,
        )
    return str(
        kernel._context_builder.build_system_prompt(
            kernel._config.system_prompt,
            **kwargs,
        )
    )


def apply_budget_aware_tool_filter(
    context: ToolBudgetFilterInput,
    *,
    tool_contract: Any,
    tool_payload: list[dict[str, Any]],
    tool_statuses: tuple[Any, ...],
) -> ToolBudgetFilterResult:
    result = ToolBudgetFilterResult(tool_contract, tool_payload, tool_statuses)
    if not _budget_filter_enabled(context):
        return result

    budget_probe = _budget_pressure_for_tool_filter(context, result)

    def unfiltered() -> ToolBudgetFilterResult:
        return ToolBudgetFilterResult(
            tool_contract,
            tool_payload,
            tool_statuses,
            system_prompt=budget_probe.system_prompt,
        )

    budget_status = budget_probe.status
    if budget_status is None:
        return unfiltered()

    cap = tool_schema_cap_for_budget_level(budget_status.level)
    if cap is None:
        return unfiltered()

    candidate_names = _full_schema_candidate_names(tool_contract)
    if len(candidate_names) <= cap:
        return unfiltered()

    inactive_status_names = _inactive_status_tool_names(context, candidate_names)
    candidate_names = tuple(name for name in candidate_names if name not in inactive_status_names)

    tool_search_name = _budget_tool_search_candidate_name(tool_contract)
    if tool_search_name:
        candidate_names = ordered_unique_names((*candidate_names, tool_search_name))
    un_deferred: set[str] = getattr(context.tool_resolution_context, "un_deferred_names", set())
    withheld_delete = (
        "delete_file" in candidate_names
        and "delete_file" not in un_deferred
    )
    if withheld_delete:
        # Under pressure delete_file is tool_search-only: an unprompted pair must never
        # displace a repair tool.
        candidate_names = tuple(name for name in candidate_names if name != "delete_file")
    preferred_names = _budget_preferred_tool_names(context, tool_contract, candidate_names)
    plan = build_tool_schema_budget_plan(
        candidate_names,
        level=budget_status.level,
        mandatory_names=_budget_mandatory_tool_names(context, tool_contract, candidate_names),
        preferred_names=preferred_names,
    )
    if withheld_delete:
        plan = replace(plan, filtered_names=plan.filtered_names | {"delete_file"}, active=True)
    plan = _pair_delete_with_move(plan, candidate_names, preferred_names)
    if inactive_status_names:
        plan = replace(
            plan,
            filtered_names=plan.filtered_names | inactive_status_names,
            active=True,
        )
    if not plan.active:
        return unfiltered()

    resolution_context = context.tool_resolution_context
    assert resolution_context is not None
    resolution_context.budget_filtered_names = plan.filtered_names
    resolution_context.budget_filter_metadata = {
        "level": plan.level,
        "cap": plan.cap,
        "kept_names": list(plan.kept_names),
        "filtered_count": len(plan.filtered_names),
        "tokens_used": budget_status.tokens_used,
        "utilization_pct": budget_status.utilization_pct,
    }
    resolution_context.search_index = build_search_index(
        resolution_context.remaining_unexposed_names(),
        tool_contract.filtered_descriptors,
    )
    rebuilt_contract = context.kernel._assemble_tool_contract(
        request_context=context.request_context,
        resolution_context=resolution_context,
    )
    rebuilt_payload = list(rebuilt_contract.prompt_schemas)
    _log_budget_tool_filter(
        context,
        plan,
        prompt_schema_count_before=len(tool_payload),
        prompt_schema_count_after=len(rebuilt_payload),
    )
    return ToolBudgetFilterResult(
        tool_contract=rebuilt_contract,
        tool_payload=rebuilt_payload,
        tool_statuses=rebuilt_contract.status_entries,
    )


def _pair_delete_with_move(
    plan: Any, candidate_names: tuple[str, ...], preferred_names: tuple[str, ...],
) -> Any:
    if (
        "delete_file" in plan.kept_names
        and "move_file" not in plan.kept_names
        and "move_file" in candidate_names
    ):
        kept = [*plan.kept_names, "move_file"]
        filtered = plan.filtered_names - {"move_file"}
        if len(kept) > plan.cap:
            for name in reversed(kept):
                if (
                    name not in plan.mandatory_names
                    and name not in {"delete_file", "move_file"}
                    and name not in preferred_names
                ):
                    kept.remove(name)
                    filtered |= {name}
                    break
            # Keep the +1 if nothing is evictable: pairing is safety and delete was requested.
        plan = replace(
            plan,
            kept_names=tuple(kept),
            filtered_names=filtered,
        )
    return plan


def _budget_filter_enabled(context: ToolBudgetFilterInput) -> bool:
    return (
        context.tool_search_enabled
        and context.tool_resolution_context is not None
        and is_feature_flag_enabled(context.feature_flags, FEATURE_TOKEN_BUDGET)
    )


def _budget_pressure_for_tool_filter(
    context: ToolBudgetFilterInput,
    result: ToolBudgetFilterResult,
) -> _BudgetPressureProbe:
    system_prompt = build_system_prompt_for_statuses(context, result.tool_statuses)
    working_messages = build_request_system_messages(
        context.kernel,
        base_system_prompt=str(system_prompt),
        tool_statuses=result.tool_statuses,
        runtime_system_messages=context.runtime_overlay_messages,
    )
    working_messages.extend(context.context_block_messages)
    working_messages.extend(context.semantic_history)
    num_tools = (
        count_full_tool_schemas(result.tool_payload)
        if context.kernel._config.tools_enabled
        else 0
    )
    _messages, budget, tracker = apply_budget_check(
        working_messages,
        context.kernel._config,
        context.kernel._engine,
        num_tools=num_tools,
    )
    if budget is None:
        return _BudgetPressureProbe(status=None, system_prompt=system_prompt)
    return _BudgetPressureProbe(
        # Count with the backend the budget was derived from; the tool-schema
        # cap this probe drives must key off the same figure the chat_decision
        # preflight sees, or the two lanes disagree about pressure level.
        status=check_budget(
            estimate_messages_tokens(
                working_messages,
                tracker.backend if tracker is not None else None,
            ),
            budget,
            num_tools=num_tools,
        ),
        system_prompt=system_prompt,
    )


def _full_schema_candidate_names(tool_contract: Any) -> tuple[str, ...]:
    return tuple(
        entry.descriptor.name
        for entry in tool_contract.entries
        if entry.available is True
        and isinstance(entry.prompt_schema, dict)
        and "parameters" in entry.prompt_schema
    )


def _budget_tool_search_candidate_name(tool_contract: Any) -> str | None:
    entry = tool_contract.entry(TOOL_SEARCH_TOOL_NAME)
    if entry is None:
        return None
    if entry.available is True or entry.reason == TOOL_NOT_EXPOSED_REASON:
        return entry.descriptor.name
    return None


def _budget_mandatory_tool_names(
    context: ToolBudgetFilterInput,
    tool_contract: Any,
    candidate_names: tuple[str, ...],
) -> tuple[str, ...]:
    candidate_set = frozenset(candidate_names)
    names: list[str] = []
    un_deferred: set[str] = getattr(
        context.tool_resolution_context,
        "un_deferred_names",
        set(),
    )
    for entry in tool_contract.entries:
        name = entry.descriptor.name
        if name not in candidate_set:
            continue
        if (
            name == TOOL_SEARCH_TOOL_NAME
            or name in un_deferred
        ):
            names.append(name)
    return ordered_unique_names(names)


def _budget_preferred_tool_names(
    context: ToolBudgetFilterInput,
    tool_contract: Any,
    candidate_names: tuple[str, ...],
) -> tuple[str, ...]:
    enabled_tools = tool_preference_set(context.request_context.tool_preferences, "enabled_tools")
    relevant_text = _budget_relevance_text(context)
    family_names = _budget_relevant_family_names(relevant_text, tool_contract)
    recent_successes = _recent_successful_tool_names(context.semantic_history)
    active_status_names = _active_status_tool_names(context)
    return ordered_unique_names(
        (
            *(name for name in candidate_names if name in enabled_tools),
            *(name for name in active_status_names if name in candidate_names),
            *(name for name in family_names if name in candidate_names),
            *(name for name in recent_successes if name in candidate_names),
        )
    )


def _budget_relevance_text(context: ToolBudgetFilterInput) -> str:
    latest = str(context.latest_user_content or "").strip()
    plan = context.request_context.approved_plan
    parts = [latest]
    if isinstance(plan, dict):
        for field in ("title", "summary", "notes", "verification"):
            value = str(plan.get(field) or "").strip()
            if value:
                parts.append(value)
        steps = plan.get("steps")
        if isinstance(steps, list):
            parts.extend(str(step).strip()[:300] for step in steps[:20] if str(step).strip())
    elif _is_continuation_utterance(latest):
        prior = _most_recent_substantive_user_content(context.semantic_history)
        if prior:
            parts.append(prior)
    return "\n".join(parts)[:8000]


def _is_continuation_utterance(content: str) -> bool:
    normalized = str(content or "").strip()
    return (
        len(normalized) <= _MAX_CONTINUATION_UTTERANCE_CHARS
        and _CONTINUATION_RE.fullmatch(normalized) is not None
    )


def _most_recent_substantive_user_content(
    semantic_history: list[dict[str, object]],
) -> str:
    for message in reversed(semantic_history):
        if str(message.get("role") or "").strip().lower() != "user":
            continue
        content = str(message.get("content") or "").strip()
        if content and not _is_continuation_utterance(content):
            return content[:4000]
    return ""


def _recent_successful_tool_names(
    semantic_history: list[dict[str, object]],
) -> tuple[str, ...]:
    names: list[str] = []
    for message in reversed(semantic_history):
        if str(message.get("role") or "").strip().lower() != "tool":
            continue
        if message.get("is_error") is True or str(message.get("error_code") or "").strip():
            continue
        name = str(message.get("name") or "").strip()
        if name and name not in _STATUS_TOOL_NAMES:
            names.append(name)
        if len(names) >= _MAX_RECENT_SUCCESSFUL_TOOLS:
            break
    return ordered_unique_names(names)


def _active_status_tool_names(context: ToolBudgetFilterInput) -> tuple[str, ...]:
    names: list[str] = []
    if context.has_active_background_jobs:
        names.append("check_background_job")
    if context.has_active_monitors:
        names.append("check_monitor")
    if context.has_pending_operations:
        names.append("operation_status")
    return ordered_unique_names(names)


def _inactive_status_tool_names(
    context: ToolBudgetFilterInput,
    candidate_names: tuple[str, ...],
) -> frozenset[str]:
    active = frozenset(_active_status_tool_names(context))
    return frozenset(
        name for name in candidate_names if name in _STATUS_TOOL_NAMES and name not in active
    )


def _budget_relevant_family_names(latest_user_content: str, tool_contract: Any) -> tuple[str, ...]:
    families = {"filesystem"}
    if looks_like_current_info_request(latest_user_content):
        families.add("web")
    matching = {
        entry.descriptor.name
        for entry in tool_contract.entries
        if any(
            status_matches_tool_family(
                name=entry.descriptor.name,
                tool_family=entry.descriptor.tool_family,
                family=family,
            )
            for family in families
        )
    }
    filesystem = tuple(name for name in _FILESYSTEM_TOOL_PRIORITY if name in matching)
    remaining = tuple(
        entry.descriptor.name
        for entry in tool_contract.entries
        if "web" in families and status_matches_tool_family(
            name=entry.descriptor.name,
            tool_family=entry.descriptor.tool_family,
            family="web",
        )
    )
    # A source/architecture prompt keeps the whole filesystem order it always had;
    # otherwise the floor guarantees the repair trio under pressure without letting
    # one family starve the keyword gate or a tool the model just used successfully.
    if not looks_like_source_architecture_request(latest_user_content):
        filesystem = filesystem[:_FILESYSTEM_BUDGET_FLOOR]
    return ordered_unique_names((*remaining, *filesystem))

def _log_budget_tool_filter(
    context: ToolBudgetFilterInput,
    plan: Any,
    *,
    prompt_schema_count_before: int,
    prompt_schema_count_after: int,
) -> None:
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.tool_schema_budget_filter_applied",
        message="Applied budget-aware tool schema filtering.",
        status="success",
        data={
            "budget_level": plan.level,
            "cap": plan.cap,
            "kept_count": len(plan.kept_names),
            "filtered_count": len(plan.filtered_names),
            "prompt_schema_count_before": prompt_schema_count_before,
            "prompt_schema_count_after": prompt_schema_count_after,
        },
        request_id=context.request_id,
        session_id=context.session_id,
    )


__all__ = [
    "ToolBudgetFilterInput",
    "ToolBudgetFilterResult",
    "apply_budget_aware_tool_filter",
    "build_system_prompt_for_statuses",
]
