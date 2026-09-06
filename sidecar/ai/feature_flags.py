"""Feature flag constants and helpers for sidecar runtime behavior."""

from __future__ import annotations

from typing import Any, Mapping

FEATURE_AGENT_EXECUTOR = "agent_executor"
FEATURE_SKILLS_SYSTEM = "skills_system"
FEATURE_TOKEN_BUDGET = "token_budget"
FEATURE_CONTEXT_COMPACTION = "context_compaction"
# Manual "compact now" trigger (chat.compact RPC + Settings button). Default-ON;
# JENNY_ENABLE_COMPACTION_MANUAL=0 is the kill switch. Gated at BOTH layers.
FEATURE_COMPACTION_MANUAL = "compaction_manual"
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
# Engine-keyed resource-discipline profile: cloud frontier engines get widened
# loop/tool budgets, every local engine keeps today's caps. Default-ON;
# JENNY_ENABLE_CLOUD_LOOP_PROFILE=0 rolls back to one profile for all engines.
FEATURE_CLOUD_LOOP_PROFILE = "cloud_loop_profile"
# Mid-turn ``context.usage`` snapshots for the composer context ring. EPHEMERAL
# (no canonical turn event, no journaling) and gated at BOTH layers — the
# sidecar stops emitting and Electron stops forwarding. Default-ON;
# JENNY_ENABLE_CONTEXT_USAGE_LIVE=0 is the kill switch, which restores the
# terminal-only meter behavior byte-identically.
FEATURE_CONTEXT_USAGE_LIVE = "context_usage_live"
# ChatGPT plan-usage rolling-window meter (composer footer chip). Additive
# optional ``usage.plan_usage`` / ``plan_usage`` wire keys sourced from Codex
# response headers; gated at BOTH layers -- the sidecar stops attaching and
# Electron stops forwarding/persisting. Default-ON;
# JENNY_ENABLE_CHATGPT_PLAN_METER=0 is the kill switch (byte-identical
# rollback -- no wire key emitted).
FEATURE_CHATGPT_PLAN_METER = "chatgpt_plan_meter"
FEATURE_VISION_UNIFIED_TURN = "vision_unified_turn"


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


def is_cloud_loop_profile_enabled(flags: Mapping[str, bool] | None) -> bool:
    if not isinstance(flags, Mapping):
        return True
    return flags.get(FEATURE_CLOUD_LOOP_PROFILE, True)


def is_context_usage_live_enabled(flags: Mapping[str, bool] | None) -> bool:
    if not isinstance(flags, Mapping):
        return True
    return flags.get(FEATURE_CONTEXT_USAGE_LIVE, True)


def is_chatgpt_plan_meter_enabled(flags: Mapping[str, bool] | None) -> bool:
    if not isinstance(flags, Mapping):
        return True
    return flags.get(FEATURE_CHATGPT_PLAN_METER, True)
