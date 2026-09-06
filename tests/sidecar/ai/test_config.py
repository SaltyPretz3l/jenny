from __future__ import annotations

import logging
from pathlib import Path

import pytest

from sidecar.ai.config import (
    FallbackModelConfig,
    MCPServerAuth,
    parse_runtime_config,
    resolve_background_runtime_root,
    resolve_effective_max_tokens,
)
from sidecar.ai.config_models import SYSTEM_PROMPT_PROFILE_COMPANION
from sidecar.ai.error_codes import CMP_MCP_CONFIG_INVALID
from sidecar.ai.tools.contracts import ToolExecutionFailure


def test_parse_runtime_config_reads_modifier_fields() -> None:
    config = parse_runtime_config(
        {
            "engine_type": "vllm",
            "model": "Qwen/Qwen3.5-9B",
            "ollama_models_dir": "G:/Ollama",
            "ollama_request_timeout_seconds": 420,
            "temperature": 0.35,
            "max_tokens": 8192,
            "reasoning_effort": "med",
        }
    )
    assert config.engine_type == "vllm"
    assert config.model == "Qwen/Qwen3.5-9B"
    assert config.ollama_models_dir == "G:/Ollama"
    assert config.ollama_request_timeout_seconds == 420
    assert config.temperature == 0.35
    assert config.max_tokens == 8192
    assert config.reasoning_effort == "medium"


def test_parse_runtime_config_bounds_generation_profiles_per_model() -> None:
    config = parse_runtime_config(
        {
            "generation_profiles_by_model": {
                "gemma3:latest": {
                    "temperature": 0.6,
                    "topK": 20,
                    "topP": 9,
                    "maxOutputTokens": 4096,
                },
                "broken": {"temperature": "hot"},
            }
        }
    )
    assert config.generation_profiles_by_model == {
        "gemma3:latest": {"temperature": 0.6, "topK": 20, "maxOutputTokens": 4096}
    }
    assert resolve_effective_max_tokens(16384, 8192, user_override=4096) == 4096
    assert resolve_effective_max_tokens(16384, 8192, user_override=16_384) == 8192


def test_parse_runtime_config_bounds_context_length_override() -> None:
    assert parse_runtime_config({}).context_length_override is None
    assert (
        parse_runtime_config({"context_length_override": 131_072}).context_length_override
        == 131_072
    )
    assert parse_runtime_config({"context_length_override": 0}).context_length_override is None
    assert (
        parse_runtime_config({"context_length_override": 262_145}).context_length_override is None
    )
    assert (
        parse_runtime_config({"context_length_override": "not-a-number"}).context_length_override
        is None
    )


def test_parse_runtime_config_reads_web_search_provider_fields() -> None:
    config = parse_runtime_config(
        {
            "tools_web_search_provider": "searxng",
            "tools_web_searxng_url": " https://searx.example.com ",
            "tools_web_search_provider_keys": {
                "brave": " brave-key ",
                "google_pse": "gkey",
                "google_pse_cx": "gcx",
            },
        }
    )
    assert config.tools_web_search_provider == "searxng"
    assert config.tools_web_searxng_url == "https://searx.example.com"
    assert config.tools_web_search_provider_keys == {
        "brave": "brave-key",
        "google_pse": "gkey",
        "google_pse_cx": "gcx",
    }


def test_parse_runtime_config_web_search_provider_fields_default_none() -> None:
    config = parse_runtime_config({})
    assert config.tools_web_search_provider == "duckduckgo"
    assert config.tools_web_searxng_url is None
    assert config.tools_web_search_provider_keys is None


def test_parse_runtime_config_web_search_provider_fields_tolerate_malformed() -> None:
    config = parse_runtime_config(
        {
            "tools_web_searxng_url": 123,
            "tools_web_search_provider_keys": {
                "brave": "",
                "tavily": None,
                42: "dropped",
                "serper": ["not", "a", "string"],
                "  ": "blank-name",
            },
        }
    )
    assert config.tools_web_searxng_url is None
    assert config.tools_web_search_provider_keys is None

    listy = parse_runtime_config({"tools_web_search_provider_keys": ["brave"]})
    assert listy.tools_web_search_provider_keys is None


def test_parse_runtime_config_reads_compaction_tunability_fields() -> None:
    config = parse_runtime_config(
        {
            "token_budget_auto_compact_ratio_by_model": {
                " qwen3:8b ": 0.5,
                "gemma4:12b": 0.85,
            },
            "compaction_custom_prompt": "  Summarise tersely.  ",
        }
    )

    assert config.token_budget_auto_compact_ratio_by_model == {
        "qwen3:8b": 0.5,
        "gemma4:12b": 0.85,
    }
    assert config.compaction_custom_prompt == "Summarise tersely."


def test_parse_runtime_config_compaction_tunability_defaults_none() -> None:
    config = parse_runtime_config({})

    assert config.token_budget_auto_compact_ratio_by_model is None
    assert config.compaction_custom_prompt is None


