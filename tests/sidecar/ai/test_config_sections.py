"""The engine/tool config sections that ``parse_runtime_config`` merges (config_sections.py)."""

from __future__ import annotations

from dataclasses import fields

from sidecar.ai import config, config_sections
from sidecar.ai.config_models import RuntimeConfig


def test_sections_and_limits_cover_every_parsed_field_exactly_once() -> None:
    engine = config_sections.parse_engine_fields({}, "mock")
    tools = config_sections.parse_tool_fields({})
    limits = config._parse_limit_fields({})
    state = config._parse_state_fields({})
    sections = [set(engine), set(tools), set(limits), set(state)]
    for index, keys in enumerate(sections):
        for other in sections[index + 1:]:
            assert not keys & other, keys & other
    covered = set().union(*sections)
    # parse_runtime_config sets these itself; resolved_app_profile_* is computed post-parse.
    owned_by_parse = {
        "engine_type", "host_mode", "host_execution_policy_version",
        "host_execution_worker_enabled", "desktop_execution_policy_version",
        "desktop_command_workspace", "auto_approve_streak_cap", "ui_language", "fallback_models", "app_profile",
        "feature_flags",
    }
    # Resolved after parsing, never read from the raw payload.
    resolved_later = {"resolved_user_max_output_tokens"}
    expected = {
        f.name for f in fields(RuntimeConfig) if not f.name.startswith("resolved_app_profile_")
    }
    assert covered | owned_by_parse | resolved_later == expected


def test_engine_section_blanks_the_model_for_cloud_engines_without_one() -> None:
    assert config_sections.parse_engine_fields({}, "chatgpt")["model"] == ""
    assert config_sections.parse_engine_fields({}, "mock")["model"] == "mock-v1"
    assert config_sections.parse_engine_fields({"model": "  "}, "ollama")["model"] == ""


def test_engine_section_keeps_max_reasoning_effort_for_chatgpt_only() -> None:
    raw = {"reasoning_effort": "max"}
    assert config_sections.parse_engine_fields(raw, "chatgpt")["reasoning_effort"] == "max"
    assert config_sections.parse_engine_fields(raw, "ollama")["reasoning_effort"] != "max"


def test_tool_section_dedupes_and_caps_disabled_skill_ids() -> None:
    raw = {"skills_disabled_ids": [" a ", "a", "", 3, "b"] + [f"s{i}" for i in range(300)]}
    ids = config_sections.parse_tool_fields(raw)["skills_disabled_ids"]
    assert ids[:2] == ("a", "b")
    assert len(ids) == 256


def test_desktop_sandbox_override_lands_on_the_tool_section_values() -> None:
    parsed = config.parse_runtime_config(
        {
            "desktop_execution_policy_version": 1,
            "tools_python_runtime_enabled": True,
            "tools_shell_enabled": False,
            "mcp_sse_enabled": True,
            "feature_flags": {"git_tracking": True},
        }
    )
    assert parsed.tools_python_runtime_enabled is False
    assert parsed.tools_shell_enabled is True
    assert parsed.mcp_sse_enabled is False
    assert parsed.electron_tool_bridge_enabled is True
    assert parsed.feature_flags["git_tracking"] is False
