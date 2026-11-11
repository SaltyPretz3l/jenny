const path = require('path');
const { sameLocalOrigin } = require('../local-origin');
const { resolveManagedServerOwner } = require('./managed-server-owner');
const { buildApiProviderSidecarConfig } = require('./api-provider-sidecar-config');

const {
  DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
} = require('./backend-config');
const {
  inferEngineTypeFromModel,
} = require('./backend-service-utils');
const {
  resolveUsableOllamaModelsDir,
} = require('./ollama-env');
const {
  getConfiguredWithDefault,
  getConfiguredToolsExecutionTimeoutSeconds,
  getConfiguredToolsGitTimeoutSeconds,
  getConfiguredMaxCodeIntelligenceToolCallsPerTurn,
  getConfiguredToolsPythonRuntimeTimeoutSeconds,
  getConfiguredToolsPythonRuntimeMaxMemoryMb,
  getConfiguredTokenBudgetTuning,
  getConfiguredCloudLoopProfile,
} = require('./managed-sidecar-engine-tuning');
// Config-state readers, model/endpoint resolution and credential reads live in
// sibling modules; this file assembles the initialize payload and stays the
// public entry point for all of them.
const {
  getConfiguredAssistantIdentity,
  getConfiguredCompactionTuning,
  getConfiguredContextLengthOverride,
  getConfiguredDiagnosticsCaptureMode,
  getConfiguredDiagnosticsLogLevel,
  getConfiguredGenerationProfiles,
  getConfiguredLocalVllmState,
  getConfiguredMaxBudgetUsd,
  getConfiguredMaxChatLoopIterations,
  getConfiguredMaxCloudSubAgentConcurrency,
  getConfiguredMaxInlinePayloadBytes,
  getConfiguredMaxLoopIterations,
  getConfiguredMaxSubAgentConcurrency,
  getConfiguredMaxSubAgentLoopIterations,
  getConfiguredMaxTaskLoopIterations,
  getConfiguredMaxToolCallsPerSession,
  getConfiguredMaxToolsPerTurn,
  getConfiguredMaxWebToolCallsPerTurn,
  getConfiguredModelLoadGraceSeconds,
  getConfiguredOllamaRequestTimeoutSeconds,
  getConfiguredStreamInactivity,
  getConfiguredTelemetrySettings,
  getConfiguredToolPolicySnapshot,
  getConfiguredToolsImageReadEnabled,
  getConfiguredToolsLspEnabled,
  getConfiguredToolsPythonRuntimeEnabled,
  getConfiguredToolsRichFilesEnabled,
  getConfiguredToolsSubagentsEnabled,
  getConfiguredToolsTodoEnabled,
  getConfiguredToolsWebEnabled,
  getConfiguredToolsWebSearchProvider,
  getConfiguredToolsWebSearxngUrl,
  getConfiguredToolsWorkspaceRoot,
  getConfiguredToolsWorktreeEnabled,
  getHostedModelEndpoint,
  guardedConfiguredWorkspaceRootForSidecar,
} = require('./managed-sidecar-config-readers');
const {
  resolveManagedConfiguredModel,
  resolveOpenAICompatibleApiUrl,
} = require('./managed-sidecar-config-model');
const {
  buildManagedSidecarSecrets,
  getConfiguredToolsWebSearchProviderKeys,
  resolveMcpServerAuthSecrets,
} = require('./managed-sidecar-config-secrets');

function resolvePythonRuntimeBundleRoot(service) {
  const explicitRoot = String(service?.options?.pythonRuntimeBundleRoot || '').trim();
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  const developmentRepoRoot = String(service?.options?.repoRoot || '').trim();
  return developmentRepoRoot ? path.resolve(developmentRepoRoot, 'vendor') : null;
}

function bundledPythonRelativePath(platform) {
  // Linux mirrors python.executable in config/python-runtime-bundle-lock.linux-x64.json;
  // Windows mirrors the same field in config/python-runtime-bundle-lock.json; tests enforce lockstep.
  const paths = {
    win32: ['python-embed', 'python.exe'],
    linux: ['python-embed', 'bin', 'python3.13'],
  };
  return paths[platform] || null;
}

