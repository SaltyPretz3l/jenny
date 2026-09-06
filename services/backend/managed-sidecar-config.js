const path = require('path');
const { sameLocalOrigin } = require('../local-origin');

const {
  DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL,
  DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
} = require('./backend-config');
const {
  inferEngineTypeFromModel,
} = require('./backend-service-utils');
const {
  resolveUsableOllamaModelsDir,
} = require('./ollama-env');
const {
  getConfiguredOptional,
  getConfiguredWithDefault,
  getConfiguredToolsExecutionTimeoutSeconds,
  getConfiguredToolsGitTimeoutSeconds,
  getConfiguredMaxCodeIntelligenceToolCallsPerTurn,
  getConfiguredToolsPythonRuntimeTimeoutSeconds,
  getConfiguredToolsPythonRuntimeMaxMemoryMb,
  getConfiguredTokenBudgetTuning,
  getConfiguredCloudLoopProfile,
} = require('./managed-sidecar-engine-tuning');
const {
  WEB_SEARCH_PROVIDER_KEY_IDS,
} = require('./secure-store');
const {
  isToolsWorktreeEnabled,
  normalizeTelemetrySettings,
} = require('../shell-config-state');
const {
  ASSISTANT_AGENT_NAME_MAX_CHARS,
  DEFAULT_ASSISTANT_IDENTITY,
} = require('../shell-config-setup-state');
const {
  guardPersistedWorkspaceRoot,
} = require('../workspace-root-identity');
function getConfiguredToolsWorkspaceRoot(service) {
  if (service?.configService && typeof service.configService.getToolsWorkspaceRoot === 'function') {
    return String(service.configService.getToolsWorkspaceRoot() || '').trim();
  }
  if (service?.configService && typeof service.configService.getState === 'function') {
    const state = service.configService.getState() || {};
    return String(state?.toolsWorkspaceRoot || state?.tools_workspace_root || '').trim();
  }
  return String(process.env.JENNY_TOOLS_WORKSPACE_ROOT || '').trim();
}

// A persisted `.jenny` root would otherwise still reach the sidecar as
// `tools_workspace_root`; guardPersistedWorkspaceRoot treats it as absent.
function guardedConfiguredWorkspaceRootForSidecar(service, seam) {
  return guardPersistedWorkspaceRoot(getConfiguredToolsWorkspaceRoot(service), {
    logger: typeof service?._emitServiceLog === 'function'
      ? (level, event, details) => service._emitServiceLog(level, event, details)
      : null,
    seam,
  });
}

function resolvePythonRuntimeBundleRoot(service) {
  const explicitRoot = String(service?.options?.pythonRuntimeBundleRoot || '').trim();
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  const developmentRepoRoot = String(service?.options?.repoRoot || '').trim();
  return developmentRepoRoot ? path.resolve(developmentRepoRoot, 'vendor') : null;
}

function readConfigState(service, resolve, fallback = false) {
  if (service.configService && typeof service.configService.getState === 'function') {
    const state = service.configService.getState() || {};
    return resolve(state);
  }
  return fallback;
}

function getConfiguredToolsWebEnabled(service) {
  return readConfigState(service, (state) => state.tools?.web === true);
}

function getConfiguredToolsWebSearchProvider(service) {
  if (service.configService && typeof service.configService.getState === 'function') {
    const state = service.configService.getState() || {};
    const provider = String(state.webSearch?.provider || '').trim().toLowerCase();
    return provider || 'duckduckgo';
  }
  return 'duckduckgo';
}

function getConfiguredToolsWebSearxngUrl(service) {
  if (service.configService && typeof service.configService.getState === 'function') {
    const state = service.configService.getState() || {};
    const url = String(state.webSearch?.searxngUrl || '').trim();
    return url || null;
  }
  return null;
}