def test_parse_runtime_config_compaction_tunability_tolerates_malformed() -> None:
    config = parse_runtime_config(
        {
            "token_budget_auto_compact_ratio_by_model": {
                "qwen3:8b": 0.5,
                "too-low": 0.01,
                "too-high": 1.5,
                "not-a-number": "0.5",
                42: 0.5,
                "  ": 0.5,
                "none-value": None,
            },
            "compaction_custom_prompt": 123,
        }
    )

    assert config.token_budget_auto_compact_ratio_by_model == {"qwen3:8b": 0.5}
    assert config.compaction_custom_prompt is None

    listy = parse_runtime_config({"token_budget_auto_compact_ratio_by_model": [0.5]})
    assert listy.token_budget_auto_compact_ratio_by_model is None

    all_invalid = parse_runtime_config({"token_budget_auto_compact_ratio_by_model": {"m": "bad"}})
    assert all_invalid.token_budget_auto_compact_ratio_by_model is None

    blank_prompt = parse_runtime_config({"compaction_custom_prompt": "   "})
    assert blank_prompt.compaction_custom_prompt is None


def test_parse_runtime_config_compaction_custom_prompt_truncates_oversize() -> None:
    oversized = "x" * 60_000
    config = parse_runtime_config({"compaction_custom_prompt": oversized})

    assert config.compaction_custom_prompt is not None
    assert len(config.compaction_custom_prompt) == 20_000
    assert config.compaction_custom_prompt == "x" * 20_000


def test_parse_runtime_config_reads_repo_delta_resume_enabled() -> None:
    config = parse_runtime_config({"repo_delta_resume_enabled": True})
    assert config.repo_delta_resume_enabled is True


def test_parse_runtime_config_repo_delta_resume_enabled_defaults_false() -> None:
    config = parse_runtime_config({})
    assert config.repo_delta_resume_enabled is False


def test_parse_runtime_config_model_identity_overlay_enabled_defaults_true() -> None:
    """Default-on per project convention, unlike repo_delta_resume_enabled."""
    config = parse_runtime_config({})
    assert config.model_identity_overlay_enabled is True


def test_parse_runtime_config_reads_model_identity_overlay_enabled_false() -> None:
    config = parse_runtime_config({"model_identity_overlay_enabled": False})
    assert config.model_identity_overlay_enabled is False


def test_parse_runtime_config_accepts_crash_reporting_opt_in() -> None:
    """The Electron-threaded consent key parses as a known field (no
    ai.config.unknown_keys drift warning for a key we deliberately send)."""
    assert parse_runtime_config({}).crash_reporting_opt_in is False
    assert parse_runtime_config({"crash_reporting_opt_in": True}).crash_reporting_opt_in is True
    # Non-bool fails closed.
    assert parse_runtime_config({"crash_reporting_opt_in": "yes"}).crash_reporting_opt_in is False


def test_parse_runtime_config_preserves_explicit_blank_ollama_model() -> None:
    config = parse_runtime_config(
        {
            "engine_type": "ollama",
            "model": "   ",
        }
    )

    assert config.engine_type == "ollama"
    assert config.model == ""


def test_parse_runtime_config_preserves_explicit_blank_codex_cli_model() -> None:
    config = parse_runtime_config(
        {
            "engine_type": "codex-cli",
            "model": "   ",
        }
    )

    assert config.engine_type == "codex-cli"
    assert config.model == ""


def test_parse_runtime_config_normalizes_invalid_modifier_values() -> None:
    config = parse_runtime_config(
        {
            "temperature": 99,
            "max_tokens": -1,
            "reasoning_effort": "ultra",
        }
    )
    assert config.temperature == 0.7
    assert config.max_tokens == 16384
    assert config.reasoning_effort == ""


def test_parse_runtime_config_reads_max_tools_per_turn() -> None:
    config = parse_runtime_config({"max_tools_per_turn": 10})
    assert config.max_tools_per_turn == 10


def test_parse_runtime_config_clamps_max_tools_per_turn_to_bounds() -> None:
    assert parse_runtime_config({"max_tools_per_turn": 0}).max_tools_per_turn == 20
    assert parse_runtime_config({"max_tools_per_turn": 200}).max_tools_per_turn == 20


@pytest.mark.parametrize(
    "invalid_value",
    [float("nan"), float("inf"), float("-inf"), 3.5, True],
)
def test_parse_runtime_config_rejects_nonfinite_or_non_integral_integer_fields(
    invalid_value: object,
) -> None:
    config = parse_runtime_config({"max_tools_per_turn": invalid_value})
    snapshot_config = parse_runtime_config(
        {"tool_policy_snapshot": {"version": invalid_value, "rules": []}}
    )

    assert config.max_tools_per_turn == 20
    assert snapshot_config.tool_policy_snapshot is not None
    assert snapshot_config.tool_policy_snapshot.version == 1