// Hosted tool capabilities are a closed set. Keep every RuntimeConfig tool
// toggle explicit here so desktop preferences, integrations, and newly-added
// config patches cannot widen the server process by accident.
const HOSTED_TOOL_CAPABILITY_POLICY = Object.freeze({
  tools_glob_enabled: true,
  tools_grep_enabled: true,
  tools_edit_file_enabled: true,
  tools_delete_file_enabled: false,
  tools_move_file_enabled: false,
  tools_lsp_enabled: false,
  tools_distill_enabled: false,
  tools_worktree_enabled: false,
  tools_subagents_enabled: false,
  tools_mcp_resources_enabled: false,
  tools_automations_enabled: false,
  tools_workspace_present_enabled: false,
  tools_preview_test_enabled: false,
  tools_browser_use_enabled: false,
  tools_verify_enabled: false,
  tools_image_generate_enabled: false,
  tools_home_enabled: false, tools_next_step_enabled: false,
  tools_task_board_enabled: false,
  tools_project_notes_enabled: false,
  tools_session_directory_enabled: false, tools_primary_settings_enabled: false, tools_primary_chat_manage_enabled: false, tools_primary_chat_placement_enabled: false, tools_primary_app_view_enabled: false, tools_primary_chat_export_enabled: false, tools_terminal_enabled: false, tools_primary_schedules_enabled: false, tools_primary_digests_enabled: false,
  tools_memory_enabled: false,
  tools_conversations_enabled: false,
  tools_rich_files_enabled: false,
  tools_knowledge_enabled: false,
  tools_shell_enabled: false,
  tools_web_enabled: false,
  tools_image_read_enabled: false,
  tools_todo_enabled: false,
  tools_connections_enabled: false,
  tools_workspace_manifest_enabled: false,
  tools_task_capsule_enabled: false,
  tools_python_runtime_enabled: false,
  tools_load_skill_enabled: false,
});

