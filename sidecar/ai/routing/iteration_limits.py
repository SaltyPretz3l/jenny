"""Mode-aware loop-cap, wind-down, and engine-keyed loop-profile helpers.

Jenny's resource-discipline limits are engine-keyed. A cloud frontier engine can
sustain a far longer agentic loop than a single local GPU, so when the ACTIVE
engine is one of ``_CLOUD_ENGINE_TYPES`` the widened ``cloud_*`` config values
are selected; every other engine keeps the historical local values.

``config.engine_type`` is the POST-FALLBACK actual engine: a signed-out
``chatgpt`` boot lands on ``mock``, which correctly degrades to the local
profile. Never resolve the profile from the *requested* engine.
"""

from __future__ import annotations

import math
from typing import Any

from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.feature_flags import (
    is_cloud_loop_profile_enabled,
    is_resource_discipline_enabled,
)
from sidecar.ai.routing import subagent_finalization as _subagent_finalization

AGENT_SURFACE_MAIN = "main"
AGENT_SURFACE_SUB_AGENT = "sub_agent"
SUB_AGENT_REPORT_MODE_PLAIN_TEXT = _subagent_finalization.SUB_AGENT_REPORT_MODE_PLAIN_TEXT
SUB_AGENT_REPORT_MODE_STRUCTURED = _subagent_finalization.SUB_AGENT_REPORT_MODE_STRUCTURED
parse_sub_agent_report_object = _subagent_finalization.parse_structured_report
_append_sub_agent_finalization_message = _subagent_finalization.append_finalization_message
_sub_agent_response_format = _subagent_finalization.response_format

LOOP_PROFILE_CLOUD = "cloud"
LOOP_PROFILE_LOCAL = "local"

_CLOUD_ENGINE_TYPES = frozenset({"chatgpt", "codex-cli"})
_CLOUD_CHUNK_INACTIVITY_FLOOR_SECONDS = 300.0

_CHAT_MODE = "chat"
_WIND_DOWN_RATIO = 0.75
_WIND_DOWN_MESSAGE = (
    "System status: you are nearing the iteration limit for this turn. "
    "Prioritize finishing the user's request with the information already gathered."
)
_MODE_DEFAULTS = {
    _CHAT_MODE: ("max_chat_loop_iterations", 8),
    "task": ("max_task_loop_iterations", 30),
}
_CLOUD_MODE_DEFAULTS = {
    _CHAT_MODE: ("cloud_max_chat_loop_iterations", 40),
    "task": ("cloud_max_task_loop_iterations", 300),
}


def loop_profile_name(config: Any) -> str:
    """Public name of the active profile — ``"cloud"`` or ``"local"``."""

    return LOOP_PROFILE_CLOUD if _is_cloud_profile_active(config) else LOOP_PROFILE_LOCAL


def effective_sub_agent_concurrency_budget(config: Any) -> int:
    """Return concurrency capacity for the active post-fallback engine profile."""

    if _is_cloud_profile_active(config):
        return min(
            3,
            _safe_iteration_limit(
                getattr(config, "max_cloud_sub_agent_concurrency", 3),
                default=3,
            ),
        )
    return _safe_iteration_limit(
        getattr(config, "max_sub_agent_concurrency", 1),
        default=1,
    )


def max_iterations_for_mode(config: Any, *, mode: str) -> int:
    cloud = _is_cloud_profile_active(config)
    if not _resource_discipline_enabled(config):
        # Legacy single-cap path. A cloud engine still gets the cloud chat cap
        # so turning resource discipline off never pins it to the local 8.
        if cloud:
            return _safe_iteration_limit(
                getattr(config, "cloud_max_chat_loop_iterations", 40),
                default=40,
            )
        return _safe_iteration_limit(getattr(config, "max_loop_iterations", 8), default=8)
    normalized_mode = str(mode or "").strip().lower()
    table = _CLOUD_MODE_DEFAULTS if cloud else _MODE_DEFAULTS
    attr_name, default = table.get(normalized_mode, table["task"])
    value = getattr(config, attr_name, None)
    if value is None:
        value = default if cloud else getattr(config, "max_loop_iterations", default)
    return _safe_iteration_limit(value, default=default)


def max_iterations_for_agent_surface(config: Any, *, mode: str, agent_surface: str) -> int:
    normalized_surface = str(agent_surface or "").strip().lower()
    if normalized_surface == AGENT_SURFACE_SUB_AGENT:
        # Sub-agent budgets are profile-independent by design: a widened parent
        # loop should spawn more sub-agents, not longer ones.
        if not _resource_discipline_enabled(config):
            return _safe_iteration_limit(getattr(config, "max_loop_iterations", 8), default=8)
        value = getattr(config, "max_sub_agent_loop_iterations", None)
        if value is None:
            value = getattr(config, "max_loop_iterations", 10)
        return _safe_iteration_limit(value, default=10)
    return max_iterations_for_mode(config, mode=mode)