def test_parse_runtime_config_defaults_max_tools_per_turn() -> None:
    config = parse_runtime_config({})
    assert config.max_tools_per_turn == 20


def test_parse_runtime_config_reads_loop_caps() -> None:
    config = parse_runtime_config(
        {
            "max_loop_iterations": 12,
            "max_chat_loop_iterations": 10,
            "max_task_loop_iterations": 28,
            "max_sub_agent_concurrency": 3,
            "max_cloud_sub_agent_concurrency": 2,
        }
    )

    assert config.max_loop_iterations == 12
    assert config.max_chat_loop_iterations == 10
    assert config.max_task_loop_iterations == 28
    assert config.max_sub_agent_concurrency == 3
    assert config.max_cloud_sub_agent_concurrency == 2


def test_parse_runtime_config_defaults_loop_caps() -> None:
    config = parse_runtime_config({})

    assert config.max_loop_iterations == 8
    assert config.max_chat_loop_iterations == 8
    assert config.max_task_loop_iterations == 30
    assert config.max_sub_agent_loop_iterations == 10
    assert config.max_sub_agent_concurrency == 1
    assert config.max_cloud_sub_agent_concurrency == 3


def test_parse_runtime_config_clamps_loop_caps() -> None:
    assert parse_runtime_config({"max_loop_iterations": 0}).max_loop_iterations == 8
    assert parse_runtime_config({"max_loop_iterations": 99}).max_loop_iterations == 8
    assert parse_runtime_config({"max_chat_loop_iterations": 0}).max_chat_loop_iterations == 8
    assert parse_runtime_config({"max_chat_loop_iterations": 99}).max_chat_loop_iterations == 8
    assert parse_runtime_config({"max_task_loop_iterations": 0}).max_task_loop_iterations == 30
    assert parse_runtime_config({"max_task_loop_iterations": 99}).max_task_loop_iterations == 30
    assert (
        parse_runtime_config({"max_sub_agent_loop_iterations": 0}).max_sub_agent_loop_iterations
        == 10
    )
    assert (
        parse_runtime_config({"max_sub_agent_loop_iterations": 99}).max_sub_agent_loop_iterations
        == 10
    )
    assert parse_runtime_config({"max_sub_agent_concurrency": 0}).max_sub_agent_concurrency == 1
    assert parse_runtime_config({"max_sub_agent_concurrency": 99}).max_sub_agent_concurrency == 1
    assert (
        parse_runtime_config({"max_cloud_sub_agent_concurrency": 0}).max_cloud_sub_agent_concurrency
        == 3
    )
    assert (
        parse_runtime_config({"max_cloud_sub_agent_concurrency": 4}).max_cloud_sub_agent_concurrency
        == 3
    )


def test_parse_runtime_config_reads_phase10_tool_budget_caps() -> None:
    config = parse_runtime_config(
        {
            "max_web_tool_calls_per_turn": 3,
            "max_tool_calls_per_session": 80,
        }
    )

    assert config.max_web_tool_calls_per_turn == 3
    assert config.max_tool_calls_per_session == 80


def test_parse_runtime_config_defaults_phase10_tool_budget_caps() -> None:
    config = parse_runtime_config({})

    assert config.max_web_tool_calls_per_turn == 10
    assert config.max_tool_calls_per_session == 200


def test_parse_runtime_config_defaults_cloud_loop_profile_caps() -> None:
    config = parse_runtime_config({})

    assert config.cloud_max_chat_loop_iterations == 40
    assert config.cloud_max_task_loop_iterations == 300
    assert config.cloud_max_loop_wall_seconds == 28_800.0
    assert config.cloud_max_tools_per_turn == 200
    assert config.cloud_max_tool_calls_per_session == 2_000
    assert config.cloud_max_web_tool_calls_per_turn == 30
    assert config.cloud_tools_execution_timeout_seconds == 1_800.0


def test_parse_runtime_config_reads_cloud_loop_profile_caps() -> None:
    config = parse_runtime_config(
        {
            "cloud_max_chat_loop_iterations": 25,
            "cloud_max_task_loop_iterations": 150,
            "cloud_max_loop_wall_seconds": 7_200.0,
            "cloud_max_tools_per_turn": 90,
            "cloud_max_tool_calls_per_session": 1_500,
            "cloud_max_web_tool_calls_per_turn": 55,
            "cloud_tools_execution_timeout_seconds": 900.0,
        }
    )

    assert config.cloud_max_chat_loop_iterations == 25
    assert config.cloud_max_task_loop_iterations == 150
    assert config.cloud_max_loop_wall_seconds == 7_200.0
    assert config.cloud_max_tools_per_turn == 90
    assert config.cloud_max_tool_calls_per_session == 1_500
    assert config.cloud_max_web_tool_calls_per_turn == 55
    assert config.cloud_tools_execution_timeout_seconds == 900.0


