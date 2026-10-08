"""Feature flag constants and helpers for sidecar runtime behavior."""

from __future__ import annotations

from typing import Any, Mapping

FEATURE_AGENT_EXECUTOR = "agent_executor"
FEATURE_SKILLS_SYSTEM = "skills_system"
FEATURE_TOKEN_BUDGET = "token_budget"
FEATURE_CONTEXT_COMPACTION = "context_compaction"
FEATURE_API_RETRY = "api_retry"
FEATURE_PROMPT_CACHE = "prompt_cache"
FEATURE_TOOL_SEARCH = "tool_search"
FEATURE_SHELL_SECURITY = "shell_security"
FEATURE_STRICT_AUTO_RUN = "strict_auto_run"
FEATURE_GIT_TRACKING = "git_tracking"
FEATURE_TASK_LIFECYCLE = "task_lifecycle"
FEATURE_MULTIPLEXER = "multiplexer"
FEATURE_CHAT_CANCEL = "chat_cancel"
FEATURE_PHASE_EVENTS = "phase_events"
FEATURE_CANONICAL_TURN_EVENTS = "canonical_turn_events"
FEATURE_RESOURCE_DISCIPLINE = "resource_discipline"


def normalize_feature_flags(value: Any) -> dict[str, bool]:
    if not isinstance(value, dict):
        return {}

    normalized: dict[str, bool] = {}
    for raw_key, raw_value in value.items():
        if not isinstance(raw_key, str):
            continue
        key = raw_key.strip().lower()
        if not key or not isinstance(raw_value, bool):
            continue
        normalized[key] = raw_value
    return normalized


def is_feature_flag_enabled(flags: Mapping[str, bool], name: str) -> bool:
    key = name.strip().lower()
    if not key:
        return False
    return flags.get(key, False)


def is_resource_discipline_enabled(flags: Mapping[str, bool] | None) -> bool:
    if not isinstance(flags, Mapping):
        return True
    return flags.get(FEATURE_RESOURCE_DISCIPLINE, True)