def effective_max_loop_wall_seconds(config: Any) -> float:
    return _profiled_float(
        config,
        cloud_attr="cloud_max_loop_wall_seconds",
        local_attr="max_loop_wall_seconds",
        cloud_default=28_800.0,
        local_default=1_800.0,
    )


def effective_tools_execution_timeout_seconds(config: Any) -> float:
    return _profiled_float(
        config,
        cloud_attr="cloud_tools_execution_timeout_seconds",
        local_attr="tools_execution_timeout_seconds",
        cloud_default=1_800.0,
        local_default=120.0,
    )


def effective_chunk_inactivity_seconds(config: Any) -> float:
    """Return the between-chunk timeout for the active engine profile.

    Cloud reasoning can legitimately remain silent longer than a local decode.
    Preserve the configured value for local engines while applying a bounded
    five-minute floor to the default-on cloud loop profile.
    """

    configured = _safe_positive_float(
        getattr(config, "chunk_inactivity_seconds", 120.0),
        120.0,
    )
    if _is_cloud_profile_active(config) and not bool(
        getattr(config, "chunk_inactivity_seconds_is_override", False)
    ):
        return max(configured, _CLOUD_CHUNK_INACTIVITY_FLOOR_SECONDS)
    return configured


def effective_max_tools_per_turn(config: Any) -> int:
    return _profiled_int(
        config,
        cloud_attr="cloud_max_tools_per_turn",
        local_attr="max_tools_per_turn",
        cloud_default=200,
        local_default=20,
    )


def effective_max_tool_calls_per_session(config: Any) -> int:
    return _profiled_int(
        config,
        cloud_attr="cloud_max_tool_calls_per_session",
        local_attr="max_tool_calls_per_session",
        cloud_default=2_000,
        local_default=200,
    )


def effective_max_web_tool_calls_per_turn(config: Any) -> int:
    return _profiled_int(
        config,
        cloud_attr="cloud_max_web_tool_calls_per_turn",
        local_attr="max_web_tool_calls_per_turn",
        cloud_default=30,
        local_default=10,
    )


def wind_down_threshold(max_iterations: int) -> int:
    return max(1, int(max(1, int(max_iterations)) * _WIND_DOWN_RATIO))


def should_emit_wind_down(
    *,
    iteration: int,
    max_iterations: int,
    already_emitted: bool,
) -> bool:
    if already_emitted:
        return False
    return int(iteration) >= wind_down_threshold(max_iterations)


def wind_down_enabled(config: Any) -> bool:
    return _resource_discipline_enabled(config)


def append_wind_down_system_message(messages: list[dict[str, object]]) -> None:
    messages.append({"role": "system", "content": _WIND_DOWN_MESSAGE})


def is_sub_agent_final_iteration(
    *,
    iteration: int,
    max_iterations: int,
    request_context: Any | None,
) -> bool:
    return is_sub_agent_request_context(request_context) and int(iteration) >= max(
        1, int(max_iterations)
    )


def is_sub_agent_request_context(request_context: Any | None) -> bool:
    return (
        str(getattr(request_context, "agent_surface", "") or "").strip().lower()
        == AGENT_SURFACE_SUB_AGENT
    )


def sub_agent_report_response_format(
    request_context: Any | None = None,
) -> ResponseFormat | None:
    """Constrain a tools-stripped child finalization to its report contract."""

    return _sub_agent_response_format(request_context)


def append_sub_agent_finalization_message(
    messages: list[dict[str, object]],
    request_context: Any | None = None,
) -> None:
    _append_sub_agent_finalization_message(messages, request_context)


def _resource_discipline_enabled(config: Any) -> bool:
    flags = getattr(config, "feature_flags", {}) if config is not None else {}
    return is_resource_discipline_enabled(flags)


def _is_cloud_profile_active(config: Any) -> bool:
    engine_type = str(getattr(config, "engine_type", "") or "").strip().lower()
    if engine_type not in _CLOUD_ENGINE_TYPES:
        return False
    flags = getattr(config, "feature_flags", {}) if config is not None else {}
    return is_cloud_loop_profile_enabled(flags)


def _profiled_int(
    config: Any,
    *,
    cloud_attr: str,
    local_attr: str,
    cloud_default: int,
    local_default: int,
) -> int:
    if _is_cloud_profile_active(config):
        return _safe_iteration_limit(
            getattr(config, cloud_attr, cloud_default),
            default=cloud_default,
        )
    return _safe_iteration_limit(getattr(config, local_attr, local_default), default=local_default)


def _profiled_float(
    config: Any,
    *,
    cloud_attr: str,
    local_attr: str,
    cloud_default: float,
    local_default: float,
) -> float:
    if _is_cloud_profile_active(config):
        return _safe_positive_float(getattr(config, cloud_attr, cloud_default), cloud_default)
    return _safe_positive_float(getattr(config, local_attr, local_default), local_default)


def _safe_iteration_limit(value: Any, *, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(1, parsed)


def _safe_positive_float(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return float(default)
    if math.isnan(parsed) or parsed <= 0.0:
        return float(default)
    return parsed