def test_parse_runtime_config_clamps_cloud_loop_profile_caps() -> None:
    # Out-of-range values fail open to the cloud defaults; the cloud bounds are
    # deliberately wider than the local keys' bounds.
    assert (
        parse_runtime_config({"cloud_max_chat_loop_iterations": 0}).cloud_max_chat_loop_iterations
        == 40
    )
    assert (
        parse_runtime_config(
            {"cloud_max_task_loop_iterations": 5_000}
        ).cloud_max_task_loop_iterations
        == 300
    )
    assert (
        parse_runtime_config({"cloud_max_loop_wall_seconds": 10.0}).cloud_max_loop_wall_seconds
        == 28_800.0
    )
    assert (
        parse_runtime_config({"cloud_max_loop_wall_seconds": 100_000.0}).cloud_max_loop_wall_seconds
        == 28_800.0
    )
    assert parse_runtime_config({"cloud_max_tools_per_turn": 900}).cloud_max_tools_per_turn == 200
    assert (
        parse_runtime_config(
            {"cloud_max_tool_calls_per_session": 5_000}
        ).cloud_max_tool_calls_per_session
        == 2_000
    )
    assert (
        parse_runtime_config(
            {"cloud_max_web_tool_calls_per_turn": 500}
        ).cloud_max_web_tool_calls_per_turn
        == 30
    )
    assert (
        parse_runtime_config(
            {"cloud_tools_execution_timeout_seconds": 7_200.0}
        ).cloud_tools_execution_timeout_seconds
        == 1_800.0
    )


def test_parse_runtime_config_cloud_bounds_admit_values_the_local_bounds_reject() -> None:
    # The local keys cap wall clock at 3600s / tool timeout at 600s / tools per
    # turn at 100 / session calls at 1000; the cloud keys must accept more.
    # 2026-08-30: local wall-clock default raised to 1800s, ceiling to 3600s.
    config = parse_runtime_config(
        {
            "max_loop_wall_seconds": 28_800.0,
            "tools_execution_timeout_seconds": 1_800.0,
            "max_tools_per_turn": 200,
            "max_tool_calls_per_session": 2_000,
            "cloud_max_loop_wall_seconds": 28_800.0,
            "cloud_tools_execution_timeout_seconds": 1_800.0,
            "cloud_max_tools_per_turn": 200,
            "cloud_max_tool_calls_per_session": 2_000,
        }
    )

    assert config.max_loop_wall_seconds == 1_800.0
    assert config.tools_execution_timeout_seconds == 120.0
    assert config.max_tools_per_turn == 20
    assert config.max_tool_calls_per_session == 200
    assert config.cloud_max_loop_wall_seconds == 28_800.0
    assert config.cloud_tools_execution_timeout_seconds == 1_800.0
    assert config.cloud_max_tools_per_turn == 200
    assert config.cloud_max_tool_calls_per_session == 2_000


def test_parse_runtime_config_reads_max_inline_payload_bytes() -> None:
    config = parse_runtime_config({"max_inline_payload_bytes": 32_768})
    assert config.max_inline_payload_bytes == 32_768


def test_parse_runtime_config_clamps_max_inline_payload_bytes() -> None:
    assert (
        parse_runtime_config({"max_inline_payload_bytes": 1000}).max_inline_payload_bytes == 65_536
    )
    assert (
        parse_runtime_config({"max_inline_payload_bytes": 5_000_000}).max_inline_payload_bytes
        == 65_536
    )


def test_parse_runtime_config_defaults_max_inline_payload_bytes() -> None:
    assert parse_runtime_config({}).max_inline_payload_bytes == 65_536


def test_parse_runtime_config_reads_safety_mode() -> None:
    assert parse_runtime_config({"safety_mode": "strict"}).safety_mode == "strict"
    assert parse_runtime_config({"safety_mode": "PARANOID"}).safety_mode == "paranoid"


def test_parse_runtime_config_defaults_invalid_safety_mode() -> None:
    assert parse_runtime_config({}).safety_mode == "normal"
    assert parse_runtime_config({"safety_mode": "anything"}).safety_mode == "normal"


def test_parse_runtime_config_reads_max_budget_usd() -> None:
    config = parse_runtime_config({"max_budget_usd": 12.5})
    assert config.max_budget_usd == 12.5


def test_parse_runtime_config_defaults_max_budget_usd() -> None:
    assert parse_runtime_config({}).max_budget_usd is None


def test_parse_runtime_config_rejects_invalid_max_budget_usd() -> None:
    assert parse_runtime_config({"max_budget_usd": 0}).max_budget_usd is None
    assert parse_runtime_config({"max_budget_usd": -1}).max_budget_usd is None
    assert parse_runtime_config({"max_budget_usd": 2_000_000}).max_budget_usd is None
    assert parse_runtime_config({"max_budget_usd": "10"}).max_budget_usd is None


