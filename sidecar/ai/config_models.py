"""Pure-data RuntimeConfig and related MCP, tool-policy, and fallback structures."""

from __future__ import annotations

from dataclasses import dataclass, field

from sidecar.ai.personality import DEFAULT_ASSISTANT_NAME, DEFAULT_PERSONALITY_BASE_PROMPT
from sidecar.ai.tools.tool_search import DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE

SYSTEM_PROMPT_DEFAULT = DEFAULT_PERSONALITY_BASE_PROMPT

SYSTEM_PROMPT_MINIMAL = (
    "You are an AI assistant operating through Jenny. Follow the user's request "
    "and the runtime, workspace, and tool instructions below."
)
SYSTEM_PROMPT_PROFILE_AUTO = "auto"
SYSTEM_PROMPT_PROFILE_COMPANION = "companion"
SYSTEM_PROMPT_PROFILE_MINIMAL = "minimal"


def resolve_system_prompt_profile(engine_type: str, requested_profile: str) -> str:
    """Resolve the effective prompt profile for one configured engine.

    ChatGPT-subscription models always use the lean profile. This keys off the
    provider route rather than a model-name prefix, so a locally served model
    with a GPT-like name keeps the local companion defaults.
    """
    if str(engine_type or "").strip().lower() == "chatgpt":
        return SYSTEM_PROMPT_PROFILE_MINIMAL
    normalized = str(requested_profile or "").strip().lower()
    if normalized == SYSTEM_PROMPT_PROFILE_MINIMAL:
        return SYSTEM_PROMPT_PROFILE_MINIMAL
    return SYSTEM_PROMPT_PROFILE_COMPANION


def uses_minimal_system_prompt(config: object) -> bool:
    return (
        resolve_system_prompt_profile(
            str(getattr(config, "engine_type", "") or ""),
            str(getattr(config, "system_prompt_profile", SYSTEM_PROMPT_PROFILE_AUTO) or ""),
        )
        == SYSTEM_PROMPT_PROFILE_MINIMAL
    )


@dataclass(frozen=True)
class MCPServerAuth:
    """Auth configuration for a remote (sse/http) MCP server.

    ``token`` and ``client_secret`` are in-memory only and MUST NOT be
    logged, echoed in error messages, or otherwise surfaced verbatim.
    ``__repr__`` is overridden so accidental logging (str/repr/dataclass
    repr) never leaks the literal secret values.
    """

    kind: str = "bearer"  # "bearer" | "oauth_client_credentials"
    token: str | None = None  # resolved bearer/PAT (in-memory only)
    token_url: str | None = None  # client-credentials only
    client_id: str | None = None
    client_secret: str | None = None
    scope: str | None = None

    def __repr__(self) -> str:
        token_repr = "'***'" if self.token else "None"
        client_secret_repr = "'***'" if self.client_secret else "None"
        return (
            "MCPServerAuth("
            f"kind={self.kind!r}, "
            f"token={token_repr}, "
            f"token_url={self.token_url!r}, "
            f"client_id={self.client_id!r}, "
            f"client_secret={client_secret_repr}, "
            f"scope={self.scope!r})"
        )


@dataclass(frozen=True)
class MCPServerConfig:
    name: str
    transport: str
    command: str | None = None
    args: tuple[str, ...] = ()
    url: str | None = None
    request_timeout_seconds: float = 30.0
    memory_limit_mb: int = 512
    max_processes: int = 5
    max_open_files: int = 256
    cpu_warning_seconds: float = 30.0
    init_timeout_seconds: float = 30.0
    auth: MCPServerAuth | None = None
    # True only for servers known to honor MCP notifications/cancelled by
    # aborting the in-flight tool (the first-party builtin server). The stdio
    # transport then cancels cooperatively instead of terminating the process.
    cooperative_cancel: bool = False
    approved_tools_digest: str | None = None


@dataclass(frozen=True)
class FallbackModelConfig:
    engine_type: str
    model: str
    max_context_tokens: int | None = None


