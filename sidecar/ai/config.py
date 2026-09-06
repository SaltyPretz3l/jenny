"""Runtime configuration parsing for the sidecar AI stack."""

from __future__ import annotations

import logging
import os
from dataclasses import fields
from pathlib import Path
from typing import Any

from sidecar.ai.config_models import (
    SYSTEM_PROMPT_DEFAULT,
    SYSTEM_PROMPT_PROFILE_AUTO,
    FallbackModelConfig,  # noqa: F401  (re-exported for backward-compat imports)
    MCPServerAuth,  # noqa: F401  (re-exported for backward-compat imports)
    MCPServerConfig,  # noqa: F401  (re-exported for backward-compat imports)
    RuntimeConfig,
    ToolPolicyRule,  # noqa: F401  (re-exported for backward-compat imports)
    ToolPolicyRuleMatch,  # noqa: F401  (re-exported for backward-compat imports)
    ToolPolicySnapshot,  # noqa: F401  (re-exported for backward-compat imports)
)
from sidecar.ai.config_parsing import (
    LOCAL_FIRST_FALLBACK_ENGINES,  # noqa: F401  (re-exported for backward-compat imports)
    _as_bool,
    _as_bounded_float,
    _as_bounded_int,
    _as_mapping,
    _as_non_empty_string,
    _as_nullable_string,
    _as_optional_bounded_float,
    _as_optional_bounded_float_map,
    _as_optional_capped_text,
    _as_string_mapping,
    _identity_value,
    _normalize_codex_cli_models,
    _normalize_generation_profiles,
    _normalize_knowledge_roots,
    _normalize_reasoning_effort,
    _normalize_safety_mode,
    _normalize_session_start_date,
    _normalize_tool_policy_snapshot,
    _normalize_tool_search_mode,
    _normalize_tool_search_threshold_pct,
    _parse_fallback_models,
    _parse_mcp_servers,
    codex_cli_unavailable_reason,  # noqa: F401  (re-exported for backward-compat imports)
)
from sidecar.ai.feature_flags import normalize_feature_flags
from sidecar.ai.mode_policy import normalize_mode
from sidecar.ai.personality import normalize_assistant_name

logger = logging.getLogger(__name__)

_DEFAULT_MAX_OUTPUT_TOKENS = 16384

# Top-level keys `parse_runtime_config` accepts: every `RuntimeConfig` field
# except the `resolved_app_profile_*` set, which is computed post-parse from
# the `app_profile` token and never read from the raw payload. Deriving this
# from dataclass fields means new config knobs are auto-recognized the moment
# they land on `RuntimeConfig`. Any key in `raw_config` not in this set is a
# tolerated-but-unknown extra: we log a single WARN per load so drift is
# visible without rejecting forward-compatible payloads.
# See docs/operations/versioning-and-migration.md for the schema policy.
_KNOWN_TOP_LEVEL_KEYS: frozenset[str] = frozenset(
    f.name for f in fields(RuntimeConfig) if not f.name.startswith("resolved_app_profile_")
)

# Fail-soft cap for the custom compaction prompt: oversize input is truncated,
# not rejected, so a pasted prompt never silently disables compaction tuning.
_COMPACTION_CUSTOM_PROMPT_MAX_CHARS = 20_000


def read_environment_value(name: str, default: str = "") -> str:
    """Read a process environment value through the config boundary."""
    return str(os.environ.get(name, default)).strip()


def resolve_effective_max_tokens(
    config_max_tokens: int,
    engine_max_output: int | None,
    fallback: int = _DEFAULT_MAX_OUTPUT_TOKENS,
    user_override: int | None = None,
) -> int:
    """Pick the best max_tokens value for a generation call.

    Priority: explicit per-model user override, engine-detected value,
    RuntimeConfig default, then the hard-coded fallback.
    """
    if user_override is not None:
        if engine_max_output is not None and engine_max_output > 0:
            return min(user_override, engine_max_output)
        return user_override
    if engine_max_output is not None:
        return engine_max_output
    return config_max_tokens or fallback