// Provider API keys come from SecureStore (never shell config / plaintext
// JSON). Returns null when nothing is configured so the sidecar parse falls
// back to its safe default. Values are secrets: this map must only ever be
// placed on the sidecar initialize payload, never logged or persisted.
function getConfiguredToolsWebSearchProviderKeys(service) {
  const secureStore = service.secureStore;
  if (!secureStore || typeof secureStore.getWebSearchProviderKey !== 'function') {
    return null;
  }
  const keyIds = Array.isArray(WEB_SEARCH_PROVIDER_KEY_IDS) ? WEB_SEARCH_PROVIDER_KEY_IDS : [];
  const keys = {};
  for (const keyId of keyIds) {
    try {
      const value = String(secureStore.getWebSearchProviderKey(keyId) || '').trim();
      if (value) {
        keys[keyId] = value;
      }
    } catch (error) {
      if (typeof service._emitServiceLog === 'function') {
        service._emitServiceLog('WARN', 'web_search.provider_key_read_failed', {
          keyId,
          errorName: String(error?.name || 'Error'),
          credentialStore: getCredentialStoreStatusForLog(secureStore),
        });
      }
    }
  }
  return Object.keys(keys).length ? keys : null;
}

function getConfiguredToolPolicySnapshot(service) {
  // Pull a fresh snapshot from the permission store so retries / subagents /
  // automations spawned mid-session see the policy that was in force when
  // their parent chat.send started. The sidecar treats `null` as "no
  // overrides — use built-in defaults".
  if (service.toolPermissionStore && typeof service.toolPermissionStore.getSnapshot === 'function') {
    try {
      return service.toolPermissionStore.getSnapshot();
    } catch (err) {
      if (typeof service._emitServiceLog === 'function') {
        service._emitServiceLog('WARN', 'tool_policy.snapshot_unavailable', {
          message: err?.message || String(err),
        });
      }
      return null;
    }
  }
  return null;
}

function getConfiguredLocalVllmState(service) {
  if (service.configService && typeof service.configService.getState === 'function') {
    const state = service.configService.getState() || {};
    const vllm = state.localEngines?.vllm;
    if (vllm && typeof vllm === 'object' && !Array.isArray(vllm)) {
      return vllm;
    }
  }
  return null;
}

function getConfiguredLocalOpenAICompatibleState(service) {
  if (service.configService && typeof service.configService.getState === 'function') {
    const state = service.configService.getState() || {};
    const openaiCompat = state.localEngines?.openaiCompatible;
    if (openaiCompat && typeof openaiCompat === 'object' && !Array.isArray(openaiCompat)) {
      return openaiCompat;
    }
  }
  return null;
}

function getConfiguredToolsImageReadEnabled(service) {
  return readConfigState(service, (state) => state.tools?.imageRead === true);
}

function getConfiguredToolsPythonRuntimeEnabled(service) {
  return readConfigState(service, (state) => state.tools?.pythonRuntime === true);
}

function getConfiguredToolsTodoEnabled(service) {
  return true;
}

function getConfiguredToolsMermaidEnabled(service) {
  return true;
}

function getConfiguredToolsLspEnabled(service) {
  return readConfigState(service, (state) => (
    state.tools?.lsp === true
    || state.tools?.tools_lsp_enabled === true
    || state.toolsLspEnabled === true
    || state.tools_lsp_enabled === true
  ));
}

function getConfiguredToolsWorktreeEnabled(service) {
  return readConfigState(service, isToolsWorktreeEnabled);
}

function getConfiguredToolsSubagentsEnabled(service) {
  return readConfigState(service, (state) => {
    const tools = state.tools && typeof state.tools === 'object' ? state.tools : {};
    for (const [source, key] of [
      [tools, 'subagents'],
      [tools, 'tools_subagents_enabled'],
      [state, 'toolsSubagentsEnabled'],
      [state, 'tools_subagents_enabled'],
    ]) {
      if (typeof source[key] === 'boolean') {
        return source[key];
      }
    }
    return true;
  }, true);
}

function getConfiguredToolsSubagentBatchEnabled(service) {
  // Compatibility-only output retained for one release. No active manifest
  // entry consumes it after Delegation V2.
  return (
    getConfiguredToolsSubagentsEnabled(service)
    && service.featureFlags?.subagent_batch === true
  );
}