@dataclass(frozen=True)
class ToolPolicyRuleMatch:
    """Match conditions for a tool-policy rule.

    Mirrors the Electron-side ``services/tools/tool-policy-evaluator.js``
    rule shape. Fields are ``None`` when the matcher is not constrained on
    that dimension.
    """

    tool_id: str | None = None
    action: str | None = None
    tool_family: str | None = None
    source_kind: str | None = None
    mode: tuple[str, ...] = ()
    path_prefix: str | None = None
    mcp_server: str | None = None


@dataclass(frozen=True)
class ToolPolicyRule:
    """One ordered entry in the policy rule list."""

    id: str
    decision: str  # 'auto' | 'ask' | 'deny'
    reason: str
    match: ToolPolicyRuleMatch


@dataclass(frozen=True)
class ToolPolicySnapshot:
    """Immutable per-run snapshot of the Electron-owned tool policy.

    Threaded through ``buildManagedSidecarConfig`` on init/refresh so retries,
    subagents, and automations all see the same policy that was in force when
    the parent ``chat.send`` started. The Electron-side
    ``ToolPermissionStore.getSnapshot()`` produces the JSON payload that
    ``RuntimeConfig.tool_policy_snapshot`` is built from.
    """

    version: int = 1
    legacy_policies: tuple[tuple[str, str], ...] = ()
    rules: tuple[ToolPolicyRule, ...] = ()

    @classmethod
    def empty(cls) -> "ToolPolicySnapshot":
        return cls()

    def legacy_decision_for(self, tool_name: str) -> str | None:
        for name, decision in self.legacy_policies:
            if name == tool_name:
                return decision
        return None