def parse_runtime_config(raw_config: Any) -> RuntimeConfig:  # noqa: PLR0915
    if not isinstance(raw_config, dict):
        return RuntimeConfig()

    unknown_keys = sorted(
        key
        for key in raw_config.keys()
        if isinstance(key, str) and key not in _KNOWN_TOP_LEVEL_KEYS
    )
    if unknown_keys:
        from sidecar.runtime.diagnostics import log_event  # noqa: PLC0415

        log_event(
            logger,
            logging.WARNING,
            component="ai.config",
            event="ai.config.unknown_keys",
            message=(
                f"parse_runtime_config received {len(unknown_keys)} unknown top-level "
                f"key(s); tolerating per forward-compat policy"
            ),
            status="degraded",
            data={
                "keys": unknown_keys,
                "source": "runtime_config",
            },
        )

    engine_type = _as_non_empty_string(raw_config.get("engine_type")) or "mock"
    raw_model = raw_config.get("model")
    explicit_blank_model = isinstance(raw_model, str) and not raw_model.strip()
    normalized_model = _as_non_empty_string(raw_model)
    model = normalized_model or "mock-v1"
    if explicit_blank_model and engine_type in {
        "ollama",
        "openai-compatible",
        "vllm",
        "codex-cli",
        "chatgpt",
        "plugin_host",
    }:
        model = ""
    if engine_type == "chatgpt" and normalized_model is None:
        model = ""
    context_length = (
        _as_bounded_int(
            raw_config.get("context_length"),
            default=0,
            min_value=1,
            max_value=10_000_000,
        )
        or None
    )
    context_length_override = (
        _as_bounded_int(
            raw_config.get("context_length_override"),
            default=0,
            min_value=1,
            max_value=262_144,
        )
        or None
    )
    # Name is the only runtime identity input; other identity fields are ignored.
    assistant_identity_source = _as_mapping(raw_config.get("assistant_identity"))
    assistant_name = normalize_assistant_name(
        _identity_value(assistant_identity_source, "agent_name", "agentName")
        or raw_config.get("assistant_name")
        or raw_config.get("agent_name")
    )
    assistant_identity = {"agent_name": assistant_name}
    api_url = _as_nullable_string(raw_config.get("api_url"))
    replay_script_path = _as_nullable_string(raw_config.get("replay_script_path"))
    replay_delay_ms = _as_optional_bounded_float(
        raw_config.get("replay_delay_ms"),
        min_value=0.0,
        max_value=10_000.0,
    )
    ollama_models_dir = _as_nullable_string(raw_config.get("ollama_models_dir"))
    ollama_request_timeout_seconds = _as_bounded_int(
        raw_config.get("ollama_request_timeout_seconds"),
        default=300,
        min_value=30,
        max_value=3600,
    )
    codex_cli_enabled = _as_bool(raw_config.get("codex_cli_enabled"), default=False)
    codex_cli_command = _as_nullable_string(raw_config.get("codex_cli_command"))
    codex_cli_runtime_root = _as_nullable_string(raw_config.get("codex_cli_runtime_root"))
    codex_cli_models = _normalize_codex_cli_models(raw_config.get("codex_cli_models"))
    codex_cli_request_timeout_seconds = _as_bounded_int(
        raw_config.get("codex_cli_request_timeout_seconds"),
        default=300,
        min_value=30,
        max_value=3600,
    )
    codex_cli_auth_ready = _as_bool(raw_config.get("codex_cli_auth_ready"), default=False)
    codex_cli_auth_reason = _as_nullable_string(raw_config.get("codex_cli_auth_reason"))
    chatgpt_access_token = _as_nullable_string(raw_config.get("chatgpt_access_token"))
    openai_compatible_api_key = _as_nullable_string(
        raw_config.get("openai_compatible_api_key")
    )
    chatgpt_account_id = _as_nullable_string(raw_config.get("chatgpt_account_id"))
    chatgpt_base_url = _as_nullable_string(raw_config.get("chatgpt_base_url"))
    tools_execution_timeout_seconds = _as_bounded_float(
        raw_config.get("tools_execution_timeout_seconds"),
        default=120.0,
        min_value=5.0,
        max_value=600.0,
    )
    max_loop_wall_seconds = _as_bounded_float(
        raw_config.get("max_loop_wall_seconds"),
        # 2026-08-30: local working-time default raised to 1800s (ceiling 3600s)
        # in lockstep with renderer/shared/engine-tuning-schema.js.
        default=1800.0,
        min_value=30.0,
        max_value=3600.0,
    )
    max_loop_iterations = _as_bounded_int(
        raw_config.get("max_loop_iterations"),
        default=8,
        min_value=1,
        max_value=32,
    )
    max_chat_loop_iterations = _as_bounded_int(
        raw_config.get("max_chat_loop_iterations"),
        default=max_loop_iterations,
        min_value=1,
        max_value=32,
    )
    max_task_loop_iterations = _as_bounded_int(
        raw_config.get("max_task_loop_iterations"),
        default=30,
        min_value=1,
        max_value=32,
    )
    max_sub_agent_loop_iterations = _as_bounded_int(
        raw_config.get("max_sub_agent_loop_iterations"),
        default=10,
        min_value=1,
        max_value=32,
    )
    max_sub_agent_concurrency = _as_bounded_int(
        raw_config.get("max_sub_agent_concurrency"),
        default=1,
        min_value=1,
        max_value=8,
    )
    max_cloud_sub_agent_concurrency = _as_bounded_int(
        raw_config.get("max_cloud_sub_agent_concurrency"),
        default=3,
        min_value=1,
        max_value=3,
    )
    max_budget_usd = _as_optional_bounded_float(
        raw_config.get("max_budget_usd"),
        min_value=0.000001,
        max_value=1_000_000.0,
    )
    chunk_inactivity_seconds = _as_bounded_float(
        raw_config.get("chunk_inactivity_seconds"),
        default=120.0,
        min_value=5.0,
        max_value=300.0,
    )
    chunk_inactivity_seconds_is_override = _as_bool(
        raw_config.get("chunk_inactivity_seconds_is_override"), default=False
    )
    model_load_grace_seconds = _as_bounded_float(
        raw_config.get("model_load_grace_seconds"),
        default=300.0,
        min_value=60.0,
        max_value=1800.0,
    )
    system_prompt = _as_non_empty_string(raw_config.get("system_prompt")) or SYSTEM_PROMPT_DEFAULT
    system_prompt_profile = (
        _as_non_empty_string(raw_config.get("system_prompt_profile")) or SYSTEM_PROMPT_PROFILE_AUTO
    )
    mode = normalize_mode(_as_non_empty_string(raw_config.get("mode")), default="chat")
    temperature = _as_bounded_float(
        raw_config.get("temperature"),
        default=0.7,
        min_value=0.0,
        max_value=2.0,
    )
    max_tokens = _as_bounded_int(
        raw_config.get("max_tokens"),
        default=16384,
        min_value=1,
        max_value=200_000,
    )
    max_inline_payload_bytes = _as_bounded_int(
        raw_config.get("max_inline_payload_bytes"),
        default=65_536,
        min_value=4096,
        max_value=2_097_152,
    )
    token_budget_reserved_for_summary = (
        _as_bounded_int(
            raw_config.get("token_budget_reserved_for_summary"),
            default=0,
            min_value=256,
            max_value=200_000,
        )
        or None
    )
    token_budget_tool_overhead = (
        _as_bounded_int(
            raw_config.get("token_budget_tool_overhead"),
            default=0,
            min_value=0,
            max_value=10_000,
        )
        or None
    )
    token_budget_warning_ratio = _as_optional_bounded_float(
        raw_config.get("token_budget_warning_ratio"),
        min_value=0.1,
        max_value=0.99,
    )
    token_budget_auto_compact_ratio = _as_optional_bounded_float(
        raw_config.get("token_budget_auto_compact_ratio"),
        min_value=0.1,
        max_value=0.99,
    )
    token_budget_auto_compact_ratio_by_model = _as_optional_bounded_float_map(
        raw_config.get("token_budget_auto_compact_ratio_by_model"),
        min_value=0.1,
        max_value=0.99,
    )
    compaction_custom_prompt = _as_optional_capped_text(
        raw_config.get("compaction_custom_prompt"),
        max_chars=_COMPACTION_CUSTOM_PROMPT_MAX_CHARS,
    )
    generation_profiles_by_model = _normalize_generation_profiles(
        raw_config.get("generation_profiles_by_model")
    )
    reasoning_effort = _normalize_reasoning_effort(raw_config.get("reasoning_effort"), default="")
    session_start_date = _normalize_session_start_date(raw_config.get("session_start_date"))
    safety_mode = _normalize_safety_mode(raw_config.get("safety_mode"))
    tool_search_mode = _normalize_tool_search_mode(raw_config.get("tool_search_mode"))
    tool_search_auto_threshold_pct = _normalize_tool_search_threshold_pct(
        raw_config.get("tool_search_auto_threshold_pct")
    )
    max_tools_per_turn = _as_bounded_int(
        raw_config.get("max_tools_per_turn"),
        default=20,
        min_value=1,
        max_value=100,
    )
    max_web_tool_calls_per_turn = _as_bounded_int(
        raw_config.get("max_web_tool_calls_per_turn"),
        default=10,
        min_value=1,
        max_value=100,
    )
    max_code_intelligence_tool_calls_per_turn = _as_bounded_int(
        raw_config.get("max_code_intelligence_tool_calls_per_turn"),
        default=16,
        min_value=1,
        max_value=100,
    )
    max_tool_calls_per_session = _as_bounded_int(
        raw_config.get("max_tool_calls_per_session"),
        default=200,
        min_value=1,
        max_value=1000,
    )
    # Cloud-engine loop profile. Deliberately parsed with WIDER bounds than the
    # local keys above: the whole point of the profile is limits a local engine
    # would never be given. Never narrow these to match the local bounds.
    cloud_max_chat_loop_iterations = _as_bounded_int(
        raw_config.get("cloud_max_chat_loop_iterations"),
        default=40,
        min_value=1,
        max_value=1000,
    )
    cloud_max_task_loop_iterations = _as_bounded_int(
        raw_config.get("cloud_max_task_loop_iterations"),
        default=300,
        min_value=1,
        max_value=1000,
    )
    cloud_max_loop_wall_seconds = _as_bounded_float(
        raw_config.get("cloud_max_loop_wall_seconds"),
        default=28_800.0,
        min_value=60.0,
        max_value=86_400.0,
    )
    cloud_max_tools_per_turn = _as_bounded_int(
        raw_config.get("cloud_max_tools_per_turn"),
        default=200,
        min_value=1,
        max_value=500,
    )
    cloud_max_tool_calls_per_session = _as_bounded_int(
        raw_config.get("cloud_max_tool_calls_per_session"),
        default=2_000,
        min_value=1,
        # Kept in lockstep with _MAX_SESSION_TOOL_CALL_CEILING in tool_quotas.py:
        # a value the parser admits but ToolQuotaPolicy rejects would silently
        # fail open back to 200.
        max_value=2_000,
    )
    cloud_max_web_tool_calls_per_turn = _as_bounded_int(
        raw_config.get("cloud_max_web_tool_calls_per_turn"),
        default=30,
        min_value=1,
        max_value=100,
    )
    cloud_tools_execution_timeout_seconds = _as_bounded_float(
        raw_config.get("cloud_tools_execution_timeout_seconds"),
        default=1_800.0,
        min_value=5.0,
        max_value=3_600.0,
    )
    tools_workspace_root = _as_nullable_string(raw_config.get("tools_workspace_root"))
    agent_workspace_root = _as_nullable_string(raw_config.get("agent_workspace_root"))
    electron_state_root = _as_nullable_string(raw_config.get("electron_state_root"))
    electron_shell_config_path = _as_nullable_string(raw_config.get("electron_shell_config_path"))
    electron_sessions_path = _as_nullable_string(raw_config.get("electron_sessions_path"))
    electron_tool_permissions_path = _as_nullable_string(
        raw_config.get("electron_tool_permissions_path")
    )
    skills_bundled_root = _as_nullable_string(raw_config.get("skills_bundled_root"))
    skills_user_root = _as_nullable_string(raw_config.get("skills_user_root"))
    skills_project_root = _as_nullable_string(raw_config.get("skills_project_root"))
    raw_skills_disabled_ids = raw_config.get("skills_disabled_ids")
    skills_disabled_ids = tuple(
        dict.fromkeys(
            item.strip()
            for item in raw_skills_disabled_ids
            if isinstance(item, str) and item.strip()
        )
    )[:256] if isinstance(raw_skills_disabled_ids, (list, tuple)) else ()
    raw_skills_auto_index = _as_non_empty_string(raw_config.get("skills_auto_index"))
    skills_auto_index = (
        raw_skills_auto_index if raw_skills_auto_index in {"auto", "on", "off"} else "auto"
    )
    memory_db_path = _as_nullable_string(raw_config.get("memory_db_path"))
    background_runtime_root = _as_nullable_string(raw_config.get("background_runtime_root"))
    operation_ledger_root = _as_nullable_string(raw_config.get("operation_ledger_root"))
    tools_enabled = _as_bool(raw_config.get("tools_enabled"), default=True)
    tools_glob_enabled = _as_bool(raw_config.get("tools_glob_enabled"), default=True)
    tools_grep_enabled = _as_bool(raw_config.get("tools_grep_enabled"), default=True)
    tools_edit_file_enabled = _as_bool(raw_config.get("tools_edit_file_enabled"), default=True)
    tools_delete_file_enabled = _as_bool(
        raw_config.get("tools_delete_file_enabled"),
        default=True,
    )
    tools_move_file_enabled = _as_bool(
        raw_config.get("tools_move_file_enabled"),
        default=True,
    )
    tools_lsp_enabled = _as_bool(raw_config.get("tools_lsp_enabled"), default=False)
    tools_distill_enabled = _as_bool(raw_config.get("tools_distill_enabled"), default=True)
    tool_call_reliability_net_enabled = _as_bool(
        raw_config.get("tool_call_reliability_net_enabled"), default=True
    )
    tools_lsp_command_typescript = _as_nullable_string(
        raw_config.get("tools_lsp_command_typescript")
    )
    tools_lsp_command_python = _as_nullable_string(raw_config.get("tools_lsp_command_python"))
    electron_tool_bridge_enabled = _as_bool(
        raw_config.get("electron_tool_bridge_enabled"),
        default=False,
    )
    tools_worktree_enabled = _as_bool(raw_config.get("tools_worktree_enabled"), default=False)
    tools_subagents_enabled = _as_bool(raw_config.get("tools_subagents_enabled"), default=True)
    tools_subagent_batch_enabled = tools_subagents_enabled and _as_bool(
        raw_config.get("tools_subagent_batch_enabled"), default=False
    )
    tools_mcp_resources_enabled = _as_bool(
        raw_config.get("tools_mcp_resources_enabled"),
        default=False,
    )
    tools_automations_enabled = _as_bool(
        raw_config.get("tools_automations_enabled"),
        default=False,
    )
    tools_workspace_present_enabled = _as_bool(
        raw_config.get("tools_workspace_present_enabled"),
        default=False,
    )
    tools_preview_test_enabled = _as_bool(
        raw_config.get("tools_preview_test_enabled"),
        default=False,
    )
    tools_verify_enabled = _as_bool(
        raw_config.get("tools_verify_enabled"),
        default=False,
    )
    tools_home_enabled = _as_bool(
        raw_config.get("tools_home_enabled"),
        default=False,
    )
    tools_task_board_enabled = _as_bool(
        raw_config.get("tools_task_board_enabled"),
        default=False,
    )
    tools_rich_files_enabled = _as_bool(
        raw_config.get("tools_rich_files_enabled"),
        default=True,
    )
    tools_knowledge_enabled = _as_bool(
        raw_config.get("tools_knowledge_enabled"),
        default=False,
    )
    knowledge_roots = _normalize_knowledge_roots(raw_config.get("knowledge_roots"))
    tool_policy_snapshot = _normalize_tool_policy_snapshot(raw_config.get("tool_policy_snapshot"))
    tools_shell_enabled = _as_bool(raw_config.get("tools_shell_enabled"), default=False)
    tools_confirm_side_effects = _as_bool(
        raw_config.get("tools_confirm_side_effects"),
        default=True,
    )
    tools_web_enabled = _as_bool(raw_config.get("tools_web_enabled"), default=False)
    tools_image_read_enabled = _as_bool(
        raw_config.get("tools_image_read_enabled"),
        default=False,
    )
    tools_todo_enabled = _as_bool(
        raw_config.get("tools_todo_enabled"),
        default=False,
    )
    tools_connections_enabled = _as_bool(
        raw_config.get("tools_connections_enabled"), default=True
    )
    tools_mermaid_enabled = _as_bool(
        raw_config.get("tools_mermaid_enabled"),
        default=True,
    )
    tools_workspace_manifest_enabled = _as_bool(
        raw_config.get("tools_workspace_manifest_enabled"),
        default=False,
    )
    repo_delta_resume_enabled = _as_bool(
        raw_config.get("repo_delta_resume_enabled"),
        default=False,
    )
    model_identity_overlay_enabled = _as_bool(
        raw_config.get("model_identity_overlay_enabled"),
        default=True,
    )
    session_environment_overlay_enabled = _as_bool(
        raw_config.get("session_environment_overlay_enabled"),
        default=True,
    )
    tool_result_envelope_enabled = _as_bool(
        raw_config.get("tool_result_envelope_enabled"),
        # Default ON since the W1 flip gate (frozen-corpus live eval pass,
        # 2026-08-28); the config key remains the kill switch.
        default=True,
    )
    interrupted_turn_receipts_overlay_enabled = _as_bool(
        raw_config.get("interrupted_turn_receipts_overlay_enabled"),
        default=True,
    )
    tools_task_capsule_enabled = _as_bool(
        raw_config.get("tools_task_capsule_enabled"),
        default=False,
    )
    tools_python_runtime_enabled = _as_bool(
        raw_config.get("tools_python_runtime_enabled"),
        default=False,
    )
    tools_python_runtime_timeout_seconds = _as_bounded_int(
        raw_config.get("tools_python_runtime_timeout_seconds"),
        default=30,
        min_value=1,
        max_value=600,
    )
    tools_python_runtime_max_memory_mb = _as_bounded_int(
        raw_config.get("tools_python_runtime_max_memory_mb"),
        default=512,
        min_value=64,
        max_value=4096,
    )
    tools_python_runtime_interpreter = _as_nullable_string(
        raw_config.get("tools_python_runtime_interpreter")
    )
    tools_python_runtime_root = _as_nullable_string(raw_config.get("tools_python_runtime_root"))
    tools_python_runtime_bundled_python = _as_nullable_string(
        raw_config.get("tools_python_runtime_bundled_python")
    )
    tools_python_runtime_wheelhouse_dir = _as_nullable_string(
        raw_config.get("tools_python_runtime_wheelhouse_dir")
    )
    tools_git_timeout_seconds = _as_bounded_float(
        raw_config.get("tools_git_timeout_seconds"),
        default=20.0,
        min_value=1.0,
        max_value=120.0,
    )
    tools_web_search_provider = (
        _as_non_empty_string(raw_config.get("tools_web_search_provider")) or "duckduckgo"
    )
    tools_web_searxng_url = _as_nullable_string(raw_config.get("tools_web_searxng_url"))
    tools_web_search_provider_keys = _as_string_mapping(
        raw_config.get("tools_web_search_provider_keys")
    )
    tools_web_rate_limit_per_min = _as_bounded_int(
        raw_config.get("tools_web_rate_limit_per_min"),
        default=30,
        min_value=1,
        max_value=300,
    )
    tools_web_max_fetch_bytes = _as_bounded_int(
        raw_config.get("tools_web_max_fetch_bytes"),
        default=1_048_576,
        min_value=1024,
        max_value=10_485_760,
    )
    tools_web_allow_private_addresses = _as_bool(
        raw_config.get("tools_web_allow_private_addresses"),
        default=False,
    )
    tools_max_search_file_bytes = _as_bounded_int(
        raw_config.get("tools_max_search_file_bytes"),
        default=2_097_152,
        min_value=1024,
        max_value=10_485_760,
    )
    tools_max_edit_file_bytes = _as_bounded_int(
        raw_config.get("tools_max_edit_file_bytes"),
        default=2_097_152,
        min_value=1024,
        max_value=10_485_760,
    )
    skills_bundled_enabled = _as_bool(
        raw_config.get("skills_bundled_enabled"),
        default=True,
    )
    skills_user_enabled = _as_bool(
        raw_config.get("skills_user_enabled"),
        default=True,
    )
    tools_load_skill_enabled = _as_bool(
        raw_config.get("tools_load_skill_enabled"),
        default=True,
    )
    skills_project_enabled = _as_bool(
        raw_config.get("skills_project_enabled"),
        default=True,
    )
    mcp_sse_enabled = _as_bool(raw_config.get("mcp_sse_enabled"), default=False)
    mcp_servers = _parse_mcp_servers(
        raw_config.get("mcp_servers"),
        sse_enabled=mcp_sse_enabled,
    )
    diagnostics_log_level = _as_non_empty_string(raw_config.get("diagnostics_log_level")) or "info"
    diagnostics_capture_mode = (
        _as_non_empty_string(raw_config.get("diagnostics_capture_mode")) or "redacted"
    )
    crash_reporting_opt_in = _as_bool(raw_config.get("crash_reporting_opt_in"), default=False)
    feature_flags = normalize_feature_flags(raw_config.get("feature_flags"))
    fallback_models = _parse_fallback_models(raw_config.get("fallback_models"))
    app_profile = _as_non_empty_string(raw_config.get("app_profile")) or ""

    return RuntimeConfig(
        engine_type=engine_type,
        model=model,
        context_length=context_length,
        context_length_override=context_length_override,
        ollama_models_dir=ollama_models_dir,
        ollama_request_timeout_seconds=ollama_request_timeout_seconds,
        replay_script_path=replay_script_path,
        replay_delay_ms=replay_delay_ms,
        codex_cli_enabled=codex_cli_enabled,
        codex_cli_command=codex_cli_command,
        codex_cli_runtime_root=codex_cli_runtime_root,
        codex_cli_models=codex_cli_models,
        codex_cli_request_timeout_seconds=codex_cli_request_timeout_seconds,
        codex_cli_auth_ready=codex_cli_auth_ready,
        codex_cli_auth_reason=codex_cli_auth_reason,
        chatgpt_access_token=chatgpt_access_token,
        openai_compatible_api_key=openai_compatible_api_key,
        chatgpt_account_id=chatgpt_account_id,
        chatgpt_base_url=chatgpt_base_url,
        tools_execution_timeout_seconds=tools_execution_timeout_seconds,
        max_loop_wall_seconds=max_loop_wall_seconds,
        max_loop_iterations=max_loop_iterations,
        max_chat_loop_iterations=max_chat_loop_iterations,
        max_task_loop_iterations=max_task_loop_iterations,
        max_sub_agent_loop_iterations=max_sub_agent_loop_iterations,
        max_sub_agent_concurrency=max_sub_agent_concurrency,
        max_cloud_sub_agent_concurrency=max_cloud_sub_agent_concurrency,
        max_budget_usd=max_budget_usd,
        chunk_inactivity_seconds=chunk_inactivity_seconds,
        chunk_inactivity_seconds_is_override=chunk_inactivity_seconds_is_override,
        model_load_grace_seconds=model_load_grace_seconds,
        assistant_identity=assistant_identity,
        assistant_name=assistant_name,
        api_url=api_url,
        system_prompt_profile=system_prompt_profile,
        system_prompt=system_prompt,
        mode=mode,
        temperature=temperature,
        max_tokens=max_tokens,
        max_inline_payload_bytes=max_inline_payload_bytes,
        token_budget_reserved_for_summary=token_budget_reserved_for_summary,
        token_budget_tool_overhead=token_budget_tool_overhead,
        token_budget_warning_ratio=token_budget_warning_ratio,
        token_budget_auto_compact_ratio=token_budget_auto_compact_ratio,
        token_budget_auto_compact_ratio_by_model=token_budget_auto_compact_ratio_by_model,
        compaction_custom_prompt=compaction_custom_prompt,
        generation_profiles_by_model=generation_profiles_by_model,
        reasoning_effort=reasoning_effort,
        session_start_date=session_start_date,
        safety_mode=safety_mode,
        tool_search_mode=tool_search_mode,
        tool_search_auto_threshold_pct=tool_search_auto_threshold_pct,
        max_tools_per_turn=max_tools_per_turn,
        max_web_tool_calls_per_turn=max_web_tool_calls_per_turn,
        max_code_intelligence_tool_calls_per_turn=max_code_intelligence_tool_calls_per_turn,
        max_tool_calls_per_session=max_tool_calls_per_session,
        cloud_max_chat_loop_iterations=cloud_max_chat_loop_iterations,
        cloud_max_task_loop_iterations=cloud_max_task_loop_iterations,
        cloud_max_loop_wall_seconds=cloud_max_loop_wall_seconds,
        cloud_max_tools_per_turn=cloud_max_tools_per_turn,
        cloud_max_tool_calls_per_session=cloud_max_tool_calls_per_session,
        cloud_max_web_tool_calls_per_turn=cloud_max_web_tool_calls_per_turn,
        cloud_tools_execution_timeout_seconds=cloud_tools_execution_timeout_seconds,
        tools_enabled=tools_enabled,
        tools_glob_enabled=tools_glob_enabled,
        tools_grep_enabled=tools_grep_enabled,
        tools_edit_file_enabled=tools_edit_file_enabled,
        tools_delete_file_enabled=tools_delete_file_enabled,
        tools_move_file_enabled=tools_move_file_enabled,
        tools_lsp_enabled=tools_lsp_enabled,
        tools_distill_enabled=tools_distill_enabled,
        tool_call_reliability_net_enabled=tool_call_reliability_net_enabled,
        tools_lsp_command_typescript=tools_lsp_command_typescript,
        tools_lsp_command_python=tools_lsp_command_python,
        electron_tool_bridge_enabled=electron_tool_bridge_enabled,
        tools_worktree_enabled=tools_worktree_enabled,
        tools_subagents_enabled=tools_subagents_enabled,
        tools_subagent_batch_enabled=tools_subagent_batch_enabled,
        tools_mcp_resources_enabled=tools_mcp_resources_enabled,
        tools_automations_enabled=tools_automations_enabled,
        tools_workspace_present_enabled=tools_workspace_present_enabled,
        tools_preview_test_enabled=tools_preview_test_enabled,
        tools_verify_enabled=tools_verify_enabled,
        tools_home_enabled=tools_home_enabled,
        tools_task_board_enabled=tools_task_board_enabled,
        tools_rich_files_enabled=tools_rich_files_enabled,
        tools_knowledge_enabled=tools_knowledge_enabled,
        knowledge_roots=knowledge_roots,
        tool_policy_snapshot=tool_policy_snapshot,
        tools_shell_enabled=tools_shell_enabled,
        tools_confirm_side_effects=tools_confirm_side_effects,
        tools_web_enabled=tools_web_enabled,
        tools_image_read_enabled=tools_image_read_enabled,
        tools_todo_enabled=tools_todo_enabled,
        tools_mermaid_enabled=tools_mermaid_enabled,
        tools_workspace_manifest_enabled=tools_workspace_manifest_enabled,
        repo_delta_resume_enabled=repo_delta_resume_enabled,
        model_identity_overlay_enabled=model_identity_overlay_enabled,
        session_environment_overlay_enabled=session_environment_overlay_enabled,
        tool_result_envelope_enabled=tool_result_envelope_enabled,
        interrupted_turn_receipts_overlay_enabled=interrupted_turn_receipts_overlay_enabled,
        tools_task_capsule_enabled=tools_task_capsule_enabled,
        tools_python_runtime_enabled=tools_python_runtime_enabled,
        tools_python_runtime_timeout_seconds=tools_python_runtime_timeout_seconds,
        tools_python_runtime_max_memory_mb=tools_python_runtime_max_memory_mb,
        tools_python_runtime_interpreter=tools_python_runtime_interpreter,
        tools_python_runtime_root=tools_python_runtime_root,
        tools_python_runtime_bundled_python=tools_python_runtime_bundled_python,
        tools_python_runtime_wheelhouse_dir=tools_python_runtime_wheelhouse_dir,
        tools_git_timeout_seconds=tools_git_timeout_seconds,
        tools_web_search_provider=tools_web_search_provider,
        tools_web_searxng_url=tools_web_searxng_url,
        tools_web_search_provider_keys=tools_web_search_provider_keys,
        tools_web_rate_limit_per_min=tools_web_rate_limit_per_min,
        tools_web_max_fetch_bytes=tools_web_max_fetch_bytes,
        tools_web_allow_private_addresses=tools_web_allow_private_addresses,
        tools_max_search_file_bytes=tools_max_search_file_bytes,
        tools_max_edit_file_bytes=tools_max_edit_file_bytes,
        tools_workspace_root=tools_workspace_root,
        agent_workspace_root=agent_workspace_root,
        electron_state_root=electron_state_root,
        electron_shell_config_path=electron_shell_config_path,
        electron_sessions_path=electron_sessions_path,
        electron_tool_permissions_path=electron_tool_permissions_path,
        skills_bundled_root=skills_bundled_root,
        skills_user_root=skills_user_root,
        skills_project_root=skills_project_root,
        skills_bundled_enabled=skills_bundled_enabled,
        skills_user_enabled=skills_user_enabled,
        skills_project_enabled=skills_project_enabled,
        skills_disabled_ids=skills_disabled_ids,
        skills_auto_index=skills_auto_index,
        tools_load_skill_enabled=tools_load_skill_enabled,
        tools_connections_enabled=tools_connections_enabled,
        mcp_servers=mcp_servers,
        mcp_sse_enabled=mcp_sse_enabled,
        memory_db_path=memory_db_path,
        background_runtime_root=background_runtime_root,
        operation_ledger_root=operation_ledger_root,
        diagnostics_log_level=diagnostics_log_level,
        diagnostics_capture_mode=diagnostics_capture_mode,
        crash_reporting_opt_in=crash_reporting_opt_in,
        fallback_models=fallback_models,
        feature_flags=feature_flags,
        app_profile=app_profile,
    )


def resolve_memory_db_path(config: RuntimeConfig) -> Path:
    if config.memory_db_path:
        return Path(config.memory_db_path).expanduser()
    return Path.home() / ".companion" / "memory.db"


def resolve_background_runtime_root(config: RuntimeConfig) -> Path:
    if config.background_runtime_root:
        return Path(config.background_runtime_root).expanduser()
    return Path.home() / ".companion" / "background-memory"


def resolve_operation_ledger_root(config: RuntimeConfig | None = None) -> Path:
    # Env wins over config (matching feature-flag precedence): the builtin
    # server subprocess resolves this without a parsed config, so the override
    # is the one channel that reaches it — tests rely on it for hermetic roots.
    env_override = str(os.environ.get("JENNY_OPERATION_LEDGER_ROOT", "")).strip()
    if env_override:
        return Path(env_override).expanduser()
    if config is not None and config.operation_ledger_root:
        return Path(config.operation_ledger_root).expanduser()
    return Path.home() / ".companion" / "operation-ledger"
