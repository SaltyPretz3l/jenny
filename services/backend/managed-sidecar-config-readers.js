// Config-state readers for the managed sidecar initialize payload: tool
// toggles, web search, loop limits, diagnostics, telemetry, local-engine
// state, compaction/generation tuning and the assistant identity. Split out of
// managed-sidecar-config.js (the public entry point, which re-exports the
// readers its consumers use); no SecureStore reads live here.
const {
  getConfiguredOptional,
  getConfiguredWithDefault,
} = require('./managed-sidecar-engine-tuning');
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

function getHostedModelEndpoint(service) {
  if (service?.hostMode !== 'server') return null;
  const endpoint = service.options?.modelEndpoint;
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) return null;
  return endpoint;
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

function getConfiguredOllamaRequestTimeoutSeconds(service) {
  return getConfiguredWithDefault(service, 'ollamaRequestTimeoutSeconds');
}

function getConfiguredStreamInactivity(service, modelId, engineType) {
  const cloud = ['chatgpt', 'codex-cli', 'api-provider'].includes(engineType);
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

module.exports = {
  getConfiguredAssistantIdentity,
  getConfiguredCompactionTuning,
  getConfiguredContextLengthOverride,
  getConfiguredDiagnosticsCaptureMode,
  getConfiguredDiagnosticsLogLevel,
  getConfiguredGenerationProfiles,
  getConfiguredLocalOpenAICompatibleState,
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
};
