"""Engine and tool sections of the runtime config.

``parse_runtime_config`` (config.py) owns the top-level schema, merges these
sections into ``RuntimeConfig`` and applies the hosted/desktop execution-policy
overrides on top of the tool section: the model selection, provider credentials
and identity and per-request generation knobs (``parse_engine_fields``), and the
tool/skill/MCP fields (``parse_tool_fields``). The loop/budget/timeout limits
mirrored by renderer/shared/engine-tuning-schema.js stay in config.py. Every key
here is read as ``raw_config.get("...")`` so
tests/managed-sidecar-config-parity.test.js sees it.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.config_models import SYSTEM_PROMPT_DEFAULT, SYSTEM_PROMPT_PROFILE_AUTO
from sidecar.ai.config_parsing import (
    _as_bool,
    _as_bounded_float,
    _as_bounded_int,
    _as_mapping,
    _as_non_empty_string,
    _as_nullable_string,
    _as_optional_bounded_float,
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
    _parse_mcp_servers,
    normalize_chatgpt_model_catalog,
    parse_conversation_index_config,
    parse_semantic_catalog_config,
)
from sidecar.ai.mode_policy import normalize_mode
from sidecar.ai.personality import normalize_assistant_name

# Fail-soft cap for the custom compaction prompt: oversize input is truncated,
# not rejected, so a pasted prompt never silently disables compaction tuning.
_COMPACTION_CUSTOM_PROMPT_MAX_CHARS = 20_000


def parse_engine_fields(raw_config: dict[str, Any], engine_type: str) -> dict[str, Any]:
    """The model/provider/generation ``RuntimeConfig`` keyword arguments."""
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
        "api-provider",
    }:
        model = ""
    if engine_type in {"chatgpt", "api-provider"} and normalized_model is None:
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
    api_provider_descriptor = _as_mapping(raw_config.get("api_provider_descriptor")) or None
    api_provider_model_limits = _as_mapping(raw_config.get("api_provider_model_limits")) or None
    api_provider_key = _as_nullable_string(raw_config.get("api_provider_key"))
    chatgpt_account_id = _as_nullable_string(raw_config.get("chatgpt_account_id"))
    chatgpt_model_catalog = normalize_chatgpt_model_catalog(raw_config.get("chatgpt_model_catalog"))
    chatgpt_base_url = _as_nullable_string(raw_config.get("chatgpt_base_url"))
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
    compaction_custom_prompt = _as_optional_capped_text(
        raw_config.get("compaction_custom_prompt"),
        max_chars=_COMPACTION_CUSTOM_PROMPT_MAX_CHARS,
    )
    generation_profiles_by_model = _normalize_generation_profiles(
        raw_config.get("generation_profiles_by_model")
    )
    reasoning_effort = _normalize_reasoning_effort(raw_config.get("reasoning_effort"), default="")
    if engine_type == "chatgpt" and raw_config.get("reasoning_effort") == "max":
        reasoning_effort = "max"
    session_start_date = _normalize_session_start_date(raw_config.get("session_start_date"))
    safety_mode = _normalize_safety_mode(raw_config.get("safety_mode"))
    tool_search_mode = _normalize_tool_search_mode(raw_config.get("tool_search_mode"))
    tool_search_auto_threshold_pct = _normalize_tool_search_threshold_pct(
        raw_config.get("tool_search_auto_threshold_pct")
    )

    return dict(
        model=model,
        context_length=context_length,
        context_length_override=context_length_override,
        ollama_models_dir=ollama_models_dir,
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
        api_provider_descriptor=api_provider_descriptor,
        api_provider_model_limits=api_provider_model_limits,
        api_provider_key=api_provider_key,
        managed_prefill_progress=raw_config.get("managed_prefill_progress") is True,
        json_schema_response_format=raw_config.get("json_schema_response_format") is True,
        chatgpt_account_id=chatgpt_account_id,
        chatgpt_model_catalog=chatgpt_model_catalog,
        chatgpt_base_url=chatgpt_base_url,
        assistant_identity=assistant_identity,
        assistant_name=assistant_name,
        api_url=api_url,
        system_prompt_profile=system_prompt_profile,
        system_prompt=system_prompt,
        mode=mode,
        temperature=temperature,
        max_tokens=max_tokens,
        compaction_custom_prompt=compaction_custom_prompt,
        generation_profiles_by_model=generation_profiles_by_model,
        reasoning_effort=reasoning_effort,
        session_start_date=session_start_date,
        safety_mode=safety_mode,
        use_24_hour_time=raw_config.get("use_24_hour_time") is True,
        tool_search_mode=tool_search_mode,
        tool_search_auto_threshold_pct=tool_search_auto_threshold_pct,
    )


def parse_tool_fields(raw_config: dict[str, Any]) -> dict[str, Any]:  # noqa: PLR0915
    """The tool/skill/MCP ``RuntimeConfig`` keyword arguments, before policy overrides."""
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
    tools_browser_use_enabled = _as_bool(
        raw_config.get("tools_browser_use_enabled"),
        default=False,
    )
    tools_verify_enabled = _as_bool(
        raw_config.get("tools_verify_enabled"),
        default=False,
    )
    tools_image_generate_enabled = _as_bool(
        raw_config.get("tools_image_generate_enabled"),
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
    tools_project_notes_enabled = _as_bool(
        raw_config.get("tools_project_notes_enabled"),
        default=False,
    )
    tools_session_directory_enabled = _as_bool(
        raw_config.get("tools_session_directory_enabled"),
        default=False,
    )
    tools_primary_settings_enabled = _as_bool(
        raw_config.get("tools_primary_settings_enabled"),
        default=False,
    )
    tools_primary_chat_manage_enabled = _as_bool(
        raw_config.get("tools_primary_chat_manage_enabled"),
        default=False,
    )
    tools_primary_chat_placement_enabled = _as_bool(
        raw_config.get("tools_primary_chat_placement_enabled"),
        default=False,
    )
    tools_primary_app_view_enabled = _as_bool(
        raw_config.get("tools_primary_app_view_enabled"),
        default=False,
    )
    tools_primary_chat_export_enabled = _as_bool(
        raw_config.get("tools_primary_chat_export_enabled"),
        default=False,
    )
    tools_terminal_enabled = _as_bool(raw_config.get("tools_terminal_enabled"), default=False)
    tools_primary_schedules_enabled = _as_bool(
        raw_config.get("tools_primary_schedules_enabled"),
        default=False,
    )
    tools_primary_digests_enabled = _as_bool(
        raw_config.get("tools_primary_digests_enabled"),
        default=False,
    )
    tools_next_step_enabled = _as_bool(
        raw_config.get("tools_next_step_enabled"),
        default=False,
    )
    tools_memory_enabled = _as_bool(raw_config.get("tools_memory_enabled"), default=True)
    tools_conversations_enabled = _as_bool(
        raw_config.get("tools_conversations_enabled"), default=True,
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
    semantic_catalog = parse_semantic_catalog_config(
        raw_config.get("semantic_catalog"), api_key=raw_config.get("semantic_catalog_api_key")
    )
    conversation_index = parse_conversation_index_config(raw_config.get("conversation_index"))
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
    tools_web_allow_loopback = _as_bool(raw_config.get("tools_web_allow_loopback"), default=False)
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
    # Parsed with the raw SSE flag: the desktop sandbox override in config.py
    # clears mcp_sse_enabled afterwards without re-filtering these rows.
    mcp_servers = _parse_mcp_servers(
        raw_config.get("mcp_servers"),
        sse_enabled=mcp_sse_enabled,
    )

    return dict(
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
        tools_mcp_resources_enabled=tools_mcp_resources_enabled,
        tools_automations_enabled=tools_automations_enabled,
        tools_workspace_present_enabled=tools_workspace_present_enabled,
        tools_preview_test_enabled=tools_preview_test_enabled,
        tools_browser_use_enabled=tools_browser_use_enabled,
        tools_verify_enabled=tools_verify_enabled,
        tools_image_generate_enabled=tools_image_generate_enabled,
        tools_home_enabled=tools_home_enabled,
        tools_task_board_enabled=tools_task_board_enabled,
        tools_project_notes_enabled=tools_project_notes_enabled,
        tools_session_directory_enabled=tools_session_directory_enabled,
        tools_primary_settings_enabled=tools_primary_settings_enabled,
        tools_primary_chat_manage_enabled=tools_primary_chat_manage_enabled,
        tools_primary_chat_placement_enabled=tools_primary_chat_placement_enabled,
        tools_primary_app_view_enabled=tools_primary_app_view_enabled,
        tools_primary_chat_export_enabled=tools_primary_chat_export_enabled,
        tools_terminal_enabled=tools_terminal_enabled,
        tools_primary_schedules_enabled=tools_primary_schedules_enabled,
        tools_primary_digests_enabled=tools_primary_digests_enabled,
        tools_next_step_enabled=tools_next_step_enabled,
        tools_memory_enabled=tools_memory_enabled,
        tools_conversations_enabled=tools_conversations_enabled,
        tools_rich_files_enabled=tools_rich_files_enabled,
        tools_knowledge_enabled=tools_knowledge_enabled,
        knowledge_roots=knowledge_roots,
        semantic_catalog=semantic_catalog,
        conversation_index=conversation_index,
        tool_policy_snapshot=tool_policy_snapshot,
        tools_shell_enabled=tools_shell_enabled,
        tools_confirm_side_effects=tools_confirm_side_effects,
        tools_web_enabled=tools_web_enabled,
        tools_image_read_enabled=tools_image_read_enabled,
        tools_todo_enabled=tools_todo_enabled,
        tools_workspace_manifest_enabled=tools_workspace_manifest_enabled,
        repo_delta_resume_enabled=repo_delta_resume_enabled,
        model_identity_overlay_enabled=model_identity_overlay_enabled,
        session_environment_overlay_enabled=session_environment_overlay_enabled,
        tool_result_envelope_enabled=tool_result_envelope_enabled,
        interrupted_turn_receipts_overlay_enabled=interrupted_turn_receipts_overlay_enabled,
        tools_task_capsule_enabled=tools_task_capsule_enabled,
        tools_python_runtime_enabled=tools_python_runtime_enabled,
        tools_python_runtime_interpreter=tools_python_runtime_interpreter,
        tools_python_runtime_root=tools_python_runtime_root,
        tools_python_runtime_bundled_python=tools_python_runtime_bundled_python,
        tools_python_runtime_wheelhouse_dir=tools_python_runtime_wheelhouse_dir,
        tools_web_search_provider=tools_web_search_provider,
        tools_web_searxng_url=tools_web_searxng_url,
        tools_web_search_provider_keys=tools_web_search_provider_keys,
        tools_web_rate_limit_per_min=tools_web_rate_limit_per_min,
        tools_web_max_fetch_bytes=tools_web_max_fetch_bytes,
        tools_web_allow_private_addresses=tools_web_allow_private_addresses,
        tools_web_allow_loopback=tools_web_allow_loopback,
        tools_max_search_file_bytes=tools_max_search_file_bytes,
        tools_max_edit_file_bytes=tools_max_edit_file_bytes,
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
    )