def test_parse_runtime_config_reads_search_tool_fields() -> None:
    config = parse_runtime_config(
        {
            "tools_glob_enabled": False,
            "tools_grep_enabled": False,
            "tools_edit_file_enabled": False,
            "tools_lsp_enabled": True,
            "tools_lsp_command_typescript": "typescript-language-server",
            "tools_lsp_command_python": "pyright-langserver",
            "tools_mermaid_enabled": True,
            "electron_tool_bridge_enabled": True,
            "tools_subagents_enabled": True,
            "tools_subagent_batch_enabled": True,
            "tools_mcp_resources_enabled": True,
            "tools_automations_enabled": True,
            "tools_workspace_present_enabled": True,
            "tools_home_enabled": True,
            "tools_rich_files_enabled": True,
            "tools_workspace_manifest_enabled": True,
            "tools_task_capsule_enabled": True,
            "tools_image_read_enabled": True,
            "tools_max_search_file_bytes": 4096,
            "tools_max_edit_file_bytes": 8192,
        }
    )

    assert config.tools_glob_enabled is False
    assert config.tools_grep_enabled is False
    assert config.tools_edit_file_enabled is False
    assert config.tools_lsp_enabled is True
    assert config.tools_lsp_command_typescript == "typescript-language-server"
    assert config.tools_lsp_command_python == "pyright-langserver"
    assert config.tools_mermaid_enabled is True
    assert config.electron_tool_bridge_enabled is True
    assert config.tools_subagents_enabled is True
    assert config.tools_subagent_batch_enabled is True
    assert config.tools_mcp_resources_enabled is True
    assert config.tools_automations_enabled is True
    assert config.tools_workspace_present_enabled is True
    assert config.tools_home_enabled is True
    assert config.tools_rich_files_enabled is True
    assert config.tools_workspace_manifest_enabled is True
    assert config.tools_task_capsule_enabled is True
    assert config.tools_image_read_enabled is True
    assert config.tools_max_search_file_bytes == 4096
    assert config.tools_max_edit_file_bytes == 8192


def test_parse_runtime_config_defaults_search_tool_fields() -> None:
    config = parse_runtime_config({})

    assert config.tools_glob_enabled is True
    assert config.tools_grep_enabled is True
    assert config.tools_edit_file_enabled is True
    assert config.tools_lsp_enabled is False
    assert config.tools_lsp_command_typescript is None
    assert config.tools_lsp_command_python is None
    # Mermaid is default-on so "create a visual" requests have a fast diagram tool.
    assert config.tools_mermaid_enabled is True
    assert config.electron_tool_bridge_enabled is False
    assert config.tools_subagents_enabled is True
    assert config.tools_subagent_batch_enabled is False
    assert config.tools_mcp_resources_enabled is False
    assert config.tools_automations_enabled is False
    assert config.tools_workspace_present_enabled is False
    assert config.tools_home_enabled is False
    assert config.tools_rich_files_enabled is True
    assert config.tools_workspace_manifest_enabled is False
    assert config.tools_task_capsule_enabled is False
    assert config.tools_image_read_enabled is False
    assert config.tools_max_search_file_bytes == 2_097_152
    assert config.tools_max_edit_file_bytes == 2_097_152


def test_parse_runtime_config_batch_gate_cannot_bypass_subagent_permission() -> None:
    config = parse_runtime_config(
        {
            "tools_subagents_enabled": False,
            "tools_subagent_batch_enabled": True,
        }
    )

    assert config.tools_subagents_enabled is False
    assert config.tools_subagent_batch_enabled is False


def test_parse_runtime_config_reads_knowledge_fields() -> None:
    config = parse_runtime_config(
        {
            "tools_knowledge_enabled": True,
            "knowledge_roots": ["C:\\docs\\project-x", "  ", 42, "C:\\docs\\other"],
        }
    )

    assert config.tools_knowledge_enabled is True
    # Blank and non-string entries are dropped; order is preserved.
    assert config.knowledge_roots == ("C:\\docs\\project-x", "C:\\docs\\other")


def test_parse_runtime_config_defaults_knowledge_fields() -> None:
    config = parse_runtime_config({})

    assert config.tools_knowledge_enabled is False
    assert config.knowledge_roots == ()


def test_parse_runtime_config_rejects_malformed_knowledge_fields() -> None:
    assert parse_runtime_config({"knowledge_roots": "not-a-list"}).knowledge_roots == ()
    assert parse_runtime_config({"knowledge_roots": {"a": 1}}).knowledge_roots == ()
    assert parse_runtime_config({"tools_knowledge_enabled": "yes"}).tools_knowledge_enabled is False