function getConfiguredToolsRichFilesEnabled(service) {
  return readConfigState(service, (state) => (
    state.tools?.richFiles === true
    || state.tools?.tools_rich_files_enabled === true
    || state.toolsRichFilesEnabled === true
    || state.tools_rich_files_enabled === true
  ));
}

function getConfiguredMaxToolsPerTurn(service) {
  return getConfiguredWithDefault(service, 'maxToolsPerTurn');
}

function getConfiguredMaxLoopIterations(service) {
  return getConfiguredWithDefault(service, 'maxLoopIterations');
}

function getConfiguredMaxChatLoopIterations(service) {
  return getConfiguredWithDefault(service, 'maxChatLoopIterations');
}

function getConfiguredMaxTaskLoopIterations(service) {
  return getConfiguredWithDefault(service, 'maxTaskLoopIterations');
}

function getConfiguredMaxSubAgentLoopIterations(service) {
  return getConfiguredWithDefault(service, 'maxSubAgentLoopIterations');
}

function getConfiguredMaxSubAgentConcurrency(service) {
  return getConfiguredWithDefault(service, 'maxSubAgentConcurrency');
}

function getConfiguredMaxCloudSubAgentConcurrency(service) {
  return getConfiguredWithDefault(service, 'maxCloudSubAgentConcurrency');
}

function getConfiguredMaxWebToolCallsPerTurn(service) {
  return getConfiguredWithDefault(service, 'maxWebToolCallsPerTurn');
}

function getConfiguredMaxToolCallsPerSession(service) {
  return getConfiguredWithDefault(service, 'maxToolCallsPerSession');
}

function getConfiguredMaxInlinePayloadBytes(service) {
  return getConfiguredWithDefault(service, 'maxInlinePayloadBytes');
}

function getConfiguredMaxBudgetUsd(service) {
  return getConfiguredOptional(service, 'maxBudgetUsd');
}

function getConfiguredDiagnosticsLogLevel(service) {
  const rawValue = service.configService && typeof service.configService.getState === 'function'
    ? service.configService.getState()?.diagnosticsLogLevel ?? service.configService.getState()?.diagnostics_log_level
    : null;
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'warning' || normalized === 'error') {
    return normalized;
  }
  return 'info';
}

function getConfiguredDiagnosticsCaptureMode(service) {
  const rawValue = service.configService && typeof service.configService.getState === 'function'
    ? service.configService.getState()?.diagnosticsCaptureMode ?? service.configService.getState()?.diagnostics_capture_mode
    : null;
  return String(rawValue || '').trim().toLowerCase() === 'sanitized_snippets'
    ? 'sanitized_snippets'
    : 'redacted';
}

function getConfiguredTelemetrySettings(service) {
  if (service.configService && typeof service.configService.getState === 'function') {
    const state = service.configService.getState() || {};
    return normalizeTelemetrySettings(state.telemetry, state);
  }
  return { crashReportingOptIn: false };
}

