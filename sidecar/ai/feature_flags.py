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
# Row 60 harness fixes: default ON, absent means ON.
FEATURE_SHELL_NONINTERACTIVE_ENV = "shell_noninteractive_env"
FEATURE_SHELL_HEAD_TAIL_OUTPUT = "shell_head_tail_output"
FEATURE_LOOP_RESULT_AWARE_SIGNATURE = "loop_result_aware_signature"
FEATURE_EDIT_MATCH_FALLBACKS = "edit_match_fallbacks"
FEATURE_COMPACTION_REJECT_TRUNCATED_SUMMARY = "compaction_reject_truncated_summary"
FEATURE_COMPACTION_MICRO_FIRST = "compaction_micro_first"
FEATURE_COMPACTION_RECALL_TOOL = "compaction_recall_tool"
FEATURE_COMPACTION_TOUCHED_FILES = "compaction_touched_files"
# Default-on flags the builtin tool subprocess consumes; forwarded on its argv.
BUILTIN_DEFAULT_ON_FLAGS = (
    FEATURE_SHELL_NONINTERACTIVE_ENV,
    FEATURE_SHELL_HEAD_TAIL_OUTPUT,
    FEATURE_EDIT_MATCH_FALLBACKS,
)


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


def is_default_on_flag_enabled(flags: Mapping[str, bool] | None, name: str) -> bool:
    """Read a default-ON flag: only an explicit ``False`` turns it off."""
    if not isinstance(flags, Mapping):
        return True
    return flags.get(name.strip().lower(), True) is not False


def recall_tool_enabled(config: Any) -> bool:
    """Whether ``recall_tool_output`` is offered; ``config`` is a mapping or a config object."""
    flags = config.get("feature_flags") if isinstance(config, Mapping) else None
    if not isinstance(config, Mapping):
        flags = getattr(config, "feature_flags", None)
    return is_default_on_flag_enabled(flags, FEATURE_COMPACTION_RECALL_TOOL)


def is_resource_discipline_enabled(flags: Mapping[str, bool] | None) -> bool:
    if not isinstance(flags, Mapping):
        return True
    return flags.get(FEATURE_RESOURCE_DISCIPLINE, True)