def test_parse_runtime_config_chunk_inactivity_seconds_default_and_bounds() -> None:
    # Default raised 60->120 so large local "thinking" models that pause between
    # output chunks are not killed by the stream inactivity watchdog out of the box.
    assert parse_runtime_config({}).chunk_inactivity_seconds == 120.0
    assert parse_runtime_config({}).chunk_inactivity_seconds_is_override is False
    # An in-range override is honored.
    assert parse_runtime_config({"chunk_inactivity_seconds": 180}).chunk_inactivity_seconds == 180.0
    assert (
        parse_runtime_config(
            {
                "chunk_inactivity_seconds": 60,
                "chunk_inactivity_seconds_is_override": True,
            }
        ).chunk_inactivity_seconds_is_override
        is True
    )
    # Out-of-range values (below 5 / above 300) fall back to the default.
    assert parse_runtime_config({"chunk_inactivity_seconds": 1}).chunk_inactivity_seconds == 120.0
    assert (
        parse_runtime_config({"chunk_inactivity_seconds": 9999}).chunk_inactivity_seconds == 120.0
    )


def test_parse_runtime_config_model_load_grace_seconds_default_and_bounds() -> None:
    # Separate, longer grace for the FIRST chunk only (covers model (re)load into
    # VRAM, which emits no output); default 300 matches the Ollama request timeout.
    assert parse_runtime_config({}).model_load_grace_seconds == 300.0
    # An in-range override is honored.
    assert parse_runtime_config({"model_load_grace_seconds": 600}).model_load_grace_seconds == 600.0
    # Out-of-range values (below 60 / above 1800) fall back to the default.
    assert parse_runtime_config({"model_load_grace_seconds": 5}).model_load_grace_seconds == 300.0
    assert (
        parse_runtime_config({"model_load_grace_seconds": 99999}).model_load_grace_seconds == 300.0
    )


def test_parse_runtime_config_clamps_invalid_search_file_size() -> None:
    config = parse_runtime_config(
        {"tools_max_search_file_bytes": 1, "tools_max_edit_file_bytes": 1}
    )

    assert config.tools_max_search_file_bytes == 2_097_152
    assert config.tools_max_edit_file_bytes == 2_097_152


def test_parse_runtime_config_reads_mcp_resource_limits() -> None:
    config = parse_runtime_config(
        {
            "mcp_servers": [
                {
                    "name": "docs",
                    "transport": "stdio",
                    "command": "docs-mcp",
                    "memory_limit_mb": 256,
                    "max_processes": 3,
                    "max_open_files": 128,
                    "cpu_warning_seconds": 45,
                }
            ]
        }
    )

    server = config.mcp_servers[0]
    assert server.memory_limit_mb == 256
    assert server.max_processes == 3
    assert server.max_open_files == 128
    assert server.cpu_warning_seconds == 45.0


def test_parse_runtime_config_defaults_invalid_mcp_resource_limits() -> None:
    config = parse_runtime_config(
        {
            "mcp_servers": [
                {
                    "name": "docs",
                    "transport": "stdio",
                    "command": "docs-mcp",
                    "memory_limit_mb": 1,
                    "max_processes": 0,
                    "max_open_files": 999999,
                    "cpu_warning_seconds": 0,
                }
            ]
        }
    )

    server = config.mcp_servers[0]
    assert server.memory_limit_mb == 512
    assert server.max_processes == 5
    assert server.max_open_files == 256
    assert server.cpu_warning_seconds == 30.0


def test_parse_runtime_config_reads_mcp_sse_server_with_bearer_auth() -> None:
    config = parse_runtime_config(
        {
            "mcp_sse_enabled": True,
            "mcp_servers": [
                {
                    "name": "remote-docs",
                    "transport": "sse",
                    "url": "https://mcp.example.com/sse",
                    "init_timeout_seconds": 45,
                    "auth": {
                        "kind": "bearer",
                        "token": "s3cr3t-token-literal",
                    },
                }
            ],
        }
    )

    server = config.mcp_servers[0]
    assert server.init_timeout_seconds == 45.0
    assert server.auth is not None
    assert server.auth.kind == "bearer"
    assert server.auth.token == "s3cr3t-token-literal"
    assert server.auth.token_url is None
    assert server.auth.client_id is None
    assert server.auth.client_secret is None
    assert server.auth.scope is None


def test_parse_runtime_config_reads_mcp_sse_server_with_oauth_client_credentials_auth() -> None:
    config = parse_runtime_config(
        {
            "mcp_sse_enabled": True,
            "mcp_servers": [
                {
                    "name": "remote-docs",
                    "transport": "sse",
                    "url": "https://mcp.example.com/sse",
                    "auth": {
                        "kind": "OAUTH_CLIENT_CREDENTIALS",
                        "token_url": "https://auth.example.com/token",
                        "client_id": "client-abc",
                        "client_secret": "s3cr3t-cc",
                        "scope": "mcp.read mcp.write",
                    },
                }
            ],
        }
    )

    server = config.mcp_servers[0]
    assert server.auth is not None
    assert server.auth.kind == "oauth_client_credentials"
    assert server.auth.token_url == "https://auth.example.com/token"
    assert server.auth.client_id == "client-abc"
    assert server.auth.client_secret == "s3cr3t-cc"
    assert server.auth.scope == "mcp.read mcp.write"
    assert server.auth.token is None