// MCP HTTP Transport Step 5: resolve each sse server's `auth.secret_ref` into
// the actual secret (bearer token or OAuth client_secret) and inject it into
// a NEW forwarded server row -- the discovery-returned rows are never
// mutated. `secret_ref` itself is dropped from the forwarded shape (the
// sidecar's MCPServerAuth has no use for the ref, only the resolved value).
// Fail closed: a missing secureStore, a missing method, a thrown error, or no
// matching stored secret all resolve to "no secret" -- the auth object is
// forwarded without `token`/`client_secret` so the transport structurally
// 401s / fails to mint rather than silently going unauthenticated in a way
// that could be mistaken for success. Never log the ref value or the secret.
function resolveMcpServerAuthSecrets(service, servers) {
  if (!Array.isArray(servers) || !servers.length) {
    return servers;
  }
  const secureStore = service?.secureStore;
  return servers.map((server) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      return server;
    }
    const auth = server.auth;
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      return server;
    }
    const secretRef = String(auth.secret_ref || '').trim();
    if (!secretRef) {
      return server;
    }

    const forwardedAuth = {};
    if (auth.kind) {
      forwardedAuth.kind = auth.kind;
    }
    if (auth.token_url) {
      forwardedAuth.token_url = auth.token_url;
    }
    if (auth.client_id) {
      forwardedAuth.client_id = auth.client_id;
    }
    if (auth.scope) {
      forwardedAuth.scope = auth.scope;
    }
    // secret_ref intentionally dropped -- the sidecar consumes only the
    // resolved token/client_secret, never the pointer.

    const kind = String(auth.kind || '').trim().toLowerCase();
    const isOauthClientCredentials = kind === 'oauth_client_credentials';

    let resolvedSecret = '';
    if (secureStore && typeof secureStore.getMcpAuthToken === 'function') {
      try {
        resolvedSecret = String(secureStore.getMcpAuthToken(secretRef) || '').trim();
      } catch (error) {
        if (typeof service._emitServiceLog === 'function') {
          service._emitServiceLog('WARN', 'mcp.auth_token_read_failed', {
            server: String(server.name || '').trim(),
            errorName: String(error?.name || 'Error'),
            credentialStore: getCredentialStoreStatusForLog(secureStore),
          });
        }
        resolvedSecret = '';
      }
    }

    if (resolvedSecret) {
      if (isOauthClientCredentials) {
        forwardedAuth.client_secret = resolvedSecret;
      } else {
        forwardedAuth.token = resolvedSecret;
      }
    }
    // else: fail closed -- forward the auth object without token/client_secret.

    return { ...server, auth: forwardedAuth };
  });
}

function getCredentialStoreStatusForLog(secureStore) {
  if (!secureStore || typeof secureStore.getStatus !== 'function') {
    return null;
  }
  try {
    return secureStore.getStatus();
  } catch (_error) {
    return null;
  }
}

function getConfiguredOllamaRequestTimeoutSeconds(service) {
  return getConfiguredWithDefault(service, 'ollamaRequestTimeoutSeconds');
}

function getConfiguredStreamInactivity(service, modelId, engineType) {
  const cloud = engineType === 'chatgpt' || engineType === 'codex-cli';
  if (service.configService && typeof service.configService.resolveStreamInactivitySeconds === 'function') {
    return service.configService.resolveStreamInactivitySeconds(modelId, {
      cloud,
      ollama: engineType === 'ollama',
    });
  }
  const state = service.configService && typeof service.configService.getState === 'function'
    ? service.configService.getState() || {}
    : {};
  const byModel = state.modelTuning?.streamInactivitySecondsByModel;
  const explicit = byModel && typeof byModel === 'object' ? Number(byModel[String(modelId || '').trim()]) : NaN;
  if (Number.isInteger(explicit) && explicit >= 5 && explicit <= 300) {
    return { seconds: explicit, automatic: false };
  }
  return { seconds: cloud ? 300 : 120, automatic: true };
}

// Longer grace governing the wait for the FIRST streamed chunk only (which also
// covers a model (re)load into VRAM). Mirrors getConfiguredChunkInactivitySeconds;
// bounds 60-1800, default 300 (matches the Ollama request timeout). After the
// first chunk arrives, chunk_inactivity_seconds governs every subsequent wait.
function getConfiguredModelLoadGraceSeconds(service) {
  return getConfiguredWithDefault(service, 'modelLoadGraceSeconds');
}

// Context-window + compaction tuning: bounded per-model maps and the custom
// summarization prompt. Missing values preserve the sidecar defaults. Applies
// on the next sidecar (re)initialize.
function getConfiguredCompactionTuning(service) {
  if (service.configService && typeof service.configService.getCompactionTuning === 'function') {
    return service.configService.getCompactionTuning();
  }
  const state = service.configService && typeof service.configService.getState === 'function'
    ? service.configService.getState() || {}
    : {};
  return state.compactionTuning || { ratioByModel: {}, contextLengthByModel: {}, customPrompt: '' };
}