@dataclass(frozen=True)
class RuntimeConfig:
    engine_type: str = "mock"
    model: str = "mock-v1"
    context_length: int | None = None
    # Explicit user choice, applied after model-family profile defaults.
    context_length_override: int | None = None
    ollama_models_dir: str | None = None
    ollama_request_timeout_seconds: int = 300
    # Replay engine (deterministic scripted streams for agentic GUI testing).
    replay_script_path: str | None = None
    replay_delay_ms: float | None = None
    codex_cli_enabled: bool = False
    codex_cli_command: str | None = None
    codex_cli_runtime_root: str | None = None
    codex_cli_models: tuple[str, ...] = ()
    codex_cli_request_timeout_seconds: int = 300
    codex_cli_auth_ready: bool = False
    codex_cli_auth_reason: str | None = None
    chatgpt_access_token: str | None = None
    openai_compatible_api_key: str | None = field(default=None, repr=False)
    chatgpt_account_id: str | None = None
    chatgpt_base_url: str | None = None
    tools_execution_timeout_seconds: float = 120.0
    # 2026-08-30: local working-time default raised to 1800s (schema lockstep).
    max_loop_wall_seconds: float = 1800.0
    max_loop_iterations: int = 8
    max_chat_loop_iterations: int = 8
    max_task_loop_iterations: int = 30
    max_sub_agent_loop_iterations: int = 10
    max_sub_agent_concurrency: int = 1
    max_cloud_sub_agent_concurrency: int = 3
    max_budget_usd: float | None = None
    chunk_inactivity_seconds: float = 120.0
    chunk_inactivity_seconds_is_override: bool = False
    # Separate, longer grace for the FIRST streamed chunk only. The first chunk
    # also covers a model (re)load into VRAM, which on local hardware can take
    # longer than the between-token inactivity window and emits no output. Once
    # any chunk has arrived the model is alive and ``chunk_inactivity_seconds``
    # governs every subsequent wait unchanged.
    model_load_grace_seconds: float = 300.0
    assistant_identity: dict[str, str] | None = None
    assistant_name: str = DEFAULT_ASSISTANT_NAME
    api_url: str | None = None
    system_prompt_profile: str = SYSTEM_PROMPT_PROFILE_AUTO
    system_prompt: str = SYSTEM_PROMPT_DEFAULT
    mode: str = "chat"
    temperature: float = 0.7
    max_tokens: int = 16384
    max_inline_payload_bytes: int = 65_536
    # Token-budget overrides — each None means "use module default in token_budget.py".
    # See docs/operations/resource-budgets.md § "Token budget constants".
    token_budget_reserved_for_summary: int | None = None
    token_budget_tool_overhead: int | None = None
    token_budget_warning_ratio: float | None = None
    token_budget_auto_compact_ratio: float | None = None
    # Per-model override map: {model_id: ratio}. A model id missing from the map
    # falls back to token_budget_auto_compact_ratio (global), then the module
    # default in token_budget.py.
    token_budget_auto_compact_ratio_by_model: dict[str, float] | None = None
    # Custom compaction summarization prompt override. Unset falls back to the
    # hardcoded FULL_COMPACTION_PROMPT in compaction_prompts.py.
    compaction_custom_prompt: str | None = None
    generation_profiles_by_model: dict[str, dict[str, float | int]] | None = None
    reasoning_effort: str = ""
    session_start_date: str = ""
    safety_mode: str = "normal"
    tools_enabled: bool = True
    tools_glob_enabled: bool = True
    tools_grep_enabled: bool = True
    tools_edit_file_enabled: bool = True
    tools_delete_file_enabled: bool = True
    tools_move_file_enabled: bool = True
    tools_lsp_enabled: bool = False
    tools_distill_enabled: bool = True
    tool_call_reliability_net_enabled: bool = True
    tools_lsp_command_typescript: str | None = None
    tools_lsp_command_python: str | None = None
    electron_tool_bridge_enabled: bool = False
    tools_worktree_enabled: bool = False
    tools_subagents_enabled: bool = True
    tools_subagent_batch_enabled: bool = False
    tools_mcp_resources_enabled: bool = False
    tools_automations_enabled: bool = False
    tools_workspace_present_enabled: bool = False
    tools_preview_test_enabled: bool = False
    tools_verify_enabled: bool = False
    tools_home_enabled: bool = False
    tools_task_board_enabled: bool = False
    tools_rich_files_enabled: bool = True
    tools_knowledge_enabled: bool = False
    # Absolute paths of user-registered knowledge folders (Electron-validated;
    # the knowledge tools re-validate containment on every access).
    knowledge_roots: tuple[str, ...] = ()
    tool_policy_snapshot: ToolPolicySnapshot | None = None
    tools_shell_enabled: bool = False
    tools_confirm_side_effects: bool = True
    tools_web_enabled: bool = False
    tools_image_read_enabled: bool = False
    tools_todo_enabled: bool = False
    tools_mermaid_enabled: bool = True
    tools_workspace_manifest_enabled: bool = False
    repo_delta_resume_enabled: bool = False
    model_identity_overlay_enabled: bool = True
    session_environment_overlay_enabled: bool = True
    tool_result_envelope_enabled: bool = True
    interrupted_turn_receipts_overlay_enabled: bool = True
    tools_task_capsule_enabled: bool = False
    tools_python_runtime_enabled: bool = False
    tools_python_runtime_timeout_seconds: int = 30
    tools_python_runtime_max_memory_mb: int = 512
    tools_python_runtime_interpreter: str | None = None
    tools_python_runtime_root: str | None = None
    tools_python_runtime_bundled_python: str | None = None
    tools_python_runtime_wheelhouse_dir: str | None = None
    tools_git_timeout_seconds: float = 20.0
    tool_search_mode: str = "standard"
    tool_search_auto_threshold_pct: int = DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE
    tools_web_search_provider: str = "duckduckgo"
    tools_web_searxng_url: str | None = None
    tools_web_search_provider_keys: dict[str, str] | None = None
    tools_web_rate_limit_per_min: int = 30
    tools_web_max_fetch_bytes: int = 1_048_576
    tools_web_allow_private_addresses: bool = False
    tools_max_search_file_bytes: int = 2_097_152
    tools_max_edit_file_bytes: int = 2_097_152
    max_tools_per_turn: int = 20
    max_web_tool_calls_per_turn: int = 10
    max_code_intelligence_tool_calls_per_turn: int = 16
    max_tool_calls_per_session: int = 200
    # Cloud-engine loop profile (see sidecar/ai/routing/iteration_limits.py).
    # These are the widened counterparts of the resource-discipline knobs above,
    # selected only when the ACTIVE (post-fallback) engine is a cloud frontier
    # engine and the `cloud_loop_profile` feature flag is on. Every other engine
    # — and any cloud engine that fell back to `mock` — keeps the local values.
    cloud_max_chat_loop_iterations: int = 40
    cloud_max_task_loop_iterations: int = 300
    cloud_max_loop_wall_seconds: float = 28_800.0
    cloud_max_tools_per_turn: int = 200
    cloud_max_tool_calls_per_session: int = 2_000
    cloud_max_web_tool_calls_per_turn: int = 30
    cloud_tools_execution_timeout_seconds: float = 1_800.0
    tools_workspace_root: str | None = None
    agent_workspace_root: str | None = None
    electron_state_root: str | None = None
    electron_shell_config_path: str | None = None
    electron_sessions_path: str | None = None
    electron_tool_permissions_path: str | None = None
    skills_bundled_root: str | None = None
    skills_user_root: str | None = None
    skills_project_root: str | None = None
    skills_bundled_enabled: bool = True
    skills_user_enabled: bool = True
    skills_project_enabled: bool = True
    skills_disabled_ids: tuple[str, ...] = ()
    skills_auto_index: str = "auto"
    # Read-only skill-content loader for the scoped skill index above. See
    # sidecar/ai/tools/builtins/skills.py; default-on, matching the other
    # always-available builtin read tools (tools_distill_enabled et al.).
    tools_load_skill_enabled: bool = True
    tools_connections_enabled: bool = True
    mcp_servers: tuple[MCPServerConfig, ...] = ()
    mcp_sse_enabled: bool = False
    memory_db_path: str | None = None
    background_runtime_root: str | None = None
    operation_ledger_root: str | None = None
    diagnostics_log_level: str = "info"
    diagnostics_capture_mode: str = "redacted"
    # Electron threads the user's crash-reporting consent so sidecar-side
    # telemetry (none today) can honor it; accepting the key also keeps it out
    # of the ai.config.unknown_keys drift warning on every managed launch.
    crash_reporting_opt_in: bool = False
    fallback_models: tuple[FallbackModelConfig, ...] = ()
    feature_flags: dict[str, bool] | None = None
    app_profile: str = ""
    resolved_app_profile_family: str = ""
    resolved_app_profile_variant: str = ""
    resolved_app_profile_temperature: float | None = None
    resolved_app_profile_top_k: int | None = None
    resolved_app_profile_top_p: float | None = None
    resolved_app_profile_min_p: float | None = None
    resolved_app_profile_presence_penalty: float | None = None
    resolved_app_profile_repeat_penalty: float | None = None
    resolved_app_profile_reasoning_parser_start: str = ""
    resolved_app_profile_reasoning_parser_end: str = ""
    resolved_app_profile_prompt_addendum: str = ""
    resolved_app_profile_thinking_sampler: dict[str, float | int] | None = None
    resolved_app_profile_instruct_sampler: dict[str, float | int] | None = None
    resolved_app_profile_max_output_tokens: int | None = None
    resolved_app_profile_thinking_token_headroom: int | None = None
    resolved_user_max_output_tokens: int | None = None

    def __post_init__(self) -> None:
        effective_profile = resolve_system_prompt_profile(
            self.engine_type,
            self.system_prompt_profile,
        )
        object.__setattr__(self, "system_prompt_profile", effective_profile)
        if (
            effective_profile == SYSTEM_PROMPT_PROFILE_MINIMAL
            and self.system_prompt == SYSTEM_PROMPT_DEFAULT
        ):
            object.__setattr__(self, "system_prompt", SYSTEM_PROMPT_MINIMAL)