def test_parse_runtime_config_mcp_server_defaults_new_fields_when_unset() -> None:
    config = parse_runtime_config(
        {
            "mcp_servers": [
                {
                    "name": "docs",
                    "transport": "stdio",
                    "command": "docs-mcp",
                }
            ]
        }
    )

    server = config.mcp_servers[0]
    assert server.init_timeout_seconds == 30.0
    assert server.auth is None
    # Existing parse results remain unchanged when new fields are absent.
    assert server.name == "docs"
    assert server.transport == "stdio"
    assert server.command == "docs-mcp"


def test_mcp_server_auth_repr_and_str_redact_secrets() -> None:
    auth = MCPServerAuth(
        kind="bearer",
        token="s3cr3t-token-literal",
    )
    oauth_auth = MCPServerAuth(
        kind="oauth_client_credentials",
        token_url="https://auth.example.com/token",
        client_id="client-abc",
        client_secret="s3cr3t-cc",
        scope="mcp.read",
    )

    for rendered in (repr(auth), str(auth), repr(oauth_auth), str(oauth_auth)):
        assert "s3cr3t-token-literal" not in rendered
        assert "s3cr3t-cc" not in rendered

    assert "token='***'" in repr(auth)
    assert "client_secret='***'" in repr(oauth_auth)


def test_mcp_server_auth_repr_shows_none_when_secret_unset() -> None:
    auth = MCPServerAuth(kind="bearer")

    rendered = repr(auth)
    assert "token=None" in rendered
    assert "client_secret=None" in rendered


def test_parse_runtime_config_mcp_server_unknown_auth_kind_raises() -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        parse_runtime_config(
            {
                "mcp_sse_enabled": True,
                "mcp_servers": [
                    {
                        "name": "remote-docs",
                        "transport": "sse",
                        "url": "https://mcp.example.com/sse",
                        "auth": {
                            "kind": "totally_bogus_kind",
                            "token": "s3cr3t-token-literal",
                        },
                    }
                ],
            }
        )

    assert excinfo.value.code == CMP_MCP_CONFIG_INVALID
    assert "remote-docs" in excinfo.value.message
    assert "totally_bogus_kind" in excinfo.value.message
    assert "s3cr3t-token-literal" not in excinfo.value.message


def test_parse_runtime_config_reads_diagnostics_preferences() -> None:
    config = parse_runtime_config(
        {
            "diagnostics_log_level": "warning",
            "diagnostics_capture_mode": "sanitized_snippets",
        }
    )

    assert config.diagnostics_log_level == "warning"
    assert config.diagnostics_capture_mode == "sanitized_snippets"


def test_parse_runtime_config_normalizes_session_start_date() -> None:
    config = parse_runtime_config({"session_start_date": " 2026-03-28 "})
    fallback = parse_runtime_config({"session_start_date": "March 28"})

    assert config.session_start_date == "2026-03-28"
    assert fallback.session_start_date == ""


def test_parse_runtime_config_reads_tool_search_preferences() -> None:
    config = parse_runtime_config(
        {
            "tool_search_mode": "tst-auto",
            "tool_search_auto_threshold_pct": 25,
        }
    )

    assert config.tool_search_mode == "tst-auto"
    assert config.tool_search_auto_threshold_pct == 25


def test_parse_runtime_config_warns_for_obsolete_personality_keys(caplog) -> None:
    """Obsolete direct/headless keys remain tolerated but are reported as unknown."""
    obsolete = {
        "personality_workspace_root": " G:/Profiles/Jenny ",
        "personality_profile": "mentor",
        "assistant_custom_text": "Be terse.",
        "custom_text": "Be terse.",
    }
    with caplog.at_level(logging.WARNING, logger="sidecar.ai.config"):
        config = parse_runtime_config(
            {
                "engine_type": "ollama",
                "model": "llama3.2",
                "assistant_identity": {
                    "agentName": "Echo",
                    "profile": "creative",
                    "customText": "Be theatrical.",
                },
                **obsolete,
            }
        )

    assert config.assistant_name == "Echo"
    assert config.assistant_identity == {"agent_name": "Echo"}
    assert config.system_prompt_profile == SYSTEM_PROMPT_PROFILE_COMPANION
    for key in obsolete:
        assert not hasattr(config, key)
    assert not hasattr(config, "personality_profile")
    assert not hasattr(config, "assistant_custom_text")
    # The nested v2 identity halves are dropped, not smuggled through.
    assert "creative" not in str(config.assistant_identity)
    assert "theatrical" not in str(config.assistant_identity)
    warnings = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.config.unknown_keys"
    ]
    assert len(warnings) == 1
    assert warnings[0].data["keys"] == sorted(obsolete)


def test_parse_runtime_config_reads_background_runtime_root() -> None:
    config = parse_runtime_config(
        {"background_runtime_root": " G:/Profiles/Jenny/background-memory "}
    )

    assert config.background_runtime_root == "G:/Profiles/Jenny/background-memory"