function getConfiguredGenerationProfiles(service) {
  const state = service.configService && typeof service.configService.getState === 'function'
    ? service.configService.getState() || {}
    : {};
  const profiles = state.modelTuning?.generationProfilesByModel;
  return profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {};
}

function getConfiguredContextLengthOverride(compactionTuning, modelId, engineType) {
  if (engineType !== 'ollama' && engineType !== 'openai-compatible') return null;
  const normalizedModelId = String(modelId || '').trim();
  const byModel = compactionTuning?.contextLengthByModel;
  if (!byModel || typeof byModel !== 'object') return null;
  // The setting is stored under the model-list tag the user tuned, but a managed
  // llama-server reports itself under stripLatestTag(tag). Try the alias we were
  // given first, then the ':latest' form it could have been stripped from, so the
  // window the sidecar budgets against is the one the server was launched with.
  const raw = Object.prototype.hasOwnProperty.call(byModel, normalizedModelId)
    ? byModel[normalizedModelId]
    : byModel[`${normalizedModelId}:latest`];
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeAssistantIdentityForSidecar(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const agentName = String(source.agentName || source.agent_name || DEFAULT_ASSISTANT_IDENTITY.agentName || 'Jenny').trim()
    || 'Jenny';
  // Personality v3: the name is the whole identity on the wire. Tone lives in
  // the user-owned PERSONALITY.md note and reaches the sidecar as the
  // `personality` context block, not as a config-derived overlay.
  return { agent_name: agentName.slice(0, ASSISTANT_AGENT_NAME_MAX_CHARS) };
}

function getConfiguredAssistantIdentity(service) {
  if (service.configService && typeof service.configService.getAssistantIdentity === 'function') {
    return normalizeAssistantIdentityForSidecar(service.configService.getAssistantIdentity());
  }
  if (service.configService && typeof service.configService.getState === 'function') {
    return normalizeAssistantIdentityForSidecar(service.configService.getState()?.assistantIdentity);
  }
  return normalizeAssistantIdentityForSidecar(DEFAULT_ASSISTANT_IDENTITY);
}

function resolveManagedStartupModel(service, engineType, fallbackDefaultModel) {
  const pendingModel = String(service._managedPendingModel || '').trim();
  if (pendingModel) {
    return pendingModel;
  }
  const activeModel = String(service.currentModel || '').trim();
  if (activeModel) {
    return activeModel;
  }
  // Ollama loads models on demand, so never request the configured default
  // during startup initialization: booting unloaded keeps the observed phase
  // 'ready' (chat usable immediately) and the first prompt lazy-loads the
  // default via resolveModel. Requesting it here used to latch
  // model_unavailable whenever the engine was not up yet, locking the chat
  // behind a manual model load every session.
  // ChatGPT auth is a per-session OAuth token, not a model to preload — boot
  // unloaded exactly like ollama and let the composer drive the first turn.
  if (engineType === 'ollama' || engineType === 'chatgpt' || engineType === 'plugin_host') {
    return '';
  }
  // If the configured default model belongs to a different engine than the
  // one being booted (e.g. preferredEngineType='openai-compatible' but the
  // persisted default is an Ollama-style tag), don't pass the mismatched
  // name to the sidecar — it would fail load_model and fall back to mock.
  // Boot the engine unloaded instead; the user picks a model in the UI.
  if (fallbackDefaultModel) {
    const inferredForFallback = inferEngineTypeFromModel(fallbackDefaultModel);
    if (inferredForFallback && inferredForFallback !== engineType) {
      return '';
    }
    return fallbackDefaultModel;
  }
  if (engineType === 'replay') {
    return 'replay-default';
  }
  return 'mock-v1';
}

function forcePhaseEventsForStreamEnvelopeV2(config) {
  if (config?.feature_flags?.stream_envelope_v2 === true) {
    config.feature_flags.phase_events = true;
  }
}

function resolveManagedConfiguredModel(service) {
  const engineType = service.currentEngineType
    || inferEngineTypeFromModel(service.currentModel || service.defaultModel);
  const manager = engineType === 'openai-compatible'
    ? service.options?.getLlamaServerManager?.() || null
    : null;
  const llamaServerStatus = manager?.getStatus?.();
  const llamaServerAlias = String(llamaServerStatus?.alias || '').trim();
  // Only the endpoint that IS the managed server takes its alias; a user's own
  // openai-compatible endpoint keeps the model it was configured with.
  if (llamaServerStatus?.state === 'ready' && llamaServerAlias
    && sameLocalOrigin(resolveOpenAICompatibleApiUrl(service), manager.getBaseUrl?.())) {
    return llamaServerAlias;
  }
  const configuredDefaultModel = String(service.defaultModel || '').trim();
  const inferredDefaultEngine = inferEngineTypeFromModel(configuredDefaultModel);
  const fallbackDefaultModel = (
    engineType === 'ollama'
    && configuredDefaultModel
    && inferredDefaultEngine !== 'ollama'
  )
    ? DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL
    : configuredDefaultModel;
  return resolveManagedStartupModel(service, engineType, fallbackDefaultModel);
}

function buildManagedSidecarConfig(service, { telemetrySettings = null } = {}) {
  const workspaceRoot = guardedConfiguredWorkspaceRootForSidecar(service, 'managed_sidecar_config');
  const hasWorkspaceRoot = Boolean(workspaceRoot);
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
  const engineType = service.currentEngineType || inferEngineTypeFromModel(service.currentModel || service.defaultModel);
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
  const streamInactivity = getConfiguredStreamInactivity(service, configuredModel, engineType);
  const tokenBudgetTuning = getConfiguredTokenBudgetTuning(service);
  const cloudLoopProfile = getConfiguredCloudLoopProfile(service);
  const config = {
    engine_type: engineType,
    model: configuredModel,
    // Ollama keeps the deliberate VRAM-conscious shell clamp. Every other
    // engine reports its own window (or uses the sidecar's bounded fallback).
    context_length: engineType === 'ollama'
      ? DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH
      : openAiCompatibleContextLength,
    context_length_override: configuredContextLengthOverride,
    ollama_request_timeout_seconds: getConfiguredOllamaRequestTimeoutSeconds(service),
    ollama_models_dir: ollamaModelsDirState.modelsDir,
    tools_workspace_root: hasWorkspaceRoot ? workspaceRoot : null,
    tools_shell_enabled: hasWorkspaceRoot,
    tools_web_enabled: getConfiguredToolsWebEnabled(service),
    tools_web_search_provider: getConfiguredToolsWebSearchProvider(service),
    tools_web_searxng_url: getConfiguredToolsWebSearxngUrl(service),
    tools_web_search_provider_keys: getConfiguredToolsWebSearchProviderKeys(service),
    tools_todo_enabled: getConfiguredToolsTodoEnabled(service),
    tools_mermaid_enabled: getConfiguredToolsMermaidEnabled(service),
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
    tools_verify_enabled: service.featureFlags?.tools_verify_enabled === true,
    tools_home_enabled: service.featureFlags?.tools_home_enabled === true,
    tools_task_board_enabled: service.featureFlags?.tools_task_board_enabled === true,
    tools_subagents_enabled: getConfiguredToolsSubagentsEnabled(service),
    tools_subagent_batch_enabled: getConfiguredToolsSubagentBatchEnabled(service),
    tools_rich_files_enabled: getConfiguredToolsRichFilesEnabled(service),
    tools_image_read_enabled: getConfiguredToolsImageReadEnabled(service),
    tools_python_runtime_enabled: getConfiguredToolsPythonRuntimeEnabled(service),
    tools_python_runtime_timeout_seconds: getConfiguredToolsPythonRuntimeTimeoutSeconds(service),
    tools_python_runtime_max_memory_mb: getConfiguredToolsPythonRuntimeMaxMemoryMb(service),
    tools_python_runtime_interpreter: null,
    tools_python_runtime_root: path.join(service.options.userDataPath, 'python-runtime'),
    tools_python_runtime_bundled_python: pythonRuntimeBundleRoot
      ? path.join(pythonRuntimeBundleRoot, 'python-embed', 'python.exe')
      : null,
    // The composition layer selects <repo>/vendor for managed development and
    // process.resourcesPath for a packaged sidecar. Electron also defines
    // resourcesPath in development, so it is not itself a packaging signal.
    // Pack commands verify the packaged directory before electron-builder.
    tools_python_runtime_wheelhouse_dir: pythonRuntimeBundleRoot
      ? path.join(pythonRuntimeBundleRoot, 'python-runtime-wheels')
      : null,
    tools_confirm_side_effects: true,
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
    electron_tool_permissions_path: path.join(service.options.userDataPath, 'tool-permissions.json'),
    memory_db_path: path.join(service.options.userDataPath, 'sidecar-memory.db'),
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
    forcePhaseEventsForStreamEnvelopeV2(config);
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
  if (service.mcpDiscoveryService && typeof service.mcpDiscoveryService.getSidecarConfig === 'function') {
    Object.assign(config, service.mcpDiscoveryService.getSidecarConfig({
      httpTransportEnabled: service.featureFlags?.mcp_http_transport === true,
    }));
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
  forcePhaseEventsForStreamEnvelopeV2(config);
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
  }
  return config;
}

// The api_url the sidecar's openai-compatible engine will talk to: an
// explicit endpoint wins, otherwise the configured local port.
function resolveOpenAICompatibleApiUrl(service) {
  const openaiCompatState = getConfiguredLocalOpenAICompatibleState(service);
  const explicitUrl = typeof openaiCompatState?.apiUrl === 'string'
    ? openaiCompatState.apiUrl.trim()
    : '';
  if (explicitUrl) {
    return explicitUrl;
  }
  const port = Number(openaiCompatState?.port);
  return Number.isFinite(port) && port > 0 ? `http://127.0.0.1:${Math.trunc(port)}` : '';
}

function buildManagedSidecarSecrets(service, { telemetrySettings = null } = {}) {
  const secrets = {};
  if (
    (telemetrySettings || getConfiguredTelemetrySettings(service)).crashReportingOptIn === true
    && service.secureStore
    && typeof service.secureStore.getSentryDsn === 'function'
  ) {
    try {
      const dsn = String(service.secureStore.getSentryDsn() || '').trim();
      if (dsn) {
        secrets.telemetry_dsn = dsn;
      }
    } catch (error) {
      if (typeof service._emitServiceLog === 'function') {
        service._emitServiceLog('WARN', 'telemetry.dsn_read_failed', {
          errorName: String(error?.name || 'Error'),
          credentialStore: getCredentialStoreStatusForLog(service.secureStore),
        });
      }
    }
  }
  if (service.currentEngineType === 'chatgpt') {
    secrets.chatgpt_access_token = service.chatgptAuthService?.getCachedAccessToken?.() || '';
  }
  if (service.currentEngineType === 'openai-compatible') {
    // The key belongs to the managed llama-server process only. The engine's
    // api_url may point at a user-run server (explicit apiUrl, or a different
    // port), which must never receive Jenny's key.
    const manager = service.options?.getLlamaServerManager?.();
    const apiKey = typeof manager?.getApiKey === 'function' ? String(manager.getApiKey() || '') : '';
    if (apiKey && sameLocalOrigin(resolveOpenAICompatibleApiUrl(service), manager.getBaseUrl?.())) {
      secrets.openai_compatible_api_key = apiKey;
    }
  }
  return secrets;
}

module.exports = {
  getConfiguredToolsImageReadEnabled,
  getConfiguredToolsMermaidEnabled,
  getConfiguredToolsPythonRuntimeEnabled,
  getConfiguredToolsWebSearchProvider,
  getConfiguredToolsWebSearchProviderKeys,
  getConfiguredToolsWebSearxngUrl,
  getConfiguredToolsWorkspaceRoot,
  getConfiguredTelemetrySettings,
  buildManagedSidecarConfig,
  buildManagedSidecarSecrets,
  resolveManagedConfiguredModel,
  resolveMcpServerAuthSecrets,
};
