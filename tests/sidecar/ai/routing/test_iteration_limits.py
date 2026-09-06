from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.routing.iteration_limits import (
    AGENT_SURFACE_SUB_AGENT,
    append_sub_agent_finalization_message,
    effective_chunk_inactivity_seconds,
    effective_max_loop_wall_seconds,
    effective_max_tool_calls_per_session,
    effective_max_tools_per_turn,
    effective_max_web_tool_calls_per_turn,
    effective_sub_agent_concurrency_budget,
    effective_tools_execution_timeout_seconds,
    is_sub_agent_final_iteration,
    loop_profile_name,
    max_iterations_for_agent_surface,
    max_iterations_for_mode,
    should_emit_wind_down,
    wind_down_threshold,
)

CLOUD_ENGINE_TYPES = ("chatgpt", "codex-cli")
LOCAL_ENGINE_TYPES = ("ollama", "vllm", "openai-compatible", "mock", "replay")


def test_max_iterations_for_mode_uses_q38_chat_and_task_defaults() -> None:
    config = parse_runtime_config({})

    assert max_iterations_for_mode(config, mode="chat") == 8
    assert max_iterations_for_mode(config, mode="assist") == 30
    assert max_iterations_for_mode(config, mode="autonomous") == 30


def test_wind_down_threshold_uses_floor_75_percent_q38_defaults() -> None:
    assert wind_down_threshold(8) == 6
    assert wind_down_threshold(30) == 22
    assert wind_down_threshold(10) == 7


def test_max_iterations_for_agent_surface_uses_q38_sub_agent_default() -> None:
    config = parse_runtime_config({})

    assert max_iterations_for_agent_surface(config, mode="assist", agent_surface=AGENT_SURFACE_SUB_AGENT) == 10


def test_sub_agent_final_iteration_is_reserved_for_tool_free_report_synthesis() -> None:
    context = SimpleNamespace(agent_surface=AGENT_SURFACE_SUB_AGENT)

    assert is_sub_agent_final_iteration(
        iteration=5,
        max_iterations=6,
        request_context=context,
    ) is False
    assert is_sub_agent_final_iteration(
        iteration=6,
        max_iterations=6,
        request_context=context,
    ) is True
    assert is_sub_agent_final_iteration(
        iteration=6,
        max_iterations=6,
        request_context=SimpleNamespace(agent_surface="main"),
    ) is False

    messages: list[dict[str, object]] = []
    append_sub_agent_finalization_message(messages)
    assert messages[0]["role"] == "system"
    assert "Do not call any more tools" in str(messages[0]["content"])
    assert "exactly one compact JSON object" in str(messages[0]["content"])


def test_should_emit_wind_down_only_at_threshold_once() -> None:
    assert should_emit_wind_down(iteration=5, max_iterations=8, already_emitted=False) is False
    assert should_emit_wind_down(iteration=6, max_iterations=8, already_emitted=False) is True
    assert should_emit_wind_down(iteration=7, max_iterations=8, already_emitted=True) is False


def test_max_iterations_for_mode_restores_legacy_cap_when_resource_discipline_disabled() -> None:
    config = parse_runtime_config(
        {
            "feature_flags": {"resource_discipline": False},
            "max_loop_iterations": 5,
            "max_chat_loop_iterations": 12,
            "max_task_loop_iterations": 30,
        }
    )

    assert max_iterations_for_mode(config, mode="chat") == 5
    assert max_iterations_for_mode(config, mode="task") == 5
    assert (
        max_iterations_for_agent_surface(config, mode="assist", agent_surface=AGENT_SURFACE_SUB_AGENT)
        == 5
    )


def test_max_iterations_for_mode_handles_malformed_config_values() -> None:
    config = SimpleNamespace(
        feature_flags={"resource_discipline": True},
        max_chat_loop_iterations="not-an-int",
        max_task_loop_iterations="also-bad",
        max_loop_iterations="bad",
    )

    assert max_iterations_for_mode(config, mode="chat") == 8
    assert max_iterations_for_mode(config, mode="task") == 30


# ── Engine-keyed cloud loop profile ──────────────────────────────────────────


@pytest.mark.parametrize("engine_type", CLOUD_ENGINE_TYPES)
def test_cloud_engines_get_the_widened_iteration_caps(engine_type: str) -> None:
    config = parse_runtime_config({"engine_type": engine_type})

    assert loop_profile_name(config) == "cloud"
    assert max_iterations_for_mode(config, mode="chat") == 40
    assert max_iterations_for_mode(config, mode="task") == 300
    assert max_iterations_for_mode(config, mode="autonomous") == 300


@pytest.mark.parametrize("engine_type", LOCAL_ENGINE_TYPES)
def test_local_engines_keep_todays_iteration_caps(engine_type: str) -> None:
    config = parse_runtime_config({"engine_type": engine_type})

    assert loop_profile_name(config) == "local"
    assert max_iterations_for_mode(config, mode="chat") == 8
    assert max_iterations_for_mode(config, mode="task") == 30