def test_resolve_background_runtime_root_defaults_to_companion_directory(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))

    resolved = resolve_background_runtime_root(parse_runtime_config({}))

    assert resolved == tmp_path / ".companion" / "background-memory"


# ---------------------------------------------------------------------------
# Codex CLI engine config parsing
# ---------------------------------------------------------------------------


def test_parse_runtime_config_normalizes_codex_cli_settings() -> None:
    config = parse_runtime_config(
        {
            "engine_type": "codex-cli",
            "model": "codex-cli/gpt-5.5",
            "codex_cli_enabled": True,
            "codex_cli_command": "  C:/Tools/codex.exe  ",
            "codex_cli_runtime_root": "  C:/Users/Jenny/AppData/Roaming/jenny/codex-cli-engine  ",
            "codex_cli_models": [
                " gpt-5.5 ",
                "codex-cli/o4-mini",
                "codex-cli",
                "codex-cli/",
                "",
                7,
            ],
            "codex_cli_request_timeout_seconds": 900,
            "codex_cli_auth_ready": True,
            "codex_cli_auth_reason": "  ready  ",
        }
    )

    assert config.engine_type == "codex-cli"
    assert config.model == "codex-cli/gpt-5.5"
    assert config.codex_cli_enabled is True
    assert config.codex_cli_command == "C:/Tools/codex.exe"
    assert config.codex_cli_runtime_root == "C:/Users/Jenny/AppData/Roaming/jenny/codex-cli-engine"
    assert config.codex_cli_models == ("codex-cli/gpt-5.5", "codex-cli/o4-mini")
    assert config.codex_cli_request_timeout_seconds == 900
    assert config.codex_cli_auth_ready is True
    assert config.codex_cli_auth_reason == "ready"


def test_parse_runtime_config_codex_cli_defaults_fail_closed() -> None:
    config = parse_runtime_config({})

    assert config.codex_cli_enabled is False
    assert config.codex_cli_command is None
    assert config.codex_cli_runtime_root is None
    assert config.codex_cli_models == ()
    assert config.codex_cli_request_timeout_seconds == 300
    assert config.codex_cli_auth_ready is False
    assert config.codex_cli_auth_reason is None


# ---------------------------------------------------------------------------
# Fallback model config parsing (GAP 2)
# ---------------------------------------------------------------------------


def test_parse_runtime_config_reads_fallback_models() -> None:
    config = parse_runtime_config(
        {
            "fallback_models": [
                {"engine_type": "ollama", "model": "qwen3:8b"},
                {"engine_type": "vllm", "model": "Qwen/Qwen3.5-9B"},
            ],
        }
    )
    assert len(config.fallback_models) == 2
    assert config.fallback_models[0] == FallbackModelConfig(engine_type="ollama", model="qwen3:8b")
    assert config.fallback_models[1] == FallbackModelConfig(
        engine_type="vllm",
        model="Qwen/Qwen3.5-9B",
    )


def test_parse_runtime_config_fallback_models_empty_by_default() -> None:
    config = parse_runtime_config({})
    assert config.fallback_models == ()


def test_parse_runtime_config_fallback_models_skips_invalid_entries() -> None:
    config = parse_runtime_config(
        {
            "fallback_models": [
                "not-a-dict",
                {"engine_type": "ollama"},
                {"model": "qwen3:8b"},
                {"engine_type": "", "model": "qwen3:8b"},
                {"engine_type": "ollama", "model": ""},
                {"engine_type": "vllm", "model": "Qwen/Qwen3.5-9B"},
            ],
        }
    )
    assert len(config.fallback_models) == 1
    assert config.fallback_models[0].engine_type == "vllm"


def test_parse_runtime_config_fallback_models_skip_archived_cloud_engines() -> None:
    config = parse_runtime_config(
        {
            "fallback_models": [
                {"engine_type": "openai", "model": "gpt-4.1"},
                {"engine_type": "anthropic", "model": "claude-sonnet"},
                {"engine_type": "gemini", "model": "gemini-pro"},
                {"engine_type": "openai-compatible", "model": "local-compatible"},
                {"engine_type": "ollama", "model": "qwen3:8b"},
            ],
        }
    )

    assert [entry.engine_type for entry in config.fallback_models] == [
        "openai-compatible",
        "ollama",
    ]


def test_parse_runtime_config_fallback_models_reads_max_context_tokens() -> None:
    config = parse_runtime_config(
        {
            "fallback_models": [
                {"engine_type": "ollama", "model": "qwen3:8b", "max_context_tokens": 32768},
            ],
        }
    )
    assert config.fallback_models[0].max_context_tokens == 32768


def test_parse_runtime_config_fallback_models_non_list_ignored() -> None:
    assert parse_runtime_config({"fallback_models": "ollama"}).fallback_models == ()
    assert parse_runtime_config({"fallback_models": 42}).fallback_models == ()
    assert parse_runtime_config({"fallback_models": None}).fallback_models == ()
