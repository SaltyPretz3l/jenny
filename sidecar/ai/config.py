"""Runtime configuration parsing for the sidecar AI stack.

``parse_runtime_config`` owns the canonical top-level schema: the unknown-key
policy, the loop/budget/timeout limits mirrored by
renderer/shared/engine-tuning-schema.js (tests/engine-tuning-schema.test.js
reads them from this file), the state paths, and the hosted/desktop
execution-policy overrides. The engine/provider/generation and tool/skill/MCP
sections live in config_sections.py.
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import fields
from pathlib import Path
from typing import Any

from sidecar.ai.config_models import (
    SYSTEM_PROMPT_DEFAULT,  # noqa: F401  (re-exported for backward-compat imports)
    SYSTEM_PROMPT_PROFILE_AUTO,  # noqa: F401  (re-exported for backward-compat imports)
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
    _as_non_empty_string,
    _as_nullable_string,
    _as_optional_bounded_float,
    _as_optional_bounded_float_map,
    _normalize_tool_policy_snapshot,  # noqa: F401  (re-exported for backward-compat imports)
    _normalize_ui_language,
    _parse_fallback_models,
    codex_cli_unavailable_reason,  # noqa: F401  (re-exported for backward-compat imports)
    normalize_chatgpt_model_catalog,  # noqa: F401  (re-exported for backward-compat imports)
    parse_conversation_index_config,  # noqa: F401  (re-exported for backward-compat imports)
    parse_semantic_catalog_config,  # noqa: F401  (re-exported for backward-compat imports)
)
from sidecar.ai.config_sections import parse_engine_fields, parse_tool_fields
from sidecar.ai.execution_policy import (
    desktop_policy_from_config,
)
from sidecar.ai.feature_flags import normalize_feature_flags
from sidecar.ai.host_policy import host_policy_from_config

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
# Retired keys: no longer read, but older configs and the current Electron
# payload still carry them, so they load silently instead of tripping the
# unknown-key WARN on every config load. Drop an entry once nothing sends it.
_RETIRED_TOP_LEVEL_KEYS: frozenset[str] = frozenset({"tools_subagent_batch_enabled"})
# Secret raw keys folded into a nested RuntimeConfig field rather than their own.
_NESTED_SECRET_KEYS: frozenset[str] = frozenset({"semantic_catalog_api_key"})
# Keys Electron sends that another sidecar module reads from the raw payload
# (startup applies the owned-process transfer in owned_process_tracking.py).
_CONSUMED_ELSEWHERE_KEYS: frozenset[str] = frozenset({"owned_process_handoff"})
_KNOWN_TOP_LEVEL_KEYS: frozenset[str] = (
    _RETIRED_TOP_LEVEL_KEYS | _NESTED_SECRET_KEYS | _CONSUMED_ELSEWHERE_KEYS
) | frozenset(
    f.name for f in fields(RuntimeConfig) if not f.name.startswith("resolved_app_profile_")
)


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


def _parse_ui_language(raw_config: dict[str, Any]) -> str:
    return _normalize_ui_language(raw_config.get("ui_language"))


def _parse_auto_approve_streak_cap(raw_config: dict[str, Any]) -> int:
    value = raw_config.get("auto_approve_streak_cap")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 50
    if not math.isfinite(value):
        return 50
    return min(500, max(0, int(value)))


def _warn_unknown_top_level_keys(raw_config: dict[str, Any]) -> None:
    unknown_keys = sorted(
        key
        for key in raw_config.keys()
        if isinstance(key, str) and key not in _KNOWN_TOP_LEVEL_KEYS
    )
    if unknown_keys:
        from sidecar.runtime.diagnostics import log_event

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


def _parse_limit_fields(raw_config: dict[str, Any]) -> dict[str, Any]:
    """Loop, budget and timeout limits (the engine-tuning schema's sidecar side)."""
    ollama_request_timeout_seconds = _as_bounded_int(
        raw_config.get("ollama_request_timeout_seconds"),
        default=300,
        min_value=30,
        max_value=3600,
    )
    tools_execution_timeout_seconds = _as_bounded_float(
        raw_config.get("tools_execution_timeout_seconds"),
        default=120.0,
        min_value=5.0,
        max_value=600.0,
    )
    max_loop_wall_seconds = _as_bounded_float(
        raw_config.get("max_loop_wall_seconds"),
        # Lockstep with renderer/shared/engine-tuning-schema.js, config_models.py
        # and iteration_limits.effective_max_loop_wall_seconds.
        default=3600.0,
        min_value=30.0,
        max_value=7200.0,
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
        max_value=250,
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
    max_tools_per_turn = _as_bounded_int(
        raw_config.get("max_tools_per_turn"),
        default=20,
        min_value=1,
        max_value=500,
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
        # TR-008 (owner 2026-09-28): the local per-chat budget matches the
        # cloud profile. Kept in lockstep with _MAX_SESSION_TOOL_CALL_CEILING in
        # tool_quotas.py and the engine-tuning schema; only lowering is possible.
        default=2_000,
        min_value=1,
        max_value=2_000,
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
    tools_git_timeout_seconds = _as_bounded_float(
        raw_config.get("tools_git_timeout_seconds"),
        default=20.0,
        min_value=1.0,
        max_value=120.0,
    )

    return dict(
        ollama_request_timeout_seconds=ollama_request_timeout_seconds,
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
        max_inline_payload_bytes=max_inline_payload_bytes,
        token_budget_reserved_for_summary=token_budget_reserved_for_summary,
        token_budget_tool_overhead=token_budget_tool_overhead,
        token_budget_warning_ratio=token_budget_warning_ratio,
        token_budget_auto_compact_ratio=token_budget_auto_compact_ratio,
        token_budget_auto_compact_ratio_by_model=token_budget_auto_compact_ratio_by_model,
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
        tools_python_runtime_timeout_seconds=tools_python_runtime_timeout_seconds,
        tools_python_runtime_max_memory_mb=tools_python_runtime_max_memory_mb,
        tools_git_timeout_seconds=tools_git_timeout_seconds,
    )


def _parse_state_fields(raw_config: dict[str, Any]) -> dict[str, Any]:
    """Workspace roots, Electron state paths, memory and diagnostics settings."""
    tools_workspace_root = _as_nullable_string(raw_config.get("tools_workspace_root"))
    agent_workspace_root = _as_nullable_string(raw_config.get("agent_workspace_root"))
    electron_state_root = _as_nullable_string(raw_config.get("electron_state_root"))
    electron_shell_config_path = _as_nullable_string(raw_config.get("electron_shell_config_path"))
    electron_sessions_path = _as_nullable_string(raw_config.get("electron_sessions_path"))
    electron_tool_permissions_path = _as_nullable_string(
        raw_config.get("electron_tool_permissions_path")
    )
    memory_db_path = _as_nullable_string(raw_config.get("memory_db_path"))
    memory_hybrid_recall_enabled = _as_bool(
        raw_config.get("memory_hybrid_recall_enabled"), default=False
    ) or read_environment_value("JENNY_ENABLE_MEMORY_HYBRID_RECALL") == "1"
    background_runtime_root = _as_nullable_string(raw_config.get("background_runtime_root"))
    operation_ledger_root = _as_nullable_string(raw_config.get("operation_ledger_root"))
    diagnostics_log_level = _as_non_empty_string(raw_config.get("diagnostics_log_level")) or "info"
    diagnostics_capture_mode = (
        _as_non_empty_string(raw_config.get("diagnostics_capture_mode")) or "redacted"
    )
    crash_reporting_opt_in = _as_bool(raw_config.get("crash_reporting_opt_in"), default=False)

    return dict(
        tools_workspace_root=tools_workspace_root,
        agent_workspace_root=agent_workspace_root,
        electron_state_root=electron_state_root,
        electron_shell_config_path=electron_shell_config_path,
        electron_sessions_path=electron_sessions_path,
        owned_process_ledger_path=_as_nullable_string(raw_config.get("owned_process_ledger_path")),
        electron_tool_permissions_path=electron_tool_permissions_path,
        memory_db_path=memory_db_path,
        memory_hybrid_recall_enabled=memory_hybrid_recall_enabled,
        background_runtime_root=background_runtime_root,
        operation_ledger_root=operation_ledger_root,
        diagnostics_log_level=diagnostics_log_level,
        diagnostics_capture_mode=diagnostics_capture_mode,
        crash_reporting_opt_in=crash_reporting_opt_in,
    )


def _apply_execution_policy_overrides(
    values: dict[str, Any], *, host_enforced: bool, desktop_enforced: bool
) -> None:
    """Close the sidecar-owned paths a hosted or sandboxed desktop run must not open."""
    if host_enforced:
        # Hosted filesystem mutations always enter the ordinary one-call approval
        # path, regardless of a desktop auto-approval preference.
        values["tools_confirm_side_effects"] = True
        # These hooks call back into Electron or invoke repository tooling. A
        # hosted sidecar has no Electron bridge and must not inherit forged
        # feature flags from a server request.
        feature_flags = dict(values["feature_flags"] or {})
        feature_flags["auto_checkpoint"] = False
        feature_flags["verification_gate"] = False
        values["feature_flags"] = feature_flags
        values["tools_verify_enabled"] = False
        values["tools_image_generate_enabled"] = False
    if desktop_enforced:
        # The sandbox keeps managed/local inference alive while closing every
        # sidecar-owned execution path.  The command descriptor is advertised
        # separately and is routed through the Electron bridge.
        feature_flags = dict(values["feature_flags"] or {})
        feature_flags["auto_checkpoint"] = False
        feature_flags["verification_gate"] = False
        feature_flags["git_tracking"] = False
        values["feature_flags"] = feature_flags
        values.update(
            repo_delta_resume_enabled=False,
            tools_verify_enabled=False,
            tools_image_generate_enabled=False,
            tools_worktree_enabled=False,
            tools_subagents_enabled=False,
            tools_python_runtime_enabled=False,
            tools_lsp_enabled=False,
            tools_automations_enabled=False,
            tools_mcp_resources_enabled=False,
            mcp_sse_enabled=False,
            electron_tool_bridge_enabled=True,
            # Keep the user-facing command descriptor available.  The builtin
            # subprocess receives a separate shell-disabled argv below.
            tools_shell_enabled=True,
        )


def parse_runtime_config(raw_config: Any) -> RuntimeConfig:
    if not isinstance(raw_config, dict):
        return RuntimeConfig()

    _warn_unknown_top_level_keys(raw_config)
    engine_type = _as_non_empty_string(raw_config.get("engine_type")) or "mock"
    host_policy = host_policy_from_config(raw_config)
    desktop_execution_policy = desktop_policy_from_config(raw_config)
    values: dict[str, Any] = {
        **parse_engine_fields(raw_config, engine_type),
        **_parse_limit_fields(raw_config),
        **_parse_state_fields(raw_config),
        **parse_tool_fields(raw_config),
        "feature_flags": normalize_feature_flags(raw_config.get("feature_flags")),
    }
    _apply_execution_policy_overrides(
        values,
        host_enforced=host_policy.enforced,
        desktop_enforced=desktop_execution_policy.enforced,
    )
    fallback_models = _parse_fallback_models(raw_config.get("fallback_models"))
    app_profile = _as_non_empty_string(raw_config.get("app_profile")) or ""

    return RuntimeConfig(
        engine_type=engine_type,
        host_mode=host_policy.mode,
        host_execution_policy_version=host_policy.version,
        host_execution_worker_enabled=_as_bool(
            raw_config.get("host_execution_worker_enabled"), default=False
        ),
        desktop_execution_policy_version=desktop_execution_policy.version,
        desktop_command_workspace=(
            "synced"
            if desktop_execution_policy.enforced
            and raw_config.get("desktop_command_workspace") == "synced"
            else "copy"
        ),
        auto_approve_streak_cap=_parse_auto_approve_streak_cap(raw_config),
        ui_language=_parse_ui_language(raw_config),
        fallback_models=fallback_models,
        app_profile=app_profile,
        **values,
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
    # Desktop default: the app profile (Electron userData, sent as
    # electron_state_root), so one profile never reads another profile's or a
    # test run's receipts. The machine-global legacy dir is only the fallback
    # for a sidecar launched without a profile; it is ignored, never migrated.
    state_root = str(getattr(config, "electron_state_root", "") or "").strip()
    if state_root:
        return Path(state_root).expanduser() / "operation-ledger"
    return Path.home() / ".companion" / "operation-ledger"