function buildManagedSidecarConfig(service, { telemetrySettings = null } = {}) {
  const workspaceRoot = guardedConfiguredWorkspaceRootForSidecar(service, 'managed_sidecar_config');
  const hasWorkspaceRoot = Boolean(workspaceRoot);
  const chatUiState = service.configService && typeof service.configService.getChatUiState === 'function'
    ? service.configService.getChatUiState()
    : {};
  const ollamaModelsDirState = resolveUsableOllamaModelsDir();
  if (ollamaModelsDirState.warning && typeof service._emitServiceLog === 'function') {
    service._emitServiceLog('WARN', 'ollama.models_dir_ignored', {
      configuredPath: ollamaModelsDirState.configuredPath,
      reason: ollamaModelsDirState.warning.reason,
      target: ollamaModelsDirState.warning.target || null,
      remediation: ollamaModelsDirState.warning.remediation || null,
      troubleshooting: ollamaModelsDirState.warning.troubleshooting || null,
      message: ollamaModelsDirState.warning.message,
    });
  }
  const hostedEndpoint = getHostedModelEndpoint(service);
  const engineType = String(
    hostedEndpoint?.engine
    || service.currentEngineType
    || inferEngineTypeFromModel(service.currentModel || service.defaultModel)
  ).trim().toLowerCase();
  const assistantIdentity = getConfiguredAssistantIdentity(service);
  const compactionTuning = getConfiguredCompactionTuning(service);
  const generationProfiles = getConfiguredGenerationProfiles(service);
  const configuredModel = resolveManagedConfiguredModel(service);
  const configuredContextLengthOverride = getConfiguredContextLengthOverride(
    compactionTuning, configuredModel, engineType
  );
  const managedLlamaServerContextLength = Number(
    service.options?.managedLlamaServerProfile?.contextSize
  );
  const openAiCompatibleContextLength = engineType === 'openai-compatible'
    ? (configuredContextLengthOverride ?? (
      Number.isSafeInteger(managedLlamaServerContextLength)
      && managedLlamaServerContextLength > 0
        ? managedLlamaServerContextLength
        : null
    ))
    : null;
  const pythonRuntimeBundleRoot = resolvePythonRuntimeBundleRoot(service);
  const rel = bundledPythonRelativePath(process.platform);
  const streamInactivity = getConfiguredStreamInactivity(service, configuredModel, engineType);
  const tokenBudgetTuning = getConfiguredTokenBudgetTuning(service);
  const cloudLoopProfile = getConfiguredCloudLoopProfile(service);
  const config = {
    engine_type: engineType,
    managed_prefill_progress: !hostedEndpoint && engineType === 'openai-compatible'
      && service.featureFlags?.prefill_progress === true
      && service.options?.getLlamaServerManager?.()?.supportsPrefillProgress?.() === true
      && sameLocalOrigin(resolveOpenAICompatibleApiUrl(service),
        service.options?.getLlamaServerManager?.()?.getBaseUrl?.()),
    model: configuredModel,
    ...buildApiProviderSidecarConfig(service, engineType, configuredModel), // row 78: descriptor + limits
    // Ollama keeps the deliberate VRAM-conscious shell clamp. Every other
    // engine reports its own window (or uses the sidecar's bounded fallback).
    context_length: engineType === 'ollama'
      ? DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH
      : openAiCompatibleContextLength,
    context_length_override: configuredContextLengthOverride,
    ollama_request_timeout_seconds: getConfiguredOllamaRequestTimeoutSeconds(service),
    ollama_models_dir: ollamaModelsDirState.modelsDir,
    tools_workspace_root: hasWorkspaceRoot ? workspaceRoot : null,
    desktop_execution_policy_version: service.configService?.getState?.()?.commandSandbox?.enabled === true ? 1 : null,
    // Row 106: read only by the sandboxed run_command description; policy stays v1.
    desktop_command_workspace: service.commandSandbox?.mode === 'synced' ? 'synced' : 'copy',
    tools_shell_enabled: hasWorkspaceRoot,
    tools_web_enabled: getConfiguredToolsWebEnabled(service),
    tools_web_search_provider: getConfiguredToolsWebSearchProvider(service),
    tools_web_searxng_url: getConfiguredToolsWebSearxngUrl(service),
    tools_web_search_provider_keys: getConfiguredToolsWebSearchProviderKeys(service),
    tools_todo_enabled: getConfiguredToolsTodoEnabled(service),
    tools_lsp_enabled: getConfiguredToolsLspEnabled(service),
    tools_worktree_enabled: getConfiguredToolsWorktreeEnabled(service),
    electron_tool_bridge_enabled: Boolean(service.toolExecutor),
    tools_workspace_manifest_enabled: service.featureFlags?.workspace_manifest === true,
    repo_delta_resume_enabled: service.featureFlags?.repo_delta_resume === true,
    tools_task_capsule_enabled: service.featureFlags?.task_capsule === true,
    tools_mcp_resources_enabled: service.featureFlags?.mcp_resources === true,
    tools_automations_enabled: service.featureFlags?.tools_automations_enabled === true,
    tools_workspace_present_enabled: service.featureFlags?.tools_workspace_present_enabled === true,
    tools_preview_test_enabled: service.featureFlags?.tools_preview_test_enabled === true,
    tools_browser_use_enabled: service.featureFlags?.tools_browser_use_enabled === true,
    tools_verify_enabled: service.featureFlags?.tools_verify_enabled === true,
    tools_image_generate_enabled: service.featureFlags?.tools_image_generate_enabled === true,
    tools_home_enabled: service.featureFlags?.tools_home_enabled === true, tools_next_step_enabled: service.featureFlags?.tools_next_step_enabled === true,
    tools_task_board_enabled: service.featureFlags?.tools_task_board_enabled === true,
    tools_project_notes_enabled: service.featureFlags?.tools_project_notes_enabled === true,
    tools_session_directory_enabled: service.featureFlags?.tools_session_directory_enabled !== false, tools_primary_digests_enabled: service.featureFlags?.primary_digests === true && service.featureFlags?.primary_chat !== false, // row 86: default off
    tools_primary_settings_enabled: service.featureFlags?.primary_settings_writes !== false, tools_primary_chat_manage_enabled: service.featureFlags?.primary_chat_manage !== false, tools_primary_chat_placement_enabled: service.featureFlags?.primary_chat_placement !== false && service.featureFlags?.primary_chat !== false, tools_primary_app_view_enabled: service.featureFlags?.primary_app_view !== false && service.featureFlags?.primary_chat !== false && service.hostMode !== 'server', tools_primary_chat_export_enabled: service.featureFlags?.primary_chat_export !== false && service.featureFlags?.primary_chat !== false && service.hostMode !== 'server', tools_terminal_enabled: service.featureFlags?.terminal_tools !== false && service.hostMode !== 'server', tools_primary_schedules_enabled: service.featureFlags?.primary_scheduled_checks !== false && service.featureFlags?.primary_chat !== false,
    tools_memory_enabled: service.featureFlags?.memory_v2_enabled === true,
    tools_conversations_enabled: service.featureFlags?.memory_v2_enabled === true,
    memory_hybrid_recall_enabled: service.featureFlags?.memory_hybrid_recall === true,
    json_schema_response_format: engineType === 'openai-compatible' && resolveManagedServerOwner(service, resolveOpenAICompatibleApiUrl(service))?.kind === 'llama-server', // Reflection's json_schema: managed llama-server only, never NInfer.
    tools_subagents_enabled: getConfiguredToolsSubagentsEnabled(service),
    tools_rich_files_enabled: getConfiguredToolsRichFilesEnabled(service),
    tools_image_read_enabled: getConfiguredToolsImageReadEnabled(service),
    tools_python_runtime_enabled: getConfiguredToolsPythonRuntimeEnabled(service),
    tools_python_runtime_timeout_seconds: getConfiguredToolsPythonRuntimeTimeoutSeconds(service),
    tools_python_runtime_max_memory_mb: getConfiguredToolsPythonRuntimeMaxMemoryMb(service),
    tools_python_runtime_interpreter: null,
    tools_python_runtime_root: path.join(service.options.userDataPath, 'python-runtime'),
    tools_python_runtime_bundled_python: pythonRuntimeBundleRoot && rel
      ? path.join(pythonRuntimeBundleRoot, ...rel)
      : null,
    // The composition layer selects <repo>/vendor for managed development and
    // process.resourcesPath for a packaged sidecar. Electron also defines
    // resourcesPath in development, so it is not itself a packaging signal.
    // Pack commands verify the packaged directory before electron-builder.
    tools_python_runtime_wheelhouse_dir: pythonRuntimeBundleRoot
      ? path.join(pythonRuntimeBundleRoot, 'python-runtime-wheels')
      : null,
    tools_confirm_side_effects: true,
    safety_mode: chatUiState?.safetyMode || 'normal',
    auto_approve_streak_cap: chatUiState?.autoApproveStreakCap ?? 50,
    ui_language: chatUiState?.uiLanguage || 'en',
    use_24_hour_time: chatUiState?.use24HourTime === true,
    tool_policy_snapshot: getConfiguredToolPolicySnapshot(service),
    max_tools_per_turn: getConfiguredMaxToolsPerTurn(service),
    max_loop_iterations: getConfiguredMaxLoopIterations(service),
    max_chat_loop_iterations: getConfiguredMaxChatLoopIterations(service),
    max_task_loop_iterations: getConfiguredMaxTaskLoopIterations(service),
    max_sub_agent_loop_iterations: getConfiguredMaxSubAgentLoopIterations(service),
    max_sub_agent_concurrency: getConfiguredMaxSubAgentConcurrency(service),
    max_cloud_sub_agent_concurrency: getConfiguredMaxCloudSubAgentConcurrency(service),
    max_web_tool_calls_per_turn: getConfiguredMaxWebToolCallsPerTurn(service),
    max_tool_calls_per_session: getConfiguredMaxToolCallsPerSession(service),
    max_inline_payload_bytes: getConfiguredMaxInlinePayloadBytes(service),
    // Bounded deferred discovery is always the managed runtime posture. The
    // internal JENNY_ENABLE_TOOL_SEARCH=0 rollback exposes the full assembled
    // tool set instead of removing tools from the model.
    tool_search_mode: 'tst-auto',
    max_budget_usd: getConfiguredMaxBudgetUsd(service),
    // The Electron stream watchdog resolves this same schema-owned value and
    // stays wider, so the sidecar remains the graceful deadline authority.
    max_loop_wall_seconds: getConfiguredWithDefault(service, 'maxLoopWallSeconds'),
    chunk_inactivity_seconds: streamInactivity.seconds,
    chunk_inactivity_seconds_is_override: streamInactivity.automatic !== true,
    model_load_grace_seconds: getConfiguredModelLoadGraceSeconds(service),
    tools_execution_timeout_seconds: getConfiguredToolsExecutionTimeoutSeconds(service),
    tools_git_timeout_seconds: getConfiguredToolsGitTimeoutSeconds(service),
    max_code_intelligence_tool_calls_per_turn:
      getConfiguredMaxCodeIntelligenceToolCallsPerTurn(service),
    cloud_max_chat_loop_iterations: cloudLoopProfile.maxChatLoopIterations,
    cloud_max_task_loop_iterations: cloudLoopProfile.maxTaskLoopIterations,
    cloud_max_tools_per_turn: cloudLoopProfile.maxToolsPerTurn,
    cloud_max_tool_calls_per_session: cloudLoopProfile.maxToolCallsPerSession,
    cloud_max_web_tool_calls_per_turn: cloudLoopProfile.maxWebToolCallsPerTurn,
    cloud_tools_execution_timeout_seconds: cloudLoopProfile.toolsExecutionTimeoutSeconds,
    token_budget_auto_compact_ratio: tokenBudgetTuning.autoCompactRatio,
    token_budget_warning_ratio: tokenBudgetTuning.warningRatio,
    token_budget_reserved_for_summary: tokenBudgetTuning.reservedForSummary,
    token_budget_tool_overhead: tokenBudgetTuning.toolOverhead,
    token_budget_auto_compact_ratio_by_model: Object.keys(compactionTuning.ratioByModel || {}).length
      ? compactionTuning.ratioByModel
      : null,
    compaction_custom_prompt: compactionTuning.customPrompt ? compactionTuning.customPrompt : null,
    generation_profiles_by_model: Object.keys(generationProfiles).length
      ? generationProfiles
      : null,
    electron_state_root: service.options.userDataPath,
    electron_shell_config_path: path.join(service.options.userDataPath, 'shell-config.json'),
    electron_sessions_path: path.join(service.options.userDataPath, 'sessions.json'),
    owned_process_ledger_path: path.join(service.options.userDataPath, 'owned-processes.json'),
    owned_process_handoff: service.sidecarManager?.ownedProcessHandoff || null,
    electron_tool_permissions_path: path.join(service.options.userDataPath, 'tool-permissions.json'),
    memory_db_path: service.hostMode === 'server' && service.options.memoryPath
      ? service.options.memoryPath : path.join(service.options.userDataPath, 'sidecar-memory.db'),
    background_runtime_root: path.join(service.options.userDataPath, 'background-memory'),
    diagnostics_log_level: getConfiguredDiagnosticsLogLevel(service),
    diagnostics_capture_mode: getConfiguredDiagnosticsCaptureMode(service),
    crash_reporting_opt_in: (
      telemetrySettings || getConfiguredTelemetrySettings(service)
    ).crashReportingOptIn === true,
    assistant_identity: assistantIdentity,
  };
  if (
    service.featureFlags
    && typeof service.featureFlags === 'object'
    && !Array.isArray(service.featureFlags)
    && Object.keys(service.featureFlags).length
  ) {
    config.feature_flags = {
      ...(config.feature_flags || {}),
      ...service.featureFlags,
    };
  }
  if (service.skillsService && typeof service.skillsService.getSidecarConfig === 'function') {
    Object.assign(config, service.skillsService.getSidecarConfig());
  }
  // knowledge_layer (default-off): publish the registered knowledge roots
  // (absolute realpaths — paths, not secrets) + tools_knowledge_enabled into
  // the managed-sidecar config. Flag-off returns {false, []}, so the keys stay
  // byte-identically inert until the flag is on AND a folder is registered.
  if (service.knowledgeService && typeof service.knowledgeService.getSidecarConfig === 'function') {
    Object.assign(config, service.knowledgeService.getSidecarConfig());
  }
  // Row 41: the semantic catalog contribution (db path, loopback embedder URL,
  // model key, prompt templates). Enabled only while the embedder is ready.
  if (typeof service.semanticCatalogService?.getSidecarConfig === 'function') {
    Object.assign(config, service.semanticCatalogService.getSidecarConfig());
  }
  // Row 58 W4: the sidecar-owned derived index of past chats (desktop only).
  if (service.featureFlags?.memory_v2_enabled === true && service.hostMode !== 'server') {
    config.conversation_index = { enabled: true, db_path: path.join(service.options.userDataPath, 'conversation-index.db') };
  }
  if (service.mcpDiscoveryService && typeof service.mcpDiscoveryService.getSidecarConfig === 'function') {
    Object.assign(config, service.mcpDiscoveryService.getSidecarConfig());
    if (Array.isArray(config.mcp_servers) && config.mcp_servers.length) {
      config.mcp_servers = resolveMcpServerAuthSecrets(service, config.mcp_servers);
    }
  }
  const integrationPatch = service.providerIntegrationRegistry?.getManagedConfigPatch?.() || {};
  if (
    integrationPatch.feature_flags
    && typeof integrationPatch.feature_flags === 'object'
    && !Array.isArray(integrationPatch.feature_flags)
  ) {
    config.feature_flags = {
      ...(config.feature_flags || {}),
      ...integrationPatch.feature_flags,
    };
  }
  for (const [key, value] of Object.entries(integrationPatch)) {
    if (key === 'feature_flags') {
      continue;
    }
    config[key] = value;
  }
  // Runtime checkpoints require additive canonical events even when legacy UI
  // rollout flags are off. This does not change the application's flag settings.
  if (service.featureFlags?.session_runtime === true) {
    config.feature_flags = { ...config.feature_flags, canonical_turn_events: true };
  }
  if (engineType === 'vllm') {
    const vllmState = getConfiguredLocalVllmState(service);
    const port = Number(vllmState?.port);
    if (Number.isFinite(port) && port > 0) {
      config.api_url = `http://127.0.0.1:${Math.trunc(port)}`;
    }
  }
  if (engineType === 'replay') {
    // Replay-engine knobs are env-driven dev/test machinery (the Playwright
    // smoke suite and CDP agents set them per launch); they flow to the
    // sidecar through the initialize payload like every other config field.
    const replayScriptPath = String(process.env.JENNY_REPLAY_SCRIPT || '').trim();
    if (replayScriptPath) {
      config.replay_script_path = replayScriptPath;
    }
    const replayDelayMs = Number(process.env.JENNY_REPLAY_DELAY_MS);
    if (Number.isFinite(replayDelayMs) && replayDelayMs >= 0) {
      config.replay_delay_ms = replayDelayMs;
    }
  }
  if (engineType === 'openai-compatible') {
    const apiUrl = resolveOpenAICompatibleApiUrl(service);
    if (apiUrl) {
      config.api_url = apiUrl;
    }
  }
  if (engineType === 'chatgpt') {
    // No api_url: the ChatGPT engine talks to its own fixed endpoint. Only
    // the account id (not a secret) travels on the non-secrets config.
    config.chatgpt_account_id = service.chatgptAuthService?.getAccountId?.() || '';
    config.chatgpt_model_catalog = service.chatgptModelCatalogService?.snapshot?.().models || [];
  }
  if (service.hostMode === 'server') {
    const requestedHostPolicyVersion = Number(
      service.options?.hostExecutionPolicyVersion ?? service.hostExecutionPolicyVersion ?? 1
    );
    const hostExecutionPolicyVersion = [1, 2].includes(requestedHostPolicyVersion)
      ? requestedHostPolicyVersion
      : 1;
    const workerStatus = service.hostExecutionBroker?.status?.()
      || service.options?.hostExecutionBroker?.status?.()
      || null;
    const hostExecutionWorkerEnabled = hostExecutionPolicyVersion === 2
      && workerStatus?.available === true;
    // Server-side policy is an initialize-payload boundary contract. Keep it
    // after user/configured feature assembly so a persisted desktop setting
    // cannot re-enable a host-owned capability for a hosted process.
    for (const key of Object.keys(config)) {
      if (
        /^tools_.*_enabled$/.test(key)
        && !Object.prototype.hasOwnProperty.call(HOSTED_TOOL_CAPABILITY_POLICY, key)
      ) {
        config[key] = false;
      }
    }
    Object.assign(config, {
      host_mode: 'server',
      host_execution_policy_version: hostExecutionPolicyVersion,
      host_execution_worker_enabled: hostExecutionWorkerEnabled,
      ...HOSTED_TOOL_CAPABILITY_POLICY,
      tools_workspace_root: hasWorkspaceRoot ? workspaceRoot : null,
      // This flag gates the reviewed hosted bridge descriptor. The builtin
      // shell handler remains denied at its hosted dispatch seam.
      tools_shell_enabled: hostExecutionWorkerEnabled,
      electron_tool_bridge_enabled: true,
      repo_delta_resume_enabled: false,
    });
    if (hostedEndpoint?.apiUrl && ['ollama', 'openai-compatible'].includes(engineType)) {
      config.api_url = String(hostedEndpoint.apiUrl).trim();
    }
  }
  return config;
}

module.exports = {
  bundledPythonRelativePath,
  getConfiguredToolsImageReadEnabled,
  getConfiguredToolsPythonRuntimeEnabled,
  getConfiguredToolsWebSearchProvider,
  getConfiguredToolsWebSearchProviderKeys,
  getConfiguredToolsWebSearxngUrl,
  getConfiguredToolsWorkspaceRoot,
  getConfiguredTelemetrySettings,
  getConfiguredContextLengthOverride,
  buildManagedSidecarConfig,
  buildManagedSidecarSecrets,
  resolveManagedConfiguredModel,
  resolveMcpServerAuthSecrets,
  resolveOpenAICompatibleApiUrl,
};