def test_cloud_profile_falls_back_to_local_when_the_flag_is_off() -> None:
    config = parse_runtime_config(
        {"engine_type": "chatgpt", "feature_flags": {"cloud_loop_profile": False}}
    )

    assert loop_profile_name(config) == "local"
    assert max_iterations_for_mode(config, mode="chat") == 8
    assert max_iterations_for_mode(config, mode="task") == 30
    # 2026-08-30: local working-time default raised to 1800 seconds.
    assert effective_max_loop_wall_seconds(config) == 1_800.0
    assert effective_max_tools_per_turn(config) == 20
    assert effective_tools_execution_timeout_seconds(config) == 120.0
    assert effective_chunk_inactivity_seconds(config) == 120.0


def test_cloud_engine_that_fell_back_to_mock_degrades_to_the_local_profile() -> None:
    # engine_type is the POST-FALLBACK engine: a signed-out chatgpt boot lands
    # on "mock", which must not carry the widened budgets.
    config = parse_runtime_config({"engine_type": "mock", "chatgpt_access_token": None})

    assert loop_profile_name(config) == "local"
    assert max_iterations_for_mode(config, mode="task") == 30


def test_cloud_values_are_config_overridable() -> None:
    config = parse_runtime_config(
        {
            "engine_type": "codex-cli",
            "cloud_max_task_loop_iterations": 120,
            "cloud_max_tools_per_turn": 64,
        }
    )

    assert max_iterations_for_mode(config, mode="task") == 120
    assert effective_max_tools_per_turn(config) == 64
    # Untouched cloud keys keep their profile defaults.
    assert max_iterations_for_mode(config, mode="chat") == 40


def test_wind_down_threshold_scales_with_the_cloud_task_cap() -> None:
    config = parse_runtime_config({"engine_type": "chatgpt"})
    max_iterations = max_iterations_for_mode(config, mode="task")

    assert max_iterations == 300
    assert wind_down_threshold(max_iterations) == 225
    assert should_emit_wind_down(
        iteration=224, max_iterations=max_iterations, already_emitted=False
    ) is False
    assert should_emit_wind_down(
        iteration=225, max_iterations=max_iterations, already_emitted=False
    ) is True


def test_sub_agent_budget_is_profile_independent() -> None:
    cloud = parse_runtime_config({"engine_type": "chatgpt"})
    local = parse_runtime_config({})

    for config in (cloud, local):
        assert (
            max_iterations_for_agent_surface(
                config, mode="task", agent_surface=AGENT_SURFACE_SUB_AGENT
            )
            == 10
        )
    assert max_iterations_for_agent_surface(cloud, mode="task", agent_surface="main") == 300


def test_cloud_profile_uses_the_cloud_chat_cap_when_resource_discipline_is_off() -> None:
    config = parse_runtime_config(
        {"engine_type": "chatgpt", "feature_flags": {"resource_discipline": False}}
    )

    assert max_iterations_for_mode(config, mode="chat") == 40
    assert max_iterations_for_mode(config, mode="task") == 40
    # Sub-agents stay on the legacy single cap, exactly as for a local engine.
    assert (
        max_iterations_for_agent_surface(
            config, mode="task", agent_surface=AGENT_SURFACE_SUB_AGENT
        )
        == 8
    )


def test_effective_helpers_select_local_versus_cloud_values() -> None:
    local = parse_runtime_config({})
    cloud = parse_runtime_config({"engine_type": "chatgpt"})

    assert effective_max_loop_wall_seconds(local) == 1_800.0
    assert effective_max_loop_wall_seconds(cloud) == 28_800.0
    assert effective_tools_execution_timeout_seconds(local) == 120.0
    assert effective_tools_execution_timeout_seconds(cloud) == 1_800.0
    assert effective_chunk_inactivity_seconds(local) == 120.0
    assert effective_chunk_inactivity_seconds(cloud) == 300.0
    assert effective_max_tools_per_turn(local) == 20
    assert effective_max_tools_per_turn(cloud) == 200
    assert effective_max_tool_calls_per_session(local) == 200
    assert effective_max_tool_calls_per_session(cloud) == 2_000
    assert effective_max_web_tool_calls_per_turn(local) == 10
    assert effective_max_web_tool_calls_per_turn(cloud) == 30
    assert effective_sub_agent_concurrency_budget(local) == 1
    assert effective_sub_agent_concurrency_budget(cloud) == 3


def test_explicit_cloud_chunk_inactivity_override_wins_over_automatic_floor() -> None:
    cloud = parse_runtime_config(
        {
            "engine_type": "chatgpt",
            "chunk_inactivity_seconds": 60,
            "chunk_inactivity_seconds_is_override": True,
        }
    )

    assert effective_chunk_inactivity_seconds(cloud) == 60.0


def test_effective_helpers_fail_open_on_malformed_and_missing_attributes() -> None:
    malformed = SimpleNamespace(
        engine_type="chatgpt",
        feature_flags={},
        cloud_max_loop_wall_seconds="not-a-float",
        cloud_tools_execution_timeout_seconds=0.0,
        cloud_max_tools_per_turn="nope",
    )

    assert effective_max_loop_wall_seconds(malformed) == 28_800.0
    assert effective_tools_execution_timeout_seconds(malformed) == 1_800.0
    assert effective_chunk_inactivity_seconds(malformed) == 300.0
    assert effective_max_tools_per_turn(malformed) == 200
    # Attributes missing entirely (pre-field config objects) fall back too.
    assert effective_max_tool_calls_per_session(malformed) == 2_000
    assert effective_max_web_tool_calls_per_turn(SimpleNamespace()) == 10
